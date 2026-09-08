import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineyKeyring, SecureLineStorage, migrateLegacyCredentials, secretToolExecutableAvailable } from "./secure-storage";

const unavailableKeyring = {
  available: false,
  get: () => null,
  set: () => false,
  clear: () => false,
} as unknown as LineyKeyring;

describe("secure storage", () => {
  test("detects a present secret-tool even when it exits non-zero for no arguments", () => {
    const presentExecutable = (() => ({ error: undefined, status: 2, signal: null })) as unknown as typeof spawnSync;
    const missingExecutable = (() => ({ error: new Error("ENOENT"), status: null, signal: null })) as unknown as typeof spawnSync;
    expect(secretToolExecutableAvailable(presentExecutable)).toBe(true);
    expect(secretToolExecutableAvailable(missingExecutable)).toBe(false);
  });

  test("keeps refresh token in memory in session-only mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "liney-storage-test-"));
    const path = join(root, "linejs-session.json");
    const storage = new SecureLineStorage(path, unavailableKeyring);
    await storage.set("refreshToken", "refresh-secret");
    await storage.set("e2eeKeys:u-me", "encrypted-key-material");
    expect(await storage.get("refreshToken")).toBe("refresh-secret");
    expect(readFileSync(path, "utf8")).not.toContain("refresh-secret");
    expect(readFileSync(path, "utf8")).toContain("encrypted-key-material");
    expect(storage.sessionOnly).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("sanitizes legacy session and refuses plaintext auth migration without Wallet", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-migration-test-"));
    const sessionPath = join(root, "linejs-session.json");
    const authPath = join(root, "auth.json");
    writeFileSync(sessionPath, JSON.stringify({ refreshToken: "legacy-refresh", accessToken: "legacy-access", expire: 1 }), { mode: 0o644 });
    writeFileSync(authPath, JSON.stringify({ accessToken: "legacy-access", refreshToken: "legacy-refresh" }), { mode: 0o644 });
    chmodSync(sessionPath, 0o644);
    const result = migrateLegacyCredentials(root, unavailableKeyring);
    expect(result.credential).toBeNull();
    expect(readFileSync(sessionPath, "utf8")).not.toContain("legacy-refresh");
    expect(readFileSync(sessionPath, "utf8")).not.toContain("legacy-access");
    expect(() => readFileSync(authPath, "utf8")).toThrow();
    expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
  });

  test("removes nested access-token fields when opening an old session", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-session-sanitize-test-"));
    const path = join(root, "linejs-session.json");
    writeFileSync(path, JSON.stringify({
      expire: 123,
      auth: { accessToken: "nested-access", refreshToken: "nested-refresh" },
      reqseq: { "u-me": 4 },
    }), { mode: 0o644 });
    const storage = new SecureLineStorage(path, unavailableKeyring);
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain("nested-access");
    expect(persisted).not.toContain("nested-refresh");
    expect(persisted).toContain('"u-me": 4');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(storage.getAll().expire).toBe(123);
  });

  test("keeps future token-shaped storage keys out of the session file", async () => {
    const root = mkdtempSync(join(tmpdir(), "liney-secret-key-test-"));
    const path = join(root, "linejs-session.json");
    const storage = new SecureLineStorage(path, unavailableKeyring);
    await storage.set("accessToken", "process-only-access");
    await storage.set("nested", { token: "nested-secret", safe: true });
    expect(await storage.get("accessToken")).toBe("process-only-access");
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain("process-only-access");
    expect(persisted).not.toContain("nested-secret");
    expect(persisted).toContain('"safe": true');
  });
});
