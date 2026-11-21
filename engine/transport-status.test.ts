import { describe, expect, test } from "bun:test";
import { reduceLineTransportState } from "../src/transport-status";

describe("LINE transport status reducer", () => {
  test("moves to connected only after the LINE transport confirms it", () => {
    expect(reduceLineTransportState("unknown", { type: "event.transport", transport: "line", state: "connected" })).toBe("connected");
  });

  test("shows reconnecting when LINE transport reconnects", () => {
    expect(reduceLineTransportState("connected", { type: "event.transport", transport: "line", state: "reconnecting" })).toBe("reconnecting");
  });

  test.each(["talk", "openchat", "talk-poll", "openchat-poll"])("marks %s failures as degraded", (transport) => {
    expect(reduceLineTransportState("connected", { type: "event.transport.error", transport })).toBe("degraded");
  });

  test("resets after logout or failed session restore", () => {
    for (const type of ["auth.logged_out", "auth.restore_failed"]) {
      expect(reduceLineTransportState("degraded", { type })).toBe("unknown");
    }
  });

  test("ignores unrelated events and unknown transport states", () => {
    expect(reduceLineTransportState("connected", { type: "event.transport", transport: "line", state: "idle" })).toBe("connected");
    expect(reduceLineTransportState("connected", { type: "event.transport.error", transport: "profile" })).toBe("connected");
    expect(reduceLineTransportState("connected", { type: "engine.ready" })).toBe("connected");
  });
});
