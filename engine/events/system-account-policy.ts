export const SYSTEM_ACCOUNT_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const SYSTEM_ACCOUNT_EVENT_THROTTLE_MS = 1_000;
export const SYSTEM_ACCOUNT_BOX_LIMIT = 100;
export const SYSTEM_ACCOUNT_MISSING_BASELINE_CURSOR = "__liney_system_account_not_seen__";

/**
 * The LINE system conversation only matters when it has recent activity. Keep
 * discovery bounded: a new system notification moves the conversation into the
 * recent window. A separate missing-baseline cursor lets the first later
 * appearance be treated as new instead of silently establishing a baseline.
 */
export function systemAccountMessageBoxLimit(_reason: string): number {
  return SYSTEM_ACCOUNT_BOX_LIMIT;
}

export function shouldRecordMissingSystemAccountBaseline(
  reason: string,
  previousCursor: string | undefined,
  foundSystemAccount: boolean,
): boolean {
  return reason === "startup" && !previousCursor && !foundSystemAccount;
}
