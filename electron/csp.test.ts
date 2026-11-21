import { describe, expect, test } from "bun:test";
import { CONTENT_SECURITY_POLICY } from "./csp.mjs";

function directives() {
  return new Map(
    CONTENT_SECURITY_POLICY.split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [name, ...sources] = entry.split(/\s+/);
        return [name, sources];
      }),
  );
}

describe("renderer content security policy", () => {
  test("locks down script execution and embedding", () => {
    const map = directives();

    expect(map.get("default-src")).toEqual(["'self'"]);
    expect(map.get("script-src")).toEqual(["'self'"]);
    expect(map.get("object-src")).toEqual(["'none'"]);
    expect(map.get("frame-src")).toEqual(["'none'"]);
    expect(map.get("frame-ancestors")).toEqual(["'none'"]);
    expect(map.get("base-uri")).toEqual(["'self'"]);
    expect(map.get("form-action")).toEqual(["'none'"]);
  });

  test("allows the media sources the LINE UI actually renders", () => {
    const map = directives();

    expect(map.get("img-src")).toContain("https:");
    expect(map.get("img-src")).toContain("blob:");
    expect(map.get("img-src")).toContain("data:");
    expect(map.get("media-src")).toContain("https:");
    expect(map.get("style-src")).toContain("'unsafe-inline'");
  });

  test("never enables eval or inline scripts", () => {
    const scripts = directives().get("script-src") ?? [];

    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });
});
