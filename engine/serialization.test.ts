import { describe, expect, test } from "bun:test";
import { normalizeJsonValue, parseJsonValue } from "./serialization";

describe("persisted binary serialization", () => {
  test("round-trips Uint8Array as bytes instead of numeric objects", () => {
    const encoded = JSON.stringify(normalizeJsonValue({ chunks: [Uint8Array.of(0, 127, 255)] }));
    const restored = parseJsonValue(encoded, true) as { chunks: Buffer[] };
    expect(Buffer.isBuffer(restored.chunks[0])).toBe(true);
    expect([...restored.chunks[0]]).toEqual([0, 127, 255]);
    expect(encoded).toContain("__liney_binary_v1__");
  });

  test("repairs legacy numeric chunk objects from existing SQLite rows", () => {
    const restored = parseJsonValue(JSON.stringify({ chunks: [{ "0": 1, "1": 2, "2": 255 }] }), true) as { chunks: Buffer[] };
    expect(Buffer.isBuffer(restored.chunks[0])).toBe(true);
    expect([...restored.chunks[0]]).toEqual([1, 2, 255]);
  });
});

