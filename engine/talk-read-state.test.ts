import { describe, expect, test } from "bun:test";
import { talkReadStateForMessages } from "./talk-read-state";

describe("Talk read range state", () => {
  test("counts unique peer readers with lossless 64-bit message ids", () => {
    const range = {
      chatId: "c-room",
      ranges: {
        "u-self": [{ startMessageId: "631457091218833600", endMessageId: "631457091218833700", startTime: 1, endTime: 2 }],
        "u-a": [{ startMessageId: "631457091218833620", endMessageId: "631457091218833650", startTime: 1, endTime: 2 }],
        "u-b": [
          { startMessageId: "631457091218833634", endMessageId: "631457091218833640", startTime: 1, endTime: 2 },
          { startMessageId: "631457091218833634", endMessageId: "631457091218833640", startTime: 1, endTime: 2 },
        ],
      },
    };

    expect(talkReadStateForMessages(range, [
      "631457091218833619",
      "631457091218833634",
      "631457091218833651",
    ], "u-self")).toEqual([
      { messageId: "631457091218833619", readCount: 0, readerMids: [] },
      { messageId: "631457091218833634", readCount: 2, readerMids: ["u-a", "u-b"] },
      { messageId: "631457091218833651", readCount: 0, readerMids: [] },
    ]);
  });

  test("accepts reversed ranges and ignores invalid ids", () => {
    const range = {
      chatId: "u-peer",
      ranges: {
        "u-peer": [{ startMessageId: "20", endMessageId: "10", startTime: 0, endTime: 0 }],
      },
    };
    expect(talkReadStateForMessages(range, ["15", "not-an-id"], "u-self")).toEqual([
      { messageId: "15", readCount: 1, readerMids: ["u-peer"] },
      { messageId: "not-an-id", readCount: 0, readerMids: [] },
    ]);
  });
});
