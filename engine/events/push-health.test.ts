import { describe, expect, test } from "bun:test";
import { PUSH_STARTUP_GRACE_MS, shouldUsePollingFallback } from "./push-health";

describe("push transport health", () => {
  test("keeps polling off for a healthy idle push connection", () => {
    const now = 100_000;
    expect(shouldUsePollingFallback({
      healthy: true,
      connectedSince: now - 60_000,
      fallbackNotBefore: now - 1,
      now,
    })).toBe(false);
  });

  test("gives initial PUSH connection a grace period before enabling fallback", () => {
    const startedAt = 100_000;
    expect(shouldUsePollingFallback({
      healthy: false,
      connectedSince: 0,
      fallbackNotBefore: startedAt + PUSH_STARTUP_GRACE_MS,
      now: startedAt + PUSH_STARTUP_GRACE_MS - 1,
    })).toBe(false);
    expect(shouldUsePollingFallback({
      healthy: false,
      connectedSince: 0,
      fallbackNotBefore: startedAt + PUSH_STARTUP_GRACE_MS,
      now: startedAt + PUSH_STARTUP_GRACE_MS,
    })).toBe(true);
  });

  test("allows immediate fallback when PUSH is intentionally disabled", () => {
    expect(shouldUsePollingFallback({
      healthy: false,
      connectedSince: 0,
      fallbackNotBefore: 0,
      now: 1,
    })).toBe(true);
  });
});
