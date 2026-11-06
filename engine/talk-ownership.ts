/**
 * LINEJS history decoding is not guaranteed to expose isMyMessage on every
 * transport. Treat the sender MID as authoritative when both MIDs are known.
 *
 * Don't infer ownership from a chat's target MID, display name or quote author:
 * those are different concepts, particularly in groups and OpenChat.
 */
export function resolveTalkOwnership(
  selfMid: unknown,
  senderMid: unknown,
  sourceFlag: unknown,
): boolean {
  const own = typeof selfMid === "string" ? selfMid.trim() : "";
  const sender = typeof senderMid === "string" ? senderMid.trim() : "";
  if (/^u[0-9a-f]{32}$/i.test(own) && /^u[0-9a-f]{32}$/i.test(sender)) {
    return own.toLowerCase() === sender.toLowerCase();
  }
  return sourceFlag === true;
}

export function reconcileTalkOwnership<T extends {
  isMine?: boolean;
  from?: unknown;
  senderId?: unknown;
  raw?: unknown;
}>(message: T, selfMid: unknown): T {
  const raw = message.raw && typeof message.raw === "object"
    ? message.raw as { from?: unknown }
    : undefined;
  const from = raw?.from ?? message.from ?? message.senderId;
  const sender = typeof from === "string" ? from :
    from && typeof from === "object"
      ? (from as {mid?:unknown;id?:unknown}).mid ?? (from as {id?:unknown}).id
      : "";
  const mine = resolveTalkOwnership(selfMid, sender, message.isMine);
  return mine === message.isMine ? message : {...message, isMine: mine};
}
