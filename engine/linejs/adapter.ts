/**
 * LineJsAdapter — isolates @evex/linejs behind a stable boundary.
 * UI/engine must not import "@evex/linejs" directly (AGENTS.md:4).
 * Future LINEJS API changes or replacements require changes only here.
 */
import { Buffer } from "node:buffer";
import { listLineAlbums, listLineAlbumPhotos, previewLineAlbumPhoto } from "./albums";
import { loginWithAuthToken, loginWithPassword, loginWithQR, Client as LineJsRuntimeClient, SquareMessage, TalkMessage, User as LineJsUser, type Client } from "@evex/linejs";
import { BaseClient } from "@evex/linejs/base";
import { MemoryStorage } from "@evex/linejs/storage";
import { parseCancelCall, parseIncomingCall } from "@evex/linejs/call";

// All LINEJS runtime values and types used by the engine are re-exported from
// this module. Other engine modules should depend on this boundary rather than
// importing the replaceable protocol implementation directly.
export { SquareMessage, TalkMessage };
export { parseCancelCall, parseIncomingCall };
export {
  BaseStorage,
  type Storage,
} from "@evex/linejs/storage";
export {
  type CallSession,
  AndromedaTransport,
  PlanetTransport,
  opusCodecFactory,
  type CallTransport,
  type CodecFactory,
  type CallSessionState,
} from "@evex/linejs/call";

export const LINEJS_VERSION = "3.5.0";
export type LineClient = Client;

export const LineJsAdapter = {
  listLineAlbums,
  listLineAlbumPhotos,
  previewLineAlbumPhoto,
  loginWithQR,
  loginWithBrandedQR,
  loginWithPassword,
  loginWithAuthToken,
  createTalkMessage,
  fromRawTalk,
  createSquareMessage,
  parseIncomingCall,
  parseIncomingCallForClient,
  parseCancelCall,
  getMyProfile,
  fetchJoinedChats,
  fetchJoinedSquareChats,
  getUser,
  getChat,
  findContactBySearchIdOrTicketV3,
  addFriendByUserId,
  createTalkChat,
  createSquare,
  getSquareChat,
  getTargetProfiles,
  renameThrift,
  request,
  fetch,
  fetchMessageAsset,
  authToken,
  systemType,
  getMessageDataUrl,
  downloadMediaByE2EE,
  downloadMessageData,
  getContactsV2,
  getContacts,
  fetchUsers,
  getSquareMember,
  getMessageBoxes,
  getTalkMessageReadRanges,
  talkMessageEditState,
  replyTargetMessageId,
  getUserFriendIds,
  getSquareChatStatus,
  fetchSquareChatEvents,
  getPreviousMessages,
  getRecentMessages,
  profileMid,
  decryptE2EEMessage,
  createPollingSession,
  push,
  renewPushStream,
  renewPushStreams,
  pushStream,
  closePushStream,
  closePushConnections,
  setPushListening,
  initializePushConnection,
  readPush,
  on,
  sendTalkMessage,
  uploadObjTalk,
  sendTalkMediaE2EE,
  getReqseq,
  reactToSquareMessage,
  cancelTalkReaction,
  reactToTalkMessage,
  unsendSquareMessage,
  unsendTalkMessage,
  markSquareMessageRead,
  markSquareChatsRead,
  sendTalkChecked,
  markTalkMessageRead,
  startCallSession,
  answerIncomingCall,
  setCallCodecFactory,
  // Re-export version for RPC capabilities
  version: LINEJS_VERSION,
};


export type LineyLoginBrand = {
  modelName: string;
  systemName: string;
};

/** Isolated, in-memory storage used for a same-account QR keychain refresh. */
export function createTemporaryQrStorage(initialData: Record<string, unknown>) {
  const storage = new MemoryStorage(initialData as any);
  return {
    storage,
    snapshot: () => storage.getAll() as Record<string, unknown>,
    clear: () => storage.clear(),
  };
}

/** Rebind a QR-authenticated client to Liney's durable, protected storage. */
export function bindClientStorage(client: LineClient, storage: unknown): void {
  const base = (client as any).base;
  if (!base || !("storage" in base)) throw new Error("LINEJS client storage is unavailable");
  base.storage = storage;
  if (base.storage !== storage) throw new Error("LINEJS client storage could not be rebound");
}

