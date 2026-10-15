import { BaseStorage, type Storage } from "./linejs/adapter";
import { resolveLineyMediaBinary } from "./native-sidecar";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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

const CREDENTIAL_KIND = "credential";
const REFRESH_KIND = "refresh-token";

type KeyringRunner = typeof spawnSync;

function runNativeKeyring(
  binary: string,
  args: string[],
  runner: KeyringRunner,
  input?: string,
): { ok: boolean; stdout: string } {
  const result = runner(binary, args, {
    ...(input !== undefined ? { input } : {}),
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.signal || result.status !== 0) {
    return { ok: false, stdout: "" };
  }
  return { ok: true, stdout: String(result.stdout ?? "").trim() };
}

export function nativeKeyringSidecarAvailable(
  binary = resolveLineyMediaBinary(),
  runner: KeyringRunner = spawnSync,
): boolean {
  if (!binary) return false;
  const result = runNativeKeyring(binary, ["--liney-keyring-probe"], runner);
  if (!result.ok) return false;
  try {
    return Boolean((JSON.parse(result.stdout) as { available?: unknown }).available);
  } catch {
    return false;
  }
}

export class LineyKeyring {
  readonly available: boolean;
  private readonly binary?: string;
  private readonly runner: KeyringRunner;

  constructor(
    binary = resolveLineyMediaBinary(),
    runner: KeyringRunner = spawnSync,
  ) {
    this.binary = binary;
    this.runner = runner;
    this.available = nativeKeyringSidecarAvailable(binary, runner);
  }

  get(kind: string): string | null {
    if (!this.available || !this.binary) return null;
    const result = runNativeKeyring(
      this.binary,
      ["--liney-keyring-get", "--kind", kind],
      this.runner,
    );
    if (!result.ok) return null;
    try {
      const parsed = JSON.parse(result.stdout) as { available?: unknown; value?: unknown };
      return parsed.available && typeof parsed.value === "string" ? parsed.value : null;
    } catch {
      return null;
    }
  }

  set(kind: string, value: string): boolean {
    if (!this.available || !this.binary || !value) return false;
    const result = runNativeKeyring(
      this.binary,
      ["--liney-keyring-set", "--kind", kind],
      this.runner,
      value,
    );
    if (!result.ok) return false;
    return this.get(kind) === value;
  }

  clear(kind: string): boolean {
    if (!this.available || !this.binary) return false;
    return runNativeKeyring(
      this.binary,
      ["--liney-keyring-clear", "--kind", kind],
      this.runner,
    ).ok;
  }
}

export type AuthCredential = {
  accessToken: string;
  refreshToken?: string;
  expire?: number;
};

export type CredentialPersistenceMode = "wallet" | "encrypted-file" | "session-only";

type EncryptedFallbackEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  tag: string;
  ciphertext: string;
};

const FALLBACK_AAD = Buffer.from("liney-credential-fallback-v1", "utf8");

export class LineyEncryptedFallback {
  readonly vaultPath: string;
  readonly keyPath: string;

  constructor(dataDir: string, configDir = dataDir) {
    this.vaultPath = join(dataDir, "credential-fallback.enc");
    this.keyPath = join(configDir, "credential-fallback.key");
    ensurePrivateDirectory(dataDir);
    ensurePrivateDirectory(configDir);
    this.hardenExistingFiles();
  }

  get usable(): boolean {
    if (existsSync(this.vaultPath) && !existsSync(this.keyPath)) return false;
    if (existsSync(this.keyPath)) return Boolean(this.readKey(false));
    return true;
  }

  get hasSecrets(): boolean {
    const secrets = this.readSecrets();
    return Boolean(secrets && Object.keys(secrets).length);
  }

  get(kind: string): string | null {
    const secrets = this.readSecrets();
    if (!secrets) return null;
    const value = secrets[kind];
    return typeof value === "string" && value ? value : null;
  }

  set(kind: string, value: string): boolean {
    if (!kind || !value) return false;
    const current = this.readSecrets();
    if (current === null) return false;
    const key = this.readKey(true);
    if (!key) return false;
    current[kind] = value;
    return this.writeSecrets(current, key);
  }

