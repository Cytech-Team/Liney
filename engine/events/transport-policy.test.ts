import { describe, expect, test } from "bun:test";
import { eventTransportPolicy } from "./transport-policy";

describe("event transport policy", () => {
  test("keeps push primary and polling fallback enabled by default", () => {
    expect(eventTransportPolicy({})).toEqual({ pushEnabled: true, pollingEnabled: true });
  });

  test("allows isolating either transport for diagnostics/recovery", () => {
    expect(eventTransportPolicy({ LINEY_DISABLE_PUSH: "1" })).toEqual({ pushEnabled: false, pollingEnabled: true });
    expect(eventTransportPolicy({ LINEY_DISABLE_EVENT_POLLING: "1" })).toEqual({ pushEnabled: true, pollingEnabled: false });
  });
});