export async function loginWithBrandedQR(
  opts: Parameters<typeof loginWithQR>[0],
  init: Parameters<typeof loginWithQR>[1],
  brand: LineyLoginBrand,
): Promise<Client> {
  const base = new BaseClient(init as any);
  const loginProcess = (base as any).loginProcess;
  const modelName = String(brand.modelName || "Liney-Linux").slice(0, 48);
  const systemName = String(brand.systemName || "Liney-Linux").slice(0, 48);

  if (typeof loginProcess?.qrCodeLoginV2 === "function") {
    const original = loginProcess.qrCodeLoginV2.bind(loginProcess);
    loginProcess.qrCodeLoginV2 = (authSessionId: string, rawModelName?: string, rawSystemName?: string, autoLoginIsRequired = true) =>
      original(authSessionId, rawModelName || modelName, rawSystemName || systemName, autoLoginIsRequired);
  }

  if (typeof loginProcess?.qrCodeLoginV2ForSecure === "function") {
    const original = loginProcess.qrCodeLoginV2ForSecure.bind(loginProcess);
    loginProcess.qrCodeLoginV2ForSecure = (authSessionId: string, nonce: string, rawModelName?: string, rawSystemName?: string, autoLoginIsRequired = true) =>
      original(authSessionId, nonce, rawModelName || modelName, rawSystemName || systemName, autoLoginIsRequired);
  }

  base.on("qrcall", opts.onReceiveQRUrl);
  base.on("pincall", opts.onPincodeRequest);
  await loginProcess.withQrCode({});
  await loginProcess.ready();
  return new LineJsRuntimeClient(base as any) as Client;
}

// Thin helpers to avoid spreading LINEJS types throughout engine
export async function getMyProfile(client: Client) {
  return client.getMyProfile();
}
export async function fetchJoinedChats(client: Client) {
  return client.fetchJoinedChats();
}
export async function fetchJoinedSquareChats(client: Client) {
  return client.fetchJoinedSquareChats();
}
export async function getUser(client: Client, mid: string) {
  return client.getUser(mid);
}
export async function getChat(client: Client, chatId: string) {
  return client.getChat(chatId);
}

export function findContactBySearchIdOrTicketV3(client: LineClient, searchId: string) {
  return (client as any).base.relation.findContactBySearchIdOrTicketV3({ searchId });
}

export function addFriendByUserId(client: LineClient, userId: string) {
  return (client as any).base.relation.addFriendByUserId({ userId });
}

export async function createTalkChat(client: LineClient, name: string, targetUserMids: string[]) {
  const reqSeq = await (client as any).base.getReqseq();
  return (client as any).base.talk.createChat({
    request: {
      reqSeq,
      type: "GROUP",
      name,
      targetUserMids,
      picturePath: "",
    },
  });
}

export function createSquare(client: LineClient, options: { squareName: string; displayName: string; description?: string; searchable?: boolean }) {
  return (client as any).base.square.createSquare({
    squareName: options.squareName,
    displayName: options.displayName,
    description: options.description,
    searchable: options.searchable ?? true,
    squareJoinMethodType: "NONE",
  });
}

export function createTalkMessage(client: LineClient, raw: unknown): TalkMessage {
  return new TalkMessage({ client, raw: raw as any });
}

export async function fromRawTalk(client: LineClient, raw: unknown): Promise<TalkMessage> {
  return TalkMessage.fromRawTalk(raw as any, client);
}

export function createSquareMessage(client: LineClient, raw: unknown): SquareMessage {
  return new SquareMessage({ client, raw: raw as any });
}

export async function getSquareChat(client: LineClient, chatId: string) {
  return (client as any).getSquareChat(chatId);
}

export function renameThrift(client: LineClient, schema: string, value: unknown): unknown {
  return (client as any).base.thrift.rename_thrift(schema, value);
}

export function request(
  client: LineClient,
  fields: unknown[],
  method: string,
  version: number,
  parse: boolean,
  endpoint: string,
) {
  return (client as any).base.request.request(fields, method, version, parse, endpoint);
}

export function fetch(client: LineClient, url: string, init?: RequestInit): Promise<Response> {
  return (client as any).base.fetch(url, init);
}

export async function fetchMessageAsset(client: LineClient, url: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(client, url, init);
  if (!response.ok) throw new Error(`LINE asset request failed (${response.status})`);
  return response.blob();
}

export function authToken(client: LineClient): string | undefined {
  return (client as any).base.authToken;
}

