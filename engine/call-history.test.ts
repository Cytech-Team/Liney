import { describe, expect, test } from "bun:test";
import {
  callHistoryPreview,
  formatCallDuration,
  parseCallHistory,
} from "./call-history";

describe("call history presentation", () => {
  test("parses LINE CALL metadata instead of exposing the protocol text", () => {
    const call = parseCallHistory({
      contentType: "CALL",
      text: "Call History : 11000 millisecs, Result: 16",
      contentMetadata: {
        DURATION: "11000",
        RESULT: "NORMAL",
        CAUSE: "16",
      },
    });

    expect(call).toEqual({
      durationMs: 11_000,
      result: "NORMAL",
      cause: "16",
      status: "completed",
    });
    expect(callHistoryPreview(call)).toBe("โทรสำเร็จ · 11 วินาที");
    expect(formatCallDuration(call?.durationMs ?? 0)).toBe("11 วินาที");
  });

  test("keeps failed call outcomes distinct", () => {
    expect(parseCallHistory({
      contentType: 6,
      contentMetadata: { DURATION: "0", RESULT: "REJECTED", CAUSE: "21" },
    })?.status).toBe("rejected");
    expect(parseCallHistory({
      contentType: 6,
      contentMetadata: { DURATION: "0", RESULT: "NO_RESPONSE", CAUSE: "18" },
    })?.status).toBe("no-response");
    expect(parseCallHistory({
      contentType: 6,
      contentMetadata: { DURATION: "0", RESULT: "CANCELED", CAUSE: "77" },
    })?.status).toBe("canceled");
  });

  test("recovers a call record from legacy protocol text", () => {
    expect(parseCallHistory({
      contentType: 6,
      text: "Call History : 86000 millisecs, Result: 16",
    })).toMatchObject({
      durationMs: 86_000,
      cause: "16",
      status: "completed",
    });
  });

  test("ignores non-call messages", () => {
    expect(parseCallHistory({ contentType: 0, text: "Call History : 11000 millisecs, Result: 16" })).toBeNull();
  });
});
