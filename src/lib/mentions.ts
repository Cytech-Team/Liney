export type MessageMention = { start: number; end: number; mid?: string };

export type MentionCandidate = { mid: string; name: string };

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

export type MentionQuery = { start: number; query: string };
export type MentionOption = { mid: string; name: string; avatarUrl?: string };

/**
 * Finds the "@query" token that ends at the caret. The picker opens on any "@"
 * (Thai is often typed without spaces before a tag) and closes once the query
 * hits whitespace or another "@". Offsets are UTF-16 indices, like LINE's.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const end = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, end);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && before[at - 1] === "@") return null;
  const query = before.slice(at + 1);
  if (query.length > 60 || /[\s@]/u.test(query)) return null;
  return { start: at, query };
}

/** A word character on either side means the "@" is not a standalone tag. */
function blocksMentionBoundary(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

/**
 * An "@" glued to an e-mail local part is not a tag. Only ASCII word
 * characters count, so Thai text typed without a space still tags ("สวัสดี@นัท").
 */
function blocksMentionStart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9._%+-@]/.test(value);
}

/**
 * Turns "@Name" tokens in an outgoing message into LINE's mention metadata.
 *
 * Without contentMetadata.MENTION the recipient only sees plain text, so the
 * tag must be resolved back to a member mid (and UTF-16 offsets) at send time.
 * Longer names win so "@Ann" never steals the start of "@Anna".
 */
export function buildMentionMetadata(text: string, candidates: MentionCandidate[]): { MENTION: string } | undefined {
  if (!text || !candidates.length) return undefined;
  const byName = new Map<string, string>();
  for (const candidate of candidates) {
    const name = String(candidate.name ?? "").trim();
    const mid = String(candidate.mid ?? "");
    if (!name || !/^[up][a-f0-9]{32}$/i.test(mid) || byName.has(name)) continue;
    byName.set(name, mid);
  }
  if (!byName.size) return undefined;

  const claimed = new Array<boolean>(text.length).fill(false);
  const entries: { start: number; end: number; mid: string }[] = [];
  for (const name of [...byName.keys()].sort((left, right) => right.length - left.length)) {
    const token = `@${name}`;
    let index = text.indexOf(token);
    while (index >= 0) {
      const end = index + token.length;
      const free = !claimed.slice(index, end).some(Boolean);
      const startsClean = index === 0 || !blocksMentionStart(text[index - 1]);
      const endsClean = end >= text.length || !blocksMentionBoundary(text[end]);
      if (free && startsClean && endsClean) {
        entries.push({ start: index, end, mid: byName.get(name)! });
        for (let cursor = index; cursor < end; cursor += 1) claimed[cursor] = true;
      }
      index = text.indexOf(token, index + 1);
    }
  }
  if (!entries.length) return undefined;
  entries.sort((left, right) => left.start - right.start);
  return {
    MENTION: JSON.stringify({
      MENTIONEES: entries.map(({ start, end, mid }) => ({ S: String(start), E: String(end), M: mid })),
    }),
  };
}
