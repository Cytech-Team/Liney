import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineyDatabase } from "./database";

describe("LineyDatabase", () => {
  test("stores chats, history, outbox and sync state transactionally", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-db-test-"));
    const database = new LineyDatabase(join(root, "data", "liney.sqlite"));
    database.upsertAccount("default", { mid: "u-me", displayName: "Me" });
    database.upsertChat("default", { id: "u-peer", kind: "dm", name: "Peer", unread: 2 });
    database.recordMessageActivity("default", {
      chatId: "u-peer",
      kind: "dm",
      preview: "live message",
      createdTime: 1_700_000_000_010,
      isMine: false,
    });
    expect(database.listChats("default")[0]).toMatchObject({
      preview: "live message",
      unread: 3,
      lastMessageTime: 1_700_000_000_010,
    });
    database.recordMessageActivity("default", {
      chatId: "u-peer",
      kind: "dm",
      preview: "live message",
      createdTime: 1_700_000_000_010,
      isMine: false,
      isNew: false,
    });
    expect(database.listChats("default")[0]?.unread).toBe(3);
    database.markChatRead("default", "u-peer");
    expect(database.listChats("default")[0]?.unread).toBe(0);
    database.upsertMessage("default", {
      id: "local-1",
      chatId: "u-peer",
      kind: "dm",
      text: "hello",
      filename: "hello.txt",
      isMine: true,
      createdTime: 1_700_000_000_000,
      reactions: [{ type: 2, count: 1, mine: true }],
      replyToId: "parent-1",
      status: "sending",
      raw: { id: "raw-1", contentType: "NONE" },
    });
    database.reconcileMessage("default", "local-1", {
      id: "server-1",
      chatId: "u-peer",
      kind: "dm",
      text: "hello",
      isMine: true,
      createdTime: 1_700_000_000_000,
      status: "sent",
    }, "server-1");

    const messages = database.listMessages("default", "u-peer");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("server-1");
    expect(messages[0]?.status).toBe("sent");
    expect(messages[0]?.filename).toBe("hello.txt");
    expect(messages[0]?.reactions).toEqual([{ type: 2, count: 1, mine: true }]);
    expect(messages[0]?.replyToId).toBe("parent-1");
    expect(database.getMessageSource("default", "server-1", "u-peer", "dm")).toMatchObject({
      chatId: "u-peer",
      kind: "dm",
      raw: { id: "raw-1", contentType: "NONE" },
    });

    database.upsertMessage("default", {
      id: "hidden-1",
      chatId: "u-peer",
      kind: "dm",
      text: "only visible before local delete",
      isMine: false,
      createdTime: 1_700_000_000_020,
      status: "sent",
    });
    database.hideMessageForMe("default", "u-peer", "dm", "hidden-1");
    expect(database.isMessageHidden("default", "u-peer", "dm", "hidden-1")).toBe(true);
    expect(database.listMessages("default", "u-peer")).toHaveLength(1);

    database.markMessageUnsent("default", "u-peer", "server-1");
    expect(database.listMessages("default", "u-peer")[0]).toMatchObject({
      id: "server-1",
      text: "ยกเลิกข้อความแล้ว",
      unsent: true,
      status: "sent",
    });
    expect(database.getMessage("default", "u-peer", "server-1")?.reactions).toBeUndefined();

    database.saveOutbox("default", {
      localId: "local-2",
      chatId: "u-peer",
      kind: "dm",
      contentType: 0,
      text: "retry",
      durationMs: 1_200,
      fingerprint: "fp",
      status: "unknown",
      attempts: 1,
      createdAt: 1_700_000_000_001,
      updatedAt: 1_700_000_000_001,
      relatedMessageId: "server-1",
    });
    expect(database.listPendingOutbox("default")).toMatchObject([{
      localId: "local-2",
      durationMs: 1_200,
      relatedMessageId: "server-1",
    }]);
    database.setSyncState("default", { key: "dm:u-peer", generation: 3, status: "ready", cursor: "cursor-3" });
    expect(database.getSyncState("default", "dm:u-peer")?.generation).toBe(3);
    expect(database.listChats("default")[0]?.id).toBe("u-peer");
    expect(database.stats("default")).toEqual({ chats: 1, messages: 1, pending: 1 });
    expect(statSync(join(root, "data", "liney.sqlite")).mode & 0o777).toBe(0o600);

    database.clearHistory("default");
    expect(database.stats("default")).toEqual({ chats: 1, messages: 0, pending: 0 });
    database.close();
  });
});
