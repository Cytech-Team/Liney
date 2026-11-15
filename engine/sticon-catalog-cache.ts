import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteJson } from "./secure-storage";
import type { OwnedEmoji } from "./sticon-catalog";

const SCHEMA_VERSION = 1;
const ASSET_ID = /^[0-9A-Za-z]{1,32}$/;

type CacheFile = { schema: number; expiresAt: number; emoji: OwnedEmoji[] };

function validEmoji(value: unknown): value is OwnedEmoji {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.owned === true
    && ASSET_ID.test(String(item.productId ?? ""))
    && ASSET_ID.test(String(item.sticonId ?? ""))
    && /^\d{1,30}$/.test(String(item.version ?? ""))
    && (item.resourceType === "STATIC" || item.resourceType === "ANIMATION");
}

/** Private on-disk cache for the account-owned LINE Emoji catalogue. */
export class EmojiCatalogCache {
  constructor(private readonly path: string) {}

  read(now = Date.now()): OwnedEmoji[] | null {
    if (!existsSync(this.path)) return null;
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CacheFile>;
      if (value.schema !== SCHEMA_VERSION || !Number.isFinite(value.expiresAt) || Number(value.expiresAt) <= now || !Array.isArray(value.emoji)) return null;
      const emoji = value.emoji.filter(validEmoji);
      return emoji.length === value.emoji.length ? emoji : null;
    } catch { return null; }
  }

  write(emoji: OwnedEmoji[], expiresAt: number): void {
    atomicWriteJson(this.path, { schema: SCHEMA_VERSION, expiresAt, emoji }, 0o600);
  }

  clear(): boolean {
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
      return true;
    } catch { return false; }
  }
}