export function systemType(client: LineClient): string {
  return String((client as any).base.request.systemType ?? "");
}

export function getMessageDataUrl(client: LineClient, messageId: string, isPreview: boolean, isSquare: boolean): string {
  return (client as any).base.obs.getMessageDataUrl(messageId, isPreview, isSquare);
}

export function downloadMediaByE2EE(client: LineClient, raw: unknown): Promise<Blob> {
  return (client as any).base.obs.downloadMediaByE2EE(raw);
}

export function downloadMessageData(client: LineClient, params: Record<string, unknown>): Promise<Blob> {
  return (client as any).base.obs.downloadMessageData(params);
}

export function getContactsV2(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.talk.getContactsV2(params);
}

export function getContacts(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.talk.getContacts(params);
}

/**
 * Fetches friends using LINEJS's supported V3 → V2 → getUser fallback path.
 * Keep this compatibility policy behind the adapter boundary.
 */
const FRIEND_CONTACT_BATCH_SIZE = 50;

function isInvalidContactLength(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /INVALID_LENGTH|invalid length/i.test(message);
}

function hasUsefulContactName(user: any): boolean {
  const raw = user?.raw && typeof user.raw === "object" ? user.raw : {};
  const records = [
    raw,
    raw?.contact,
    raw?.targetProfileDetail,
    raw?.profile,
    raw?.contact?.targetProfileDetail,
    raw?.contact?.profile,
  ].filter((value) => value && typeof value === "object");
  return records.some((record) => [
    record.displayNameOverridden,
    record.profileName,
    record.displayName,
    record.name,
  ].some((value) => {
    if (typeof value !== "string") return false;
    const name = value.trim();
    return Boolean(name) && !["line user", "line chat"].includes(name.toLowerCase());
  }));
}

async function fetchContactUsers(
  mids: string[],
  fetchBatch: (batch: string[]) => Promise<any>,
  mapResponse: (response: any) => any[],
): Promise<{ users: any[]; failedMids: string[] }> {
  const users: any[] = [];
  const failedMids: string[] = [];
  const pending: string[][] = [];
  for (let start = 0; start < mids.length; start += FRIEND_CONTACT_BATCH_SIZE) {
    pending.push(mids.slice(start, start + FRIEND_CONTACT_BATCH_SIZE));
  }

  while (pending.length) {
    const batch = pending.shift()!;
    try {
      const response = await fetchBatch(batch);
      const mapped = mapResponse(response);
      users.push(...mapped);
      const resolved = new Set(mapped
        .filter(hasUsefulContactName)
        .map((user) => String(user?.mid ?? user?.raw?.targetUserMid ?? "").trim())
        .filter(Boolean));
      failedMids.push(...batch.filter((mid) => !resolved.has(mid)));
    } catch (error) {
      // Some LINE endpoints impose a smaller server-side limit than the
      // advertised limit. Split only the rejected batch and retain all other
      // successful batches instead of discarding the complete friend refresh.
      if (isInvalidContactLength(error) && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2);
        pending.unshift(batch.slice(middle));
        pending.unshift(batch.slice(0, middle));
      } else {
        failedMids.push(...batch);
      }
    }
  }
  return { users, failedMids };
}

/**
 * Fetch profiles in bounded, adaptive batches. An endpoint error for one batch
 * is isolated so cached and successfully refreshed contacts remain available.
 */
