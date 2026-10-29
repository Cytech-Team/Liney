import { bindClientStorage, createTemporaryQrStorage, getTargetProfiles, LineJsAdapter, parseE2EEKeyData, type LineClient, type LineyPollingSession } from "./linejs/adapter";
import { presentOwnProfile } from "./linejs/profile-display";
// Keep all LINEJS values behind the adapter boundary. This makes replacing the
// protocol implementation a local engine change instead of a repository-wide
// import migration.
const {
  loginWithPassword,
  loginWithBrandedQR,
  loginWithAuthToken,
  createSquareMessage,
  createTalkMessage,
  fetchMessageAsset,
  fromRawTalk,
  parseCancelCall,
  parseIncomingCallForClient,
} = LineJsAdapter;
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { rename as renameAsync, rm as rmAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parentPort } from "node:worker_threads";
import { runFallbackPolling } from "./events/fallback-polling";
import { OrderedOperationDispatcher, talkOperationIdentity, squareOperationIdentity } from "./events/ordered-operation-dispatcher";
import { PUSH_STARTUP_GRACE_MS, shouldUsePollingFallback } from "./events/push-health";
import {
  SYSTEM_ACCOUNT_EVENT_THROTTLE_MS,
  SYSTEM_ACCOUNT_MISSING_BASELINE_CURSOR,
  SYSTEM_ACCOUNT_RECONCILE_INTERVAL_MS,
  shouldRecordMissingSystemAccountBaseline,
  systemAccountMessageBoxLimit,
} from "./events/system-account-policy";
import { eventTransportPolicy } from "./events/transport-policy";
import { CallManager } from "./call-manager";
import { LineyDatabase, type DatabaseChat, type DatabaseMessage, type OutboxRecord } from "./database";
import { LineyMediaCache } from "./media-cache";
import { decodeMediaBase64, MediaWorker } from "./media-worker";
import { detectImageMime, normalizeImageBlob } from "./media-format";
import {
  LineyEncryptedFallback,
  LineyKeyring,
  SecureLineStorage,
  credentialPersistenceStatus,
  ensurePrivateDirectory,
  migrateFallbackCredentialToWallet,
  migrateLegacyCredentials,
  readCredentialFromFallback,
  readCredentialFromWallet,
  type AuthCredential,
  type CredentialPersistenceMode,
  writeCredentialToFallback,
  writeCredentialToWallet,
} from "./secure-storage";
import {
  echoMatches,
  isRetryableError,
  isUncertainSendError,
  messageFingerprint,
  retryDelayMs,
} from "./outbox";
import {
  LINE_SYSTEM_ACCOUNT_MID,
  talkMessageBoxHistoryState,
  talkMessageBoxId,
} from "./talk-history";
import { flexAltText, parseFlexMessage } from "./flex";
import { parseRichMessage } from "./rich";
import { richAssetAuthHeaders } from "./rich-asset";
import { callHistoryPreview, parseCallHistory } from "./call-history";
import { canonicalTalkOperationType, isLineServiceChatOperation } from "./talk-operation";
import { talkReadStateForMessages } from "./talk-read-state";
import { normalizeJsonValue } from "./serialization";
import { stickerUrlFromRaw } from "./sticker";
import { ownedStickersFromPurchases } from "./sticker-catalog";
import { StickerCatalogCache } from "./sticker-catalog-cache";
import { SyncCoordinator } from "./sync/coordinator";
import { PROTOCOL_VERSION } from "./protocol/protocol";

const LINEJS_VERSION = LineJsAdapter.version;
let ACCOUNT_ID = "default";
process.umask(0o077);
let client: LineClient | null = null;
let loginInFlight = false;
let authGeneration = 0;
let listenerAbort: AbortController | null = null;
let currentProfile: any = null;
let pushHealthy = false;
let pushConnectedSince = 0;
let pushFallbackNotBefore = 0;
const mediaPreviewCache = new Map<string, string>();
const messageMediaSourceCache = new Map<string, { raw: any; isSquare: boolean }>();
const preSyncedMessages = new Map<string, any[]>();
const MEDIA_PREVIEW_MEMORY_LIMIT = 48;
const MESSAGE_MEDIA_SOURCE_LIMIT = 420;
const TALK_MESSAGE_BOX_CACHE_LIMIT = 500;
const MESSAGE_LIST_RESULT_LIMIT = 100;
const LINK_PREVIEW_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
const LINK_PREVIEW_CACHE_VERSION = 4;
const LINK_PREVIEW_FAILURE_TTL_MS = 5 * 60_000;
const LINK_PREVIEW_CACHE_MAX_ENTRIES = 400;
const linkPreviewInflight = new Map<string, Promise<Record<string, unknown>>>();
const linkPreviewFailureUntil = new Map<string, number>();
const PERSISTENT_CACHE_MAX_PER_CHAT = 180;
const PERSISTENT_CACHE_MAX_TOTAL = 12_000;
const PERSISTENT_CACHE_KEEP_PER_CHAT = 12;
const PERSISTENT_CACHE_PRUNE_INTERVAL_MS = 5 * 60_000;
const MESSAGE_CACHE_ENRICH_TTL_MS = 10 * 60_000;
const messageCacheEnrichInFlight = new Map<string, Promise<void>>();
const messageCacheEnrichedAt = new Map<string, number>();

function trimMapOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const first = map.keys().next().value as K | undefined;
    if (first === undefined) break;
    map.delete(first);
  }
}

function rememberMediaPreview(key: string, dataUrl: string): void {
  mediaPreviewCache.delete(key);
  mediaPreviewCache.set(key, dataUrl);
  trimMapOldest(mediaPreviewCache, MEDIA_PREVIEW_MEMORY_LIMIT);
}

function clientOsLabel(): string {
  const explicit = String(process.env.LINEY_CLIENT_LABEL ?? process.env.LINEY_CLIENT_OS ?? "").trim();
  if (explicit) return explicit;
  try {
    const osRelease = readFileSync("/etc/os-release", "utf8");
    const pretty = osRelease.match(/^PRETTY_NAME=(.*)$/m)?.[1] ?? osRelease.match(/^NAME=(.*)$/m)?.[1] ?? "";
    const value = pretty.replace(/^['"]|['"]$/g, "").replace(/\s+Linux$/i, "").trim();
    if (value) return value.split(/\s+/).slice(0, 2).join(" ");
  } catch {
    // Best effort only; fall through to generic Linux.
  }
  return process.platform === "linux" ? "Linux" : process.platform;
}

function safeClientLabel(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._ -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32);
  return normalized || "Linux";
}

function clientIdentity() {
  const platform = safeClientLabel(clientOsLabel());
  const channel = safeClientLabel(String(process.env.LINEY_CLIENT_CHANNEL ?? "Linux"));
  const suffix = safeClientLabel(String(process.env.LINEY_CLIENT_SUFFIX ?? platform));
  const displayName = `Liney-${suffix}`;
  return {
    displayName,
    modelName: displayName,
    systemName: `Liney-${channel}`,
    platform,
    channel,
    device: "DESKTOPWIN" as const,
  };
}
const liveMessageOverlayKeys = new Set<string>();
let preSyncedChats: any[] | null = null;
let preSyncedFriends: any[] | null = null;
let preSyncedOpenChats: any[] | null = null;
type ChatListRefreshKind = "talk" | "friends" | "openchat";
const chatListRefreshGeneration: Record<ChatListRefreshKind, number> = { talk: 0, friends: 0, openchat: 0 };
type ChatListLoader = (persist?: boolean, canPersist?: () => boolean) => Promise<any[]>;
const talkMessageBoxCache = new Map<string, any>();
let systemAccountTrackInFlight: Promise<void> | null = null;
let lastSystemAccountTrackAt = 0;
const SYSTEM_ACCOUNT_TRACK_KEY = "line-system-account-cursor";
type SenderIdentity = { id: string; name: string; avatarUrl: string; identityKey?: string; profileSnapshotTime?: number; profileFetchedAt?: number; displayNameOverride?: boolean; isOfficialAccount?: boolean; profileNameFromApi?: boolean };
const talkSenderCache = new Map<string, SenderIdentity>();
const talkSenderProfileChecked = new Map<string, number>();
const TALK_SENDER_PROFILE_REFRESH_INTERVAL_MS = 4 * 60_000;
const talkSenderResolutionCache = new Map<string, Promise<SenderIdentity | null>>();
// Keep negative group metadata lookups on a cooldown. LINE may retain history
// after group access has been revoked, and re-fetching every startup is wasteful.
const groupMetadataCheckedAt = new Map<string, number>();
const GROUP_METADATA_RETRY_MS = 5 * 60_000;
const squareSenderCache = new Map<string, SenderIdentity>();
let ownedStickerCache: { expiresAt: number; stickers: ReturnType<typeof ownedStickersFromPurchases> } | null = null;
const STICKER_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

function invalidateChatListRefreshes(): void {
  for (const kind of Object.keys(chatListRefreshGeneration) as ChatListRefreshKind[]) {
    chatListRefreshGeneration[kind] += 1;
  }
}

function refreshChatListInBackground(kind: ChatListRefreshKind, loader: ChatListLoader): void {
  const generation = ++chatListRefreshGeneration[kind];
  void loader(true, () => Boolean(client) && generation === chatListRefreshGeneration[kind]).then((fresh) => {
    if (!client || generation !== chatListRefreshGeneration[kind]) return;
    emit({ type: "event.chats.updated", kind, refreshGeneration: generation, chats: fresh });
  }).catch(() => undefined);
}

function shopResultAs<T extends Record<string, unknown>>(schema: string, value: unknown): T {
  const renamed = client ? LineJsAdapter.renameThrift(client, schema, value) : undefined;
  return renamed && typeof renamed === "object" ? renamed as T : {} as T;
}

function stickerIdsFromProductInfo(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  const candidates = [root.stickers, root.stickerList, root.stickerDetails];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.map((item) => {
      if (item && typeof item === "object") return String((item as Record<string, unknown>).id ?? (item as Record<string, unknown>).stickerId ?? "");
      return String(item ?? "");
    }).filter((id) => /^\d{1,30}$/.test(id));
  }
  return [];
}

async function stickerPackFromPublicMetadata(packageId: string, version: string) {
  const response = await fetch(`https://stickershop.line-scdn.net/stickershop/v1/product/${encodeURIComponent(packageId)}/android/productInfo.meta`, {
    signal: AbortSignal.timeout(10_000),
    headers: { "accept": "application/json" },
  });
  if (!response.ok) return [];
  const stickerIds = stickerIdsFromProductInfo(await response.json());
  return stickerIds.map((stickerId) => ({ packageId, stickerId, version, owned: true as const }));
}

async function listOwnedStickers(): Promise<ReturnType<typeof ownedStickersFromPurchases>> {
  if (!client) throw new Error("not authenticated");
  if (ownedStickerCache && ownedStickerCache.expiresAt > Date.now()) return ownedStickerCache.stickers;
  const cached = stickerCatalogCache.read();
  if (cached) {
    ownedStickerCache = { expiresAt: Date.now() + 5 * 60_000, stickers: cached };
    return cached;
  }
  const pageSize = 100;
  const stickers: ReturnType<typeof ownedStickersFromPurchases> = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  try {
    while (offset < total && offset < 2_000) {
      const page = await LineJsAdapter.request(client,
        [
          [11, 2, "stickershop"], [8, 3, offset], [8, 4, pageSize],
          [12, 5, [[11, 1, "th"], [11, 2, "TH"]]],
        ],
        "getOwnedProducts", 4, true, "/TSHOP4",
      ) as unknown;
      const result = shopResultAs<Record<string, unknown>>("ProductList", page);
      stickers.push(...ownedStickersFromPurchases(result));
      const records = Array.isArray(result.productList) ? result.productList : [];
      total = Math.max(0, Number(result.totalSize ?? records.length));
      if (!records.length) break;
      offset += records.length;
    }
  } catch (error) {
    // LINE's installed-products endpoint is not available on every desktop
    // session. Keep whatever was already fetched and try account summaries.
    console.warn("[sticker catalog] full inventory unavailable:", error instanceof Error ? error.message : String(error));
  }

  // A Shop product can provide only some sticker IDs (or no detail at all).
  // Query the account-owned package summaries independently and fill missing
  // packages from LINE's public product manifests. This never adds packs
  // merely observed in another person's chat.
  try {
    const summariesRaw = await LineJsAdapter.request(client,
      [[11, 2, "stickershop"], [8, 3, 0], [8, 4, 200], [12, 5, [[11, 1, "th"], [11, 2, "TH"]]]],
      "getOwnedProductSummaries", 4, true, "/TSHOP4",
    ) as unknown;
    const decoded = shopResultAs<{ productList?: unknown }>("ProductSummaryList", summariesRaw);
    const rawRecord = summariesRaw && typeof summariesRaw === "object" ? summariesRaw as Record<string, unknown> : {};
    const products = Array.isArray(decoded.productList) ? decoded.productList
      : Array.isArray(rawRecord.productList) ? rawRecord.productList
      : Array.isArray(rawRecord["1"]) ? rawRecord["1"] : [];
    const knownPackages = new Set(stickers.map((sticker) => sticker.packageId));
    const missing = new Map<string, string>();
    for (const entry of products) {
      if (!entry || typeof entry !== "object") continue;
      const data = entry as Record<string, unknown>;
      const packageId = String(data.id ?? data["1"] ?? "").trim();
      if (!/^\d{1,30}$/.test(packageId) || knownPackages.has(packageId)) continue;
      const version = String(data.latestVersion ?? data["21"] ?? "1").trim() || "1";
      missing.set(packageId, version);
    }
    const pending = [...missing.entries()];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(5, pending.length) }, async () => {
      while (cursor < pending.length) {
        const [packageId, version] = pending[cursor++];
        try {
          stickers.push(...await stickerPackFromPublicMetadata(packageId, version));
        } catch (error) {
          console.warn("[sticker catalog] package metadata failed:", packageId, error instanceof Error ? error.message : String(error));
        }
      }
    }));
  } catch (error) {
    if (!stickers.length) throw error; // Don't cache empty results as success.
    console.warn("[sticker catalog] summaries unavailable:", error instanceof Error ? error.message : String(error));
  }
  const unique = [...new Map(stickers.map((sticker) => [`${sticker.packageId}:${sticker.stickerId}`, sticker])).values()];
  stickerCatalogCache.write(unique, Date.now() + STICKER_CACHE_TTL_MS);
  ownedStickerCache = { expiresAt: Date.now() + 5 * 60_000, stickers: unique };
  return unique;
}

function forgetOwnedSticker(packageId: string, stickerId: string): void {
  if (!/^\d{1,30}$/.test(packageId) || !/^\d{1,30}$/.test(stickerId)) return;
  if (ownedStickerCache) {
    ownedStickerCache = {
      ...ownedStickerCache,
      stickers: ownedStickerCache.stickers.filter((item) => item.packageId !== packageId || item.stickerId !== stickerId),
    };
  }
  stickerCatalogCache.remove(packageId, stickerId);
}

function emit(payload: unknown) {
  const value = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (() => {
      const record = payload as Record<string, unknown>;
      if (typeof record.type === "string" && record.id === undefined) {
        const { type, ...eventPayload } = record;
        return { type, version: PROTOCOL_VERSION, payload: eventPayload };
      }
      return { version: PROTOCOL_VERSION, ...record };
    })()
    : payload;
  if (parentPort) parentPort.postMessage(value);
  else process.stdout.write(`${JSON.stringify(value)}\n`);
}

function dataPath() {
  const explicit = process.env.LINEY_DATA_DIR;
  return explicit || join(homedir(), ".local", "share", "liney");
}

function ensureDataDir() {
  ensurePrivateDirectory(dataPath());
}

function storagePath() {
  return join(dataPath(), "linejs-session.json");
}

function configPath() {
  const explicit = process.env.LINEY_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return explicit || join(base, "liney");
}

function databasePath() {
  return join(dataPath(), "liney.sqlite");
}

ensureDataDir();
const stickerCatalogCache = new StickerCatalogCache(join(dataPath(), "sticker-catalog-cache.json"));
const keyring = new LineyKeyring();
const credentialFallback = new LineyEncryptedFallback(dataPath(), configPath());
const fallbackMigration = migrateFallbackCredentialToWallet(keyring, credentialFallback);
const legacyMigration = migrateLegacyCredentials(dataPath(), keyring, credentialFallback);
const store = new SecureLineStorage(storagePath(), keyring, credentialFallback);
const database = new LineyDatabase(databasePath());
if (readCredential()) ACCOUNT_ID = database.latestAccountId() ?? ACCOUNT_ID;
// Recover names for cached direct chats from messages sent by that exact MID.
database.restorePlaceholderDmNamesFromHistory(ACCOUNT_ID);
// Upgrade saved sidebar previews from an old generic label to LINE ALT_TEXT.
database.restoreFlexPreviewsFromHistory(ACCOUNT_ID);
let lastPersistentCachePruneAt = 0;
function prunePersistentCache(force = false): void {
  const now = Date.now();
  if (!force && now - lastPersistentCachePruneAt < PERSISTENT_CACHE_PRUNE_INTERVAL_MS) return;
  lastPersistentCachePruneAt = now;
  try {
    database.pruneMessageCache(ACCOUNT_ID, {
      maxPerChat: PERSISTENT_CACHE_MAX_PER_CHAT,
      maxTotal: PERSISTENT_CACHE_MAX_TOTAL,
      keepPerChat: PERSISTENT_CACHE_KEEP_PER_CHAT,
    });
  } catch {
    // Cache pruning must never block startup or message persistence.
  }
}
prunePersistentCache(true);
const mediaDiskCache = new LineyMediaCache(join(dataPath(), "media"));
const mediaUploadTempDir = join(dataPath(), "media-upload-tmp");
let syncCoordinator: SyncCoordinator | null = null;
function getSyncCoordinator(): SyncCoordinator {
  if (syncCoordinator) return syncCoordinator;
  syncCoordinator = new SyncCoordinator(database, emit, {
    currentAccountId: () => ACCOUNT_ID,
    loadFriends: () => loadFriendsList(false),
    loadChats: () => loadChatsList(false),
    loadOpenChats: () => loadOpenChatList(false),
    loadCachedFriends: () => collapseTalkIdentityAliases(database.listChats(ACCOUNT_ID, "dm")),
    loadCachedChats: () => collapseTalkIdentityAliases(database.listChats(ACCOUNT_ID).filter((chat) => chat.kind !== "openchat")),
    loadCachedOpenChats: () => database.listChats(ACCOUNT_ID, "openchat"),
    persistLists: (friends, chats, openChats) => {
      database.upsertChats(ACCOUNT_ID, [...friends, ...chats, ...openChats] as DatabaseChat[]);
      const talkIdentities = [...friends, ...chats].filter((chat) => chat.kind !== "openchat");
      persistStableTalkIdentityAliases(talkIdentities);
      friends.splice(0, friends.length, ...collapseTalkIdentityAliases(friends));
      chats.splice(0, chats.length, ...collapseTalkIdentityAliases(chats));
    },
    fetchTalk: fetchTalkMessagesWithFallback,
    fetchOpen: fetchOpenChatMessagesNormalized,
    persist: persistNormalizedMessages,
    isHidden: (chatId, isSquare, messageId, kind) => database.isMessageHidden(ACCOUNT_ID, chatId, kind as any, messageId),
    isLiveOverlay: (cacheKey) => liveMessageOverlayKeys.has(cacheKey),
    warmImage: (id, square) => getImagePreviewDataUrl(id, square).then(() => undefined),
    getPreSynced: () => ({ chats: preSyncedChats, friends: preSyncedFriends, openChats: preSyncedOpenChats, messages: preSyncedMessages }),
    setPreSynced: (next) => {
      if (next.chats !== undefined) preSyncedChats = next.chats;
      if (next.friends !== undefined) preSyncedFriends = next.friends;
      if (next.openChats !== undefined) preSyncedOpenChats = next.openChats;
    },
  });
  return syncCoordinator;
}
const callManager = new CallManager((event) => emit({
  ...event,
  type: event.type === "call.incoming" ? "call.incoming" : `event.${event.type}`,
  ...(event.error ? { error: redactSecrets(event.error) } : {}),
}));

function redactSecrets(value: string): string {
  return value
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(?:Bearer\s+)?(?:accessToken|refreshToken|authToken|authorization)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\b(?:password|passwd)\s*[:=]\s*[^\s,;]+/gi, "password=[redacted]");
}

function errorInfo(error: unknown): { code: string; message: string; retryable: boolean } {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  const data = (error as { data?: { code?: unknown; e?: { code?: unknown } } } | null)?.data;
  const codeValue = String(data?.code ?? data?.e?.code ?? "");
  const normalizedMessage = message.toLowerCase();
  const isSenderKeyFailure =
    codeValue === "E2EE_UPDATE_SENDER_KEY"
    || codeValue === "83"
    || message.includes("E2EE_UPDATE_SENDER_KEY")
    || normalizedMessage.includes("invalid sender key")
    || normalizedMessage.includes("verified e2ee sender key");
  if (isSenderKeyFailure) {
    const requiresReconnect = normalizedMessage.includes("still rejects")
      || normalizedMessage.includes("reconnect this line account");
    return {
      code: "E2EE_SENDER_KEY_INVALID",
      message: requiresReconnect
        ? "LINE ยังปฏิเสธคีย์เข้ารหัสหลังต่ออายุแล้ว ต้องเชื่อมบัญชี LINE ใหม่ด้วย QR ก่อนส่งอีกครั้ง"
        : "LINE ปฏิเสธคีย์เข้ารหัสเดิม กด “ลองใหม่” เพื่อให้ Liney ต่ออายุคีย์ก่อนส่งอีกครั้ง",
      retryable: !requiresReconnect,
    };
  }
  const code = /not authenticated/i.test(message)
    ? "NOT_AUTHENTICATED"
    : /timed out|timeout/i.test(message)
      ? "TIMEOUT"
      : /unavailable/i.test(message)
        ? "UNAVAILABLE"
        : /unknown method/i.test(message)
          ? "UNKNOWN_METHOD"
          : /protocol version/i.test(message)
            ? "PROTOCOL_VERSION_UNSUPPORTED"
            : "ENGINE_ERROR";
  return { code, message, retryable: isRetryableError(error) };
}
const mediaWorker = new MediaWorker(
  (event) => emit(event),
  (error) => errorInfo(error),
);

function replyError(id: string, error: unknown): void {
  emit({ id, ok: false, error: errorInfo(error) });
}

function normalize(value: any): any {
  return normalizeJsonValue(value);
}

async function persistCredential(next: LineClient): Promise<CredentialPersistenceMode> {
  const refreshToken = await store.get("refreshToken");
  const expireValue = await store.get("expire");
  const credential: AuthCredential = {
    accessToken: LineJsAdapter.authToken(next),
    ...(typeof refreshToken === "string" ? { refreshToken } : {}),
    ...(typeof expireValue === "number" ? { expire: expireValue } : {}),
  };

  if (writeCredentialToWallet(keyring, credential)) {
    credentialFallback.clearAll();
    return "wallet";
  }

  if (writeCredentialToFallback(credentialFallback, credential)) {
    emit({
      type: "auth.persistence",
      mode: "encrypted-file",
      warning: "Secret Service unavailable; using Liney's encrypted local fallback until a Wallet becomes available",
    });
    return "encrypted-file";
  }

  emit({
    type: "auth.persistence",
    mode: "session-only",
    warning: "Credential persistence is unavailable; login will last for this process only",
  });
  return "session-only";
}

function readCredential(): AuthCredential | null {
  return readCredentialFromWallet(keyring)
    ?? readCredentialFromFallback(credentialFallback)
    ?? fallbackMigration.credential
    ?? legacyMigration.credential;
}

async function clearLocalSession() {
  authGeneration += 1;
  listenerAbort?.abort();
  listenerAbort = null;
  // Full sync is cancellable and must not continue writing the previous
  // account's in-memory/cache state after logout or during a new login.
  syncCoordinator?.cancel();
  invalidateChatListRefreshes();
  pushHealthy = false;
  pushConnectedSince = 0;
  pushFallbackNotBefore = 0;
  mediaWorker.cancelAll();
  client = null;
  currentProfile = null;
  mediaPreviewCache.clear();
  messageMediaSourceCache.clear();
  preSyncedMessages.clear();
  liveMessageOverlayKeys.clear();
  preSyncedChats = null;
  preSyncedFriends = null;
  preSyncedOpenChats = null;
  talkMessageBoxCache.clear();
  talkSenderCache.clear();
  talkSenderProfileChecked.clear();
  talkSenderResolutionCache.clear();
  groupMetadataCheckedAt.clear();
  squareSenderCache.clear();
  await callManager.stop("logged-out").catch(() => undefined);
  database.clearAccount(ACCOUNT_ID);
  await mediaDiskCache.clear();
  ownedStickerCache = null;
  stickerCatalogCache.clear();
  ACCOUNT_ID = "default";
  try {
    await store.clear();
  } catch {
    // Keep logout best-effort if the keyring daemon disappears mid-operation.
  }
}

function accountIdForMid(value: unknown): string | null {
  const mid = String(value ?? "").trim();
  return mid ? `account:${createHash("sha256").update(mid).digest("hex")}` : null;
}

async function activateAccount(profile: any): Promise<{ changed: boolean; migrated: boolean }> {
  const previous = ACCOUNT_ID;
  const mid = String(profile?.mid ?? "").trim();
  const derived = accountIdForMid(mid);
  if (!derived) return { changed: false, migrated: false };

  const known = database.findAccountIdByMid(mid);
  let next = known && known !== "default" ? known : derived;
  let migrated = false;
  if ((!known || known === "default") && previous === "default") {
    const legacy = database.getAccount("default");
    if (!legacy || !legacy.mid || legacy.mid === mid) {
      migrated = database.rekeyAccount("default", derived);
      next = derived;
    }
  }
  if (next !== previous) {
    listenerAbort?.abort();
    listenerAbort = null;
    syncCoordinator?.cancel();
    invalidateChatListRefreshes();
    mediaWorker.cancelAll();
    await callManager.stop("account-switched").catch(() => undefined);
    mediaPreviewCache.clear();
    messageMediaSourceCache.clear();
    preSyncedMessages.clear();
    liveMessageOverlayKeys.clear();
    preSyncedChats = null;
    preSyncedFriends = null;
    preSyncedOpenChats = null;
    talkMessageBoxCache.clear();
    talkSenderCache.clear();
    talkSenderProfileChecked.clear();
    talkSenderResolutionCache.clear();
    groupMetadataCheckedAt.clear();
    squareSenderCache.clear();
    ownedStickerCache = null;
    stickerCatalogCache.clear();
  }
  ACCOUNT_ID = next;
  return { changed: next !== previous, migrated };
}

function contentTypeCode(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  const names: Record<string, number> = {
    NONE: 0,
    IMAGE: 1,
    VIDEO: 2,
    AUDIO: 3,
    HTML: 4,
    PDF: 5,
    CALL: 6,
    STICKER: 7,
    PRESENCE: 8,
    GIFT: 9,
    GROUPBOARD: 10,
    APPLINK: 11,
    LINK: 12,
    CONTACT: 13,
    FILE: 14,
    LOCATION: 15,
    POSTNOTIFICATION: 16,
    RICH: 17,
    CHATEVENT: 18,
    MUSIC: 19,
    PAYMENT: 20,
    EXTIMAGE: 21,
    FLEX: 22,
  };
  return names[String(value ?? "NONE").toUpperCase()] ?? 0;
}

const REACTION_CODES: Record<string, number> = {
  UNDO: 1,
  NICE: 2,
  LOVE: 3,
  FUN: 4,
  AMAZING: 5,
  SAD: 6,
  OMG: 7,
};

function reactionTypeCode(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  return REACTION_CODES[text.toUpperCase()] ?? 0;
}

function reactionSummaries(rawReactions: unknown, selfMid = ""): Array<{ type: number; count: number; mine?: boolean }> {
  const counts = new Map<number, { count: number; mine: boolean }>();
  for (const raw of Array.isArray(rawReactions) ? rawReactions : []) {
    const value = raw && typeof raw === "object" ? raw as Record<string, any> : {};
    const type = reactionTypeCode(
      value.reactionType?.predefinedReactionType
        ?? value.reactionType
        ?? value.type,
    );
    if (type < 2 || type > 7) continue;
    const current = counts.get(type) ?? { count: 0, mine: false };
    current.count += 1;
    const reactor = midString(value.fromUserMid ?? value.from ?? value.reactor?.mid);
    current.mine = current.mine || Boolean(selfMid && reactor && reactor === selfMid);
    counts.set(type, current);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([type, value]) => ({ type, count: value.count, ...(value.mine ? { mine: true } : {}) }));
}

function squareReactionSummaries(status: unknown, selfMid = ""): Array<{ type: number; count: number; mine?: boolean }> {
  if (!status || typeof status !== "object") return [];
  const value = status as Record<string, any>;
  const counts = value.countByReactionType;
  const mineType = reactionTypeCode(value.myReaction?.type);
  return (counts && typeof counts === "object" ? Object.entries(counts) : [])
    .map(([type, count]) => ({
      type: reactionTypeCode(type),
      count: Number(count),
    }))
    .filter((item) => item.type >= 2 && item.type <= 7 && item.count > 0)
    .sort((left, right) => left.type - right.type)
    .map((item) => ({
      ...item,
      ...(item.type === mineType || (selfMid && value.myReaction?.reactor?.mid === selfMid && item.type === mineType)
        ? { mine: true }
        : {}),
    }));
}

function relatedMessageId(raw: any): string | undefined {
  return LineJsAdapter.replyTargetMessageId(raw);
}

function applyReactionToSummaries(rawReactions: unknown, type: number): Array<{ type: number; count: number; mine?: boolean }> {
  const current = Array.isArray(rawReactions)
    ? rawReactions
      .map((item: any) => ({
        type: reactionTypeCode(item?.type),
        count: Math.max(0, Number(item?.count ?? 0)),
        mine: Boolean(item?.mine),
      }))
      .filter((item) => item.type >= 2 && item.type <= 7 && item.count > 0)
    : [];
  const previous = current.find((item) => item.mine);
  if (type === REACTION_CODES.UNDO) {
    if (previous) previous.count -= 1;
  } else if (type >= 2 && type <= 7) {
    if (previous && previous.type !== type) previous.count -= 1;
    const next = current.find((item) => item.type === type);
    if (next) {
      if (!previous || previous.type !== type) next.count += 1;
      next.mine = true;
    } else {
      current.push({ type, count: 1, mine: true });
    }
  }
  return current
    .filter((item) => item.count > 0)
    .sort((left, right) => left.type - right.type)
    .map((item) => ({ type: item.type, count: item.count, ...(item.mine ? { mine: true } : {}) }));
}

type MediaObjectType = "image" | "video" | "audio" | "file";

