import { invoke } from "@tauri-apps/api/core";
import { lineyEngine } from "./engine";

// Notification daemons consume local icon paths, not LINE's HTTPS avatar URLs.
// Native Tauri owns the files and never accepts a path supplied by the WebView.
const pending = new Map<string, Promise<void>>();
const retryAfter = new Map<string, number>();
const THROTTLE_MS = 5 * 60_000;
const FIRST_AVATAR_WAIT_MS = 850;

export function notificationAvatarUrl(input?: string): string | undefined {
  if (!input || input.length > 4096) return undefined;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    // The authenticated engine enforces a public-asset URL policy, including
    // private-IP/redirect checks, when retrieving the image bytes.
    return url.toString();
  } catch { return undefined; }
}

async function avatarKey(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function downloadAndStore(key: string, url: string): Promise<void> {
  try {
    if (await invoke<boolean>("notification_avatar_cached", { key })) return;
    if ((retryAfter.get(key) ?? 0) > Date.now()) return;
    const result = await lineyEngine.request<{ dataUrl?: unknown }>("asset.preview", { url }, 20_000);
    const image = result?.dataUrl;
    if (typeof image !== "string" || image.length > 3 * 1024 * 1024 ||
      !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(image)) {
      throw new Error("unsupported notification avatar");
    }
    await invoke("store_notification_avatar", { key, dataUrl: image });
    retryAfter.delete(key);
  } catch {
    // Missing or private CDN avatars should not block message notifications.
    retryAfter.set(key, Date.now() + THROTTLE_MS);
  }
}

export async function prepareNotificationAvatar(input?: string): Promise<string | undefined> {
  if (!lineyEngine.isNative) return undefined;
  const url = notificationAvatarUrl(input);
  if (!url) return undefined;
  try {
    const key = await avatarKey(url);
    let task = pending.get(key);
    if (!task) {
      task = downloadAndStore(key, url).finally(() => {
        if (pending.get(key) === task) pending.delete(key);
      });
      pending.set(key, task);
    }
    // Give a fast CDN/cache lookup an opportunity to populate the first toast.
    // Never keep the message notification waiting for a slow image download.
    await Promise.race([
      task,
      new Promise<void>((resolve) => setTimeout(resolve, FIRST_AVATAR_WAIT_MS)),
    ]);
    return key;
  } catch {
    return undefined;
  }
}
