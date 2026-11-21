import { describe, expect, test } from "bun:test";
import {
  isExpiredTalkSyncCursorError,
  resetTalkSyncCursor,
  restoreTalkSyncCursor,
  talkSyncCursor,
} from "./linejs/adapter";

function fakeClient(talk: Record<string, unknown> = {}) {
  return { base: { poll: { sync: { talk } } } } as any;
}

describe("Talk sync cursor persistence", () => {
  test("reads the cursor LINEJS keeps in memory", () => {
    const client = fakeClient({ revision: 413193, globalRev: 1356729, individualRev: 51803 });
    expect(talkSyncCursor(client)).toEqual({
      revision: 413193,
      globalRev: 1356729,
      individualRev: 51803,
    });
  });

  test("restores a stored cursor before transports attach", () => {
    const client = fakeClient({ revision: 0, globalRev: 0, individualRev: 0 });
    restoreTalkSyncCursor(client, { revision: 413193, globalRev: 1356729, individualRev: 51803 });
    expect(talkSyncCursor(client)).toEqual({
      revision: 413193,
      globalRev: 1356729,
      individualRev: 51803,
    });
  });

  test("ignores malformed or missing stored cursors", () => {
    const client = fakeClient({ revision: 9, globalRev: 8, individualRev: 7 });
    restoreTalkSyncCursor(client, null);
    expect(talkSyncCursor(client)).toEqual({ revision: 0, globalRev: 0, individualRev: 0 });
    restoreTalkSyncCursor(client, { revision: "nope", globalRev: -1, individualRev: 12 } as any);
    expect(talkSyncCursor(client)).toEqual({ revision: 0, globalRev: 0, individualRev: 12 });
  });

  test("treats an HTTP 410 Gone sync response as an expired cursor", () => {
    expect(isExpiredTalkSyncCursorError(new Error("Request internal failed: status=410 headers=[] body=<>"))).toBe(true);
    expect(isExpiredTalkSyncCursorError("status=410")).toBe(true);
    expect(isExpiredTalkSyncCursorError(new Error("status=500"))).toBe(false);
    expect(isExpiredTalkSyncCursorError(new Error("timed out"))).toBe(false);
  });

  test("resets the cursor so the next attempt performs a full sync", () => {
    const client = fakeClient({ revision: 413193, globalRev: 1356729, individualRev: 51803 });
    resetTalkSyncCursor(client);
    expect(talkSyncCursor(client)).toEqual({ revision: 0, globalRev: 0, individualRev: 0 });
  });
});
