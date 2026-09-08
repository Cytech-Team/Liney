import { Buffer } from "node:buffer";

function startsWith(bytes: Uint8Array, values: number[]): boolean {
  return values.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Buffer.from(bytes.subarray(start, start + length)).toString("ascii");
}

/** Identify common image formats and reject an HTML/JSON error body as media. */
export function detectImageMime(bytes: Uint8Array, declaredMime = ""): string | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 2) === "BM") return "image/bmp";
  if (ascii(bytes, 4, 4) === "ftyp" && /^(avif|avis|heic|heix|hevc|mif1)$/i.test(ascii(bytes, 8, 4))) {
    return /^hei/i.test(ascii(bytes, 8, 4)) ? "image/heic" : "image/avif";
  }

  const mime = String(declaredMime || "").split(";", 1)[0].trim().toLowerCase();
  if (!mime.startsWith("image/")) return undefined;
  const prefix = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart().toLowerCase();
  if (prefix.startsWith("<!doctype") || prefix.startsWith("<html") || prefix.startsWith("{") || prefix.startsWith("[")) {
    return undefined;
  }
  return mime;
}

export async function normalizeImageBlob(blob: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.byteLength) throw new Error("empty media response");
  const mime = detectImageMime(bytes, blob.type);
  if (!mime) throw new Error("LINE returned a non-image media response");
  return new Blob([bytes], { type: mime });
}

