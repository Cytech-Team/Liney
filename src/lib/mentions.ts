export type MessageMention = { start: number; end: number; mid?: string };

type MentionEntry = { S?: unknown; E?: unknown; M?: unknown };

/**
 * LINE stores mentions as S/E offsets (UTF-16 indices) in
 * contentMetadata.MENTION, either as a JSON string or an object.
 * "@All" entries carry no mid and are therefore not clickable.
 */
export function parseMessageMentions(text: unknown, raw: unknown): MessageMention[] {
  let source = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  const contentMetadata = (source as { contentMetadata?: Record<string, unknown> } | undefined)?.contentMetadata;
  const value = contentMetadata?.MENTION ?? contentMetadata?.mention;
  if (!value) return [];

  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }

  const entries = Array.isArray((parsed as { MENTIONEES?: unknown[] } | undefined)?.MENTIONEES)
    ? (parsed as { MENTIONEES: unknown[] }).MENTIONEES
    : [];
  const length = String(text ?? "").length;

  return entries
    .flatMap((entry): MessageMention[] => {
      const record = entry as MentionEntry;
      const start = Number(record?.S);
      const end = Number(record?.E);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > length) return [];
      const mid = typeof record?.M === "string" && /^[up][a-f0-9]{32}$/i.test(record.M) ? record.M : undefined;
      return [{ start, end, ...(mid ? { mid } : {}) }];
    })
    .sort((left, right) => left.start - right.start);
}
