import { describe, expect, test } from "bun:test";
import { requireTalkGroupMid, requireFriendMid, renameGroup, inviteGroupFriends, leaveGroup, renameFriend, setFriendFavorite, setFriendMuted } from "./social";

const chatId = `c${"a".repeat(32)}`;
const mid = `u${"b".repeat(32)}`;

function fakeClient() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const client = {
    getChat: async (id: string) => {
      calls.push({ method: "getChat", args: id });
      return {
        updateName: async (value: unknown) => { calls.push({ method: "updateName", args: value }); },
        invite: async (value: unknown) => { calls.push({ method: "invite", args: value }); },
        leave: async () => { calls.push({ method: "leave", args: null }); },
      };
    },
    getUser: async (id: string) => {
      calls.push({ method: "getUser", args: id });
      return {
        rename: async (v: unknown) => { calls.push({ method: "rename", args: v }); },
        setFavorite: async (v: unknown) => { calls.push({ method: "favorite", args: v }); },
        setNotificationDisabled: async (v: unknown) => { calls.push({ method: "mute", args: v }); },
      };
    },
  } as any;
  return { client, calls };
}

describe("LINE group and friend commands", () => {
  test("does not allow invalid group or friend mids", () => {
    expect(() => requireTalkGroupMid("../room")).toThrow();
    expect(() => requireTalkGroupMid(mid)).toThrow();
    expect(() => requireFriendMid(chatId)).toThrow();
    expect(requireTalkGroupMid(chatId)).toBe(chatId);
  });
  test("renames and invites real group via high-level LINEJS Chat", async () => {
    const { client, calls } = fakeClient();
    await renameGroup(client, chatId, " Team ");
    await inviteGroupFriends(client, chatId, [mid, mid]);
    expect(calls.map((entry) => entry.method)).toEqual(["getChat", "updateName", "getChat", "invite"]);
    expect(calls[1].args).toBe("Team");
    expect(calls[3].args).toEqual([mid]);
    await expect(inviteGroupFriends(client, chatId, [])).rejects.toThrow();
  });
  test("leaving a group is a separate, explicit command", async () => {
    const { client, calls } = fakeClient();
    await leaveGroup(client, chatId);
    expect(calls.map((entry) => entry.method)).toEqual(["getChat", "leave"]);
  });
  test("friend rename, favorite and mute call LINEJS service", async () => {
    const { client, calls } = fakeClient();
    await renameFriend(client, mid, "Buddy");
    await setFriendFavorite(client, mid, true);
    await setFriendMuted(client, mid, false);
    expect(calls.map((entry) => entry.method)).toEqual(["getUser", "rename", "getUser", "favorite", "getUser", "mute"]);
    await expect(setFriendFavorite(client, mid, "true")).rejects.toThrow();
  });
});
