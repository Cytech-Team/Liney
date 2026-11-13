import { describe, expect, test } from "bun:test";
import { resolveUpdaterConfig } from "./updater-config.mjs";

describe("resolveUpdaterConfig", () => {
  test("disables updates in development builds", () => {
    const result = resolveUpdaterConfig({
      isPackaged: false,
      appImagePath: undefined,
      feedUrlEnv: "",
      updateChannelEnv: "",
    });
    expect(result.configured).toBe(false);
    expect(result.reason).toMatch(/development/i);
  });

  test("requires AppImage for packaged system packages", () => {
    const result = resolveUpdaterConfig({
      isPackaged: true,
      appImagePath: undefined,
      feedUrlEnv: "https://updates.example.com",
      updateChannelEnv: "preview",
    });
    expect(result.configured).toBe(false);
    expect(result.reason).toMatch(/AppImage/i);
  });

  test("uses baked-in GitHub feed for packaged AppImage without custom env", () => {
    const result = resolveUpdaterConfig({
      isPackaged: true,
      appImagePath: "/tmp/Liney.AppImage",
      feedUrlEnv: "",
      updateChannelEnv: "",
    });
    expect(result.configured).toBe(true);
    expect(result.provider).toBe("github");
    expect(result.owner).toBe("Cytech-Team");
    expect(result.repo).toBe("Liney");
    expect(result.displayChannel).toBe("preview");
    expect(result.allowPrerelease).toBe(true);
    // Must use default latest-linux.yml so GitHub prerelease filtering works.
    // Setting channel to "preview"/"stable" would look for preview-linux.yml
    // which electron-builder never generates.
    expect(result.autoUpdaterChannel).toBeNull();
  });

  test("stable channel disables prerelease", () => {
    const result = resolveUpdaterConfig({
      isPackaged: true,
      appImagePath: "/tmp/Liney.AppImage",
      feedUrlEnv: "",
      updateChannelEnv: "stable",
    });
    expect(result.configured).toBe(true);
    expect(result.displayChannel).toBe("stable");
    expect(result.allowPrerelease).toBe(false);
    expect(result.autoUpdaterChannel).toBeNull();
  });

  test("custom generic feed keeps channel in URL and default yml name", () => {
    const result = resolveUpdaterConfig({
      isPackaged: true,
      appImagePath: "/tmp/Liney.AppImage",
      feedUrlEnv: "https://updates.example.com///",
      updateChannelEnv: "preview",
    });
    expect(result.configured).toBe(true);
    expect(result.provider).toBe("generic");
    expect(result.url).toBe("https://updates.example.com/preview/");
    expect(result.autoUpdaterChannel).toBeNull();
  });
});
