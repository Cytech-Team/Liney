import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VideoMessage } from "../src/components/VideoMessage";
import type { Message } from "../src/data/mock";

const message: Message = {
  id: "video-1",
  author: "them",
  time: "12:00",
  contentType: 2,
  durationMs: 65_000,
  filename: "clip.mp4",
};

describe("VideoMessage", () => {
  test("renders an idle card with duration and play label", () => {
    const markup = renderToStaticMarkup(createElement(VideoMessage, {
      message,
      onPlay: () => undefined,
    }));
    expect(markup).toContain("video-message-card");
    expect(markup).toContain("1:05");
    expect(markup).toContain("วิดีโอ");
    expect(markup).toContain("clip.mp4");
    expect(markup).not.toContain("<video");
  });

  test("renders the native player when the local cache is ready", () => {
    const markup = renderToStaticMarkup(createElement(VideoMessage, {
      message,
      state: { status: "ready", url: "liney-media://video/abc" },
      onPlay: () => undefined,
    }));
    expect(markup).toContain("<video");
    expect(markup).toContain("liney-media://video/abc");
    expect(markup).toContain("autoPlay");
    expect(markup).toContain("controls");
  });

  test("shows a retry instead of a blank card when loading fails", () => {
    const markup = renderToStaticMarkup(createElement(VideoMessage, {
      message,
      state: { status: "error", error: "LINE ไม่ส่งไฟล์วิดีโอกลับมา" },
      onPlay: () => undefined,
    }));
    expect(markup).toContain("LINE ไม่ส่งไฟล์วิดีโอกลับมา");
    expect(markup).toContain("ลองโหลดวิดีโออีกครั้ง");
  });
});
