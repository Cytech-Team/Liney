import { resolveAccessToken, setAuthToken } from "./auth-token";
import { LineJsAdapter, type LineClient } from "./linejs/adapter";

export type AuthEventHooks = {
  /** False once this client has been logged out or replaced by a new login. */
  active: () => boolean;
  onToken: (token: string) => void;
  onSessionEnded: (reason: string) => void;
};

/**
 * LINEJS emits the rotated access token from `x-line-next-access` but never
 * assigns it back to `client.base.authToken`. Without this listener every
 * request after the first rotation keeps using an invalidated token, and the
 * credential persisted at that moment is already dead.
 *
 * LINEJS also emits `end` when LINE rejects the device or the session is
 * revoked. That event used to be dropped, leaving the UI on cached data with
 * no way to recover.
 */
export function attachAuthEvents(client: LineClient, hooks: AuthEventHooks): void {
  LineJsAdapter.on(client, "update:authtoken", (token: unknown) => {
    if (!hooks.active()) return;
    const next = resolveAccessToken(LineJsAdapter.authToken(client), token);
    if (!next) return;
    setAuthToken(client, next);
    hooks.onToken(next);
  });
  LineJsAdapter.on(client, "end", () => {
    if (!hooks.active()) return;
    hooks.onSessionEnded("NOT_AUTHORIZED_DEVICE");
  });
}
