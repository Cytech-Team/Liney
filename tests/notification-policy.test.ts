import { describe, expect, test } from "bun:test";
import { shouldNotifyMessage } from "../src/lib/notification-policy";

const now = 1_700_000_000_000;

describe("desktop notification policy", () => {
  test("notifies for a fresh incoming message in a hidden chat", () => {
    expect(shouldNotifyMessage({
      isMine: false,
      visible: false,
      createdTime: now - 5_000,
      armedAt: now - 10_000,
      now,
    })).toBe(true);
  });

  test("suppresses the historical replay after login", () => {
    for (const createdTime of [now - 60_000, now - 10 * 60_000, now - 24 * 60 * 60_000]) {
      expect(shouldNotifyMessage({
        isMine: false,
        visible: false,
        createdTime,
        armedAt: now,
        now,
      })).toBe(false);
    }
  });

  test("suppresses own messages and the currently visible chat", () => {
    expect(shouldNotifyMessage({ isMine: true, visible: false, createdTime: now, armedAt: now - 10_000, now })).toBe(false);
    expect(shouldNotifyMessage({ isMine: false, visible: true, createdTime: now, armedAt: now - 10_000, now })).toBe(false);
  });

  test("suppresses messages without a usable timestamp", () => {
    expect(shouldNotifyMessage({ isMine: false, visible: false, createdTime: 0, armedAt: now, now })).toBe(false);
    expect(shouldNotifyMessage({ isMine: false, visible: false, createdTime: Number.NaN, armedAt: now, now })).toBe(false);
  });

  test("allows messages created after login even if delivery is delayed", () => {
    expect(shouldNotifyMessage({
      isMine: false,
      visible: false,
      createdTime: now - 2 * 60_000,
      armedAt: now - 3 * 60_000,
      now,
    })).toBe(true);
  });
});
