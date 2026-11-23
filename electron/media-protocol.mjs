import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const VIDEO_TOKEN = /^[a-f0-9]{64}$/;

export function isVideoToken(value) {
  return VIDEO_TOKEN.test(String(value ?? ""));
}

/**
 * Parse a single-range HTTP header. Returns null for no header, "invalid" for
 * a malformed or unsatisfiable range, and inclusive byte offsets otherwise.
 */
export function parseByteRange(header, size) {
  if (header === null || header === undefined) return null;
  const value = String(header).trim();
  if (!value) return null;
  if (!Number.isFinite(size) || size <= 0) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return "invalid";
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";

  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  let start = Number(rawStart);
  let end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "invalid";
  end = Math.min(end, size - 1);
  return { start, end };
}

export function videoFilePath(folder, token) {
  if (!isVideoToken(token)) return null;
  const resolvedFolder = path.resolve(folder);
  const file = path.resolve(resolvedFolder, `${token}.mp4`);
  if (!file.startsWith(resolvedFolder + path.sep)) return null;
  return file;
}

/**
 * Serves `<stateDir>/video-cache/<token>.mp4` to the sandboxed renderer.
 * The token is an opaque SHA-256 hash; no chat id or local path crosses IPC.
 */
export async function handleLineyMediaRequest({ request, folder }) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("Invalid URL", { status: 400 });
  }
  if (url.hostname !== "video") return new Response("Not found", { status: 404 });

  const token = url.pathname.replace(/^\/+/, "");
  const file = videoFilePath(folder, token);
  if (!file) return new Response("Forbidden", { status: 403 });

  let info;
  try {
    info = await stat(file);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!info.isFile() || info.size <= 0) return new Response("Not found", { status: 404 });

  const size = info.size;
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });

  const range = parseByteRange(request.headers.get("range"), size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    });
  }

  if (String(request.method ?? "GET").toUpperCase() === "HEAD") {
    headers.set("Content-Length", String(size));
    return new Response(null, { status: 200, headers });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  headers.set("Content-Length", String(end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const stream = Readable.toWeb(createReadStream(file, { start, end }));
  return new Response(stream, { status: range ? 206 : 200, headers });
}
