import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isVideoCacheToken,
  LineyVideoCache,
  MAX_VIDEO_ENTRY_BYTES,
  videoCacheToken,
} from "./video-cache";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "liney-video-cache-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("LineyVideoCache", () => {
  test("stores and streams a hashed video file with private permissions", async () => {
    const folder = join(root(), "video-cache");
    const cache = new LineyVideoCache(folder);
    const key = "account:talk:message-1";
    const token = videoCacheToken(key);

    expect(isVideoCacheToken(token)).toBe(true);
    expect(await cache.get(key)).toBeNull();

    const saved = await cache.put(key, new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/mp4" }));

    expect(saved.size).toBe(4);
    expect(saved.path).toBe(cache.pathForToken(token));
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(await cache.get(key)).toMatchObject({ path: saved.path, size: 4 });
    expect(readdirSync(folder)).toEqual([`${token}.mp4`]);
  });

  test("rejects path-like tokens and empty blobs", async () => {
    const cache = new LineyVideoCache(root());
    expect(() => cache.pathForToken("../../etc/passwd")).toThrow("invalid video cache token");
    await expect(cache.put("empty", new Blob([]))).rejects.toThrow("video is empty");
  });

  test("rejects a video past the cache entry limit before reading it", async () => {
    const cache = new LineyVideoCache(root());
    const oversized = { size: MAX_VIDEO_ENTRY_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) } as Blob;
    await expect(cache.put("huge", oversized)).rejects.toThrow("video is too large to cache");
  });

  test("trims the oldest entry when the cache exceeds its byte budget", async () => {
    const cache = new LineyVideoCache(root(), 4, 10);
    await cache.put("old", new Blob([new Uint8Array([1, 2, 3, 4])]));
    await cache.put("new", new Blob([new Uint8Array([5, 6, 7, 8])]));

    expect(await cache.get("old")).toBeNull();
    expect(await cache.get("new")).not.toBeNull();
  });

  test("removes one cached video and clears the cache", async () => {
    const cache = new LineyVideoCache(root());
    const first = await cache.put("first", new Blob([new Uint8Array([1])]));
    const second = await cache.put("second", new Blob([new Uint8Array([2])]));
    expect(statSync(first.path).isFile()).toBe(true);
    expect(statSync(second.path).isFile()).toBe(true);

    await cache.remove("first");
    expect(await cache.get("first")).toBeNull();
    expect(await cache.get("second")).not.toBeNull();

    await cache.clear();
    expect(await cache.get("second")).toBeNull();
  });
});
