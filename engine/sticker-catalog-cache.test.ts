import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StickerCatalogCache } from "./sticker-catalog-cache";

describe("StickerCatalogCache", () => {
  test("persists a private, expiring account sticker catalogue", () => {
    const path = join(mkdtempSync(join(tmpdir(), "liney-sticker-cache-")), "catalog.json");
    const cache = new StickerCatalogCache(path);
    cache.write([{ packageId: "11537", stickerId: "52002734", version: "1", owned: true }], 2_000);
    expect(cache.read(1_000)).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(cache.read(2_000)).toBeNull();
    expect(cache.clear()).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("removes a stale owned sticker without invalidating the rest of the catalogue", () => {
    const path = join(mkdtempSync(join(tmpdir(), "liney-sticker-cache-")), "catalog.json");
    const cache = new StickerCatalogCache(path);
    cache.write([
      { packageId: "1", stickerId: "11", version: "1", owned: true },
      { packageId: "2", stickerId: "22", version: "1", owned: true },
    ], Date.now() + 60_000);
    expect(cache.remove("1", "11")).toBe(true);
    expect(cache.read()).toEqual([{ packageId: "2", stickerId: "22", version: "1", owned: true }]);
  });
});
