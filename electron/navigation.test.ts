import { describe, expect, test } from "bun:test";
import { isPermittedNavigation } from "./navigation.mjs";

describe("renderer navigation guard", () => {
  test("allows the app origin and its pages", () => {
    expect(isPermittedNavigation("lineyapp://app/index.html", undefined)).toBe(true);
    expect(isPermittedNavigation("lineyapp://app/index.html?x=1", undefined)).toBe(true);
  });

  test("rejects a host that only shares the URL prefix", () => {
    expect(isPermittedNavigation("lineyapp://app.evil.example/index.html", undefined)).toBe(false);
    expect(isPermittedNavigation("lineyapp://apple/index.html", undefined)).toBe(false);
  });

  test("rejects other schemes and malformed URLs", () => {
    expect(isPermittedNavigation("https://example.com/", undefined)).toBe(false);
    expect(isPermittedNavigation("file:///etc/passwd", undefined)).toBe(false);
    expect(isPermittedNavigation("not a url", undefined)).toBe(false);
  });

  test("allows the configured development origin only", () => {
    const dev = "http://localhost:5173";
    expect(isPermittedNavigation("http://localhost:5173/index.html", dev)).toBe(true);
    expect(isPermittedNavigation("http://localhost:5174/index.html", dev)).toBe(false);
    expect(isPermittedNavigation("http://localhost:5173.evil.example/", dev)).toBe(false);
  });
});
