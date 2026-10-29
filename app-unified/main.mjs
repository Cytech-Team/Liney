/**
 * Experimental unified UI host: one process, native Slint GUI, Engine Worker.
 * Worker is a thread, never a child process, and has the exact same PID.
 * Do not use against production LINE credentials until integration is verified.
 */
import * as slint from "slint-ui";
slint.setXdgAppId("dev.cytechteam.liney");
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { ChatController } from "./controller.mjs";

process.umask(0o077); // Set on process owner; Node workers cannot call process.umask().
const isolated = process.env.LINEY_DATA_DIR;
if (process.env.LINEY_UNIFIED_TEST === "1" && !isolated) {
  throw new Error("LINEY_DATA_DIR is required for tests to protect real sessions");
}
const ui = slint.loadFile(new URL("./ui/main.slint", import.meta.url));
const window = new ui.LineyNative();
window.runtime_label = "Slint · Node.js";

const pending = new Map();
const workerScript = process.env.LINEY_UNIFIED_MOCK_ENGINE === "1"
  ? new URL("./tests/mock-engine.mjs", import.meta.url)
  : new URL("./dist/engine.mjs", import.meta.url);
const engine = new Worker(workerScript, {
  // The bundled TypeScript core runs natively on Node in this Worker Thread.
  env: { ...process.env },
});
function call(method, params = {}, timeoutMs = 20000) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Engine request timed out: " + method));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    engine.postMessage({ id, version: 1, method, params });
  });
}
let controller = null;
engine.on("message", (message) => {
  if (!message?.id && message?.type) controller?.handleEvent(message);
  const entry = message?.id && pending.get(message.id);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.ok === false) entry.reject(new Error(message.error?.message || "Engine error"));
    else entry.resolve(message.result);
  }
});
engine.on("error", () => { window.engine_status = "Engine worker error"; });
engine.on("exit", () => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Engine worker closed"));
  }
  pending.clear();
  window.engine_status = "Engine stopped";
});

// No webview, browser runtime, network server, engine child process or sockets.
controller = new ChatController({
  window,slint,call,
  copyText: (value) => {
    // Clipboard is a native-OS operation. Do not log QR URLs or secrets.
    console.error("Copy QR URL is not yet available in this preview");
  }
});
void controller.start().then((response) => {
  console.log(JSON.stringify({
    hostPid:process.pid,workerPid:response.processId,
    enginePong:true,nativeRenderer:"Slint",childProcess:false,
  }));
}).catch(error=>{
  window.engine_status = "Engine unavailable";
  window.cache_status = "Native engine is not ready";
  console.error("Native integration:",String(error?.message??error));
});
try {
  await window.run();
} finally {
  // Ask the engine to stop its push listeners and call resources first.
  // Forced termination is strictly a fallback for a hung Worker Thread.
  if (engine.threadId !== -1) {
    engine.postMessage({ type: "liney:shutdown" });
    let timer;
    await Promise.race([
      new Promise((resolve) => engine.once("exit", resolve)),
      new Promise((resolve) => { timer = setTimeout(resolve, 1800); }),
    ]);
    clearTimeout(timer);
    if (engine.threadId !== -1) await engine.terminate();
  }
}
