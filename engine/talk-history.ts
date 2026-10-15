export type TalkHistoryState = "available" | "new" | "unavailable";

// Canonical LINE-managed system account. Its cursor can advance even when
// history endpoints omit the payload, so the engine also checks live operation
// messages and the message box's lastMessages before showing a placeholder.
export const LINE_SYSTEM_ACCOUNT_MID = "u085311ecd9e3e3d74ae4c9f5437cbcb5";

export type TalkMessageBoxLike = {
  id?: unknown;
  unreadCount?: unknown;
  lastMessages?: unknown[];
  lastSeenMessageId?: unknown;
  lastRemovedMessageId?: unknown;
  lastRemovedTime?: unknown;
  hiddenAtMessageId?: unknown;
};

export function talkMessageBoxId(box?: TalkMessageBoxLike): string {
  return typeof box?.id === "string" ? box.id : String(box?.id ?? "");
}

function positiveCounter(value: unknown): boolean {
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try { return BigInt(value) > 0n; } catch { return false; }
  }
  return false;
}

export function talkMessageBoxHasHistory(box: TalkMessageBoxLike): boolean {
  return Array.isArray(box.lastMessages) && box.lastMessages.length > 0;
}

/**
 * Distinguish a brand-new room from a room whose older history is no longer
 * available through Talk history. `lastDeliveredMessageId` alone is not
 * evidence of a conversation: LINE can allocate it for contacts that have
 * never exchanged a message (Noi23 is one real example).
 */
export function talkMessageBoxHistoryState(box?: TalkMessageBoxLike): TalkHistoryState {
  if (!box) return "new";
  if (talkMessageBoxHasHistory(box)) return "available";
  if (talkMessageBoxId(box) === LINE_SYSTEM_ACCOUNT_MID) return "unavailable";

  const hasConversationEvidence =
    positiveCounter(box.unreadCount) ||
    positiveCounter(box.lastSeenMessageId) ||
    positiveCounter(box.lastRemovedMessageId) ||
    positiveCounter(box.lastRemovedTime) ||
    positiveCounter(box.hiddenAtMessageId);

  return hasConversationEvidence ? "unavailable" : "new";
}

export function shouldRetryTalkHistory(cursor: unknown, messageCount: number): boolean {
  return cursor !== undefined && cursor !== null && messageCount === 0;
}

export function additionalTalkHistoryBoxIds(
  joinedChatIds: readonly string[],
  boxes: readonly TalkMessageBoxLike[],
): string[] {
  const joined = new Set(joinedChatIds);
  return [...new Set(
    boxes
      .filter(talkMessageBoxHasHistory)
      .map(talkMessageBoxId)
      .filter((id) => Boolean(id) && !joined.has(id)),
  )];
}
