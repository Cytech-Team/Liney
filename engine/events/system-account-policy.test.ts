import { describe, expect, test } from "bun:test";
import {
  SYSTEM_ACCOUNT_BOX_LIMIT,
  SYSTEM_ACCOUNT_MISSING_BASELINE_CURSOR,
  SYSTEM_ACCOUNT_RECONCILE_INTERVAL_MS,
  shouldRecordMissingSystemAccountBaseline,
  systemAccountMessageBoxLimit,
} from "./system-account-policy";

describe("LINE system account tracking policy", () => {
  test("does not run full-account reconciliation every few seconds while idle", () => {
    expect(SYSTEM_ACCOUNT_RECONCILE_INTERVAL_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  test("bounds startup and event reconciliation to the recent message-box window", () => {
    expect(systemAccountMessageBoxLimit("startup")).toBe(SYSTEM_ACCOUNT_BOX_LIMIT);
    expect(systemAccountMessageBoxLimit("op:NOTIFIED_UPDATE_PROFILE")).toBe(SYSTEM_ACCOUNT_BOX_LIMIT);
    expect(systemAccountMessageBoxLimit("reconcile")).toBe(SYSTEM_ACCOUNT_BOX_LIMIT);
    expect(SYSTEM_ACCOUNT_BOX_LIMIT).toBeLessThanOrEqual(100);
  });

  test("records a missing startup baseline so a later first appearance is not swallowed", () => {
    expect(shouldRecordMissingSystemAccountBaseline("startup", undefined, false)).toBe(true);
    expect(shouldRecordMissingSystemAccountBaseline("startup", "123", false)).toBe(false);
    expect(shouldRecordMissingSystemAccountBaseline("reconcile", undefined, false)).toBe(false);
    expect(shouldRecordMissingSystemAccountBaseline("startup", undefined, true)).toBe(false);
    expect(SYSTEM_ACCOUNT_MISSING_BASELINE_CURSOR.length).toBeGreaterThan(0);
  });
});