  clear(kind: string): boolean {
    const current = this.readSecrets();
    if (current === null) return false;
    delete current[kind];
    if (!Object.keys(current).length) {
      this.clearAll();
      return true;
    }
    const key = this.readKey(false);
    return Boolean(key && this.writeSecrets(current, key));
  }

  clearAll(): void {
    try { unlinkSync(this.vaultPath); } catch {}
    try { unlinkSync(this.keyPath); } catch {}
  }

  private hardenExistingFiles(): void {
    for (const path of [this.vaultPath, this.keyPath]) {
      if (!existsSync(path)) continue;
      try { chmodSync(path, 0o600); } catch {}
    }
  }

  private readKey(create: boolean): Buffer | null {
    if (existsSync(this.keyPath)) {
      try {
        const raw = readFileSync(this.keyPath, "utf8").trim();
        const key = Buffer.from(raw, "base64");
        if (key.length !== 32) return null;
        try { chmodSync(this.keyPath, 0o600); } catch {}
        return key;
      } catch {
        return null;
      }
    }

    if (!create || existsSync(this.vaultPath)) return null;

    const key = randomBytes(32);
    try {
      atomicWriteText(this.keyPath, key.toString("base64"), 0o600);
      return key;
    } catch {
      return null;
    }
  }

  private readSecrets(): Record<string, string> | null {
    if (!existsSync(this.vaultPath)) return {};
    const key = this.readKey(false);
    if (!key) return null;
    try {
      const envelope = JSON.parse(readFileSync(this.vaultPath, "utf8")) as Partial<EncryptedFallbackEnvelope>;
      if (
        envelope.version !== 1
        || envelope.algorithm !== "aes-256-gcm"
        || typeof envelope.nonce !== "string"
        || typeof envelope.tag !== "string"
        || typeof envelope.ciphertext !== "string"
      ) return null;

      const nonce = Buffer.from(envelope.nonce, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");
      if (nonce.length !== 12 || tag.length !== 16) return null;

      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(FALLBACK_AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      const value = JSON.parse(plaintext);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;

      const result: Record<string, string> = {};
      for (const [kind, secret] of Object.entries(value as Record<string, unknown>)) {
        if (typeof secret === "string" && secret) result[kind] = secret;
      }
      try { chmodSync(this.vaultPath, 0o600); } catch {}
      return result;
    } catch {
      return null;
    }
  }

  private writeSecrets(secrets: Record<string, string>, key: Buffer): boolean {
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(FALLBACK_AAD);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(secrets), "utf8"),
        cipher.final(),
      ]);
      const envelope: EncryptedFallbackEnvelope = {
        version: 1,
        algorithm: "aes-256-gcm",
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      atomicWriteJson(this.vaultPath, envelope, 0o600);
      return true;
    } catch {
      return false;
    }
  }
}

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

