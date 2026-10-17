import { describe, expect, test } from "bun:test";
import {
  fetchUsers, getFriendSyncDiagnostics, retryMissingFriendProfiles,
} from "./adapter";

const mid = (i: number) => `u${String(i).padStart(32, "0")}`;
const rawUser = (id: string) => ({ targetUserMid: id, profileName: `Friend ${id.slice(-3)}` });

describe("Friend Sync Diagnostics", () => {
  test("scans more than 300 friends without truncating, in batches of 50", async () => {
    let requests = 0;
    const batches: number[] = [];
    const ids = Array.from({ length: 320 }, (_, i) => mid(i));
    const client = {
      base: {
        relation: {
          getUserFriendIds: async () => { requests++; return { userFriendMids: ids }; },
          getContactsV3: async ({ mids }: { mids: string[] }) => {
            batches.push(mids.length);
            return { responses: mids.map(rawUser) };
          },
        },
      },
    } as never;
    const users = await fetchUsers(client);
    const diag = getFriendSyncDiagnostics(client);
    expect(users).toHaveLength(320);
    expect(requests).toBe(1);
    expect(batches).toEqual([50, 50, 50, 50, 50, 50, 20]);
    expect(diag).toMatchObject({
      discovered: 320, resolved: 320, unresolved: 0, viaV3: 320,
      batches: 7, phase: "complete",
    });
    expect(JSON.stringify(diag)).not.toContain(ids[0]);
  });

  test("uses one V3 attempt when unsupported, then recovers 241 contacts with V2", async () => {
    const ids = Array.from({ length: 241 }, (_, i) => mid(i));
    let v3Calls = 0;
    let v2Calls = 0;
    const client = { base: {
      relation: {
        getUserFriendIds: async () => ({ userFriendMids: ids }),
        getContactsV3: async () => { v3Calls++; throw new Error("API method not capable: getContactsV3"); },
      },
      talk: { getContactsV2: async ({ mids }: { mids: string[] }) => {
        v2Calls++;
        return { contacts: Object.fromEntries(mids.map(id => [id, { displayName: `User ${id.slice(-3)}` }])) };
      } },
    } } as never;
    const users = await fetchUsers(client);
    const report = getFriendSyncDiagnostics(client);
    expect(users).toHaveLength(241);
    expect(v3Calls).toBe(1);
    expect(v2Calls).toBe(5);
    expect(report).toMatchObject({ phase: "complete", discovered: 241, resolved: 241, unresolved: 0, viaV2: 241, batches: 6, unavailableEndpoints: ["Contacts V3"], errors: [] });
  });

  test("attributes an unknown V3 error to its endpoint, even if V2 recovers", async () => {
    const id = mid(8);
    const client = { base: {
      relation: {
        getUserFriendIds: async () => ({ userFriendMids: [id] }),
        getContactsV3: async () => { throw new Error("unclassified service error"); },
      },
      talk: { getContactsV2: async () => ({ contacts: { [id]: { displayName: "Recovered name" } } }) },
    } } as never;
    await fetchUsers(client);
    expect(getFriendSyncDiagnostics(client)).toMatchObject({ resolved: 1, unresolved: 0, errors: [{ category: "OTHER", source: "Contacts V3", count: 1 }] });
  });

  test("recovers after INVALID_LENGTH by splitting batches; counts errors", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => mid(i));
    const client = {
      base: { relation: {
        getUserFriendIds: async () => ({ userFriendMids: ids }),
        getContactsV3: async ({ mids }: { mids: string[] }) => {
          if (mids.length > 15) throw new Error("INVALID_LENGTH");
          return { responses: mids.map(rawUser) };
        },
      } },
    } as never;
    const users = await fetchUsers(client);
    const diag = getFriendSyncDiagnostics(client);
    expect(users).toHaveLength(60);
    expect(diag.resolved).toBe(60);
    expect(diag.splitBatches).toBeGreaterThan(0);
    expect(diag.errors.some(error => error.category === "BATCH_TOO_LARGE")).toBe(true);
  });

  test("retries only unresolved profiles without re-enumerating friend MIDs", async () => {
    const ids = [mid(1), mid(2), mid(3)];
    let found = 0;
    let allowLast = false;
    const requested: string[][] = [];
    const client = {
      base: { relation: {
        getUserFriendIds: async () => { found++; return { userFriendMids: ids }; },
        getContactsV3: async ({ mids }: { mids: string[] }) => {
          requested.push(mids);
          return { responses: mids.filter((id) => id !== ids[2] || allowLast).map(rawUser) };
        },
      } },
    } as never;
    const first = await fetchUsers(client);
    expect(first).toHaveLength(2);
    expect(getFriendSyncDiagnostics(client).unresolved).toBe(1);
    allowLast = true;
    const recovered = await retryMissingFriendProfiles(client);
    expect(recovered).toHaveLength(1);
    expect(requested.at(-1)).toEqual([ids[2]]);
    expect(found).toBe(1);
    expect(getFriendSyncDiagnostics(client)).toMatchObject({
      discovered: 3, resolved: 3, unresolved: 0, phase: "complete",
    });
    await expect(retryMissingFriendProfiles(client)).rejects.toThrow("FRIEND_SYNC_COOLDOWN");
  });

  test("uses V2 then individual getUser only for unresolved V3 contacts", async () => {
    const ids = [mid(10), mid(11), mid(12)];
    let individual = 0;
    const client = {
      base: {
        relation: {
          getUserFriendIds: async () => ({ userFriendMids: ids }),
          getContactsV3: async () => ({ responses: [rawUser(ids[0])] }),
        },
        talk: {
          getContactsV2: async ({ mids }: { mids: string[] }) => ({
            contacts: Object.fromEntries(mids.filter((id) => id === ids[1])
              .map((id) => [id, { displayName: "V2 User" }])),
          }),
        },
      },
      getUser: async (id: string) => { individual++; return { mid: id, raw: rawUser(id) }; },
    } as never;
    const users = await fetchUsers(client);
    expect(users).toHaveLength(3);
    expect(individual).toBe(1);
    expect(getFriendSyncDiagnostics(client)).toMatchObject({
      discovered: 3, resolved: 3, unresolved: 0,
      viaV3: 1, viaV2: 1, viaSingle: 1,
    });
  });

  test("shares concurrent scans instead of duplicating enumeration", async () => {
    const ids = [mid(51), mid(52)];
    let calls = 0;
    const client = {
      base: { relation: {
        getUserFriendIds: async () => {
          calls++;
          await new Promise(resolve => setTimeout(resolve, 10));
          return { userFriendMids: ids };
        },
        getContactsV3: async ({ mids }: { mids: string[] }) => ({ responses: mids.map(rawUser) }),
      } },
    } as never;
    const [left, right] = await Promise.all([fetchUsers(client), fetchUsers(client)]);
    expect(left).toHaveLength(2);
    expect(right).toHaveLength(2);
    expect(calls).toBe(1);
  });
});
