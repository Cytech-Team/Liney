export type NotificationJump = { messageId: string; nonce: number };

/**
 * A notification jump is a one-shot event, not a scroll position.
 *
 * The request stays in parent state until it is replaced, so the jump effect
 * re-runs on every chat switch or message refresh. Applying it only once per
 * nonce stops Liney from dragging the user back to the same message after
 * they navigate away and return to the conversation.
 */
export function pendingNotificationJump(
  jump: NotificationJump | null | undefined,
  consumedNonce: number,
): NotificationJump | null {
  if (!jump?.messageId || !jump.nonce) return null;
  if (jump.nonce === consumedNonce) return null;
  return jump;
}
