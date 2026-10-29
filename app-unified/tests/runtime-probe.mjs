/**
 * Boots the actual pinned LINEJS engine without an account/credentials.
 * A real in-process Worker is required to confirm single-PID operation.
 * Never point this smoke test at production LINEY_DATA_DIR.
 */
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
process.umask(0o077);
if (process.env.LINEY_DISABLE_AUTO_RESTORE !== "1" || !process.env.LINEY_DATA_DIR)
  throw Error("This test requires an isolated LINEY_DATA_DIR and disabled auto restore");

const worker = new Worker(new URL("../dist/engine.mjs",import.meta.url),{env:{...process.env}});
let timeout;
try {
  const pong = await new Promise((resolve,reject)=>{
    timeout=setTimeout(()=>reject(Error("Real LINEJS Worker did not respond")),9000);
    worker.once("error",reject);
    worker.on("message",m=>{
      if(m?.type==="engine.ready") worker.postMessage({id:"native-smoke",version:1,method:"ping"});
      if(m?.id==="native-smoke") m.ok===true ? resolve(m.result) : reject(Error("Engine ping failed"));
    });
    worker.once("exit",code=>reject(Error("LINEJS Worker exited before ping: "+code)));
  });
  assert.equal(pong.pong,true);
  assert.equal(pong.processId,process.pid);
  assert.equal(pong.protocolVersion,1);
  console.log("REAL_ENGINE_NATIVE_SAME_PID_PASS");
  worker.postMessage({type:"liney:shutdown"});
  await Promise.race([
    new Promise(resolve=>worker.once("exit",resolve)),
    new Promise(resolve=>setTimeout(resolve,1000)),
  ]);
} finally {
  clearTimeout(timeout);
  if (worker.threadId !== -1) await worker.terminate();
}
