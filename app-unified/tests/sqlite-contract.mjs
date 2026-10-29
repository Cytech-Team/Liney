import assert from "node:assert/strict";
import { Database } from "../dist/sqlite.mjs";

const db = new Database(":memory:", { create: true });
db.exec("PRAGMA journal_mode = MEMORY; CREATE TABLE chats (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
db.query("INSERT INTO chats (body) VALUES (?)").run("Native test");
assert.equal(db.query("SELECT body FROM chats WHERE id = ?").get(1).body, "Native test");
assert.equal(db.query("SELECT COUNT(*) AS total FROM chats").get().total, 1);
db.close();
console.log("SQLite compatibility: PASS (in-memory database only)");
