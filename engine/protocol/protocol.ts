/**
 * Versioned RPC contract between GTK UI and engine (AGENTS.md:5)
 * Single source of truth for method names and event types.
 */
export const PROTOCOL_VERSION = 1 as const;
export const LINEJS_VERSION = "3.3.2" as const;

export type RpcRequest = {
  id: string;
  version: typeof PROTOCOL_VERSION;
  method: string;
  params: Record<string, unknown>;
};

export type RpcSuccess = {
  id: string;
  version: typeof PROTOCOL_VERSION;
  ok: true;
  result: unknown;
};

export type RpcError = {
  id: string;
  version: typeof PROTOCOL_VERSION;
  ok: false;
  error: { code: string; message: string; retryable: boolean };
};

export type EngineEventType =
  | "engine.ready"
  | "auth.restoring"
  | "auth.ready"
  | "auth.qr"
  | "auth.pin"
  | "auth.logged_out"
  | "sync.start"
  | "sync.progress"
  | "sync.ready"
  | "sync.room_error"
  | "event.message"
  | "event.message.reaction"
  | "event.message.unsent"
  | "event.transport"
  | "event.chats.updated";

export const RPC_METHODS = [
  "ping",
  "capabilities",
  "auth.qr.start",
  "auth.password.start",
  "auth.token",
  "auth.logout",
  "profile.get",
  "chat.list",
  "friends.list",
  "openchat.list",
  "message.list",
  "message.send",
  "message.sendSticker",
  "message.sendEmoji",
  "message.retry",
  "message.react",
  "message.unsend",
  "message.delete_for_me",
  "media.preview",
  "media.send",
  "chat.mark_read",
  "sync.start",
  "sync.status",
] as const;
