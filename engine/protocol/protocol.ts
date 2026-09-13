/**
 * Versioned RPC contract between the WebView UI and engine.
 * Single source of truth for method names and event types.
 */
export const PROTOCOL_VERSION = 1 as const;

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
  | "sync.error"
  | "sync.room_error"
  | "event.message"
  | "event.message.updated"
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
  "call.history",
  "message.list",
  "message.read_state",
  "message.send",
  "message.sendSticker",
  "message.sendEmoji",
  "message.retry",
  "message.react",
  "message.unsend",
  "message.delete_for_me",
  "asset.preview",
  "media.preview",
  "media.send",
  "chat.mark_read",
  "sync.start",
  "sync.cancel",
  "sync.status",
] as const;
