import { describe, expect, test } from "bun:test";
import { detectImageMime, normalizeImageBlob } from "./media-format";

describe("media format validation", () => {
  test("detects image bytes even when LINE omits the MIME type", async () => {
    const image = await normalizeImageBlob(new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])]));
    expect(image.type).toBe("image/jpeg");
  });

  test("rejects a successful HTTP error body", async () => {
    expect(detectImageMime(new TextEncoder().encode("<html>not an image</html>"), "image/jpeg")).toBeUndefined();
    await expect(normalizeImageBlob(new Blob(["{\"error\":true}"], { type: "application/json" }))).rejects.toThrow("non-image");
  });

  test("recognizes PNG and WebP signatures", () => {
    expect(detectImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(detectImageMime(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
  });
});

