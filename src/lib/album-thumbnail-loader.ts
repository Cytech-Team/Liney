import { lineyEngine } from "./engine";

type PreviewResult = { dataUrl?: unknown };
export type Request = { method: "album.cover.preview" | "album.photo.preview"; params: Record<string, string> };

const MAX_CACHE_ENTRIES = 64;
const MAX_PREVIEW_BASE64_LENGTH = 14 * 1024 * 1024;

/** Decode one authenticated image, then keep only a small browser-side JPEG. */
function resizeAlbumImage(dataUrl: unknown): Promise<string> {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_PREVIEW_BASE64_LENGTH
    || !/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(dataUrl)) {
    return Promise.reject(new Error("Album thumbnail has an invalid image format"));
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height) throw new Error("Empty album image");
        // Use a bounded preview; never store the full-size photo in React state.
        const ratio = Math.min(1, 256 / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.78));
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => reject(new Error("Album thumbnail cannot be decoded"));
    image.src = dataUrl;
  });
}

/** Per-modal bounded cache and queue, to keep large album views responsive. */
export class AlbumThumbnailLoader {
  private active = 0;
  private queue: Array<() => void> = [];
  private cache = new Map<string, string | null>();
  private pending = new Map<string, Promise<string | null>>();

  peek(key: string) { return this.cache.get(key); }

  load(key: string, request: Request): Promise<string | null> {
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key) ?? null);
    const existing = this.pending.get(key);
    if (existing) return existing;

    const task = new Promise<string | null>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        void lineyEngine.request<PreviewResult>(request.method, request.params, 40_000)
          .then((result) => resizeAlbumImage(result?.dataUrl))
          .catch(() => null)
          .then((thumbnail) => {
            this.cache.delete(key);
            this.cache.set(key, thumbnail);
            if (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
            resolve(thumbnail);
          })
          .finally(() => {
            this.pending.delete(key);
            this.active -= 1;
            this.pump();
          });
      });
      this.pump();
    });
    this.pending.set(key, task);
    return task;
  }

  private pump() {
    while (this.active < 2 && this.queue.length) this.queue.shift()?.();
  }
}
