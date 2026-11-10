// Do not start REST polling until the initial PUSH Talk subscription has
// had the same bounded window to produce its first sync response.
export const PUSH_SYNC_RESPONSE_TIMEOUT_MS = 8_000;
export const PUSH_STARTUP_GRACE_MS = PUSH_SYNC_RESPONSE_TIMEOUT_MS;

export type PushConnectionState = {
  healthy: boolean;
  connectedSince: number;
  fallbackNotBefore: number;
  now: number;
};

/**
 * Polling is fallback-only. A quiet but connected push transport is healthy;
 * the absence of chat events is not evidence that the connection is stale.
 * During initial connection setup, give PUSH a short grace period so REST
 * polling does not race the first PUSH sync request.
 */
export function shouldUsePollingFallback(state: PushConnectionState): boolean {
  if (state.healthy && state.connectedSince > 0) return false;
  return state.now >= state.fallbackNotBefore;
}
