import { BaseStorage, type Storage } from "@evex/linejs/storage";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type JsonRecord = Record<string, unknown>;
type StoredValue = Storage["Value"];

const KEYRING_APP = "liney";
const KEYRING_ACCOUNT = "default";
const CREDENTIAL_KIND = "credential";
const REFRESH_KIND = "refresh-token";

export function secretToolExecutableAvailable(runner: typeof spawnSync = spawnSync): boolean {
  // `secret-tool` does not provide a portable `--version` option. Some
  // distributions print usage and exit non-zero for it, which used to make a
  // working Secret Service look unavailable and silently forced every login
  // into session-only mode. Invoking it without arguments still lets
  // spawnSync distinguish a missing executable (`result.error`) from a
  // present executable; `probe()` below checks the actual D-Bus service.
  const result = runner("secret-tool", [], {
    encoding: "utf8",
    timeout: 2_500,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return !result.error && result.status !== null && !result.signal;
}

function secretTool(
  args: string[],
  input?: string,
  allowMissing = false,
): string | null {
  const result = spawnSync("secret-tool", args, {
    input,
    encoding: "utf8",
    timeout: 4_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.signal === "SIGTERM") {
    throw new Error("Secret Service is unavailable");
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "");
    if (allowMissing && /not found|no such item|could not find/i.test(stderr)) return null;
    throw new Error("Secret Service operation failed");
  }
  return String(result.stdout ?? "").trim() || null;
}

export class LineyKeyring {
  readonly available: boolean;

  constructor() {
    this.available = secretToolExecutableAvailable() && this.probe();
  }

  private probe(): boolean {
    try {
      // `search` returns 1 when no item exists, which is still a healthy
      // Secret Service. A transport/DBus failure contains a useful marker.
      const result = spawnSync(
        "secret-tool",
        ["search", "application", KEYRING_APP, "account", KEYRING_ACCOUNT],
        {
          encoding: "utf8",
          timeout: 4_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const stderr = String(result.stderr ?? "");
      return !result.error && !/cannot|failed|dbus|daemon|no such file/i.test(stderr);
    } catch {
      return false;
    }
  }

  get(kind: string): string | null {
    if (!this.available) return null;
    try {
      return secretTool(
        ["lookup", "application", KEYRING_APP, "account", KEYRING_ACCOUNT, "kind", kind],
        undefined,
        true,
      );
    } catch {
      return null;
    }
  }

  set(kind: string, value: string): boolean {
    if (!this.available) return false;
    try {
      secretTool(
        [
          "store",
          "--label=Liney credential",
          "application",
          KEYRING_APP,
          "account",
          KEYRING_ACCOUNT,
          "kind",
          kind,
        ],
        value,
      );
      return this.get(kind) === value;
    } catch {
      return false;
    }
  }

  clear(kind: string): boolean {
    if (!this.available) return false;
    try {
      secretTool(
        ["clear", "application", KEYRING_APP, "account", KEYRING_ACCOUNT, "kind", kind],
        undefined,
        true,
      );
      return true;
    } catch {
      return false;
    }
  }
}

export type AuthCredential = {
  accessToken: string;
  refreshToken?: string;
  expire?: number;
};

export function readCredentialFromWallet(keyring: LineyKeyring): AuthCredential | null {
  const raw = keyring.get(CREDENTIAL_KIND);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as JsonRecord;
    if (typeof value.accessToken !== "string" || !value.accessToken.trim()) return null;
    const refreshToken = keyring.get(REFRESH_KIND);
    return {
      accessToken: value.accessToken,
      ...(typeof refreshToken === "string"
        ? { refreshToken }
        : typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
      ...(typeof value.expire === "number" ? { expire: value.expire } : {}),
    };
  } catch {
    return null;
  }
}

export function writeCredentialToWallet(
  keyring: LineyKeyring,
  credential: AuthCredential,
): boolean {
  // Keep the rotating refresh token in its own Secret Service item. This
  // avoids copying it into the general credential record and keeps the
  // storage boundary explicit for future keyring adapters.
  const payload = JSON.stringify({
    accessToken: credential.accessToken,
    ...(credential.expire !== undefined ? { expire: credential.expire } : {}),
  });
  if (!keyring.set(CREDENTIAL_KIND, payload)) return false;
  if (credential.refreshToken && !keyring.set(REFRESH_KIND, credential.refreshToken)) {
    keyring.clear(CREDENTIAL_KIND);
    return false;
  }
  if (!credential.refreshToken) keyring.clear(REFRESH_KIND);
  return true;
}

export function clearCredentialFromWallet(keyring: LineyKeyring): void {
  keyring.clear(CREDENTIAL_KIND);
  keyring.clear(REFRESH_KIND);
}

const SECRET_FIELD = /^(refreshToken|accessToken|authToken|idToken|token|access_token|refresh_token)$/i;

function sanitizeStoredValue(value: unknown): { value: unknown; removed: boolean } {
  if (Array.isArray(value)) {
    let removed = false;
    const items = value.map((item) => {
      const result = sanitizeStoredValue(item);
      removed ||= result.removed;
      return result.value;
    });
    return { value: items, removed };
  }
  if (!value || typeof value !== "object") return { value, removed: false };
  let removed = false;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Tokens must never be put back on disk, even when migrating a session
    // written by an older Liney build. Apply this recursively because some
    // LINEJS versions nest auth material in a state object.
    if (SECRET_FIELD.test(key)) {
      removed = true;
      continue;
    }
    const result = sanitizeStoredValue(item);
    removed ||= result.removed;
    output[key] = result.value;
  }
  return { value: output, removed };
}

function safeSessionData(value: unknown): Record<string, StoredValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized = sanitizeStoredValue(value).value;
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, StoredValue>
    : {};
}

export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
}

export function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
  ensurePrivateDirectory(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    try { fsyncSync(fd); } catch { /* some virtual filesystems do not support fsync */ }
  } finally {
    closeSync(fd);
  }
  try { chmodSync(temp, mode); } catch { /* best effort */ }
  try {
    renameSync(temp, path);
    try { chmodSync(path, mode); } catch { /* best effort */ }
  } catch (error) {
    try { unlinkSync(temp); } catch { /* preserve original failure */ }
    throw error;
  }
}

