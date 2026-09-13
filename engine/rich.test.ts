import { describe, expect, test } from "bun:test";
import { parseRichMessage } from "./rich";

describe("parseRichMessage", () => {
  test("reads the composed image and clickable regions", () => {
    const result = parseRichMessage({
      contentMetadata: {
        DOWNLOAD_URL: "https://cdn.example.test/news.jpg",
        ALT_TEXT: "ข่าววันนี้",
        MARKUP_JSON: JSON.stringify({
          canvas: { width: 1040, height: 1248, initialScene: "scene1" },
          actions: { action0: { type: "web", params: { linkUri: "https://example.test/story" } } },
          scenes: { scene1: { listeners: [{ action: "action0", params: [0, 0, 1040, 1040] }] } },
        }),
      },
    });
    expect(result).toEqual({
      imageUrl: "https://cdn.example.test/news.jpg",
      altText: "ข่าววันนี้",
      width: 1040,
      height: 1248,
      actions: [{ x: 0, y: 0, width: 1040, height: 1040, link: "https://example.test/story" }],
    });
  });

  test("rejects unsafe rich URLs and out-of-bounds action regions", () => {
    expect(parseRichMessage({ contentMetadata: { DOWNLOAD_URL: "javascript:alert(1)" } })).toBeUndefined();
    expect(parseRichMessage({
      contentMetadata: {
        DOWNLOAD_URL: "https://cdn.example.test/news.jpg",
        MARKUP_JSON: JSON.stringify({
          canvas: { width: 100, height: 100 },
          actions: { action0: { params: { linkUri: "https://example.test/story" } } },
          scenes: { scene1: { listeners: [{ action: "action0", params: [80, 80, 30, 30] }] } },
        }),
      },
    })).toMatchObject({ imageUrl: "https://cdn.example.test/news.jpg", width: 100, height: 100 });
    expect(parseRichMessage({
      contentMetadata: {
        DOWNLOAD_URL: "https://cdn.example.test/news.jpg",
        MARKUP_JSON: JSON.stringify({
          canvas: { width: 100, height: 100 },
          actions: { action0: { params: { linkUri: "https://example.test/story" } } },
          scenes: { scene1: { listeners: [{ action: "action0", params: [80, 80, 30, 30] }] } },
        }),
      },
    })?.actions).toBeUndefined();
  });

  test("accepts a wrapped message with JSON metadata", () => {
    const result = parseRichMessage({
      raw: {
        contentMetadata: JSON.stringify({
          DOWNLOAD_URL: "https://cdn.example.test/news.jpg",
          ALT_TEXT: "ข่าววันนี้",
        }),
      },
    });

    expect(result).toEqual({
      imageUrl: "https://cdn.example.test/news.jpg",
      altText: "ข่าววันนี้",
    });
  });
});
