import { describe, expect, test } from "bun:test";
import { stickerUrlCandidatesFromRaw, stickerUrlFromRaw } from "./sticker";

describe("stickerUrlFromRaw", () => {
  test("builds an animated sticker URL", () => {
    expect(stickerUrlFromRaw({
      contentType: "STICKER",
      contentMetadata: { STKID: "856655617", STKOPT: "A", STKPKGID: "37505" },
    })).toBe("https://stickershop.line-scdn.net/stickershop/v1/sticker/856655617/android/sticker_animation.png");
  });

  test("builds a static URL for Square payloads", () => {
    expect(stickerUrlFromRaw({
      contentType: "STICKER",
      contentMetadata: { STKID: "1734385", STKOPT: "", STKPKGID: "1041359" },
    })).toBe("https://stickershop.line-scdn.net/stickershop/v1/sticker/1734385/android/sticker.png");
  });

  test("returns undefined when sticker metadata is unavailable", () => {
    expect(stickerUrlFromRaw({ contentType: "STICKER", contentMetadata: {} })).toBeUndefined();
    expect(stickerUrlFromRaw(undefined)).toBeUndefined();
  });

  test("accepts JSON metadata and provides Android, legacy Android, and iPhone fallbacks", () => {
    const candidates = stickerUrlCandidatesFromRaw({
      contentMetadata: JSON.stringify({ STKID: "651698630", STKOPT: "" }),
    });
    expect(candidates).toEqual([
      "https://stickershop.line-scdn.net/stickershop/v1/sticker/651698630/android/sticker.png",
      "https://stickershop.line-scdn.net/stickershop/v1/sticker/651698630/ANDROID/sticker.png",
      "https://stickershop.line-scdn.net/stickershop/v1/sticker/651698630/iPhone/sticker@2x.png",
      "https://stickershop.line-scdn.net/stickershop/v1/sticker/651698630/android/sticker_animation.png",
      "https://stickershop.line-scdn.net/stickershop/v1/sticker/651698630/ANDROID/sticker_animation.png",
      "https://stickershop.line-scdn.net/stickershop/v1/sticker/651698630/iPhone/sticker_animation@2x.png",
    ]);
  });
});
