import type { Chat } from "../data/mock";

/**
 * LINE's target-profile API does not consistently mark brand Official
 * Accounts as BOT, so keep the engine flag as the primary signal and cover
 * the LINE-branded and common Thai OA names used by the desktop client.
 * Unknown accounts can be tagged later without changing this heuristic.
 */
const LIKELY_OFFICIAL_NAME = /^(?:LINE\b|KBank\b|Thailand Post\b|Krungthai\b|Krungsri\b|Service Messages\b|MyCall\b|Gamestore\b|บิงช์\s*TODAY\b)|\bTODAY\b/i;

export function isLikelyBotChat(
  chat: Pick<Chat, "kind" | "name" | "isOfficialAccount">,
): boolean {
  if (chat.isOfficialAccount) return true;
  if (chat.kind !== "dm") return false;
  return LIKELY_OFFICIAL_NAME.test(String(chat.name ?? "").trim());
}
