import { describe, expect, test } from "bun:test";
import { PUSH_HEARTBEAT_TIMEOUT_MS, PUSH_STARTUP_GRACE_MS, PUSH_SYNC_RESPONSE_TIMEOUT_MS, isPushHeartbeatStale, shouldUsePollingFallback } from "./events/push-health";
import { observePushHeartbeat, observePushTalkSyncResponse } from "./linejs/adapter";

describe("PUSH Talk sync readiness", () => {
  test("does not declare startup fallback ready before the Talk sync handshake timeout", () => {
    expect(PUSH_STARTUP_GRACE_MS).toBe(PUSH_SYNC_RESPONSE_TIMEOUT_MS);
    expect(PUSH_SYNC_RESPONSE_TIMEOUT_MS).toBe(8_000);
    const now = 50_000;
    expect(shouldUsePollingFallback({
      healthy: false,
      connectedSince: 0,
      fallbackNotBefore: now + PUSH_STARTUP_GRACE_MS,
      now: now + PUSH_STARTUP_GRACE_MS - 1,
    })).toBe(false);
    expect(shouldUsePollingFallback({
      healthy: false,
      connectedSince: 0,
      fallbackNotBefore: now + PUSH_STARTUP_GRACE_MS,
      now: now + PUSH_STARTUP_GRACE_MS,
    })).toBe(true);
  });

  test("keeps REST fallback gated while a failed PUSH connection is closing", () => {
    const now = 100_000;
    expect(shouldUsePollingFallback({
      healthy: false,
      connectedSince: 0,
      fallbackNotBefore: Number.POSITIVE_INFINITY,
      now,
    })).toBe(false);
    expect(shouldUsePollingFallback({
      healthy: false,
      connectedSince: 0,
      fallbackNotBefore: now,
      now,
    })).toBe(true);
  });

  test("detects a stale PUSH heartbeat without treating quiet chats as stale", () => {
    const lastHeartbeatAt = 100_000;
    expect(PUSH_HEARTBEAT_TIMEOUT_MS).toBe(95_000);
    expect(isPushHeartbeatStale(lastHeartbeatAt, lastHeartbeatAt + 94_999)).toBe(false);
    expect(isPushHeartbeatStale(lastHeartbeatAt, lastHeartbeatAt + 95_000)).toBe(true);
    expect(isPushHeartbeatStale(0, 1_000_000)).toBe(false);
  });

  test("observes heartbeat acknowledgements and preserves the LINEJS handler", () => {
    const received: number[] = [];
    const original = function (this: { marker: string }, pingId: number) {
      received.push(pingId);
      expect(this.marker).toBe("manager");
    };
    const push = { marker: "manager", onPingCallback: original };
    const observed: number[] = [];
    const stop = observePushHeartbeat(push, (pingId) => observed.push(pingId));

    push.onPingCallback.call(push, 3);
    expect(received).toEqual([3]);
    expect(observed).toEqual([3]);

    stop();
    expect(push.onPingCallback).toBe(original);
  });

  test("marks readiness only after a complete Talk sync response", async () => {
    const received: number[] = [];
    const original = async (requestId: number, _isFin?: boolean, _data?: Uint8Array) => {
      received.push(requestId);
      return undefined;
    };
    const push = {
      onSignOnResponse: original,
      signOnRequests: {
        1: [3, "fetchMyEvents", null],
        2: [8, "sync", null],
      },
    };
    let ready = 0;
    const stop = observePushTalkSyncResponse(push, () => { ready += 1; });

    await push.onSignOnResponse(1, true, new Uint8Array());
    await push.onSignOnResponse(2, false, new Uint8Array());
    expect(ready).toBe(0);

    await push.onSignOnResponse(2, true, new Uint8Array());
    expect(ready).toBe(1);
    expect(received).toEqual([1, 2, 2]);

    stop();
    expect(push.onSignOnResponse).toBe(original);
  });

  test("does not mark a rejected Talk sync response as ready", async () => {
    const original = async () => false;
    const push = {
      onSignOnResponse: original,
      signOnRequests: { 1: [8, "sync", null] },
    };
    let ready = 0;
    const stop = observePushTalkSyncResponse(push, () => { ready += 1; });

    const result = await push.onSignOnResponse(1, true, new Uint8Array());
    expect(result).toBe(false);
    expect(ready).toBe(0);

    stop();
    expect(push.onSignOnResponse).toBe(original);
  });

  test("does not overwrite a newer PUSH response handler during cleanup", () => {
    const original = () => undefined;
    const newer = () => undefined;
    const push = { onSignOnResponse: original, signOnRequests: {} };
    const stop = observePushTalkSyncResponse(push, () => undefined);
    push.onSignOnResponse = newer;
    stop();
    expect(push.onSignOnResponse).toBe(newer);
  });
});