function mediaObjectType(contentType: unknown, mime = ""): MediaObjectType {
  const code = contentTypeCode(contentType);
  if (code === 1) return "image";
  if (code === 2) return "video";
  if (code === 3) return "audio";
  if (code === 14) return "file";
  if (mime.toLowerCase().startsWith("image/")) return "image";
  if (mime.toLowerCase().startsWith("video/")) return "video";
  if (mime.toLowerCase().startsWith("audio/")) return "audio";
  return "file";
}

function mediaContentType(params: any, mime: string): number {
  const requested = contentTypeCode(params?.contentType);
  if ([1, 2, 3, 14].includes(requested)) return requested;
  const objectType = mediaObjectType(requested, mime);
  return objectType === "image" ? 1 : objectType === "video" ? 2 : objectType === "audio" ? 3 : 14;
}

function mediaFilename(raw: any): string | undefined {
  const metadata = raw?.contentMetadata ?? {};
  const value = metadata?.FILE_NAME ?? metadata?.fileName ?? metadata?.filename
    ?? metadata?.name ?? raw?.fileName ?? raw?.filename;
  const filename = String(value ?? "").trim();
  return filename || undefined;
}

function messageStickerUrl(message: any): string | undefined {
  return contentTypeCode(message?.contentType) === 7 ? stickerUrlFromRaw(message?.raw ?? message) : undefined;
}

function messageFlex(message: any): ReturnType<typeof parseFlexMessage> {
  return contentTypeCode(message?.contentType) === 22 ? parseFlexMessage(message?.raw ?? message) : undefined;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const image = await normalizeImageBlob(blob);
  const bytes = Buffer.from(await image.arrayBuffer());
  const mime = image.type || "image/jpeg";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function messageContentMetadata(raw: any): Record<string, unknown> {
  const value = raw?.contentMetadata;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Fall through to the ID-based OBS path.
    }
  }
  return {};
}

function httpsUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function downloadObsMessageData(messageId: string, isPreview: boolean, isSquare: boolean): Promise<Blob> {
  if (!client || !LineJsAdapter.authToken(client)) throw new Error("not authenticated");
  const response = await LineJsAdapter.fetch(
    client,
    LineJsAdapter.getMessageDataUrl(client, messageId, isPreview, isSquare),
    {
      headers: {
        accept: "image/*,application/octet-stream,*/*",
        "x-line-application": LineJsAdapter.systemType(client),
        "x-Line-access": LineJsAdapter.authToken(client),
      },
    },
  );
  if (!response.ok) throw new Error(`LINE media request failed (${response.status})`);
  return response.blob();
}

async function tryImageSource(
  source: () => Promise<Blob>,
  cacheable: boolean,
): Promise<{ blob: Blob; cacheable: boolean } | null> {
  try {
    const blob = await normalizeImageBlob(await source());
    return blob.size ? { blob, cacheable } : null;
  } catch {
    return null;
  }
}

async function fetchMessageMediaBlob(messageId: string, isSquare: boolean, chatId?: string): Promise<{ blob: Blob; cacheable: boolean }> {
  if (!client) throw new Error("not authenticated");
  const source = messageMediaSourceCache.get(`${isSquare ? "square" : "talk"}:${messageId}`);
  const persisted = database.getMessageSource(
    ACCOUNT_ID,
    messageId,
    chatId,
    isSquare ? "openchat" : undefined,
  );
  if (!source?.raw && persisted?.raw) rememberMessageMedia(persisted.raw, isSquare);

  let raw = source?.raw ?? persisted?.raw ?? {};
  if (!source?.raw && !persisted?.raw && chatId) {
    // Older databases did not persist the raw LINE payload. Recover the
    // message once from the room so its OBS/E2EE metadata can be cached for
    // subsequent restarts instead of leaving an image permanently blank.
    try {
      const recovered = isSquare
        ? await fetchOpenChatMessagesNormalized(chatId, 100)
        : await fetchTalkMessagesWithFallback(chatId, 100);
      const match = recovered.find((item: any) => String(item?.id ?? "") === messageId);
      if (match?.raw) {
        raw = match.raw;
        rememberMessageMedia(raw, isSquare);
        persistNormalizedMessages(chatId, isSquare, recovered);
      }
    } catch {
      // Continue with the normal message-id based OBS fallbacks below.
    }
  }
  const metadata = messageContentMetadata(raw);
  const contentType = contentTypeCode(raw?.contentType);

  // Some generations of LINE messages carry signed OBS URLs directly.
  const previewUrl = httpsUrl(metadata.PREVIEW_URL);
  if (previewUrl) {
    const result = await tryImageSource(() => fetchMessageAsset(client!, previewUrl), true);
    if (result) return result;
  }

  // RICH messages carry their composed image in DOWNLOAD_URL rather than the
  // normal OBS message object. Try it before message-id OBS fallbacks so old
  // RICH cards do not incur several guaranteed-failing media requests.
  if (contentType === 17) {
    const downloadUrl = httpsUrl(metadata.DOWNLOAD_URL);
    if (downloadUrl) {
      // OA Plus artwork may reject anonymous CDN requests (HTTP 403).
      // Only attach the LINE session to the exact official OA CDN host and
      // never forward headers across redirects. The URL comes from an actual
      // persisted LINE message belonging to the active account.
      const authHeaders = richAssetAuthHeaders(
        downloadUrl,
        LineJsAdapter.authToken(client!),
        LineJsAdapter.systemType(client!),
      );
      if (authHeaders) {
        const result = await tryImageSource(() => fetchMessageAsset(client!, downloadUrl, {
          headers: authHeaders,
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        }), true);
        if (result) return result;
      }
      const result = await tryImageSource(() => fetchMessageAsset(client!, downloadUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      }), true);
      if (result) return result;
    }
    throw new Error(`LINE rich media object ${messageId} is unavailable`);
  }

  // E2EE media cannot be read from /preview directly; decrypt the chunks.
  if (!isSquare && Array.isArray(raw?.chunks) && raw.chunks.length) {
    const result = await tryImageSource(async () => {
      const decrypted = await LineJsAdapter.downloadMediaByE2EE(client!, raw);
      if (!decrypted) throw new Error("LINE E2EE media is empty");
      return decrypted;
    }, false);
    if (result) return result;
  }

  // Normal Talk/OpenChat image preview path.
  const previewResult = await tryImageSource(
    () => downloadObsMessageData(messageId, true, isSquare),
    true,
  );
  if (previewResult) return previewResult;

  // Keep the SDK helper as a compatibility fallback for older LINE gateways.
  // Its object_info request can fail independently of the media request, so
  // the direct OBS request above must be attempted first.
  const sdkPreviewResult = await tryImageSource(async () => LineJsAdapter.downloadMessageData(client!, {
    messageId,
    isPreview: true,
    isSquare,
  }), true);
  if (sdkPreviewResult) return sdkPreviewResult;

  // A full OBS object is still useful as the inline image if preview is absent.
  const fullResult = await tryImageSource(
    () => downloadObsMessageData(messageId, false, isSquare),
    false,
  );
  if (fullResult) return fullResult;

  const sdkFullResult = await tryImageSource(async () => LineJsAdapter.downloadMessageData(client!, {
    messageId,
    isPreview: false,
    isSquare,
  }), false);
  if (sdkFullResult) return sdkFullResult;

  const downloadUrl = httpsUrl(metadata.DOWNLOAD_URL);
  if (downloadUrl) {
    const result = await tryImageSource(() => fetchMessageAsset(client!, downloadUrl), false);
    if (result) return result;
  }

  throw new Error(`LINE media object ${messageId} is unavailable`);
}

async function getImagePreviewDataUrl(messageId: string, isSquare: boolean, chatId?: string, forceRefresh = false): Promise<string> {
  if (!client) throw new Error("not authenticated");
  const key = `${isSquare ? "square" : "talk"}:${messageId}`;
  if (forceRefresh) {
    mediaPreviewCache.delete(key);
    await mediaDiskCache.remove(key);
    database.deleteMedia(ACCOUNT_ID, key);
  }
  const cached = mediaPreviewCache.get(key);
  if (cached) {
    mediaPreviewCache.delete(key);
    mediaPreviewCache.set(key, cached);
    return cached;
  }

  const diskMetadata = database.getMedia(ACCOUNT_ID, key);
  const diskCached = await mediaDiskCache.get(key, diskMetadata?.mime || "image/jpeg");
  if (diskCached) {
    try {
      const image = await normalizeImageBlob(new Blob([diskCached.bytes], { type: diskCached.mime }));
      const dataUrl = await blobToDataUrl(image);
      database.touchMedia(ACCOUNT_ID, key);
      rememberMediaPreview(key, dataUrl);
      return dataUrl;
    } catch {
      // A partial/corrupt cache entry must not permanently mask a good LINE
      // response. Remove both the file and its SQLite index before refetching.
      await mediaDiskCache.remove(key);
      database.deleteMedia(ACCOUNT_ID, key);
    }
  }

  const fetched = await fetchMessageMediaBlob(messageId, isSquare, chatId);
  const dataUrl = await blobToDataUrl(fetched.blob);
  if (fetched.cacheable) {
    const saved = await mediaDiskCache.put(key, fetched.blob);
    if (saved) database.saveMedia(ACCOUNT_ID, key, saved.path, saved.mime, saved.size);
  }
  rememberMediaPreview(key, dataUrl);
  return dataUrl;
}

function contentLabel(contentType: unknown) {
  switch (contentTypeCode(contentType)) {
    case 1: return "รูปภาพ";
    case 2: return "วิดีโอ";
    case 3: return "ข้อความเสียง";
    case 6: return "การโทร";
    case 7: return "สติกเกอร์";
    case 14: return "ไฟล์";
    case 15: return "ตำแหน่งที่ตั้ง";
    case 16: return "มีโพสต์ใหม่";
    case 17: return "Rich message";
    case 18: return "กิจกรรมในแชต";
    case 22: return "การ์ดข้อความ";
    default: return "";
  }
}

function parsePostNotification(raw: any) {
  const metadata = raw?.contentMetadata ?? {};
  const serviceType = String(metadata.serviceType ?? "").toUpperCase();
  const locKey = String(metadata.locKey ?? "").toUpperCase();
  if (serviceType === "AB") {
    const albumName = String(metadata.albumName ?? "อัลบั้ม").trim() || "อัลบั้ม";
    const action = locKey === "BA" ? "created" : locKey === "BT" ? "added" : "posted";
    return {
      kind: "album",
      action,
      title: albumName,
      body: action === "created" ? "สร้างอัลบั้ม" : action === "added" ? "เพิ่มรูปภาพในอัลบั้ม" : "อัปเดตอัลบั้ม",
      link: String(metadata.postEndUrl ?? ""),
    };
  }
  if (serviceType === "GB") {
    const body = String(metadata.text ?? "").trim();
    return {
      kind: "note",
      action: "posted",
      title: "โน้ต",
      body: body || "มีโพสต์ใหม่ในโน้ต",
      link: String(metadata.postEndUrl ?? ""),
    };
  }
  return null;
}

function postNotificationPreview(raw: any) {
  const card = parsePostNotification(raw);
  if (!card) return "มีโพสต์ใหม่";
  if (card.kind === "album") {
    const action = card.action === "created" ? "สร้างอัลบั้ม" : card.action === "added" ? "เพิ่มรูปในอัลบั้ม" : "อัปเดตอัลบั้ม";
    return `${action} · ${card.title}`;
  }
  return card.body || card.title;
}

function cdnUrl(pathOrHash: unknown) {
  const value = String(pathOrHash ?? "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://profile.line-scdn.net/${value.replace(/^\/+/, "")}`;
}

/**
 * The OBS talk profile endpoint is keyed by MID. Add LINE's current picture
 * status/path as a cache key so image edits invalidate the desktop image cache.
 */
function talkProfileImageVersion(...values: unknown[]): string {
  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("|")
    .slice(0, 256);
}

function talkProfileIdentityKey(value: unknown): string | undefined {
  const profileId = String(value ?? "").trim();
  return profileId
    ? `profile:${createHash("sha256").update(profileId).digest("hex")}`
    : undefined;
}

function talkProfileSnapshotTime(value: unknown): number | undefined {
  const snapshotTime = Number(value);
  return Number.isFinite(snapshotTime) && snapshotTime > 0 ? snapshotTime : undefined;
}

function talkProfileFetchedAtFrom(value: any): number {
  return Number(value?.profileFetchedAt ?? value?.raw?.profileFetchedAt ?? 0) || 0;
}

function talkProfileRefreshVersion(): string {
  return `refresh-${Math.floor(Date.now() / (5 * 60_000))}`;
}

function talkSenderProfileNeedsRefresh(mid: string): boolean {
  const checkedAt = talkSenderProfileChecked.get(mid) ?? 0;
  return Date.now() - checkedAt >= TALK_SENDER_PROFILE_REFRESH_INTERVAL_MS;
}

function markTalkSenderProfileChecked(mid: string): void {
  talkSenderProfileChecked.set(mid, Date.now());
}

function talkProfileRefreshAvatarUrl(value: unknown, version: unknown): string {
  const avatarUrl = String(value ?? "").trim();
  const cacheVersion = String(version ?? "").trim();
  if (!avatarUrl) return avatarUrl;
  try {
    const url = new URL(avatarUrl);
    const versions = [
      ...(url.searchParams.get("v") ?? "").split("|"),
      cacheVersion,
    ].map((part) => part.trim()).filter((part, index, all) => part && all.indexOf(part) === index);
    if (versions.length) {
      const combined = versions.join("|");
      url.searchParams.set(
        "v",
        combined.length <= 256
          ? combined
          : "sha256-" + createHash("sha256").update(combined).digest("hex"),
      );
    }
    return url.toString();
  } catch {
    return avatarUrl;
  }
}

function talkProfileImageUrl(mid: string, fallback?: unknown, picturePath?: unknown): string {
  const directPath = [picturePath, fallback].find((value) => {
    if (typeof value !== "string") return false;
    const candidate = value.trim();
    return candidate.length >= 16
      && !candidate.includes("|")
      && !/^refresh-/i.test(candidate)
      && !/^\d+$/.test(candidate);
  });
  if (directPath) return cdnUrl(directPath);

  const normalizedMid = String(mid ?? "").trim();
  if (/^u[0-9a-f]{32}$/i.test(normalizedMid)) {
    const version = typeof fallback === "string" || typeof fallback === "number"
      ? String(fallback).trim().slice(0, 256)
      : "";
    const cacheKey = version ? `?v=${encodeURIComponent(version)}` : "";
    return `https://obs.line-scdn.net/r/talk/p/${encodeURIComponent(normalizedMid)}${cacheKey}`;
  }
  return cdnUrl(fallback);
}

function midString(value: any): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (typeof value.id === "string") return value.id;
    if (typeof value.mid === "string") return value.mid;
  }
  return "";
}

function midTypeName(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) {
    return ["USER", "ROOM", "GROUP", "SQUARE", "SQUARE_CHAT", "SQUARE_MEMBER", "BOT", "SQUARE_THREAD"][value] ?? "";
  }
  return String(value ?? "").trim().toUpperCase();
}

function isBotTargetProfile(profile: any): boolean {
  const userType = profile?.userType;
  const normalized = String(userType ?? "").trim().toUpperCase();
  return userType === 2 || normalized === "2" || normalized === "BOT";
}

function finiteMessageTime(value: unknown): number {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : Date.now();
}

function usefulTalkName(value: unknown): string {
  const name = String(value ?? "").trim();
  return name && !["LINE User", "LINE Chat"].includes(name) ? name : "";
}

function talkProfileIdentity(mid: string, raw: any, isOfficialAccount = false): SenderIdentity {
  const detail = raw?.targetProfileDetail ?? raw?.contact ?? raw ?? {};
  const name = String(detail?.profileName ?? detail?.displayName ?? "LINE User").trim() || "LINE User";
  const profileSnapshotTime = talkProfileSnapshotTime(detail?.snapshotTimeMillis);
  const pictureVersion = talkProfileImageVersion(detail?.pictureStatus, detail?.picturePath, profileSnapshotTime);
  const picturePath = detail?.picturePath || detail?.pictureStatus;
  const avatarUrl = /^u[0-9a-f]{32}$/i.test(mid)
    ? talkProfileImageUrl(mid, pictureVersion || talkProfileRefreshVersion(), picturePath)
    : cdnUrl(picturePath);
  const identityKey = talkProfileIdentityKey(detail?.profileId);
  return {
    id: mid,
    name,
    avatarUrl,
    profileNameFromApi: Boolean(usefulTalkName(name)),
    ...(identityKey ? { identityKey } : {}),
    ...(profileSnapshotTime ? { profileSnapshotTime } : {}),
    ...(isOfficialAccount ? { isOfficialAccount: true } : {}),
  };
}

function talkContactIdentity(mid: string, contact: any): SenderIdentity {
  const root = contact && typeof contact === "object" ? contact : {};
  const detail = root?.contact && typeof root.contact === "object" ? root.contact : root;
  const profile = root?.targetProfileDetail
    ?? detail?.targetProfileDetail
    ?? root?.profile
    ?? detail?.profile
    ?? {};
  const displayNameOverride = String(detail?.displayNameOverridden || root?.displayNameOverridden || "").trim();
  const name = String(
    displayNameOverride
      || profile?.profileName
      || profile?.displayName
      || detail?.profileName
      || detail?.displayName
      || root?.profileName
      || root?.displayName
      || "LINE User",
  ).trim() || "LINE User";
  const profileSnapshotTime = talkProfileSnapshotTime(
    profile?.snapshotTimeMillis ?? detail?.snapshotTimeMillis ?? root?.snapshotTimeMillis,
  );
  const pictureVersion = talkProfileImageVersion(
    profile?.pictureStatus,
    profile?.picturePath,
    profileSnapshotTime,
    detail?.pictureStatus,
    detail?.picturePath,
    root?.pictureStatus,
    root?.picturePath,
  );
  const picturePath = profile?.picturePath
    || detail?.picturePath
    || root?.picturePath
    || profile?.pictureStatus
    || detail?.pictureStatus
    || root?.pictureStatus;
  const avatarUrl = /^u[0-9a-f]{32}$/i.test(mid)
    ? talkProfileImageUrl(mid, pictureVersion || talkProfileRefreshVersion(), picturePath)
    : cdnUrl(detail?.thumbnailUrl || root?.thumbnailUrl || picturePath);
  const identityKey = talkProfileIdentityKey(profile?.profileId ?? detail?.profileId ?? root?.profileId);
  return {
    id: mid,
    name,
    avatarUrl,
    profileNameFromApi: Boolean(usefulTalkName(name)),
    ...(identityKey ? { identityKey } : {}),
    ...(profileSnapshotTime ? { profileSnapshotTime } : {}),
    ...(displayNameOverride ? { displayNameOverride: true } : {}),
  };
}

async function resolveTalkSender(mid: string): Promise<SenderIdentity | null> {
  if (!client || !mid || !mid.startsWith("u")) return null;
  const cached = talkSenderCache.get(mid);
  if (cached && !talkSenderProfileNeedsRefresh(mid)) return cached;

  const rememberCandidate = (identity: SenderIdentity): SenderIdentity => {
    const current = talkSenderCache.get(mid);
    const name = usefulTalkName(identity.name)
      || usefulTalkName(current?.name)
      || String(identity.name || current?.name || "LINE User");
    const merged: SenderIdentity = {
      ...current,
      ...identity,
      id: mid,
      name,
      avatarUrl: identity.avatarUrl || current?.avatarUrl || "",
      identityKey: identity.identityKey || current?.identityKey,
      profileSnapshotTime: identity.profileSnapshotTime ?? current?.profileSnapshotTime,
      profileFetchedAt: identity.profileFetchedAt ?? current?.profileFetchedAt,
      profileNameFromApi: identity.profileNameFromApi ?? current?.profileNameFromApi,
      ...(identity.displayNameOverride || current?.displayNameOverride ? { displayNameOverride: true } : {}),
      ...(identity.isOfficialAccount || current?.isOfficialAccount ? { isOfficialAccount: true } : {}),
    };
    talkSenderCache.set(mid, merged);
    return merged;
  };

  try {
    const profiles = await getTargetProfiles(client, [mid]);
    markTalkSenderProfileChecked(mid);
    const [profile] = profiles;
    if (profile) {
      const identity = { ...talkProfileIdentity(mid, profile, isBotTargetProfile(profile)), profileFetchedAt: Date.now() };
      const candidate = rememberCandidate(identity);
      if (usefulTalkName(identity.name)) return candidate;
    }
  } catch {
    markTalkSenderProfileChecked(mid);
    // A failed batch profile lookup must not block the per-user contact fallbacks.
  }

  try {
    const user: any = await LineJsAdapter.getUser(client, mid);
    const identity = { ...talkProfileIdentity(mid, user?.raw), profileFetchedAt: Date.now() };
    const candidate = rememberCandidate(identity);
    if (usefulTalkName(identity.name)) return candidate;
  } catch {
    // Continue through Talk contact fallbacks for non-friend group members.
  }
  try {
    const response: any = await LineJsAdapter.getContactsV2(client, { mids: [mid] });
    const contact = response?.contacts?.[mid]?.contact;
    if (contact) {
      const identity = { ...talkContactIdentity(mid, contact), profileFetchedAt: Date.now() };
      const candidate = rememberCandidate(identity);
      if (usefulTalkName(identity.name)) return candidate;
    }
  } catch {
    // Older / restricted desktop sessions can reject V2.
  }
  try {
    const contacts: any[] = await LineJsAdapter.getContacts(client, { mids: [mid] });
    const contact = contacts?.[0];
    if (contact) {
      const identity = { ...talkContactIdentity(mid, contact), profileFetchedAt: Date.now() };
      const candidate = rememberCandidate(identity);
      if (usefulTalkName(identity.name)) return candidate;
    }
  } catch {
    // Continue to the persisted, same-MID history fallback.
  }

  const current = talkSenderCache.get(mid);
  const fallback: SenderIdentity = {
    ...current,
    id: mid,
    name: database.getLatestPeerName(ACCOUNT_ID, mid) || usefulTalkName(current?.name) || "LINE User",
    avatarUrl: current?.avatarUrl || "",
    profileNameFromApi: current?.profileNameFromApi ?? false,
  };
  talkSenderCache.set(mid, fallback);
  return fallback;
}

function resolveTalkSenderInBackground(mid: string): Promise<SenderIdentity | null> {
  const pending = talkSenderResolutionCache.get(mid);
  if (pending) return pending;
  const resolution = resolveTalkSender(mid).finally(() => {
    if (talkSenderResolutionCache.get(mid) === resolution) talkSenderResolutionCache.delete(mid);
  });
  talkSenderResolutionCache.set(mid, resolution);
  return resolution;
}

async function resolveTalkIdentities(ids: string[]): Promise<Map<string, SenderIdentity>> {
  if (!client) return new Map();
  const unique = [...new Set(ids.filter((id) => id.startsWith("u")))];
  // A cache entry with a placeholder name is not a resolved profile.
  // Retry it after the existing cooldown rather than treating it as complete.
  const missing = unique.filter((id) =>
    !usefulTalkName(talkSenderCache.get(id)?.name)
    && talkSenderProfileNeedsRefresh(id)
  );

  // Resolve group participants in one RPC where possible. This is both faster
  // and more complete than getUser() for people who are not in the friend list.
  const contactBatches: string[][] = [];
  for (let start = 0; start < missing.length; start += 50) {
    contactBatches.push(missing.slice(start, start + 50));
  }
  while (contactBatches.length) {
    const mids = contactBatches.shift()!;
    try {
      const response: any = await LineJsAdapter.getContactsV2(client, { mids });
      for (const mid of mids) {
        const contact = response?.contacts?.[mid]?.contact;
        if (contact) {
          const incoming = talkContactIdentity(mid, contact);
          const current = talkSenderCache.get(mid);
          talkSenderCache.set(mid, {
            ...current,
            ...incoming,
            name: incoming.displayNameOverride
              ? incoming.name
              : usefulTalkName(incoming.name) || usefulTalkName(current?.name) || incoming.name,
            avatarUrl: incoming.avatarUrl || current?.avatarUrl || "",
            profileNameFromApi: Boolean(usefulTalkName(incoming.name)) || Boolean(current?.profileNameFromApi),
            profileFetchedAt: Date.now(),
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/INVALID_LENGTH|invalid length/i.test(message) && mids.length > 1) {
        const middle = Math.ceil(mids.length / 2);
        contactBatches.unshift(mids.slice(middle));
        contactBatches.unshift(mids.slice(0, middle));
      }
      // Missing profiles stay eligible for the individual and background fallbacks.
    }
  }

  // Official Accounts are returned as BOT target profiles even when the
  // normal user/contact endpoints hide their profile. Never re-query MIDs that
  // were already classified in this session; cache reads are a hot path.
  const uncheckedProfiles = unique.filter(talkSenderProfileNeedsRefresh);
  for (let start = 0; start < uncheckedProfiles.length; start += 50) {
    const mids = uncheckedProfiles.slice(start, start + 50);
    try {
      const profiles = await getTargetProfiles(client, mids);
      for (const profile of profiles) {
        const mid = midString(profile?.targetUserMid);
        if (!mid) continue;
        const current = talkSenderCache.get(mid);
        const isOfficialAccount = isBotTargetProfile(profile);
        const profileIdentity = talkProfileIdentity(mid, profile, isOfficialAccount);
        const profileFetchedAt = Date.now();
        const hasCurrentProfile = Boolean(usefulTalkName(profileIdentity.name))
          || Boolean(profileIdentity.avatarUrl)
          || profileIdentity.isOfficialAccount;
        if (usefulTalkName(profileIdentity.name)) markTalkSenderProfileChecked(mid);
        if (!hasCurrentProfile) continue;
        // snapshotTimeMillis describes the server snapshot and can lag or use a
        // different clock. A successful response is still the latest value we
        // have received, so it must replace the cached profile.
        talkSenderCache.set(mid, {
          id: mid,
          name: current?.displayNameOverride
            ? current.name
            : usefulTalkName(profileIdentity.name)
              ? profileIdentity.name
              : current?.name || profileIdentity.name,
          avatarUrl: profileIdentity.avatarUrl || current?.avatarUrl || "",
          identityKey: profileIdentity.identityKey || current?.identityKey,
          profileSnapshotTime: profileIdentity.profileSnapshotTime ?? current?.profileSnapshotTime,
          profileFetchedAt,
          profileNameFromApi: Boolean(usefulTalkName(profileIdentity.name)) || Boolean(current?.profileNameFromApi),
          ...(current?.displayNameOverride ? { displayNameOverride: true } : {}),
          ...(isOfficialAccount || current?.isOfficialAccount ? { isOfficialAccount: true } : {}),
        });
      }
    } catch {
      // Classification must never make a room disappear.
    }
  }
  await resolveIdentities(
    unique.filter((id) => !talkSenderCache.get(id)?.profileNameFromApi),
    resolveTalkSender,
  );
  return new Map(unique.flatMap((id) => {
    const identity = talkSenderCache.get(id);
    return identity ? [[id, identity] as const] : [];
  }));
}

async function resolveSquareSender(mid: string, fallbackName = ""): Promise<SenderIdentity | null> {
  if (!client || !mid || !mid.startsWith("p")) return null;
  const cached = squareSenderCache.get(mid);
  if (cached) return cached;
  try {
    const response: any = await LineJsAdapter.getSquareMember(client, { squareMemberMid: mid });
    const member = response?.squareMember ?? response ?? {};
    const identity = {
      id: mid,
      name: String(member?.displayName ?? fallbackName ?? "OpenChat member").trim() || "OpenChat member",
      avatarUrl: cdnUrl(member?.profileImageObsHash),
    };
    squareSenderCache.set(mid, identity);
    return identity;
  } catch {
    const fallback = { id: mid, name: fallbackName || "OpenChat member", avatarUrl: "" };
    squareSenderCache.set(mid, fallback);
    return fallback;
  }
}

async function resolveIdentities(
  ids: string[],
  resolver: (id: string) => Promise<SenderIdentity | null>,
  concurrency = 6,
): Promise<Map<string, SenderIdentity>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const result = new Map<string, SenderIdentity>();
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (cursor < unique.length) {
      const index = cursor++;
      const id = unique[index];
      const identity = await resolver(id);
      if (identity) result.set(id, identity);
    }
  });
  await Promise.all(workers);
  return result;
}

function displayMessageText(text: unknown, contentType: unknown, rawMessage?: unknown) {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const code = contentTypeCode(contentType);
  if (code === 6) return callHistoryPreview(parseCallHistory(rawMessage ?? { contentType, text }));
  if (code === 22) return flexAltText(rawMessage) || "การ์ดข้อความ";
  const internalTokens = new Set([
    "IMAGE", "VIDEO", "AUDIO", "CALL", "STICKER", "FILE", "LOCATION",
    "POSTNOTIFICATION", "CHATEVENT", "FLEX",
  ]);
  if (internalTokens.has(raw.toUpperCase())) return contentLabel(code) || "ข้อความใหม่";
  return raw || contentLabel(code) || "ข้อความใหม่";
}

// This is the same URI constructed by LINEJS's TalkMessage.announce()
// implementation. It is the fallback link for messages whose sender/profile
// data is hidden from the selfbot API (notably Official Accounts).
function officialLineMessageUrl(chatId: string, messageId: string): string {
  const params = new URLSearchParams({ chatId, messageId });
  return `line://nv/chatMsg?${params.toString()}`;
}

function compactPreview(text: unknown, contentType: unknown, rawMessage?: unknown) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const code = contentTypeCode(contentType);
  if (code === 6) return callHistoryPreview(parseCallHistory(rawMessage ?? { contentType, text }));
  if (code === 22) return flexAltText(rawMessage) || "การ์ดข้อความ";
  // LINEJS may surface the enum token itself as message.text for non-text
  // messages (for example POSTNOTIFICATION). Never show that internal token
  // directly in the UI; use a localized content label instead.
  const internalTokens = new Set([
    "IMAGE", "VIDEO", "AUDIO", "CALL", "STICKER", "FILE", "LOCATION",
    "POSTNOTIFICATION", "CHATEVENT", "FLEX",
  ]);
  if (internalTokens.has(clean.toUpperCase())) return contentLabel(code) || "ข้อความใหม่";
  return clean || contentLabel(code) || "ข้อความใหม่";
}


function mediaSourceKey(messageId: string, isSquare: boolean) {
  return `${isSquare ? "square" : "talk"}:${messageId}`;
}

function rememberMessageMedia(raw: any, isSquare: boolean) {
  const id = String(raw?.id ?? "");
  if (!id || ![1, 17].includes(contentTypeCode(raw?.contentType))) return;
  messageMediaSourceCache.delete(mediaSourceKey(id, isSquare));
  messageMediaSourceCache.set(mediaSourceKey(id, isSquare), { raw, isSquare });
  trimMapOldest(messageMediaSourceCache, MESSAGE_MEDIA_SOURCE_LIMIT);
}

