const DEFINITIVE_AUTH_CODES = new Set([
  "NOT_AUTHORIZED_DEVICE",
  "AUTHENTICATION_FAILED",
  "INVALID_TOKEN",
]);

type ErrorLike = {
  code?: unknown;
  data?: { code?: unknown; e?: { code?: unknown } };
};

export function authErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as ErrorLike;
  return String(value.data?.code ?? value.data?.e?.code ?? value.code ?? "").trim();
}

/**
 * Diagnostics-safe summary of a QR/login failure. LINEJS can include response
 * headers and bodies in the message; keep the status and the shape, drop the
 * payload and any long opaque token.
 */
export function authErrorSummary(error: unknown): { code: string; status: string; message: string } {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = /status=(\d{3})\b/.exec(message)?.[1] ?? "";
  const safe = message
    .replace(/headers=\[[^\]]*\]/gi, "headers=[redacted]")
    .replace(/body=<[^>]*>/gi, "body=<redacted>")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .slice(0, 300);
  return { code: authErrorCode(error) || "unknown", status, message: safe };
}

/**
 * Only a code that LINE itself returns may invalidate the stored credential.
 * Network errors and unknown failures must keep it so a temporary outage does
 * not force the user through a new QR login.
 */
export function isDefinitiveAuthFailure(error: unknown): boolean {
  return DEFINITIVE_AUTH_CODES.has(authErrorCode(error));
}
