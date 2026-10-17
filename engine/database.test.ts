import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineyDatabase } from "./database";

describe("LineyDatabase", () => {
  test("repairs old Flex previews from the latest non-hidden message only", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-flex-preview-test-"));
    const db = new LineyDatabase(join(root, "liney.sqlite"));
    const accountId = "test";
    for (const id of ["melody", "shopping", "text-room", "no-alt"]) {
      db.upsertChat(accountId, { id, kind: "dm", name: id, preview: "Flex message" });
    }
    db.upsertMessage(accountId, {
      id: "melody-flex", chatId: "melody", kind: "dm", text: "Flex message",
      contentType: 22, isMine: false, createdTime: 200,
      raw: { contentMetadata: { ALT_TEXT: "เมโลดี้เพลงมาแรง", FLEX_JSON: "{}" } },
    });
    db.upsertMessage(accountId, {
      id: "shopping-flex", chatId: "shopping", kind: "dm", text: "Flex message",
      contentType: 22, isMine: false, createdTime: 200,
      raw: { contentMetadata: { ALT_TEXT: "ช้อปสินค้าลดราคา" } },
    });
    db.upsertMessage(accountId, {
      id: "text-newer", chatId: "text-room", kind: "dm", text: "ข้อความปกติ",
      contentType: 0, isMine: false, createdTime: 250,
    });
    db.upsertMessage(accountId, {
      id: "no-alt-flex", chatId: "no-alt", kind: "dm", text: "Flex message",
      contentType: 22, isMine: false, createdTime: 150,
      raw: { contentMetadata: { FLEX_JSON: "{}" } },
    });
    expect(db.restoreFlexPreviewsFromHistory(accountId)).toBe(3);
    const byId = new Map(db.listChats(accountId).map((chat) => [chat.id, chat]));
    expect(byId.get("melody")?.preview).toBe("เมโลดี้เพลงมาแรง");
    expect(byId.get("shopping")?.preview).toBe("ช้อปสินค้าลดราคา");
    expect(byId.get("text-room")?.preview).toBe("Flex message");
    expect(byId.get("no-alt")?.preview).toBe("การ์ดข้อความ");
    expect(db.restoreFlexPreviewsFromHistory(accountId)).toBe(0);
  });

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
    database.recordMessageActivity("default", {
      chatId: "u-peer",
      kind: "dm",
      preview: "edited old message",
      createdTime: 1_699_999_999_999,
      isMine: false,
      isNew: false,
    });
    expect(database.listChats("default")[0]).toMatchObject({
      preview: "live message",
      unread: 3,
      lastMessageTime: 1_700_000_000_010,
    });
    database.markChatRead("default", "u-peer");
    expect(database.listChats("default")[0]?.unread).toBe(0);
    database.setTrackedChatActivity("default", "u-peer", {
      preview: "tracked metadata event",
      createdTime: 1_700_000_000_020,
      unread: 4,
    });
    expect(database.listChats("default")[0]).toMatchObject({
      preview: "tracked metadata event",
      unread: 4,
      lastMessageTime: 1_700_000_000_020,
      historyState: "unavailable",
    });
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
      id: "official-1",
      chatId: "u-peer",
      kind: "dm",
      text: "ประกาศจากบัญชีทางการ",
      isMine: false,
      isOfficialAccount: true,
      createdTime: 1_700_000_000_005,
      status: "sent",
    });
    expect(database.getMessage("default", "u-peer", "official-1")?.isOfficialAccount).toBe(true);
    database.upsertMessage("default", {
      id: "official-1",
      chatId: "u-peer",
      kind: "dm",
      text: "ประกาศจากบัญชีทางการ",
      isMine: false,
      isOfficialAccount: false,
      createdTime: 1_700_000_000_005,
      status: "sent",
    });
    expect(database.getMessage("default", "u-peer", "official-1")?.isOfficialAccount).toBe(true);

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
    expect(database.listMessages("default", "u-peer")).toHaveLength(2);

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
    database.recordProtocolEvent("default", {
      eventKey: "rev:160",
      source: "talk-system",
      opType: "UPDATE_SERVICE_CHAT",
      revision: "160",
      createdTime: 1_700_000_000_030,
      param1: "service",
      raw: { type: 160, param1: "service" },
    });
    expect(database.listProtocolEvents("default")).toMatchObject([{
      eventKey: "rev:160",
      opType: "UPDATE_SERVICE_CHAT",
      revision: "160",
      param1: "service",
    }]);
    expect(database.listChats("default")[0]?.id).toBe("u-peer");
    expect(database.stats("default")).toEqual({ chats: 1, messages: 2, pending: 1 });
    expect(statSync(join(root, "data", "liney.sqlite")).mode & 0o777).toBe(0o600);

    database.clearHistory("default");
    expect(database.stats("default")).toEqual({ chats: 1, messages: 0, pending: 0 });
    database.close();
  });

  test("finds accounts by MID and rekeys legacy data without merging accounts", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-account-test-"));
    const database = new LineyDatabase(join(root, "liney.sqlite"));
    database.upsertAccount("default", { mid: "u-first", displayName: "First" });
    database.upsertChat("default", { id: "u-peer", kind: "dm", name: "Peer" });

    expect(database.findAccountIdByMid("u-first")).toBe("default");
    expect(database.rekeyAccount("default", "account:first")).toBe(true);
    expect(database.findAccountIdByMid("u-first")).toBe("account:first");
    expect(database.listChats("account:first")).toHaveLength(1);
    expect(database.listChats("default")).toHaveLength(0);

    database.upsertAccount("account:second", { mid: "u-second", displayName: "Second" });
    expect(database.rekeyAccount("account:first", "account:second")).toBe(false);
    expect(database.listChats("account:first")).toHaveLength(1);
    database.clearAccount("account:first");
    expect(database.getAccount("account:first")).toBeNull();
    expect(database.listChats("account:first")).toHaveLength(0);
    database.close();
  });

  test("keeps explicit never-chatted rows in the conversation list", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-stale-chat-test-"));
    const database = new LineyDatabase(join(root, "liney.sqlite"));
    database.upsertChat("default", {
      id: "u-stale",
      kind: "dm",
      name: "Stale contact",
      lastMessageTime: 1_700_000_000_000,
      historyState: "new",
    });
    database.upsertChat("default", {
      id: "u-preview",
      kind: "dm",
      name: "Recent contact",
      preview: "hello",
      lastMessageTime: 1_700_000_000_001,
    });

    expect(database.listConversationChats("default").map((chat) => chat.id)).toEqual(["u-preview", "u-stale"]);
    expect(database.listConversationChats("default")[1]).toMatchObject({
      historyState: "new",
    });
    database.close();
  });

  test("keeps link previews persistent and bounded by LRU", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-link-preview-cache-test-"));
    const database = new LineyDatabase(join(root, "liney.sqlite"));

    database.saveLinkPreview("default", "https://example.com/one", { title: "One", siteName: "example.com" }, 2);
    database.saveLinkPreview("default", "https://example.com/two", { title: "Two", siteName: "example.com" }, 2);
    expect(database.getLinkPreview("default", "https://example.com/one")).toMatchObject({ title: "One" });
    database.saveLinkPreview("default", "https://example.com/three", { title: "Three", siteName: "example.com" }, 2);

    expect(database.getLinkPreview("default", "https://example.com/one")).toMatchObject({ title: "One" });
    expect(database.getLinkPreview("default", "https://example.com/three")).toMatchObject({ title: "Three" });
    expect(database.getLinkPreview("default", "https://example.com/two")).toBeNull();
    database.close();
  });

  test("prunes durable message cache without deleting pending rows", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-cache-prune-test-"));
    const database = new LineyDatabase(join(root, "liney.sqlite"));

    for (const chatId of ["u-a", "u-b", "u-c"]) {
      database.upsertChat("default", { id: chatId, kind: "dm", name: chatId });
      for (let index = 0; index < 10; index += 1) {
        database.upsertMessage("default", {
          id: `${chatId}-${index}`,
          chatId,
          kind: "dm",
          text: `message ${index}`,
          isMine: false,
          createdTime: 1_700_000_000_000 + index,
          status: "sent",
        });
      }
    }
    database.upsertMessage("default", {
      id: "pending-1",
      chatId: "u-a",
      kind: "dm",
      text: "still sending",
      isMine: true,
      createdTime: 1_700_000_000_100,
      status: "sending",
    });

    const result = database.pruneMessageCache("default", {
      maxPerChat: 5,
      maxTotal: 12,
      keepPerChat: 2,
    });

    expect(result.removed).toBeGreaterThan(0);
    expect(database.getMessage("default", "u-a", "pending-1")?.status).toBe("sending");
    expect(database.listMessages("default", "u-a", 100).some((message) => message.id === "u-a-9")).toBe(true);
    expect(database.listMessages("default", "u-b", 100).some((message) => message.id === "u-b-9")).toBe(true);
    expect(database.listMessages("default", "u-c", 100).some((message) => message.id === "u-c-9")).toBe(true);
    expect(database.stats("default").messages).toBeLessThanOrEqual(13);
    database.close();
  });

  test("lists visible CALL messages without mixing in other content", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-call-history-test-"));
    const database = new LineyDatabase(join(root, "liney.sqlite"));
    database.upsertMessage("default", {
      id: "call-1",
      chatId: "u-peer",
      kind: "dm",
      text: "Call History : 11000 millisecs, Result: 16",
      isMine: false,
      createdTime: 1_700_000_000_000,
      contentType: 6,
      raw: {
        id: "call-1",
        contentType: "CALL",
        contentMetadata: { DURATION: "11000", RESULT: "NORMAL", CAUSE: "16" },
      },
    });
    database.upsertMessage("default", {
      id: "text-1",
      chatId: "u-peer",
      kind: "dm",
      text: "ข้อความปกติ",
      isMine: false,
      createdTime: 1_700_000_000_001,
      contentType: 0,
    });

    expect(database.listMessagesByContentType("default", 6)).toMatchObject([{
      id: "call-1",
      contentType: 6,
      raw: { contentType: "CALL" },
    }]);
    database.hideMessageForMe("default", "u-peer", "dm", "call-1");
    expect(database.listMessagesByContentType("default", 6)).toEqual([]);
    database.close();
  });
});

describe("E2EE pending recovery index", () => {
  test("returns only encrypted placeholders and stops returning recovered messages", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-e2ee-recovery-test-"));
    const database = new LineyDatabase(join(root, "liney.sqlite"));
    const base = {
      chatId: "u-peer", kind: "dm" as const, isMine: false,
      createdTime: 1_700_000_000_000, contentType: 0,
    };
    database.upsertMessage("default", { ...base, id: "pending", text: "ข้อความเข้ารหัส — ไม่สามารถถอดรหัสได้", raw: {
      id: "pending", contentType: 0, lineyE2eeDecodeError: true,
    } });
    database.upsertMessage("default", { ...base, id: "ready", text: "hello", raw: { id: "ready", contentType: 0 } });
    database.upsertMessage("default", { ...base, id: "fake", text: "like placeholder", raw: { id: "fake", lineyE2eeDecodeError: false } });
    expect(database.listPendingE2EEMessages("default").map((message) => message.id)).toEqual(["pending"]);
    database.upsertMessage("default", { ...base, id: "pending", text: "decrypted", raw: {
      id: "pending", contentType: 0, text: "decrypted",
    } });
    expect(database.listPendingE2EEMessages("default")).toEqual([]);
    database.close();
  });
});
