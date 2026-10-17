import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const repo = new URL('../', import.meta.url);
const ext = fs.readFileSync(new URL('../extensions/liney-connector/background.js', import.meta.url),'utf8');
function fixture(initial={}) {
 const store={...initial}, calls=[];
 const chrome={
  runtime:{id:'liney-test',getManifest:()=>({version:'0.3.0'}),onMessage:{addListener:()=>{}}},
  storage:{local:{
   get:async(keys)=>Object.fromEntries(keys.map(k=>[k,store[k]])),
   set:async(values)=>Object.assign(store,values),
  }}
 };
 const context={chrome,URL,Headers,Uint8Array,atob,btoa,console,
   fetch:async(url,opts={})=>{
    calls.push([String(url),opts.method||'GET']);
    assert.match(String(url),/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//);
    if(String(url).endsWith('/health'))return new Response(JSON.stringify({ok:true,status:{pid:123}}),{status:200});
    if(String(url).endsWith('/rpc'))return new Response(JSON.stringify({ok:true,result:{protocolVersion:1,device:'DESKTOPWIN'}}),{status:200});
    throw Error('Unexpected local HTTP call');
   },
   Response};
 vm.runInNewContext(ext+'\nglobalThis.testApi = {localRunnerUrl,runnerConfig,saveRunnerConfig,handleRequest};',context);
 return {...context.testApi,store,calls};
}
const sender={url:'https://liney.namnarak.in.th/app'};
test('Remote runners are never accepted or reused',async()=>{
 const x=fixture({runnerUrl:'https://cdn.cytechteam.site/liney-runner',runnerEnabled:true,runnerToken:'a'.repeat(48)});
 const cfg=await x.runnerConfig();
 assert.equal(cfg.enabled,false);
 assert.match(cfg.url,/^http:\/\/127\.0\.0\.1/);
 await assert.rejects(x.saveRunnerConfig({url:'https://example.com',enabled:true,token:'a'.repeat(48)}),/localhost|Remote/);
 await assert.rejects(x.handleRequest({method:'capabilities'},sender),/Local Liney Engine|เครื่อง/);
 assert.equal(x.calls.length,0);
});
test('Explicit local-only setting enables local authenticated RPC',async()=>{
 const x=fixture();
 await x.saveRunnerConfig({url:'http://localhost:39211/liney-runner',token:'b'.repeat(48),enabled:true});
 const t=await x.handleRequest({method:'connector.transport'},sender);
 assert.equal(t.mode,'local-device');
 assert.equal(t.transport,'loopback');
 const c=await x.handleRequest({method:'capabilities'},sender);
 assert.equal(c.protocolVersion,1);
 assert.deepEqual(x.calls.map(x=>x[1]),['GET','POST']);
 assert.ok(x.calls.every(x=>x[0].startsWith('http://localhost')));
});
test('Web browser bundle does not contain Home Runner URL or cloud LINE API',()=>{
 const html=fs.readFileSync(new URL('../website/app.html',import.meta.url),'utf8');
 const source=fs.readFileSync(new URL('../src/lib/engine.ts',import.meta.url),'utf8');
 const matches=[...html.matchAll(/src="\/app-assets\/([^"]+\.js)"/g)];
 assert.equal(matches.length,1);
 const bundle=fs.readFileSync(new URL('../website/app-assets/'+matches[0][1],import.meta.url),'utf8');
 assert.doesNotMatch(bundle,/cdn\.cytechteam\.site\/liney-runner/);
 assert.doesNotMatch(source,/homeRunnerConfig|DEFAULT_HOME_RUNNER_URL/);
 assert.match(source,/connector\.transport/);
 assert.match(bundle,/connector\.transport/);
});
test('Extension permission set does not grant access to maintainer servers',()=>{
 const m=JSON.parse(fs.readFileSync(new URL('../extensions/liney-connector/manifest.json',import.meta.url)));
 assert.ok(m.host_permissions.some(x=>x.includes('127.0.0.1')));
 assert.ok(!m.host_permissions.some(x=>x.includes('cytechteam.site')));
 assert.equal(m.version,'0.3.0');
});