async function loadTalkMessageBoxes(): Promise<any[]> {
  if (!client) throw new Error("not authenticated");
  try {
    // `activeOnly: true` hides old direct-message boxes. Those boxes still
    // contain readable history and are needed for a real full sync.
    const boxResult: any = await LineJsAdapter.getMessageBoxes(client, {
      messageBoxListRequest: {
        activeOnly: false,
        messageBoxCountLimit: systemAccountMessageBoxLimit("chat-list"),
        withUnreadCount: true,
        lastMessagesPerMessageBoxCount: 1,
        unreadOnly: false,
      },
    } as any);
    const boxes = Array.isArray(boxResult?.messageBoxes) ? boxResult.messageBoxes : [];
    talkMessageBoxCache.clear();
    for (const box of boxes) {
      const id = talkMessageBoxId(box);
      if (id) {
        talkMessageBoxCache.delete(id);
        talkMessageBoxCache.set(id, box);
        trimMapOldest(talkMessageBoxCache, TALK_MESSAGE_BOX_CACHE_LIMIT);
      }
    }
    return boxes;
  } catch {
    // A temporary metadata failure must not throw away the last known room
    // set. The per-room fetch path can refresh this cache on demand.
    return [...talkMessageBoxCache.values()];
  }
}

function talkBoxLastTime(box: any): number {
  const value = Number(box?.lastDeliveredMessageId?.deliveredTime ?? box?.lastMessages?.[0]?.createdTime ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function systemAccountCursor(box: any): { messageId: string; deliveredTime: number; unread: number } | null {
  if (talkMessageBoxId(box) !== LINE_SYSTEM_ACCOUNT_MID) return null;
  const messageId = String(box?.lastDeliveredMessageId?.messageId ?? "").trim();
  const deliveredTime = Number(box?.lastDeliveredMessageId?.deliveredTime ?? 0);
  if (!messageId || !Number.isFinite(deliveredTime) || deliveredTime <= 0) return null;
  return {
    messageId,
    deliveredTime,
    unread: Math.max(0, Number(box?.unreadCount ?? 0)),
  };
}

function hasTalkMessagePayload(raw: any): boolean {
  return (typeof raw?.text === "string" && raw.text.trim().length > 0)
    || (typeof raw?.contentPreview === "string" && raw.contentPreview.trim().length > 0)
    || raw?.hasContent === true
    || contentTypeCode(raw?.contentType) !== 0
    || (Array.isArray(raw?.chunks) && raw.chunks.length > 0);
}

async function ingestLineSystemMessage(
  next: LineClient,
  candidate: any,
  fromSystemAccountHistory = false,
): Promise<boolean> {
  const messageId = String(candidate?.id ?? "").trim();
  if (!messageId || !hasTalkMessagePayload(candidate)) return false;

  const from = midString(candidate?.from);
  const to = midString(candidate?.to);
  const belongsToSystemAccount = [from, to].some((mid) =>
    Boolean(mid) && canonicalTalkIdentityMid(mid) === LINE_SYSTEM_ACCOUNT_MID
  );
  if (!belongsToSystemAccount && (!fromSystemAccountHistory || (from && to))) return false;

  const existing = database.getMessage(ACCOUNT_ID, LINE_SYSTEM_ACCOUNT_MID, messageId);
  if (existing && !existing.raw?.lineySystemNotification) return true;

  const syntheticId = `line-system:${messageId}`;
  const placeholder = database.getMessage(ACCOUNT_ID, LINE_SYSTEM_ACCOUNT_MID, syntheticId);
  if (placeholder?.raw?.lineySystemNotification) {
    database.hideMessageForMe(ACCOUNT_ID, LINE_SYSTEM_ACCOUNT_MID, "dm", syntheticId);
    emit({
      type: "event.message.removed",
      source: "talk-system",
      chatId: LINE_SYSTEM_ACCOUNT_MID,
      messageId: syntheticId,
      scope: "local",
    });
  }

  let raw = candidate;
  try {
    raw = await LineJsAdapter.decryptE2EEMessage(next, candidate);
  } catch (error) {
    // Some LINE-managed notifications arrive already readable. Keep their
    // supplied content if decryption is unavailable, without inventing text.
    raw = candidate;
    const hasReadableText = [candidate?.text, candidate?.contentPreview]
      .some((value) => typeof value === "string" && value.trim().length > 0);
    if (!hasReadableText) {
      emit({
        type: "event.message.decode_error",
        source: "talk-system",
        error: errorInfo(error).message,
      });
    }
  }
  if (!raw || typeof raw !== "object") return false;
  if (!raw.text && contentTypeCode(raw.contentType) === 0 && raw.contentPreview) {
    raw = { ...raw, text: raw.contentPreview };
  }
  if (!raw.id) raw = { ...raw, id: messageId };
  if (!raw.from && from) raw = { ...raw, from };
  if (!raw.to && to) raw = { ...raw, to };
  if (fromSystemAccountHistory && !belongsToSystemAccount) {
    const selfMid = midString(LineJsAdapter.profileMid(next));
    const inferredFrom = from || LINE_SYSTEM_ACCOUNT_MID;
    const inferredTo = to || (from === selfMid ? LINE_SYSTEM_ACCOUNT_MID : selfMid);
    raw = {
      ...raw,
      from: inferredFrom,
      ...(inferredTo ? { to: inferredTo } : {}),
      ...(raw.toType === undefined ? { toType: "USER" } : {}),
    };
  }

  await handleTalkMessage(next, LineJsAdapter.createTalkMessage(next, raw), raw);
  return true;
}

async function recoverLineSystemMessages(next: LineClient, box: any, cursor: {
  messageId: string;
  deliveredTime: number;
  unread: number;
}): Promise<void> {
  const candidates = new Map<string, any>();
  const addCandidates = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const candidate of items) {
      const messageId = String((candidate as any)?.id ?? "").trim();
      if (messageId) candidates.set(messageId, candidate);
    }
  };
  addCandidates(box?.lastMessages);

  const hasLatestPayload = () => {
    const latest = candidates.get(cursor.messageId);
    return Boolean(latest && hasTalkMessagePayload(latest));
  };

  if (!hasLatestPayload()) {
    try {
      addCandidates(await LineJsAdapter.getRecentMessages(next, {
        messageBoxId: LINE_SYSTEM_ACCOUNT_MID,
        messagesCount: 20,
      }));
    } catch {
      // History access is best-effort for LINE-managed accounts.
    }
  }

  if (!hasLatestPayload() && ![...candidates.values()].some(hasTalkMessagePayload)) {
    const endMessageId = box?.lastDeliveredMessageId;
    if (endMessageId?.messageId !== undefined && endMessageId?.deliveredTime !== undefined) {
      try {
        addCandidates(await LineJsAdapter.getPreviousMessages(next, {
          request: {
            messageBoxId: LINE_SYSTEM_ACCOUNT_MID,
            endMessageId,
            messagesCount: 20,
            withReadCount: true,
            receivedOnly: false,
          },
          syncReason: "INTERNAL",
        }));
      } catch {
        // Some System Account history cursors have no message payload endpoint.
      }
    }
  }

  const ordered = [...candidates.values()]
    .filter(hasTalkMessagePayload)
    .sort((left, right) => {
      const timeDifference = Number(left?.createdTime ?? 0) - Number(right?.createdTime ?? 0);
      return timeDifference || String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
    });
  for (const candidate of ordered) {
    await ingestLineSystemMessage(next, candidate, true);
  }
}

const SYSTEM_ACCOUNT_BOX_DISCOVERY_FALLBACK_LIMIT = 500;

async function findLineSystemAccountBox(next: LineClient): Promise<{
  box: any | null;
  source: "exact-range" | "prefix-range" | "bounded-list" | "missing";
  count: number | null;
  limit: number;
  succeeded: boolean;
}> {
  const requests = [
    {
      source: "exact-range" as const,
      limit: 1,
      messageBoxListRequest: {
        minChatId: LINE_SYSTEM_ACCOUNT_MID,
        maxChatId: LINE_SYSTEM_ACCOUNT_MID,
        activeOnly: false,
        messageBoxCountLimit: 1,
        withUnreadCount: true,
        lastMessagesPerMessageBoxCount: 5,
        unreadOnly: false,
      },
    },
    {
      source: "prefix-range" as const,
      limit: 10,
      messageBoxListRequest: {
        minChatId: LINE_SYSTEM_ACCOUNT_MID.slice(0, -1),
        maxChatId: LINE_SYSTEM_ACCOUNT_MID + "0",
        activeOnly: false,
        messageBoxCountLimit: 10,
        withUnreadCount: true,
        lastMessagesPerMessageBoxCount: 1,
        unreadOnly: false,
      },
    },
    {
      source: "bounded-list" as const,
      limit: SYSTEM_ACCOUNT_BOX_DISCOVERY_FALLBACK_LIMIT,
      messageBoxListRequest: {
        activeOnly: false,
        messageBoxCountLimit: SYSTEM_ACCOUNT_BOX_DISCOVERY_FALLBACK_LIMIT,
        withUnreadCount: true,
        lastMessagesPerMessageBoxCount: 0,
        unreadOnly: false,
      },
    },
  ];

  let succeeded = false;
  let count: number | null = null;
  let limit = requests[0].limit;
  let lastError: unknown;
  for (const request of requests) {
    limit = request.limit;
    try {
      const result: any = await LineJsAdapter.getMessageBoxes(next, {
        messageBoxListRequest: request.messageBoxListRequest,
      } as any);
      const boxes = Array.isArray(result?.messageBoxes) ? result.messageBoxes : [];
      succeeded = true;
      count = boxes.length;
      const box = boxes.find((candidate: any) => talkMessageBoxId(candidate) === LINE_SYSTEM_ACCOUNT_MID);
      if (box) {
        return { box, source: request.source, count, limit, succeeded };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!succeeded && lastError) throw lastError;
  return { box: null, source: "missing", count, limit, succeeded };
}

async function trackLineSystemAccount(next: LineClient, reason: string, force = false): Promise<void> {
  if (client !== next) return;
  const now = Date.now();
  if (!force && now - lastSystemAccountTrackAt < SYSTEM_ACCOUNT_EVENT_THROTTLE_MS) return;
  if (systemAccountTrackInFlight) return systemAccountTrackInFlight;
  lastSystemAccountTrackAt = now;
  systemAccountTrackInFlight = (async () => {
    try {
      const lookup = await findLineSystemAccountBox(next);
      const previous = database.getSyncState(ACCOUNT_ID, SYSTEM_ACCOUNT_TRACK_KEY);
      const box = lookup.box;
      if (!box) {
        if (shouldRecordMissingSystemAccountBaseline(reason, previous?.cursor, false)) {
          database.setSyncState(ACCOUNT_ID, {
            key: SYSTEM_ACCOUNT_TRACK_KEY,
            cursor: SYSTEM_ACCOUNT_MISSING_BASELINE_CURSOR,
            generation: Date.now(),
            status: "ready",
          });
        }
        return;
      }
      talkMessageBoxCache.delete(LINE_SYSTEM_ACCOUNT_MID);
      talkMessageBoxCache.set(LINE_SYSTEM_ACCOUNT_MID, box);
      trimMapOldest(talkMessageBoxCache, TALK_MESSAGE_BOX_CACHE_LIMIT);
      const cursor = systemAccountCursor(box);
      if (!cursor) return;

      if (!previous?.cursor) {
        // Establish a baseline only. Existing notifications are recovered into
        // history without being surfaced as new unread activity.
        await recoverLineSystemMessages(next, box, cursor);
        database.setSyncState(ACCOUNT_ID, {
          key: SYSTEM_ACCOUNT_TRACK_KEY,
          cursor: cursor.messageId,
          generation: cursor.deliveredTime,
          status: "ready",
        });
        return;
      }
      if (previous.cursor === cursor.messageId) {
        if (force || reason === "startup") await recoverLineSystemMessages(next, box, cursor);
        return;
      }

      database.setSyncState(ACCOUNT_ID, {
        key: SYSTEM_ACCOUNT_TRACK_KEY,
        cursor: cursor.messageId,
        generation: cursor.deliveredTime,
        status: "ready",
      });
      await recoverLineSystemMessages(next, box, cursor);

      const syntheticId = `line-system:${cursor.messageId}`;
      const actualMessage = database.getMessage(ACCOUNT_ID, LINE_SYSTEM_ACCOUNT_MID, cursor.messageId);
      const alreadyStored = database.getMessage(ACCOUNT_ID, LINE_SYSTEM_ACCOUNT_MID, syntheticId);
      if (!actualMessage && !alreadyStored) {
        database.upsertMessages(ACCOUNT_ID, [{
          id: syntheticId,
          chatId: LINE_SYSTEM_ACCOUNT_MID,
          kind: "dm",
          text: "มีการแจ้งเตือนใหม่จาก LINE · เนื้อหาไม่พร้อมผ่าน Talk API",
          isMine: false,
          createdTime: cursor.deliveredTime,
          contentType: 0,
          senderId: LINE_SYSTEM_ACCOUNT_MID,
          senderName: "LINE",
          isOfficialAccount: true,
          status: "sent",
          raw: {
            lineySystemNotification: true,
            trackedMessageId: cursor.messageId,
            trackReason: reason,
          },
        }]);
        database.setTrackedChatActivity(ACCOUNT_ID, LINE_SYSTEM_ACCOUNT_MID, {
          preview: "มีการแจ้งเตือนใหม่จาก LINE",
          createdTime: cursor.deliveredTime,
          unread: cursor.unread,
        });
        emit({
          type: "event.message",
          source: "talk-system",
          message: {
            id: syntheticId,
            chatId: LINE_SYSTEM_ACCOUNT_MID,
            senderId: LINE_SYSTEM_ACCOUNT_MID,
            senderName: "LINE",
            text: "มีการแจ้งเตือนใหม่จาก LINE · เนื้อหาไม่พร้อมผ่าน Talk API",
            isMine: false,
            createdTime: cursor.deliveredTime,
            contentType: 0,
            isOfficialAccount: true,
            systemNotificationTracked: true,
            trackedUnread: cursor.unread,
          },
        });
      } else if (actualMessage) {
        database.setTrackedChatActivity(ACCOUNT_ID, LINE_SYSTEM_ACCOUNT_MID, {
          preview: compactPreview(actualMessage.text, actualMessage.contentType, actualMessage.raw),
          createdTime: actualMessage.createdTime,
          unread: cursor.unread,
        });
      }

      emit({
        type: "event.system_notification",
        source: "talk-metadata",
        chatId: LINE_SYSTEM_ACCOUNT_MID,
        messageId: cursor.messageId,
        createdTime: cursor.deliveredTime,
        unread: cursor.unread,
        reason,
      });
    } catch (error) {
      emit({
        type: "event.system_notification.error",
        source: "talk-metadata",
        error: errorInfo(error).message,
      });
    } finally {
      systemAccountTrackInFlight = null;
    }
  })();
  return systemAccountTrackInFlight;
}

async function consumeSystemAccountTracking(next: LineClient, signal: AbortSignal): Promise<void> {
  await trackLineSystemAccount(next, "startup", true);
  while (!signal.aborted && client === next) {
    await waitForSignal(SYSTEM_ACCOUNT_RECONCILE_INTERVAL_MS, signal);
    if (signal.aborted || client !== next) return;
    await trackLineSystemAccount(next, "reconcile");
  }
}

async function normalizeTalkChat(chat: any, box: any, historyState = talkMessageBoxHistoryState(box)): Promise<any> {
  if (!client) throw new Error("not authenticated");
  const mid = String(chat?.mid ?? talkMessageBoxId(box));
  const isDm = mid.startsWith("u");
  // Prefer the locally-known sender identity. If it's not cached yet, leave a
  // placeholder instead of resolving it over the network here — this function
  // runs for every room during the post-cache refresh and per-sender RPCs at
  // startup are what make the app feel like it has no cache.
  let identity = isDm ? talkSenderCache.get(mid) : undefined;
  if (isDm && !identity) identity = { id: mid, name: "LINE User", avatarUrl: "" };
  const chatName = String(chat?.name ?? "").trim();
  const hasUsefulChatName = Boolean(chatName) && !["LINE Chat", "LINE User"].includes(chatName);
  const identityName = String(identity?.name ?? "").trim();
  const hasUsefulIdentityName = Boolean(identityName) && !["LINE Chat", "LINE User"].includes(identityName);
  const cachedPeerName = isDm && !hasUsefulIdentityName && !hasUsefulChatName
    ? database.getLatestPeerName(ACCOUNT_ID, mid)
    : undefined;
  const rawLast = box?.lastMessages?.[0];
  if (rawLast) rememberMessageMedia(rawLast, false);

  let preview = contentLabel(rawLast?.contentType);
  if (rawLast) {
    if (contentTypeCode(rawLast?.contentType) === 16) {
      preview = postNotificationPreview(rawLast);
    } else if (contentTypeCode(rawLast?.contentType) === 17) {
      preview = parseRichMessage(rawLast)?.altText || "Rich message";
    } else {
      try {
        const wrapped = await fromRawTalk(client, rawLast);
        preview = compactPreview(wrapped.text, rawLast.contentType, rawLast);
      } catch {
        preview = compactPreview(rawLast?.text, rawLast?.contentType, rawLast);
      }
    }
  }

  let avatarUrl = cdnUrl(chat?.raw?.picturePath);
  if (isDm) {
    const pictureVersion = talkProfileImageVersion(chat?.raw?.pictureStatus, chat?.raw?.picturePath);
    const profileVersion = pictureVersion || identity?.profileFetchedAt || identity?.profileSnapshotTime || talkProfileRefreshVersion();
    avatarUrl = talkProfileRefreshAvatarUrl(
      identity?.avatarUrl || talkProfileImageUrl(mid, profileVersion),
      profileVersion,
    );
  }
  const favoriteTimestamp = Number(chat?.raw?.favoriteTimestamp ?? 0);
  const normalizedRaw = normalize(chat?.raw);
  const raw = identity?.identityKey || identity?.profileSnapshotTime || identity?.profileFetchedAt
    ? {
        ...(normalizedRaw && typeof normalizedRaw === "object" ? normalizedRaw as Record<string, unknown> : {}),
        ...(identity.identityKey ? { profileIdentityKey: identity.identityKey } : {}),
        ...(identity.profileSnapshotTime ? { profileSnapshotTime: identity.profileSnapshotTime } : {}),
        ...(identity.profileFetchedAt ? { profileFetchedAt: identity.profileFetchedAt } : {}),
      }
    : normalizedRaw;
  return {
    id: mid,
    name: isDm
      ? (hasUsefulIdentityName ? identityName : hasUsefulChatName ? chatName : cachedPeerName || String(identity?.name || "LINE Chat"))
      : (hasUsefulChatName ? chatName : String(identity?.name || "LINE Chat")),
    kind: isDm ? "dm" : "group",
    avatarUrl,
    preview,
    unread: Number(box?.unreadCount ?? 0),
    lastMessageTime: historyState === "new" ? 0 : talkBoxLastTime(box),
    favoriteTimestamp,
    pinned: favoriteTimestamp > 0,
    historyState,
    identityKey: identity?.identityKey,
    profileSnapshotTime: identity?.profileSnapshotTime,
    profileFetchedAt: identity?.profileFetchedAt,
    raw,
  };
}

function talkProfileIdentityKeyFromChat(chat: any): string {
  const key = String(
    chat?.identityKey
      ?? chat?.profileIdentityKey
      ?? chat?.raw?.profileIdentityKey
      ?? "",
  ).trim();
  return /^profile:[0-9a-f]{64}$/i.test(key) ? key : "";
}

function talkIdentityAliasesForChats(chats: any[]): Map<string, string> {
  const aliases = new Map(
    database.listTalkIdentityAliases(ACCOUNT_ID).map(({ aliasMid, canonicalMid }) => [aliasMid, canonicalMid]),
  );
  const canonicalMidFor = (mid: string): string => {
    let current = mid;
    const seen = new Set([current]);
    for (let depth = 0; depth < aliases.size; depth += 1) {
      const next = aliases.get(current);
      if (!next || seen.has(next)) break;
      current = next;
      seen.add(current);
    }
    return current;
  };

  // LINE can expose the same profile through more than one MID after its
  // contact/chat snapshots refresh at different times. Only an identical
  // server profileId hash is strong enough evidence to join those records.
  const byProfile = new Map<string, any[]>();
  for (const chat of chats) {
    const id = String(chat?.id ?? "");
    const profileKey = talkProfileIdentityKeyFromChat(chat);
    if (chat?.kind !== "dm" || !/^u[0-9a-f]{32}$/i.test(id) || !profileKey) continue;
    const group = byProfile.get(profileKey) ?? [];
    group.push(chat);
    byProfile.set(profileKey, group);
  }

  for (const entries of byProfile.values()) {
    const unique = [...new Map(entries.map((entry) => [String(entry.id), entry])).values()];
    if (unique.length < 2) continue;
    const ranked = [...unique].sort((a, b) => {
      const freshnessA = talkProfileFetchedAtFrom(a) || Number(a?.profileSnapshotTime ?? a?.raw?.profileSnapshotTime ?? 0) || 0;
      const freshnessB = talkProfileFetchedAtFrom(b) || Number(b?.profileSnapshotTime ?? b?.raw?.profileSnapshotTime ?? 0) || 0;
      if (freshnessA !== freshnessB) return freshnessB - freshnessA;
      const activityA = Number(a?.lastMessageTime ?? 0) || 0;
      const activityB = Number(b?.lastMessageTime ?? 0) || 0;
      if (activityA !== activityB) return activityB - activityA;
      return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
    });
    // Keep an existing canonical choice when the freshest row is already an
    // alias, while still using its profile metadata to choose the winner.
    const canonical = canonicalMidFor(String(ranked[0]?.id ?? ""));
    if (!canonical) continue;
    for (const entry of unique) {
      const id = String(entry?.id ?? "");
      if (id && id !== canonical) aliases.set(id, canonical);
    }
  }
  return aliases;
}

function persistStableTalkIdentityAliases(chats: any[]): void {
  for (const [aliasMid, canonicalMid] of talkIdentityAliasesForChats(chats)) {
    if (aliasMid !== canonicalMid) {
      database.mergeTalkIdentity(ACCOUNT_ID, aliasMid, canonicalMid);
    }
  }
}

function collapseTalkIdentityAliases(chats: any[]): any[] {
  const aliases = talkIdentityAliasesForChats(chats);
  if (!aliases.size) return chats;

  const canonicalMidFor = (mid: string): string => {
    let current = mid;
    const seen = new Set([current]);
    for (let depth = 0; depth < aliases.size; depth += 1) {
      const next = aliases.get(current);
      if (!next || seen.has(next)) break;
      current = next;
      seen.add(current);
    }
    return current;
  };
  const groups = new Map<string, any[]>();
  for (const chat of chats) {
    const id = String(chat?.id ?? "");
    const canonical = chat?.kind === "dm" && /^u[0-9a-f]{32}$/i.test(id)
      ? canonicalMidFor(id)
      : id;
    const group = groups.get(canonical) ?? [];
    group.push(chat);
    groups.set(canonical, group);
  }

  return [...groups.entries()].map(([canonical, entries]) => {
    if (entries.length === 1 && String(entries[0]?.id ?? "") === canonical) return entries[0];

    const timeOf = (entry: any) => Number(entry?.lastMessageTime ?? 0) || 0;
    const snapshotOf = (entry: any) => Number(entry?.profileSnapshotTime ?? entry?.raw?.profileSnapshotTime ?? 0) || 0;
    const freshnessOf = (entry: any) => talkProfileFetchedAtFrom(entry) || snapshotOf(entry);
    const canonicalEntry = entries.find((entry) => String(entry?.id ?? "") === canonical);
    const latestEntry = entries.reduce((best, entry) => timeOf(entry) > timeOf(best) ? entry : best, entries[0]);
    const freshestEntry = entries.reduce((best, entry) => freshnessOf(entry) > freshnessOf(best) ? entry : best, canonicalEntry ?? latestEntry);
    const usefulName = (value: unknown) => {
      const name = String(value ?? "").trim();
      return name && !["LINE User", "LINE Chat"].includes(name) ? name : "";
    };
    const canonicalHasProfile = Boolean(
      canonicalEntry
        && (usefulName(canonicalEntry.name)
          || String(canonicalEntry.avatarUrl ?? "").trim()
          || String(canonicalEntry.identityKey ?? canonicalEntry.raw?.profileIdentityKey ?? "").trim()),
    );
    const profileEntry = canonicalHasProfile && freshnessOf(canonicalEntry) >= freshnessOf(freshestEntry)
      ? canonicalEntry
      : freshnessOf(freshestEntry) > 0
        ? freshestEntry
        : canonicalEntry ?? latestEntry;
    const name = usefulName(profileEntry?.name) || usefulName(canonicalEntry?.name) || usefulName(latestEntry?.name) || "LINE User";
    const profileFetchedAt = Math.max(...entries.map(talkProfileFetchedAtFrom)) || undefined;
    const profileSnapshotTime = Number(
      profileEntry?.profileSnapshotTime
        ?? profileEntry?.raw?.profileSnapshotTime
        ?? (profileFetchedAt ? 0 : Math.max(...entries.map(snapshotOf))),
    ) || undefined;
    const sourceRaw = profileEntry?.raw && typeof profileEntry.raw === "object" && !Array.isArray(profileEntry.raw)
      ? profileEntry.raw as Record<string, unknown>
      : {};
    const identityKey = String(
      profileEntry?.profileIdentityKey
        ?? profileEntry?.identityKey
        ?? sourceRaw.profileIdentityKey
        ?? ("manual:" + createHash("sha256").update(ACCOUNT_ID + ":" + canonical).digest("hex")),
    );
    const raw = {
      ...sourceRaw,
      profileIdentityKey: identityKey,
      ...(profileSnapshotTime ? { profileSnapshotTime } : {}),
      ...(profileFetchedAt ? { profileFetchedAt } : {}),
    };

    return {
      ...latestEntry,
      ...profileEntry,
      id: canonical,
      name,
      kind: "dm",
      avatarUrl: profileEntry?.avatarUrl || canonicalEntry?.avatarUrl || latestEntry?.avatarUrl || "",
      preview: latestEntry?.preview || profileEntry?.preview || "",
      unread: entries.reduce((sum, entry) => sum + Math.max(0, Number(entry?.unread ?? 0) || 0), 0),
      lastMessageTime: Math.max(...entries.map(timeOf)),
      pinned: entries.some((entry) => Boolean(entry?.pinned)),
      favoriteTimestamp: Math.max(...entries.map((entry) => Number(entry?.favoriteTimestamp ?? 0) || 0)),
      favoriteTime: Math.max(...entries.map((entry) => Number(entry?.favoriteTime ?? 0) || 0)),
      isFavorite: entries.some((entry) => Boolean(entry?.isFavorite)),
      historyState: entries.some((entry) => entry?.historyState === "available")
        ? "available"
        : entries.some((entry) => entry?.historyState === "new")
          ? "new"
          : "unavailable",
      identityKey,
      profileIdentityKey: identityKey,
      profileSnapshotTime,
      profileFetchedAt,
      raw,
    };
  });
}

function mergeKnownTalkChats(remote: any[]): any[] {
  const byId = new Map<string, any>();
  for (const chat of remote) {
    const id = String(chat?.id ?? "");
    if (id) byId.set(id, chat);
  }
  // The remote list is not a deletion journal. Keep locally known rooms with
  // history when LINE returns a partial snapshot (which is common while the
  // Talk metadata endpoints are refreshing). A later successful snapshot can
  // still update every field for the same id.
  for (const known of database.listConversationChats(ACCOUNT_ID)) {
    const id = String(known.id);
    const current = byId.get(id);
    if (!current) {
      byId.set(id, known);
      continue;
    }
    const currentName = String(current.name ?? "").trim();
    const usefulName = Boolean(currentName) && !["LINE Chat", "LINE User"].includes(currentName);
    const currentProfileKey = talkProfileIdentityKeyFromChat(current);
    const knownProfileKey = talkProfileIdentityKeyFromChat(known);
    const currentSnapshot = Number(current.profileSnapshotTime ?? current.raw?.profileSnapshotTime ?? 0) || 0;
    const knownSnapshot = Number(known.profileSnapshotTime ?? known.raw?.profileSnapshotTime ?? 0) || 0;
    const currentFetchedAt = talkProfileFetchedAtFrom(current);
    const knownFetchedAt = talkProfileFetchedAtFrom(known);
    const hasFetchTimestamps = currentFetchedAt > 0 || knownFetchedAt > 0;
    const currentProfileIsNewer = hasFetchTimestamps
      ? currentFetchedAt >= knownFetchedAt
      : currentSnapshot >= knownSnapshot;
    const profileIdentityKey = currentProfileKey && currentProfileIsNewer
      ? currentProfileKey
      : knownProfileKey || currentProfileKey;
    const profileSnapshotTime = currentFetchedAt ? (currentSnapshot || undefined) : Math.max(currentSnapshot, knownSnapshot) || undefined;
    const profileFetchedAt = Math.max(currentFetchedAt, knownFetchedAt) || undefined;
    const knownRaw = known.raw && typeof known.raw === "object" && !Array.isArray(known.raw)
      ? known.raw as Record<string, unknown>
      : {};
    const currentRaw = current.raw && typeof current.raw === "object" && !Array.isArray(current.raw)
      ? current.raw as Record<string, unknown>
      : {};
    const raw = {
      ...knownRaw,
      ...currentRaw,
      ...(profileIdentityKey ? { profileIdentityKey } : {}),
      ...(profileSnapshotTime ? { profileSnapshotTime } : {}),
      ...(profileFetchedAt ? { profileFetchedAt } : {}),
    };
    byId.set(id, {
      ...known,
      ...current,
      name: usefulName ? currentName : known.name,
      avatarUrl: current.avatarUrl || known.avatarUrl,
      preview: current.preview || known.preview,
      lastMessageTime: Math.max(Number(current.lastMessageTime ?? 0), Number(known.lastMessageTime ?? 0)),
      historyState: known.historyState === "available" ? "available" : current.historyState ?? known.historyState ?? "available",
      identityKey: profileIdentityKey || current.identityKey || known.identityKey,
      profileIdentityKey: profileIdentityKey || current.profileIdentityKey || known.profileIdentityKey,
      profileSnapshotTime,
      profileFetchedAt,
      raw,
    });
  }
  return [...byId.values()];
}

async function loadChatsList(persist = true, canPersist: () => boolean = () => true): Promise<any[]> {
  if (!client) throw new Error("not authenticated");
  let chats: any[] = [];
  let joinedError: unknown;
  try {
    chats = await LineJsAdapter.fetchJoinedChats(client);
  } catch (error) {
    joinedError = error;
  }
  const boxes = await loadTalkMessageBoxes();
  const boxMap = new Map(boxes.map((box: any) => [talkMessageBoxId(box), box]));
  const joinedIds = chats.map((chat: any) => String(chat.mid));
  const additionalIds = [...new Set([
    ...boxes
      .map((box: any) => talkMessageBoxId(box))
      .filter((id) => Boolean(id) && !joinedIds.includes(id)),
  ])];

  // A joined-group list can lack chatName. Fetch only unresolved group
  // metadata; never replace a previously known real group name with a
  // placeholder from a partial server response. Bound the network fanout.
  const cachedGroupRows = database.listConversationChats(ACCOUNT_ID)
    .filter((saved) => saved.kind === "group");
  const knownGroups = new Map(cachedGroupRows
    .filter((saved) => usefulTalkName(saved.name))
    .map((saved) => [saved.id, saved]));
  // The old generic-name rooms generally come from SQLite, not from the
  // current joined-room response. Try those separately before declaring their
  // metadata unavailable; never include them in the joined-room batch because
  // a revoked membership can reject an entire batch.
  const unresolvedCachedGroups = cachedGroupRows.filter((saved) =>
    !usefulTalkName(saved.name)
    && !joinedIds.includes(saved.id)
    && Date.now() - (groupMetadataCheckedAt.get(saved.id) ?? 0) >= GROUP_METADATA_RETRY_MS
  ).slice(0, 40);
  const unresolvedJoinedGroups = chats.filter((chat: any) => {
    const id = String(chat?.mid ?? "");
    return id && !id.startsWith("u")
      && !usefulTalkName(chat?.name)
      && !knownGroups.has(id)
      && Date.now() - (groupMetadataCheckedAt.get(id) ?? 0) >= GROUP_METADATA_RETRY_MS;
  });
  const extraGroups = new Map<string, any>();
  // LINEJS getChats accepts multiple MIDs. Request only names and pictures,
  // not complete member lists, so metadata recovery stays lightweight.
  const unresolvedIds = unresolvedJoinedGroups.slice(0, 48).map((chat: any) => String(chat.mid));
  const singleLookupIds = new Set(additionalIds.filter((id) => !id.startsWith("u")));
  for (let offset = 0; offset < unresolvedIds.length; offset += 20) {
    const mids = unresolvedIds.slice(offset, offset + 20);
    for (const mid of mids) groupMetadataCheckedAt.set(mid, Date.now());
    try {
      const details = await LineJsAdapter.getChatMetadataBatch(client, mids);
      for (const detail of details) {
        if (usefulTalkName(detail.name)) extraGroups.set(detail.mid, detail);
      }
    } catch {
      // Fall back to bounded single-room calls only when a batch fails.
      for (const mid of mids) singleLookupIds.add(mid);
    }
  }
  await runPool([...singleLookupIds], 3, async (id) => {
    groupMetadataCheckedAt.set(id, Date.now());
    try {
      const extra = await LineJsAdapter.getChat(client!, id);
      if (extra) extraGroups.set(id, extra);
    } catch {
      // Preserve archives even when the account cannot access room metadata.
    }
  });
  // Archived unknown groups get only a couple of batched attempts per cooldown.
  // Do not fan out individual getChat calls for rooms no longer on the account.
  for (let offset = 0; offset < unresolvedCachedGroups.length; offset += 20) {
    const mids = unresolvedCachedGroups.slice(offset, offset + 20).map((row) => row.id);
    for (const mid of mids) groupMetadataCheckedAt.set(mid, Date.now());
    try {
      for (const details of await LineJsAdapter.getChatMetadataBatch(client, mids)) {
        if (usefulTalkName(details.name)) extraGroups.set(details.mid, details);
      }
    } catch {
      // A rejected or archived group must not hold up normal chat loading.
    }
  }

  const jobs: Array<{ chat: any; box: any; historyState: "available" | "new" | "unavailable" }> = [
    ...chats.map((chat: any) => {
      const id = String(chat?.mid ?? "");
      const box = boxMap.get(id);
      const details = extraGroups.get(id);
      return { chat: details && usefulTalkName(details.name) ? details : chat, box, historyState: talkMessageBoxHistoryState(box) };
    }),
    ...additionalIds.map((id) => {
      const box = boxMap.get(id);
      return {
        chat: extraGroups.get(id),
        box,
        historyState: talkMessageBoxHistoryState(box),
      };
    }),
  ];
  const directMids = [...new Set(jobs
    .map(({ chat, box }) => String(chat?.mid ?? talkMessageBoxId(box)))
    .filter((mid) => mid.startsWith("u")))];
  if (directMids.length) await resolveTalkIdentities(directMids);
  const remoteResult = new Array<any>(jobs.length);
  await runPool(jobs, 4, async ({ chat, box, historyState }, index) => {
    remoteResult[index] = await normalizeTalkChat(chat, box, historyState);
  });
  // Apply recovered metadata to archived SQLite rows without inventing
  // messages or changing an unavailable room into an active room.
  const recoveredArchivedGroups = unresolvedCachedGroups.flatMap((saved) => {
    const remote = extraGroups.get(saved.id);
    return remote && usefulTalkName(remote.name)
      ? [{
          ...saved,
          name: remote.name,
          avatarUrl: cdnUrl(remote.raw?.picturePath ?? remote.raw?.pictureStatus) || saved.avatarUrl,
          raw: { ...(saved.raw ?? {}), ...(remote.raw ?? {}) },
        }]
      : [];
  });
  let result = mergeKnownTalkChats([...remoteResult, ...recoveredArchivedGroups]);
  if (!result.length && joinedError) throw joinedError;
  if (persist && canPersist()) {
    // Store both MIDs before reconciling so the database transaction can move
    // the complete history, unread state, and outbox to the canonical chat.
    database.upsertChats(ACCOUNT_ID, result as DatabaseChat[]);
    persistStableTalkIdentityAliases(result);
  }
  result = collapseTalkIdentityAliases(result);
  result.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  return result;
}

async function loadFriendsList(persist = true, canPersist: () => boolean = () => true, retryOnly = false): Promise<any[]> {
  if (!client) throw new Error("not authenticated");
  const users: any[] = retryOnly
    ? await LineJsAdapter.retryMissingFriendProfiles(client)
    : await LineJsAdapter.fetchUsers(client);
  const contacts = users.map((user) => {
    const raw = user?.raw ?? {};
    const mid = String(user?.mid ?? raw?.targetUserMid ?? "").trim();
    const contact = raw?.contact ?? raw?.targetProfileDetail ?? raw;
    return { mid, raw, contact };
  }).filter(({ mid }) => mid.startsWith("u"));
  const friendsByMid = new Map<string, any>();
  for (const { mid, raw, contact } of contacts) {
    const favoriteTime = Number(contact?.favoriteTime ?? raw?.favoriteTime ?? 0);
    const identity = talkContactIdentity(mid, raw);
    const previousIdentity = talkSenderCache.get(mid);
    const currentName = usefulTalkName(identity.name);
    const previousName = usefulTalkName(previousIdentity?.name);
    const cachedPeerName = currentName || previousName
      ? undefined
      : database.getLatestPeerName(ACCOUNT_ID, mid);
    const refreshedIdentity: SenderIdentity = {
      ...previousIdentity,
      ...identity,
      name: identity.displayNameOverride
        ? identity.name
        : currentName || previousName || cachedPeerName || identity.name,
      avatarUrl: identity.avatarUrl || previousIdentity?.avatarUrl || talkProfileImageUrl(mid, talkProfileRefreshVersion()),
      identityKey: identity.identityKey || previousIdentity?.identityKey,
      profileSnapshotTime: identity.profileSnapshotTime ?? previousIdentity?.profileSnapshotTime,
      profileFetchedAt: Date.now(),
      displayNameOverride: identity.displayNameOverride,
      ...(identity.isOfficialAccount || previousIdentity?.isOfficialAccount ? { isOfficialAccount: true } : {}),
    };
    const profileIdentity: SenderIdentity = {
      ...refreshedIdentity,
      profileNameFromApi: Boolean(currentName) || Boolean(previousIdentity?.profileNameFromApi),
    };
    talkSenderCache.set(mid, profileIdentity);
    friendsByMid.set(mid, {
      id: mid,
      name: refreshedIdentity.name,
      kind: "dm",
      avatarUrl: refreshedIdentity.avatarUrl,
      identityKey: refreshedIdentity.identityKey,
      profileSnapshotTime: refreshedIdentity.profileSnapshotTime,
      profileFetchedAt: refreshedIdentity.profileFetchedAt,
      raw: {
        ...(refreshedIdentity.identityKey ? { profileIdentityKey: refreshedIdentity.identityKey } : {}),
        ...(refreshedIdentity.profileSnapshotTime ? { profileSnapshotTime: refreshedIdentity.profileSnapshotTime } : {}),
        ...(refreshedIdentity.profileFetchedAt ? { profileFetchedAt: refreshedIdentity.profileFetchedAt } : {}),
      },
      statusMessage: String(contact?.statusMessage ?? ""),
      favoriteTime,
      isFavorite: favoriteTime > 0,
    });
  }

  const refreshedIdentities = await resolveTalkIdentities([...friendsByMid.keys()]);
  let result = [...friendsByMid.values()].map((friend) => {
    const identity = refreshedIdentities.get(friend.id) ?? talkSenderCache.get(friend.id);
    if (!identity) return friend;
    const profileVersion = identity.profileFetchedAt ?? identity.profileSnapshotTime ?? talkProfileRefreshVersion();
    const identityName = identity.name.trim();
    const name = identity.displayNameOverride
      ? identity.name
      : identityName && !["LINE User", "LINE Chat"].includes(identityName)
        ? identityName
        : friend.name;
    const identityKey = identity.identityKey || friend.identityKey;
    const profileSnapshotTime = identity.profileSnapshotTime ?? friend.profileSnapshotTime;
    const profileFetchedAt = identity.profileFetchedAt ?? friend.profileFetchedAt;
    const avatarUrl = talkProfileRefreshAvatarUrl(
      identity.avatarUrl || talkProfileImageUrl(friend.id, profileVersion),
      profileVersion,
    );
    return {
      ...friend,
      name,
      avatarUrl,
      identityKey,
      profileSnapshotTime,
      profileFetchedAt,
      raw: {
        ...friend.raw,
        ...(identityKey ? { profileIdentityKey: identityKey } : {}),
        ...(profileSnapshotTime ? { profileSnapshotTime } : {}),
        ...(profileFetchedAt ? { profileFetchedAt } : {}),
      },
    };
  });
  if (persist && canPersist()) {
    database.upsertChats(ACCOUNT_ID, result as DatabaseChat[]);
    persistStableTalkIdentityAliases(result);
  }
  result = collapseTalkIdentityAliases(result);
  result.sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    if (a.favoriteTime !== b.favoriteTime) return b.favoriteTime - a.favoriteTime;
    return a.name.localeCompare(b.name, "th");
  });
  return result;
}

