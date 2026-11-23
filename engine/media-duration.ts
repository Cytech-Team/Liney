function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/**
 * LINE stores video/audio length in contentMetadata.DURATION as milliseconds.
 * Keep the parser tolerant of the nested `{ raw: message }` shape used by the
 * engine, and of JSON-string metadata from older database rows.
 */
export function mediaDurationMs(raw: unknown): number | undefined {
  const direct = asRecord(raw);
  const nested = direct ? asRecord(direct.raw) : undefined;
  const source = nested ?? direct;
  if (!source) return undefined;
  const metadata = asRecord(source.contentMetadata) ?? parseRecord(source.contentMetadata) ?? {};
  const value = Number(metadata.DURATION ?? metadata.duration ?? source.duration);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}
