import { describe, expect, test } from "bun:test";
import { adaptivePlaybackPrebufferMs } from "./call-playback-buffer";

describe("adaptive call playback buffer", () => {
  test("keeps stable 20ms audio low latency", () => {
    expect(adaptivePlaybackPrebufferMs(20, [20, 20, 21, 19])).toBe(40);
  });

  test("matches stable 40ms packet cadence automatically", () => {
    const target = adaptivePlaybackPrebufferMs(40, [39, 41, 40, 40]);
    expect(target).toBeGreaterThanOrEqual(80);
    expect(target).toBeLessThanOrEqual(100);
  });

  test("adds headroom on jittery links without growing without bound", () => {
    const target = adaptivePlaybackPrebufferMs(20, [18, 22, 19, 70, 21, 65]);
    expect(target).toBeGreaterThanOrEqual(70);
    expect(target).toBeLessThanOrEqual(240);
  });

  test("caps pathological stalls", () => {
    expect(adaptivePlaybackPrebufferMs(20, [20, 900, 20, 800])).toBeLessThanOrEqual(240);
  });
});