async function loadOpenChatList(persist = true, canPersist: () => boolean = () => true): Promise<any[]> {
  if (!client) throw new Error("not authenticated");
  let chats: any[] = [];
  let joinedError: unknown;
  try {
    chats = await LineJsAdapter.fetchJoinedSquareChats(client);
  } catch (error) {
    joinedError = error;
  }
  const result: any[] = [];
  // Bounded concurrency (not Promise.all) so a refresh doesn't fan out one
  // getSquareChatStatus request per OpenChat at the same instant.
  await runPool(chats, 4, async (chat: any) => {
    let status: any = null;
    try {
      status = (await LineJsAdapter.getSquareChatStatus(client!, {
        request: { squareChatMid: String(chat.mid) },
      })).chatStatus;
    } catch {
      status = null;
    }
    const last = status?.lastMessage?.message;
    if (last) rememberMessageMedia(last, true);
    result.push({
      id: String(chat.mid),
      name: String(chat.name || "OpenChat"),
      kind: "openchat",
      avatarUrl: cdnUrl(chat?.raw?.chatImageObsHash),
      preview: compactPreview(last?.text, last?.contentType, last),
      unread: Number(status?.otherStatus?.unreadMessageCount ?? 0),
      memberCount: Number(status?.otherStatus?.memberCount ?? 0),
      lastMessageTime: Number(last?.createdTime ?? 0),
      raw: normalize(chat.raw),
    });
  });
  const byId = new Map<string, any>(result.map((chat) => [String(chat.id), chat]));
  for (const known of database.listChats(ACCOUNT_ID, "openchat")) {
    if (!byId.has(known.id)) byId.set(known.id, known);
  }
  const merged = [...byId.values()];
  if (!merged.length && joinedError) throw joinedError;
  merged.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  if (persist && canPersist()) database.upsertChats(ACCOUNT_ID, merged as DatabaseChat[]);
  return merged;
}

async function fetchOpenChatMessagesNormalized(chatId: string, limit: number): Promise<any[]> {
  if (!client) throw new Error("not authenticated");
  const collected: any[] = [];
  const selfMid = midString(LineJsAdapter.profileMid(client));
  let syncToken: string | undefined;
  for (let page = 0; page < 6 && collected.length < limit; page++) {
    const response: any = await LineJsAdapter.fetchSquareChatEvents(client, {
      squareChatMid: chatId,
      syncToken,
      limit: 100,
      direction: "FORWARD",
    });
    syncToken = response?.syncToken || syncToken;
    const events: any[] = response?.events ?? [];
    for (const event of events) {
      const payload = event?.payload?.receiveMessage ?? event?.payload?.sendMessage;
      const squareMessage = payload?.squareMessage;
      const message = squareMessage?.message;
      if (!message) continue;
      const contentType = contentTypeCode(message?.contentType);
      rememberMessageMedia(message, true);
      const rich = contentType === 17 ? parseRichMessage(message) : undefined;
      collected.push({
        id: String(message?.id ?? crypto.randomUUID()),
        text: contentType === 17 ? (rich?.altText || "Rich message") : displayMessageText(message?.text, contentType, message),
        from: String(message?.from ?? ""),
        to: String(message?.to ?? chatId),
        isMine: event?.type === "SEND_MESSAGE",
        senderName: String(payload?.senderDisplayName ?? ""),
        createdTime: Number(message?.createdTime ?? event?.createdTime ?? Date.now()),
        contentType,
        readCount: Math.max(0, Number(message?.readCount ?? 0)),
        filename: mediaFilename(message),
        stickerUrl: contentType === 7 ? stickerUrlFromRaw(message) : undefined,
        flex: contentType === 22 ? parseFlexMessage(message) : undefined,
        reactions: squareReactionSummaries(payload?.messageReactionStatus, selfMid),
        replyToId: relatedMessageId(message),
        rich,
        call: contentType === 6 ? parseCallHistory(message) : undefined,
        raw: message,
      });
    }
    if (!events.length) break;
  }
  const unique = [...new Map(collected.map((item) => [item.id, item])).values()]
    .sort((a: any, b: any) => a.createdTime - b.createdTime)
    .slice(-limit);
  const fallbackNames = new Map<string, string>();
  for (const item of unique as any[]) {
    if (item.from && item.senderName) fallbackNames.set(item.from, item.senderName);
  }
  const identities = await resolveIdentities(
    (unique as any[]).filter((item) => !item.isMine).map((item) => item.from),
    (senderMid) => resolveSquareSender(senderMid, fallbackNames.get(senderMid) || ""),
  );
  return decorateReplyReferences((unique as any[]).map((item) => {
    const sender = item.isMine ? null : identities.get(item.from);
    return {
      ...item,
      senderId: sender?.id ?? item.from,
      senderName: sender?.name ?? item.senderName ?? "",
      senderAvatarUrl: sender?.avatarUrl ?? "",
      raw: item.raw,
    };
  }));
}

async function fetchTalkMessagesNormalized(
  chatId: string,
  limit: number,
  endMessageId?: { messageId: string | bigint; deliveredTime: number },
): Promise<any[]> {
  if (!client) throw new Error("not authenticated");
  let list: any[];
  const isOlderPage = endMessageId !== undefined;
  const decode = async (rawList: unknown): Promise<any[]> => Promise.all(
    (Array.isArray(rawList) ? rawList : []).map(async (raw: any) => {
      try {
        return await fromRawTalk(client!, raw);
      } catch {
        return {
          raw,
          text: raw?.text ?? "",
          isMyMessage: midString(raw?.from) === midString(LineJsAdapter.profileMid(client)),
        };
      }
    }),
  );

  const sourceLists: any[][] = [];
  const routeErrors: unknown[] = [];
  let box = talkMessageBoxCache.get(chatId);
  // Older-page requests already have an explicit cursor. Initial loads still
  // try MessageBox discovery, but a discovery failure must not block the
  // direct recent-message fallback.
  if (!box && !endMessageId) {
    try {
      const boxes = await loadTalkMessageBoxes();
      box = boxes.find((candidate: any) => talkMessageBoxId(candidate) === chatId);
    } catch (error) {
      routeErrors.push(error);
    }
  }

  const cursor = endMessageId ?? box?.lastDeliveredMessageId;
  const readRoute = async (request: () => Promise<unknown>): Promise<number> => {
    try {
      const rawList = await request();
      const decoded = await decode(rawList);
      sourceLists.push(decoded);
      return decoded.length;
    } catch (error) {
      routeErrors.push(error);
      return 0;
    }
  };

  if (isOlderPage) {
    await readRoute(() => LineJsAdapter.getPreviousMessages(client!, {
      request: {
        messageBoxId: chatId,
        endMessageId: cursor!,
        messagesCount: limit,
      },
    }));
    if (routeErrors.length && !sourceLists.some((batch) => batch.length)) {
      throw routeErrors.at(-1);
    }
    list = sourceLists[0] ?? [];
  } else {
    let cursorCount = 0;
    if (cursor && cursor.messageId !== undefined && cursor.deliveredTime !== undefined) {
      cursorCount = await readRoute(() => LineJsAdapter.getPreviousMessages(client!, {
        request: {
          messageBoxId: chatId,
          endMessageId: cursor,
          messagesCount: limit,
        },
      }));
    }

    // Keep every source bounded to this room and merge partial responses. LINE
    // can return a short cursor page even when the recent window or MessageBox
    // still has a usable payload.
    // A full cursor page can still end before a newer sidebar event when
    // LINE has published stale MessageBox metadata. In that case try the
    // recent window too, then merge and deduplicate both responses.
    if (!cursorCount || cursorCount < limit || !historySnapshotCoversSidebar(chatId, sourceLists.flat())) {
      await readRoute(() => LineJsAdapter.getRecentMessages(client!, {
        messageBoxId: chatId,
        messagesCount: limit,
      }));
    }
    if (Array.isArray(box?.lastMessages) && box.lastMessages.length) {
      sourceLists.push(await decode(box.lastMessages));
    }

    const byId = new Map<string, any>();
    for (const batch of sourceLists) {
      for (const message of batch) {
        const raw = message?.raw ?? {};
        const key = String(raw?.id ?? message?.id ?? [
          Number(raw?.createdTime ?? message?.createdTime ?? 0),
          midString(raw?.from ?? message?.from),
          midString(raw?.to ?? message?.to),
          contentTypeCode(raw?.contentType ?? message?.contentType),
        ].join(":"));
        const previous = byId.get(key);
        if (!previous) {
          byId.set(key, message);
        } else {
          byId.set(key, {
            ...previous,
            ...message,
            text: message?.text || previous?.text || "",
            rich: message?.rich ?? previous?.rich,
            flex: message?.flex ?? previous?.flex,
            call: message?.call ?? previous?.call,
            stickerUrl: message?.stickerUrl ?? previous?.stickerUrl,
            reactions: message?.reactions ?? previous?.reactions,
          });
        }
      }
    }
    list = [...byId.values()].sort((left, right) =>
      Number(left?.raw?.createdTime ?? left?.createdTime ?? 0)
        - Number(right?.raw?.createdTime ?? right?.createdTime ?? 0));
    if (!list.length && routeErrors.length) throw routeErrors.at(-1);
  }
  const rows = list.map((message: any) => {
    const contentType = contentTypeCode(message?.raw?.contentType);
    const raw = message?.raw ?? {};
    rememberMessageMedia(raw, false);
  const postNotification = contentType === 16 ? parsePostNotification(raw) : null;
  const rich = contentType === 17 ? parseRichMessage(raw) : undefined;
    const from = midString(raw?.from) || midString(message?.from);
    const to = midString(raw?.to) || midString(message?.to);
    const selfMid = midString(client ? LineJsAdapter.profileMid(client) : undefined);
    const editState = LineJsAdapter.talkMessageEditState(message);
    return {
      id: String(raw?.id ?? crypto.randomUUID()),
      text: contentType === 16
        ? postNotificationPreview(raw)
        : contentType === 17 ? (rich?.altText || "Rich message") : displayMessageText(message?.text, contentType, raw),
      from,
      to,
      isMine: Boolean(message?.isMyMessage),
      createdTime: Number(raw?.createdTime ?? Date.now()),
      contentType,
      readCount: Math.max(0, Number(raw?.readCount ?? 0)),
      edited: editState.edited || undefined,
      updatedTime: editState.updatedTime,
      filename: mediaFilename(raw),
      stickerUrl: contentType === 7 ? stickerUrlFromRaw(raw) : undefined,
      flex: contentType === 22 ? parseFlexMessage(raw) : undefined,
      reactions: reactionSummaries(raw?.reactions, selfMid),
      replyToId: relatedMessageId(raw),
      rich,
      call: contentType === 6 ? parseCallHistory(raw) : undefined,
      raw,
      postNotification,
    };
  });
  const uniqueRows = [...new Map(rows.map((item: any) => [String(item.id), item])).values()];
  const identities = await resolveTalkIdentities(
    uniqueRows.filter((item: any) => !item.isMine).map((item: any) => item.from),
  );
  return decorateReplyReferences(uniqueRows.map((item: any) => {
    const sender = item.isMine ? null : identities.get(item.from);
    return {
      ...item,
      senderId: sender?.id ?? item.from,
      senderName: sender?.name ?? "",
      senderAvatarUrl: sender?.avatarUrl ?? "",
      officialClientUrl: officialLineMessageUrl(chatId, String(item.id)),
        isOfficialAccount: sender?.isOfficialAccount,
    };
  }));
}

async function loadTalkMessagesBefore(
  chatId: string,
  before: { messageId: string; createdTime: number },
  limit: number,
): Promise<{ messages: any[]; hasMore: boolean }> {
  const safeLimit = Math.max(1, Math.min(limit, MESSAGE_LIST_RESULT_LIMIT));
  const cached = database.listMessagesBefore(
    ACCOUNT_ID,
    chatId,
    before.createdTime,
    before.messageId,
    safeLimit,
  );
  let hasMore = cached.hasMore;

  if (cached.messages.length >= safeLimit && !cached.hasMore) {
    // A full local page does not prove the remote history is exhausted.
    // The next page request checks the older cursor without OFFSET.
    hasMore = true;
  } else if (
    cached.messages.length < safeLimit
    && !cached.hasMore
    && client
    && chatId !== LINE_SYSTEM_ACCOUNT_MID
  ) {
    const pivot = cached.messages[0]
      ?? database.getMessage(ACCOUNT_ID, chatId, before.messageId)
      ?? { id: before.messageId, createdTime: before.createdTime, raw: undefined };
    const pivotId = String(pivot.id);
    const pivotTime = Number(pivot.createdTime);
    const pivotRaw = (pivot.raw && typeof pivot.raw === "object" ? pivot.raw : {}) as Record<string, unknown>;
    const deliveredTime = Number(pivotRaw.deliveredTime ?? pivotTime);
    const remaining = safeLimit - cached.messages.length;
    if (!/^\d+$/.test(pivotId) || !Number.isFinite(deliveredTime) || deliveredTime <= 0) {
      const decorated = await recoverMissingStickerMetadata(
        chatId,
        false,
        await enrichStoredTalkSenders(cached.messages),
        safeLimit,
      );
      return { messages: decorated, hasMore: cached.hasMore };
    }
    const remote = await fetchTalkMessagesNormalized(chatId, remaining, {
      messageId: BigInt(pivotId),
      deliveredTime,
    });
    const olderRemote = remote
      .filter((message: any) => {
        const time = Number(message?.createdTime ?? 0);
        const id = String(message?.id ?? "");
        return time < pivotTime || (time === pivotTime && id < pivotId);
      })
      .sort((left: any, right: any) => (
        Number(left?.createdTime ?? 0) - Number(right?.createdTime ?? 0)
        || String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
      ));
    const knownIds = new Set(cached.messages.map((message) => String(message.id)));
    const newRemoteCount = olderRemote.filter((message: any) => !knownIds.has(String(message.id))).length;
    if (olderRemote.length) persistNormalizedMessages(chatId, false, olderRemote);

    const refreshed = database.listMessagesBefore(
      ACCOUNT_ID,
      chatId,
      before.createdTime,
      before.messageId,
      safeLimit,
    );
    hasMore = refreshed.hasMore
      || (remote.length >= remaining && newRemoteCount > 0);
    const decorated = await recoverMissingStickerMetadata(
      chatId,
      false,
      await enrichStoredTalkSenders(refreshed.messages),
      safeLimit,
    );
    return { messages: decorated, hasMore };
  }

  const decorated = await recoverMissingStickerMetadata(
    chatId,
    false,
    await enrichStoredTalkSenders(cached.messages),
    safeLimit,
  );
  return { messages: decorated, hasMore };
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function chatKindFor(chatId: string, openchat: boolean): "dm" | "group" | "openchat" {
  if (openchat) return "openchat";
  const existing = preSyncedChats?.find((chat) => String(chat.id) === chatId)?.kind;
  return existing === "dm" || existing === "group"
    ? existing
    : chatId.startsWith("u") ? "dm" : "group";
}

function decorateReplyReferences(messages: any[]): any[] {
  const byId = new Map<string, any>(messages.map((message) => [String(message?.id ?? ""), message]));
  return messages.map((message) => {
    const replyId = String(message?.replyToId ?? "").trim();
    if (!replyId) return message;
    const chatId = String(message?.chatId ?? "").trim();
    const target = byId.get(replyId) ?? (chatId ? database.getMessage(ACCOUNT_ID, chatId, replyId) : null);
    return {
      ...message,
      replyTo: {
        id: replyId,
        text: String(target?.text ?? "ข้อความ"),
        author: target?.isMine ? "me" : "them",
        ...(target?.senderName ? { senderName: target.senderName } : {}),
      },
    };
  });
}

function decorateStoredMessages(messages: DatabaseMessage[]): any[] {
  const decorated = messages.map((message) => {
    const stickerUrl = messageStickerUrl(message);
    const flex = messageFlex(message);
    const rich = Number(message.contentType ?? 0) === 17 ? parseRichMessage(message.raw) : undefined;
    const call = Number(message.contentType ?? 0) === 6 ? parseCallHistory(message.raw) : undefined;
    const readCount = Math.max(0, Number((message.raw as any)?.readCount ?? 0));
    const editState = LineJsAdapter.talkMessageEditState(message.raw);
    return stickerUrl || flex || rich || call || readCount > 0 || editState.edited
      ? {
        ...message,
        ...(readCount > 0 ? { readCount } : {}),
        ...(editState.edited ? { edited: true, updatedTime: editState.updatedTime } : {}),
        ...(stickerUrl ? { stickerUrl } : {}),
        ...(flex ? { flex } : {}),
        ...(rich ? { rich } : {}),
        ...(call ? { call, text: callHistoryPreview(call) } : {}),
      }
      : message;
  });
  return decorateReplyReferences(decorated);
}

function mergeHistorySnapshots(previous: any[], fresh: any[]): any[] {
  const byId = new Map<string, any>();
  for (const message of [...previous, ...fresh]) {
    const id = String(message?.id ?? "");
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, message);
      continue;
    }
    byId.set(id, {
      ...existing,
      ...message,
      text: message?.text || existing?.text || "",
      rich: message?.rich ?? existing?.rich,
      flex: message?.flex ?? existing?.flex,
      call: message?.call ?? existing?.call,
      stickerUrl: message?.stickerUrl ?? existing?.stickerUrl,
      reactions: message?.reactions ?? existing?.reactions,
    });
  }
  return [...byId.values()].sort((left, right) =>
    Number(left?.createdTime ?? 0) - Number(right?.createdTime ?? 0));
}

function listCallHistory(limit = 200): any[] {
  const chats = new Map(database.listConversationChats(ACCOUNT_ID).map((chat) => [chat.id, chat]));
  return database.listMessagesByContentType(ACCOUNT_ID, 6, limit).flatMap((message) => {
    const raw = message.raw && typeof message.raw === "object" && !Array.isArray(message.raw)
      ? message.raw as Record<string, unknown>
      : {};
    const call = parseCallHistory({ ...raw, contentType: message.contentType, text: message.text });
    if (!call) return [];
    const chat = chats.get(message.chatId);
    const chatName = String(chat?.name ?? "").trim();
    const name = chatName && !["LINE Chat", "LINE User"].includes(chatName)
      ? chatName
      : String(message.senderName ?? "").trim() || (message.chatId.startsWith("u") ? "LINE User" : "LINE Group");
    return [{
      id: message.id,
      chatId: message.chatId,
      kind: message.kind,
      name,
      avatarUrl: chat?.avatarUrl || message.senderAvatarUrl || "",
      isMine: message.isMine,
      createdTime: message.createdTime,
      call,
    }];
  });
}

async function enrichStoredTalkSenders(messages: DatabaseMessage[]): Promise<DatabaseMessage[]> {
  if (!client) return messages;
  const senderMidForMessage = (message: DatabaseMessage): string => {
    const senderId = String(message.senderId ?? "").trim();
    return senderId || midString((message.raw as any)?.from);
  };
  const senderMids = [...new Set(
    messages
      .filter((message) => !message.isMine)
      .map(senderMidForMessage)
      .filter((mid) => mid.startsWith("u")),
  )];
  if (!senderMids.length) return messages;
  try {
    const identities = await resolveTalkIdentities(senderMids);
    let changed = false;
    const enriched = messages.map((message) => {
      const identity = identities.get(senderMidForMessage(message));
      if (!identity) return message;
      const next = {
        ...message,
        senderId: identity.id,
        senderName: identity.name,
        senderAvatarUrl: identity.avatarUrl,
        isOfficialAccount: Boolean(identity.isOfficialAccount),
      };
      if (
        next.senderName !== message.senderName
        || next.senderAvatarUrl !== message.senderAvatarUrl
        || next.isOfficialAccount !== Boolean(message.isOfficialAccount)
      ) changed = true;
      return next;
    });
    if (changed) database.upsertMessages(ACCOUNT_ID, enriched);
    return enriched;
  } catch {
    // Sender enrichment is optional; never hide cached history when it fails.
    return messages;
  }
}

