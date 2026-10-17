/**
 * LINEJS Moa Album API facade, deliberately read-only.
 * No album network calls occur until the user opens the album browser.
 * Server channel credentials and unfiltered protocol responses stay inside LINEJS.
 */
import { Buffer } from "node:buffer";
import type { Client } from "@evex/linejs";

export type LineAlbum = {
  albumId: string;
  chatId: string;
  title: string;
  photoCount: number;
  createTime?: number;
  updateTime?: number;
};

export type LineAlbumPhoto = {
  id: string;
  oid: string;
  resourceType: string;
  sid: string;
  width?: number;
  height?: number;
};

export type LineAlbumPage = { albums: LineAlbum[]; nextCursor?: string; hasMore: boolean };
export type LineAlbumPhotoPage = { photos: LineAlbumPhoto[]; nextCursor?: string };

type MoaApi = {
  getAlbums: (options: { cursor?: string }) => Promise<unknown>;
  getPhotos: (options: { chatId: string; albumId: string; cursor?: string; pageSize: number }) => Promise<unknown>;
  downloadPhoto: (options: { chatId: string; albumId: string; oid: string; prefix: "album/a" }) => Promise<Uint8Array>;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function id(value: unknown, label: string, max = 192): string {
  const valueString = String(value ?? "").trim();
  const hasControlCharacters = [...valueString].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (!valueString || valueString.length > max || hasControlCharacters) {
    throw new Error(`invalid ${label}`);
  }
  return valueString;
}

function optionalCursor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return id(value, "album cursor", 4096);
}

function safeNumber(value: unknown): number | undefined {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number) && number >= 0 ? number : undefined;
}

function moa(client: Client): MoaApi {
  const service = record(record(client).base).moa as Partial<MoaApi> | undefined;
  if (!service || typeof service.getAlbums !== "function" ||
    typeof service.getPhotos !== "function" ||
    typeof service.downloadPhoto !== "function") {
    throw new Error("LINEJS Album/Moa service is unavailable");
  }
  return service as MoaApi;
}

export async function listLineAlbums(client: Client, cursor?: string): Promise<LineAlbumPage> {
  const response = record(await moa(client).getAlbums({ cursor: optionalCursor(cursor) }));
  const result = record(response.result);
  const raw = Array.isArray(result.albums) ? result.albums : [];
  const albums: LineAlbum[] = raw.slice(0, 100).flatMap((value) => {
    const entry = record(value);
    const albumId = String(entry.albumId ?? "").trim();
    const chatId = String(entry.chatId ?? "").trim();
    if (!albumId || !chatId) return [];
    return [{
      albumId, chatId,
      title: String(entry.title ?? "อัลบั้ม").slice(0, 200),
      photoCount: safeNumber(entry.photoCount) ?? 0,
      ...(safeNumber(entry.createTime) !== undefined ? { createTime: safeNumber(entry.createTime) } : {}),
      ...(safeNumber(entry.updateTime) !== undefined ? { updateTime: safeNumber(entry.updateTime) } : {}),
    }];
  });
  const nextCursor = optionalCursor(result.nextCursor);
  return { albums, ...(nextCursor ? { nextCursor } : {}), hasMore: Boolean(result.hasMore || nextCursor) };
}

export async function listLineAlbumPhotos(
  client: Client,
  options: { chatId: string; albumId: string; cursor?: string },
): Promise<LineAlbumPhotoPage> {
  const response = record(await moa(client).getPhotos({
    chatId: id(options.chatId, "chat id"),
    albumId: id(options.albumId, "album id"),
    cursor: optionalCursor(options.cursor),
    pageSize: 40,
  }));
  const result = record(response.result);
  const raw = Array.isArray(result.photos) ? result.photos : [];
  const photos: LineAlbumPhoto[] = raw.slice(0, 40).flatMap((value) => {
    const entry = record(value);
    const resource = record(entry.obsResourceId);
    const oid = String(entry.oid ?? resource.oid ?? "").trim();
    if (!oid) return [];
    return [{
      id: String(entry.photoId ?? entry.id ?? oid),
      oid,
      resourceType: String(entry.resourceType ?? "image"),
      sid: String(resource.sid ?? "a"),
      ...(safeNumber(entry.width) !== undefined ? { width: safeNumber(entry.width) } : {}),
      ...(safeNumber(entry.height) !== undefined ? { height: safeNumber(entry.height) } : {}),
    }];
  });
  const nextCursor = optionalCursor(result.nextCursor);
  return { photos, ...(nextCursor ? { nextCursor } : {}) };
}

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
export async function previewLineAlbumPhoto(
  client: Client,
  options: { chatId: string; albumId: string; oid: string },
): Promise<{ dataUrl: string; bytes: number }> {
  const bytes = await moa(client).downloadPhoto({
    chatId: id(options.chatId, "chat id"),
    albumId: id(options.albumId, "album id"),
    oid: id(options.oid, "photo object id"),
    prefix: "album/a",
  });
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_PREVIEW_BYTES) {
    throw new Error("album photo preview is empty or exceeds the 10 MB limit");
  }
  // The album service returns original bytes; restrict preview to recognisable still images.
  const header = Buffer.from(bytes.subarray(0, 12));
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const gif = header.subarray(0, 3).toString("ascii") === "GIF";
  const webp = header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
  const mime = jpeg ? "image/jpeg" : png ? "image/png" : gif ? "image/gif" : webp ? "image/webp" : undefined;
  if (!mime) throw new Error("album file is not a supported image preview");
  return { dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`, bytes: bytes.length };
}


/**
 * Moa's album list does not provide a cover URL. Resolve a real album photo
 * only on demand, rather than downloading a picture for every album at list time.
 * No private channel credentials or OBS URLs are returned to the WebView.
 */
export async function previewLineAlbumCover(
  client: Client,
  options: { chatId: string; albumId: string },
): Promise<{ dataUrl: string; bytes: number }> {
  const page = await listLineAlbumPhotos(client, options);
  const candidates = page.photos.filter((photo) =>
    photo.sid !== "v" && !/video/i.test(photo.resourceType));
  if (!candidates.length) throw new Error("album has no previewable photos");
  // A broken/deleted first picture shouldn't hide the whole album's cover.
  let failure: unknown;
  for (const photo of candidates.slice(0, 3)) {
    try {
      return await previewLineAlbumPhoto(client, { ...options, oid: photo.oid });
    } catch (error) {
      failure = error;
    }
  }
  throw failure ?? new Error("album cover unavailable");
}