export async function fetchUsers(client: LineClient): Promise<any[]> {
  const runtime = client as any;
  const relation = runtime.base?.relation;
  const talk = runtime.base?.talk;
  if (!relation?.getUserFriendIds) throw new Error("LINEJS friend list fetch is unavailable");

  const result = await relation.getUserFriendIds({ request: { blockStatus: "ALL" } });
  const rawMids = Array.isArray(result?.userFriendMids) ? result.userFriendMids : [];
  const friendMids = [...new Set(rawMids.map((mid: unknown) => String(mid ?? "").trim()).filter(Boolean))];
  if (!friendMids.length) return [];

  let users: any[] = [];
  let unresolved = friendMids;
  if (typeof relation.getContactsV3 === "function") {
    const v3 = await fetchContactUsers(
      unresolved,
      (batch) => relation.getContactsV3({ mids: batch }),
      (response) => (response?.responses ?? []).map((raw: any) => new LineJsUser({ client, raw })),
    );
    users = v3.users;
    unresolved = v3.failedMids;
  }

  if (unresolved.length && typeof talk?.getContactsV2 === "function") {
    const v2 = await fetchContactUsers(
      unresolved,
      (batch) => talk.getContactsV2({ mids: batch }),
      (response) => Object.entries(response?.contacts ?? {}).map(([mid, entry]) => new LineJsUser({
        client,
        raw: { ...(entry as object), targetUserMid: mid } as never,
      })),
    );
    users.push(...v2.users);
    unresolved = v2.failedMids;
  }

  // Use the per-user endpoint only for contacts that the batched endpoints
  // could not resolve. Bound concurrency to avoid turning a partial sync into
  // a burst of hundreds of profile requests.
  if (typeof runtime.getUser === "function" && unresolved.length) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, unresolved.length) }, async () => {
      while (cursor < unresolved.length) {
        const mid = unresolved[cursor++];
        try {
          users.push(await runtime.getUser(mid));
        } catch {
          // Keep the profile missing; the next background refresh can retry.
        }
      }
    });
    await Promise.all(workers);
  }

  return users;
}

export function getSquareMember(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.square.getSquareMember(params);
}

/**
 * Match LINEJS getReplyTarget(): relatedMessageId is only a reply when the
 * relation type is REPLY (wire value 3). FORWARD/AUTO_REPLY/SUBORDINATE also
 * use relatedMessageId but must not be rendered as quoted replies.
 */
export function replyTargetMessageId(value: unknown): string | undefined {
  const wrapper = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = wrapper.message && typeof wrapper.message === "object"
    ? wrapper.message as Record<string, unknown>
    : wrapper;
  const relation = nested.messageRelationType;
  if (relation !== 3 && String(relation ?? "").trim().toUpperCase() !== "REPLY") return undefined;
  const id = String(nested.relatedMessageId ?? "").trim();
  return id || undefined;
}

export type TalkMessageEditState = {
  edited: boolean;
  updatedTime?: number;
};

/** Normalize LINEJS's edit markers from both live operations and history. */
export function talkMessageEditState(message: unknown): TalkMessageEditState {
  const wrapper = message && typeof message === "object" ? message as Record<string, unknown> : {};
  const rawValue = wrapper.raw && typeof wrapper.raw === "object" ? wrapper.raw : message;
  const raw = rawValue && typeof rawValue === "object" ? rawValue as Record<string, unknown> : {};
  const metadata = raw.contentMetadata && typeof raw.contentMetadata === "object"
    ? raw.contentMetadata as Record<string, unknown>
    : {};

  let wrapperEdited = false;
  let wrapperUpdated: unknown;
  try { wrapperEdited = Boolean((message as any)?.isEdited); } catch { /* raw fallback below */ }
  try { wrapperUpdated = (message as any)?.updatedTime; } catch { /* raw fallback below */ }

  const candidate = wrapperUpdated ?? metadata.UPDATED_TIME ?? raw.updatedTime;
  const hasUpdatedMarker = candidate !== undefined && candidate !== null && String(candidate).trim() !== "";
  const numeric = typeof candidate === "bigint" ? Number(candidate) : Number(candidate);
  const updatedTime = hasUpdatedMarker && Number.isFinite(numeric) ? numeric : undefined;
  const edited = wrapperEdited || metadata.EDITED === "true" || hasUpdatedMarker;
  return updatedTime === undefined ? { edited } : { edited, updatedTime };
}

export type TalkMessageReadRangeEntry = {
  startMessageId: string;
  endMessageId: string;
  startTime: number;
  endTime: number;
};

export type TalkMessageReadRange = {
  chatId: string;
  ranges: Record<string, TalkMessageReadRangeEntry[]>;
};

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function int64String(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return String(value);
  if (value && typeof value === "object") {
    try {
      const text = String(value).trim();
      if (/^-?\d+$/.test(text)) return text;
    } catch { /* ignore malformed int64 wrappers */ }
  }
  return "";
}

function int64Time(value: unknown): number {
  if (typeof value === "bigint") {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function readRangeEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = objectRecord(value);
  if (!Object.keys(record).length) return [];
  if ("startMessageId" in record || "endMessageId" in record || "1" in record || "2" in record) return [record];
  return Object.entries(record)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, entry]) => entry);
}

