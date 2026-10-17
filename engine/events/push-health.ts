export const PUSH_STARTUP_GRACE_MS = 3_000;

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
