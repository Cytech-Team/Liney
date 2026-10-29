import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
// Test fixtures, never a real account or local LINE state.
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE example(body TEXT)");
db.prepare("INSERT INTO example VALUES(?)").run("private fixture only");
const now=Date.now();
const chats=[
 {id:"nagi",kind:"dm",name:"Nagi Rin",preview:"ส่งรูปมาให้ดูด้วยนะ",lastMessageTime:now-100000,unread:2},
 {id:"cytech",kind:"group",name:"Cytech Team",preview:"ประชุมวันศุกร์ 10 โมง",lastMessageTime:now-1500000,unread:0,pinned:true},
 {id:"study",kind:"group",name:"Design Study",preview:"May: เดี๋ยวลอง layout ใหม่",lastMessageTime:now-2400000},
 {id:"open1",kind:"openchat",name:"Linux Thailand",preview:"OpenChat · 1.2K members",lastMessageTime:now-4000000,unread:14},
 {id:"open2",kind:"openchat",name:"Vtuber Talk",preview:"New photo posted",lastMessageTime:now-6500000},
 {id:"yoga",kind:"group",name:"Yoga club",preview:"Saturday 8 AM",lastMessageTime:now-8500000},
];
const byChat={
 nagi:[
  {id:"m1",text:"วันนี้ไปคาเฟ่มา ร้านสวยมาก",senderName:"Nagi",createdTime:now-2100000,isMine:false},
  {id:"m2",text:"ส่งรูปมาให้ดูด้วยนะ 🌿",senderName:"Nagi",createdTime:now-1900000,isMine:false},
  {id:"m3",text:"เมนูน่ากินจัด เดี๋ยวไว้ไปลอง",createdTime:now-800000,isMine:true},
  {id:"m4",text:"ไปดิ เดี๋ยวส่งโลเคชั่นให้",senderName:"Nagi",createdTime:now-550000,isMine:false},
 ],
 cytech:[
  {id:"c1",text:"mock LINE client ตัวใหม่เป็นไงบ้าง",senderName:"May",createdTime:now-2100000,isMine:false},
  {id:"c2",text:"กำลังย้ายเป็น Slint + Node Native UI",createdTime:now-1800000,isMine:true},
  {id:"c3",text:"เอา UI ให้สวยก่อน ที่เหลือค่อยเสียบ 😎",senderName:"May",createdTime:now-1500000,isMine:false}
 ],
};
for (const c of chats) byChat[c.id] ??= [
  {id:c.id+"-a",text:c.preview,senderName:c.name,createdTime:now-3200000,isMine:false},
  {id:c.id+"-b",text:"Liney native UI preview",createdTime:now-1700000,isMine:true}
];
parentPort.on("message", ({id,method,params}) => {
  const result=method==="ping" ? {pong:true,protocolVersion:1,processId:process.pid}
    : method==="capabilities" ? {authenticated:process.env.LINEY_MOCK_EMPTY_CHATS !== "1"}
    : method==="chats.list" ? (process.env.LINEY_MOCK_EMPTY_CHATS === "1" ? [] : chats)
    : method==="message.list" ? byChat[String(params?.chatId)] || []
    : method==="message.send" ? {localId:String(params?.localId),queued:false,sent:true}
    : method==="auth.qr.start" ? {authenticated:false}
    : null;
  if (method==="message.send") {
    const arr=byChat[String(params?.chatId)] ?? [];
    arr.push({id:params.localId,text:params.text,isMine:true,createdTime:Date.now(),status:"sent"});
  }
  parentPort.postMessage({ id,version:1,ok:true,result });
  if(method==="auth.qr.start")
    parentPort.postMessage({type:"auth.qr",version:1,payload:{url:"https://example.org/native-liney-test-login"}});

});
