export type FlexMessageData = {
  contents: Record<string, unknown>;
  altText?: string;
  version?: string;
  effectTag?: string;
};

const MAX_FLEX_JSON_LENGTH = 768 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

/**
 * Extract the JSON Flex document from a raw Talk or Square message.
 * Only the two LINE Flex root types are accepted; the UI renders the known
 * component types itself and never evaluates payload content as markup.
 */
export function parseFlexMessage(raw: unknown): FlexMessageData | undefined {
  const source = isRecord(raw) && isRecord(raw.raw) ? raw.raw : raw;
  if (!isRecord(source)) return undefined;
  const metadata = isRecord(source.contentMetadata) ? source.contentMetadata : undefined;
  if (!metadata) return undefined;

  const contents = parseJson(metadata.FLEX_JSON ?? metadata.flexJson);
  if (!isRecord(contents)) return undefined;
  const type = String(contents.type ?? "").toLowerCase();
  if (type !== "bubble" && type !== "carousel") return undefined;

  const altText = String(metadata.ALT_TEXT ?? metadata.altText ?? "").trim();
  const version = String(metadata.FLEX_VER ?? metadata.flexVer ?? "").trim();
  const effectTag = String(metadata.EFFECT_TAG ?? metadata.effectTag ?? "").trim();
  return {
    contents,
    ...(altText ? { altText } : {}),
    ...(version ? { version } : {}),
    ...(effectTag ? { effectTag } : {}),
  };
}
