/**
 * Notification policy for live message events.
 *
 * After a first login the engine replays history through the same event path
 * as live messages. Without an arming point, every replayed message fires a
 * desktop toast ("notification bomb"). Only notify for messages created after
 * the session was armed, with a small allowance for clock skew and a bounded
 * freshness window for delayed delivery.
 */
export function shouldNotifyMessage(input: {
  isMine: boolean;
  visible: boolean;
  createdTime: number;
  armedAt: number;
  now: number;
  freshnessMs?: number;
  clockSkewMs?: number;
}): boolean {
  if (input.isMine || input.visible) return false;
  if (!Number.isFinite(input.createdTime) || input.createdTime <= 0) return false;
  const armedAt = input.armedAt > 0 ? input.armedAt : input.now;
  if (input.createdTime < armedAt - (input.clockSkewMs ?? 30_000)) return false;
  const age = input.now - input.createdTime;
  return age <= (input.freshnessMs ?? 5 * 60_000);
}
