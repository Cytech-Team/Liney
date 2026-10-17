import type { Client } from "@evex/linejs";

export function requireTalkGroupMid(value: unknown): string {
  if (typeof value !== "string" || !/^c[a-f0-9]{32}$/i.test(value)) {
    throw new TypeError("A LINE group MID is required");
  }
  return value;
}
export function requireFriendMid(value: unknown): string {
  if (typeof value !== "string" || !/^u[a-f0-9]{32}$/i.test(value)) {
    throw new TypeError("A LINE friend MID is required");
  }
  return value;
}
function displayName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new TypeError("Name must contain 1–100 characters");
  }
  return value.trim();
}
export async function renameGroup(client: Client, roomId: string, name: string) {
  const group = await client.getChat(requireTalkGroupMid(roomId));
  await group.updateName(displayName(name));
  return { id: roomId, name: name.trim() };
}
export async function inviteGroupFriends(client: Client, roomId: string, memberMids: unknown) {
  if (!Array.isArray(memberMids) || memberMids.length === 0 || memberMids.length > 20) {
    throw new TypeError("Select between 1 and 20 friends");
  }
  const mids = [...new Set(memberMids.map(requireFriendMid))];
  const group = await client.getChat(requireTalkGroupMid(roomId));
  await group.invite(mids);
  return { invited: mids.length };
}
export async function leaveGroup(client: Client, roomId: string) {
  const group = await client.getChat(requireTalkGroupMid(roomId));
  await group.leave();
  return { left: true };
}
export async function renameFriend(client: Client, friendId: string, name: string | null) {
  if (name !== null && (typeof name !== "string" || name.length > 100)) throw new TypeError("Invalid friend display name");
  const friend = await client.getUser(requireFriendMid(friendId));
  await friend.rename(name === null ? null : name.trim());
  return { renamed: true };
}
export async function setFriendFavorite(client: Client, friendId: string, favorite: unknown) {
  if (typeof favorite !== "boolean") throw new TypeError("favorite must be boolean");
  const friend = await client.getUser(requireFriendMid(friendId));
  await friend.setFavorite(favorite);
  return { favorite };
}
export async function setFriendMuted(client: Client, friendId: string, muted: unknown) {
  if (typeof muted !== "boolean") throw new TypeError("muted must be boolean");
  const friend = await client.getUser(requireFriendMid(friendId));
  await friend.setNotificationDisabled(muted);
  return { muted };
}
