import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory } from "./secure-storage";

export type DiskMedia = {
  path: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
};

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1_200;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;

function cacheFileName(key: string): string {
  return `${createHash("sha256").update(key).digest("hex")}.preview`;
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime || "application/octet-stream"};base64,${Buffer.from(bytes).toString("base64")}`;
}

export class LineyMediaCache {
  readonly root: string;
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  constructor(root: string, maxBytes = DEFAULT_MAX_BYTES, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.root = root;
    this.maxBytes = Math.max(MAX_ENTRY_BYTES, maxBytes);
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    ensurePrivateDirectory(root);
  }

  async get(key: string, mime = "image/jpeg"): Promise<{ dataUrl: string; path: string; mime: string; size: number; bytes: Uint8Array } | null> {
    const path = this.pathFor(key);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_ENTRY_BYTES) {
        await rm(path, { force: true });
        return null;
      }
      const bytes = new Uint8Array(await readFile(path));
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return { dataUrl: dataUrl(mime, bytes), path, mime, size: bytes.byteLength, bytes };
    } catch {
      return null;
    }
  }

  async put(key: string, blob: Blob): Promise<{ path: string; mime: string; size: number } | null> {
    const size = Number(blob.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_ENTRY_BYTES) return null;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.pathFor(key);
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > MAX_ENTRY_BYTES) return null;
      await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600).catch(() => undefined);
      await rename(temp, path);
      await chmod(path, 0o600).catch(() => undefined);
      await this.trim(path);
      return { path, mime: blob.type || "image/jpeg", size: bytes.byteLength };
    } catch {
      await rm(temp, { force: true }).catch(() => undefined);
      return null;
    }
  }

  async clear(): Promise<void> {
    let entries: string[] = [];
    try { entries = await readdir(this.root); } catch { return; }
    await Promise.all(entries.map((entry) => rm(join(this.root, entry), { force: true })));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true }).catch(() => undefined);
  }

  private pathFor(key: string): string {
    return join(this.root, cacheFileName(key));
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
