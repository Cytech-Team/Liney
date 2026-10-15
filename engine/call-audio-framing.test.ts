import { describe, expect, test } from "bun:test";
import { framePlanetOneToOneOpus, unframePlanetOneToOneOpus } from "./call-audio-framing";

describe("PLANET 1:1 Opus framing", () => {
  test("adds the native 0x00 prefix before sending raw Opus", () => {
    const raw = new Uint8Array([0x78, 0x11, 0x22]);
    expect(Array.from(framePlanetOneToOneOpus(raw))).toEqual([0x00, 0x78, 0x11, 0x22]);
  });

  test("removes the native 0x00 prefix before Opus decoding", () => {
    const native = new Uint8Array([0x00, 0x78, 0x11, 0x22]);
    expect(Array.from(unframePlanetOneToOneOpus(native))).toEqual([0x78, 0x11, 0x22]);
  });

  test("removes a non-zero native prefix such as 0x10", () => {
    const native = new Uint8Array([0x10, 0x78, 0x11, 0x22]);
    expect(Array.from(unframePlanetOneToOneOpus(native))).toEqual([0x78, 0x11, 0x22]);
  });

  test("does not turn an empty native payload into invalid data", () => {
    const oneByte = new Uint8Array([0x10]);
    expect(unframePlanetOneToOneOpus(oneByte)).toBe(oneByte);
  });
});
