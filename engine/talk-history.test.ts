import { describe, expect, test } from "bun:test";
import { additionalTalkHistoryBoxIds, LINE_SYSTEM_ACCOUNT_MID, shouldRetryTalkHistory, talkMessageBoxHasHistory, talkMessageBoxHistoryState } from "./talk-history";

describe("Talk message-box history discovery", () => {
  test("keeps historical rooms that are absent from the active joined-chat list", () => {
    expect(additionalTalkHistoryBoxIds(
      ["c-active"],
      [
        { id: "c-active", lastMessages: [{ id: "already-known" }] },
        { id: "u-mom", lastMessages: [{ id: "historical" }] },
        { id: "u-empty", lastMessages: [] },
        { id: "missing-id", lastMessages: [{ id: "ignored" }] },
        { id: "u-mom", lastMessages: [{ id: "duplicate" }] },
      ],
    )).toEqual(["u-mom", "missing-id"]);
  });

  test("does not classify empty boxes as rooms with history", () => {
    expect(talkMessageBoxHasHistory({ id: "u-empty", lastMessages: [] })).toBe(false);
    expect(talkMessageBoxHasHistory({ id: "u-missing" })).toBe(false);
    expect(talkMessageBoxHasHistory({ id: "u-has-history", lastMessages: [{ id: "m-1" }] })).toBe(true);
  });


  test("separates never-chatted rooms from unavailable old history", () => {
    expect(talkMessageBoxHistoryState({
      id: "u-noi23",
      unreadCount: 0,
      lastMessages: [],
    })).toBe("new");
    expect(talkMessageBoxHistoryState({
      id: LINE_SYSTEM_ACCOUNT_MID,
      unreadCount: 0,
      lastMessages: [],
    })).toBe("unavailable");
    expect(talkMessageBoxHistoryState({
      id: "u-old",
      unreadCount: 0,
      lastMessages: [],
      lastSeenMessageId: "12799637962986",
      lastRemovedMessageId: "12799637958927",
    })).toBe("unavailable");
    expect(talkMessageBoxHistoryState({
      id: "u-live",
      lastMessages: [{ id: "m-1" }],
    })).toBe("available");
    expect(talkMessageBoxHistoryState({
      id: "u-unread",
      unreadCount: 2,
      lastMessages: [],
    })).toBe("unavailable");
  });

  test("retries recent history when a cursor query returns no messages", () => {
    expect(shouldRetryTalkHistory({ messageId: "last" }, 0)).toBe(true);
    expect(shouldRetryTalkHistory({ messageId: "last" }, 1)).toBe(false);
    expect(shouldRetryTalkHistory(undefined, 0)).toBe(false);
  });
});
