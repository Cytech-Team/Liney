import { describe, expect, test } from "bun:test";
import { flexAltText, parseFlexMessage } from "./flex";

describe("parseFlexMessage", () => {
  test("reads a human preview from ALT_TEXT without depending on FLEX_JSON", () => {
    expect(flexAltText({ contentMetadata: { ALT_TEXT: "  เพลงใหม่\nมาแล้ว  ", FLEX_JSON: "not parsed" } })).toBe("เพลงใหม่ มาแล้ว");
    expect(flexAltText({ raw: { contentMetadata: JSON.stringify({ ALT_TEXT: "โปรโมชันวันนี้" }) } })).toBe("โปรโมชันวันนี้");
    expect(flexAltText({ flex: { altText: "สินค้าแนะนำ" } })).toBe("สินค้าแนะนำ");
    expect(flexAltText({ contentMetadata: {} })).toBeUndefined();
  });

  test("parses a JSON encoded bubble and metadata", () => {
    expect(parseFlexMessage({
      contentType: "FLEX",
      contentMetadata: {
        FLEX_VER: "u2",
        ALT_TEXT: "โปรโมชั่น",
        FLEX_JSON: JSON.stringify({ type: "bubble", body: { type: "box", layout: "vertical", contents: [] } }),
      },
    })).toMatchObject({
      version: "u2",
      altText: "โปรโมชั่น",
      contents: { type: "bubble" },
    });
  });

  test("supports a double-encoded carousel and rejects malformed roots", () => {
    const encoded = JSON.stringify(JSON.stringify({ type: "carousel", contents: [] }));
    expect(parseFlexMessage({ contentMetadata: { FLEX_JSON: encoded } })?.contents.type).toBe("carousel");
    expect(parseFlexMessage({ contentMetadata: { FLEX_JSON: JSON.stringify({ type: "box" }) } })).toBeUndefined();
    expect(parseFlexMessage({ contentMetadata: { FLEX_JSON: "not-json" } })).toBeUndefined();
  });

  test("accepts JSON metadata wrappers without inventing undefined labels", () => {
    const result = parseFlexMessage({
      raw: {
        contentMetadata: JSON.stringify({
          flexJson: JSON.stringify({ type: "bubble", body: { type: "box", layout: "vertical", contents: [] } }),
        }),
      },
    });

    expect(result).toEqual({
      contents: { type: "bubble", body: { type: "box", layout: "vertical", contents: [] } },
    });
  });
});