/**
 * Normalize LINEJS's getMessageReadRange response. In 3.4.2 the generated
 * Thrift schema names the map value as the unresolved type `th`, so each
 * reader's list can arrive as an object with numeric keys and each entry can
 * still use raw field ids (1..4). Keep that quirk inside the adapter.
 */
export function normalizeTalkMessageReadRanges(value: unknown): TalkMessageReadRange[] {
  const rows = Array.isArray(value) ? value : [];
  return rows.flatMap((row): TalkMessageReadRange[] => {
    const raw = objectRecord(row);
    const chatId = String(raw.chatId ?? raw["1"] ?? "").trim();
    if (!chatId) return [];
    const rawRanges = objectRecord(raw.ranges ?? raw["2"]);
    const ranges: Record<string, TalkMessageReadRangeEntry[]> = {};
    for (const [readerMid, rawEntries] of Object.entries(rawRanges)) {
      const mid = String(readerMid).trim();
      if (!mid) continue;
      const entries = readRangeEntries(rawEntries).flatMap((entry): TalkMessageReadRangeEntry[] => {
        const item = objectRecord(entry);
        const startMessageId = int64String(item.startMessageId ?? item["1"]);
        const endMessageId = int64String(item.endMessageId ?? item["2"]);
        if (!startMessageId || !endMessageId) return [];
        return [{
          startMessageId,
          endMessageId,
          startTime: int64Time(item.startTime ?? item["3"]),
          endTime: int64Time(item.endTime ?? item["4"]),
        }];
      });
      if (entries.length) ranges[mid] = entries;
    }
    return [{ chatId, ranges }];
  });
}

export async function getTalkMessageReadRanges(
  client: LineClient,
  chatIds: string[],
): Promise<TalkMessageReadRange[]> {
  const uniqueChatIds = [...new Set(chatIds.map((chatId) => String(chatId).trim()).filter(Boolean))];
  if (!uniqueChatIds.length) return [];
  const result = await (client as any).base.talk.getMessageReadRange({
    chatIds: uniqueChatIds,
    syncReason: "INTERNAL",
  });
  return normalizeTalkMessageReadRanges(result);
}

export function getMessageBoxes(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.talk.getMessageBoxes(params);
}

export function getUserFriendIds(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.relation.getUserFriendIds(params);
}

export function getSquareChatStatus(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.square.getSquareChatStatus(params);
}

export function fetchSquareChatEvents(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.square.fetchSquareChatEvents(params);
}

export function getPreviousMessages(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.talk.getPreviousMessagesV2WithRequest(params);
}

export function getRecentMessages(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.talk.getRecentMessagesV2(params);
}

export function profileMid(client: LineClient): unknown {
  return (client as any).base.profile?.mid;
}

export function decryptE2EEMessage(client: LineClient, encrypted: unknown) {
  return (client as any).base.e2ee.decryptE2EEMessage(encrypted);
}

export type LineyPollingOptions = {
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
  pollingInterval?: number;
};

export type LineyPollingSession = {
  talk(options?: LineyPollingOptions): AsyncIterable<unknown>;
  square(options?: LineyPollingOptions): AsyncIterable<unknown>;
};

export function createPollingSession(client: LineClient): LineyPollingSession {
  const polling = (client as any).base.createPolling();
  return {
    talk: (options = {}) => polling._listenTalkEvents(options),
    square: (options = {}) => polling._listenSquareEvents(options),
  };
}

export function push(client: LineClient) {
  return (client as any).base.push;
}

export function renewPushStreams(pushClient: any): void {
  pushClient.opStream.renew();
  pushClient.sqStream.renew();
}

export function renewPushStream(pushClient: any, stream: "op" | "sq"): void {
  (stream === "op" ? pushClient.opStream : pushClient.sqStream).renew();
}

export function pushStream(pushClient: any, stream: "op" | "sq"): AsyncIterable<unknown> {
  return (stream === "op" ? pushClient.opStream : pushClient.sqStream).stream;
}

export function closePushStream(pushClient: any, stream: "op" | "sq"): void {
  try { (stream === "op" ? pushClient.opStream : pushClient.sqStream).close(); } catch { /* best effort */ }
}

export async function closePushConnections(pushClient: any): Promise<void> {
  const connections = Array.isArray(pushClient?.conns) ? [...pushClient.conns] : [];
  await Promise.all(connections.map(async (connection: any) => {
    try { await connection?.close?.(); } catch { /* best effort */ }
  }));
  if (Array.isArray(pushClient?.conns)) pushClient.conns.length = 0;
}

