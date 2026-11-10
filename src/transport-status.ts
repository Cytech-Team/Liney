export type LineTransportState = "unknown" | "connected" | "reconnecting" | "degraded";

export function reduceLineTransportState(
  current: LineTransportState,
  event: { type?: unknown; transport?: unknown; state?: unknown },
): LineTransportState {
  if (event.type === "auth.logged_out" || event.type === "auth.restore_failed") return "unknown";
  if (event.type === "event.transport" && event.transport === "line") {
    if (event.state === "connected") return "connected";
    if (event.state === "reconnecting") return "reconnecting";
  }
  if (
    event.type === "event.transport.error" &&
    (event.transport === "talk" || event.transport === "openchat" || event.transport === "talk-poll" || event.transport === "openchat-poll")
  ) return "degraded";
  return current;
}
