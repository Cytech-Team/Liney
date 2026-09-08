import { realpathSync } from "node:fs";
import { readFile as readFileAsync, stat as statAsync } from "node:fs/promises";
import { homedir } from "node:os";

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export type MediaWorkerEvent = {
  type: "media.progress" | "media.error";
  jobId: string;
  phase?: "queued" | "reading" | "uploading" | "complete" | "cancelled";
  done?: number;
  total?: number;
  cancelled?: boolean;
  error?: unknown;
};

export function decodeMediaBase64(encoded: string): Uint8Array {
  if (!encoded) throw new Error("media file or image data is required");
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("media data is not valid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error("media file exceeds the 25 MB limit");
  return new Uint8Array(bytes);
}

export class MediaWorker {
  private readonly jobs = new Map<string, AbortController>();
  private readonly allowedRoots: string[];
  private readonly onEvent: (event: MediaWorkerEvent) => void;
  private readonly formatError: (error: unknown) => unknown;

  constructor(
    onEvent: (event: MediaWorkerEvent) => void,
    formatError: (error: unknown) => unknown = (error) => String(error instanceof Error ? error.message : error),
    allowedRoots = [homedir(), "/tmp"],
  ) {
    this.onEvent = onEvent;
    this.formatError = formatError;
    this.allowedRoots = allowedRoots.map((root) => root.replace(/\/+$/, ""));
  }

  async read(params: { filePath?: string; base64?: string }, jobId: string, signal: AbortSignal): Promise<Uint8Array> {
    this.assertNotCancelled(signal);
    const filePath = String(params.filePath ?? "").trim();
    if (filePath) {
      let resolved: string;
      try { resolved = realpathSync(filePath); } catch { throw new Error("media file does not exist"); }
      if (!this.allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
        throw new Error("media path is outside the allowed user/temp directories");
      }
      const info = await statAsync(resolved);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_MEDIA_BYTES) {
        throw new Error("media file exceeds the 25 MB limit");
      }
      this.onEvent({ type: "media.progress", jobId, phase: "reading", done: 0, total: info.size });
      const bytes = await readFileAsync(resolved);
      this.assertNotCancelled(signal);
      this.onEvent({ type: "media.progress", jobId, phase: "reading", done: info.size, total: info.size });
      return new Uint8Array(bytes);
    }
    const bytes = decodeMediaBase64(String(params.base64 ?? "").trim());
    this.assertNotCancelled(signal);
    this.onEvent({ type: "media.progress", jobId, phase: "reading", done: bytes.byteLength, total: bytes.byteLength });
    return bytes;
  }

  async run<T>(jobId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.jobs.has(jobId)) throw new Error("media job is already running");
    const controller = new AbortController();
    this.jobs.set(jobId, controller);
    this.onEvent({ type: "media.progress", jobId, phase: "queued", done: 0, total: 0 });
    try {
      const result = await task(controller.signal);
      this.assertNotCancelled(controller.signal);
      this.onEvent({ type: "media.progress", jobId, phase: "complete", done: 1, total: 1 });
      return result;
    } catch (error) {
      this.onEvent({
        type: "media.error",
        jobId,
        cancelled: controller.signal.aborted,
        error: this.formatError(error),
      });
      throw error;
    } finally {
      this.jobs.delete(jobId);
    }
  }

  cancel(jobId: string): boolean {
    const controller = this.jobs.get(jobId);
    if (!controller) return false;
    controller.abort();
    this.onEvent({ type: "media.progress", jobId, phase: "cancelled", done: 0, total: 0 });
    return true;
  }

  cancelAll(): void {
    for (const jobId of this.jobs.keys()) this.cancel(jobId);
  }

  assertActive(signal: AbortSignal): void {
    this.assertNotCancelled(signal);
  }

  private assertNotCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("media upload cancelled");
  }
}