export function setPushListening(pushClient: any, listening: boolean): void {
  pushClient.islisten = listening;
}

export function initializePushConnection(pushClient: any, revision: number, operations: number[]) {
  return pushClient.initializeConn(revision, operations);
}

export function readPush(pushClient: any, operations: number[]) {
  return pushClient.InitAndRead(operations);
}

export function on(client: LineClient, event: string, listener: (...args: any[]) => void): void {
  (client as any).base.on(event, listener);
}

const e2eeSenderKeyUpdates = new WeakMap<object, Promise<void>>();

async function updateE2EESenderKey(client: LineClient): Promise<void> {
  const key = client as object;
  const pending = e2eeSenderKeyUpdates.get(key);
  if (pending) return pending;

  const update = (async () => {
    const base = (client as any).base;
    const e2ee = base.e2ee;
    const selfMid = base.profile?.mid;
    if (typeof selfMid !== "string" || !selfMid) {
      throw new Error("LINE requires an E2EE sender-key update, but the active account profile is unavailable");
    }
    if (typeof e2ee?.registerE2EEKeyPair !== "function") {
      throw new Error("LINE requires an E2EE sender-key update, but key registration is unavailable");
    }
    const registered = await e2ee.registerE2EEKeyPair();
    if (!registered) {
      throw new Error("LINE requires an E2EE sender-key update, but key registration failed");
    }
    const keyData = {
      keyId: registered.keyId,
      privKey: Buffer.from(registered.privKey).toString("base64"),
      pubKey: Buffer.from(registered.pubKey).toString("base64"),
      e2eeVersion: registered.e2eeVersion,
    };
    if (typeof e2ee.saveE2EESelfKeyData !== "function" || typeof e2ee.getE2EESelfKeyData !== "function") {
      throw new Error("LINE registered an E2EE key, but the active sender-key store is unavailable");
    }
    await e2ee.saveE2EESelfKeyData(keyData);
    const activeKey = await e2ee.getE2EESelfKeyData(selfMid);
    if (
      String(activeKey?.keyId ?? "") !== String(registered.keyId)
      || activeKey?.privKey !== keyData.privKey
      || activeKey?.pubKey !== keyData.pubKey
    ) {
      throw new Error("LINE registered an E2EE key, but the active session still selects a stale sender key");
    }
    if (typeof e2ee.verifyStoredKeyAgainstServer === "function") {
      const verified = await e2ee.verifyStoredKeyAgainstServer(registered.keyId, registered.privKey);
      if (verified === false) {
        throw new Error("LINE registered an E2EE sender key that does not match the server's public key");
      }
    }
  })();
  e2eeSenderKeyUpdates.set(key, update);
  try {
    await update;
  } catch (error) {
    if (e2eeSenderKeyUpdates.get(key) === update) e2eeSenderKeyUpdates.delete(key);
    throw error;
  }
}

function codeFromTalkErrorMessage(message: string): string {
  const marker = message.indexOf('"code"');
  if (marker < 0) return "";
  const colon = message.indexOf(":", marker + 6);
  if (colon < 0) return "";
  const quoteStart = message.indexOf('"', colon + 1);
  if (quoteStart < 0) return "";
  const quoteEnd = message.indexOf('"', quoteStart + 1);
  return quoteEnd > quoteStart ? message.slice(quoteStart + 1, quoteEnd) : "";
}

function talkSendErrorCode(error: unknown): string {
  if (typeof error === "string") return codeFromTalkErrorMessage(error);
  if (!error || typeof error !== "object") return "";
  const value = error as {
    code?: unknown;
    data?: { code?: unknown; e?: { code?: unknown }; error?: { code?: unknown } };
    message?: unknown;
    cause?: unknown;
  };
  const code = value.data?.code ?? value.data?.e?.code ?? value.data?.error?.code ?? value.code;
  if (code !== undefined && code !== null) return String(code);
  const message = typeof value.message === "string" ? value.message : String(error);
  const parsedCode = codeFromTalkErrorMessage(message);
  if (parsedCode) return parsedCode;
  return value.cause && value.cause !== error ? talkSendErrorCode(value.cause) : "";
}
function isTalkSenderKeyError(error: unknown): boolean {
  const code = talkSendErrorCode(error);
  if (code === "E2EE_UPDATE_SENDER_KEY" || code === "83") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("invalid sender key");
}