async function recoverMissingStickerMetadata(
  chatId: string,
  openchat: boolean,
  messages: DatabaseMessage[],
  limit: number,
): Promise<any[]> {
  const hasMissingSticker = messages.some((message) => (
    Number(message.contentType ?? 0) === 7 && !messageStickerUrl(message)
  ));
  if (!hasMissingSticker || !client) return decorateStoredMessages(messages);

  try {
    // Older Liney versions saved the sticker row without the raw LINE
    // payload. Re-read a bounded recent window once so those rows can also
    // resolve STKID/STKOPT instead of remaining text-only forever.
    const recovered = openchat
      ? await fetchOpenChatMessagesNormalized(chatId, Math.max(limit, 100))
      : await fetchTalkMessagesWithFallback(chatId, Math.max(limit, 100));
    if (recovered.some((message: any) => messageStickerUrl(message))) {
      persistNormalizedMessages(chatId, openchat, recovered);
      return decorateStoredMessages(database.listMessages(ACCOUNT_ID, chatId, limit));
    }
  } catch {
    // Keep the local history visible when LINE cannot refresh this room.
  }
  return decorateStoredMessages(messages);
}

function enrichCachedMessagesInBackground(
  chatId: string,
  openchat: boolean,
  messages: DatabaseMessage[],
  limit: number,
): void {
  if (!client || !messages.length) return;
  const key = `${openchat ? "openchat" : "talk"}:${chatId}`;
  const now = Date.now();
  if (messageCacheEnrichInFlight.has(key)) return;
  if (now - (messageCacheEnrichedAt.get(key) ?? 0) < MESSAGE_CACHE_ENRICH_TTL_MS) return;
  messageCacheEnrichedAt.set(key, now);
  trimMapOldest(messageCacheEnrichedAt, 128);

  const task = (async () => {
    const enriched = openchat ? messages : await enrichStoredTalkSenders(messages);
    await recoverMissingStickerMetadata(chatId, openchat, enriched, limit);
  })()
    .catch(() => {
      // Cached history is already usable. Background enrichment is best-effort.
    })
    .finally(() => {
      if (messageCacheEnrichInFlight.get(key) === task) messageCacheEnrichInFlight.delete(key);
    });
  messageCacheEnrichInFlight.set(key, task);
}

function persistNormalizedMessages(chatId: string, openchat: boolean, messages: any[]): void {
  const canonicalChatId = openchat ? chatId : canonicalTalkIdentityMid(chatId);
  const kind = chatKindFor(canonicalChatId, openchat);
  const rows: DatabaseMessage[] = messages.map((message) => ({
    id: String(message.id),
    chatId: canonicalChatId,
    kind,
    text: typeof message.text === "string" ? message.text : "",
    filename: typeof message.filename === "string" ? message.filename : undefined,
    isMine: Boolean(message.isMine),
    createdTime: Number(message.createdTime ?? Date.now()),
    contentType: Number(message.contentType ?? 0),
    senderId: message.senderId,
    senderName: message.senderName,
    senderAvatarUrl: message.senderAvatarUrl,
    isOfficialAccount: Boolean(message.isOfficialAccount),
    postNotification: message.postNotification,
    reactions: message.reactions,
    replyToId: message.replyToId ?? message.replyTo?.id,
    unsent: Boolean(message.unsent),
    status: "sent",
    raw: normalize(message.raw),
  }));
  if (rows.length) {
    database.upsertMessages(ACCOUNT_ID, rows);
    prunePersistentCache();
  }
}

function persistLiveMessage(
  chatId: string,
  kind: "dm" | "group" | "openchat",
  message: any,
  localId?: string,
): void {
  if (kind !== "openchat") chatId = canonicalTalkIdentityMid(chatId);
  const messageId = String(message.id ?? crypto.randomUUID());
  if (database.isMessageHidden(ACCOUNT_ID, chatId, kind, messageId)) return;
  const createdTime = finiteMessageTime(message.createdTime);
  const isExistingMessage = database.getMessageSource(ACCOUNT_ID, messageId, chatId, kind) !== null;
  const row: DatabaseMessage = {
    id: localId || messageId,
    chatId,
    kind,
    text: typeof message.text === "string" ? message.text : "",
    filename: typeof message.filename === "string" ? message.filename : undefined,
    isMine: Boolean(message.isMine),
    createdTime,
    contentType: Number(message.contentType ?? 0),
    senderId: message.senderId,
    senderName: message.senderName,
    senderAvatarUrl: message.senderAvatarUrl,
    isOfficialAccount: Boolean(message.isOfficialAccount),
    postNotification: message.postNotification,
    reactions: message.reactions,
    replyToId: message.replyToId ?? message.replyTo?.id,
    unsent: Boolean(message.unsent),
    status: "sent",
    raw: normalize(message.raw),
  };
  if (localId) database.reconcileMessage(ACCOUNT_ID, localId, { ...row, id: messageId }, messageId);
  else database.upsertMessage(ACCOUNT_ID, row);
  prunePersistentCache();

  // A pre-sync result is a one-shot optimization. Once a live event touches
  // a room, force message.list to read the durable SQLite row instead of
  // serving the older in-memory snapshot. The overlay flag also protects
  // against a full-sync worker finishing after this event and re-populating
  // that stale snapshot.
  const cacheKey = `${kind === "openchat" ? "openchat" : "talk"}:${chatId}`;
  preSyncedMessages.delete(cacheKey);
  liveMessageOverlayKeys.add(cacheKey);

  const preview = compactPreview(message.text, message.contentType, message.raw);
  const targetChats = kind === "openchat" ? preSyncedOpenChats : preSyncedChats;
  if (targetChats) {
    const existing = targetChats.find((chat) => String(chat?.id ?? "") === chatId);
    if (existing) {
      const previousLastMessageTime = Number(existing.lastMessageTime ?? 0);
      if (createdTime >= previousLastMessageTime) existing.preview = preview;
      existing.lastMessageTime = Math.max(previousLastMessageTime, createdTime);
      if (!message.isMine && !isExistingMessage) existing.unread = Number(existing.unread ?? 0) + 1;
    } else {
      targetChats.push({
        id: chatId,
        kind,
        name: message.senderName || (kind === "openchat" ? "OpenChat" : kind === "group" ? "LINE Group" : "LINE Chat"),
        avatarUrl: message.senderAvatarUrl || "",
        preview,
        unread: message.isMine || isExistingMessage ? 0 : 1,
        lastMessageTime: createdTime,
      });
      targetChats.sort((a, b) => Number(b.lastMessageTime ?? 0) - Number(a.lastMessageTime ?? 0));
    }
  }
  database.recordMessageActivity(ACCOUNT_ID, {
    chatId,
    kind,
    name: message.senderName,
    avatarUrl: message.senderAvatarUrl,
    preview,
    createdTime,
    isMine: Boolean(message.isMine),
    isNew: !isExistingMessage,
  });
}

function reconcileEcho(chatId: string, kind: "dm" | "group" | "openchat", message: any): string | undefined {
  if (!message.isMine) return undefined;
  const candidate = {
    chatId,
    kind,
    contentType: Number(message.contentType ?? 0),
    text: message.text,
    filename: message.filename,
    createdTime: Number(message.createdTime ?? Date.now()),
    id: String(message.id ?? ""),
    relatedMessageId: message.replyToId ?? message.relatedMessageId,
  };
  const match = database.listPendingOutbox(ACCOUNT_ID).find((record) => echoMatches(record, candidate));
  if (!match) return undefined;
  database.deleteOutbox(ACCOUNT_ID, match.localId);
  return match.localId;
}

function startSync(mode: "full" | "delta" = "full"): Promise<void> {
  invalidateChatListRefreshes();
  return getSyncCoordinator().startFull(mode).catch((error) => {
    // coordinator already set error state; just rethrow for caller
    throw error;
  });
}

function waitForSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function canonicalTalkIdentityMid(mid: string): string {
  return database.resolveTalkIdentityMid(ACCOUNT_ID, mid);
}

function canonicalTalkChatId(chatId: string, kind: string): string {
  return kind === "openchat" ? chatId : canonicalTalkIdentityMid(chatId);
}

function talkHistoryActivity(chatId: string): { hasActivity: boolean; lastMessageTime: number } {
  const transient = preSyncedChats?.find((chat) => String(chat?.id ?? "") === chatId);
  const persisted = database.listConversationChats(ACCOUNT_ID).find((chat) => chat.id === chatId);
  const rows = [transient, persisted].filter(Boolean) as any[];
  const lastMessageTime = rows.reduce(
    (latest, chat) => Math.max(latest, Number(chat?.lastMessageTime ?? 0) || 0),
    0,
  );
  const hasActivity = lastMessageTime > 0
    || rows.some((chat) => Boolean(String(chat?.preview ?? "").trim()))
    || rows.some((chat) => ["available", "unavailable"].includes(String(chat?.historyState ?? "")));
  return { hasActivity, lastMessageTime };
}

function historySnapshotCoversSidebar(chatId: string, messages: readonly any[]): boolean {
  const activity = talkHistoryActivity(chatId);
  if (!activity.hasActivity) return true;
  if (!messages.length) return false;
  if (!activity.lastMessageTime) return true;
  const latest = messages.reduce(
    (value, message) => Math.max(value, Number(message?.createdTime ?? message?.raw?.createdTime ?? 0) || 0),
    0,
  );
  return latest >= activity.lastMessageTime;
}

const talkHistoryMetadataRefreshAt = new Map<string, number>();
const TALK_HISTORY_METADATA_REFRESH_TTL_MS = 30_000;

async function recoverTalkHistoryFromCursorMatchedMid(chatId: string, limit: number): Promise<any[]> {
  const currentChatId = canonicalTalkIdentityMid(chatId);
  const box = talkMessageBoxCache.get(currentChatId) ?? talkMessageBoxCache.get(chatId);
  const cursorMessageId = String(box?.lastDeliveredMessageId?.messageId ?? "").trim();
  const cursorDeliveredTime = Number(box?.lastDeliveredMessageId?.deliveredTime ?? 0);
  if (!cursorMessageId || !Number.isFinite(cursorDeliveredTime) || cursorDeliveredTime <= 0) return [];

  // A LINE message ID plus its delivery time is a stronger identity link than
  // a display name or avatar. Only auto-recover when exactly one prior DM has
  // that same server message; uncertain matches stay separate for user review.
  const priorChatId = database.findTalkChatForCursorMessage(
    ACCOUNT_ID,
    currentChatId,
    cursorMessageId,
    cursorDeliveredTime,
  );
  if (!priorChatId || priorChatId === currentChatId) return [];
  if (!database.mergeTalkIdentity(ACCOUNT_ID, priorChatId, currentChatId)) return [];
  return enrichStoredTalkSenders(database.listMessages(ACCOUNT_ID, currentChatId, limit));
}

async function fetchTalkMessagesWithFallback(
  chatId: string,
  limit: number,
  metadataAlreadyFresh = false,
): Promise<any[]> {
  let firstResult: any[] = [];
  let firstError: unknown;
  try {
    firstResult = await fetchTalkMessagesNormalized(chatId, limit);
  } catch (error) {
    firstError = error;
  }

  const firstCoversSidebar = historySnapshotCoversSidebar(chatId, firstResult);
  if (firstCoversSidebar) {
    if (firstError) throw firstError;
    return firstResult;
  }
  if (!talkHistoryActivity(chatId).hasActivity) {
    if (firstError) throw firstError;
    return firstResult;
  }
  if (metadataAlreadyFresh) {
    const restored = await recoverTalkHistoryFromCursorMatchedMid(chatId, limit);
    if (restored.length) return mergeHistorySnapshots(firstResult, restored);
    if (firstError) throw new Error("LINE history could not be loaded after refreshing the MessageBox.");
    return firstResult;
  }

  const now = Date.now();
  const lastRefreshAt = talkHistoryMetadataRefreshAt.get(chatId) ?? 0;
  if (now - lastRefreshAt < TALK_HISTORY_METADATA_REFRESH_TTL_MS) {
    const restored = await recoverTalkHistoryFromCursorMatchedMid(chatId, limit);
    if (restored.length) return mergeHistorySnapshots(firstResult, restored);
    if (firstError) throw new Error("LINE history could not be loaded from its current MessageBox.");
    return firstResult;
  }
  talkHistoryMetadataRefreshAt.set(chatId, now);
  trimMapOldest(talkHistoryMetadataRefreshAt, 256);

  // A stale cursor can make every history route return an old or empty page.
  // Refresh MessageBoxes once; fetchTalkMessagesNormalized also tries the
  // recent endpoint when the cursor page does not reach sidebar activity.
  talkMessageBoxCache.delete(chatId);
  await loadTalkMessageBoxes();
  const refreshedChatId = canonicalTalkIdentityMid(chatId);
  let refreshed: any[] = [];
  let refreshedError: unknown;
  try {
    refreshed = await fetchTalkMessagesNormalized(refreshedChatId, limit);
  } catch (error) {
    refreshedError = error;
  }
  if (historySnapshotCoversSidebar(refreshedChatId, refreshed)) return refreshed;

  const restored = await recoverTalkHistoryFromCursorMatchedMid(refreshedChatId, limit);
  if (restored.length) return mergeHistorySnapshots(mergeHistorySnapshots(firstResult, refreshed), restored);

  if (refreshedError) {
    if (firstError) {
      throw new Error("LINE history could not be loaded after refreshing the MessageBox.");
    }
    if (firstResult.length) return firstResult;
    throw new Error("LINE history could not be loaded from the cursor, recent window, or MessageBox payload.");
  }
  // Keep known rows visible if LINE still serves an incomplete window. The
  // caller merges this with SQLite and exposes retry when no safe source exists.
  return mergeHistorySnapshots(firstResult, refreshed);
}

function talkChatId(raw: any, message: any, isMine: boolean, from: string, to: string): string {
  const toType = midTypeName(raw?.toType ?? (() => {
    try { return message?.to?.type; } catch { return ""; }
  })());
  let chatId: string;
  if (toType === "GROUP" || toType === "ROOM") chatId = to || from;
  else if (toType === "USER") chatId = isMine ? (to || from) : (from || to);
  else {
    // Some LINE sessions return the enum as a numeric value in raw and some
    // return only the MID. The MID fallback preserves the DM direction in both
    // forms while still using the room MID for group messages.
    chatId = isMine ? (to || from) : (to.startsWith("u") ? (from || to) : (to || from));
  }
  return canonicalTalkIdentityMid(chatId);
}

const SQUARE_OPERATION_NAMES: Record<string, string> = {
  "0": "RECEIVE_MESSAGE",
  "1": "SEND_MESSAGE",
  "5": "NOTIFIED_DESTROY_MESSAGE",
  "29": "NOTIFICATION_MESSAGE",
  "47": "NOTIFICATION_MESSAGE_REACTION",
  "54": "NOTIFICATION_THREAD_MESSAGE",
  "55": "NOTIFICATION_THREAD_MESSAGE_REACTION",
};

function operationTypeName(value: unknown, names: Record<string, string>): string {
  const text = String(value ?? "").trim();
  return names[text] ?? text.toUpperCase();
}

function operationMessageId(operation: any): string {
  const value = operation?.message?.id
    ?? operation?.messageId
    ?? operation?.param1
    ?? operation?.param2;
  return String(value ?? "").trim();
}

function operationTalkChatId(operation: any, isMine: boolean): string {
  const raw = operation?.message ?? {};
  const from = midString(raw?.from);
  const to = midString(raw?.to);
  if (from || to) return talkChatId(raw, undefined, isMine, from, to);
  for (const value of [operation?.chatMid, operation?.chatId, operation?.param2, operation?.param3]) {
    const candidate = String(value ?? "").trim();
    if (candidate.startsWith("c") || candidate.startsWith("r") || candidate.startsWith("u")) return canonicalTalkIdentityMid(candidate);
  }
  return "";
}

function talkOperationReaction(operation: any): number {
  const reactions = operation?.message?.reactions;
  const last = Array.isArray(reactions) ? reactions.at(-1) : undefined;
  return reactionTypeCode(
    last?.reactionType?.predefinedReactionType
      ?? last?.reactionType
      ?? operation?.reactionType
      ?? operation?.param3,
  );
}

function persistReactionEvent(
  chatId: string,
  kind: "dm" | "group" | "openchat",
  messageId: string,
  reaction: number,
  source: "talk" | "openchat",
): void {
  if (!chatId || !messageId || reaction < 1 || reaction > 7) return;
  const stored = database.getMessage(ACCOUNT_ID, chatId, messageId);
  const reactions = applyReactionToSummaries(stored?.reactions, reaction);
  database.updateMessageReactions(ACCOUNT_ID, chatId, messageId, reactions);
  emit({ type: "event.message.reaction", source, chatId, messageId, reactions });
}

async function handleTalkMessage(next: LineClient, message: any, rawOverride?: any, eventKind: "message" | "edit" | "recover" = "message"): Promise<void> {
  if (client !== next) return;
  const raw = rawOverride ?? message?.raw ?? {};
  if (!raw || typeof raw !== "object") return;
  const contentType = contentTypeCode(raw?.contentType);
  const postNotification = contentType === 16 ? parsePostNotification(raw) : null;
  const rich = contentType === 17 ? parseRichMessage(raw) : undefined;
  rememberMessageMedia(raw, false);

  const from = midString(raw?.from) || midString(message?.from);
  const to = midString(raw?.to) || midString(message?.to);
  let isMine = false;
  try { isMine = Boolean(message?.isMyMessage); } catch { /* use profile fallback */ }
  if (!isMine) {
    const selfMid = midString(LineJsAdapter.profileMid(next));
    if (selfMid && from === selfMid) isMine = true;
  }
  const chatId = talkChatId(raw, message, isMine, from, to);
  if (!chatId) return;
  const kind = chatKindFor(chatId, false);
  if (database.isMessageHidden(ACCOUNT_ID, chatId, kind, String(raw?.id ?? ""))) return;

  // Never wait for a profile RPC before delivering the message to the UI.
  // Full sync normally warms this cache, while a new group member can be
  // resolved in the background without blocking later events.
  const isLineSystemSender = Boolean(
    from && canonicalTalkIdentityMid(from) === LINE_SYSTEM_ACCOUNT_MID,
  );
  const sender = isMine
    ? null
    : isLineSystemSender
      ? { id: from, name: "LINE", avatarUrl: "" }
      : talkSenderCache.get(from) ?? (from ? { id: from, name: "LINE User", avatarUrl: "" } : null);
  const shouldResolveSender = !isMine && !isLineSystemSender && Boolean(from)
    && (!talkSenderCache.has(from) || talkSenderProfileNeedsRefresh(from));
  let textValue: unknown = raw?.text;
  try { if (message?.text !== undefined) textValue = message.text; } catch { /* raw text fallback */ }
  const messageId = String(raw?.id ?? crypto.randomUUID());
  const editState = LineJsAdapter.talkMessageEditState(message);
  const normalized = {
    id: messageId,
    chatId,
    from,
    senderId: sender?.id ?? from,
    senderName: sender?.name ?? "",
    senderAvatarUrl: sender?.avatarUrl ?? "",
    officialClientUrl: officialLineMessageUrl(chatId, messageId),
    isOfficialAccount: sender?.isOfficialAccount,
    text: contentType === 16
      ? postNotificationPreview(raw)
       : contentType === 17 ? (rich?.altText || "Rich message") : displayMessageText(textValue, contentType, raw),
    isMine,
    createdTime: finiteMessageTime(raw?.createdTime),
    contentType,
    readCount: Math.max(0, Number(raw?.readCount ?? 0)),
    edited: editState.edited || eventKind === "edit" || undefined,
    updatedTime: editState.updatedTime,
    filename: mediaFilename(raw),
    stickerUrl: contentType === 7 ? stickerUrlFromRaw(raw) : undefined,
    flex: contentType === 22 ? parseFlexMessage(raw) : undefined,
    reactions: reactionSummaries(raw?.reactions, midString(LineJsAdapter.profileMid(next))),
    replyToId: relatedMessageId(raw),
    rich,
    call: contentType === 6 ? parseCallHistory(raw) : undefined,
    postNotification,
    raw,
  };
  let localId: string | undefined;
  if (eventKind === "message") {
    try { localId = reconcileEcho(chatId, kind, normalized); } catch { /* UI still receives the event */ }
  }
  try { persistLiveMessage(chatId, kind, normalized, localId); } catch (error) {
    emit({ type: "event.message.persistence_error", source: "talk", error: errorInfo(error).message });
  }

  if (shouldResolveSender) {
    void resolveTalkSenderInBackground(from).then((identity) => {
      if (!identity || client !== next) return;
      const stored = database.getMessage(ACCOUNT_ID, chatId, normalized.id);
      if (stored) {
        database.upsertMessage(ACCOUNT_ID, {
          ...stored,
          senderId: identity.id,
          senderName: identity.name,
          senderAvatarUrl: identity.avatarUrl,
          isOfficialAccount: Boolean(identity.isOfficialAccount),
        });
      }
      emit({
        type: "event.message.updated",
        source: "talk",
        chatId,
        messageId: normalized.id,
        message: {
          id: normalized.id,
          chatId,
          senderId: identity.id,
          senderName: identity.name,
          senderAvatarUrl: identity.avatarUrl,
          officialClientUrl: officialLineMessageUrl(chatId, normalized.id),
          isOfficialAccount: identity.isOfficialAccount,
        },
      });
    }).catch(() => undefined);
  }

  // The raw LINE object can contain binary chunks/BigInt values and is not
  // needed by the renderer (SQLite keeps it for media recovery). Sending it
  // over JSONL used to be able to throw after persistence, making the message
  // appear to vanish from the live UI.
  const wireMessage = { ...normalized };
  delete (wireMessage as { raw?: unknown }).raw;
  emit({
    type: eventKind !== "message" ? "event.message.updated" : "event.message",
    source: "talk",
    chatId,
    messageId: normalized.id,
    localId,
    message: localId ? { ...wireMessage, localId } : wireMessage,
  });
}

async function handleSquareMessage(
  next: LineClient,
  message: any,
  isMineOverride?: boolean,
  fallbackName = "",
  reactionStatus?: any,
): Promise<void> {
  if (client !== next) return;
  const envelope = message?.raw ?? {};
  const raw = envelope?.message ?? envelope;
  if (!raw || typeof raw !== "object") return;
  const contentType = contentTypeCode(raw?.contentType);
  rememberMessageMedia(raw, true);
  const rich = contentType === 17 ? parseRichMessage(raw) : undefined;
  const from = midString(envelope?.from) || midString(raw?.from) || midString(message?.from);
  const to = midString(envelope?.to) || midString(raw?.to) || midString(message?.to);
  const selfMid = midString(LineJsAdapter.profileMid(next));
  const isMine = isMineOverride ?? Boolean(selfMid && from === selfMid);
  const sender = isMine
    ? null
    : squareSenderCache.get(from) ?? { id: from, name: fallbackName || "OpenChat member", avatarUrl: "" };
  if (!isMine && from && !squareSenderCache.has(from)) {
    void resolveSquareSender(from, fallbackName).catch(() => undefined);
  }
  let textValue: unknown = raw?.text;
  try { if (message?.text !== undefined) textValue = message.text; } catch { /* raw text fallback */ }
  const normalized = {
    id: String(raw?.id ?? crypto.randomUUID()),
    chatId: to,
    from,
    senderId: sender?.id ?? from,
    senderName: sender?.name ?? fallbackName,
    senderAvatarUrl: sender?.avatarUrl ?? "",
    text: contentType === 17 ? (rich?.altText || "Rich message") : displayMessageText(textValue, contentType, raw),
    isMine,
    createdTime: finiteMessageTime(raw?.createdTime),
    contentType,
    readCount: Math.max(0, Number(raw?.readCount ?? 0)),
    filename: mediaFilename(raw),
    stickerUrl: contentType === 7 ? stickerUrlFromRaw(raw) : undefined,
    flex: contentType === 22 ? parseFlexMessage(raw) : undefined,
    reactions: squareReactionSummaries(reactionStatus ?? envelope?.messageReactionStatus ?? raw?.messageReactionStatus, selfMid),
    replyToId: relatedMessageId(raw),
    rich,
    call: contentType === 6 ? parseCallHistory(raw) : undefined,
    raw,
  };
  if (!to) return;
  if (database.isMessageHidden(ACCOUNT_ID, to, "openchat", String(raw?.id ?? ""))) return;
  let localId: string | undefined;
  try { localId = reconcileEcho(to, "openchat", normalized); } catch { /* UI still receives the event */ }
  try { persistLiveMessage(to, "openchat", normalized, localId); } catch (error) {
    emit({ type: "event.message.persistence_error", source: "openchat", error: errorInfo(error).message });
  }
  const wireMessage = { ...normalized };
  delete (wireMessage as { raw?: unknown }).raw;
  emit({
    type: "event.message",
    source: "openchat",
    localId,
    message: localId ? { ...wireMessage, localId } : wireMessage,
  });
}

async function handleTalkOperation(next: LineClient, operation: any): Promise<void> {
  if (client !== next) return;
  const type = canonicalTalkOperationType(operation?.type, LINEJS_VERSION);
  if (isLineServiceChatOperation(type)) {
    const revision = String(operation?.revision ?? "").trim();
    const createdTime = Number(operation?.createdTime ?? Date.now());
    const param1 = String(operation?.param1 ?? "").trim();
    const param2 = String(operation?.param2 ?? "").trim();
    const param3 = String(operation?.param3 ?? "").trim();
    const eventKey = revision || `${type}:${createdTime}:${param1}:${param2}:${param3}`;
    database.recordProtocolEvent(ACCOUNT_ID, {
      eventKey,
      source: "talk-system",
      opType: type,
      revision: revision || undefined,
      createdTime: Number.isFinite(createdTime) ? createdTime : Date.now(),
      param1: param1 || undefined,
      param2: param2 || undefined,
      param3: param3 || undefined,
      raw: normalize(operation),
    });
    emit({
      type: "event.system_notification.operation",
      source: "talk",
      operationType: type,
      revision: revision || undefined,
      createdTime,
      param1: param1 || undefined,
      param2: param2 || undefined,
      param3: param3 || undefined,
    });
    await ingestLineSystemMessage(next, operation?.message);
    void trackLineSystemAccount(next, `op:${type}`).catch(() => undefined);
    return;
  } else if (type === "DUMMY") {
    void trackLineSystemAccount(next, `op:${type}`).catch(() => undefined);
  }
  if (type === "NOTIFIED_READ_MESSAGE") {
    // LINE sends this as param1=chat MID, param2=reader MID and
    // param3=the highest message id they have read. It is a peer event, not
    // the local mark-read request we send when opening a room.
    const chatId = canonicalTalkIdentityMid(String(operation?.param1 ?? "").trim());
    const readerMid = String(operation?.param2 ?? "").trim();
    const messageId = String(operation?.param3 ?? "").trim();
    const selfMid = midString(LineJsAdapter.profileMid(next));
    if (chatId && messageId && readerMid && readerMid !== selfMid) {
      emit({ type: "event.message.read", source: "talk", chatId, messageId, readerMid });
    }
    return;
  }
  if (type === "NOTIFIED_RECEIVED_CALL") {
    const incoming: any = parseIncomingCallForClient(next, operation);
    callManager.rememberIncoming(incoming);

    // Call UI should use the same identity/cache path as normal Talk messages.
    // Never block the ringing prompt on profile resolution: emit cached data
    // immediately when available, then refresh it in the background.
    const callerMid = String(
      incoming?.audio?.callerMid ?? incoming?.from ?? operation?.param1 ?? "",
    ).trim();
    const emitCallIdentity = (identity: SenderIdentity | null | undefined) => {
      if (!identity || !callerMid) return;
      emit({
        type: "event.call.identity",
        peer: callerMid,
        name: identity.name,
        avatarUrl: identity.avatarUrl,
      });
    };
    emitCallIdentity(talkSenderCache.get(callerMid));
    if (callerMid.startsWith("u")) {
      void resolveTalkSenderInBackground(callerMid)
        .then(emitCallIdentity)
        .catch(() => undefined);
    }
    return;
  }
  if (type === "CANCEL_CALL") {
    const event = parseCancelCall(operation);
    void callManager.stop("remote-cancelled");
    emit({ type: "event.call.cancel", event: normalize(event) });
    return;
  }
  if (["SEND_REACTION", "NOTIFIED_SEND_REACTION", "NOTIFIED_GCS_REACTION"].includes(type)) {
    const messageId = operationMessageId(operation);
    const chatId = operationTalkChatId(operation, type === "SEND_REACTION");
    persistReactionEvent(chatId, chatKindFor(chatId, false), messageId, talkOperationReaction(operation), "talk");
    return;
  }
  if (["DESTROY_MESSAGE", "NOTIFIED_DESTROY_MESSAGE"].includes(type)) {
    const messageId = operationMessageId(operation);
    const chatId = operationTalkChatId(operation, type === "DESTROY_MESSAGE");
    if (chatId && messageId) {
      database.markMessageUnsent(ACCOUNT_ID, chatId, messageId);
      removeMessageCaches(messageId, false);
      emit({ type: "event.message.unsent", source: "talk", chatId, messageId });
    }
    return;
  }
  if (!["SEND_MESSAGE", "RECEIVE_MESSAGE", "EDIT_MESSAGE", "NOTIFIED_EDIT_MESSAGE"].includes(type)) return;
  const encrypted = operation?.message;
  if (!encrypted || typeof encrypted !== "object") return;
  let raw = encrypted;
  try {
    raw = await LineJsAdapter.decryptE2EEMessage(next, encrypted);
  } catch (error) {
    // A single message with a missing/rotated E2EE key must not terminate the
    // event consumer. Keep the envelope for later recovery, but surface an
    // explicit placeholder instead of silently turning it into an empty chat.
    const fallbackText = "ข้อความเข้ารหัส — ไม่สามารถถอดรหัสได้";
    raw = { ...encrypted, text: fallbackText, lineyE2eeDecodeError: true };
    emit({ type: "event.message.decode_error", source: "talk", error: errorInfo(error).message });
    const eventKind = type === "EDIT_MESSAGE" || type === "NOTIFIED_EDIT_MESSAGE" ? "edit" : "message";
    await handleTalkMessage(next, { raw, text: fallbackText }, raw, eventKind);
    return;
  }
  // Decryption is asynchronous: a logout/account switch may have happened.
  if (client !== next) return;
  const eventKind = type === "EDIT_MESSAGE" || type === "NOTIFIED_EDIT_MESSAGE" ? "edit" : "message";
  await handleTalkMessage(next, createTalkMessage(next, raw), raw, eventKind);
}

