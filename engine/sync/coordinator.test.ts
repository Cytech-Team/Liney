import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineyDatabase } from "../database";
import { SyncCoordinator } from "./coordinator";

describe("SyncCoordinator account scoping", () => {
  test("writes sync state to the active account instead of shared default", async () => {
    const directory = mkdtempSync(join(tmpdir(), "liney-sync-account-test-"));
    const db = new LineyDatabase(join(directory, "liney.sqlite"));
    let accountId = "account:test-1";
    db.upsertAccount(accountId, { mid: "u1", displayName: "One" });
    db.upsertAccount("account:test-2", { mid: "u2", displayName: "Two" });
    const cached = { chats: null as unknown[] | null, friends: null as unknown[] | null,
      openChats: null as unknown[] | null, messages: new Map<string, unknown[]>() };
    const coordinator = new SyncCoordinator(db, () => {}, {
      currentAccountId: () => accountId,
      loadFriends: async () => [],
      loadChats: async () => [],
      loadOpenChats: async () => [],
      fetchTalk: async () => [],
      fetchOpen: async () => [],
      persistLists: () => {},
      persist: () => {},
      isHidden: () => false,
      warmImage: async () => {},
      getPreSynced: () => cached,
      setPreSynced: (next) => {
        if (next.chats !== undefined) cached.chats = next.chats;
        if (next.friends !== undefined) cached.friends = next.friends;
        if (next.openChats !== undefined) cached.openChats = next.openChats;
      },
    });
    try {
      await coordinator.startFull();
      expect(db.getSyncState("account:test-1", "account")?.status).toBe("ready");
      expect(db.getSyncState("default", "account")).toBeNull();
      accountId = "account:test-2";
      await coordinator.startFull();
      expect(db.getSyncState("account:test-2", "account")?.status).toBe("ready");
      expect(coordinator.status().state?.status).toBe("ready");
      coordinator.cancel();
      expect(db.getSyncState("account:test-2", "account")?.status).toBe("idle");
      expect(db.getSyncState("account:test-1", "account")?.status).toBe("ready");
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
