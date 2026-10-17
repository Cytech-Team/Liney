import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LineyEncryptedFallback,
  LineyKeyring,
  SecureLineStorage,
  migrateFallbackCredentialToWallet,
  migrateLegacyCredentials,
  nativeKeyringSidecarAvailable,
  readCredentialFromFallback,
  readCredentialFromWallet,
  writeCredentialToFallback,
} from "./secure-storage";

const unavailableKeyring = {
  available: false,
  get: () => null,
  set: () => false,
  clear: () => false,
} as unknown as LineyKeyring;

function createMemoryKeyring() {
  const values = new Map<string, string>();
  const keyring = {
    available: true,
    get: (kind: string) => values.get(kind) ?? null,
    set: (kind: string, value: string) => {
      values.set(kind, value);
      return true;
    },
    clear: (kind: string) => {
      values.delete(kind);
      return true;
    },
  } as unknown as LineyKeyring;
  return { keyring, values };
}

describe("secure storage", () => {
  test("detects the bundled native keyring backend directly", () => {
    const available = (() => ({
      error: undefined,
      status: 0,
      signal: null,
      stdout: '{"available":true}',
      stderr: "",
    })) as unknown as typeof spawnSync;
    const unavailable = (() => ({
      error: undefined,
      status: 0,
      signal: null,
      stdout: '{"available":false}',
      stderr: "",
    })) as unknown as typeof spawnSync;
    expect(nativeKeyringSidecarAvailable("/tmp/liney-media-test", available)).toBe(true);
    expect(nativeKeyringSidecarAvailable("/tmp/liney-media-test", unavailable)).toBe(false);
  });

  test("persists refresh token in AES-GCM fallback without plaintext", async () => {
    const root = mkdtempSync(join(tmpdir(), "liney-storage-test-"));
    const config = join(root, "config");
    const path = join(root, "linejs-session.json");
    const fallback = new LineyEncryptedFallback(root, config);
    const storage = new SecureLineStorage(path, unavailableKeyring, fallback);

    await storage.set("refreshToken", "refresh-secret");
    await storage.set("e2eeKeys:u-me", "encrypted-key-material");

    expect(await storage.get("refreshToken")).toBe("refresh-secret");
    expect(storage.persistenceMode).toBe("encrypted-file");
    expect(storage.sessionOnly).toBe(false);
    expect(readFileSync(path, "utf8")).not.toContain("refresh-secret");
    expect(readFileSync(path, "utf8")).toContain("encrypted-key-material");
    expect(readFileSync(fallback.vaultPath, "utf8")).not.toContain("refresh-secret");
    expect(readFileSync(fallback.keyPath, "utf8")).not.toContain("refresh-secret");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(fallback.vaultPath).mode & 0o777).toBe(0o600);
    expect(statSync(fallback.keyPath).mode & 0o777).toBe(0o600);

    const restarted = new SecureLineStorage(
      path,
      unavailableKeyring,
      new LineyEncryptedFallback(root, config),
    );
    expect(await restarted.get("refreshToken")).toBe("refresh-secret");
  });

  test("moves encrypted fallback into Wallet only after verification", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-fallback-wallet-test-"));
    const config = join(root, "config");
    const fallback = new LineyEncryptedFallback(root, config);
    expect(writeCredentialToFallback(fallback, {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expire: 123,
    })).toBe(true);

    const { keyring } = createMemoryKeyring();
    const result = migrateFallbackCredentialToWallet(keyring, fallback);
    expect(result.migrated).toBe(true);
    expect(result.credential?.accessToken).toBe("access-secret");
    expect(readCredentialFromWallet(keyring)?.refreshToken).toBe("refresh-secret");
    expect(existsSync(fallback.vaultPath)).toBe(false);
    expect(existsSync(fallback.keyPath)).toBe(false);
  });

  test("migrates plaintext legacy auth into encrypted fallback when Wallet is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-migration-test-"));
    const config = join(root, "config");
    const fallback = new LineyEncryptedFallback(root, config);
    const sessionPath = join(root, "linejs-session.json");
    const authPath = join(root, "auth.json");
    writeFileSync(
      sessionPath,
      JSON.stringify({ refreshToken: "legacy-refresh", accessToken: "legacy-access", expire: 1 }),
      { mode: 0o644 },
    );
    writeFileSync(
      authPath,
      JSON.stringify({ accessToken: "legacy-access", refreshToken: "legacy-refresh" }),
      { mode: 0o644 },
    );
    chmodSync(sessionPath, 0o644);

    const result = migrateLegacyCredentials(root, unavailableKeyring, fallback);
    expect(result.migrated).toBe(true);
    expect(result.credential?.accessToken).toBe("legacy-access");
    expect(readCredentialFromFallback(fallback)?.refreshToken).toBe("legacy-refresh");
    expect(readFileSync(fallback.vaultPath, "utf8")).not.toContain("legacy-access");
    expect(readFileSync(fallback.vaultPath, "utf8")).not.toContain("legacy-refresh");
    expect(readFileSync(sessionPath, "utf8")).not.toContain("legacy-refresh");
    expect(readFileSync(sessionPath, "utf8")).not.toContain("legacy-access");
    expect(() => readFileSync(authPath, "utf8")).toThrow();
    expect(statSync(sessionPath).mode & 0o777).toBe(0o600);
  });

  test("refuses to overwrite an encrypted vault if its key disappeared", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-fallback-corrupt-test-"));
    const config = join(root, "config");
    const fallback = new LineyEncryptedFallback(root, config);
    writeFileSync(fallback.vaultPath, '{"version":1,"ciphertext":"existing"}', { mode: 0o600 });
    const before = readFileSync(fallback.vaultPath, "utf8");

    expect(fallback.usable).toBe(false);
    expect(fallback.set("credential", "new-secret")).toBe(false);
    expect(readFileSync(fallback.vaultPath, "utf8")).toBe(before);
    expect(existsSync(fallback.keyPath)).toBe(false);
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
