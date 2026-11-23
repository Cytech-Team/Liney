import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichMessage } from "../src/components/RichMessage";

describe("RichMessage missing artwork", () => {
  test("plays a Rich video with its cover poster and OA button", () => {
    const markup = renderToStaticMarkup(createElement(RichMessage, {
      data: {
        imageUrl: "https://cdn.example.test/cover.jpg",
        altText: "โปรโมชัน",
        videoUrl: "https://cdn.example.test/promo.mp4",
        videoPosterUrl: "https://cdn.example.test/poster.jpg",
        videoButton: { label: "ติดต่อสอบถาม", link: "https://line.me/R/ti/p/@test" },
      },
    }));
    expect(markup).toContain("<video");
    expect(markup).toContain("https://cdn.example.test/promo.mp4");
    expect(markup).toContain("poster=\"https://cdn.example.test/poster.jpg\"");
    expect(markup).toContain("controls");
    expect(markup).toContain("ติดต่อสอบถาม");
  });

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
