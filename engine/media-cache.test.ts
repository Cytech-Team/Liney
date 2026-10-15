import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineyMediaCache } from "./media-cache";

describe("media disk cache", () => {
  test("stores private preview bytes and restores the MIME type", async () => {
    const root = mkdtempSync(join(tmpdir(), "liney-media-cache-test-"));
    const cache = new LineyMediaCache(join(root, "media"));
    const saved = await cache.put("talk:message-1", new Blob([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], { type: "image/png" }));
    expect(saved?.size).toBe(4);
    expect(saved?.path).toContain(".preview");
    expect(statSync(saved!.path).mode & 0o777).toBe(0o600);

    const restored = await cache.get("talk:message-1", "image/png");
    expect(restored?.mime).toBe("image/png");
    expect(restored?.size).toBe(4);
    expect(restored?.dataUrl).toStartWith("data:image/png;base64,");

    await cache.clear();
    expect(await cache.get("talk:message-1", "image/png")).toBeNull();
  });

  test("evicts least-recently-used previews when the entry cap is exceeded", async () => {
    const root = mkdtempSync(join(tmpdir(), "liney-media-cache-cap-test-"));
    const cache = new LineyMediaCache(join(root, "media"), 25 * 1024 * 1024, 2);
    await cache.put("talk:one", new Blob([Uint8Array.of(1)], { type: "image/png" }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await cache.put("talk:two", new Blob([Uint8Array.of(2)], { type: "image/png" }));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await cache.put("talk:three", new Blob([Uint8Array.of(3)], { type: "image/png" }));

    expect(await cache.get("talk:one", "image/png")).toBeNull();
    expect(await cache.get("talk:two", "image/png")).not.toBeNull();
    expect(await cache.get("talk:three", "image/png")).not.toBeNull();
  });
});

