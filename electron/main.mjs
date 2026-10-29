/**
 * Liney Electron shell. React UI and LINEJS are reused verbatim.
 * This is an isolated preview until live session, packaging and security QA pass.
 */
import { app, BrowserWindow, ipcMain, dialog, Notification, shell, clipboard, Menu, Tray, protocol, net } from "electron";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

protocol.registerSchemesAsPrivileged([
  {scheme:"lineyapp",privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}
]);
const base = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(base, "..");
const bundled = app.isPackaged;
const preview = process.env.LINEY_ELECTRON_STABLE !== "1";
app.setName(preview ? "Liney Electron Preview" : "Liney");
const stateDir = process.env.LINEY_DATA_DIR || path.join(
  process.env.XDG_DATA_HOME || path.join(app.getPath("home"), ".local/share"),
  preview ? "liney-electron-preview" : "liney"
);
if (preview || process.env.LINEY_DATA_DIR) app.setPath("userData", stateDir);
process.umask(0o077);
const icon = path.join(root, "src-tauri/icons/128x128.png");
const windows = new Map();
let engine = null;
let engineStarting = null;
const pending = new Map();
let quitting = false;
let tray = null;
let closeToTray = false;
let toneTimer = null;

function broadcast(type, payload) {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(type, payload);
  }
}
function engineRejectAll(reason) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}
async function ensureEngine() {
  if (engine && engine.threadId !== -1) return;
  if (engineStarting) return engineStarting;
  engineStarting = (async () => {
    await mkdir(stateDir, {recursive:true,mode:0o700});
    const engineRoot = bundled && root.endsWith(".asar")
      ? root.slice(0,-5)+".asar.unpacked"
      : root;
    const location = path.join(engineRoot, "electron/dist/engine.mjs");
    if (!existsSync(location)) throw new Error("LINEJS Engine bundle missing. Run npm run electron:engine");
    const worker = new Worker(location, {
      env: {...process.env, LINEY_DATA_DIR:stateDir},
    });
    engine = worker;
    worker.on("message", (packet) => {
      if (packet && typeof packet.type === "string" && !packet.id) broadcast("liney:engine:event", packet);
      if (!packet || typeof packet.id !== "string") return;
      const entry = pending.get(packet.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(packet.id);
      if (packet.ok === false) {
        const error = new Error(String(packet.error?.message || "LINE engine rejected request"));
        error.code = String(packet.error?.code || "ENGINE_ERROR");
        entry.reject(error);
      } else entry.resolve(packet.result);
    });
    worker.on("error", (error) => {
      broadcast("liney:engine:event", {type:"engine.error",message:String(error.message)});
      engineRejectAll("LINEJS worker failed");
    });
    worker.on("exit", (code) => {
      if (engine === worker) engine = null;
      engineRejectAll("LINEJS worker exited ("+code+")");
      if (!quitting) broadcast("liney:engine:event", {type:"engine.closed",code});
    });
    await requestEngine("ping",{},12000);
  })().finally(() => {engineStarting=null;});
  return engineStarting;
}
function requestEngine(method, params={}, timeout=15000) {
  if (!engine || engine.threadId === -1) return Promise.reject(new Error("LINEJS worker unavailable"));
  if (typeof method !== "string" || method.length>100 || !/^[a-z0-9_.-]+$/i.test(method)) return Promise.reject(new Error("Invalid LINEJS method"));
  const id = randomUUID();
  return new Promise((resolve,reject) => {
    const timer = setTimeout(()=>{pending.delete(id);reject(new Error("LINEJS request timed out: "+method));}, Math.min(Math.max(timeout,1000),900000));
    pending.set(id,{resolve,reject,timer});
    try {engine.postMessage({id,version:1,method,params});}
    catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
  });
}
async function stopEngine() {
  if (!engine || engine.threadId === -1) return;
  const current=engine;engine=null;
  current.postMessage({type:"liney:shutdown"});
  await Promise.race([
    new Promise(resolve=>current.once("exit",resolve)),
    new Promise(resolve=>setTimeout(resolve,1500))
  ]);
  if(current.threadId!==-1) await current.terminate();
}
function loadApp(win, pathQuery="") {
  const file = path.join(root,"dist/index.html");
  const dev = process.env.LINEY_ELECTRON_DEV_URL;
  if(dev) return win.loadURL(dev + (pathQuery || ""));
  if(!existsSync(file)) throw new Error("React production build missing; run npm run electron:web");
  return win.loadURL("lineyapp://app/index.html" + (pathQuery ? "?" + pathQuery.replace(/^\?/,"") : ""));
}
function createWindow(label="main", opts={}) {
  const win = new BrowserWindow({
    autoHideMenuBar:true,
    width:opts.width||1160,height:opts.height||760,
    minWidth:opts.minWidth||740,minHeight:opts.minHeight||520,
    title: opts.title||"Liney",icon,
    backgroundColor:"#101318",show:false,
    webPreferences:{
      preload:path.join(base,"preload.cjs"),
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
      webSecurity:true,
      devTools:!bundled
    }
  });
  win.setMenuBarVisibility(false);
  win.removeMenu();
  windows.set(label,win);
  win.on("closed",()=>windows.delete(label));
  win.on("close",event=>{
    if(label==="main" && closeToTray && !quitting){event.preventDefault();win.hide();}
  });
  win.once("ready-to-show",()=>win.show());
  if(label==="main" && process.env.LINEY_ELECTRON_SMOKE==="1") {
    win.webContents.once("did-finish-load",()=>{
      setTimeout(async()=>{
        try{
          const checks=await win.webContents.executeJavaScript(`({
            authDialog: Boolean(document.querySelector(".auth-modal")),
            logoLoaded: Boolean(document.querySelector(".auth-brand img")?.naturalWidth),
            bridge: Boolean(window.lineyDesktop),
            webkit: Boolean(window.__TAURI_INTERNALS__)
          })`);
          await ensureEngine();
          const pong=await requestEngine("ping");
          const outcome={...checks,menuHidden:!win.isMenuBarVisible() && Menu.getApplicationMenu()===null,enginePong:Boolean(pong),renderer:"React original",system:"Electron"};
          console.log("LINEY_ELECTRON_SMOKE_RESULT="+JSON.stringify(outcome));
          app.exit(checks.authDialog && checks.logoLoaded && checks.bridge && !checks.webkit && outcome.menuHidden && Boolean(pong) ? 0 : 3);
        }catch(e){console.error("LINEY_ELECTRON_SMOKE_ERROR="+String(e));app.exit(4);}
      },1000);
    });
  }
  win.webContents.setWindowOpenHandler(({url})=>{
    if(/^https?:\/\//.test(url)) void shell.openExternal(url);
    return {action:"deny"};
  });
  win.webContents.on("will-navigate",(event,url)=>{
    const permitted = process.env.LINEY_ELECTRON_DEV_URL || "lineyapp://app/";
    if(!url.startsWith(permitted)) event.preventDefault();
  });
  loadApp(win,opts.query||"").catch(error=>{console.error("React UI load failed:",error.message);});
  return win;
}
const avatarFolder = path.join(stateDir,"notification-avatars");
const avatarPath = key => path.join(avatarFolder,key+".png");
async function runDesktopCommand(command,args={}) {
  switch(command) {
    case "set_close_to_tray":
      closeToTray=Boolean(args.enabled);
      if(closeToTray && !tray) {
        tray=new Tray(icon);
        tray.setToolTip("Liney");
        tray.setContextMenu(Menu.buildFromTemplate([
          {label:"Open Liney",click:()=>{const w=windows.get("main");w?.show();w?.focus();}},
          {label:"Quit",click:()=>{closeToTray=false;app.quit();}}
        ]));
        tray.on("double-click",()=>windows.get("main")?.show());
      } else if (!closeToTray && tray){tray.destroy();tray=null;}
      return null;
    case "set_autostart":
      if (!args.enabled) return null;
      // Linux desktop-file/systemd autostart needs a separately reviewed implementation.
      throw new Error("Autostart is not yet supported in Electron preview");
    case "notify_message":
    case "notify_call":
      if (Notification.isSupported()) new Notification({title:String(args.title||"Liney").slice(0,150),body:String(args.body||"").slice(0,1000)}).show();
      return null;
    case "open_external_url": {
      const u=new URL(String(args.url||""));
      if(!["https:","http:"].includes(u.protocol)||u.username||u.password) throw new Error("External URL not allowed");
      await shell.openExternal(u.href);return null;
    }
    case "read_clipboard_image": {
      const im=clipboard.readImage();
      if (im.isEmpty()) return {base64:"",mime:"image/png",filename:"clipboard.png"};
      return {base64:im.toPNG().toString("base64"),mime:"image/png",filename:"clipboard.png"};
    }
    case "notification_avatar_cached": {
      const key=String(args.key||"");
      if(!/^[a-f0-9]{64}$/.test(key)) return false;
      try{await stat(avatarPath(key));return true;}catch{return false;}
    }
    case "store_notification_avatar": {
      const key=String(args.key||"");const data=String(args.dataUrl||"");
      if(!/^[a-f0-9]{64}$/.test(key)||!/^data:image\/(?:png|jpeg|webp);base64,/.test(data)||data.length>4200000) throw new Error("Invalid avatar");
      const bytes=Buffer.from(data.slice(data.indexOf(",")+1),"base64");
      if(bytes.length>3100000) throw new Error("Avatar too large");
      await mkdir(avatarFolder,{recursive:true,mode:0o700});
      await writeFile(avatarPath(key),bytes,{mode:0o600});return null;
    }
    case "start_call_tone":
    case "stop_call_tone":
      // TODO: port original native tone player. Never play fake call audio.
      return null;
    default:throw new Error("Unsupported desktop command: "+command);
  }
}
app.whenReady().then(async()=>{
  // No browser-style File/Edit/View/Window menu in a standalone messenger.
  Menu.setApplicationMenu(null);
  protocol.handle("lineyapp",request=>{
    const url=new URL(request.url);
    if(url.hostname!=="app")return new Response("Unknown app host",{status:403});
    let urlPath;
    try {urlPath=decodeURIComponent(url.pathname);}catch{return new Response("Invalid path",{status:400});}
    const filename=path.resolve(root,"dist","."+urlPath);
    const folder=path.resolve(root,"dist")+path.sep;
    if(filename!==path.resolve(root,"dist/index.html") && !filename.startsWith(folder))
      return new Response("Forbidden",{status:403});
    return net.fetch(new URL("file://"+filename).toString());
  });
  ipcMain.handle("liney:engine:start",async()=>{await ensureEngine();return true;});
  ipcMain.handle("liney:engine:request",async(_event,method,params,timeout)=>{
    await ensureEngine();
    return requestEngine(method,params,timeout);
  });
  ipcMain.handle("liney:engine:stop",()=>stopEngine());
  ipcMain.handle("liney:desktop:command",(_event,command,args)=>runDesktopCommand(command,args));
  ipcMain.handle("liney:desktop:dialog",async(event,options={})=>{
    const owner=BrowserWindow.fromWebContents(event.sender);
    const opts={properties:options.multiple?["openFile","multiSelections"]:["openFile"]};
    if(options.directory) opts.properties=["openDirectory"];
    const result=await dialog.showOpenDialog(owner,opts);
    if(result.canceled)return null;
    return options.multiple?result.filePaths:result.filePaths[0]||null;
  });
  ipcMain.handle("liney:desktop:window",async(_event,cmd,label,options)=>{
    if(cmd==="create"){if(windows.has(label))return true;createWindow(label,options);return true;}
    const win=windows.get(label);
    if(!win)return false;
    if(cmd==="show"){win.show();return true;}
    if(cmd==="focus"){win.focus();return true;}
    if(cmd==="close"){win.close();return true;}
    return false;
  });
  ipcMain.handle("liney:desktop:emit",(_event,label,name,payload)=>{
    const win=windows.get(label);
    if(win&&!win.isDestroyed())win.webContents.send("liney:desktop:event",{name,payload});
    return Boolean(win);
  });
  if (process.env.LINEY_ELECTRON_TEST_NOENGINE !== "1") {
    // Don't start LINEJS without user action; the React UI starts it when ready.
  }
  createWindow();
});
app.on("window-all-closed",()=>{if(!closeToTray)app.quit();});
app.on("before-quit",()=>{quitting=true;});
app.on("will-quit",()=>{if(engine)void stopEngine();});
