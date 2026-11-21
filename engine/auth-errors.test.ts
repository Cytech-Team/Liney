import { describe, expect, test } from "bun:test";
import { authErrorCode, isDefinitiveAuthFailure } from "./auth-errors";

describe("auth error classification", () => {
  test("reads the LINE error code from the flat data payload", () => {
    expect(authErrorCode({ data: { code: "NOT_AUTHORIZED_DEVICE" } })).toBe("NOT_AUTHORIZED_DEVICE");
  });

  test("reads the LINE error code from a nested thrift exception", () => {
    expect(authErrorCode({ data: { e: { code: "AUTHENTICATION_FAILED" } } })).toBe("AUTHENTICATION_FAILED");
  });

  test("treats revoked or invalid sessions as definitive failures", () => {
    for (const code of ["NOT_AUTHORIZED_DEVICE", "AUTHENTICATION_FAILED", "INVALID_TOKEN"]) {
      expect(isDefinitiveAuthFailure({ data: { code } })).toBe(true);
    }
  });

  test("keeps the stored credential for network or unknown failures", () => {
    expect(isDefinitiveAuthFailure(new Error("fetch failed"))).toBe(false);
    expect(isDefinitiveAuthFailure({ data: { code: "INTERNAL_ERROR" } })).toBe(false);
    expect(isDefinitiveAuthFailure(null)).toBe(false);
  });
});
