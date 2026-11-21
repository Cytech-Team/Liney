import { describe, expect, test } from "bun:test";
import { normalizeExternalUrl } from "./external-links.mjs";

describe("external link allowlist", () => {
  test("allows the protocols the chat UI renders", () => {
    expect(normalizeExternalUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeExternalUrl("http://example.com/")).toBe("http://example.com/");
    expect(normalizeExternalUrl("mailto:support@example.com")).toBe("mailto:support@example.com");
    expect(normalizeExternalUrl("tel:+66123456789")).toBe("tel:+66123456789");
    expect(normalizeExternalUrl("line://nv/chatMsg?messageId=1")).toBe("line://nv/chatMsg?messageId=1");
  });

  test("rejects scripts, files and credentials", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "smb://server/share",
      "https://user:pass@example.com/",
    ]) {
      expect(() => normalizeExternalUrl(url)).toThrow();
    }
  });

  test("rejects malformed input", () => {
    expect(() => normalizeExternalUrl("")).toThrow();
    expect(() => normalizeExternalUrl("not a url")).toThrow();
  });
});
