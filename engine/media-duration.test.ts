import { describe, expect, test } from "bun:test";
import { mediaDurationMs } from "./media-duration";

describe("mediaDurationMs", () => {
  test("reads DURATION milliseconds from object metadata", () => {
    expect(mediaDurationMs({ contentMetadata: { DURATION: "89746" } })).toBe(89746);
    expect(mediaDurationMs({ contentMetadata: { duration: 1200 } })).toBe(1200);
  });

  test("reads JSON-string metadata and the wrapped raw message shape", () => {
    expect(mediaDurationMs({ contentMetadata: JSON.stringify({ DURATION: 4500 }) })).toBe(4500);
    expect(mediaDurationMs({ raw: { contentMetadata: { DURATION: 9000 } } })).toBe(9000);
  });

  test("ignores missing, zero and malformed durations", () => {
    expect(mediaDurationMs({})).toBeUndefined();
    expect(mediaDurationMs({ contentMetadata: { DURATION: 0 } })).toBeUndefined();
    expect(mediaDurationMs({ contentMetadata: { DURATION: "not-a-number" } })).toBeUndefined();
    expect(mediaDurationMs(null)).toBeUndefined();
  });
});
