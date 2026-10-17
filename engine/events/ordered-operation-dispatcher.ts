/**
 * A per-session ordered lane shared by PUSH and fallback polling.
 *
 * Callers await dispatch() to apply backpressure: concurrent producers cannot
 * start unbounded decryption/SQLite writes or overtake an earlier operation.
 * Only successfully handled operations enter the bounded replay cache.
 */
export class OrderedOperationDispatcher<T> {
  private tail: Promise<void> = Promise.resolve();
  private readonly seen = new Map<string, true>();

  constructor(
    private readonly isActive: () => boolean,
    private readonly identify: (event: T) => string | null,
    private readonly handle: (event: T) => Promise<void>,
    private readonly seenLimit = 2_048,
  ) {}

  dispatch(event: T): Promise<void> {
    const task = this.tail.then(async () => {
      if (!this.isActive()) return;
      const identity = this.identify(event);
      if (identity && this.seen.has(identity)) return;
      await this.handle(event);
      if (identity && this.isActive() && this.seenLimit > 0) {
        this.seen.set(identity, true);
        while (this.seen.size > this.seenLimit) {
          const oldest = this.seen.keys().next().value;
          if (oldest === undefined) break;
          this.seen.delete(oldest);
        }
      }
    });
    // An isolated malformed operation must not poison later deliveries.
    this.tail = task.catch(() => undefined);
    return task;
  }
}

const asId = (value: unknown): string => String(value ?? "").trim();

/** No synthetic ids: edits, reads and reactions must only dedupe by revision. */
export function talkOperationIdentity(operation: any, type: string): string | null {
  const revision = asId(operation?.revision);
  if (revision && revision !== "0") return `talk:${type}:revision:${revision}`;
  if (type !== "RECEIVE_MESSAGE" && type !== "SEND_MESSAGE") return null;
  const messageId = asId(operation?.message?.id);
  return messageId ? `talk:${type}:message:${messageId}` : null;
}

export function squareOperationIdentity(operation: any, type: string): string | null {
  const revision = asId(operation?.revision);
  if (revision && revision !== "0") return `square:${type}:revision:${revision}`;
  if (type !== "RECEIVE_MESSAGE" && type !== "SEND_MESSAGE") return null;
  const envelope = operation?.payload?.receiveMessage ?? operation?.payload?.sendMessage
    ?? operation?.payload?.notificationMessage;
  const squareMessage = envelope?.squareMessage;
  const messageId = asId(squareMessage?.message?.id ?? squareMessage?.id);
  const chatId = asId(squareMessage?.squareChatMid ?? squareMessage?.to ?? envelope?.squareChatMid);
  return messageId && chatId ? `square:${type}:message:${chatId}:${messageId}` : null;
}
