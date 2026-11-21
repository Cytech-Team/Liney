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
 * Only a code that LINE itself returns may invalidate the stored credential.
 * Network errors and unknown failures must keep it so a temporary outage does
 * not force the user through a new QR login.
 */
export function isDefinitiveAuthFailure(error: unknown): boolean {
  return DEFINITIVE_AUTH_CODES.has(authErrorCode(error));
}