export async function sendTalkMessage(
  client: LineClient,
  params: Record<string, unknown>,
  rebuildAfterSenderKeyUpdate?: () => Promise<Record<string, unknown>>,
) {
  const talk = (client as any).base.talk;
  try {
    return await talk.sendMessage(params);
  } catch (error) {
    if (!isTalkSenderKeyError(error) || params.e2ee === false) throw error;
    await updateE2EESenderKey(client);
    // The sender-key ID is embedded in E2EE chunks. Media retries must rebuild
    // those chunks after key rotation, while text lets LINEJS encrypt the text.
    try {
      const retryParams = rebuildAfterSenderKeyUpdate
        ? await rebuildAfterSenderKeyUpdate()
        : { ...params, e2ee: true };
      return await talk.sendMessage(retryParams);
    } catch (retryError) {
      if (isTalkSenderKeyError(retryError)) {
        throw new Error(
          "LINE still rejects the verified E2EE sender key. Reconnect this LINE account to refresh its encrypted session.",
          { cause: retryError },
        );
      }
      throw retryError;
    }
  }
}
export function uploadObjTalk(client: LineClient, ...args: any[]) {
  return (client as any).base.obs.uploadObjTalk(...args);
}

export type TalkMediaObjectType = "image" | "video" | "audio" | "file" | "gif";

/**
 * LINEJS 3.4.2 can upload Talk media with E2EE, but its public helper does
 * not expose relatedMessageId. Keep the upstream wire sequence here at the
 * adapter boundary and add the reply relation only to the final Talk message.
 * This avoids downgrading media replies to plaintext OBS messages.
 */
export async function sendTalkMediaE2EE(
  client: LineClient,
  options: {
    to: string;
    oType: TalkMediaObjectType;
    data: Blob;
    filename?: string;
    preview?: Blob;
    durationMs?: number;
    relatedMessageId?: string;
  },
): Promise<unknown> {
  const { to, oType, data, filename, preview, durationMs, relatedMessageId } = options;
  if (!(to.startsWith("u") || to.startsWith("c"))) throw new Error("invalid Talk MID");

  const typeSet: Record<TalkMediaObjectType, [string, number]> = {
    image: ["emi", 1],
    video: ["emv", 2],
    audio: ["ema", 3],
    file: ["emf", 14],
    gif: ["emi", 1],
  };
  const [obsNamespace, contentType] = typeSet[oType];
  const ext = filename?.split(".").at(-1)?.trim() || "bin";
  const params: Record<string, string> = { type: "file" };
  if (oType === "gif") params.cat = "original";

  const base = (client as any).base;
  const encrypted = await base.e2ee.encryptByKeyMaterial(Buffer.from(await data.arrayBuffer()));
  const encryptedBytes = Buffer.isBuffer(encrypted.encryptedData)
    ? encrypted.encryptedData
    : Buffer.from(encrypted.encryptedData);
  const encryptedBlob = new Blob([new Uint8Array(encryptedBytes)]);
  const tempId = `reqid-${crypto.randomUUID()}`;
  const original = await base.obs.uploadObjectForService({
    data: encryptedBlob,
    oType: "file",
    obsPath: `talk/${obsNamespace}/${tempId}`,
    params,
  });
  const objId = String(original?.objId ?? "").trim();
  if (!objId) throw new Error("LINE OBS did not return an object id");

  if (oType === "image" || oType === "gif" || oType === "video") {
    let previewBlob = encryptedBlob;
    if (preview) {
      const previewEncrypted = await base.e2ee.encryptByKeyMaterial(
        Buffer.from(await preview.arrayBuffer()),
        Buffer.from(String(encrypted.keyMaterial), "base64"),
      );
      const previewBytes = Buffer.isBuffer(previewEncrypted.encryptedData)
        ? previewEncrypted.encryptedData
        : Buffer.from(previewEncrypted.encryptedData);
      previewBlob = new Blob([new Uint8Array(previewBytes)]);
    }
    const previewUpload = await base.obs.uploadObjectForService({
      data: previewBlob,
      oType: "file",
      obsPath: `talk/${obsNamespace}/${objId}__ud-preview`,
      params,
    });
    if (String(previewUpload?.objId ?? "") !== objId) throw new Error("LINE OBS preview object id mismatch");
  }

  const roundedDuration = typeof durationMs === "number" ? Math.round(durationMs) : NaN;
  const durationMetadata = oType === "video" && Number.isSafeInteger(roundedDuration) && roundedDuration > 0
    ? { DURATION: String(roundedDuration) }
    : {};

  const contentMetadata = {
    SID: obsNamespace,
    OID: objId,
    FILE_SIZE: String(encryptedBlob.size),
    e2eeVersion: "2",
    ...(oType === "image" || oType === "gif" || oType === "video"
      ? { MEDIA_CONTENT_INFO: JSON.stringify({
        category: "original",
        fileSize: encryptedBlob.size,
        extension: ext,
        animated: oType === "gif",
      }) }
      : {}),
    ...durationMetadata,
  };
  const buildEncryptedMessage = async () => ({
    to,
    chunks: await base.e2ee.encryptE2EEMessage(
      to,
      { keyMaterial: encrypted.keyMaterial, fileName: filename || "line." + ext },
      contentType,
    ),
    contentType,
    contentMetadata,
    ...(relatedMessageId ? { relatedMessageId } : {}),
    e2ee: true,
  });

  return sendTalkMessage(client, await buildEncryptedMessage(), buildEncryptedMessage);
}

