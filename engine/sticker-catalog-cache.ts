import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteJson } from "./secure-storage";
import type { OwnedSticker } from "./sticker-catalog";

const SCHEMA_VERSION = 1;

type CacheFile = { schema: number; expiresAt: number; stickers: OwnedSticker[] };

function validSticker(value: unknown): value is OwnedSticker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.owned === true
    && /^\d{1,30}$/.test(String(item.packageId ?? ""))
    && /^\d{1,30}$/.test(String(item.stickerId ?? ""))
    && /^\d{1,30}$/.test(String(item.version ?? ""));
}

/** Private on-disk cache for the account-owned sticker catalogue. */
export class StickerCatalogCache {
  constructor(private readonly path: string) {}

  read(now = Date.now()): OwnedSticker[] | null {
    if (!existsSync(this.path)) return null;
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CacheFile>;
      if (value.schema !== SCHEMA_VERSION || !Number.isFinite(value.expiresAt) || Number(value.expiresAt) <= now || !Array.isArray(value.stickers)) return null;
      const stickers = value.stickers.filter(validSticker);
      return stickers.length === value.stickers.length ? stickers : null;
    } catch { return null; }
  }

  write(stickers: OwnedSticker[], expiresAt: number): void {
    atomicWriteJson(this.path, { schema: SCHEMA_VERSION, expiresAt, stickers }, 0o600);
  }

  clear(): boolean {
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
      return true;
    } catch { return false; }
  }

  remove(packageId: string, stickerId: string): boolean {
    try {
      if (!existsSync(this.path)) return true;
      const value = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CacheFile>;
      if (value.schema !== SCHEMA_VERSION || !Number.isFinite(value.expiresAt) || !Array.isArray(value.stickers)) return false;
      const stickers = value.stickers.filter(validSticker);
      if (stickers.length !== value.stickers.length) return false;
      const next = stickers.filter((item) => item.packageId !== packageId || item.stickerId !== stickerId);
      if (next.length === stickers.length) return true;
      atomicWriteJson(this.path, { schema: SCHEMA_VERSION, expiresAt: Number(value.expiresAt), stickers: next }, 0o600);
      return true;
    } catch { return false; }
  }
}
