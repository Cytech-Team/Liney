import type { LineClient } from "./linejs/adapter";

/**
 * LINE may rotate the access token through the `update:authtoken` event
 * without assigning it back to the client. Persist the event value, otherwise
 * the next launch can restore an already invalidated token.
 */
export function resolveAccessToken(clientToken: unknown, eventToken: unknown): string {
  const rotated = typeof eventToken === "string" ? eventToken.trim() : "";
  if (rotated) return rotated;
  return typeof clientToken === "string" ? clientToken.trim() : "";
}

export function setAuthToken(client: LineClient, token: string): void {
  const base = (client as unknown as { base?: { authToken?: string } }).base;
  if (base) base.authToken = token;
}
