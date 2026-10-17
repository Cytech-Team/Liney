import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../compatibility.js", import.meta.url), "utf8");
const wait = () => new Promise((resolve) => setImmediate(resolve));
function device() {
  const registry = new Map();
  let fetchCount = 0, copied = "";
  function element(id) {
    if (!registry.has(id)) registry.set(id, {
      id, textContent: "", innerHTML: "", style: {}, disabled: false,
      handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; },
      click() { this.handlers.click(); },
    });
    return registry.get(id);
  }
  const document = {
    getElementById: element,
    createElement: () => ({
      textContent: "",
      get innerHTML() { return this.textContent.replace(/&/g,"&amp;").replace(/</g,"&lt;"); }
    }),
  };
  const window = { isSecureContext: true, indexedDB: null };
  const navigator = {
    userAgent: "Mozilla/5.0 CrOS x86_64 Chrome/155.0.0.0",
    serviceWorker: {},
    permissions: { query: async () => ({state:"prompt"}) },
    clipboard: {writeText: async(text) => {copied=text;}},
    storage: {
      estimate: async()=>({usage:1024,quota:1000000}),
      persisted: async()=>false,
    },
  };
  const crypto = {subtle:{digest:async()=>new Uint8Array(32)}};
  const fetch = async (url, options) => {
    fetchCount++;
    assert.equal(url,"http://127.0.0.1:39211/liney-runner/health");
    assert.equal(options.targetAddressSpace,"loopback");
    assert.equal(options.credentials,"omit");
    assert.equal(options.method,"GET");
    return {ok:true,json:async()=>({mode:"local-device",transport:"loopback"})};
  };
  const context={document,window,navigator,crypto,fetch,console,Worker:()=>{},WebAssembly:{},TextEncoder,
    setTimeout,clearTimeout,AbortController};
  return {registry,element,context,get fetchCount(){return fetchCount;},get copied(){return copied;}};
}

test("machine scan does not attempt localhost until user presses test connection",async()=>{
  const d=device();
  vm.runInNewContext(source,d.context);
  await wait();await wait();
  assert.equal(d.fetchCount,0,"no network permission request should run automatically");
  assert.match(d.element("check-results").innerHTML,/IndexedDB/);
  d.element("check-connection").click();
  await wait();await wait();
  assert.equal(d.fetchCount,1);
  assert.match(d.element("check-results").innerHTML,/พบ Liney Local Engine/);
});
test("report is user-initiated and contains no access token or hardware fingerprint",async()=>{
 const d=device();
 vm.runInNewContext(source,d.context);
 await wait();await wait();
 assert.equal(d.copied,"");
 d.element("copy-report").click();
 await wait();
 assert.match(d.copied,/Device Compatibility Check/);
 assert.doesNotMatch(d.copied,/Bearer |runner\.token|x-liney|CrOS x86_64 Chrome/);
});
