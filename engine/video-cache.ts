import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./secure-storage";

export const MAX_VIDEO_ENTRY_BYTES = 250 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 200;

export type VideoCacheEntry = {
  path: string;
  size: number;
};

export function videoCacheToken(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function isVideoCacheToken(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/**
 * Full-size video cache. Unlike LineyMediaCache this never loads the file back
 * into memory: the Electron media protocol streams it from disk, so large
 * clips do not become renderer data URLs.
 */
export class LineyVideoCache {
  readonly root: string;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(root: string, maxBytes = DEFAULT_MAX_BYTES, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.root = root;
    this.maxBytes = Math.max(1, Math.floor(maxBytes));
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    ensurePrivateDirectory(root);
  }

  pathForToken(token: string): string {
    if (!isVideoCacheToken(token)) throw new Error("invalid video cache token");
    return join(this.root, `${token}.mp4`);
  }

  async get(key: string): Promise<VideoCacheEntry | null> {
    const path = this.pathForToken(videoCacheToken(key));
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_VIDEO_ENTRY_BYTES) {
        await rm(path, { force: true });
        return null;
      }
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return { path, size: info.size };
    } catch {
      return null;
    }
  }

  async put(key: string, blob: Blob): Promise<VideoCacheEntry> {
    const size = Number(blob.size);
    if (!Number.isFinite(size) || size <= 0) throw new Error("video is empty");
    if (size > MAX_VIDEO_ENTRY_BYTES) throw new Error("video is too large to cache");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.pathForToken(videoCacheToken(key));
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.byteLength) throw new Error("video is empty");
      if (bytes.byteLength > MAX_VIDEO_ENTRY_BYTES) throw new Error("video is too large to cache");
      await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600).catch(() => undefined);
      await rename(temp, path);
      await chmod(path, 0o600).catch(() => undefined);
      await this.trim(path);
      return { path, size: bytes.byteLength };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathForToken(videoCacheToken(key)), { force: true }).catch(() => undefined);
  }

  async clear(): Promise<void> {
    let entries: string[] = [];
    try { entries = await readdir(this.root); } catch { return; }
    await Promise.all(entries.map((entry) => rm(join(this.root, entry), { force: true })));
  }

  private async trim(protectedPath: string): Promise<void> {
    let entries: string[] = [];
    try { entries = await readdir(this.root); } catch { return; }
    const files = await Promise.all(entries.map(async (entry) => {
      const path = join(this.root, entry);
      try {
        const info = await stat(path);
        return info.isFile() ? { path, size: info.size, atimeMs: info.atimeMs } : null;
      } catch {
        return null;
      }
    }));
    const candidates = files.filter((item): item is { path: string; size: number; atimeMs: number } => Boolean(item));
    let total = candidates.reduce((sum, item) => sum + item.size, 0);
    let count = candidates.length;
    if (total <= this.maxBytes && count <= this.maxEntries) return;
    for (const item of candidates.filter((entry) => entry.path !== protectedPath).sort((a, b) => a.atimeMs - b.atimeMs)) {
      if (total <= this.maxBytes && count <= this.maxEntries) break;
      await rm(item.path, { force: true });
      total -= item.size;
      count -= 1;
    }
  }
}