async function handleSquareOperation(next: LineClient, operation: any): Promise<void> {
  if (client !== next) return;
  const type = operationTypeName(operation?.type, SQUARE_OPERATION_NAMES);
  const payload = operation?.payload ?? {};
  if (type === "NOTIFIED_DESTROY_MESSAGE") {
    const event = payload?.notifiedDestroyMessage;
    const chatId = String(event?.squareChatMid ?? "").trim();
    const messageId = String(event?.messageId ?? "").trim();
    if (chatId && messageId) {
      database.markMessageUnsent(ACCOUNT_ID, chatId, messageId);
      removeMessageCaches(messageId, true);
      emit({ type: "event.message.unsent", source: "openchat", chatId, messageId });
    }
    return;
  }
  if (type === "NOTIFICATION_MESSAGE_REACTION" || type === "NOTIFICATION_THREAD_MESSAGE_REACTION") {
    const event = type === "NOTIFICATION_THREAD_MESSAGE_REACTION"
      ? payload?.notificationThreadMessageReaction
      : payload?.notificationMessageReaction;
    const chatId = String(event?.squareChatMid ?? event?.chatMid ?? "").trim();
    const messageId = String(event?.messageId ?? "").trim();
    persistReactionEvent(chatId, "openchat", messageId, reactionTypeCode(event?.type), "openchat");
    return;
  }
  const envelope = payload?.notificationMessage ?? payload?.sendMessage ?? payload?.receiveMessage;
  const squareRaw = envelope?.squareMessage;
  if (!squareRaw) return;
  const isMine = type === "SEND_MESSAGE" ? true : type === "RECEIVE_MESSAGE" ? false : undefined;
  const fallbackName = String(envelope?.senderDisplayName ?? payload?.senderDisplayName ?? "").trim();
  await handleSquareMessage(
    next,
    createSquareMessage(next, squareRaw),
    isMine,
    fallbackName,
    envelope?.messageReactionStatus,
  );
}

async function consumeTalkEvents(next: LineClient, signal: AbortSignal, push: any, dispatcher: OrderedOperationDispatcher<any>): Promise<void> {
  while (!signal.aborted && client === next) {
    const stream = LineJsAdapter.pushStream(push, "op");
    try {
      for await (const operation of stream as AsyncIterable<any>) {
        if (signal.aborted || client !== next) return;
        try {
          await dispatcher.dispatch(operation);
        } catch (error) {
          if (!signal.aborted) emit({ type: "event.message.error", source: "talk", error: errorInfo(error).message });
        }
      }
    } catch (error) {
      if (!signal.aborted) emit({ type: "event.transport.error", transport: "talk", error: errorInfo(error).message });
    }
    if (!signal.aborted && client === next) {
      LineJsAdapter.renewPushStream(push, "op");
      await waitForSignal(50, signal);
    }
  }
}

async function consumeSquareEvents(next: LineClient, signal: AbortSignal, push: any, dispatcher: OrderedOperationDispatcher<any>): Promise<void> {
  while (!signal.aborted && client === next) {
    const stream = LineJsAdapter.pushStream(push, "sq");
    try {
      for await (const operation of stream as AsyncIterable<any>) {
        if (signal.aborted || client !== next) return;
        try {
          await dispatcher.dispatch(operation);
        } catch (error) {
          if (!signal.aborted) emit({ type: "event.message.error", source: "openchat", error: errorInfo(error).message });
        }
      }
    } catch (error) {
      if (!signal.aborted) emit({ type: "event.transport.error", transport: "openchat", error: errorInfo(error).message });
    }
    if (!signal.aborted && client === next) {
      LineJsAdapter.renewPushStream(push, "sq");
      await waitForSignal(50, signal);
    }
  }
}

function needsPollingFallback(): boolean {
  return shouldUsePollingFallback({
    healthy: pushHealthy,
    connectedSince: pushConnectedSince,
    fallbackNotBefore: pushFallbackNotBefore,
    now: Date.now(),
  });
}

async function consumeTalkPolling(next: LineClient, signal: AbortSignal, polling: LineyPollingSession, dispatcher: OrderedOperationDispatcher<any>): Promise<void> {
  await runFallbackPolling({
    signal,
    shouldPoll: () => client === next && needsPollingFallback(),
    createStream: (cycleSignal) => polling.talk({
      signal: cycleSignal,
      pollingInterval: 1_000,
      onError: (error: unknown) => {
        // LINEJS catches polling errors internally and otherwise retries every
        // pollingInterval. Re-throw here so our supervisor can apply bounded
        // exponential backoff/circuit breaking instead of opening sockets in
        // a tight failure loop.
        if (!signal.aborted && !cycleSignal.aborted) throw error;
      },
    }),
    onEvent: async (operation) => {
      if (signal.aborted || client !== next) return;
      try {
        await dispatcher.dispatch(operation);
      } catch (error) {
        if (!signal.aborted) emit({ type: "event.message.error", source: "talk-poll", error: errorInfo(error).message });
      }
    },
    onError: (error) => {
      if (!signal.aborted) emit({ type: "event.transport.error", transport: "talk-poll", error: errorInfo(error).message });
    },
  });
}

async function consumeSquarePolling(next: LineClient, signal: AbortSignal, polling: LineyPollingSession, dispatcher: OrderedOperationDispatcher<any>): Promise<void> {
  await runFallbackPolling({
    signal,
    shouldPoll: () => client === next && needsPollingFallback(),
    createStream: (cycleSignal) => polling.square({
      signal: cycleSignal,
      pollingInterval: 1_000,
      onError: (error: unknown) => {
        if (!signal.aborted && !cycleSignal.aborted) throw error;
      },
    }),
    onEvent: async (operation) => {
      if (signal.aborted || client !== next) return;
      try {
        await dispatcher.dispatch(operation);
      } catch (error) {
        if (!signal.aborted) emit({ type: "event.message.error", source: "openchat-poll", error: errorInfo(error).message });
      }
    },
    onError: (error) => {
      if (!signal.aborted) emit({ type: "event.transport.error", transport: "openchat-poll", error: errorInfo(error).message });
    },
  });
}

async function supervisePush(next: LineClient, signal: AbortSignal, push: any): Promise<void> {
  let backoff = 1_000;
  const stop = () => {
    void LineJsAdapter.closePushConnections(push);
    LineJsAdapter.closePushStream(push, "op");
    LineJsAdapter.closePushStream(push, "sq");
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (!signal.aborted && client === next && LineJsAdapter.authToken(next)) {
      const cycleStartedAt = Date.now();
      try {
        LineJsAdapter.setPushListening(push, true);
        await LineJsAdapter.initializePushConnection(push, 1, [3, 8]);
        pushHealthy = true;
        pushConnectedSince = Date.now();
        emit({ type: "event.transport", transport: "line", state: "connected" });
        await LineJsAdapter.readPush(push, [3, 8]);
        // A connection that drops immediately is not healthy. Increase the
        // delay for those loops so a broken PUSH endpoint cannot spin and
        // starve the REST fallback; reset only after a stable connection.
        if (Date.now() - cycleStartedAt >= 10_000) {
          backoff = 1_000;
        } else {
          pushHealthy = false;
          pushConnectedSince = 0;
          backoff = Math.min(backoff * 2, 30_000);
        }
      } catch (error) {
        pushHealthy = false;
        pushConnectedSince = 0;
        if (!signal.aborted) {
          emit({ type: "event.transport", transport: "line", state: "reconnecting", error: errorInfo(error).message });
        }
        await LineJsAdapter.closePushConnections(push);
        backoff = Math.min(backoff * 2, 30_000);
      }
      if (signal.aborted || client !== next) break;
      await waitForSignal(backoff, signal);
    }
  } finally {
    pushHealthy = false;
    pushConnectedSince = 0;
    signal.removeEventListener("abort", stop);
    LineJsAdapter.setPushListening(push, false);
    await LineJsAdapter.closePushConnections(push);
  }
}

function attachEvents(next: LineClient) {
  listenerAbort?.abort();
  listenerAbort = new AbortController();
  const signal = listenerAbort.signal;
  const push = LineJsAdapter.push(next) as any;
  // One serial lane per LINE transport family, shared between PUSH and REST
  // fallback. Backpressure keeps decrypt/write order and bounds in-flight work.
  const active = () => !signal.aborted && client === next;
  const talkDispatcher = new OrderedOperationDispatcher(active,
    (operation: any) => talkOperationIdentity(operation, canonicalTalkOperationType(operation?.type, LINEJS_VERSION)),
    (operation: any) => handleTalkOperation(next, operation));
  const squareDispatcher = new OrderedOperationDispatcher(active,
    (operation: any) => squareOperationIdentity(operation, operationTypeName(operation?.type, SQUARE_OPERATION_NAMES)),
    (operation: any) => handleSquareOperation(next, operation));

  LineJsAdapter.on(next, "update:authtoken", () => {
    void persistCredential(next).catch(() => undefined);
  });

  // Do not use Client.listen here. Its internal async iterator rejects on one
  // decryption/handler error and silently stops delivering every later event.
  // Consuming the raw streams lets us isolate each operation and supervise
  // the HTTP/2 push connection independently.
  const transport = eventTransportPolicy(process.env);
  // Health belongs to this authenticated session. Do not let a previous
  // listener's state make a new session look connected.
  pushHealthy = false;
  pushConnectedSince = 0;
  pushFallbackNotBefore = transport.pushEnabled ? Date.now() + PUSH_STARTUP_GRACE_MS : 0;
  if (transport.pushEnabled) {
    LineJsAdapter.renewPushStreams(push);
    void consumeTalkEvents(next, signal, push, talkDispatcher);
    void consumeSquareEvents(next, signal, push, squareDispatcher);
    void supervisePush(next, signal, push);
  } else {
    pushHealthy = false;
    pushConnectedSince = 0;
  }
  void consumeSystemAccountTracking(next, signal);
  if (transport.pollingEnabled) {
    // Keep one LINEJS Polling instance for the authenticated session. Its sync
    // revision/token state must survive push recovery cycles; recreating it
    // would restart fallback sync from revision/token zero.
    const polling = LineJsAdapter.createPollingSession(next);
    void consumeTalkPolling(next, signal, polling, talkDispatcher);
    void consumeSquarePolling(next, signal, polling, squareDispatcher);
  }
}

async function finishAuthentication(next: LineClient, restored: boolean) {
  // Validate the session against LINE before declaring it ready.  Full sync is
  // deliberately *not* part of this critical path: waiting for hundreds of
  // rooms here held the entire Tauri login screen in "starting" state.
  const profile: any = await next.getMyProfile();
  const account = await activateAccount(profile);
  database.consolidateTalkIdentityAliases(ACCOUNT_ID);
  client = next;
  currentProfile = presentOwnProfile(normalize(profile));
  database.upsertAccount(ACCOUNT_ID, {
    mid: String(profile?.mid ?? ""),
    displayName: String(profile?.displayName ?? ""),
  });
  prunePersistentCache(true);
  callManager.attach(next);
  attachEvents(next);
  const credentialStorage = await persistCredential(next);
  emit({
    type: "auth.ready",
    restored,
    clientIdentity: clientIdentity(),
    profile: currentProfile,
    authTokenPresent: Boolean(LineJsAdapter.authToken(next)),
    storage: credentialStorage,
    accountChanged: account.changed && !account.migrated,
  });
  // The first successful account-wide pass is durable. Subsequent launches
  // refresh changed/new rooms in the background without replaying all history.
  const fullCompleted = database.getSyncState(ACCOUNT_ID, "full-complete")?.status === "ready";
  const mode = !fullCompleted || process.env.LINEY_FULL_SYNC_ON_LOGIN === "1" ? "full" : "delta";
  if (process.env.LINEY_LIGHT_START !== "1") {
    void startSync(mode).catch(() => undefined);
  }
  void resumePendingOutbox();
}

async function startQrLogin(id: string) {
  if (loginInFlight) {
    replyError(id, new Error("login already in progress"));
    return;
  }
  loginInFlight = true;
  const generation = ++authGeneration;
  try {
    listenerAbort?.abort();
    client = null;
    const identity = clientIdentity();
    const next = await loginWithBrandedQR(
      {
        onReceiveQRUrl(url) {
          emit({ type: "auth.qr", url });
        },
        onPincodeRequest(pin) {
          emit({ type: "auth.pin", pin });
        },
      },
      {
        device: identity.device,
        storage: store,
      },
      identity,
    );
    if (generation !== authGeneration) return;
    await finishAuthentication(next, false);
    emit({ id, ok: true, result: { authenticated: true } });
  } catch (error) {
    replyError(id, error);
  } finally {
    loginInFlight = false;
  }
}

async function recoverPendingE2EE(next: LineClient): Promise<void> {
  const pending = database.listPendingE2EEMessages(ACCOUNT_ID, 500);
  let recovered = 0;
  let failed = 0;
  for (const stored of pending) {
    if (client !== next) break;
    const raw = stored.raw;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const encrypted = { ...(raw as Record<string, unknown>) };
    delete encrypted.text;
    delete encrypted.lineyE2eeDecodeError;
    try {
      const decrypted = await LineJsAdapter.decryptE2EEMessage(next, encrypted);
      if (client !== next) break;
      if (!decrypted || typeof decrypted !== "object") throw new Error("E2EE returned no message");
      await handleTalkMessage(next, LineJsAdapter.createTalkMessage(next, decrypted), decrypted, "recover");
      const updated = database.getMessage(ACCOUNT_ID, stored.chatId, stored.id);
      if ((updated?.raw as Record<string, unknown> | undefined)?.lineyE2eeDecodeError === true) failed++;
      else recovered++;
    } catch {
      failed++;
    }
  }
  if (client === next) {
    emit({ type: "event.e2ee.recovery", recovered, failed, checked: pending.length });
  }
}

async function importE2EEKeychainViaQr(id: string) {
  const activeClient = client;
  const targetMid = String(currentProfile?.mid ?? "").trim();
  if (!activeClient || !targetMid) {
    replyError(id, new Error("ต้องเชื่อมต่อบัญชี LINE ก่อนนำเข้าคีย์"));
    return;
  }
  if (loginInFlight) {
    replyError(id, new Error("มีการเข้าสู่ระบบอีกครั้งกำลังทำงานอยู่"));
    return;
  }

  loginInFlight = true;
  const generation = authGeneration;
  let temporary: ReturnType<typeof createTemporaryQrStorage> | null = null;
  try {
    const originalData: Record<string, unknown> = { ...store.getAll() };
    const refreshToken = await store.get("refreshToken");
    if (typeof refreshToken === "string" && refreshToken) {
      originalData.refreshToken = refreshToken;
    }
    temporary = createTemporaryQrStorage(originalData);
    const identity = clientIdentity();
    const next = await loginWithBrandedQR(
      {
        onReceiveQRUrl(url) {
          emit({ type: "auth.qr", url });
        },
        onPincodeRequest(pin) {
          emit({ type: "auth.pin", pin });
        },
      },
      {
        device: identity.device,
        storage: temporary.storage,
      },
      identity,
    );
    if (generation !== authGeneration || client !== activeClient) {
      throw new Error("เซสชัน LINE เปลี่ยนระหว่างนำเข้าคีย์ กรุณาลองใหม่");
    }

    const profile: any = await next.getMyProfile();
    const importedMid = String(profile?.mid ?? "").trim();
    if (!importedMid || importedMid !== targetMid) {
      throw new Error("QR ที่สแกนต้องเป็นบัญชี LINE เดียวกับที่เปิดอยู่บน Desktop");
    }

    const snapshot = temporary.snapshot();
    const aliasKey = `e2eeKeys:${targetMid}`;
    const activeKey = parseE2EEKeyData(snapshot[aliasKey]);
    const selectedKeyId = String(activeKey?.keyId ?? "").trim();
    const selectedKey = selectedKeyId ? snapshot[`e2eeKeys:${selectedKeyId}`] : undefined;
    const selectedRecord = parseE2EEKeyData(selectedKey);
    if (
      !selectedKeyId
      || !selectedRecord
      || typeof activeKey?.privKey !== "string"
      || typeof activeKey?.pubKey !== "string"
      || activeKey.privKey !== selectedRecord.privKey
      || activeKey.pubKey !== selectedRecord.pubKey
      || String(selectedRecord.keyId ?? "") !== selectedKeyId
    ) {
      throw new Error("LINE ไม่ได้ส่ง keychain ที่เลือกกลับมา กรุณาสแกน QR ใหม่จากมือถือ");
    }

    const keyGenerationCount = Object.entries(snapshot).filter(([key, value]) => {
      const record = key.startsWith("e2eeKeys:") && key !== aliasKey
        ? parseE2EEKeyData(value)
        : null;
      return typeof record?.privKey === "string" && typeof record.pubKey === "string";
    }).length;
    if (keyGenerationCount < 1) {
      throw new Error("ไม่พบคีย์ E2EE ที่นำเข้า");
    }

    // Write key-id entries before the account alias so a partial storage error
    // can never activate an incomplete keychain. Keep all older generations.
    const changedEntries = Object.entries(snapshot).filter(([key, value]) => {
      const oldValue = originalData[key];
      return JSON.stringify(oldValue) !== JSON.stringify(value);
    });
    changedEntries.sort(([left], [right]) => {
      if (left === aliasKey) return 1;
      if (right === aliasKey) return -1;
      return left.localeCompare(right);
    });
    for (const [key, value] of changedEntries) {
      await store.set(key, value as any);
    }
    const savedAlias = await store.get(aliasKey);
    const savedKey = parseE2EEKeyData(savedAlias);
    if (
      String(savedKey?.keyId ?? "") !== selectedKeyId
      || savedKey?.privKey !== activeKey?.privKey
      || savedKey?.pubKey !== activeKey?.pubKey
    ) {
      throw new Error("บันทึก keychain ลงเครื่องไม่สำเร็จ");
    }

    bindClientStorage(next, store);
    await finishAuthentication(next, false);
    void recoverPendingE2EE(next).catch((error) => emit({ type: "event.e2ee.recovery_error", error: errorInfo(error).message }));
    emit({
      id,
      ok: true,
      result: { authenticated: true, keychainImported: true, generations: keyGenerationCount },
    });
  } catch (error) {
    replyError(id, error);
  } finally {
    if (temporary) await temporary.clear().catch(() => undefined);
    loginInFlight = false;
  }
}

async function startPasswordLogin(id: string, rawEmail: unknown, rawPassword: unknown) {
  if (loginInFlight) {
    replyError(id, new Error("login already in progress"));
    return;
  }
  if (client) {
    emit({ id, ok: true, result: { authenticated: true, restored: true } });
    return;
  }

  let email = String(rawEmail ?? "").trim();
  let password = String(rawPassword ?? "");
  if (!email || !password) {
    replyError(id, new Error("email and password are required"));
    return;
  }

  loginInFlight = true;
  const generation = ++authGeneration;
  try {
    listenerAbort?.abort();
    client = null;
    const next = await loginWithPassword(
      {
        email,
        password,
        onPincodeRequest(pin) {
          emit({ type: "auth.pin", pin });
        },
      },
      {
        device: clientIdentity().device,
        storage: store,
      },
    );
    if (generation !== authGeneration) return;
    await finishAuthentication(next, false);
    emit({ id, ok: true, result: { authenticated: true } });
  } catch (error) {
    replyError(id, error);
  } finally {
    // Do not retain the user's password in the engine after the login attempt.
    email = "";
    password = "";
    loginInFlight = false;
  }
}

async function restoreToken(id: string, token: unknown) {
  if (client) {
    emit({ id, ok: true, result: { authenticated: true, restored: true } });
    return;
  }
  const generation = ++authGeneration;
  try {
    const next = await loginWithAuthToken(token as any, {
      device: clientIdentity().device,
      storage: store,
    });
    if (generation !== authGeneration) return;
    await finishAuthentication(next, true);
    emit({ id, ok: true, result: { authenticated: true } });
  } catch (error) {
    replyError(id, error);
  }
}

async function autoRestore() {
  const credential = readCredential();
  if (!credential) return;
  const generation = authGeneration;
  emit({ type: "auth.restoring" });
  try {
    const next = await loginWithAuthToken(credential as any, {
      device: clientIdentity().device,
      storage: store,
    });
    if (generation !== authGeneration) return;
    await finishAuthentication(next, true);
  } catch (error) {
    client = null;
    emit({
      type: "auth.restore_failed",
      error: errorInfo(error).message,
    });
  }
}

let restorePromise: Promise<void> = Promise.resolve();

function mediaTempPath(localId: string): string {
  const name = createHash("sha256").update(localId).digest("hex");
  return join(mediaUploadTempDir, `${name}.upload`);
}

async function stageMediaInput(params: any, localId: string): Promise<string> {
  const suppliedPath = String(params?.filePath ?? "").trim();
  if (suppliedPath) return suppliedPath;
  const bytes = decodeMediaBase64(String(params?.base64 ?? "").trim());
  ensurePrivateDirectory(mediaUploadTempDir);
  const path = mediaTempPath(localId);
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFileAsync(temp, bytes, { mode: 0o600, flag: "wx" });
    await renameAsync(temp, path);
    return path;
  } catch (error) {
    await unlinkAsync(temp).catch(() => undefined);
    throw error;
  }
}

function isOwnedMediaTemp(path: string): boolean {
  return path.startsWith(`${mediaUploadTempDir}/`);
}

async function removeOwnedMediaTemp(path: string | undefined): Promise<void> {
  if (!path || !isOwnedMediaTemp(path)) return;
  await unlinkAsync(path).catch(() => undefined);
}

async function clearMediaUploadTemp(): Promise<void> {
  await rmAsync(mediaUploadTempDir, { recursive: true, force: true }).catch(() => undefined);
}

function outboxKind(value: unknown, chatId: string): "dm" | "group" | "openchat" {
  if (String(value) === "openchat") return "openchat";
  if (String(value) === "dm") return "dm";
  if (String(value) === "group") return "group";
  return chatKindFor(chatId, false);
}

function serverIdFromResult(value: unknown): string | undefined {
  const normalized = normalize(value);
  if (!normalized || typeof normalized !== "object") return undefined;
  const record = normalized as Record<string, unknown>;
  for (const key of ["id", "messageId", "message_id", "objId"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  for (const key of [
    "createdSquareMessage",
    "createdThreadMessage",
    "createdMessage",
    "squareMessage",
    "message",
    "result",
    "data",
  ]) {
    const nested = serverIdFromResult(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

async function sendRemoteMessage(record: OutboxRecord): Promise<unknown> {
  if (!client || (!record.text && record.contentType === 0)) throw new Error("not authenticated");
  const options = {
    text: record.text,
    ...(record.contentType ? { contentType: record.contentType === 7 ? "STICKER" : record.contentType } : {}),
    ...(record.contentMetadata ? { contentMetadata: record.contentMetadata } : {}),
    ...(record.relatedMessageId ? { relatedMessageId: record.relatedMessageId } : {}),
  };
  if (record.kind === "openchat") {
    const chat: any = await LineJsAdapter.getSquareChat(client, record.chatId);
    return chat.sendMessage(options);
  }
  // Leave normal text sends unspecified so LINEJS can negotiate the recipient's
  // E2EE requirement and retry encrypted when LINE requires it. Forcing E2EE
  // can fail before the request when recipient key metadata is not available.
  return LineJsAdapter.sendTalkMessage(client, {
    to: record.chatId,
    ...options,
    // Stickers carry their payload in contentMetadata; an empty E2EE body is invalid.
    ...(record.contentType === 7 ? { e2ee: false } : {}),
  });
}

async function sendRemoteMedia(record: OutboxRecord, jobId: string, signal: AbortSignal): Promise<unknown> {
  if (!client || !record.filePath) throw new Error("media upload source is unavailable");
  const bytes = await mediaWorker.read({ filePath: record.filePath }, jobId, signal);
  mediaWorker.assertActive(signal);
  const blob = new Blob([bytes], { type: record.mime || "application/octet-stream" });
  emit({ type: "media.progress", jobId, phase: "uploading", done: 0, total: bytes.byteLength });
  const objectType = mediaObjectType(record.contentType, record.mime);
  const filename = record.filename || `${objectType}.bin`;
  const durationMs = record.durationMs;

  if (record.kind === "openchat") {
    mediaWorker.assertActive(signal);
    const uploaded = await LineJsAdapter.uploadObjTalk(client,
      record.chatId,
      objectType,
      blob,
      undefined,
      filename,
      durationMs,
    );
    mediaWorker.assertActive(signal);
    emit({ type: "media.progress", jobId, phase: "uploading", done: bytes.byteLength, total: bytes.byteLength });
    return { objId: uploaded.objId, objHash: uploaded.objHash };
  }

  // Talk media follows LINEJS's E2EE OBS path. Liney's adapter extends the
  // upstream helper with relatedMessageId so replying with media does not
  // silently downgrade the attachment to a plaintext OBS object.
  mediaWorker.assertActive(signal);
  const sent = await LineJsAdapter.sendTalkMediaE2EE(client, {
    to: record.chatId,
    oType: objectType,
    data: blob,
    filename,
    durationMs,
    ...(record.relatedMessageId ? { relatedMessageId: record.relatedMessageId } : {}),
  });
  mediaWorker.assertActive(signal);
  emit({ type: "media.progress", jobId, phase: "uploading", done: bytes.byteLength, total: bytes.byteLength });
  return sent;
}

async function sendOutbox(record: OutboxRecord): Promise<unknown> {
  record = { ...record, chatId: canonicalTalkChatId(record.chatId, record.kind) };
  const sending: OutboxRecord = {
    ...record,
    status: "sending",
    attempts: record.attempts + 1,
    updatedAt: Date.now(),
    lastError: undefined,
  };
  database.saveOutbox(ACCOUNT_ID, sending);
  database.updateMessageStatus(ACCOUNT_ID, record.chatId, record.localId, "sending");
  emit({ type: "message.sending", localId: record.localId, chatId: record.chatId });
  try {
    const result = await sendRemoteMessage(sending);
    const serverId = serverIdFromResult(result);
    database.deleteOutbox(ACCOUNT_ID, record.localId);
    try {
      database.reconcileMessage(ACCOUNT_ID, record.localId, {
        id: serverId ?? record.localId,
        chatId: record.chatId,
        kind: record.kind,
        text: record.text,
        filename: record.filename,
        isMine: true,
        createdTime: record.createdAt,
        contentType: record.contentType,
        replyToId: record.relatedMessageId,
        status: "sent",
      }, serverId);
    } catch {
      // A self-echo may have inserted the server row first; the event path is
      // authoritative in that race and the request still succeeded.
    }
    emit({ type: "message.sent", localId: record.localId, chatId: record.chatId, serverId });
    return result;
  } catch (error) {
    if (record.contentType === 7 && /USER_NOT_STICKER_OWNER|not owned/i.test(error instanceof Error ? error.message : String(error))) {
      const metadata = record.contentMetadata ?? {};
      forgetOwnedSticker(String(metadata.STKPKGID ?? ""), String(metadata.STKID ?? ""));
    }
    const uncertain = isUncertainSendError(error);
    const failureInfo = errorInfo(error);
    const failed: OutboxRecord = {
      ...sending,
      status: uncertain ? "unknown" : "failed",
      updatedAt: Date.now(),
      nextAttemptAt: Date.now() + retryDelayMs(sending.attempts),
      lastError: failureInfo.message,
    };
    database.saveOutbox(ACCOUNT_ID, failed);
    database.updateMessageStatus(ACCOUNT_ID, record.chatId, record.localId, failed.status);
    emit({
      type: "message.failed",
      localId: record.localId,
      chatId: record.chatId,
      status: failed.status,
      retryable: failureInfo.retryable,
      errorCode: failureInfo.code,
      errorMessage: failureInfo.message,
    });
    throw error;
  }
}

async function sendMediaOutbox(record: OutboxRecord): Promise<unknown> {
  record = { ...record, chatId: canonicalTalkChatId(record.chatId, record.kind) };
  const sending: OutboxRecord = {
    ...record,
    status: "sending",
    attempts: record.attempts + 1,
    updatedAt: Date.now(),
    lastError: undefined,
  };
  database.saveOutbox(ACCOUNT_ID, sending);
  database.updateMessageStatus(ACCOUNT_ID, record.chatId, record.localId, "sending");
  emit({ type: "message.sending", localId: record.localId, chatId: record.chatId, contentType: record.contentType });
  try {
    const result = await mediaWorker.run(record.localId, (signal) => sendRemoteMedia(sending, record.localId, signal));
    const serverId = serverIdFromResult(result);
    database.deleteOutbox(ACCOUNT_ID, record.localId);
    try {
      database.reconcileMessage(ACCOUNT_ID, record.localId, {
        id: serverId ?? record.localId,
        chatId: record.chatId,
        kind: record.kind,
        filename: record.filename,
        isMine: true,
        createdTime: record.createdAt,
        contentType: record.contentType,
        replyToId: record.relatedMessageId,
        status: "sent",
      }, serverId);
    } catch {
      // A self-echo may have inserted the server row first; the event path is
      // authoritative in that race and the request still succeeded.
    }
    await removeOwnedMediaTemp(record.filePath);
    emit({ type: "message.sent", localId: record.localId, chatId: record.chatId, serverId, contentType: record.contentType });
    return result;
  } catch (error) {
    const uncertain = isUncertainSendError(error);
    const failureInfo = errorInfo(error);
    const failed: OutboxRecord = {
      ...sending,
      status: uncertain ? "unknown" : "failed",
      updatedAt: Date.now(),
      nextAttemptAt: Date.now() + retryDelayMs(sending.attempts),
      lastError: failureInfo.message,
    };
    database.saveOutbox(ACCOUNT_ID, failed);
    database.updateMessageStatus(ACCOUNT_ID, record.chatId, record.localId, failed.status);
    emit({
      type: "message.failed",
      localId: record.localId,
      chatId: record.chatId,
      status: failed.status,
      retryable: failureInfo.retryable,
      errorCode: failureInfo.code,
      errorMessage: failureInfo.message,
      contentType: record.contentType,
    });
    throw error;
  }
}

async function reconcileUnknownOutbox(record: OutboxRecord): Promise<string | undefined> {
  record = { ...record, chatId: canonicalTalkChatId(record.chatId, record.kind) };
  const list = record.kind === "openchat"
    ? await fetchOpenChatMessagesNormalized(record.chatId, 100)
    : await fetchTalkMessagesWithFallback(record.chatId, 100);
  const matches = list.filter((message) => echoMatches(record, {
    chatId: record.chatId,
    kind: record.kind,
    contentType: Number(message.contentType ?? 0),
    text: message.text,
    filename: message.filename,
    createdTime: Number(message.createdTime ?? Date.now()),
    id: String(message.id ?? ""),
    relatedMessageId: message.replyToId ?? message.relatedMessageId,
  }));
  if (!matches.length) return undefined;
  const ranked = [...matches].sort((a, b) => Math.abs(Number(a.createdTime ?? 0) - record.createdAt) - Math.abs(Number(b.createdTime ?? 0) - record.createdAt));
  const match = ranked[0];
  const second = ranked[1];
  if (second && Math.abs(Number(second.createdTime ?? 0) - Number(match.createdTime ?? 0)) < 1_000) return undefined;
  database.reconcileMessage(ACCOUNT_ID, record.localId, {
    id: String(match.id),
    chatId: record.chatId,
    kind: record.kind,
    text: record.text,
    filename: record.filename,
    isMine: true,
    createdTime: record.createdAt,
    contentType: record.contentType,
    replyToId: record.relatedMessageId,
    status: "sent",
  }, String(match.id));
  database.deleteOutbox(ACCOUNT_ID, record.localId);
  await removeOwnedMediaTemp(record.filePath);
  emit({ type: "message.sent", localId: record.localId, chatId: record.chatId, serverId: String(match.id), reconciled: true, contentType: record.contentType });
  return String(match.id);
}

async function resumePendingOutbox(): Promise<void> {
  const pending = database.listPendingOutbox(ACCOUNT_ID);
  if (!pending.length || !client) return;
  await runPool(pending, 2, async (record) => {
    try {
      const current = database.getOutbox(ACCOUNT_ID, record.localId);
      if (!current) return;
      if (current.status === "unknown" || current.status === "sending") {
        const reconciled = await reconcileUnknownOutbox(current);
        if (reconciled) return;
      }
      const retryRecord = { ...current, status: "queued" as const, nextAttemptAt: undefined };
      if (retryRecord.contentType > 0) await sendMediaOutbox(retryRecord);
      else await sendOutbox(retryRecord);
    } catch {
      // A broken queued item must not block the rest of the outbox. The send
      // helpers persist the current state and emit the retryable failure.
    }
  });
}

function messageKind(value: unknown, chatId: string): "dm" | "group" | "openchat" {
  return outboxKind(value, chatId);
}

function requireMessageId(value: unknown, kind?: "dm" | "group" | "openchat"): string {
  const messageId = String(value ?? "").trim();
  if (!messageId) throw new Error("messageId is required");
  // Talk's thrift request is BigInt-backed.  Square/OpenChat keeps the id as
  // an opaque string, so do not reject a valid Square id just because it is
  // not decimal text.
  if (kind !== "openchat" && !/^\d+$/.test(messageId)) {
    throw new Error("LINE message id is not available yet");
  }
  return messageId;
}

function requireReactionType(value: unknown): number {
  const reaction = reactionTypeCode(value);
  if (![1, 2, 3, 4, 5, 6, 7].includes(reaction)) {
    throw new Error("unsupported reaction type");
  }
  return reaction;
}

function removeMessageCaches(messageId: string, isSquare: boolean): void {
  const prefix = `${isSquare ? "square" : "talk"}:`;
  mediaPreviewCache.delete(`${prefix}${messageId}`);
  messageMediaSourceCache.delete(`${prefix}${messageId}`);
}

async function removeMessageArtifacts(messageId: string, isSquare: boolean): Promise<void> {
  const key = `${isSquare ? "square" : "talk"}:${messageId}`;
  removeMessageCaches(messageId, isSquare);
  database.deleteMedia(ACCOUNT_ID, key);
  await mediaDiskCache.remove(key);
}

async function reactToMessage(
  chatId: string,
  kind: "dm" | "group" | "openchat",
  messageId: string,
  reactionInput: unknown,
): Promise<unknown> {
  if (!client) throw new Error("not authenticated");
  const reaction = requireReactionType(reactionInput);
  const numericId = requireMessageId(messageId, kind);
  let result: any;
  if (kind === "openchat") {
    result = await LineJsAdapter.reactToSquareMessage(client, {
      request: {
        reqSeq: 0,
        reactionType: reaction as any,
        messageId: numericId,
        squareChatMid: chatId,
      },
    });
  } else if (reaction === REACTION_CODES.UNDO) {
    result = await LineJsAdapter.cancelTalkReaction(client, {
      cancelReactionRequest: {
        reqSeq: await LineJsAdapter.getReqseq(client),
        messageId: BigInt(numericId),
      },
    });
  } else {
    result = await LineJsAdapter.reactToTalkMessage(client, {
      id: BigInt(numericId),
      reaction: reaction as any,
    });
  }

  const stored = database.getMessage(ACCOUNT_ID, chatId, numericId);
  const hasAuthoritativeStatus = kind === "openchat"
    && result?.status
    && typeof result.status === "object";
  const authoritative = hasAuthoritativeStatus
    ? squareReactionSummaries(result.status, midString(LineJsAdapter.profileMid(client)))
    : [];
  const reactions = hasAuthoritativeStatus
    ? authoritative
    : applyReactionToSummaries(stored?.reactions, reaction);
  database.updateMessageReactions(ACCOUNT_ID, chatId, numericId, reactions);
  emit({
    type: "event.message.reaction",
    source: kind === "openchat" ? "openchat" : "talk",
    chatId,
    messageId: numericId,
    reactions,
  });
  return { chatId, messageId: numericId, reaction, reactions, server: normalize(result) };
}

async function unsendMessage(chatId: string, kind: "dm" | "group" | "openchat", messageId: string): Promise<unknown> {
  if (!client) throw new Error("not authenticated");
  const numericId = requireMessageId(messageId, kind);
  const stored = database.getMessage(ACCOUNT_ID, chatId, numericId);
  if (!stored) throw new Error("message is not available in local history");
  if (!stored.isMine) throw new Error("cannot unsend another user's message");
  const result = kind === "openchat"
    ? await LineJsAdapter.unsendSquareMessage(client, { messageId: numericId, squareChatMid: chatId })
    : await LineJsAdapter.unsendTalkMessage(client, { messageId: numericId });
  database.markMessageUnsent(ACCOUNT_ID, chatId, numericId);
  await removeMessageArtifacts(numericId, kind === "openchat");
  emit({ type: "event.message.unsent", source: kind === "openchat" ? "openchat" : "talk", chatId, messageId: numericId });
  return { chatId, messageId: numericId, unsent: true, server: normalize(result) };
}

function isPrivateAssetAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    if (lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || /^fe[89ab]/.test(lower) || lower.startsWith("ff") || lower.startsWith("2001:db8:")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
    return mapped ? isPrivateAssetAddress(mapped) : false;
  }
  return true;
}

async function assertPublicAssetUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("asset URL must be public HTTPS");
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error("asset host is not public");
  if (isIP(host)) {
    if (isPrivateAssetAddress(host)) throw new Error("asset host is not public");
    return;
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateAssetAddress(record.address))) throw new Error("asset host resolves to a private address");
}

async function assertPublicLinkUrl(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("link URL must be public HTTP(S)");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("link host is not public");
  }
  if (isIP(host)) {
    if (isPrivateAssetAddress(host)) throw new Error("link host is not public");
    return;
  }
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length || records.some((record) => isPrivateAssetAddress(record.address))) {
    throw new Error("link host resolves to a private address");
  }
}