export function readJsonFile(path: string): JsonRecord | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as JsonRecord
      : null;
  } catch {
    return null;
  }
}

export class SecureLineStorage extends BaseStorage {
  private data: Record<string, StoredValue>;
  private readonly memorySecrets = new Map<string, StoredValue>();
  private writeLock: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly keyring: LineyKeyring;
  private memoryRefreshToken?: string;

  constructor(path: string, keyring = new LineyKeyring()) {
    super();
    this.path = path;
    this.keyring = keyring;
    ensurePrivateDirectory(dirname(path));
    const legacy = readJsonFile(path);
    const sanitized = sanitizeStoredValue(legacy);
    this.data = safeSessionData(sanitized.value);
    // Sanitize legacy sessions immediately. This is intentionally done even
    // when Wallet is unavailable so a stale 0644 token cannot remain on disk.
    if (sanitized.removed) {
      this.persist();
    } else if (!existsSync(path)) {
      this.persist();
    } else {
      try { chmodSync(path, 0o600); } catch { /* best effort */ }
    }
  }

  get walletAvailable(): boolean {
    return this.keyring.available;
  }

  get sessionOnly(): boolean {
    return !this.keyring.available && Boolean(this.memoryRefreshToken);
  }

  get keyringInstance(): LineyKeyring {
    return this.keyring;
  }