export function getReqseq(client: LineClient) {
  return (client as any).base.getReqseq();
}

export function reactToSquareMessage(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.square.reactToMessage(params);
}

export function cancelTalkReaction(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.talk.cancelReaction(params);
}

export function reactToTalkMessage(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.talk.react(params);
}

export function unsendSquareMessage(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.square.unsendMessage(params);
}

export function unsendTalkMessage(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.talk.unsendMessage(params);
}

export function markSquareMessageRead(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.square.markAsRead(params);
}

export function markSquareChatsRead(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.square.markChatsAsRead(params);
}

export function sendTalkChecked(client: LineClient, params: Record<string, unknown>) {
  return (client as any).base.talk.sendChatChecked(params);
}

/**
 * Mark a Talk room read through the same wire shape used by TalkMessage.read().
 * Keep the message id as decimal text: sendChatChecked's thrift field is a
 * string, and coercing LINE's 64-bit ids through Number would corrupt it.
 */
export async function markTalkMessageRead(client: LineClient, chatId: string, messageId: string): Promise<void> {
  const normalizedChatId = String(chatId).trim();
  const normalizedMessageId = String(messageId).trim();
  if (!normalizedChatId) throw new Error("chatId is required");
  if (!/^\d+$/.test(normalizedMessageId)) throw new Error("LINE message id is not available yet");
  await (client as any).base.talk.sendChatChecked({
    chatMid: normalizedChatId,
    lastMessageId: normalizedMessageId,
    seq: await (client as any).base.getReqseq(),
  });
}

export function parseIncomingCallForClient(client: LineClient, operation: unknown) {
  return (parseIncomingCall as any)(operation, (client as any).base.profile?.mid ?? "");
}

export function answerIncomingCall(
  client: LineClient,
  event: unknown,
  opts: {
    deviceId: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    debug?: (event: Record<string, unknown>) => void;
    preferVideo?: boolean;
  },
) {
  const answer = (client as any).call?.answerIncoming;
  if (typeof answer !== "function") throw new Error("LINEJS incoming PLANET answer helper is unavailable");
  return answer.call((client as any).call, event, opts);
}

export function startCallSession(client: LineClient, params: Record<string, unknown>) {
  return (client as any).call.startSession(params);
}

export function setCallCodecFactory(client: LineClient, factory: unknown): void {
  (client as any).call.setCodecFactory(factory);
}

/**
 * Resolve the lightweight profile metadata LINE exposes for message senders.
 * `userType === "BOT"` is the only public signal that a sender is an
 * Official Account-like bot. Keep this classification behind the adapter so
 * the rest of the engine does not depend on LINEJS response details.
 */
export async function getTargetProfiles(client: LineClient, mids: string[]) {
  const targetUsers = [...new Set(mids.map((mid) => String(mid).trim()).filter(Boolean))]
    .map((targetUserMid) => ({ targetUserMid }));
  if (!targetUsers.length) return [];
  const response = await client.base.relation.getTargetProfiles({
    request: {
      targetUsers,
      syncReason: "INTERNAL",
    },
  });
  return Array.isArray(response?.responses) ? response.responses : [];
}
