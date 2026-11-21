// Do not start REST polling until the initial PUSH Talk subscription has
// had the same bounded window to produce its first sync response.
export const PUSH_SYNC_RESPONSE_TIMEOUT_MS = 8_000;
export const PUSH_STARTUP_GRACE_MS = PUSH_SYNC_RESPONSE_TIMEOUT_MS;
/**
 * A launch without a persisted Talk sync cursor has to ask LINE for a full
 * account sync before the PUSH subscription delivers anything. That request
 * regularly takes longer than the fallback grace window, so the first PUSH
 * connection is allowed this much extra time to finish it instead of being
 * torn down and restarted from revision zero.
 */
export const PUSH_SYNC_RESPONSE_EXTENDED_TIMEOUT_MS = 60_000;

export type PushConnectionState = {
  healthy: boolean;
  connectedSince: number;
  fallbackNotBefore: number;
  now: number;
};

/**
 * Polling is fallback-only. A quiet but synced push transport is healthy;
 * the absence of chat events is not evidence that the connection is stale.
 * During startup, wait for the initial Talk sync handshake before allowing
 * REST polling to compete for the shared LINE revision cursor.
 */
export function shouldUsePollingFallback(state: PushConnectionState): boolean {
  if (state.healthy && state.connectedSince > 0) return false;
  return state.now >= state.fallbackNotBefore;
}
