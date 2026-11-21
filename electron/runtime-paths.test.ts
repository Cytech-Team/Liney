import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { channelFromManifest, resolveRuntimePaths } from "./runtime-paths.mjs";

describe("channelFromManifest", () => {
  test("accepts only an explicit stable marker", () => {
    expect(channelFromManifest({ lineyChannel: "stable" })).toBe("stable");
  });

  test("falls back to preview for missing, unknown or broken manifests", () => {
    expect(channelFromManifest({})).toBe("preview");
    expect(channelFromManifest({ lineyChannel: "stable-ish" })).toBe("preview");
    expect(channelFromManifest(null)).toBe("preview");
    expect(channelFromManifest(undefined)).toBe("preview");
  });
});

describe("resolveRuntimePaths", () => {
  test("uses an isolated dev data dir for unpackaged builds", () => {
    const paths = resolveRuntimePaths({
      isPackaged: false,
      env: {},
      home: "/home/liney",
      xdgDataHome: undefined,
    });

    expect(paths.channel).toBe("dev");
    expect(paths.stateDir).toBe("/home/liney/.local/share/liney-electron-dev");
    expect(paths.credentialNamespace).toBe("dev");
    expect(paths.userDataDir).toBe(paths.stateDir);
  });

  test("keeps the preview data dir and legacy credential namespace", () => {
    const paths = resolveRuntimePaths({
      isPackaged: true,
      env: {},
      home: "/home/liney",
      xdgDataHome: undefined,
    });

    expect(paths.channel).toBe("preview");
    expect(paths.stateDir).toBe("/home/liney/.local/share/liney-electron-preview");
    expect(paths.credentialNamespace).toBe("");
    expect(paths.userDataDir).toBe(paths.stateDir);
  });

  test("uses the stable data dir and namespaced credentials", () => {
    const paths = resolveRuntimePaths({
      isPackaged: true,
      env: { LINEY_ELECTRON_STABLE: "1" },
      home: "/home/liney",
      xdgDataHome: "/data",
    });

    expect(paths.channel).toBe("stable");
    expect(paths.stateDir).toBe(join("/data", "liney"));
    expect(paths.credentialNamespace).toBe("stable");
    expect(paths.userDataDir).toBeNull();
  });

  test("reads the stable channel from packaged build metadata", () => {
    const paths = resolveRuntimePaths({
      isPackaged: true,
      buildChannel: "stable",
      env: {},
      home: "/home/liney",
      xdgDataHome: undefined,
    });

    expect(paths.channel).toBe("stable");
    expect(paths.stateDir).toBe("/home/liney/.local/share/liney");
    expect(paths.credentialNamespace).toBe("stable");
  });

  test("never trusts build metadata in an unpackaged build", () => {
    const paths = resolveRuntimePaths({
      isPackaged: false,
      buildChannel: "stable",
      env: {},
      home: "/home/liney",
      xdgDataHome: undefined,
    });

    expect(paths.channel).toBe("dev");
    expect(paths.credentialNamespace).toBe("dev");
  });

  test("ignores the stable flag in unpackaged builds", () => {
    const paths = resolveRuntimePaths({
      isPackaged: false,
      env: { LINEY_ELECTRON_STABLE: "1" },
      home: "/home/liney",
      xdgDataHome: undefined,
    });

    expect(paths.channel).toBe("dev");
    expect(paths.credentialNamespace).toBe("dev");
  });

  test("honors an explicit data dir and isolates its keyring namespace", () => {
    const first = resolveRuntimePaths({
      isPackaged: true,
      env: { LINEY_DATA_DIR: "/tmp/liney-test" },
      home: "/home/liney",
      xdgDataHome: undefined,
    });
    const second = resolveRuntimePaths({
      isPackaged: true,
      env: { LINEY_DATA_DIR: "/tmp/liney-test" },
      home: "/home/liney",
      xdgDataHome: undefined,
    });
    const other = resolveRuntimePaths({
      isPackaged: true,
      env: { LINEY_DATA_DIR: "/tmp/liney-other" },
      home: "/home/liney",
      xdgDataHome: undefined,
    });

    expect(first.stateDir).toBe("/tmp/liney-test");
    expect(first.userDataDir).toBe("/tmp/liney-test");
    expect(first.credentialNamespace).toMatch(/^custom-[0-9a-f]{12}$/);
    expect(first.credentialNamespace).toBe(second.credentialNamespace);
    expect(first.credentialNamespace).not.toBe(other.credentialNamespace);
  });
});
