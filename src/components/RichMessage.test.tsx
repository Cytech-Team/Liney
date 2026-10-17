import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichMessage } from "./RichMessage";

describe("RichMessage missing artwork", () => {
  test("offers a compact fallback, image retry and the official LINE client", () => {
    const markup = renderToStaticMarkup(createElement(RichMessage, {
      data: { imageUrl: "invalid-url", altText: "ข่าวประชาสัมพันธ์", width: 1040, height: 1040 },
      messageId: "42",
      chatId: "u-test",
      onOpenOriginal: () => undefined,
    }));
    expect(markup).toContain("ไม่สามารถโหลดภาพจาก LINE ได้");
    expect(markup).toContain("ข่าวประชาสัมพันธ์");
    expect(markup).toContain("ลองใหม่");
    expect(markup).toContain("เปิดใน LINE ทางการ");
    expect(markup).not.toContain("aspect-ratio");
  });
});
