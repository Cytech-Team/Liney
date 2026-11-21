/**
 * Helpers for OpenChat (Square) history paging.
 *
 * `fetchSquareChatEvents` returns `SquareEvent` items where every event carries
 * its own `syncToken`. LINE reverses the page when `direction` is `BACKWARD`,
 * starting at the supplied token. Keeping the token next to the message lets a
 * later request ask for "everything older than this message" without walking
 * the whole room from the live tail.
 */

export const SQUARE_EVENT_TOKEN_KEY = "lineySquareEventToken";

export type SquareEventEnvelope = {
  message: Record<string, unknown>;
  senderName: string;
  isMine: boolean;
  reactionStatus: unknown;
  eventToken?: string;
};

type SquareEventLike = {
  type?: unknown;
  syncToken?: unknown;
  payload?: {
    receiveMessage?: Record<string, unknown>;
    sendMessage?: Record<string, unknown>;
    notificationMessage?: Record<string, unknown>;
  };
};

const asToken = (value: unknown): string | undefined => {
  const token = typeof value === "string" ? value.trim() : "";
  return token || undefined;
};

/** Pull the message envelope out of a square event, ignoring non-message events. */
export function squareEventEnvelope(event: unknown): SquareEventEnvelope | null {
  const value = event as SquareEventLike | null | undefined;
  const payload = value?.payload;
  const envelope = payload?.receiveMessage ?? payload?.sendMessage ?? payload?.notificationMessage;
  const squareMessage = envelope?.squareMessage as Record<string, unknown> | undefined;
  const message = (squareMessage?.message ?? squareMessage) as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object" || typeof message.id === "undefined") return null;
  const type = String(value?.type ?? "");
  return {
    message,
    senderName: String((envelope as any)?.senderDisplayName ?? ""),
    isMine: type === "SEND_MESSAGE",
    reactionStatus: (envelope as any)?.messageReactionStatus,
    eventToken: asToken(value?.syncToken),
  };
}

/** Copy a message payload with its event token attached for later paging. */
export function withSquareEventToken(
  raw: Record<string, unknown> | null | undefined,
  token: string | undefined,
): Record<string, unknown> {
  const base = raw && typeof raw === "object" ? raw : {};
  if (!token) return base;
  return { ...base, [SQUARE_EVENT_TOKEN_KEY]: token };
}

/** Read the token stored by `withSquareEventToken`. */
export function squareEventToken(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return asToken((raw as Record<string, unknown>)[SQUARE_EVENT_TOKEN_KEY]);
}

export type SquareHistoryCandidate = { id: string; createdTime: number };

/**
 * Keep only messages older than the pivot, drop duplicates, and return them in
 * ascending conversation order.
 */
export function olderSquareHistory<T extends SquareHistoryCandidate>(
  items: readonly T[],
  pivot: SquareHistoryCandidate,
): T[] {
  const seen = new Set<string>();
  const older: T[] = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    const time = Number(item.createdTime ?? 0);
    if (time > pivot.createdTime) continue;
    if (time === pivot.createdTime && item.id >= pivot.id) continue;
    seen.add(item.id);
    older.push(item);
  }
  older.sort((left, right) => (
    Number(left.createdTime ?? 0) - Number(right.createdTime ?? 0)
    || left.id.localeCompare(right.id)
  ));
  return older;
}
