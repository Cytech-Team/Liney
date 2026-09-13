import { describe, expect, test } from "bun:test";
import {
  isPlaceholderSenderName,
  liveMessagePreview,
  notificationSenderName,
  officialLineMessageUrl,
} from "../src/lib/message-presentation";

describe("message presentation helpers", () => {
  test("normalizes message previews without exposing protocol placeholders", () => {
    expect(liveMessagePreview({ text: "  hello\nworld  " })).toBe("hello world");
    expect(liveMessagePreview({ text: "IMAGE", contentType: 1 })).toBe("รูปภาพ");
    expect(liveMessagePreview({ text: "ignored", contentType: 7 })).toBe("ignored");
    expect(liveMessagePreview({ contentType: 17, rich: { altText: "  rich\ncard " } })).toBe("rich card");
    expect(liveMessagePreview({ contentType: 22 })).toBe("Flex message");
    expect(liveMessagePreview({
      contentType: 6,
      text: "Call History : 11000 millisecs, Result: 16",
      call: { durationMs: 11_000, status: "completed" },
    })).toBe("โทรสำเร็จ · 11 วินาที");
    expect(liveMessagePreview({ contentType: 6, text: "Call History : 11000 millisecs, Result: 16" })).toBe("การโทร");
    expect(liveMessagePreview({})).toBe("ข้อความใหม่");
  });

  test("recognizes only known placeholder sender labels", () => {
    expect(isPlaceholderSenderName(" LINE USER ")).toBe(true);
    expect(isPlaceholderSenderName("LINE Official Account")).toBe(true);
    expect(isPlaceholderSenderName("unknown")).toBe(true);
    expect(isPlaceholderSenderName("LINE User 2")).toBe(false);
    expect(isPlaceholderSenderName("ร้านกาแฟ")).toBe(false);
  });

  test("uses the sender, then chat, then a safe generic notification title", () => {
    expect(notificationSenderName({ senderName: "  ร้านกาแฟ  " }, { name: "ห้องแชต" })).toBe("ร้านกาแฟ");
    expect(notificationSenderName({ senderName: "LINE User" }, { name: "ห้องแชต" })).toBe("ห้องแชต");
    expect(notificationSenderName({ senderName: "unknown" }, { name: "LINE Official Account" })).toBe("LINE");
  });

  test("builds an encoded official-client deep link", () => {
    const url = officialLineMessageUrl("u/chat?1", "message&2");
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("line:");
    expect(parsed.hostname).toBe("nv");
    expect(parsed.pathname).toBe("/chatMsg");
    expect(parsed.searchParams.get("chatId")).toBe("u/chat?1");
    expect(parsed.searchParams.get("messageId")).toBe("message&2");
  });
});