export function readCredentialFromFallback(fallback: LineyEncryptedFallback): AuthCredential | null {
  const raw = fallback.get(CREDENTIAL_KIND);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as JsonRecord;
    if (typeof value.accessToken !== "string" || !value.accessToken.trim()) return null;
    const refreshToken = fallback.get(REFRESH_KIND);
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

export function writeCredentialToFallback(
  fallback: LineyEncryptedFallback,
  credential: AuthCredential,
): boolean {
  const payload = JSON.stringify({
    accessToken: credential.accessToken,
    ...(credential.expire !== undefined ? { expire: credential.expire } : {}),
  });
  if (!fallback.set(CREDENTIAL_KIND, payload)) return false;
  if (credential.refreshToken && !fallback.set(REFRESH_KIND, credential.refreshToken)) {
    fallback.clear(CREDENTIAL_KIND);
    return false;
  }
  if (!credential.refreshToken) fallback.clear(REFRESH_KIND);
  return true;
}

export function clearCredentialFromFallback(fallback: LineyEncryptedFallback): void {
  fallback.clear(CREDENTIAL_KIND);
  fallback.clear(REFRESH_KIND);
}

export function migrateFallbackCredentialToWallet(
  keyring: LineyKeyring,
  fallback: LineyEncryptedFallback,
): { credential: AuthCredential | null; migrated: boolean } {
  const credential = readCredentialFromFallback(fallback);
  if (!credential) return { credential: null, migrated: false };
  if (!keyring.available) return { credential, migrated: false };
  if (!writeCredentialToWallet(keyring, credential)) return { credential, migrated: false };

  const verified = readCredentialFromWallet(keyring);
  if (!verified || verified.accessToken !== credential.accessToken) {
    return { credential, migrated: false };
  }
  fallback.clearAll();
  return { credential: verified, migrated: true };
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

export function atomicWriteText(path: string, value: string, mode = 0o600): void {
  ensurePrivateDirectory(dirname(path));
  const temp = path + ".tmp-" + process.pid + "-" + Date.now();
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, value, "utf8");
    try { fsyncSync(fd); } catch {}
  } finally {
    closeSync(fd);
  }
  try { chmodSync(temp, mode); } catch {}
  try {
    renameSync(temp, path);
    try { chmodSync(path, mode); } catch {}
  } catch (error) {
    try { unlinkSync(temp); } catch {}
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
  private readonly fallback: LineyEncryptedFallback;
  private memoryRefreshToken?: string;

  constructor(
    path: string,
    keyring = new LineyKeyring(),
    fallback = new LineyEncryptedFallback(dirname(path)),
  ) {
    super();
    this.path = path;
    this.keyring = keyring;
    this.fallback = fallback;
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

  get fallbackAvailable(): boolean {
    return this.fallback.usable;
  }

  get sessionOnly(): boolean {
    return !this.keyring.available && !this.fallback.usable && Boolean(this.memoryRefreshToken);
  }

  get persistenceMode(): CredentialPersistenceMode {
    // A populated fallback means the Wallet was unavailable or failed during
    // the current lifecycle, even if the initial startup probe said it was
    // available. Prefer the storage that actually owns the newest secret.
    if (this.fallback.hasSecrets) return "encrypted-file";
    if (this.keyring.available) return "wallet";
    if (this.fallback.usable) return "encrypted-file";
    return "session-only";
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
          this.fallback.clear(REFRESH_KIND);
        } else if (this.keyring.set(REFRESH_KIND, token)) {
          this.memoryRefreshToken = token;
          this.fallback.clear(REFRESH_KIND);
        } else if (this.fallback.set(REFRESH_KIND, token)) {
          this.memoryRefreshToken = token;
        } else {
          this.memoryRefreshToken = token;
        }
        return;
      }
      if (SECRET_FIELD.test(key)) {
        // Keep future access/auth token keys process-local too. Current LINEJS
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
    if (key.toLowerCase() === "refreshtoken") {
      return this.memoryRefreshToken
        ?? this.keyring.get(REFRESH_KIND)
        ?? this.fallback.get(REFRESH_KIND)
        ?? undefined;
    }
    if (SECRET_FIELD.test(key)) return this.memorySecrets.get(key);
    return this.data[key];
  }

  async delete(key: string): Promise<void> {
    await this.withLock(async () => {
      if (key.toLowerCase() === "refreshtoken") {
        this.memoryRefreshToken = undefined;
        this.keyring.clear(REFRESH_KIND);
        this.fallback.clear(REFRESH_KIND);
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
      this.fallback.clearAll();
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

export function migrateLegacyCredentials(
  dataDir: string,
  keyring: LineyKeyring,
  fallback = new LineyEncryptedFallback(dataDir),
): {
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

  if (!accessToken) {
    if (legacySession) atomicWriteJson(sessionPath, safeSessionData(legacySession), 0o600);
    return { credential: null, migrated: false };
  }

  const credential: AuthCredential = {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expire !== undefined ? { expire } : {}),
  };
  let verified: AuthCredential | null = null;
  if (keyring.available && writeCredentialToWallet(keyring, credential)) {
    verified = readCredentialFromWallet(keyring);
  } else if (writeCredentialToFallback(fallback, credential)) {
    verified = readCredentialFromFallback(fallback);
  }
  if (!verified || verified.accessToken !== accessToken) {
    return { credential: null, migrated: false };
  }
  if (existsSync(authPath)) {
    try { unlinkSync(authPath); } catch { /* restore can still use the Wallet */ }
  }
  if (legacySession) {
    atomicWriteJson(sessionPath, safeSessionData(legacySession), 0o600);
  }
  return { credential: verified, migrated: true };
}

export function credentialPersistenceStatus(storage: SecureLineStorage): CredentialPersistenceMode {
  return storage.persistenceMode;
}
