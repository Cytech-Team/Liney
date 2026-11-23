import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleLineyMediaRequest,
  isVideoToken,
  parseByteRange,
  videoFilePath,
} from "./media-protocol.mjs";

const TOKEN = "a".repeat(64);
const roots: string[] = [];

function folder(): string {
  const value = mkdtempSync(join(tmpdir(), "liney-media-protocol-"));
  roots.push(value);
  return value;
}

function fakeRequest(url: string, headers: Record<string, string> = {}, method = "GET") {
  return { url, method, headers: new Headers(headers) };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("liney-media video protocol", () => {
  test("accepts only opaque sha256 tokens", () => {
    expect(isVideoToken(TOKEN)).toBe(true);
    expect(isVideoToken("../../etc/passwd")).toBe(false);
    expect(isVideoToken("a".repeat(63))).toBe(false);
  });

  test("resolves a token inside the cache folder only", () => {
    const root = folder();
    expect(videoFilePath(root, TOKEN)).toBe(join(root, `${TOKEN}.mp4`));
    expect(videoFilePath(root, "../escape")).toBeNull();
  });

  test("parses closed, open and suffix byte ranges", () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=0-200", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=100-", 100)).toBe("invalid");
    expect(parseByteRange("bytes=9-1", 100)).toBe("invalid");
    expect(parseByteRange("items=0-1", 100)).toBe("invalid");
  });

  test("streams a cache file with an exact partial response", async () => {
    const root = folder();
    writeFileSync(join(root, `${TOKEN}.mp4`), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));

    const response = await handleLineyMediaRequest({
      request: fakeRequest(`liney-media://video/${TOKEN}`, { range: "bytes=2-5" }),
      folder: root,
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(response.headers.get("content-length")).toBe("4");
    const body = new Uint8Array(await new Response(response.body).arrayBuffer());
    expect(Array.from(body)).toEqual([2, 3, 4, 5]);
  });

  test("streams the whole file and answers HEAD without a body", async () => {
    const root = folder();
    writeFileSync(join(root, `${TOKEN}.mp4`), new Uint8Array([0, 1, 2, 3, 4]));

    const full = await handleLineyMediaRequest({
      request: fakeRequest(`liney-media://video/${TOKEN}`),
      folder: root,
    });
    expect(full.status).toBe(200);
    expect(full.headers.get("content-length")).toBe("5");
    expect(full.headers.get("content-range")).toBeNull();
    expect(Array.from(new Uint8Array(await new Response(full.body).arrayBuffer()))).toEqual([0, 1, 2, 3, 4]);

    const head = await handleLineyMediaRequest({
      request: fakeRequest(`liney-media://video/${TOKEN}`, {}, "HEAD"),
      folder: root,
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("5");
    expect(head.body).toBeNull();
  });

  test("returns 404 for a missing file and 403 for a forged token", async () => {
    const root = folder();
    const missing = await handleLineyMediaRequest({
      request: fakeRequest(`liney-media://video/${TOKEN}`),
      folder: root,
    });
    expect(missing.status).toBe(404);

    const forged = await handleLineyMediaRequest({
      request: fakeRequest("liney-media://video/%2e%2e%2fsecret"),
      folder: root,
    });
    expect(forged.status).toBe(403);
  });

  test("returns 416 for an unsatisfiable range", async () => {
    const root = folder();
    writeFileSync(join(root, `${TOKEN}.mp4`), new Uint8Array([1, 2, 3]));
    const response = await handleLineyMediaRequest({
      request: fakeRequest(`liney-media://video/${TOKEN}`, { range: "bytes=8-" }),
      folder: root,
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */3");
  });
});
