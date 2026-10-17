import { describe, expect, test } from "bun:test";
import { presentOwnProfile } from "./profile-display";

const mid = "u0123456789abcdef0123456789abcdef";

describe("LINE own-account avatar presentation", () => {
  test("derives an OBS picture URL from mid and pictureStatus", () => {
    const displayed = presentOwnProfile({ mid, displayName: "LINE Test", pictureStatus: "test-123" });
    expect(displayed.pictureUrl).toBe(`https://obs.line-scdn.net/r/talk/p/${mid}?v=test-123`);
    expect(displayed.avatarUrl).toBe(displayed.pictureUrl);
    expect(displayed.displayName).toBe("LINE Test");
  });

  test("prefers a ready HTTPS picture URL returned from the server", () => {
    const displayed = presentOwnProfile({ mid, pictureUrl: "https://profile.line-scdn.net/p/123", pictureStatus: "abc" });
    expect(displayed.pictureUrl).toBe("https://profile.line-scdn.net/p/123");
  });

  test("supports LINE picturePath without a URL", () => {
    const displayed = presentOwnProfile({ mid: "invalid", picturePath: "/image/hash", pictureStatus: "2" });
    expect(displayed.pictureUrl).toBe("https://profile.line-scdn.net/image/hash");
  });

  test("rejects non-HTTPS picture urls and avoids constructing URLs from invalid mids", () => {
    const displayed = presentOwnProfile({ mid: "malformed", pictureUrl: "javascript:alert(1)", picturePath: "http://insecure/" });
    expect(displayed.pictureUrl).toBe("javascript:alert(1)");
    expect(displayed.avatarUrl).toBeUndefined();
  });

  test("forces a new image cache key after a successful avatar upload", () => {
    const a = presentOwnProfile({ mid, pictureStatus: "123" });
    const b = presentOwnProfile({ mid, pictureStatus: "123" }, 1720000000000);
    expect(b.pictureUrl).not.toBe(a.pictureUrl);
    expect(b.pictureUrl).toContain("v=1720000000000");
  });
});
