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

// Notification content images occupy the thumbnail slot on the RIGHT of a
// Freedesktop/CyShell notification. The native app icon stays on the LEFT.
// Render the sender as the main circle and, for group chats, the room avatar
// as a small presence-like circle overlapping its lower-right corner.
const artworkPending = new Map<string, Promise<void>>();
const ARTWORK_FIRST_WAIT_MS = 1_100;

async function loadArtworkImage(input: string | undefined): Promise<HTMLImageElement | null> {
  const url = notificationAvatarUrl(input);
  if (!url) return null;
  try {
    const response = await lineyEngine.request<{ dataUrl?: unknown }>("asset.preview", { url }, 20_000);
    const source = response?.dataUrl;
    if (typeof source !== "string" || source.length > 3 * 1024 * 1024
      || !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(source)) return null;
    return await new Promise<HTMLImageElement | null>((resolve) => {
      const picture = new Image();
      picture.onload = () => resolve(picture);
      picture.onerror = () => resolve(null);
      picture.src = source;
    });
  } catch {
    return null;
  }
}

function drawCover(
  context: CanvasRenderingContext2D,
  picture: HTMLImageElement,
  x: number,
  y: number,
  size: number,
): void {
  const crop = Math.min(picture.naturalWidth, picture.naturalHeight);
  if (!crop) return;
  context.drawImage(
    picture,
    (picture.naturalWidth - crop) / 2,
    (picture.naturalHeight - crop) / 2,
    crop,
    crop,
    x, y, size, size,
  );
}

async function storeNotificationArtwork(
  key: string,
  senderUrl: string | undefined,
  groupUrl: string | undefined,
): Promise<void> {
  try {
    if (await invoke<boolean>("notification_avatar_cached", { key })) return;
    if ((retryAfter.get(key) ?? 0) > Date.now()) return;

    const [sender, room] = await Promise.all([
      loadArtworkImage(senderUrl),
      groupUrl ? loadArtworkImage(groupUrl) : Promise.resolve(null),
    ]);
    const main = sender || room;
    if (!main) throw new Error("notification picture unavailable");

    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("notification canvas unavailable");

    // Transparent pixels outside the circle keep the right-hand thumbnail
    // circular regardless of a notification daemon's thumbnail clipping.
    context.save();
    context.beginPath();
    context.arc(64, 64, 59, 0, Math.PI * 2);
    context.clip();
    drawCover(context, main, 5, 5, 118);
    context.restore();

    // A missing sender falls back to the group as the main image, without
    // showing the same group avatar twice.
    if (sender && room && groupUrl && senderUrl !== groupUrl) {
      const x = 101, y = 102, outer = 25, inner = 20;
      context.beginPath();
      context.arc(x, y, outer, 0, Math.PI * 2);
      context.fillStyle = "#20242b";
      context.fill();
      context.save();
      context.beginPath();
      context.arc(x, y, inner, 0, Math.PI * 2);
      context.clip();
      drawCover(context, room, x - inner, y - inner, inner * 2);
      context.restore();
    }

    await invoke("store_notification_avatar", { key, dataUrl: canvas.toDataURL("image/png") });
    retryAfter.delete(key);
  } catch {
    // Network and CDN issues must never prevent notifications from arriving.
    retryAfter.set(key, Date.now() + THROTTLE_MS);
  }
}

export async function prepareNotificationArtwork(
  senderAvatarUrl?: string,
  groupAvatarUrl?: string,
): Promise<string | undefined> {
  if (!lineyEngine.isNative) return undefined;
  const sender = notificationAvatarUrl(senderAvatarUrl);
  const room = notificationAvatarUrl(groupAvatarUrl);
  if (!sender && !room) return undefined;
  try {
    const key = await avatarKey(["liney-notification-avatar-v2", sender || "", room || ""].join("\n"));
    let task = artworkPending.get(key);
    if (!task) {
      task = storeNotificationArtwork(key, sender, room).finally(() => {
        if (artworkPending.get(key) === task) artworkPending.delete(key);
      });
      artworkPending.set(key, task);
    }
    // Let a fast cached/local image appear immediately; a slow CDN fetch
    // continues in the background for the next notification.
    await Promise.race([
      task,
      new Promise<void>((resolve) => setTimeout(resolve, ARTWORK_FIRST_WAIT_MS)),
    ]);
    return key;
  } catch {
    return undefined;
  }
}
