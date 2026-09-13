import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineyDatabase } from "./database";
import { LINEJS_VERSION } from "./linejs/adapter";

type Message = Record<string, unknown>;

function waitForMessage(rl: Interface, child: ChildProcessWithoutNullStreams, predicate: (message: Message) => boolean): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("engine contract response timed out"));
    }, 12_000);
    const onLine = (line: string) => {
      try {
        const message = JSON.parse(line) as Message;
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      } catch {
        // Ignore non-JSON diagnostics; the protocol itself remains line-delimited.
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("engine exited before contract response"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      rl.off("line", onLine);
      child.off("close", onClose);
    };
    rl.on("line", onLine);
    child.once("close", onClose);
  });
}

describe("engine JSONL contract", () => {
  test("returns versioned responses and structured errors", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "liney-rpc-test-"));
    const cachedDatabase = new LineyDatabase(join(dataDir, "liney.sqlite"));
    cachedDatabase.upsertChat("default", {
      id: "u-cached",
      kind: "dm",
      name: "Cached friend",
      preview: "offline history",
      lastMessageTime: 1_700_000_000_000,
    });
    cachedDatabase.upsertMessage("default", {
      id: "cached-message",
      chatId: "u-cached",
      kind: "dm",
      text: "ยังเปิดดูได้ตอนออฟไลน์",
      isMine: false,
      createdTime: 1_700_000_000_000,
      status: "sent",
    });
    cachedDatabase.upsertMessage("default", {
      id: "631000000000000001",
      chatId: "u-reply",
      kind: "dm",
      text: "ข้อความต้นทางที่อยู่นอกหน้าต่างโหลด",
      isMine: false,
      createdTime: 1_700_000_000_100,
      status: "sent",
    });
    cachedDatabase.upsertMessage("default", {
      id: "631000000000000002",
      chatId: "u-reply",
      kind: "dm",
      text: "ตอบกลับข้อความเก่า",
      isMine: true,
      createdTime: 1_700_000_000_200,
      replyToId: "631000000000000001",
      status: "sent",
    });
    cachedDatabase.upsertMessage("default", {
      id: "cached-call",
      chatId: "u-cached",
      kind: "dm",
      text: "Call History : 11000 millisecs, Result: 16",
      isMine: false,
      createdTime: 1_699_999_999_000,
      contentType: 6,
      raw: {
        id: "cached-call",
        contentType: "CALL",
        contentMetadata: { DURATION: "11000", RESULT: "NORMAL", CAUSE: "16" },
      },
    });
    cachedDatabase.close();
    const child = spawn(process.execPath, ["run", join(import.meta.dir, "main.ts")], {
      env: {
        ...process.env,
        LINEY_DATA_DIR: dataDir,
        LINEY_ENABLE_CALLS: "0",
        LINEY_DISABLE_AUTO_RESTORE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: child.stdout });
    try {
      const ready = await waitForMessage(rl, child, (message) => message.type === "engine.ready");
      expect(ready.version).toBe(1);
      expect(ready.payload).toMatchObject({ engine: "liney-engine", linejsVersion: LINEJS_VERSION });

      child.stdin.write(`${JSON.stringify({ id: "bad-version", version: 99, method: "ping", params: {} })}\n`);
      const versionError = await waitForMessage(rl, child, (message) => message.id === "bad-version");
      expect(versionError.version).toBe(1);
      expect(versionError.ok).toBe(false);
      expect(versionError.error).toMatchObject({ code: "PROTOCOL_VERSION_UNSUPPORTED", retryable: false });

      child.stdin.write(`${JSON.stringify({ id: "ping-1", version: 1, method: "ping", params: {} })}\n`);
      const ping = await waitForMessage(rl, child, (message) => message.id === "ping-1");
      expect(ping.version).toBe(1);
      expect(ping.ok).toBe(true);
      expect(ping.result).toMatchObject({ protocolVersion: 1 });

      child.stdin.write(`${JSON.stringify({ id: "caps-1", version: 1, method: "capabilities", params: {} })}\n`);
      const caps = await waitForMessage(rl, child, (message) => message.id === "caps-1");
      expect(caps.result).toMatchObject({ protocolVersion: 1, authenticated: false });
      expect((caps.result as { features: string[] }).features).not.toContain("call-audio-1to1");

      child.stdin.write(`${JSON.stringify({ id: "cached-chats", version: 1, method: "chat.list", params: {} })}\n`);
      const cachedChats = await waitForMessage(rl, child, (message) => message.id === "cached-chats");
      expect(cachedChats.ok).toBe(true);
      expect(cachedChats.result).toMatchObject([{ id: "u-cached", name: "Cached friend" }]);

      child.stdin.write(`${JSON.stringify({ id: "cached-messages", version: 1, method: "message.list", params: { chatId: "u-cached", kind: "talk", limit: 1 } })}\n`);
      const cachedMessages = await waitForMessage(rl, child, (message) => message.id === "cached-messages");
      expect(cachedMessages.ok).toBe(true);
      expect(cachedMessages.result).toMatchObject([{ id: "cached-message", text: "ยังเปิดดูได้ตอนออฟไลน์" }]);

      child.stdin.write(`${JSON.stringify({ id: "cached-reply", version: 1, method: "message.list", params: { chatId: "u-reply", kind: "talk", limit: 1 } })}\n`);
      const cachedReply = await waitForMessage(rl, child, (message) => message.id === "cached-reply");
      expect(cachedReply.ok).toBe(true);
      expect(cachedReply.result).toMatchObject([{
        id: "631000000000000002",
        replyTo: {
          id: "631000000000000001",
          text: "ข้อความต้นทางที่อยู่นอกหน้าต่างโหลด",
          author: "them",
        },
      }]);

      child.stdin.write(`${JSON.stringify({ id: "cached-call-message", version: 1, method: "message.list", params: { chatId: "u-cached", kind: "talk", limit: 2 } })}\n`);
      const cachedCallMessage = await waitForMessage(rl, child, (message) => message.id === "cached-call-message");
      expect((cachedCallMessage.result as Array<Record<string, unknown>>)[0]).toMatchObject({
        id: "cached-call",
        text: "โทรสำเร็จ · 11 วินาที",
        call: { durationMs: 11_000, status: "completed" },
      });

      child.stdin.write(`${JSON.stringify({ id: "cached-calls", version: 1, method: "call.history", params: {} })}\n`);
      const cachedCalls = await waitForMessage(rl, child, (message) => message.id === "cached-calls");
      expect(cachedCalls.ok).toBe(true);
      expect(cachedCalls.result).toMatchObject([{
        id: "cached-call",
        chatId: "u-cached",
        call: { durationMs: 11_000, status: "completed" },
      }]);

      child.stdin.write(`${JSON.stringify({ id: "asset-unsafe", version: 1, method: "asset.preview", params: { url: "http://127.0.0.1/private.png" } })}\n`);
      const assetError = await waitForMessage(rl, child, (message) => message.id === "asset-unsafe");
      expect(assetError.ok).toBe(false);
      expect(assetError.error).toMatchObject({ code: "ENGINE_ERROR", retryable: false });

      child.stdin.write(`${JSON.stringify({ id: "link-unsafe", version: 1, method: "link.preview", params: { url: "http://127.0.0.1/private.html" } })}\n`);
      const linkError = await waitForMessage(rl, child, (message) => message.id === "link-unsafe");
      expect(linkError.ok).toBe(false);
      expect(linkError.error).toMatchObject({ code: "ENGINE_ERROR", retryable: false });

      child.stdin.write(`${JSON.stringify({ id: "password-missing", version: 1, method: "auth.password.start", params: { email: "" } })}\n`);
      const passwordError = await waitForMessage(rl, child, (message) => message.id === "password-missing");
      expect(passwordError.ok).toBe(false);
      expect(passwordError.error).toMatchObject({ code: "ENGINE_ERROR", retryable: false });

      child.stdin.write(`${JSON.stringify({ id: "sync-1", version: 1, method: "sync.status", params: {} })}\n`);
      const sync = await waitForMessage(rl, child, (message) => message.id === "sync-1");
      expect(sync.error).toMatchObject({ code: "NOT_AUTHENTICATED" });
    } finally {
      rl.close();
      child.kill("SIGTERM");
    }
  }, 20_000);
});
