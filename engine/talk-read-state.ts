import type { TalkMessageReadRange } from "./linejs/adapter";

export type TalkMessageReadState = {
  messageId: string;
  readCount: number;
  readerMids: string[];
};

function decimalId(value: string): bigint | null {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) return null;
  try { return BigInt(text); } catch { return null; }
}

function rangeContains(messageId: bigint, startText: string, endText: string): boolean {
  const start = decimalId(startText);
  const end = decimalId(endText);
  if (start === null || end === null) return false;
  const low = start <= end ? start : end;
  const high = start <= end ? end : start;
  return messageId >= low && messageId <= high;
}

/**
 * Convert LINE's per-reader message ranges into exact read state for the
 * requested message ids. Message ids stay as BigInt throughout comparison;
 * LINE ids are larger than Number.MAX_SAFE_INTEGER.
 */
export function talkReadStateForMessages(
  range: TalkMessageReadRange | undefined,
  messageIds: string[],
  selfMid = "",
): TalkMessageReadState[] {
  const ids = [...new Set(messageIds.map((messageId) => String(messageId).trim()).filter(Boolean))];
  if (!range) return ids.map((messageId) => ({ messageId, readCount: 0, readerMids: [] }));
  const self = selfMid.trim();
  return ids.map((messageId) => {
    const id = decimalId(messageId);
    if (id === null) return { messageId, readCount: 0, readerMids: [] };
    const readerMids = Object.entries(range.ranges)
      .filter(([readerMid, entries]) => readerMid !== self && entries.some((entry) => rangeContains(id, entry.startMessageId, entry.endMessageId)))
      .map(([readerMid]) => readerMid)
      .sort();
    return { messageId, readCount: readerMids.length, readerMids };
  });
}
