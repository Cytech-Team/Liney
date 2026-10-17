/**
 * Prepare LINE's own-account Profile for the desktop renderer.
 * getProfile returns pictureStatus rather than a ready-to-render pictureUrl.
 * The authenticated account's OBS profile asset is addressable by its MID.
 */
export type OwnProfileRecord = {
  mid?: unknown;
  pictureStatus?: unknown;
  picturePath?: unknown;
  pictureUrl?: unknown;
  avatarUrl?: unknown;
  [key: string]: unknown;
};

export function presentOwnProfile<T extends OwnProfileRecord>(profile: T, refreshKey?: number): T & { pictureUrl?: string; avatarUrl?: string } {
  const raw = profile && typeof profile === "object" ? profile : {} as T;
  const existing = [raw.pictureUrl, raw.avatarUrl].find(
    (value): value is string => typeof value === "string" && /^https:\/\//i.test(value.trim()),
  );
  const picturePath = typeof raw.picturePath === "string" ? raw.picturePath.trim() : "";
  const mid = String(raw.mid ?? "").trim();
  const status = String(raw.pictureStatus ?? "").trim();
  let image = existing?.trim() ?? "";

  if (!image && picturePath) {
    image = /^https:\/\//i.test(picturePath)
      ? picturePath
      : !/^https?:\/\//i.test(picturePath)
        ? `https://profile.line-scdn.net/${picturePath.replace(/^\/+/, "")}`
        : "";
  }
  // LINE exposes the pictureStatus field but often omits picturePath.
  // Resolve the self-profile directly through its OBS talk-profile endpoint.
  if (!image && /^u[0-9a-f]{32}$/i.test(mid)) {
    const version = refreshKey ? String(refreshKey) : status && status !== "0" ? status : "";
    image = `https://obs.line-scdn.net/r/talk/p/${encodeURIComponent(mid)}`;
    if (version) image += `?v=${encodeURIComponent(version.slice(0, 120))}`;
  }
  return image ? { ...raw, pictureUrl: image, avatarUrl: image } : { ...raw };
}
