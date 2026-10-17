import { describe, expect, test } from "bun:test";
import { richAssetAuthHeaders } from "./rich-asset";

describe("private LINE Rich image request", () => {
  test("uses LINE authorization for the expected official CDN only", () => {
    const headers = richAssetAuthHeaders("https://oaplus-media-manager.line-scdn.net/asset/id", "test-token", "test-device");
    expect(headers).toEqual(expect.objectContaining({ "x-line-access": "test-token", "x-line-application": "test-device" }));
  });
  test("does not leak LINE credentials to user-controlled domains or redirects", () => {
    for (const url of [
      "https://oaplus-media-manager.line-scdn.net.attacker.test/asset",
      "https://attacker.test/asset",
      "https://oaplus-media-manager.line-scdn.net@attacker.test/asset",
      "http://oaplus-media-manager.line-scdn.net/asset",
      "https://oaplus-media-manager.line-scdn.net:444/asset",
      "javascript:alert(1)",
    ]) {
      expect(richAssetAuthHeaders(url, "test-token", "test-device")).toBeUndefined();
    }
  });
  test("refuses authorization without a logged in LINE client", () => {
    expect(richAssetAuthHeaders("https://oaplus-media-manager.line-scdn.net/foo", "", "test-device")).toBeUndefined();
  });
});