async function readResponseTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("link page exceeds 3 MB");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readResponseBytesLimited(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("asset exceeds 8 MB");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("asset exceeds 8 MB");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function fetchUiAssetDataUrl(rawUrl: string): Promise<{ dataUrl: string; mime: string; size: number }> {
  let url = new URL(rawUrl);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 5; redirect++) {
    await assertPublicAssetUrl(url);
    response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 5) throw new Error("asset redirect is invalid");
      url = new URL(location, url);
      continue;
    }
    break;
  }
  if (!response?.ok) throw new Error(`asset download failed (${response?.status ?? "network"})`);
  const mime = String(response.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  if (!mime.startsWith("image/")) throw new Error("asset is not an image");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 8 * 1024 * 1024) throw new Error("asset exceeds 8 MB");
  const bytes = await readResponseBytesLimited(response, 8 * 1024 * 1024);
  if (!bytes.length) throw new Error("asset exceeds 8 MB");
  const normalizedMime = detectImageMime(bytes, mime);
  if (!normalizedMime) throw new Error("asset is not an image");
  return { dataUrl: `data:${normalizedMime};base64,${bytes.toString("base64")}`, mime: normalizedMime, size: bytes.length };
}

function htmlMeta(html: string, prop: string): string | undefined {
  const expected = prop.trim().toLowerCase();
  for (const tagMatch of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    const tag = tagMatch[0].replace(/^<meta\b|\/?>$/gi, "");
    for (const match of tag.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g)) {
      const name = match[1].toLowerCase();
      if (!attributes.has(name)) {
        attributes.set(name, decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ""));
      }
    }
    const name = String(attributes.get("property") ?? attributes.get("name") ?? "").trim().toLowerCase();
    if (name !== expected) continue;
    const value = attributes.get("content")?.trim();
    if (value) return value;
  }
  return undefined;
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&", apos: "'", copy: "©", gt: ">", hellip: "…", ldquo: "“", lsquo: "‘",
    lt: "<", mdash: "—", nbsp: " ", ndash: "–", quot: '"', rdquo: "”", reg: "®", rsquo: "’", trade: "™",
  };
  let decoded = value;
  for (let pass = 0; pass < 8; pass++) {
    const next = decoded
      .replace(/&#(?:x([\da-f]{1,8})|(\d{1,10}));/gi, (_match, hex: string | undefined, decimal: string | undefined) => {
        const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
        return Number.isInteger(codePoint)
          && codePoint > 0
          && codePoint <= 0x10ffff
          && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : "\uFFFD";
      })
      .replace(/&([a-z][a-z0-9]+);/gi, (match, entity: string) => namedEntities[entity.toLowerCase()] ?? match);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function ogAbsolute(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined;
  try { return new URL(value, base).toString(); } catch { return undefined; }
}

async function fetchLinkPreview(rawUrl: string): Promise<Record<string, unknown>> {
  const initialUrl = new URL(rawUrl);
  if (!["http:", "https:"].includes(initialUrl.protocol)) throw new Error("link must be http(s)");
  // The v3 key refreshes previews saved before nested entity decoding.
  const cacheUrl = "v" + LINK_PREVIEW_CACHE_VERSION + ":" + initialUrl.toString();
  const cached = database.getLinkPreview(ACCOUNT_ID, cacheUrl, LINK_PREVIEW_CACHE_TTL_MS);
  if (cached) return cached;

  const requestKey = `${ACCOUNT_ID}:${cacheUrl}`;
  const failureUntil = linkPreviewFailureUntil.get(requestKey) ?? 0;
  if (failureUntil > Date.now()) throw new Error("link preview temporarily unavailable");
  if (failureUntil) linkPreviewFailureUntil.delete(requestKey);

  const existing = linkPreviewInflight.get(requestKey);
  if (existing) return existing;

  const task = (async () => {
    let url = initialUrl;
    let response: Response | undefined;
    for (let redirect = 0; redirect <= 5; redirect++) {
      // Validate every hop. Checking only the initial URL lets an attacker use
      // a public redirector to reach localhost or a private service.
      await assertPublicLinkUrl(url);
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "user-agent": "Liney/0.1 (+link preview)" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === 5) throw new Error("link redirect is invalid");
        url = new URL(location, url);
        continue;
      }
      break;
    }
    if (!response?.ok) throw new Error(`link fetch failed (${response?.status ?? "network"})`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > 3 * 1024 * 1024) throw new Error("link page exceeds 3 MB");
    const text = await readResponseTextLimited(response, 3 * 1024 * 1024);

    const titleText = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
    const title = htmlMeta(text, "og:title")
      ?? htmlMeta(text, "twitter:title")
      ?? (titleText ? decodeHtmlEntities(titleText.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim() : undefined);
    const description =
      htmlMeta(text, "og:description") ??
      htmlMeta(text, "description") ??
      htmlMeta(text, "twitter:description");
    const image = ogAbsolute(
      htmlMeta(text, "og:image:secure_url")
        ?? htmlMeta(text, "og:image")
        ?? htmlMeta(text, "og:image:url")
        ?? htmlMeta(text, "twitter:image"),
      url,
    );
    const siteName = htmlMeta(text, "og:site_name") ?? new URL(url).hostname;
    const preview: Record<string, unknown> = {
      url: new URL(url).toString(),
      title: (title ?? siteName ?? "").slice(0, 300),
      description: (description ?? "").slice(0, 500) || undefined,
      image,
      siteName: siteName ?? "",
    };
    database.saveLinkPreview(ACCOUNT_ID, cacheUrl, preview, LINK_PREVIEW_CACHE_MAX_ENTRIES);
    linkPreviewFailureUntil.delete(requestKey);
    return preview;
  })();

  linkPreviewInflight.set(requestKey, task);
  try {
    return await task;
  } catch (error) {
    linkPreviewFailureUntil.set(requestKey, Date.now() + LINK_PREVIEW_FAILURE_TTL_MS);
    trimMapOldest(linkPreviewFailureUntil, 256);
    throw error;
  } finally {
    linkPreviewInflight.delete(requestKey);
  }
}

function isCacheReadMethod(method: string): boolean {
  return method === "chat.list"
    || method === "chats.list"
    || method === "friends.list"
    || method === "openchat.list"
    || method === "call.history"
    || method === "message.list"
    || method === "messages.list";
}

async function serveCachedRequest(id: string, method: string, request: any): Promise<boolean> {
  if (method === "call.history") {
    const result = listCallHistory(Math.max(1, Math.min(Number(request?.params?.limit ?? 200), 500)));
    if (!result.length) return false;
    emit({ id, ok: true, result });
    return true;
  }

  if (method === "chat.list" || method === "chats.list") {
    if (preSyncedChats) {
      const synced = preSyncedChats;
      preSyncedChats = null;
      emit({ id, ok: true, result: synced });
      return true;
    }
    const cached = collapseTalkIdentityAliases(database.listConversationChats(ACCOUNT_ID));
    if (!cached.length) return false;
    emit({ id, ok: true, result: cached });
    if (client) refreshChatListInBackground("talk", loadChatsList);
    return true;
  }

  if (method === "friends.list") {
    if (preSyncedFriends) {
      const synced = preSyncedFriends;
      preSyncedFriends = null;
      emit({ id, ok: true, result: synced });
      return true;
    }
    const cached = collapseTalkIdentityAliases(database.listChats(ACCOUNT_ID, "dm"));
    if (!cached.length) return false;
    emit({ id, ok: true, result: cached });
    if (client) refreshChatListInBackground("friends", loadFriendsList);
    return true;
  }

  if (method === "openchat.list") {
    if (preSyncedOpenChats) {
      const synced = preSyncedOpenChats;
      preSyncedOpenChats = null;
      emit({ id, ok: true, result: synced });
      return true;
    }
    const cached = database.listChats(ACCOUNT_ID, "openchat");
    if (!cached.length) return false;
    emit({ id, ok: true, result: cached });
    if (client) refreshChatListInBackground("openchat", loadOpenChatList);
    return true;
  }

  if (method !== "message.list" && method !== "messages.list") return false;
  // A room can have newer metadata than the local SQLite message window when
  // a push operation was missed. Explicit refresh must bypass cache so the
  // authenticated handler can reconcile against LINE history.
  if (request?.params?.refresh === true) return false;
  const requestedChatId = String(request?.params?.chatId ?? "").trim();
  if (!requestedChatId) return false;
  const kind = String(request?.params?.kind ?? "talk");
  const chatId = canonicalTalkChatId(requestedChatId, kind);
  const limit = Math.max(1, Math.min(Number(request?.params?.limit ?? 50), MESSAGE_LIST_RESULT_LIMIT));
  const openchat = kind === "openchat";
  const cacheKey = `${openchat ? "openchat" : "talk"}:${chatId}`;
  const transient = preSyncedMessages.get(cacheKey);
  if (transient) {
    const visible = transient.filter((message: any) => !database.isMessageHidden(
      ACCOUNT_ID,
      chatId,
      openchat ? "openchat" : chatKindFor(chatId, false),
      String(message?.id ?? ""),
    ));
    if (openchat || !client || historySnapshotCoversSidebar(chatId, visible)) {
      preSyncedMessages.delete(cacheKey);
      const result = client
        ? await recoverMissingStickerMetadata(chatId, openchat, visible.slice(-limit), limit)
        : decorateStoredMessages(visible.slice(-limit));
      emit({ id, ok: true, result });
      return true;
    }
    // Empty or stale transient snapshots are misses when sidebar metadata
    // proves activity. Let the authenticated path exercise every history route.
    preSyncedMessages.delete(cacheKey);
  }

  const stored = database.listMessages(ACCOUNT_ID, chatId, limit);
  if (!stored.length || (client && !openchat && !historySnapshotCoversSidebar(chatId, stored))) return false;
  // SQLite is the hot path: render immediately, then repair optional sender /
  // legacy sticker metadata in a bounded background task. A cache hit must
  // never wait on LINE RPCs just because the session is online.
  const result = decorateStoredMessages(stored);
  emit({ id, ok: true, result });
  enrichCachedMessagesInBackground(chatId, openchat, stored, limit);
  // Message reads must not refresh the whole sidebar. Push/delta sync owns
  // conversation metadata; coupling the two creates a render/request loop.
  return true;
}

