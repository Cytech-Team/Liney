export type FlexMessageData = {
  contents: Record<string, unknown>;
  altText?: string;
  version?: string;
  effectTag?: string;
};

const MAX_FLEX_JSON_LENGTH = 768 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (isRecord(value) || Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > MAX_FLEX_JSON_LENGTH) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "string" && parsed.length <= MAX_FLEX_JSON_LENGTH) {
      try { return JSON.parse(parsed) as unknown; } catch { return parsed; }
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = isRecord(value) ? value : undefined;
  if (direct) return direct;
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : undefined;
}

function messageMetadata(raw: unknown): Record<string, unknown> | undefined {
  const source = isRecord(raw) && isRecord(raw.raw) ? raw.raw : raw;
  return isRecord(source) ? parseRecord(source.contentMetadata) : undefined;
}

function metadataText(metadata: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text) return text;
  }
  return undefined;
}

/** Extract LINE's real, human-readable preview without parsing FLEX_JSON. */
export function flexAltText(raw: unknown): string | undefined {
  const source = isRecord(raw) ? raw : undefined;
  const flex = isRecord(source?.flex) ? source.flex : undefined;
  const metadata = messageMetadata(raw);
  const text = metadataText(metadata ?? {}, "ALT_TEXT", "altText")
    ?? (typeof flex?.altText === "string" ? flex.altText : undefined);
  const clean = text?.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 400) : undefined;
}

/**
 * Extract the JSON Flex document from a raw Talk or Square message.
 * Only the two LINE Flex root types are accepted; the UI renders the known
 * component types itself and never evaluates payload content as markup.
 */
export function parseFlexMessage(raw: unknown): FlexMessageData | undefined {
  const metadata = messageMetadata(raw);
  if (!metadata) return undefined;

  const contents = parseJson(metadata.FLEX_JSON ?? metadata.flexJson);
  if (!isRecord(contents)) return undefined;
  const type = String(contents.type ?? "").trim().toLowerCase();
  if (type !== "bubble" && type !== "carousel") return undefined;

  const altText = metadataText(metadata, "ALT_TEXT", "altText");
  const version = metadataText(metadata, "FLEX_VER", "flexVer");
  const effectTag = metadataText(metadata, "EFFECT_TAG", "effectTag");
  return {
    contents,
    ...(altText ? { altText } : {}),
    ...(version ? { version } : {}),
    ...(effectTag ? { effectTag } : {}),
  };
}