  async set(key: string, value: StoredValue): Promise<void> {
    await this.withLock(async () => {
      if (key.toLowerCase() === "refreshtoken") {
        const token = typeof value === "string" ? value : "";
        if (!token) {
          this.memoryRefreshToken = undefined;
          this.keyring.clear(REFRESH_KIND);
        } else if (!this.keyring.set(REFRESH_KIND, token)) {
          // Session-only is allowed for this process, never persisted.
          this.memoryRefreshToken = token;
        } else {
          this.memoryRefreshToken = token;
        }
        return;
      }
      if (SECRET_FIELD.test(key)) {
        // Keep future access/auth token keys process-local too. LINEJS 3.3.2
        // does not write the access token through Storage, but this boundary
        // prevents a dependency upgrade from creating a plaintext secret file.
        if (value === null || value === undefined || value === "") this.memorySecrets.delete(key);
        else this.memorySecrets.set(key, value);
        return;
      }
      const sanitized = sanitizeStoredValue(value).value;
      if (sanitized === undefined) delete this.data[key];
      else this.data[key] = sanitized as StoredValue;
      this.persist();
    });
  }

  async get(key: string): Promise<StoredValue | undefined> {
    if (key.toLowerCase() === "refreshtoken") return this.memoryRefreshToken ?? this.keyring.get(REFRESH_KIND) ?? undefined;
    if (SECRET_FIELD.test(key)) return this.memorySecrets.get(key);
    return this.data[key];
  }

  async delete(key: string): Promise<void> {
    await this.withLock(async () => {
      if (key.toLowerCase() === "refreshtoken") {
        this.memoryRefreshToken = undefined;
        this.keyring.clear(REFRESH_KIND);
      } else if (SECRET_FIELD.test(key)) {
        this.memorySecrets.delete(key);
      } else {
        delete this.data[key];
        this.persist();
      }
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      this.data = {};
      this.memoryRefreshToken = undefined;
      this.memorySecrets.clear();
      clearCredentialFromWallet(this.keyring);
      this.persist();
    });
  }

  getAll(): Record<string, StoredValue> {
    return { ...this.data };
  }

  async migrate(storage: BaseStorage): Promise<void> {
    for (const [key, value] of Object.entries(this.data)) await storage.set(key, value);
  }

  private persist(): void {
    atomicWriteJson(this.path, this.data, 0o600);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.writeLock;
    this.writeLock = next;
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export function migrateLegacyCredentials(dataDir: string, keyring: LineyKeyring): {
  credential: AuthCredential | null;
  migrated: boolean;
} {
  const authPath = join(dataDir, "auth.json");
  const sessionPath = join(dataDir, "linejs-session.json");
  const legacyAuth = readJsonFile(authPath);
  const legacySession = readJsonFile(sessionPath);
  const accessToken = typeof legacyAuth?.accessToken === "string" ? legacyAuth.accessToken : "";
  const refreshToken = typeof legacyAuth?.refreshToken === "string"
    ? legacyAuth.refreshToken
    : typeof legacySession?.refreshToken === "string"
      ? legacySession.refreshToken
      : undefined;
  const expire = typeof legacyAuth?.expire === "number"
    ? legacyAuth.expire
    : typeof legacySession?.expire === "number"
      ? legacySession.expire
      : undefined;

  if (!accessToken || !keyring.available) {
    // Remove sensitive legacy files even when migration cannot persist yet.
    // The selected fallback policy is session-only: keeping an old access
    // token around would silently turn that fallback into plaintext storage.
    if (existsSync(authPath)) {
      try { unlinkSync(authPath); } catch { /* the next QR login can recover */ }
    }
    if (legacySession) {
      atomicWriteJson(sessionPath, safeSessionData(legacySession), 0o600);
    }
    return { credential: null, migrated: false };
  }

  const credential: AuthCredential = {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expire !== undefined ? { expire } : {}),
  };
  if (!writeCredentialToWallet(keyring, credential)) return { credential: null, migrated: false };

  // Verify from the Wallet before removing the plaintext legacy file.
  const verified = readCredentialFromWallet(keyring);
  if (!verified || verified.accessToken !== accessToken) return { credential: null, migrated: false };
  if (existsSync(authPath)) {
    try { unlinkSync(authPath); } catch { /* restore can still use the Wallet */ }
  }
  if (legacySession) {
    atomicWriteJson(sessionPath, safeSessionData(legacySession), 0o600);
  }
  return { credential: verified, migrated: true };
}

export function credentialPersistenceStatus(storage: SecureLineStorage): "wallet" | "session-only" {
  return storage.walletAvailable ? "wallet" : "session-only";
}
