import { describe, expect, test } from "bun:test";
import { compareStableVersions, latestStableLinejs, parseStableVersion } from "./linejs-upstream-version";

describe("JSR LINEJS upstream version selection", () => {
  const metadata = (versions: Record<string, { yanked?: boolean }>) => ({
    scope: "evex", name: "linejs", githubRepository: { owner: "evex-dev", name: "linejs" }, versions,
  });
  test("tracks highest published stable version even when GitHub release trails JSR", () => {
    expect(latestStableLinejs(metadata({ "3.4.2": {}, "3.5.0": {}, "3.6.0-rc.1": {} }))).toBe("3.5.0");
  });
  test("ignores yanked stable releases", () => {
    expect(latestStableLinejs(metadata({ "3.4.2": {}, "3.5.0": { yanked: true } }))).toBe("3.4.2");
  });
  test("sorts semver numerically not alphabetically", () => {
    expect(compareStableVersions("3.10.0", "3.9.10")).toBeGreaterThan(0);
    expect(latestStableLinejs(metadata({ "3.9.10": {}, "3.10.0": {} }))).toBe("3.10.0");
  });
  test("rejects prereleases and invalid versions", () => {
    expect(parseStableVersion("4.0.0-beta.1")).toBeNull();
    expect(parseStableVersion("03.0.0")).toBeNull();
  });
  test("refuses untrusted or empty metadata", () => {
    expect(() => latestStableLinejs(metadata({ "3.5.0-rc.1": {} }))).toThrow("no published");
    expect(() => latestStableLinejs({ ...metadata({ "3.5.0": {} }), scope: "other" })).toThrow("Unexpected");
    expect(() => latestStableLinejs({ ...metadata({ "3.5.0": {} }), githubRepository: { owner: "unknown", name: "linejs" } })).toThrow("unexpected GitHub");
  });
});
