export type RichMessageAction = {
  x: number;
  y: number;
  width: number;
  height: number;
  link: string;
};

export type RichMessageData = {
  imageUrl: string;
  altText?: string;
  width?: number;
  height?: number;
  actions?: RichMessageAction[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return undefined;
  let parsed: unknown = value;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (typeof parsed !== "string") break;
    try { parsed = JSON.parse(parsed); } catch { return undefined; }
  }
  return asRecord(parsed);
}

function messageMetadata(raw: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(raw);
  const nested = direct ? asRecord(direct.raw) : undefined;
  const source = nested ?? direct;
  const metadata = source?.contentMetadata;
  return asRecord(metadata) ?? parseRecord(metadata);
}

function safeHttpsUrl(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 8_000) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 && number <= 20_000 ? number : undefined;
}

function coordinateNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 20_000 ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

/**
 * Parse LINE's legacy RICH message format. RICH messages are a composed
 * image plus hit regions described by MARKUP_JSON, rather than Flex JSON.
 * Only HTTPS image and web URLs are allowed to cross into the renderer.
 */
export function parseRichMessage(raw: any): RichMessageData | undefined {
  const metadata = messageMetadata(raw);
  if (!metadata) return undefined;
  const imageUrl = safeHttpsUrl(
    metadata.DOWNLOAD_URL
      ?? metadata.downloadUrl
      ?? metadata.PREVIEW_URL
      ?? metadata.previewUrl,
  );
  if (!imageUrl) return undefined;

  const markup = parseRecord(metadata.MARKUP_JSON ?? metadata.markupJson);
  const canvas = asRecord(markup?.canvas);
  const width = positiveNumber(canvas?.width);
  const height = positiveNumber(canvas?.height);
  const actionsById = asRecord(markup?.actions);
  const sceneName = stringValue(canvas?.initialScene) ?? "scene1";
  const scenes = asRecord(markup?.scenes);
  const scene = asRecord(scenes?.[sceneName]);
  const listeners = Array.isArray(scene?.listeners) ? scene.listeners : [];
  const actions: RichMessageAction[] = [];

  for (const listener of listeners) {
    const item = asRecord(listener);
    const actionId = stringValue(item?.action);
    const action = actionId && actionsById ? asRecord(actionsById[actionId]) : undefined;
    const params = Array.isArray(item?.params) ? item.params : [];
    const [x, y] = params.slice(0, 2).map(coordinateNumber);
    const [actionWidth, actionHeight] = params.slice(2, 4).map(positiveNumber);
    const link = safeHttpsUrl(
      asRecord(action?.params)?.linkUri
        ?? asRecord(action?.params)?.uri
        ?? asRecord(action?.params)?.url,
    );
    if (x === undefined || y === undefined || actionWidth === undefined || actionHeight === undefined || !link) continue;
    if (width && height && (x >= width || y >= height || x + actionWidth > width || y + actionHeight > height)) continue;
    actions.push({ x, y, width: actionWidth, height: actionHeight, link });
  }

  const altText = stringValue(metadata.ALT_TEXT ?? metadata.altText);
  return {
    imageUrl,
    ...(altText ? { altText } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(actions.length ? { actions } : {}),
  };
}
