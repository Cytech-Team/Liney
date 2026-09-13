import { getTargetProfiles, LineJsAdapter, type LineClient } from "./linejs/adapter";
// Keep all LINEJS values behind the adapter boundary. This makes replacing the
// protocol implementation a local engine change instead of a repository-wide
// import migration.
const {
  loginWithPassword,
  loginWithQR,
  loginWithAuthToken,
  createSquareMessage,
  createTalkMessage,
  fetchMessageAsset,
  fromRawTalk,
  parseCancelCall,
  parseIncomingCall,
} = LineJsAdapter;
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { rename as renameAsync, rm as rmAsync, unlink as unlinkAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CallManager } from "./call-manager";
import { LineyDatabase, type DatabaseChat, type DatabaseMessage, type OutboxRecord } from "./database";
import { LineyMediaCache } from "./media-cache";
import { decodeMediaBase64, MediaWorker } from "./media-worker";
import { detectImageMime, normalizeImageBlob } from "./media-format";
import {
  LineyKeyring,
  SecureLineStorage,
  credentialPersistenceStatus,
  ensurePrivateDirectory,
  migrateLegacyCredentials,
  readCredentialFromWallet,
  type AuthCredential,
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
  shouldRetryTalkHistory,
} from "./talk-history";
import { parseFlexMessage } from "./flex";
import { parseRichMessage } from "./rich";
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
let lastTalkPushEventAt = 0;
let lastSquarePushEventAt = 0;
const mediaPreviewCache = new Map<string, string>();
const messageMediaSourceCache = new Map<string, { raw: any; isSquare: boolean }>();
const preSyncedMessages = new Map<string, any[]>();
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
const SYSTEM_ACCOUNT_TRACK_INTERVAL_MS = 15_000;
const SYSTEM_ACCOUNT_TRACK_EVENT_THROTTLE_MS = 1_000;
type SenderIdentity = { id: string; name: string; avatarUrl: string; isOfficialAccount?: boolean };
const talkSenderCache = new Map<string, SenderIdentity>();
const talkSenderProfileChecked = new Set<string>();
const talkSenderResolutionCache = new Map<string, Promise<SenderIdentity | null>>();
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
  while (offset < total && offset < 2_000) {
    // LINEJS exposes getPurchasedProducts, but it only includes transaction
    // history. getOwnedProducts is the Shop API inventory endpoint and also
    // includes free/default packs currently attached to this account.
    const page = await LineJsAdapter.request(client,
      [
        [11, 2, "stickershop"], [8, 3, offset], [8, 4, pageSize],
        [12, 5, [[11, 1, "th"], [11, 2, "TH"]]],
      ],
      "getOwnedProducts", 4, true, "/TSHOP4",
    ) as unknown;
    // getOwnedProducts is not yet declared in LINEJS's generated result map,
    // so RequestClient returns the decoded thrift fields by number. Rename it
    // with the already-generated ProductList schema before consuming it.
    const result = shopResultAs<Record<string, unknown>>("ProductList", page);
    stickers.push(...ownedStickersFromPurchases(result));
    const records = Array.isArray(result.productList) ? result.productList : [];
    total = Math.max(0, Number(result.totalSize ?? records.length));
    if (!records.length) break;
    offset += records.length;
  }
  // Modern desktop sessions can return no details from getOwnedProducts.
  // Ask the companion summaries endpoint for the installed account packs,
  // then read each pack's public manifest for its sticker IDs. Neither source
  // is chat history and each id is still anchored to account ownership.
  if (!stickers.length) {
    const summariesRaw = await LineJsAdapter.request(client,
      [[11, 2, "stickershop"], [8, 3, 0], [8, 4, 200], [12, 5, [[11, 1, "th"], [11, 2, "TH"]]]],
      "getOwnedProductSummaries", 4, true, "/TSHOP4",
    ) as unknown;
    const summaries = shopResultAs<{ productList?: unknown }>("ProductSummaryList", summariesRaw);
    const products = Array.isArray(summaries.productList) ? summaries.productList : [];
    for (const product of products.slice(0, 200)) {
      if (!product || typeof product !== "object") continue;
      const data = product as Record<string, unknown>;
      const packageId = String(data.id ?? "").trim();
      if (!/^\d{1,30}$/.test(packageId)) continue;
      const version = String(data.latestVersion ?? "1").trim() || "1";
      stickers.push(...await stickerPackFromPublicMetadata(packageId, version));
    }
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
  process.stdout.write(`${JSON.stringify(value)}\n`);
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

function databasePath() {
  return join(dataPath(), "liney.sqlite");
}

ensureDataDir();
const stickerCatalogCache = new StickerCatalogCache(join(dataPath(), "sticker-catalog-cache.json"));
const keyring = new LineyKeyring();
const legacyMigration = migrateLegacyCredentials(dataPath(), keyring);
const store = new SecureLineStorage(storagePath(), keyring);
const database = new LineyDatabase(databasePath());
if (readCredential()) ACCOUNT_ID = database.latestAccountId() ?? ACCOUNT_ID;
const mediaDiskCache = new LineyMediaCache(join(dataPath(), "media"));
const mediaUploadTempDir = join(dataPath(), "media-upload-tmp");
let syncCoordinator: SyncCoordinator | null = null;
function getSyncCoordinator(): SyncCoordinator {
  if (syncCoordinator) return syncCoordinator;
  syncCoordinator = new SyncCoordinator(database, emit, {
    loadFriends: () => loadFriendsList(false),
    loadChats: () => loadChatsList(false),
    loadOpenChats: () => loadOpenChatList(false),
    persistLists: (friends, chats, openChats) => database.upsertChats(ACCOUNT_ID, [...friends, ...chats, ...openChats] as DatabaseChat[]),
    fetchTalk: fetchTalkMessagesNormalized,
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

async function persistCredential(next: LineClient) {
  const refreshToken = await store.get("refreshToken");
  const expireValue = await store.get("expire");
  const credential: AuthCredential = {
    accessToken: LineJsAdapter.authToken(next),
    ...(typeof refreshToken === "string" ? { refreshToken } : {}),
    ...(typeof expireValue === "number" ? { expire: expireValue } : {}),
  };
  const persisted = writeCredentialToWallet(keyring, credential);
  if (!persisted) {
    emit({
      type: "auth.persistence",
      mode: "session-only",
      warning: "Secret Service unavailable; credentials will not survive restart",
    });
  }
  return persisted;
}

function readCredential(): AuthCredential | null {
  return readCredentialFromWallet(keyring) ?? legacyMigration.credential;
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
  lastTalkPushEventAt = 0;
  lastSquarePushEventAt = 0;
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
        : await fetchTalkMessagesNormalized(chatId, 100);
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
      const result = await tryImageSource(() => fetchMessageAsset(client!, downloadUrl), true);
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
  if (cached) return cached;

  const diskMetadata = database.getMedia(ACCOUNT_ID, key);
  const diskCached = await mediaDiskCache.get(key, diskMetadata?.mime || "image/jpeg");
  if (diskCached) {
    try {
      const image = await normalizeImageBlob(new Blob([diskCached.bytes], { type: diskCached.mime }));
      const dataUrl = await blobToDataUrl(image);
      database.touchMedia(ACCOUNT_ID, key);
      mediaPreviewCache.set(key, dataUrl);
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
  mediaPreviewCache.set(key, dataUrl);
  if (mediaPreviewCache.size > 64) {
    const first = mediaPreviewCache.keys().next().value;
    if (first) mediaPreviewCache.delete(first);
  }
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
    case 22: return "Flex message";
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
 * LINE profile hashes can become stale after a user changes their avatar.
 * The OBS talk profile endpoint is keyed by MID and always resolves the
 * current profile image, so prefer it for normal Talk users.
 */
function talkProfileImageUrl(mid: string, fallback?: unknown): string {
  const normalizedMid = String(mid ?? "").trim();
  if (/^u[0-9a-f]{32}$/i.test(normalizedMid)) {
    return `https://obs.line-scdn.net/r/talk/p/${encodeURIComponent(normalizedMid)}`;
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

function talkProfileIdentity(mid: string, raw: any, isOfficialAccount = false): SenderIdentity {
  const detail = raw?.targetProfileDetail ?? raw?.contact ?? raw ?? {};
  const name = String(detail?.profileName ?? detail?.displayName ?? "LINE User").trim() || "LINE User";
  const avatarUrl = talkProfileImageUrl(mid, detail?.pictureStatus || detail?.picturePath);
  return { id: mid, name, avatarUrl, ...(isOfficialAccount ? { isOfficialAccount: true } : {}) };
}

function talkContactIdentity(mid: string, contact: any): SenderIdentity {
  const name = String(contact?.displayNameOverridden || contact?.displayName || "LINE User").trim() || "LINE User";
  const avatarUrl = talkProfileImageUrl(mid, contact?.pictureStatus || contact?.picturePath || contact?.thumbnailUrl);
  return { id: mid, name, avatarUrl };
}

async function resolveTalkSender(mid: string): Promise<SenderIdentity | null> {
  if (!client || !mid || !mid.startsWith("u")) return null;
  const cached = talkSenderCache.get(mid);
  if (cached && (cached.isOfficialAccount || talkSenderProfileChecked.has(mid))) return cached;
  try {
    const profiles = await getTargetProfiles(client, [mid]);
    talkSenderProfileChecked.add(mid);
    const [profile] = profiles;
    if (profile) {
      const identity = talkProfileIdentity(mid, profile, isBotTargetProfile(profile));
      if (identity.name !== "LINE User" || identity.avatarUrl || identity.isOfficialAccount) {
        talkSenderCache.set(mid, identity);
        return identity;
      }
    }
  } catch {
    // Profile classification is best-effort; regular contact fallbacks below
    // still keep the message visible when RelationService is unavailable.
  }
  try {
    const user: any = await LineJsAdapter.getUser(client, mid);
    const identity = talkProfileIdentity(mid, user?.raw);
    if (identity.name !== "LINE User" || identity.avatarUrl) {
      talkSenderCache.set(mid, identity);
      return identity;
    }
  } catch {
    // Continue through Talk contact fallbacks for non-friend group members.
  }
  try {
    const response: any = await LineJsAdapter.getContactsV2(client, { mids: [mid] });
    const contact = response?.contacts?.[mid]?.contact;
    if (contact) {
      const identity = talkContactIdentity(mid, contact);
      talkSenderCache.set(mid, identity);
      return identity;
    }
  } catch {
    // Older / restricted desktop sessions can reject V2.
  }
  try {
    const contacts: any[] = await LineJsAdapter.getContacts(client, { mids: [mid] });
    const contact = contacts?.[0];
    if (contact) {
      const identity = talkContactIdentity(mid, contact);
      talkSenderCache.set(mid, identity);
      return identity;
    }
  } catch {
    // Last fallback below.
  }
  const fallback = { id: mid, name: "LINE User", avatarUrl: "" };
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
  const missing = unique.filter((id) => !talkSenderCache.has(id));

  // Resolve group participants in one RPC where possible. This is both faster
  // and more complete than getUser() for people who are not in the friend list.
  for (let start = 0; start < missing.length; start += 50) {
    const mids = missing.slice(start, start + 50);
    try {
      const response: any = await LineJsAdapter.getContactsV2(client, { mids });
      for (const mid of mids) {
        const contact = response?.contacts?.[mid]?.contact;
        if (contact) talkSenderCache.set(mid, talkContactIdentity(mid, contact));
      }
    } catch {
      // Fall back per sender below.
    }
  }

  // Official Accounts are returned as BOT target profiles even when the
  // normal user/contact endpoints hide their profile. Classify in bounded
  // batches so historical messages can retain an actionable client fallback.
  for (let start = 0; start < unique.length; start += 50) {
    const mids = unique.slice(start, start + 50);
    try {
      const profiles = await getTargetProfiles(client, mids);
      for (const mid of mids) talkSenderProfileChecked.add(mid);
      for (const profile of profiles) {
        const mid = midString(profile?.targetUserMid);
        if (!mid) continue;
        const current = talkSenderCache.get(mid);
        const isOfficialAccount = isBotTargetProfile(profile);
        const profileIdentity = talkProfileIdentity(mid, profile, isOfficialAccount);
        talkSenderCache.set(mid, {
          id: mid,
          name: current?.name && current.name !== "LINE User" ? current.name : profileIdentity.name,
          avatarUrl: current?.avatarUrl || profileIdentity.avatarUrl,
          ...(isOfficialAccount || current?.isOfficialAccount ? { isOfficialAccount: true } : {}),
        });
      }
    } catch {
      // Classification must never make a room disappear.
    }
  }
  await resolveIdentities(
    unique.filter((id) => !talkSenderCache.has(id)),
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
  messageMediaSourceCache.set(mediaSourceKey(id, isSquare), { raw, isSquare });
  if (messageMediaSourceCache.size > 1200) {
    const first = messageMediaSourceCache.keys().next().value;
    if (first) messageMediaSourceCache.delete(first);
  }
}

async function loadTalkMessageBoxes(): Promise<any[]> {
  if (!client) throw new Error("not authenticated");
  try {
    // `activeOnly: true` hides old direct-message boxes. Those boxes still
    // contain readable history and are needed for a real full sync.
    const boxResult: any = await LineJsAdapter.getMessageBoxes(client, {
      messageBoxListRequest: {
        activeOnly: false,
        messageBoxCountLimit: 1000,
        withUnreadCount: true,
        lastMessagesPerMessageBoxCount: 1,
        unreadOnly: false,
      },
    } as any);
    const boxes = Array.isArray(boxResult?.messageBoxes) ? boxResult.messageBoxes : [];
    talkMessageBoxCache.clear();
    for (const box of boxes) {
      const id = talkMessageBoxId(box);
      if (id) talkMessageBoxCache.set(id, box);
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

async function trackLineSystemAccount(next: LineClient, reason: string, force = false): Promise<void> {
  if (client !== next) return;
  const now = Date.now();
  if (!force && now - lastSystemAccountTrackAt < SYSTEM_ACCOUNT_TRACK_EVENT_THROTTLE_MS) return;
  if (systemAccountTrackInFlight) return systemAccountTrackInFlight;
  lastSystemAccountTrackAt = now;
  systemAccountTrackInFlight = (async () => {
    try {
      const result: any = await LineJsAdapter.getMessageBoxes(next, {
        messageBoxListRequest: {
          activeOnly: false,
          messageBoxCountLimit: 1000,
          withUnreadCount: true,
          lastMessagesPerMessageBoxCount: 1,
          unreadOnly: false,
        },
      } as any);
      const boxes = Array.isArray(result?.messageBoxes) ? result.messageBoxes : [];
      const box = boxes.find((candidate: any) => talkMessageBoxId(candidate) === LINE_SYSTEM_ACCOUNT_MID);
      if (!box) return;
      talkMessageBoxCache.set(LINE_SYSTEM_ACCOUNT_MID, box);
      const cursor = systemAccountCursor(box);
      if (!cursor) return;

      const previous = database.getSyncState(ACCOUNT_ID, SYSTEM_ACCOUNT_TRACK_KEY);
      if (!previous?.cursor) {
        // Establish a baseline only. Existing system notifications must not be
        // surfaced as new merely because Liney has started for the first time.
        database.setSyncState(ACCOUNT_ID, {
          key: SYSTEM_ACCOUNT_TRACK_KEY,
          cursor: cursor.messageId,
          generation: cursor.deliveredTime,
          status: "ready",
        });
        return;
      }
      if (previous.cursor === cursor.messageId) return;

      database.setSyncState(ACCOUNT_ID, {
        key: SYSTEM_ACCOUNT_TRACK_KEY,
        cursor: cursor.messageId,
        generation: cursor.deliveredTime,
        status: "ready",
      });

      const syntheticId = `line-system:${cursor.messageId}`;
      const alreadyStored = database.getMessage(ACCOUNT_ID, LINE_SYSTEM_ACCOUNT_MID, syntheticId);
      if (!alreadyStored) {
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
    await waitForSignal(SYSTEM_ACCOUNT_TRACK_INTERVAL_MS, signal);
    if (signal.aborted || client !== next) return;
    await trackLineSystemAccount(next, "interval", true);
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
    // MID-based OBS URLs track the current Talk profile image and do not go
    // stale when LINE rotates pictureStatus/picturePath after an avatar edit.
    avatarUrl = talkProfileImageUrl(mid, identity?.avatarUrl);
  }
  const favoriteTimestamp = Number(chat?.raw?.favoriteTimestamp ?? 0);
  return {
    id: mid,
    name: hasUsefulChatName ? chatName : String(identity?.name || "LINE Chat"),
    kind: isDm ? "dm" : "group",
    avatarUrl,
    preview,
    unread: Number(box?.unreadCount ?? 0),
    lastMessageTime: historyState === "new" ? 0 : talkBoxLastTime(box),
    favoriteTimestamp,
    pinned: favoriteTimestamp > 0,
    historyState,
    raw: normalize(chat?.raw),
  };
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
    byId.set(id, {
      ...known,
      ...current,
      name: usefulName ? currentName : known.name,
      avatarUrl: current.avatarUrl || known.avatarUrl,
      preview: current.preview || known.preview,
      lastMessageTime: Math.max(Number(current.lastMessageTime ?? 0), Number(known.lastMessageTime ?? 0)),
      historyState: known.historyState === "available" ? "available" : current.historyState ?? known.historyState ?? "available",
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

  // Archived direct chats may be absent from getAllChatMids. Resolve group
  // metadata only for those extra boxes; DMs already have contact metadata
  // from the friends sync and therefore need no extra request. A box without
  // readable history is still surfaced so the UI can direct users to LINE's
  // official clients instead of silently dropping the room.
  const extraGroups = new Map<string, any>();
  await runPool(additionalIds.filter((id) => !id.startsWith("u")), 4, async (id) => {
    try {
      const extra = await LineJsAdapter.getChat(client!, id);
      extraGroups.set(id, extra);
    } catch {
      // Keep a generic group row; its history is still useful and loadable.
    }
  });

  const jobs: Array<{ chat: any; box: any; historyState: "available" | "new" | "unavailable" }> = [
    ...chats.map((chat: any) => {
      const box = boxMap.get(String(chat.mid));
      return { chat, box, historyState: talkMessageBoxHistoryState(box) };
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
  const remoteResult = new Array<any>(jobs.length);
  await runPool(jobs, 4, async ({ chat, box, historyState }, index) => {
    remoteResult[index] = await normalizeTalkChat(chat, box, historyState);
  });
  const result = mergeKnownTalkChats(remoteResult);
  if (!result.length && joinedError) throw joinedError;
  result.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  if (persist && canPersist()) database.upsertChats(ACCOUNT_ID, result as DatabaseChat[]);
  return result;
}

async function loadFriendsList(persist = true, canPersist: () => boolean = () => true): Promise<any[]> {
  if (!client) throw new Error("not authenticated");
  const friendIds: string[] = (await LineJsAdapter.getUserFriendIds(client, {
    request: { blockStatus: "ALL" },
  })).userFriendMids ?? [];
  const contacts: any[] = [];
  for (let offset = 0; offset < friendIds.length; offset += 50) {
    const mids = friendIds.slice(offset, offset + 50);
    try {
      const response: any = await LineJsAdapter.getContactsV2(client, { mids });
      for (const [mid, entry] of Object.entries<any>(response?.contacts ?? {})) {
        const contact = entry?.contact ?? {};
        contacts.push({ mid, contact });
      }
    } catch {
      // If getContactsV2 fails, fall back to the local sender cache only —
      // NOT a per-contact getUser() loop, which fans out N network requests
      // and is the main reason a post-cache refresh is slow at startup.
      for (const mid of mids) {
        const known = talkSenderCache.get(mid);
        if (known) {
          contacts.push({
            mid,
            contact: {
              displayName: known.name,
              picturePath: known.avatarUrl,
              pictureStatus: "",
              statusMessage: "",
              favoriteTime: 0,
            },
          });
        }
      }
    }
  }
  const result = contacts.map(({ mid, contact }) => {
    const favoriteTime = Number(contact?.favoriteTime ?? 0);
    const identity: SenderIdentity = {
      id: String(mid),
      name: String(contact?.displayNameOverridden || contact?.displayName || "LINE User"),
      avatarUrl: talkProfileImageUrl(String(mid), contact?.pictureStatus || contact?.picturePath),
    };
    talkSenderCache.set(String(mid), identity);
    return {
      id: String(mid),
      name: identity.name,
      kind: "dm",
      avatarUrl: identity.avatarUrl,
      statusMessage: String(contact?.statusMessage ?? ""),
      favoriteTime,
      isFavorite: favoriteTime > 0,
    };
  });
  result.sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    if (a.favoriteTime !== b.favoriteTime) return b.favoriteTime - a.favoriteTime;
    return a.name.localeCompare(b.name, "th");
  });
  if (persist && canPersist()) database.upsertChats(ACCOUNT_ID, result as DatabaseChat[]);
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
      preview: compactPreview(last?.text, last?.contentType),
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

async function fetchTalkMessagesNormalized(chatId: string, limit: number): Promise<any[]> {
  if (!client) throw new Error("not authenticated");
  let list: any[];
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

  try {
    let box = talkMessageBoxCache.get(chatId);
    if (!box) {
      const boxes = await loadTalkMessageBoxes();
      box = boxes.find((candidate: any) => talkMessageBoxId(candidate) === chatId);
    }

    const cursor = box?.lastDeliveredMessageId;
    const rawList = cursor && cursor.messageId !== undefined && cursor.deliveredTime !== undefined
           ? await LineJsAdapter.getPreviousMessages(client, {
        request: {
          messageBoxId: chatId,
          endMessageId: cursor,
          messagesCount: limit,
        },
      })
       : await LineJsAdapter.getRecentMessages(client, {
        messageBoxId: chatId,
        messagesCount: limit,
      });
    list = await decode(rawList);
    if (shouldRetryTalkHistory(cursor, list.length)) {
      const recentRaw: any[] = await LineJsAdapter.getRecentMessages(client, {
        messageBoxId: chatId,
        messagesCount: limit,
      });
      list = await decode(recentRaw);
    }
  } catch {
    // One corrupt/old E2EE payload must not make an entire room disappear.
    // Pull raw Talk messages and decode them independently so good messages
    // survive even when one historical encryption key is unavailable.
    try {
       const rawList: any[] = await LineJsAdapter.getRecentMessages(client, {
        messageBoxId: chatId,
        messagesCount: limit,
      });
      list = await decode(rawList);
    } catch (fallbackError) {
      const reason = String(fallbackError instanceof Error ? fallbackError.message : fallbackError);
      if (chatId.startsWith("u") || reason.includes("Message box not found")) return [];
      throw fallbackError;
    }
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
      : await fetchTalkMessagesNormalized(chatId, Math.max(limit, 100));
    if (recovered.some((message: any) => messageStickerUrl(message))) {
      persistNormalizedMessages(chatId, openchat, recovered);
      return decorateStoredMessages(database.listMessages(ACCOUNT_ID, chatId, limit));
    }
  } catch {
    // Keep the local history visible when LINE cannot refresh this room.
  }
  return decorateStoredMessages(messages);
}

function persistNormalizedMessages(chatId: string, openchat: boolean, messages: any[]): void {
  const kind = chatKindFor(chatId, openchat);
  const rows: DatabaseMessage[] = messages.map((message) => ({
    id: String(message.id),
    chatId,
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
  if (rows.length) database.upsertMessages(ACCOUNT_ID, rows);
}

function persistLiveMessage(
  chatId: string,
  kind: "dm" | "group" | "openchat",
  message: any,
  localId?: string,
): void {
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

function startSync(): Promise<void> {
  invalidateChatListRefreshes();
  return getSyncCoordinator().startFull().catch((error) => {
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

function talkChatId(raw: any, message: any, isMine: boolean, from: string, to: string): string {
  const toType = midTypeName(raw?.toType ?? (() => {
    try { return message?.to?.type; } catch { return ""; }
  })());
  if (toType === "GROUP" || toType === "ROOM") return to || from;
  if (toType === "USER") return isMine ? (to || from) : (from || to);
  // Some LINE sessions return the enum as a numeric value in raw and some
  // return only the MID. The MID fallback preserves the DM direction in both
  // forms while still using the room MID for group messages.
  if (isMine) return to || from;
  return to.startsWith("u") ? (from || to) : (to || from);
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
    if (candidate.startsWith("c") || candidate.startsWith("r") || candidate.startsWith("u")) return candidate;
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

async function handleTalkMessage(next: LineClient, message: any, rawOverride?: any, eventKind: "message" | "edit" = "message"): Promise<void> {
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
  const sender = isMine
    ? null
    : talkSenderCache.get(from) ?? (from ? { id: from, name: "LINE User", avatarUrl: "" } : null);
  const shouldResolveSender = !isMine && Boolean(from)
    && (!talkSenderCache.has(from) || !talkSenderProfileChecked.has(from));
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
    type: eventKind === "edit" ? "event.message.updated" : "event.message",
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
    void trackLineSystemAccount(next, `op:${type}`).catch(() => undefined);
  } else if (type === "DUMMY") {
    void trackLineSystemAccount(next, `op:${type}`).catch(() => undefined);
  }
  if (type === "NOTIFIED_READ_MESSAGE") {
    // LINE sends this as param1=chat MID, param2=reader MID and
    // param3=the highest message id they have read. It is a peer event, not
    // the local mark-read request we send when opening a room.
    const chatId = String(operation?.param1 ?? "").trim();
    const readerMid = String(operation?.param2 ?? "").trim();
    const messageId = String(operation?.param3 ?? "").trim();
    const selfMid = midString(LineJsAdapter.profileMid(next));
    if (chatId && messageId && readerMid && readerMid !== selfMid) {
      emit({ type: "event.message.read", source: "talk", chatId, messageId, readerMid });
    }
    return;
  }
  if (type === "NOTIFIED_RECEIVED_CALL") {
    callManager.rememberIncoming(parseIncomingCall(operation));
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
  const eventKind = type === "EDIT_MESSAGE" || type === "NOTIFIED_EDIT_MESSAGE" ? "edit" : "message";
  await handleTalkMessage(next, createTalkMessage(next, raw), raw, eventKind);
}

async function handleSquareOperation(next: LineClient, operation: any): Promise<void> {
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

async function consumeTalkEvents(next: LineClient, signal: AbortSignal, push: any): Promise<void> {
  while (!signal.aborted && client === next) {
    const stream = LineJsAdapter.pushStream(push, "op");
    try {
      for await (const operation of stream as AsyncIterable<any>) {
        if (signal.aborted || client !== next) return;
        lastTalkPushEventAt = Date.now();
        void handleTalkOperation(next, operation).catch((error) => {
          if (!signal.aborted) emit({ type: "event.message.error", source: "talk", error: errorInfo(error).message });
        });
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

async function consumeSquareEvents(next: LineClient, signal: AbortSignal, push: any): Promise<void> {
  while (!signal.aborted && client === next) {
    const stream = LineJsAdapter.pushStream(push, "sq");
    try {
      for await (const operation of stream as AsyncIterable<any>) {
        if (signal.aborted || client !== next) return;
        lastSquarePushEventAt = Date.now();
        void handleSquareOperation(next, operation).catch((error) => {
          if (!signal.aborted) emit({ type: "event.message.error", source: "openchat", error: errorInfo(error).message });
        });
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

function isPushHealthy(): boolean {
  return pushHealthy && pushConnectedSince > 0 && Date.now() - pushConnectedSince >= 2_000;
}

function isTalkPushFresh(): boolean {
  return isPushHealthy() && lastTalkPushEventAt > 0 && Date.now() - lastTalkPushEventAt < 15_000;
}

function isSquarePushFresh(): boolean {
  return isPushHealthy() && lastSquarePushEventAt > 0 && Date.now() - lastSquarePushEventAt < 15_000;
}

async function consumeTalkPolling(next: LineClient, signal: AbortSignal): Promise<void> {
  while (!signal.aborted && client === next) {
    if (isTalkPushFresh()) {
      await waitForSignal(5_000, signal);
      continue;
    }
    const polling = LineJsAdapter.createPolling(next) as any;
    try {
      for await (const operation of polling._listenTalkEvents({
        signal,
        pollingInterval: 1_000,
        onError: (error: unknown) => {
          if (!signal.aborted) emit({ type: "event.transport.error", transport: "talk-poll", error: errorInfo(error).message });
        },
      }) as AsyncIterable<any>) {
        if (signal.aborted || client !== next) return;
        if (isTalkPushFresh()) break;
        void handleTalkOperation(next, operation).catch((error) => {
          if (!signal.aborted) emit({ type: "event.message.error", source: "talk-poll", error: errorInfo(error).message });
        });
      }
    } catch (error) {
      if (!signal.aborted) emit({ type: "event.transport.error", transport: "talk-poll", error: errorInfo(error).message });
    }
    if (!signal.aborted && client === next && !isTalkPushFresh()) await waitForSignal(1_000, signal);
  }
}

async function consumeSquarePolling(next: LineClient, signal: AbortSignal): Promise<void> {
  while (!signal.aborted && client === next) {
    if (isSquarePushFresh()) {
      await waitForSignal(5_000, signal);
      continue;
    }
    const polling = LineJsAdapter.createPolling(next) as any;
    try {
      for await (const operation of polling._listenSquareEvents({
        signal,
        pollingInterval: 1_000,
        onError: (error: unknown) => {
          if (!signal.aborted) emit({ type: "event.transport.error", transport: "openchat-poll", error: errorInfo(error).message });
        },
      }) as AsyncIterable<any>) {
        if (signal.aborted || client !== next) return;
        if (isSquarePushFresh()) break;
        void handleSquareOperation(next, operation).catch((error) => {
          if (!signal.aborted) emit({ type: "event.message.error", source: "openchat-poll", error: errorInfo(error).message });
        });
      }
    } catch (error) {
      if (!signal.aborted) emit({ type: "event.transport.error", transport: "openchat-poll", error: errorInfo(error).message });
    }
    if (!signal.aborted && client === next && !isSquarePushFresh()) await waitForSignal(1_000, signal);
  }
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
        lastTalkPushEventAt = pushConnectedSince;
        lastSquarePushEventAt = pushConnectedSince;
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

  LineJsAdapter.on(next, "update:authtoken", () => {
    void persistCredential(next).catch(() => undefined);
  });

  // Do not use Client.listen here. Its internal async iterator rejects on one
  // decryption/handler error and silently stops delivering every later event.
  // Consuming the raw streams lets us isolate each operation and supervise
  // the HTTP/2 push connection independently.
  LineJsAdapter.renewPushStreams(push);
  void consumeTalkEvents(next, signal, push);
  void consumeSquareEvents(next, signal, push);
  void consumeSystemAccountTracking(next, signal);
  if (process.env.LINEY_DISABLE_EVENT_POLLING !== "1") {
    void consumeTalkPolling(next, signal);
    void consumeSquarePolling(next, signal);
  }
  void supervisePush(next, signal, push);
}

async function finishAuthentication(next: LineClient, restored: boolean) {
  // Validate the session against LINE before declaring it ready.  Full sync is
  // deliberately *not* part of this critical path: waiting for hundreds of
  // rooms here held the entire Tauri login screen in "starting" state.
  const profile: any = await next.getMyProfile();
  const account = await activateAccount(profile);
  client = next;
  currentProfile = normalize(profile);
  database.upsertAccount(ACCOUNT_ID, {
    mid: String(profile?.mid ?? ""),
    displayName: String(profile?.displayName ?? ""),
  });
  callManager.attach(next);
  attachEvents(next);
  const credentialPersisted = await persistCredential(next);
  emit({
    type: "auth.ready",
    restored,
    profile: normalize(profile),
    authTokenPresent: Boolean(LineJsAdapter.authToken(next)),
    storage: credentialPersisted ? "wallet" : "session-only",
    accountChanged: account.changed && !account.migrated,
  });
  // Full sync is intentionally opt-in on login. It can touch many rooms and
  // media previews; running it at every desktop start made the native UI hot.
  if (process.env.LINEY_FULL_SYNC_ON_LOGIN === "1" && process.env.LINEY_LIGHT_START !== "1") {
    void startSync().catch(() => undefined);
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
    const next = await loginWithQR(
      {
        onReceiveQRUrl(url) {
          emit({ type: "auth.qr", url });
        },
        onPincodeRequest(pin) {
          emit({ type: "auth.pin", pin });
        },
      },
      {
        device: "DESKTOPWIN",
        storage: store,
      },
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
        device: "DESKTOPWIN",
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
      device: "DESKTOPWIN",
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
      device: "DESKTOPWIN",
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
  try {
    return await LineJsAdapter.sendTalkMessage(client, {
      to: record.chatId,
      ...options,
      // LINE stickers carry their payload in contentMetadata.  Encrypting an
      // empty text body makes LINEJS create an invalid E2EE chunk instead.
      e2ee: record.contentType === 7 ? false : true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("E2EE_RETRY_PLAIN")) throw error;
    return LineJsAdapter.sendTalkMessage(client, {
      to: record.chatId,
      ...options,
      e2ee: false,
    });
  }
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
    const failed: OutboxRecord = {
      ...sending,
      status: uncertain ? "unknown" : "failed",
      updatedAt: Date.now(),
      nextAttemptAt: Date.now() + retryDelayMs(sending.attempts),
      lastError: errorInfo(error).message,
    };
    database.saveOutbox(ACCOUNT_ID, failed);
    database.updateMessageStatus(ACCOUNT_ID, record.chatId, record.localId, failed.status);
    emit({
      type: "message.failed",
      localId: record.localId,
      chatId: record.chatId,
      status: failed.status,
      retryable: isRetryableError(error),
    });
    throw error;
  }
}

async function sendMediaOutbox(record: OutboxRecord): Promise<unknown> {
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
    const failed: OutboxRecord = {
      ...sending,
      status: uncertain ? "unknown" : "failed",
      updatedAt: Date.now(),
      nextAttemptAt: Date.now() + retryDelayMs(sending.attempts),
      lastError: errorInfo(error).message,
    };
    database.saveOutbox(ACCOUNT_ID, failed);
    database.updateMessageStatus(ACCOUNT_ID, record.chatId, record.localId, failed.status);
    emit({
      type: "message.failed",
      localId: record.localId,
      chatId: record.chatId,
      status: failed.status,
      retryable: isRetryableError(error),
      contentType: record.contentType,
    });
    throw error;
  }
}

async function reconcileUnknownOutbox(record: OutboxRecord): Promise<string | undefined> {
  const list = record.kind === "openchat"
    ? await fetchOpenChatMessagesNormalized(record.chatId, 100)
    : await fetchTalkMessagesNormalized(record.chatId, 100);
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
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["'][^>]*>`,
    "i",
  );
  const match = pattern.exec(html);
  const value = match ? (match[1] ?? match[2] ?? "") : "";
  return value ? decodeHtmlEntities(value).trim() : undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function ogAbsolute(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined;
  try { return new URL(value, base).toString(); } catch { return undefined; }
}

async function fetchLinkPreview(rawUrl: string): Promise<Record<string, unknown>> {
  let url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("link must be http(s)");
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

  const title = htmlMeta(text, "og:title") ?? /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
  const description =
    htmlMeta(text, "og:description") ??
    htmlMeta(text, "description") ??
    htmlMeta(text, "twitter:description");
  const image = ogAbsolute(htmlMeta(text, "og:image") ?? htmlMeta(text, "twitter:image"), url);
  const siteName = htmlMeta(text, "og:site_name") ?? new URL(url).hostname;

  return {
    url: new URL(url).toString(),
    title: (title ?? siteName ?? "").slice(0, 300),
    description: (description ?? "").slice(0, 500) || undefined,
    image,
    siteName: siteName ?? "",
  };
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
    const cached = database.listConversationChats(ACCOUNT_ID);
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
    const cached = database.listChats(ACCOUNT_ID, "dm");
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
  const chatId = String(request?.params?.chatId ?? "").trim();
  if (!chatId) return false;
  const kind = String(request?.params?.kind ?? "talk");
  const limit = Math.max(1, Math.min(Number(request?.params?.limit ?? 50), 100));
  const openchat = kind === "openchat";
  const cacheKey = `${openchat ? "openchat" : "talk"}:${chatId}`;
  const transient = preSyncedMessages.get(cacheKey);
  if (transient) {
    preSyncedMessages.delete(cacheKey);
    const visible = transient.filter((message: any) => !database.isMessageHidden(
      ACCOUNT_ID,
      chatId,
      openchat ? "openchat" : chatKindFor(chatId, false),
      String(message?.id ?? ""),
    ));
    const result = client
      ? await recoverMissingStickerMetadata(chatId, openchat, visible.slice(-limit), limit)
      : decorateStoredMessages(visible.slice(-limit));
    emit({ id, ok: true, result });
    return true;
  }

  const stored = database.listMessages(ACCOUNT_ID, chatId, limit);
  if (!stored.length) return false;
  // Do not make the first usable cached response wait for a profile request.
  // Authenticated refreshes can enrich the same rows on a later request/event.
  const result = client
    ? await recoverMissingStickerMetadata(chatId, openchat, await enrichStoredTalkSenders(stored), limit)
    : decorateStoredMessages(stored);
  emit({ id, ok: true, result });
  if (client) refreshChatListInBackground(openchat ? "openchat" : "talk", openchat ? loadOpenChatList : loadChatsList);
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
    emit({ id, ok: true, result: { pong: true, protocolVersion: PROTOCOL_VERSION, linejsVersion: LINEJS_VERSION } });
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
    emit({
      id,
      ok: true,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        linejsVersion: LINEJS_VERSION,
        device: "DESKTOPWIN",
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
    if (method === "profile.get") {
      const profile = currentProfile ?? await LineJsAdapter.getMyProfile(client);
      currentProfile = normalize(profile);
      database.upsertAccount(ACCOUNT_ID, {
        mid: String((profile as any)?.mid ?? ""),
        displayName: String((profile as any)?.displayName ?? ""),
      });
      emit({ id, ok: true, result: normalize(profile) });
      return;
    }

    if (method === "chat.list" || method === "chats.list") {
      if (preSyncedChats) {
        const synced = preSyncedChats;
        preSyncedChats = null;
        emit({ id, ok: true, result: synced });
        return;
      }
      const cached = database.listConversationChats(ACCOUNT_ID);
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

    if (method === "friends.list") {
      if (preSyncedFriends) {
        const synced = preSyncedFriends;
        preSyncedFriends = null;
        emit({ id, ok: true, result: synced });
        return;
      }
      const cached = database.listChats(ACCOUNT_ID, "dm");
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

    if (method === "message.list" || method === "messages.list") {
      const chatId = String(request?.params?.chatId ?? "");
      const kind = String(request?.params?.kind ?? "talk");
      const limit = Math.max(1, Math.min(Number(request?.params?.limit ?? 50), 100));
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
      if (cached) {
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

      const stored = refresh
        ? []
        : await enrichStoredTalkSenders(database.listMessages(ACCOUNT_ID, chatId, limit));
      if (stored.length) {
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
        : await fetchTalkMessagesNormalized(chatId, limit);
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
      emit({ id, ok: true, result: visibleResult });
      return;
    }

    if (method === "message.read_state") {
      const chatId = String(request?.params?.chatId ?? "").trim();
      const kind = String(request?.params?.kind ?? "talk");
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
      const chatId = String(request?.params?.chatId ?? "").trim();
      const kind = messageKind(request?.params?.kind, chatId);
      const messageId = String(request?.params?.messageId ?? "").trim();
      if (!chatId) throw new Error("chatId is required");
      const result = await reactToMessage(chatId, kind, messageId, request?.params?.reaction);
      emit({ id, ok: true, result: normalize(result) });
      return;
    }

    if (method === "message.delete_for_me" || method === "message.deleteForMe") {
      const chatId = String(request?.params?.chatId ?? "").trim();
      const kind = messageKind(request?.params?.kind, chatId);
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
      const chatId = String(request?.params?.chatId ?? "").trim();
      const kind = messageKind(request?.params?.kind, chatId);
      const messageId = String(request?.params?.messageId ?? "").trim();
      if (!chatId) throw new Error("chatId is required");
      const result = await unsendMessage(chatId, kind, messageId);
      emit({ id, ok: true, result: normalize(result) });
      return;
    }

    if (method === "media.preview" || method === "media.preview.get") {
      const messageId = String(request?.params?.messageId ?? "");
      const kind = String(request?.params?.kind ?? "talk");
      const chatId = String(request?.params?.chatId ?? "").trim() || undefined;
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
      const chatId = String(request?.params?.chatId ?? "");
      const kind = String(request?.params?.kind ?? "talk");
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
      const chatId = String(request?.params?.chatId ?? "");
      const text = String(request?.params?.text ?? "");
      const kind = outboxKind(request?.params?.kind, chatId);
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
      const chatId = String(request?.params?.chatId ?? "");
      const kind = outboxKind(request?.params?.kind, chatId);
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

    if (method === "sticker.recent") {
      const limit = Math.max(1, Math.min(Number(request?.params?.limit ?? 240), 1_000));
      emit({ id, ok: true, result: (await listOwnedStickers()).slice(0, limit) });
      return;
    }

    if (method === "emoji.recent") {
      emit({ id, ok: true, result: database.listRecentEmoji(ACCOUNT_ID, Number(request?.params?.limit ?? 72)) });
      return;
    }

    if (method === "message.sendEmoji") {
      const chatId = String(request?.params?.chatId ?? "");
      const kind = outboxKind(request?.params?.kind, chatId);
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
      const chatId = String(request?.params?.chatId ?? "");
      const kind = String(request?.params?.kind ?? "talk");
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
        kind: outboxKind(kind, chatId),
        contentType,
        filePath,
        filename,
        mime,
        durationMs: Number(request?.params?.durationMs ?? 0) > 0 ? Number(request?.params?.durationMs) : undefined,
        fingerprint: messageFingerprint({
          chatId,
          kind: outboxKind(kind, chatId),
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
      const result = await callManager.start(peer);
      emit({ id, ok: true, result });
      return;
    }

    if (method === "call.accept") {
      const result = await callManager.accept();
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
  device: "DESKTOPWIN",
});

restorePromise = process.env.LINEY_DISABLE_AUTO_RESTORE === "1"
  ? Promise.resolve()
  : autoRestore();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    void handle(JSON.parse(trimmed));
  } catch (error) {
    emit({ ok: false, error: errorInfo(error) });
  }
});

let shutdownInFlight: Promise<void> | null = null;
const shutdown = async (): Promise<void> => {
  if (shutdownInFlight) return shutdownInFlight;
  shutdownInFlight = (async () => {
    listenerAbort?.abort();
    await callManager.stop("engine-shutdown").catch(() => undefined);
    rl.close();
  })();
  return shutdownInFlight;
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
