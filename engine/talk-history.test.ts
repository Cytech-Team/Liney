import { describe, expect, test } from "bun:test";
import { additionalTalkHistoryBoxIds, talkMessageBoxHasHistory } from "./talk-history";

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
});
