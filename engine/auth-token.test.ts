import { describe, expect, test } from "bun:test";
import { resolveAccessToken, setAuthToken } from "./auth-token";

describe("auth token persistence", () => {
  test("prefers the rotated token from the event", () => {
    expect(resolveAccessToken("old-token", "new-token")).toBe("new-token");
  });

  test("falls back to the client token when the event has no token", () => {
    expect(resolveAccessToken("old-token", "")).toBe("old-token");
    expect(resolveAccessToken("old-token", undefined)).toBe("old-token");
  });

  test("returns an empty string when neither source has a token", () => {
    expect(resolveAccessToken(undefined, undefined)).toBe("");
    expect(resolveAccessToken("", "   ")).toBe("");
  });

  test("updates the client token used by later requests", () => {
    const client = { base: { authToken: "old-token" } };

    setAuthToken(client as never, "new-token");

    expect(client.base.authToken).toBe("new-token");
  });
});
