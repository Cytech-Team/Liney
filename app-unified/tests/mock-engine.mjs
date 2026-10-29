import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE chats (id INTEGER PRIMARY KEY, name TEXT)");
db.prepare("INSERT INTO chats(name) VALUES (?)").run("Offline test");
parentPort.on("message", ({id, method}) => {
  const result = method === "ping"
    ? {pong:true,protocolVersion:1,processId:process.pid}
    : method === "chats.list"
      ? db.prepare("SELECT id, name FROM chats").all()
      : null;
  parentPort.postMessage({ id, version:1, ok:true, result });
});
