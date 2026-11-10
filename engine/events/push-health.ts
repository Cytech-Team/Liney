// Do not start REST polling until the initial PUSH Talk subscription has
// had the same bounded window to produce its first sync response.
export const PUSH_SYNC_RESPONSE_TIMEOUT_MS = 8_000;
export const PUSH_STARTUP_GRACE_MS = PUSH_SYNC_RESPONSE_TIMEOUT_MS;
// LINEJS sends a PUSH heartbeat every 30 seconds. Allow three missed beats
// before declaring the stream stale; quiet chats are not themselves failures.
export const PUSH_HEARTBEAT_TIMEOUT_MS = 95_000;
export const PUSH_HEARTBEAT_CHECK_INTERVAL_MS = 10_000;

export function isPushHeartbeatStale(lastHeartbeatAt: number, now: number): boolean {
  return lastHeartbeatAt > 0 && now - lastHeartbeatAt >= PUSH_HEARTBEAT_TIMEOUT_MS;
}

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
