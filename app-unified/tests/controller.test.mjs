import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatController, normalizeChat, normalizeMessage } from "../controller.mjs";

class Model {
  constructor(values=[]) { this.a=values.slice();this.changed=0; }
  rowCount() {return this.a.length;}
  rowData(i) {return this.a[i];}
  setRowData(i, value) {this.a[i]=value;this.changed++;}
  splice(i,count,...values) {return this.a.splice(i,count,...values);}
  push(v) {return this.a.push(v);}
}
function fixture(call) {
  const window = {
    Theme:{dark:true},engine_status:"Connecting...", cache_status:"",
    notification:"",draft:"",is_authenticated:false,has_active_chat:false,
  };
  const controller = new ChatController({
    window,slint:{ArrayModel:Model},call,
  });
  return {window,controller};
}
const fakeChats = [
  {id:"a",name:"Alice",kind:"dm",unread:2,preview:"hello",lastMessageTime:1760000000000},
  {id:"b",name:"Design Group",kind:"group",unread:0,preview:"meeting",lastMessageTime:1760000000001},
];
test("normalizes cached data without losing original IDs",()=>{
  assert.equal(normalizeChat(fakeChats[0]).id,"a");
  assert.equal(normalizeMessage({id:"m",isMine:true,text:"hey",status:"sending"}).pending,true);
});
test("native UI controller reads cache before opening messages",async()=>{
  const {window,controller}=fixture(async(method)=>{
    if(method==="ping") return {pong:true,processId:process.pid};
    if(method==="chats.list") return fakeChats;
    if(method==="message.list") return [{id:"m1",text:"hello",isMine:false}];
    throw Error(method);
  });
  await controller.start();
  assert.equal(window.engine_status,"Engine ready");
  assert.equal(controller.chatModel.rowCount(),2);
  window.select_chat("a");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(window.active_chat_name,"Alice");
  assert.equal(controller.messageModel.rowCount(),1);
  assert.equal(controller.messageModel.rowData(0).body,"hello");
});
test("filters unread/groups and updates same-model rows incrementally",()=>{
  const {window,controller}=fixture(async()=>{});
  controller.applyChats(fakeChats);
  const oldModel=controller.chatModel;
  controller.applyChats([{...fakeChats[0],preview:"changed"},{...fakeChats[1]}]);
  assert.equal(controller.chatModel,oldModel);
  assert.equal(oldModel.rowCount(),2);
  assert.ok(oldModel.changed>=1);
  window.change_filter(1);
  assert.equal(oldModel.rowCount(),1);
  assert.equal(oldModel.rowData(0).id,"a");
  window.change_filter(2);
  assert.equal(oldModel.rowCount(),1);
  assert.equal(oldModel.rowData(0).id,"b");
  window.change_filter(0);
  window.change_search("alice");
  assert.equal(oldModel.rowCount(),1);
});
test("sending message is optimistic and retains failed outbox state",async()=>{
  const sent=[];
  const {window,controller}=fixture(async(method,params)=>{
    if(method==="message.list") return [];
    if(method==="message.send") {sent.push(params);throw Error("offline");}
  });
  controller.applyChats(fakeChats);
  await controller.selectChat("a");
  window.draft="Hello offline";
  await controller.sendMessage("Hello offline");
  assert.equal(sent.length,1);
  assert.equal(sent[0].chatId,"a");
  assert.equal(controller.messageModel.rowCount(),1);
  assert.equal(controller.messageModel.rowData(0).status,"error");
  assert.equal(window.draft,"");
});
test("late responses from another chat never overwrite selection",async()=>{
  let resolveA;
  const {window,controller}=fixture(async(method,params)=>{
    if(method!=="message.list") throw Error("unexpected");
    if(params.chatId==="a") return new Promise(resolve=>{resolveA=resolve;});
    return [{id:"b1",text:"B reply"}];
  });
  controller.applyChats(fakeChats);
  const old=controller.selectChat("a");
  await controller.selectChat("b");
  resolveA([{id:"a1",text:"Wrong chat"}]);
  await old;
  assert.equal(window.active_chat_name,"Design Group");
  assert.equal(controller.messageModel.rowData(0).id,"b1");
});
