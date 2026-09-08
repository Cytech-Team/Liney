const STICKER_CDN_BASE = "https://stickershop.line-scdn.net/stickershop/v1/sticker";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function metadataFromRaw(raw: unknown): Record<string, unknown> | undefined {
  const source = isRecord(raw) && isRecord(raw.raw) ? raw.raw : raw;
  if (!isRecord(source)) return undefined;
  const value = source.contentMetadata;
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stickerIdFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const rawStickerId = metadata.STKID ?? metadata.stickerId ?? metadata.sticker_id;
  const stickerId = String(rawStickerId ?? "").trim();
  return stickerId || undefined;
}

/**
 * Return ordered official CDN candidates. LINE occasionally marks a sticker
 * as animated even though that package only publishes the static asset, and
 * some older packages publish Android and iOS assets differently.
 */
export function stickerUrlCandidatesFromRaw(raw: unknown): string[] {
  const metadata = metadataFromRaw(raw);
  if (!metadata) return [];
  const stickerId = stickerIdFromMetadata(metadata);
  if (!stickerId) return [];

  const option = String(metadata.STKOPT ?? metadata.stickerOption ?? "").trim().toUpperCase();
  const preferred = option === "A" ? "sticker_animation.png" : "sticker.png";
  const alternate = preferred === "sticker.png" ? "sticker_animation.png" : "sticker.png";
  return [
    `android/${preferred}`,
    `ANDROID/${preferred}`,
    `iPhone/${preferred.replace(".png", "@2x.png")}`,
    `android/${alternate}`,
    `ANDROID/${alternate}`,
    `iPhone/${alternate.replace(".png", "@2x.png")}`,
  ].map((asset) => `${STICKER_CDN_BASE}/${encodeURIComponent(stickerId)}/${asset}`);
}

/**
 * Build the official LINE sticker asset URL from a raw Talk/Square message.
 * The raw payload is kept in SQLite, so this stays deterministic across
 * restarts without persisting a second copy of the derived URL.
 */
export function stickerUrlFromRaw(raw: unknown): string | undefined {
  const [first] = stickerUrlCandidatesFromRaw(raw);
  return first;
}
