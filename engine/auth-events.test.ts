import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { attachAuthEvents } from "./auth-events";

function fakeClient(token = "old-token") {
  const base = Object.assign(new EventEmitter(), { authToken: token });
  return { client: { base } as never, base };
}

describe("auth events", () => {
  test("writes a rotated token back to the client before persisting it", () => {
    const { client, base } = fakeClient();
    const tokens: string[] = [];
    attachAuthEvents(client, {
      active: () => true,
      onToken: (token) => tokens.push(token),
      onSessionEnded: () => {},
    });

    base.emit("update:authtoken", "rotated-token");

    expect(base.authToken).toBe("rotated-token");
    expect(tokens).toEqual(["rotated-token"]);
  });

  test("keeps the current token when LINE emits an empty rotation", () => {
    const { client, base } = fakeClient();
    const tokens: string[] = [];
    attachAuthEvents(client, {
      active: () => true,
      onToken: (token) => tokens.push(token),
      onSessionEnded: () => {},
    });

    base.emit("update:authtoken", "");

    expect(base.authToken).toBe("old-token");
    expect(tokens).toEqual(["old-token"]);
  });

  test("surfaces a remote session end instead of ignoring it", () => {
    const { client, base } = fakeClient();
    const reasons: string[] = [];
    attachAuthEvents(client, {
      active: () => true,
      onToken: () => {},
      onSessionEnded: (reason) => reasons.push(reason),
    });

    base.emit("end");

    expect(reasons).toEqual(["NOT_AUTHORIZED_DEVICE"]);
  });

  test("ignores events from a client that has already been replaced", () => {
    const { client, base } = fakeClient();
    let active = true;
    const tokens: string[] = [];
    const reasons: string[] = [];
    attachAuthEvents(client, {
      active: () => active,
      onToken: (token) => tokens.push(token),
      onSessionEnded: (reason) => reasons.push(reason),
    });

    active = false;
    base.emit("update:authtoken", "stale-token");
    base.emit("end");

    expect(tokens).toEqual([]);
    expect(reasons).toEqual([]);
    expect(base.authToken).toBe("old-token");
  });
});
