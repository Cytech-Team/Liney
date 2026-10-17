import { describe, expect, test } from "bun:test";
import { notificationAvatarUrl, prepareNotificationAvatar } from "../src/lib/notification-avatar";

describe("notification avatar selection", () => {
  test("accepts LINE HTTPS avatar URLs", () => {
    expect(notificationAvatarUrl("https://obs.line-scdn.net/r/talk/p/u123?x=2"))
      .toBe("https://obs.line-scdn.net/r/talk/p/u123?x=2");
  });
  test("rejects unsafe and malformed avatar links", () => {
    for (const input of [
      "file:///tmp/evil.png", "http://localhost/avatar", "https://name:password@line-scdn.net/image",
      "data:image/png;base64,abcdef", "javascript:alert(1)", "bad-url",
    ]) expect(notificationAvatarUrl(input)).toBeUndefined();
  });
  test("does not attempt native cache in a web-only window", async () => {
    expect(await prepareNotificationAvatar("https://obs.line-scdn.net/r/talk/p/u123")).toBeUndefined();
  });
});
