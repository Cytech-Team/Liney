/**
 * LineJsAdapter — isolates @evex/linejs behind a stable boundary.
 * UI/engine must not import "@evex/linejs" directly (AGENTS.md:4).
 * Future LINEJS API changes or replacements require changes only here.
 */
import { loginWithAuthToken, loginWithPassword, loginWithQR, SquareMessage, TalkMessage, type Client } from "@evex/linejs";
import { parseCancelCall, parseIncomingCall } from "@evex/linejs/call";

export const LINEJS_VERSION = "3.3.2";
export type LineClient = Client;

export const LineJsAdapter = {
  loginWithQR,
  loginWithPassword,
  loginWithAuthToken,
  TalkMessage,
  SquareMessage,
  parseIncomingCall,
  parseCancelCall,
  // Re-export version for RPC capabilities
  version: LINEJS_VERSION,
};

// Thin helpers to avoid spreading LINEJS types throughout engine
export async function getMyProfile(client: Client) {
  return client.getMyProfile();
}
export async function fetchJoinedChats(client: Client) {
  return client.fetchJoinedChats();
}
export async function fetchJoinedSquareChats(client: Client) {
  return client.fetchJoinedSquareChats();
}
export async function getUser(client: Client, mid: string) {
  return client.getUser(mid);
}
export async function getChat(client: Client, chatId: string) {
  return client.getChat(chatId);
}
