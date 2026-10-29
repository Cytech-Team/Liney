// Sandboxed renderer: expose only an explicit narrow, validated bridge.
const {contextBridge,ipcRenderer}=require("electron");
function listen(channel,listener){
  if(typeof listener!=="function")throw new TypeError("Listener required");
  const cb=(_event,payload)=>listener(payload);
  ipcRenderer.on(channel,cb);
  return ()=>ipcRenderer.removeListener(channel,cb);
}
contextBridge.exposeInMainWorld("lineyDesktop",Object.freeze({
  start:()=>ipcRenderer.invoke("liney:engine:start"),
  request:(method,params,timeout)=>ipcRenderer.invoke("liney:engine:request",method,params,timeout),
  stop:()=>ipcRenderer.invoke("liney:engine:stop"),
  onEngine:listener=>listen("liney:engine:event",listener),
  invoke:(command,args)=>ipcRenderer.invoke("liney:desktop:command",command,args),
  openDialog:options=>ipcRenderer.invoke("liney:desktop:dialog",options),
  window:(cmd,label,options)=>ipcRenderer.invoke("liney:desktop:window",cmd,label,options),
  emit:(label,name,payload)=>ipcRenderer.invoke("liney:desktop:emit",label,name,payload),
  onEvent:listener=>listen("liney:desktop:event",listener),
}));