async function handle(request: any) {
  const id = String(request?.id ?? crypto.randomUUID());
  const method = String(request?.method ?? "");

  if (request?.version !== undefined && Number(request.version) !== PROTOCOL_VERSION) {
    replyError(id, new Error(`protocol version ${String(request.version)} is unsupported`));
    return;
  }

  if (method === "ping") {
    emit({ id, ok: true, result: { pong: true, protocolVersion: PROTOCOL_VERSION, linejsVersion: LINEJS_VERSION, processId: process.pid } });
    return;
  }

  // Logout must be able to cancel an in-progress session restore instead of
  // waiting behind the restore promise it is meant to invalidate.
  if (method === "auth.logout") {
    await clearLocalSession();
    emit({ type: "auth.logged_out" });
    emit({ id, ok: true, result: { authenticated: false } });
    return;
  }

  if (isCacheReadMethod(method) && await serveCachedRequest(id, method, request)) return;

  // Public image proxying does not require a LINE session. Handle it before
  // auth restore so a failed WebView image does not wait on startup network
  // work before the fallback can be resolved.
  if (method === "asset.preview") {
    const url = String(request?.params?.url ?? "").trim();
    if (!url) {
      replyError(id, new Error("url is required"));
      return;
    }
    try {
      emit({ id, ok: true, result: await fetchUiAssetDataUrl(url) });
    } catch (error) {
      replyError(id, error);
    }
    return;
  }

  await restorePromise;

  if (method === "capabilities") {
    const callStatus = callManager.status;
    const features = ["talk", "openchat", "media", "asset-proxy", "e2ee", "session-restore", "history-sqlite", "outbox", "talk-read-range", "e2ee-media"];
    if (callStatus.enabled) features.push("call-audio-1to1");
    if (callStatus.incomingAnswer) features.push("call-audio-incoming");
    features.push("album-read", "profile-update", "note-list", "note-create", "note-edit", "note-delete", "note-like", "note-comment", "note-image-upload", "group-rename", "group-invite", "group-leave", "friend-rename", "friend-favorite", "friend-mute", "profile-avatar-upload");
    emit({
      id,
      ok: true,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        linejsVersion: LINEJS_VERSION,
        device: clientIdentity().device,
        clientIdentity: clientIdentity(),
        features,
        authenticated: Boolean(client),
        storage: {
          mode: credentialPersistenceStatus(store),
          walletAvailable: store.walletAvailable,
        },
        call: callStatus,
      },
    });
    return;
  }

  if (method.startsWith("group.") || method.startsWith("friend.")) {
    if (!client) { replyError(id, new Error("not authenticated")); return; }
    try {
      const params = request?.params ?? {};
      let result: unknown;
      switch (method) {
        case "group.rename": result = await LineJsAdapter.renameGroup(client, params.chatId, params.name); break;
        case "group.invite": result = await LineJsAdapter.inviteGroupFriends(client, params.chatId, params.memberMids); break;
        case "group.leave": result = await LineJsAdapter.leaveGroup(client, params.chatId); break;
        case "friend.rename": result = await LineJsAdapter.renameFriend(client, params.mid, params.name); break;
        case "friend.favorite": result = await LineJsAdapter.setFriendFavorite(client, params.mid, params.favorite); break;
        case "friend.mute": result = await LineJsAdapter.setFriendMuted(client, params.mid, params.muted); break;
        default: throw new Error("Unknown group/friend method");
      }
      emit({ id, ok: true, result });
      void startSync("delta").catch(() => undefined);
    } catch (error) { replyError(id, error); }
    return;
  }

  if (method.startsWith("note.")) {
    if (!client) { replyError(id, new Error("not authenticated")); return; }
    try {
      const params = request?.params ?? {};
      const homeId = params.homeId;
      const postId = params.postId;
      const value = params.text;
      let result: unknown;
      switch (method) {
        case "note.list": result = await LineJsAdapter.listNotes(client, homeId, params.beforePostId); break;
        case "note.get": result = await LineJsAdapter.getNote(client, homeId, postId); break;
        case "note.create": await LineJsAdapter.createNote(client, homeId, value, params.imageData); result = { success: true }; break;
        case "note.update": await LineJsAdapter.updateNote(client, homeId, postId, value); result = { success: true }; break;
        case "note.delete": await LineJsAdapter.deleteNote(client, homeId, postId); result = { success: true }; break;
        case "note.like": await LineJsAdapter.likeNote(client, homeId, postId); result = { success: true }; break;
        case "note.comment": await LineJsAdapter.commentNote(client, homeId, postId, value); result = { success: true }; break;
        default: throw new Error("Unknown Note method");
      }
      emit({ id, ok: true, result });
    } catch (error) { replyError(id, error); }
    return;
  }

  if (method === "profile.avatar.upload") {
    if (!client) { replyError(id, new Error("not authenticated")); return; }
    try {
      const result = await LineJsAdapter.uploadProfileAvatar(client, request?.params?.imageData);
      if (!result.uploaded) throw new Error("LINE did not confirm avatar upload");
      const profile = await LineJsAdapter.getMyProfile(client);
      currentProfile = presentOwnProfile(normalize(profile), Date.now());
      emit({ id, ok: true, result: { profile: currentProfile, uploaded: true } });
    } catch (error) { replyError(id, error); }
    return;
  }

  if (method === "profile.update") {
    if (!client) { replyError(id, new Error("not authenticated")); return; }
    try {
      const values = request?.params?.values;
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new TypeError("profile.update requires a values object");
      }
      await LineJsAdapter.updateOwnProfile(client, values);
      const refreshed = await client.getMyProfile();
      currentProfile = presentOwnProfile(normalize(refreshed));
      emit({ id, ok: true, result: { profile: currentProfile } });
    } catch (error) { replyError(id, error); }
    return;
  }

  if (method === "auth.e2ee.qr_import") {
    void importE2EEKeychainViaQr(id);
    return;
  }

  if (method === "auth.qr.start") {
    if (client) {
      emit({ id, ok: true, result: { authenticated: true, restored: true } });
      return;
    }
    void startQrLogin(id);
    return;
  }

  if (method === "auth.password.start") {
    const email = request?.params?.email;
    const password = request?.params?.password;
    if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
      replyError(id, new Error("email and password are required"));
      return;
    }
    void startPasswordLogin(id, email, password);
    return;
  }

  if (method === "auth.token" || method === "auth.restore") {
    const token = request?.params?.token;
    if (!token) {
      replyError(id, new Error("token is required"));
      return;
    }
    void restoreToken(id, token);
    return;
  }

  if (method === "call.status") {
    emit({ id, ok: true, result: callManager.status });
    return;
  }

  if (method === "call.devices") {
    emit({ id, ok: true, result: callManager.devices });
    return;
  }

  if (method === "call.screenTargets") {
    emit({ id, ok: true, result: callManager.screenShareTargets });
    return;
  }

  if (method === "media.cancel") {
    const jobId = String(request?.params?.jobId ?? "");
    if (!jobId) {
      replyError(id, new Error("jobId is required"));
      return;
    }
    const cancelled = mediaWorker.cancel(jobId);
    emit({ id, ok: true, result: { jobId, cancelled } });
    return;
  }

  if (method === "link.preview") {
    const url = String(request?.params?.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) {
      replyError(id, new Error("url is required"));
      return;
    }
    try {
      emit({ id, ok: true, result: await fetchLinkPreview(url) });
    } catch (error) {
      replyError(id, error);
    }
    return;
  }

  if (method === "sticker.cache.clear") {
    ownedStickerCache = null;
    if (!stickerCatalogCache.clear()) {
      replyError(id, new Error("could not clear sticker cache"));
      return;
    }
    emit({ id, ok: true, result: { cleared: true } });
    return;
  }

  if (!client) {
    if (isCacheReadMethod(method)) {
      if ((method === "message.list" || method === "messages.list") && !String(request?.params?.chatId ?? "").trim()) {
        replyError(id, new Error("chatId is required"));
      } else {
        emit({ id, ok: true, result: [] });
      }
      return;
    }
    replyError(id, new Error("not authenticated"));
    return;
  }

  try {
    // Moa album operations are opt-in and read-only; they never run at startup.
    if (method === "album.list") {
      const cursor = String(request?.params?.cursor ?? "").trim() || undefined;
      emit({ id, ok: true, result: await LineJsAdapter.listLineAlbums(client, cursor) });
      return;
    }

    if (method === "album.photos") {
      const chatId = String(request?.params?.chatId ?? "").trim();
      const albumId = String(request?.params?.albumId ?? "").trim();
      const cursor = String(request?.params?.cursor ?? "").trim() || undefined;
      emit({ id, ok: true, result: await LineJsAdapter.listLineAlbumPhotos(client, { chatId, albumId, cursor }) });
      return;
    }

    if (method === "album.cover.preview") {
      const chatId = String(request?.params?.chatId ?? "").trim();
      const albumId = String(request?.params?.albumId ?? "").trim();
      emit({ id, ok: true, result: await LineJsAdapter.previewLineAlbumCover(client, { chatId, albumId }) });
      return;
    }

    if (method === "album.photo.preview") {
      const chatId = String(request?.params?.chatId ?? "").trim();
      const albumId = String(request?.params?.albumId ?? "").trim();
      const oid = String(request?.params?.oid ?? "").trim();
      emit({ id, ok: true, result: await LineJsAdapter.previewLineAlbumPhoto(client, { chatId, albumId, oid }) });
      return;
    }

    if (method === "profile.get") {
      const profile = currentProfile ?? await LineJsAdapter.getMyProfile(client);
      currentProfile = presentOwnProfile(normalize(profile));
      database.upsertAccount(ACCOUNT_ID, {
        mid: String((profile as any)?.mid ?? ""),
        displayName: String((profile as any)?.displayName ?? ""),
      });
      emit({ id, ok: true, result: currentProfile });
      return;
    }

    if (method === "chat.identity.merge") {
      const aliasInput = String(request?.params?.aliasMid ?? "").trim();
      const canonicalInput = String(request?.params?.canonicalMid ?? "").trim();
      if (!/^u[0-9a-f]{32}$/i.test(aliasInput) || !/^u[0-9a-f]{32}$/i.test(canonicalInput)) {
        throw new Error("เลือกแชตส่วนตัวสองรายการที่ต้องการรวม");
      }
      const aliasMid = aliasInput;
      const canonicalMid = canonicalTalkIdentityMid(canonicalInput);
      if (canonicalTalkIdentityMid(aliasMid) === canonicalMid) throw new Error("แชตสองรายการนี้ถูกรวมไว้แล้ว");
      if (!database.mergeTalkIdentity(ACCOUNT_ID, aliasMid, canonicalMid)) {
        throw new Error("ไม่พบแชตส่วนตัวทั้งสองรายการในข้อมูลเครื่องนี้");
      }
      for (const mid of new Set([aliasInput, canonicalInput, aliasMid, canonicalMid])) {
        talkMessageBoxCache.delete(mid);
        preSyncedMessages.delete("talk:" + mid);
        liveMessageOverlayKeys.delete("talk:" + mid);
      }
      const chats = collapseTalkIdentityAliases(database.listConversationChats(ACCOUNT_ID));
      database.upsertChats(ACCOUNT_ID, chats as DatabaseChat[]);
      emit({ type: "event.chats.updated", kind: "talk", chats });
      emit({ id, ok: true, result: { merged: true, canonicalMid } });
      return;
    }

    if (method === "chat.identity.merge") {
      const aliasInput = String(request?.params?.aliasMid ?? "").trim();
      const canonicalInput = String(request?.params?.canonicalMid ?? "").trim();
      if (!/^u[0-9a-f]{32}$/i.test(aliasInput) || !/^u[0-9a-f]{32}$/i.test(canonicalInput)) {
        throw new Error("เลือกแชตส่วนตัวสองรายการที่ต้องการรวม");
      }
      const aliasMid = aliasInput;
      const canonicalMid = canonicalTalkIdentityMid(canonicalInput);
      if (canonicalTalkIdentityMid(aliasMid) === canonicalMid) throw new Error("แชตสองรายการนี้ถูกรวมไว้แล้ว");
      if (!database.mergeTalkIdentity(ACCOUNT_ID, aliasMid, canonicalMid)) {
        throw new Error("ไม่พบแชตส่วนตัวทั้งสองรายการในข้อมูลเครื่องนี้");
      }
      for (const mid of new Set([aliasInput, canonicalInput, aliasMid, canonicalMid])) {
        talkMessageBoxCache.delete(mid);
        preSyncedMessages.delete("talk:" + mid);
        liveMessageOverlayKeys.delete("talk:" + mid);
      }
      const chats = collapseTalkIdentityAliases(database.listConversationChats(ACCOUNT_ID));
      database.upsertChats(ACCOUNT_ID, chats as DatabaseChat[]);
      emit({ type: "event.chats.updated", kind: "talk", chats });
      emit({ id, ok: true, result: { merged: true, canonicalMid } });
      return;
    }

    if (method === "chat.list" || method === "chats.list") {
      if (preSyncedChats) {
        const synced = preSyncedChats;
        preSyncedChats = null;
        emit({ id, ok: true, result: synced });
        return;
      }
      const cached = collapseTalkIdentityAliases(database.listConversationChats(ACCOUNT_ID));
      if (cached.length) {
        emit({ id, ok: true, result: cached });
        refreshChatListInBackground("talk", loadChatsList);
        return;
      }
      try {
        const result = await loadChatsList();
        emit({ id, ok: true, result });
      } catch (error) {
        if (cached.length) emit({ id, ok: true, result: cached });
        else throw error;
      }
      return;
    }

    if (method === "friends.sync_diagnostics") {
      emit({ id, ok: true, result: LineJsAdapter.getFriendSyncDiagnostics(client) });
      return;
    }

    if (method === "friends.sync_scan" || method === "friends.sync_retry") {
      if (method === "friends.sync_retry" && getSyncCoordinator().status().running) {
        throw new Error("FRIEND_SYNC_BUSY");
      }
      const retry = method === "friends.sync_retry";
      const recovered = await loadFriendsList(true, () => Boolean(client), retry);
      // For a retry this event is a delta; the UI merges resolved identities
      // into its existing friend/chat list without deleting cached contacts.
      emit({ type: "event.chats.updated", kind: "friends", chats: recovered });
      emit({ id, ok: true, result: LineJsAdapter.getFriendSyncDiagnostics(client) });
      return;
    }

    if (method === "friends.list") {
      if (preSyncedFriends) {
        const synced = preSyncedFriends;
        preSyncedFriends = null;
        emit({ id, ok: true, result: synced });
        return;
      }
      const cached = collapseTalkIdentityAliases(database.listChats(ACCOUNT_ID, "dm"));
      if (cached.length) {
        // Cache may contain non-friend dm as well; better to show cache than fail offline
        emit({ id, ok: true, result: cached });
        refreshChatListInBackground("friends", loadFriendsList);
        return;
      }
      try {
        const result = await loadFriendsList();
        emit({ id, ok: true, result });
      } catch (error) {
        if (cached.length) emit({ id, ok: true, result: cached });
        else throw error;
      }
      return;
    }

    if (method === "openchat.list") {
      if (preSyncedOpenChats) {
        const synced = preSyncedOpenChats;
        preSyncedOpenChats = null;
        emit({ id, ok: true, result: synced });
        return;
      }
      const cached = database.listChats(ACCOUNT_ID, "openchat");
      if (cached.length) {
        emit({ id, ok: true, result: cached });
        refreshChatListInBackground("openchat", loadOpenChatList);
        return;
      }
      try {
        const result = await loadOpenChatList();
        emit({ id, ok: true, result });
      } catch (error) {
        if (cached.length) emit({ id, ok: true, result: cached });
        else throw error;
      }
      return;
    }

    if (method === "friend.add_by_id") {
      const userId = String(request?.params?.userId ?? "").trim();
      if (!userId) throw new Error("LINE ID is required");
      if (userId.length > 100) throw new Error("LINE ID is too long");

      const contact: any = await LineJsAdapter.findContactBySearchIdOrTicketV3(client, userId);
      const mid = String(contact?.mid ?? "").trim();
      if (!mid.startsWith("u")) throw new Error("LINE ID นี้ไม่พบผู้ใช้ที่เพิ่มเป็นเพื่อนได้");
      await LineJsAdapter.addFriendByUserId(client, userId);

      // Refresh the durable friend cache so the new friend is immediately
      // available to New Chat without restarting Liney.
      const friends = await loadFriendsList(true);
      const friend = friends.find((item: any) => String(item?.id ?? "") === mid) ?? {
        id: mid,
        name: String(contact?.displayNameOverridden || contact?.displayName || userId),
        kind: "dm",
        avatarUrl: talkProfileImageUrl(mid, contact?.pictureStatus || contact?.picturePath),
        statusMessage: String(contact?.statusMessage ?? ""),
      };
      emit({ id, ok: true, result: friend });
      emit({ type: "event.chats.updated", kind: "friends", chats: friends });
      return;
    }

    if (method === "chat.create_group") {
      const name = String(request?.params?.name ?? "").trim();
      const selfMid = midString(LineJsAdapter.profileMid(client));
      const targetUserMids = [...new Set(
        (Array.isArray(request?.params?.memberMids) ? request.params.memberMids : [])
          .map((value: unknown) => String(value ?? "").trim())
          .filter((mid: string) => mid.startsWith("u") && mid !== selfMid),
      )];
      if (!name) throw new Error("group name is required");
      if (name.length > 50) throw new Error("group name must be 50 characters or fewer");
      if (!targetUserMids.length) throw new Error("select at least one friend");
      if (targetUserMids.length > 100) throw new Error("too many members selected");

      const created: any = await LineJsAdapter.createTalkChat(client, name, targetUserMids);
      const createdMid = String(created?.chat?.chatMid ?? "").trim();
      // Re-read Talk metadata after creation so the returned row has the same
      // normalized shape as the rest of Liney and is persisted to SQLite.
      const chats = await loadChatsList(true);
      const chat = chats.find((item: any) => String(item?.id ?? "") === createdMid) ?? {
        id: createdMid,
        name: String(created?.chat?.chatName || name),
        kind: "group",
        avatarUrl: cdnUrl(created?.chat?.picturePath),
        preview: "กลุ่มใหม่",
        unread: 0,
        lastMessageTime: Date.now(),
      };
      emit({ id, ok: true, result: chat });
      emit({ type: "event.chats.updated", kind: "talk", chats });
      return;
    }

    if (method === "openchat.create") {
      const name = String(request?.params?.name ?? "").trim();
      const description = String(request?.params?.description ?? "").trim();
      const searchable = request?.params?.searchable !== false;
      if (!name) throw new Error("OpenChat name is required");
      if (name.length > 50) throw new Error("OpenChat name must be 50 characters or fewer");
      if (description.length > 500) throw new Error("OpenChat description is too long");

      const displayName = String(currentProfile?.displayName ?? "Liney").trim() || "Liney";
      const created: any = await LineJsAdapter.createSquare(client, {
        squareName: name,
        displayName,
        description: description || undefined,
        searchable,
      });
      const squareChat = created?.squareChat ?? {};
      const createdMid = String(squareChat?.squareChatMid ?? "").trim();
      const openChats = await loadOpenChatList(true);
      const chat = openChats.find((item: any) => String(item?.id ?? "") === createdMid) ?? {
        id: createdMid,
        name: String(squareChat?.name || name),
        kind: "openchat",
        avatarUrl: cdnUrl(squareChat?.chatImageObsHash),
        preview: "OpenChat ใหม่",
        unread: 0,
        memberCount: 1,
        lastMessageTime: 0,
      };
      if (!chat.id) throw new Error("LINE did not return the created OpenChat id");
      emit({ id, ok: true, result: chat });
      emit({ type: "event.chats.updated", kind: "openchat", chats: openChats });
      return;
    }

    if (method === "call.history") {
      emit({
        id,
        ok: true,
        result: listCallHistory(Math.max(1, Math.min(Number(request?.params?.limit ?? 200), 500))),
      });
      return;
    }

    if (method === "sync.status") {
      emit({
        id,
        ok: true,
        result: {
          state: database.getSyncState(ACCOUNT_ID, "account"),
          stats: database.stats(ACCOUNT_ID),
        },
      });
      return;
    }

    if (method === "sync.start") {
      void startSync()
        .then(() => emit({ id, ok: true, result: { started: true } }))
        .catch((error) => replyError(id, error));
      return;
    }

    if (method === "sync.cancel") {
      getSyncCoordinator().cancel();
      invalidateChatListRefreshes();
      preSyncedChats = null;
      preSyncedFriends = null;
      preSyncedOpenChats = null;
      preSyncedMessages.clear();
      emit({ id, ok: true, result: { cancelled: true } });
      return;
    }

    if (method === "message.history_candidates") {
      const requestedChatId = String(request?.params?.chatId ?? "");
      const chatId = canonicalTalkIdentityMid(requestedChatId);
      if (!chatId) throw new Error("chatId is required");
      emit({
        id,
        ok: true,
        result: database.listTalkHistoryCandidates(ACCOUNT_ID, chatId, 1000),
      });
      return;
    }

    if (method === "message.list" || method === "messages.list") {
      const requestedChatId = String(request?.params?.chatId ?? "");
      const kind = String(request?.params?.kind ?? "talk");
      const chatId = kind === "openchat" ? requestedChatId : canonicalTalkIdentityMid(requestedChatId);
      const limit = Math.max(1, Math.min(Number(request?.params?.limit ?? 50), MESSAGE_LIST_RESULT_LIMIT));
      const refresh = request?.params?.refresh === true;
      if (!chatId) throw new Error("chatId is required");

      const cacheKey = `${kind === "openchat" ? "openchat" : "talk"}:${chatId}`;
      const storedBeforeRefresh = refresh ? database.listMessages(ACCOUNT_ID, chatId, 100) : [];
      const knownBeforeRefresh = new Set(storedBeforeRefresh.map((message) => String(message.id)));
      const newestBeforeRefresh = storedBeforeRefresh.reduce(
        (latest, message) => Math.max(latest, Number(message.createdTime ?? 0)),
        0,
      );
      const cached = refresh ? undefined : preSyncedMessages.get(cacheKey);
      if (cached && (kind === "openchat" || historySnapshotCoversSidebar(chatId, cached))) {
        preSyncedMessages.delete(cacheKey);
        const visibleCached = cached.filter((message: any) => !database.isMessageHidden(
          ACCOUNT_ID,
          chatId,
          kind === "openchat" ? "openchat" : chatKindFor(chatId, false),
          String(message?.id ?? ""),
        ));
        const withStickers = await recoverMissingStickerMetadata(
          chatId,
          kind === "openchat",
          visibleCached.slice(-limit),
          limit,
        );
        emit({ id, ok: true, result: withStickers });
        return;
      }
      if (cached) preSyncedMessages.delete(cacheKey);

      const stored = refresh
        ? []
        : await enrichStoredTalkSenders(database.listMessages(ACCOUNT_ID, chatId, limit));
      if (stored.length && (kind === "openchat" || !client || historySnapshotCoversSidebar(chatId, stored))) {
        for (const message of stored) {
          if (message.raw && Number(message.contentType ?? 0) === 1) {
            rememberMessageMedia(message.raw, kind === "openchat");
          }
        }
        const withStickers = await recoverMissingStickerMetadata(
          chatId,
          kind === "openchat",
          stored,
          limit,
        );
        emit({ id, ok: true, result: withStickers });
        return;
      }

      if (refresh && kind !== "openchat") {
        // Force a fresh MessageBox cursor as well; otherwise an old cached
        // cursor can cap getPreviousMessages at the same stale message.
        talkMessageBoxCache.delete(chatId);
      }
      const result = kind === "openchat"
        ? await fetchOpenChatMessagesNormalized(chatId, limit)
        : await fetchTalkMessagesWithFallback(chatId, limit, refresh);
      const visibleResult = result.filter((message: any) => !database.isMessageHidden(
        ACCOUNT_ID,
        chatId,
        kind === "openchat" ? "openchat" : chatKindFor(chatId, false),
        String(message?.id ?? ""),
      ));
      persistNormalizedMessages(chatId, kind === "openchat", visibleResult);
      if (refresh && newestBeforeRefresh > 0) {
        // A forced history reconciliation means the live stream missed at
        // least part of this room. Apply only messages that were not already
        // in SQLite and are newer than our previous tail so preview/time/unread
        // survive restarts without double-counting repeated refreshes.
        const recovered = visibleResult
          .filter((message: any) => !knownBeforeRefresh.has(String(message?.id ?? ""))
            && Number(message?.createdTime ?? 0) > newestBeforeRefresh)
          .sort((left: any, right: any) => Number(left?.createdTime ?? 0) - Number(right?.createdTime ?? 0));
        for (const message of recovered) {
          database.recordMessageActivity(ACCOUNT_ID, {
            chatId,
            kind: kind === "openchat" ? "openchat" : chatKindFor(chatId, false),
            name: message?.senderName,
            avatarUrl: message?.senderAvatarUrl,
            preview: compactPreview(message?.text, message?.contentType, message?.raw),
            createdTime: finiteMessageTime(message?.createdTime),
            isMine: Boolean(message?.isMine),
            isNew: true,
          });
        }
      }
      const localFallback = refresh
        ? decorateStoredMessages(storedBeforeRefresh)
        : stored;
      const shouldMergeLocal = localFallback.length > 0 && (
        refresh
        || (kind !== "openchat" && !historySnapshotCoversSidebar(chatId, visibleResult))
      );
      const responseMessages = shouldMergeLocal
        ? mergeHistorySnapshots(localFallback, visibleResult)
        : visibleResult;
      emit({ id, ok: true, result: responseMessages.slice(-limit) });
      return;
    }

    if (method === "message.history") {
      const requestedChatId = String(request?.params?.chatId ?? "").trim();
      const kind = String(request?.params?.kind ?? "talk");
      if (kind === "openchat") throw new Error("Talk history pagination does not support OpenChat");
      const chatId = canonicalTalkIdentityMid(requestedChatId);
      const beforeMessageId = String(request?.params?.beforeMessageId ?? "").trim();
      const beforeCreatedTime = Number(request?.params?.beforeCreatedTime);
      const limit = Math.max(1, Math.min(Number(request?.params?.limit ?? 50), MESSAGE_LIST_RESULT_LIMIT));
      if (!chatId || !beforeMessageId || !Number.isFinite(beforeCreatedTime) || beforeCreatedTime <= 0) {
        throw new Error("chatId, beforeMessageId and beforeCreatedTime are required");
      }
      const page = await loadTalkMessagesBefore(chatId, {
        messageId: beforeMessageId,
        createdTime: beforeCreatedTime,
      }, limit);
      emit({ id, ok: true, result: page });
      return;
    }

    if (method === "message.read_state") {
      const requestedChatId = String(request?.params?.chatId ?? "").trim();
      const kind = String(request?.params?.kind ?? "talk");
      const chatId = canonicalTalkChatId(requestedChatId, kind);
      const rawMessageIds = Array.isArray(request?.params?.messageIds) ? request.params.messageIds : [];
      const messageIds = [...new Set(rawMessageIds.map((value: unknown) => String(value ?? "").trim()).filter(Boolean))].slice(0, 200);
      if (!chatId) throw new Error("chatId is required");
      if (kind === "openchat" || !messageIds.length) {
        emit({ id, ok: true, result: [] });
        return;
      }
      const ranges = await LineJsAdapter.getTalkMessageReadRanges(client, [chatId]);
      const range = ranges.find((item) => item.chatId === chatId);
      const selfMid = midString(LineJsAdapter.profileMid(client));
      emit({ id, ok: true, result: talkReadStateForMessages(range, messageIds, selfMid) });
      return;
    }

    if (method === "message.react") {
      const requestedChatId = String(request?.params?.chatId ?? "").trim();
      const kind = messageKind(request?.params?.kind, requestedChatId);
      const chatId = canonicalTalkChatId(requestedChatId, kind);
      const messageId = String(request?.params?.messageId ?? "").trim();
      if (!chatId) throw new Error("chatId is required");
      const result = await reactToMessage(chatId, kind, messageId, request?.params?.reaction);
      emit({ id, ok: true, result: normalize(result) });
      return;
    }

    if (method === "message.delete_for_me" || method === "message.deleteForMe") {
      const requestedChatId = String(request?.params?.chatId ?? "").trim();
      const kind = messageKind(request?.params?.kind, requestedChatId);
      const chatId = canonicalTalkChatId(requestedChatId, kind);
      const messageId = String(request?.params?.messageId ?? "").trim();
      if (!chatId || !messageId) throw new Error("chatId and messageId are required");
      database.hideMessageForMe(ACCOUNT_ID, chatId, kind, messageId);
      const cacheKey = `${kind === "openchat" ? "openchat" : "talk"}:${chatId}`;
      preSyncedMessages.delete(cacheKey);
      await removeMessageArtifacts(messageId, kind === "openchat");
      emit({ type: "event.message.removed", source: kind === "openchat" ? "openchat" : "talk", chatId, messageId, scope: "local" });
      emit({ id, ok: true, result: { chatId, messageId, deletedForMe: true } });
      return;
    }

    if (method === "message.unsend" || method === "message.cancel") {
      const requestedChatId = String(request?.params?.chatId ?? "").trim();
      const kind = messageKind(request?.params?.kind, requestedChatId);
      const chatId = canonicalTalkChatId(requestedChatId, kind);
      const messageId = String(request?.params?.messageId ?? "").trim();
      if (!chatId) throw new Error("chatId is required");
      const result = await unsendMessage(chatId, kind, messageId);
      emit({ id, ok: true, result: normalize(result) });
      return;
    }

    if (method === "media.preview" || method === "media.preview.get") {
      const messageId = String(request?.params?.messageId ?? "");
      const kind = String(request?.params?.kind ?? "talk");
      const requestedChatId = String(request?.params?.chatId ?? "").trim();
      const chatId = requestedChatId ? canonicalTalkChatId(requestedChatId, kind) : undefined;
      if (!messageId) throw new Error("messageId is required");
      const dataUrl = await getImagePreviewDataUrl(
        messageId,
        kind === "openchat",
        chatId,
        Boolean(request?.params?.refresh),
      );
      emit({ id, ok: true, result: { dataUrl } });
      return;
    }

    if (method === "chat.markRead" || method === "chat.mark_read") {
      const requestedChatId = String(request?.params?.chatId ?? "");
      const kind = String(request?.params?.kind ?? "talk");
      const chatId = kind === "openchat" ? requestedChatId : canonicalTalkIdentityMid(requestedChatId);
      let messageId = String(request?.params?.messageId ?? "");
      if (!chatId) throw new Error("chatId is required");

      if (kind === "openchat") {
        if (!messageId) {
          try {
            const status: any = await LineJsAdapter.getSquareChatStatus(client, {
              request: { squareChatMid: chatId },
            });
            messageId = String(status?.chatStatus?.lastMessage?.message?.id ?? "");
          } catch {
            messageId = "";
          }
        }
        if (messageId) {
          await LineJsAdapter.markSquareMessageRead(client, {
            request: { squareChatMid: chatId, messageId },
          });
        } else {
          // Fallback for rooms whose latest message is unavailable.
          await LineJsAdapter.markSquareChatsRead(client, {
            request: { chatMids: [chatId] },
          });
        }
      } else {
        if (!messageId) {
          try {
            const recent: any[] = await LineJsAdapter.getRecentMessages(client, {
              messageBoxId: chatId,
              messagesCount: 1,
            });
            messageId = String(recent?.[0]?.id ?? "");
          } catch {
            messageId = "";
          }
        }
        if (messageId) {
          await LineJsAdapter.markTalkMessageRead(client, chatId, messageId);
        }
      }
      database.markChatRead(ACCOUNT_ID, chatId);
      const cachedChats = kind === "openchat" ? preSyncedOpenChats : preSyncedChats;
      const cachedChat = cachedChats?.find((chat) => String(chat?.id ?? "") === chatId);
      if (cachedChat) cachedChat.unread = 0;
      emit({ id, ok: true, result: { chatId, messageId, read: true } });
      return;
    }

    if (method === "message.send") {
      const requestedChatId = String(request?.params?.chatId ?? "");
      const kind = outboxKind(request?.params?.kind, requestedChatId);
      const chatId = canonicalTalkChatId(requestedChatId, kind);
      const text = String(request?.params?.text ?? "");
      const localId = String(request?.params?.localId ?? crypto.randomUUID());
      const createdAt = Number(request?.params?.createdAt ?? Date.now());
      const relatedMessageId = String(request?.params?.relatedMessageId ?? "").trim() || undefined;
      if (!chatId || !text) throw new Error("chatId and text are required");
      if (database.getOutbox(ACCOUNT_ID, localId)) throw new Error("a message with this localId already exists");
      const record: OutboxRecord = {
        localId,
        chatId,
        kind,
        contentType: 0,
        text,
        fingerprint: messageFingerprint({
          chatId,
          kind,
          contentType: 0,
          text,
          createdAt,
          sequence: Number(request?.params?.sequence ?? 0),
          relatedMessageId,
        }),
        status: "queued",
        attempts: 0,
        createdAt,
        updatedAt: Date.now(),
        relatedMessageId,
      };
      database.saveOutbox(ACCOUNT_ID, record);
      database.upsertMessage(ACCOUNT_ID, {
        id: localId,
        chatId,
        kind,
        text,
        isMine: true,
        createdTime: createdAt,
        contentType: 0,
        replyToId: relatedMessageId,
        status: "sending",
      });
      const result = await sendOutbox(record);
      emit({ id, ok: true, result: normalize(result), localId });
      return;
    }

    if (method === "message.sendSticker") {
      const requestedChatId = String(request?.params?.chatId ?? "");
      const kind = outboxKind(request?.params?.kind, requestedChatId);
      const chatId = canonicalTalkChatId(requestedChatId, kind);
      const localId = String(request?.params?.localId ?? crypto.randomUUID());
      const createdAt = Number(request?.params?.createdAt ?? Date.now());
      const packageId = String(request?.params?.packageId ?? "").trim();
      const stickerId = String(request?.params?.stickerId ?? "").trim();
      const version = String(request?.params?.version ?? "1").trim() || "1";
      const option = String(request?.params?.option ?? "").trim().toUpperCase();
      const relatedMessageId = String(request?.params?.relatedMessageId ?? "").trim() || undefined;
      if (!chatId || !/^\d{1,20}$/.test(packageId) || !/^\d{1,20}$/.test(stickerId)) {
        throw new Error("chatId, packageId and stickerId are required");
      }
      if (packageId === "30563" && stickerId === "651698630") {
        throw new Error("Sticker Arranging cannot be recreated outside the LINE mobile app");
      }
      if (database.getOutbox(ACCOUNT_ID, localId)) throw new Error("a message with this localId already exists");
      const contentMetadata = {
        STKPKGID: packageId,
        STKID: stickerId,
        STKVER: version,
        STKTXT: "[Sticker]",
        ...(option ? { STKOPT: option } : {}),
      };
      const record: OutboxRecord = {
        localId,
        chatId,
        kind,
        contentType: 7,
        text: "[Sticker]",
        contentMetadata,
        fingerprint: messageFingerprint({ chatId, kind, contentType: 7, text: `${packageId}:${stickerId}`, createdAt, sequence: Number(request?.params?.sequence ?? 0), relatedMessageId }),
        status: "queued",
        attempts: 0,
        createdAt,
        updatedAt: Date.now(),
        relatedMessageId,
      };
      database.saveOutbox(ACCOUNT_ID, record);
      database.upsertMessage(ACCOUNT_ID, {
        id: localId,
        chatId,
        kind,
        text: record.text,
        isMine: true,
        createdTime: createdAt,
        contentType: 7,
        replyToId: relatedMessageId,
        status: "sending",
        raw: { contentType: "STICKER", contentMetadata },
      });
      const result = await sendOutbox(record);
      emit({ id, ok: true, result: normalize(result), localId });
      return;
    }

    if (method === "sticker.catalog") {
      // The picker needs every entry; 36 recent stickers are not a full pack.
      emit({ id, ok: true, result: await listOwnedStickers() });
      return;
    }

    if (method === "sticker.recent") {
      // Preserve compatibility with older Liney clients.
      const limit = Math.max(1, Math.min(Number(request?.params?.limit ?? 240), 1_000));
      emit({ id, ok: true, result: (await listOwnedStickers()).slice(0, limit) });
      return;
    }

    if (method === "emoji.recent") {
      emit({ id, ok: true, result: database.listRecentEmoji(ACCOUNT_ID, Number(request?.params?.limit ?? 72)) });
      return;
    }

    if (method === "message.sendEmoji") {
      const requestedChatId = String(request?.params?.chatId ?? "");
      const kind = outboxKind(request?.params?.kind, requestedChatId);
      const chatId = canonicalTalkChatId(requestedChatId, kind);
      const localId = String(request?.params?.localId ?? crypto.randomUUID());
      const createdAt = Number(request?.params?.createdAt ?? Date.now());
      const productId = String(request?.params?.productId ?? "").trim();
      const sticonId = String(request?.params?.sticonId ?? "").trim();
      const version = Number(request?.params?.version ?? 1);
      const resourceType = String(request?.params?.resourceType ?? "STATIC").trim().toUpperCase() || "STATIC";
      if (!chatId || !/^\d{1,30}$/.test(productId) || !/^\d{1,30}$/.test(sticonId)) {
        throw new Error("chatId, productId and sticonId are required");
      }
      if (database.getOutbox(ACCOUNT_ID, localId)) throw new Error("a message with this localId already exists");
      const text = "(liney)";
      const contentMetadata = {
        REPLACE: JSON.stringify({ sticon: { resources: [{ S: 0, E: text.length, productId, sticonId, version: Number.isFinite(version) ? version : 1, resourceType }] } }),
        STICON_OWNERSHIP: JSON.stringify([productId]),
      };
      const record: OutboxRecord = {
        localId, chatId, kind, contentType: 0, text, contentMetadata,
        fingerprint: messageFingerprint({ chatId, kind, contentType: 0, text: `emoji:${productId}:${sticonId}`, createdAt, sequence: Number(request?.params?.sequence ?? 0) }),
        status: "queued", attempts: 0, createdAt, updatedAt: Date.now(),
      };
      database.saveOutbox(ACCOUNT_ID, record);
      database.upsertMessage(ACCOUNT_ID, {
        id: localId, chatId, kind, text, isMine: true, createdTime: createdAt, contentType: 0, status: "sending",
        raw: { contentType: "NONE", text, contentMetadata },
      });
      const result = await sendOutbox(record);
      emit({ id, ok: true, result: normalize(result), localId });
      return;
    }

    if (method === "message.retry") {
      const localId = String(request?.params?.localId ?? "");
      if (!localId) throw new Error("localId is required");
      const record = database.getOutbox(ACCOUNT_ID, localId);
      if (!record) throw new Error("outbox message not found");
      if (record.status === "unknown") {
        const reconciled = await reconcileUnknownOutbox(record);
        if (reconciled) {
          emit({ id, ok: true, result: { reconciled: true, serverId: reconciled }, localId });
          return;
        }
      }
      const retryRecord = { ...record, status: "queued" as const, nextAttemptAt: undefined };
      const result = record.contentType > 0
        ? await sendMediaOutbox(retryRecord)
        : await sendOutbox(retryRecord);
      emit({ id, ok: true, result: normalize(result), localId });
      return;
    }

    if (method === "media.send" || method === "media.image.send") {
      const requestedChatId = String(request?.params?.chatId ?? "");
      const kind = outboxKind(request?.params?.kind ?? "talk", requestedChatId);
      const chatId = canonicalTalkChatId(requestedChatId, kind);
      const filename = String(request?.params?.filename ?? "image.jpg");
      const mime = String(request?.params?.mime ?? "image/jpeg");
      const contentType = mediaContentType(request?.params, mime);
      const localId = String(request?.params?.localId ?? request?.params?.jobId ?? crypto.randomUUID());
      const relatedMessageId = String(request?.params?.relatedMessageId ?? "").trim() || undefined;
      if (!chatId) throw new Error("chatId is required");
      if (database.getOutbox(ACCOUNT_ID, localId)) throw new Error("a message with this localId already exists");
      const filePath = await stageMediaInput(request?.params, localId);
      const record: OutboxRecord = {
        localId,
        chatId,
        kind,
        contentType,
        filePath,
        filename,
        mime,
        durationMs: Number(request?.params?.durationMs ?? 0) > 0 ? Number(request?.params?.durationMs) : undefined,
        fingerprint: messageFingerprint({
          chatId,
          kind,
          contentType,
          createdAt: Number(request?.params?.createdAt ?? Date.now()),
          sequence: Number(request?.params?.sequence ?? 0),
          relatedMessageId,
        }),
        status: "queued",
        attempts: 0,
        createdAt: Number(request?.params?.createdAt ?? Date.now()),
        updatedAt: Date.now(),
        relatedMessageId,
      };
      database.saveOutbox(ACCOUNT_ID, record);
      database.upsertMessage(ACCOUNT_ID, {
        id: localId,
        chatId,
        kind: record.kind,
        isMine: true,
        createdTime: record.createdAt,
        contentType,
        replyToId: relatedMessageId,
        status: "sending",
      });
      const result = await sendMediaOutbox(record);
      emit({ id, ok: true, result: normalize(result), localId, jobId: localId });
      return;
    }

    if (method === "call.start") {
      const peer = String(request?.params?.peer ?? request?.params?.to ?? "");
      if (!peer) throw new Error("peer is required");
      const requestedKind = String(request?.params?.kind ?? "AUDIO").toUpperCase();
      if (requestedKind !== "AUDIO" && requestedKind !== "VIDEO") {
        throw new Error("call kind must be AUDIO or VIDEO");
      }
      const result = await callManager.start(peer, requestedKind);
      emit({ id, ok: true, result });
      return;
    }

    if (method === "call.accept") {
      const requestedMode = String(request?.params?.mode ?? "AUDIO").toUpperCase();
      if (requestedMode !== "AUDIO" && requestedMode !== "VIDEO") {
        throw new Error("call accept mode must be AUDIO or VIDEO");
      }
      const result = await callManager.accept(requestedMode);
      emit({ id, ok: true, result: { accepted: true, ...result } });
      return;
    }

    if (method === "call.reject") {
      const result = await callManager.reject();
      emit({ id, ok: true, result });
      return;
    }

    if (method === "call.setOutput") {
      const result = await callManager.setOutputTarget(request?.params?.target);
      emit({ id, ok: true, result });
      return;
    }

    if (method === "call.end") {
      await callManager.stop("user-ended");
      emit({ id, ok: true, result: { ended: true } });
      return;
    }

    if (method === "call.setMuted") {
      await callManager.setMuted(Boolean(request?.params?.muted));
      emit({ id, ok: true, result: { muted: Boolean(request?.params?.muted) } });
      return;
    }

    if (method === "call.setVideo") {
      const result = await callManager.setVideoEnabled(Boolean(request?.params?.enabled));
      emit({ id, ok: true, result });
      return;
    }

    if (method === "call.setScreenShare") {
      const result = await callManager.setScreenShareEnabled(
        Boolean(request?.params?.enabled),
        request?.params?.target,
      );
      emit({ id, ok: true, result });
      return;
    }

    if (method === "history.clear") {
      database.clearHistory(ACCOUNT_ID);
      await mediaDiskCache.clear();
      await clearMediaUploadTemp();
      preSyncedMessages.clear();
      mediaPreviewCache.clear();
      messageMediaSourceCache.clear();
      emit({ id, ok: true, result: { cleared: true } });
      return;
    }

    replyError(id, new Error(`unknown method: ${method}`));
  } catch (error) {
    replyError(id, error);
  }
}

emit({
  type: "engine.ready",
  engine: "liney-engine",
  linejsVersion: LINEJS_VERSION,
  device: clientIdentity().device,
  clientIdentity: clientIdentity(),
});

restorePromise = process.env.LINEY_DISABLE_AUTO_RESTORE === "1"
  ? Promise.resolve()
  : autoRestore();

// Legacy Tauri uses JSONL over standard IO. The native Slint UI runs
// this same engine in a Worker Thread, sharing its OS process and Node runtime.
const rl: Interface | null = parentPort
  ? null
  : createInterface({ input: process.stdin, crlfDelay: Infinity });
if (parentPort) {
  parentPort.on("message", (request: unknown) => {
    if (request && typeof request === "object" && !Array.isArray(request)) {
      if ((request as Record<string, unknown>).type === "liney:shutdown") {
        void shutdown().finally(() => process.exit(0));
      } else {
        void handle(request);
      }
    }
  });
} else {
  rl?.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      void handle(JSON.parse(trimmed));
    } catch (error) {
      emit({ ok: false, error: errorInfo(error) });
    }
  });
}

let shutdownInFlight: Promise<void> | null = null;
const shutdown = async (): Promise<void> => {
  if (shutdownInFlight) return shutdownInFlight;
  shutdownInFlight = (async () => {
    listenerAbort?.abort();
    await callManager.stop("engine-shutdown").catch(() => undefined);
    rl?.close();
  })();
  return shutdownInFlight;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
