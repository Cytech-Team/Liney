import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Archive,
  Bell,
  ChevronDown,
  CheckCheck,
  Ellipsis,


  KeyRound,
  Link2,
  Image,
  Info,
  LoaderCircle,
  LogIn,
  Maximize2,
  Mail,
  MessageCircle,
  Mic,
  Moon,
  Monitor,
  Paperclip,
  Pencil,
  Pin as PinIcon,
  Phone,
  Plus,
  QrCode,
  Reply,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Smile,
  Sparkles,
  Star,
  Sun,
  TriangleAlert,
  Trash,
  Undo2,
  Users,
  UserPlus,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import "./App.css";
import "./liney-desktop-refresh.css";
import { chats as seedChats, messages as seedMessages, type Chat, type Message } from "./data/mock";
import { FlexMessage, type FlexAction } from "./components/FlexMessage";
import { RichMessage } from "./components/RichMessage";
import { RemoteImage } from "./components/RemoteImage";
import { LineAlbumsModal } from "./components/LineAlbumsModal";
import { LineNotesModal } from "./components/LineNotesModal";
import { LineProfileSettings } from "./components/LineProfileSettings";
import { FriendSyncDiagnostics } from "./components/FriendSyncDiagnostics";
import { LineChatManageModal } from "./components/LineChatManageModal";
import { ImageViewerOverlay } from "./components/ImageViewerOverlay";
import { EngineRequestError, lineyEngine } from "./lib/engine";
import { callMessagePreview, liveMessagePreview, notificationSenderName, officialLineMessageUrl } from "./lib/message-presentation";
import { notificationAvatarUrl, prepareNotificationAvatar } from "./lib/notification-avatar";
import { MarketingSite, type MarketingView } from "./marketing/MarketingSite";
import {
  compactTimelineRooms,
  getTimelineRooms,
  setTimelineRooms as setMessageMap,
  timelineStore,
  updateTimelineRoom,
  useTimelineRoom,
} from "./stores/timeline-store";

type Section = "messages" | "friends" | "openchat" | "calls";
type ThemeMode = "system" | "light" | "dark";
type AuthMode = "qr" | "password";
type EngineState = "browser-mock" | "starting" | "ready" | "error";
type CallState = "idle" | "incoming" | "acquiring" | "connecting" | "ringing" | "in-call" | "ending" | "ended" | "failed";
const LINE_SYSTEM_ACCOUNT_MID = "u085311ecd9e3e3d74ae4c9f5437cbcb5";
type LiveChatResult = { id: string; name: string; kind: "dm" | "group" | "openchat"; avatarUrl?: string; identityKey?: string; profileIdentityKey?: string; profileSnapshotTime?: number; profileFetchedAt?: number; raw?: Record<string, unknown>; preview?: string; unread?: number; lastMessageTime?: number; memberCount?: number; pinned?: boolean; favoriteTimestamp?: number; statusMessage?: string; isFavorite?: boolean; favoriteTime?: number; historyState?: "available" | "new" | "unavailable" };
type HistoryCandidate = { id: string; name: string; messageCount: number; latestMessageTime: number };
type LiveMessageResult = {
  id: string;
  localId?: string;
  text: string;
  isMine: boolean;
  createdTime: number;
  chatId?: string;
  contentType?: number;
  readCount?: number;
  edited?: boolean;
  updatedTime?: number;
  senderId?: string;
  senderName?: string;
  senderAvatarUrl?: string;
  officialClientUrl?: string;
  isOfficialAccount?: boolean;
  stickerUrl?: string;
  emojiUrl?: string;
  flex?: Message["flex"];
  raw?: unknown;
  filename?: string;
  sendError?: string;
  postNotification?: Message["postNotification"];
  call?: Message["call"];
  rich?: Message["rich"];
  reactions?: Message["reactions"];
  replyTo?: Message["replyTo"];
  replyToId?: string;
  unsent?: boolean;
  readByPeer?: boolean;
  status?: Message["status"];
  systemNotificationTracked?: boolean;
  trackedUnread?: number;
};
type LiveMessageReadState = {
  messageId: string;
  readCount: number;
  readerMids?: string[];
};
type LiveCallHistoryResult = {
  id: string;
  chatId: string;
  kind: "dm" | "group";
  name: string;
  avatarUrl?: string;
  isMine: boolean;
  createdTime: number;
  call: NonNullable<Message["call"]>;
};

type LiveHistoryPage = {
  messages: LiveMessageResult[];
  hasMore: boolean;
};

function mapLiveMessageResult(item: LiveMessageResult, kind: Chat["kind"], autoMedia: boolean): Message {
  const contentType = Number(item.contentType ?? 0);
  return {
    id: item.id,
    author: item.isMine ? "me" : "them",
    text: item.rich || contentType === 7 && item.stickerUrl || contentType === 22 && item.flex
      ? undefined
      : contentType === 1
        ? (kind === "openchat" && !autoMedia ? "รูปภาพ" : "กำลังโหลดรูป…")
        : item.text,
    time: formatTime(item.createdTime),
    createdTime: item.createdTime,
    contentType,
    readCount: Math.max(0, Number(item.readCount ?? 0)),
    readByPeer: Number(item.readCount ?? 0) > 0,
    edited: item.edited,
    updatedTime: item.updatedTime,
    filename: item.filename,
    senderId: item.senderId,
    senderName: item.senderName,
    senderAvatarUrl: item.senderAvatarUrl,
    officialClientUrl: item.officialClientUrl,
    isOfficialAccount: item.isOfficialAccount,
    stickerUrl: item.stickerUrl,
    flex: item.flex,
    raw: item.raw,
    rich: item.rich,
    postNotification: item.postNotification,
    call: item.call,
    reactions: item.reactions,
    replyTo: item.replyTo ?? (item.replyToId ? { id: item.replyToId, text: "ข้อความ" } : undefined),
    replyToId: item.replyToId,
    unsent: item.unsent,
    status: item.status ?? "sent",
    sendError: item.sendError ? formatSendError(item.sendError) : undefined,
  };
}
type ReplyTarget = NonNullable<Message["replyTo"]>;
type MediaPreviewResult = { dataUrl: string };
type NativeClipboardImageResult = { base64: string; mime: string; filename: string };
type MediaProgress = { phase: string; done: number; total: number };
type AudioDeviceResult = { id: string; name: string; description: string; kind: "input" | "output" };
type ScreenShareTargetResult = {
  id: string;
  kind: "desktop" | "monitor" | "window" | "region";
  name: string;
  available: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  primary?: boolean;
};
type CallHardwareStatus = {
  camera?: { available?: boolean; device?: string; backend?: string };
  microphone?: { available?: boolean; backend?: string };
  speaker?: { available?: boolean; backend?: string };
  screenShare?: { available?: boolean; backend?: string };
};
type ProfileResult = { displayName?: string; mid?: string; pictureStatus?: string; statusMessage?: string };
type ClientIdentityResult = { displayName?: string; modelName?: string; systemName?: string; platform?: string; channel?: string; device?: string };
type RecentSticker = { packageId: string; stickerId: string; version: string; option?: string; owned: boolean };
type RecentEmoji = { productId: string; sticonId: string; version: string; resourceType: string; owned: boolean };
type SyncProgressState = { visible: boolean; phase: "metadata" | "friends" | "chats" | "history" | "complete" | "error"; done: number; total: number; failed: number; error?: string; summary?: { friends?: number; talkChats?: number; openChats?: number; histories?: number; failedHistories?: number; elapsedMs?: number } };
type ImageGalleryPayload = { title: string; index: number; loop: boolean; items: Array<{ id: string; src: string; time?: string }> };

function messageIdAtOrBefore(messageId: string, boundary: string): boolean {
  if (/^\d+$/.test(messageId) && /^\d+$/.test(boundary)) return BigInt(messageId) <= BigInt(boundary);
  return messageId === boundary;
}

const reactionOptions = [
  { type: 1, label: "เอาออก" },
  { type: 2, label: "ถูกใจ" },
  { type: 3, label: "รัก" },
  { type: 4, label: "สนุก" },
  { type: 5, label: "สุดยอด" },
  { type: 6, label: "เศร้า" },
  { type: 7, label: "OMG" },
] as const;

function optimisticReactions(reactions: Message["reactions"], type: number): Message["reactions"] {
  const next = (reactions ?? []).map((item) => ({ ...item }));
  const previous = next.find((item) => item.mine);
  if (type === 1) {
    if (previous) previous.count -= 1;
  } else {
    if (previous && previous.type !== type) previous.count -= 1;
    const selected = next.find((item) => item.type === type);
    if (selected) {
      if (!previous || previous.type !== type) selected.count += 1;
      selected.mine = true;
    } else {
      next.push({ type, count: 1, mine: true });
    }
  }
  return next.filter((item) => item.count > 0).sort((left, right) => left.type - right.type);
}
type AppSettings = {
  startup: boolean;
  tray: boolean;
  desktopNotifications: boolean;
  notificationPreview: boolean;
  notificationSound: boolean;
  callNotifications: boolean;
  callSound: boolean;
  openchat: boolean;
  liveTalk: boolean;
  autoMedia: boolean;
  markReadOnBottom: boolean;
  showUnreadDivider: boolean;
  autoScrollNewMessages: boolean;
  showReadCount: boolean;
  openImagesInWindow: boolean;
  loopImageGallery: boolean;
  openchatRealtimeRefresh: boolean;
  developerFlexRaw: boolean;
  density: "Compact" | "Comfortable" | "Spacious";
  radius: "Soft" | "Round";
};

const defaultSettings: AppSettings = {
  startup: true,
  tray: true,
  desktopNotifications: true,
  notificationPreview: true,
  notificationSound: true,
  callNotifications: true,
  callSound: true,
  openchat: true,
  liveTalk: false,
  autoMedia: true,
  markReadOnBottom: true,
  showUnreadDivider: true,
  autoScrollNewMessages: true,
  showReadCount: true,
  openImagesInWindow: true,
  loopImageGallery: true,
  openchatRealtimeRefresh: true,
  developerFlexRaw: false,
  density: "Comfortable",
  radius: "Round",
};


const MAX_MESSAGE_ROOMS_IN_MEMORY = 8;
const MAX_ACTIVE_MESSAGES_IN_MEMORY = 120;
const MAX_BACKGROUND_MESSAGES_IN_MEMORY = 24;
const MAX_IMAGE_PREVIEWS_PER_REFRESH = 4;

function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem("liney.settings");
    const parsed = raw ? JSON.parse(raw) as Partial<AppSettings> : {};
    // Earlier builds silently defaulted OpenChat media to off, making every
    // image look like a text-only "รูปภาพ" message. Enable it once on upgrade;
    // users can still turn it off afterwards in Settings.
    if (localStorage.getItem("liney.openchat-media-default.v2") !== "applied") {
      parsed.autoMedia = true;
      localStorage.setItem("liney.openchat-media-default.v2", "applied");
    }
    return { ...defaultSettings, ...parsed };
  } catch {
    return { ...defaultSettings };
  }
}

function liveProfileMetadata(item: LiveChatResult): { profileIdentityKey?: string; profileSnapshotTime?: number; profileFetchedAt?: number } {
  const profileIdentityKey = String(item.profileIdentityKey ?? item.identityKey ?? item.raw?.profileIdentityKey ?? "").trim();
  const profileSnapshotTime = Number(item.profileSnapshotTime ?? item.raw?.profileSnapshotTime ?? 0);
  const profileFetchedAt = Number(item.profileFetchedAt ?? item.raw?.profileFetchedAt ?? 0);
  return {
    ...(profileIdentityKey ? { profileIdentityKey } : {}),
    ...(Number.isFinite(profileSnapshotTime) && profileSnapshotTime > 0 ? { profileSnapshotTime } : {}),
    ...(Number.isFinite(profileFetchedAt) && profileFetchedAt > 0 ? { profileFetchedAt } : {}),
  };
}

function appendAvatarCacheVersion(url: URL, freshness: string | number) {
  const parts = [
    ...(url.searchParams.get("v") ?? "").split("|"),
    ...String(freshness ?? "").split("|"),
  ].map((part) => part.trim()).filter(Boolean);
  const versions = [...new Set(parts)];
  if (!versions.length) return;
  const combined = versions.join("|");
  if (combined.length <= 256) {
    url.searchParams.set("v", combined);
    return;
  }
  let hash = 2166136261;
  for (let index = 0; index < combined.length; index += 1) {
    hash = Math.imul(hash ^ combined.charCodeAt(index), 16777619);
  }
  url.searchParams.set("v", "liney-" + (hash >>> 0).toString(36));
}

function currentTalkAvatarUrl(item: LiveChatResult): string | undefined {
  const profile = liveProfileMetadata(item);
  const version = [
    profile.profileFetchedAt ? String(profile.profileFetchedAt) : "",
    profile.profileSnapshotTime ? String(profile.profileSnapshotTime) : "",
    "refresh-" + Math.floor(Date.now() / (5 * 60_000)),
  ].filter(Boolean).join("|");
  if (item.kind === "dm" && /^u[0-9a-f]{32}$/i.test(item.id)) {
    try {
      const supplied = item.avatarUrl ? new URL(item.avatarUrl) : undefined;
      const isMidLookup = supplied?.hostname === "obs.line-scdn.net"
        && supplied.pathname.replace(/\/$/, "") === `/r/talk/p/${item.id}`;
      if (supplied && !isMidLookup) {
        appendAvatarCacheVersion(supplied, version);
        return supplied.toString();
      }
    } catch {
      // Fall back to LINE's MID-keyed profile endpoint below.
    }
    const url = new URL("https://obs.line-scdn.net/r/talk/p/" + encodeURIComponent(item.id));
    appendAvatarCacheVersion(url, version);
    return url.toString();
  }
  if (item.avatarUrl) {
    try {
      const url = new URL(item.avatarUrl);
      appendAvatarCacheVersion(url, version);
      return url.toString();
    } catch {
      return item.avatarUrl;
    }
  }
  return undefined;
}

function isUnresolvedGroupArchive(chat: Pick<Chat, "kind" | "name" | "historyState" | "avatarUrl">): boolean {
  return chat.kind === "group" && chat.historyState === "unavailable"
    && !chat.avatarUrl
    && ["LINE Chat", "LINE User", "กลุ่มเก่า (ไม่ทราบชื่อ)"].includes(chat.name.trim());
}

function isUnresolvedGroupResult(chat: LiveChatResult): boolean {
  return chat.kind === "group" && chat.historyState === "unavailable"
    && !chat.avatarUrl
    && ["", "LINE Chat", "LINE User"].includes(chat.name.trim());
}

function mapLiveChatResult(item: LiveChatResult, index: number): Chat {
  const lineSystemAccount = item.id === LINE_SYSTEM_ACCOUNT_MID;
  const profile = liveProfileMetadata(item);
  return {
    id: item.id,
    name: isUnresolvedGroupResult(item) ? "กลุ่มเก่า (ไม่ทราบชื่อ)" : item.name,
    subtitle: isUnresolvedGroupResult(item)
      ? "LINE ไม่ส่งข้อมูลกลุ่มและประวัติเก่ากลับมา"
      : lineSystemAccount
      ? (item.preview || "บัญชีระบบ LINE · อ่าน payload ผ่าน Talk API ไม่ได้")
      : item.historyState === "new"
        ? "ยังไม่เคยแชท"
        : item.historyState === "unavailable"
          ? (item.preview || "ประวัติเก่าอ่านไม่ได้ · Live mode")
          : item.preview || (item.kind === "openchat" ? "OpenChat" : item.kind === "dm" ? "เพื่อน · LINE" : "กลุ่ม · LINE"),
    detail: item.kind === "openchat"
      ? `OpenChat${item.memberCount ? ` · ${item.memberCount.toLocaleString("th-TH")} คน` : ""}`
      : lineSystemAccount
        ? "LINE System Account · เห็นเวลา/activity แต่เนื้อหาถูกซ่อน"
        : item.historyState === "new"
          ? "ยังไม่เคยคุย · ส่งข้อความแรกได้เลย"
          : item.historyState === "unavailable"
            ? "ประวัติเก่าบางส่วนไม่พร้อม · ข้อความใหม่ใช้งานได้"
            : item.kind === "dm" ? "เพื่อน · LINE" : "กลุ่ม · LINE",
    time: lineSystemAccount ? formatListTime(item.lastMessageTime ?? 0) : item.historyState === "new" ? "" : formatListTime(item.lastMessageTime ?? 0),
    unread: item.unread || undefined,
    kind: item.kind,
    avatar: initials(item.name),
    avatarUrl: currentTalkAvatarUrl(item),
    ...profile,
    accent: avatarColor(index),
    lastMessageTime: item.historyState === "new" ? 0 : item.lastMessageTime ?? 0,
    pinned: item.pinned,
    favoriteTimestamp: item.favoriteTimestamp,
    historyState: item.historyState ?? "available",
  };
}

function sortLiveChats(chats: Chat[]): Chat[] {
  const byId = new Map<string, Chat>();
  for (const chat of chats) {
    if (!chat.id) continue;
    const current = byId.get(chat.id);
    if (!current) {
      byId.set(chat.id, chat);
      continue;
    }
    const currentTime = Number(current.lastMessageTime ?? 0);
    const incomingTime = Number(chat.lastMessageTime ?? 0);
    const primary = incomingTime >= currentTime ? chat : current;
    const secondary = primary === chat ? current : chat;
    const primaryName = String(primary.name ?? "").trim();
    const secondaryName = String(secondary.name ?? "").trim();
    const hasUsefulName = (name: string) => Boolean(name) && !["LINE User", "LINE Chat"].includes(name);
    const name = hasUsefulName(primaryName) ? primaryName : hasUsefulName(secondaryName) ? secondaryName : primaryName;
    byId.set(chat.id, {
      ...secondary,
      ...primary,
      name,
      avatar: hasUsefulName(primaryName) ? primary.avatar : secondary.avatar || initials(name),
      avatarUrl: primary.avatarUrl || secondary.avatarUrl,
      subtitle: primary.subtitle || secondary.subtitle,
      lastMessageTime: Math.max(currentTime, incomingTime),
    });
  }
  return [...byId.values()].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    if ((a.lastMessageTime ?? 0) !== (b.lastMessageTime ?? 0)) return (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0);
    return (b.favoriteTimestamp ?? 0) - (a.favoriteTimestamp ?? 0);
  });
}

function mapLiveFriendResult(item: LiveChatResult, index: number): Chat {
  const profile = liveProfileMetadata(item);
  return {
    id: item.id,
    name: item.name,
    subtitle: item.statusMessage?.trim() || "เพื่อน · LINE",
    detail: "เพื่อน · LINE",
    time: "",
    kind: "dm",
    avatar: initials(item.name),
    avatarUrl: currentTalkAvatarUrl(item),
    ...profile,
    accent: avatarColor(index),
    isFavorite: item.isFavorite,
    favoriteTime: item.favoriteTime,
  };
}

function sortLiveFriends(chats: Chat[]): Chat[] {
  const uniqueByIdentity = new Map<string, Chat>();
  for (const chat of chats) {
    if (!chat.id) continue;
    const key = chat.profileIdentityKey || `mid:${chat.id}`;
    const current = uniqueByIdentity.get(key);
    if (!current) {
      uniqueByIdentity.set(key, chat);
      continue;
    }
    const chatFetchedAt = Number(chat.profileFetchedAt ?? 0);
    const currentFetchedAt = Number(current.profileFetchedAt ?? 0);
    const profile = chatFetchedAt > currentFetchedAt
      || (chatFetchedAt === currentFetchedAt && Number(chat.profileSnapshotTime ?? 0) >= Number(current.profileSnapshotTime ?? 0))
      ? chat
      : current;
    const secondary = profile === chat ? current : chat;
    const name = profile.name.trim() && !["LINE User", "LINE Chat"].includes(profile.name.trim())
      ? profile.name
      : secondary.name;
    uniqueByIdentity.set(key, {
      ...secondary,
      ...profile,
      name,
      avatar: profile.avatar || secondary.avatar || initials(name),
      avatarUrl: profile.avatarUrl || secondary.avatarUrl,
      profileIdentityKey: profile.profileIdentityKey || secondary.profileIdentityKey,
      profileSnapshotTime: Math.max(profile.profileSnapshotTime ?? 0, secondary.profileSnapshotTime ?? 0) || undefined,
      isFavorite: Boolean(profile.isFavorite || secondary.isFavorite),
      favoriteTime: Math.max(profile.favoriteTime ?? 0, secondary.favoriteTime ?? 0) || undefined,
    });
  }
  return [...uniqueByIdentity.values()].sort((a, b) => {
    if (Boolean(a.isFavorite) !== Boolean(b.isFavorite)) return a.isFavorite ? -1 : 1;
    if ((a.favoriteTime ?? 0) !== (b.favoriteTime ?? 0)) return (b.favoriteTime ?? 0) - (a.favoriteTime ?? 0);
    return a.name.localeCompare(b.name, "th");
  });
}

function mergeLiveFriendSnapshots(previous: Chat[] | null, incoming: Chat[]): Chat[] {
  const prior = previous ?? [];
  const previousById = new Map(prior.map((friend) => [friend.id, friend]));
  const previousByIdentity = new Map<string, Chat>();
  for (const friend of prior) {
    if (friend.profileIdentityKey && !previousByIdentity.has(friend.profileIdentityKey)) {
      previousByIdentity.set(friend.profileIdentityKey, friend);
    }
  }

  const refreshed = incoming.map((friend) => {
    const known = previousById.get(friend.id)
      ?? (friend.profileIdentityKey ? previousByIdentity.get(friend.profileIdentityKey) : undefined);
    if (!known) return friend;

    const stableId = known.id;
    const incomingName = friend.name.trim();
    const usefulIncomingName = incomingName && !["LINE User", "LINE Chat"].includes(incomingName);
    const incomingSnapshot = Number(friend.profileSnapshotTime ?? 0);
    const knownSnapshot = Number(known.profileSnapshotTime ?? 0);
    const incomingFetchedAt = Number(friend.profileFetchedAt ?? 0);
    const knownFetchedAt = Number(known.profileFetchedAt ?? 0);
    // LINE server snapshot time can lag behind a successful profile fetch.
    // Prefer fetch time when available, and use snapshot time for older cache rows.
    const hasFetchTimes = incomingFetchedAt > 0 || knownFetchedAt > 0;
    const incomingProfileIsOlder = hasFetchTimes
      ? incomingFetchedAt === 0 || (knownFetchedAt > 0 && knownFetchedAt > incomingFetchedAt)
      : incomingSnapshot > 0 && knownSnapshot > incomingSnapshot;
    const selectedSnapshot = incomingProfileIsOlder
      ? knownSnapshot || incomingSnapshot
      : incomingSnapshot || knownSnapshot;
    return {
      ...known,
      ...friend,
      id: stableId,
      name: !incomingProfileIsOlder && usefulIncomingName ? incomingName : known.name,
      avatar: !incomingProfileIsOlder && friend.avatar ? friend.avatar : known.avatar || initials(known.name),
      avatarUrl: !incomingProfileIsOlder && friend.avatarUrl ? friend.avatarUrl : known.avatarUrl || friend.avatarUrl,
      profileIdentityKey: friend.profileIdentityKey || known.profileIdentityKey,
      profileSnapshotTime: selectedSnapshot || undefined,
      profileFetchedAt: Math.max(incomingFetchedAt, knownFetchedAt) || undefined,
      subtitle: friend.subtitle || known.subtitle,
      isFavorite: friend.isFavorite ?? known.isFavorite,
      favoriteTime: friend.favoriteTime ?? known.favoriteTime,
    };
  });
  const deduped = sortLiveFriends(refreshed);
  const presentIds = new Set(deduped.map((friend) => friend.id));
  const presentIdentities = new Set(deduped.map((friend) => friend.profileIdentityKey).filter(Boolean));
  const preserved = prior.filter((friend) =>
    !presentIds.has(friend.id)
    && (!friend.profileIdentityKey || !presentIdentities.has(friend.profileIdentityKey)),
  );
  return sortLiveFriends([...deduped, ...preserved]);
}

function mergeFriendProfilesIntoChats(chats: Chat[], friends: Chat[]): Chat[] {
  const friendsById = new Map(friends.map((friend) => [friend.id, friend]));
  const friendsByIdentity = new Map<string, Chat>();
  for (const friend of friends) {
    if (!friend.profileIdentityKey) continue;
    const current = friendsByIdentity.get(friend.profileIdentityKey);
    if (!current || Number(friend.profileSnapshotTime ?? 0) >= Number(current.profileSnapshotTime ?? 0)) {
      friendsByIdentity.set(friend.profileIdentityKey, friend);
    }
  }
  return chats.map((chat) => {
    if (chat.kind !== "dm") return chat;
    const friend = friendsById.get(chat.id)
      ?? (chat.profileIdentityKey ? friendsByIdentity.get(chat.profileIdentityKey) : undefined);
    if (!friend) return chat;
    const sameLineId = friend.id === chat.id;
    const friendFetchedAt = Number(friend.profileFetchedAt ?? 0);
    const chatFetchedAt = Number(chat.profileFetchedAt ?? 0);
    const friendIsCurrent = sameLineId
      || friendFetchedAt > chatFetchedAt
      || (friendFetchedAt === chatFetchedAt
        && Number(friend.profileSnapshotTime ?? 0) >= Number(chat.profileSnapshotTime ?? 0));
    if (!friendIsCurrent) return chat;
    const friendName = friend.name.trim();
    const name = friendName && !["LINE User", "LINE Chat"].includes(friendName) ? friendName : chat.name;
    const avatarUrl = friend.avatarUrl || chat.avatarUrl;
    const profileIdentityKey = friend.profileIdentityKey || chat.profileIdentityKey;
    const profileSnapshotTime = friend.profileSnapshotTime ?? chat.profileSnapshotTime;
    const profileFetchedAt = Math.max(friendFetchedAt, chatFetchedAt) || undefined;
    if (
      name === chat.name
      && avatarUrl === chat.avatarUrl
      && profileIdentityKey === chat.profileIdentityKey
      && profileSnapshotTime === chat.profileSnapshotTime
      && profileFetchedAt === chat.profileFetchedAt
    ) return chat;
    return { ...chat, name, avatar: initials(name), avatarUrl, profileIdentityKey, profileSnapshotTime, profileFetchedAt };
  });
}

async function notifyDesktop(
  title: string,
  body: string,
  enabled: boolean,
  soundEnabled: boolean,
  target: { chatId: string; messageId: string },
  onFallbackClick: () => void,
  avatarUrl?: string,
): Promise<void> {
  if (!enabled) return;
  try {
    if (lineyEngine.isNative) {
      const avatarKey = await prepareNotificationAvatar(avatarUrl);
      await invoke("notify_message", { title, body, chatId: target.chatId, messageId: target.messageId, sound: soundEnabled, avatarKey });
      return;
    }
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return;
    const notification = new Notification(title, { body, icon: notificationAvatarUrl(avatarUrl) });
    notification.onclick = () => { window.focus(); onFallbackClick(); notification.close(); };
  } catch {
    // Notification availability is owned by the desktop environment.
  }
}


type CallToneMode = "incoming" | "outgoing";


const navItems: { id: Section; label: string; icon: typeof MessageCircle }[] = [
  { id: "messages", label: "แชต", icon: MessageCircle },
  { id: "friends", label: "เพื่อน", icon: Users },
  { id: "openchat", label: "OpenChat", icon: Sparkles },
  { id: "calls", label: "โทร", icon: Phone },
];

export default function App() {
  const detachedView = new URLSearchParams(window.location.search).get("liney-view");
  if (lineyEngine.isNative && detachedView === "image-viewer") return <DetachedImageViewer />;
  if (lineyEngine.isNative) return <MainApp />;
  return <BrowserSite />;
}

function BrowserSite() {
  const [path, setPath] = useState(() => normalizeBrowserPath(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setPath(normalizeBrowserPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    document.title = path === "/login" ? "Liney — Login preview" : path === "/app" ? "Liney Web App" : path === "/chat" ? "Liney — Chat preview" : "Liney — LINE, made for Linux.";
  }, [path]);

  const navigate = (nextPath: string) => {
    const next = normalizeBrowserPath(nextPath);
    window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (path === "/app" || path === "/chat") return <MainApp />;
  const view: MarketingView = path === "/login" ? "login" : "home";
  return <MarketingSite view={view} onNavigate={navigate} />;
}

function normalizeBrowserPath(path: string): "/" | "/login" | "/chat" | "/app" {
  if (path === "/login" || path === "/chat" || path === "/app") return path;
  return "/";
}

function isLineyWebAppRoute() {
  return typeof window !== "undefined" && window.location.pathname === "/app";
}

function MainApp() {
  const usesEngineRuntime = lineyEngine.isNative || isLineyWebAppRoute();
  const [section, setSection] = useState<Section>("messages");
  const [activeChatId, setActiveChatId] = useState(usesEngineRuntime ? "" : "nagi");
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [albumsOpen, setAlbumsOpen] = useState(false);
  const [notesRoom, setNotesRoom] = useState<{ id: string; title: string } | null>(null);
  const [managedChat, setManagedChat] = useState<Chat | null>(null);
  const [settingsInitialTab, setSettingsInitialTab] = useState("ทั่วไป");
  const [messageRefreshNonce, setMessageRefreshNonce] = useState(0);
  const [callOpen, setCallOpen] = useState(false);
  const [callState, setCallState] = useState<CallState>("idle");
  const [callDirection, setCallDirection] = useState<"incoming" | "outgoing" | null>(null);
  const [callMode, setCallMode] = useState<"AUDIO" | "VIDEO">("AUDIO");
  const videoUpgradeInProgressRef = useRef(false);
  const [, setCallId] = useState("");
  const [callPeer, setCallPeer] = useState("");
  const [callIdentity, setCallIdentity] = useState<{ peer: string; name: string; avatarUrl?: string } | null>(null);
  const [callMuted, setCallMuted] = useState(false);
  const [callVideoCapable, setCallVideoCapable] = useState(false);
  const [callRemoteVideoFrame, setCallRemoteVideoFrame] = useState("");
  const [callVideoEnabled, setCallVideoEnabled] = useState(false);
  const [callScreenSharing, setCallScreenSharing] = useState(false);
  const [callCameraAvailable, setCallCameraAvailable] = useState(false);
  const [callMicrophoneAvailable, setCallMicrophoneAvailable] = useState(false);
  const [callSpeakerAvailable, setCallSpeakerAvailable] = useState(false);
  const [callScreenShareAvailable, setCallScreenShareAvailable] = useState(false);
  const [callScreenTargets, setCallScreenTargets] = useState<ScreenShareTargetResult[]>([]);
  const [callScreenTarget, setCallScreenTarget] = useState("desktop");
  const [callScreenManagedBySystem, setCallScreenManagedBySystem] = useState(false);
  const [callError, setCallError] = useState("");
  const [callAvailable, setCallAvailable] = useState(false);
  const [callIncomingAvailable, setCallIncomingAvailable] = useState(false);
  const [callReason, setCallReason] = useState("");
  const [callOutputs, setCallOutputs] = useState<AudioDeviceResult[]>([]);
  const [callOutputTarget, setCallOutputTarget] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("qr");
  const [qrUrl, setQrUrl] = useState("");
  const [pin, setPin] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState("");
  const [keyImportMode, setKeyImportMode] = useState(false);
  const [keyImportResult, setKeyImportResult] = useState<{ generations: number } | null>(null);
  const keyImportDialogOpenRef = useRef(false);
  const [imageViewerSrc, setImageViewerSrc] = useState<string | null>(null);
  const [notificationJump, setNotificationJump] = useState<{ chatId: string; messageId: string; nonce: number } | null>(null);
  const [liveChats, setLiveChats] = useState<Chat[] | null>(null);
  const [liveFriends, setLiveFriends] = useState<Chat[] | null>(null);
  const [callHistory, setCallHistory] = useState<LiveCallHistoryResult[] | null>(usesEngineRuntime ? null : []);
  const [listFilter, setListFilter] = useState<"all" | "unread" | "pinned" | "favorites">("all");
  const [markAllReadBusy, setMarkAllReadBusy] = useState(false);
  const [markAllReadProgress, setMarkAllReadProgress] = useState<{ done: number; total: number } | null>(null);
  const [localPins, setLocalPins] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem("liney.localPins");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [profile, setProfile] = useState<ProfileResult | null>(null);
  const [clientIdentity, setClientIdentity] = useState<ClientIdentityResult | null>(null);
  const [composer, setComposer] = useState("");
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [mediaProgress, setMediaProgress] = useState<Record<string, MediaProgress>>({});
  const recentSentRef = useRef(new Map<string, Array<{ at: number; localId: string }>>());
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem("liney.themeMode");
      if (saved === "light" || saved === "dark" || saved === "system") return saved;
    } catch {}
    return "system";
  });
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false
  );
  const dark = themeMode === "system" ? systemDark : themeMode === "dark";
  const [engineState, setEngineState] = useState<EngineState>(usesEngineRuntime ? "starting" : "browser-mock");
  const [engineVersion, setEngineVersion] = useState("3.3.2");
  const [syncStatus, setSyncStatus] = useState("");
  const [syncProgress, setSyncProgress] = useState<SyncProgressState>({ visible: false, phase: "metadata", done: 0, total: 0, failed: 0 });
  const [storageMode, setStorageMode] = useState<"wallet" | "encrypted-file" | "session-only">("session-only");
  const [settings, setSettings] = useState<AppSettings>(readSettings);
  const [windowActive, setWindowActive] = useState(() =>
    document.visibilityState === "visible" && document.hasFocus()
  );
  const settingsRef = useRef(settings);
  const activeChatRef = useRef(activeChatId);
  const authenticatedRef = useRef(authenticated);
  const liveChatsRef = useRef<Chat[] | null>(null);
  const liveFriendsRef = useRef<Chat[] | null>(null);
  const liveChatsLoadGenerationRef = useRef(0);
  const liveFriendsLoadGenerationRef = useRef(0);
  const callHistoryLoadGenerationRef = useRef(0);
  const messageLoadGenerationRef = useRef(new Map<string, number>());
  const activeMessageLoadEpochRef = useRef(0);
  const readMarkedRef = useRef(new Set<string>());
  const sessionReadReadersRef = useRef(new Map<string, Map<string, Set<string>>>());
  const imageGalleryPayloadRef = useRef<ImageGalleryPayload | null>(null);
  const notificationDedupRef = useRef(new Map<string, number>());
  const callNotificationDedupRef = useRef(new Set<string>());
  const nativeCallToneModeRef = useRef<CallToneMode | null>(null);
  const liveEventDedupRef = useRef(new Map<string, number>());
  const liveChatEventGenerationRef = useRef(new Map<string, number>());
  const messageMapRef = useRef(getTimelineRooms());
  const localReadThroughTimeRef = useRef(new Map<string, number>());
  const historyDiscoveredMessageIdsRef = useRef(new Set<string>());
  const sidebarCatchupRef = useRef(new Map<string, { target: number; attempts: number }>());
  const forcedHistoryRefreshRef = useRef(new Set<string>());

  const clearReadMarks = (chatId: string) => {
    const prefix = `${chatId}:`;
    for (const key of readMarkedRef.current) {
      if (key.startsWith(prefix)) readMarkedRef.current.delete(key);
    }
  };

  // Being the selected chat is not enough to acknowledge a message. A desktop
  // leave the webview selected while the window is minimized or behind another
  // app, so only send read receipts while the user can actually see it.
  const isChatActuallyVisible = (chatId: string) =>
    chatId === activeChatRef.current
    && document.visibilityState === "visible"
    && document.hasFocus();

  useLayoutEffect(() => {
    activeChatRef.current = activeChatId;
    // Invalidate async work from the previous room before the browser paints
    // the newly selected conversation. This keeps rapid room switching cheap.
    activeMessageLoadEpochRef.current += 1;
  }, [activeChatId]);

  useEffect(() => {
    authenticatedRef.current = authenticated;
  }, [authenticated]);

  useEffect(() => {
    const syncWindowActivity = () => {
      setWindowActive(document.visibilityState === "visible" && document.hasFocus());
    };
    syncWindowActivity();
    window.addEventListener("focus", syncWindowActivity);
    window.addEventListener("blur", syncWindowActivity);
    document.addEventListener("visibilitychange", syncWindowActivity);
    return () => {
      window.removeEventListener("focus", syncWindowActivity);
      window.removeEventListener("blur", syncWindowActivity);
      document.removeEventListener("visibilitychange", syncWindowActivity);
    };
  }, []);

  useEffect(() => {
    liveChatsRef.current = liveChats;
  }, [liveChats]);

  useEffect(() => {
    liveFriendsRef.current = liveFriends;
  }, [liveFriends]);

  useEffect(() => timelineStore.subscribe((state) => {
    messageMapRef.current = state.rooms;
  }), []);

  useEffect(() => {
    if (!usesEngineRuntime && Object.keys(getTimelineRooms()).length === 0) {
      setMessageMap(seedMessages);
      return;
    }
    if (!usesEngineRuntime) return;
    compactTimelineRooms(
      activeChatId,
      MAX_MESSAGE_ROOMS_IN_MEMORY,
      MAX_ACTIVE_MESSAGES_IN_MEMORY,
      MAX_BACKGROUND_MESSAGES_IN_MEMORY,
    );
  }, [activeChatId, usesEngineRuntime]);

  useEffect(() => {
    settingsRef.current = settings;
    try { localStorage.setItem("liney.settings", JSON.stringify(settings)); } catch { /* best effort */ }
  }, [settings]);

  useEffect(() => {
    if (!lineyEngine.isNative) return;
    void invoke("set_autostart", { enabled: settings.startup }).catch((error) => {
      setAuthError(`ตั้งค่าเปิดพร้อมระบบไม่สำเร็จ: ${String(error)}`);
    });
    void invoke("set_close_to_tray", { enabled: settings.tray }).catch((error) => {
      setAuthError(`ตั้งค่า System Tray ไม่สำเร็จ: ${String(error)}`);
    });
  }, [settings.startup, settings.tray]);

  useEffect(() => {
    document.documentElement.dataset.density = settings.density.toLowerCase();
    document.documentElement.dataset.radius = settings.radius.toLowerCase();
  }, [settings.density, settings.radius]);


  useEffect(() => {
    const desiredTone: CallToneMode | null = !settings.callSound || !callOpen
      ? null
      : callDirection === "incoming" && callState === "incoming"
        ? "incoming"
        : callDirection === "outgoing" && ["acquiring", "connecting", "ringing"].includes(callState)
          ? "outgoing"
          : null;

    if (nativeCallToneModeRef.current === desiredTone) return;
    nativeCallToneModeRef.current = desiredTone;
    if (!lineyEngine.isNative) return;
    if (desiredTone) {
      void invoke("start_call_tone", { mode: desiredTone }).catch(() => undefined);
    } else {
      void invoke("stop_call_tone").catch(() => undefined);
    }
  }, [callDirection, callOpen, callState, settings.callSound]);

  useEffect(() => () => {
    if (lineyEngine.isNative) void invoke("stop_call_tone").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!syncProgress.visible || syncProgress.phase !== "complete") return;
    const timer = window.setTimeout(() => setSyncProgress((current) => ({ ...current, visible: false })), 1_800);
    return () => window.clearTimeout(timer);
  }, [syncProgress.visible, syncProgress.phase]);

  function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function jumpToNotification(chatId: string, messageId: string) {
    if (!chatId || !messageId) return;
    const chat = [...(liveChatsRef.current ?? []), ...(liveFriendsRef.current ?? [])].find((item) => item.id === chatId);
    setSection(chat?.kind === "openchat" ? "openchat" : "messages");
    setListFilter("all");
    setActiveChatId(chatId);
    setMobileConversationOpen(true);
    setNotificationJump({ chatId, messageId, nonce: Date.now() });
    if (lineyEngine.isNative) {
      void getCurrentWindow().show().then(() => getCurrentWindow().setFocus()).catch(() => undefined);
    }
  }

  useEffect(() => {
    if (!lineyEngine.isNative) return;
    let unlisten: (() => void) | undefined;
    void listen<{ chatId?: unknown; messageId?: unknown }>("liney://notification-open", (event) => {
      jumpToNotification(String(event.payload?.chatId ?? ""), String(event.payload?.messageId ?? ""));
    }).then((listener) => { unlisten = listener; }).catch(() => undefined);
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!usesEngineRuntime) return;
    let reconnectTimer: number | undefined;
    let liveChatRefreshTimer: number | undefined;
    let liveFriendsRefreshTimer: number | undefined;
    let connectInFlight = false;
    const scheduleLiveChatRefresh = () => {
      if (liveChatRefreshTimer !== undefined) return;
      liveChatRefreshTimer = window.setTimeout(() => {
        liveChatRefreshTimer = undefined;
        void loadLiveChats();
      }, 700);
    };
    const scheduleLiveFriendsRefresh = () => {
      if (liveFriendsRefreshTimer !== undefined) return;
      liveFriendsRefreshTimer = window.setTimeout(() => {
        liveFriendsRefreshTimer = undefined;
        void loadLiveFriends();
      }, 700);
    };
    const scheduleLiveRefresh = () => {
      scheduleLiveChatRefresh();
      scheduleLiveFriendsRefresh();
    };
    const scheduleReconnect = () => {
      if (reconnectTimer !== undefined) return;
      setEngineState("starting");
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, 1_500);
    };
    const refreshCapabilities = async () => {
      const caps = await lineyEngine.request<{
        linejsVersion?: string;
        authenticated?: boolean;
        features?: string[];
        clientIdentity?: ClientIdentityResult;
        storage?: { mode?: "wallet" | "encrypted-file" | "session-only" };
        call?: {
          enabled?: boolean;
          incomingAnswer?: boolean;
          reason?: string;
          hardware?: CallHardwareStatus;
        };
      }>("capabilities", {}, 120_000);
      if (caps?.linejsVersion) setEngineVersion(caps.linejsVersion);
      if (caps?.clientIdentity) setClientIdentity(caps.clientIdentity);
      setCallAvailable(Boolean(caps?.call?.enabled || caps?.features?.includes("call-audio-1to1")));
      setCallIncomingAvailable(Boolean(caps?.call?.incomingAnswer));
      setCallCameraAvailable(Boolean(caps?.call?.hardware?.camera?.available));
      setCallMicrophoneAvailable(Boolean(caps?.call?.hardware?.microphone?.available));
      setCallSpeakerAvailable(Boolean(caps?.call?.hardware?.speaker?.available));
      setCallScreenShareAvailable(Boolean(caps?.call?.hardware?.screenShare?.available));
      setCallReason(String(caps?.call?.reason ?? ""));
      if (
        caps?.storage?.mode === "wallet"
        || caps?.storage?.mode === "encrypted-file"
        || caps?.storage?.mode === "session-only"
      ) setStorageMode(caps.storage.mode);
      setEngineState("ready");
      if (caps?.authenticated) {
        authenticatedRef.current = true;
        setAuthenticated(true);
        try {
          const restoredProfile = await lineyEngine.request<ProfileResult>("profile.get", {}, 20_000);
          setProfile(restoredProfile);
        } catch {}
        // Defer list loads so the auth.ready event (which also populates them)
        // doesn't trigger a second, duplicate network refresh at startup.
        scheduleLiveRefresh();
      } else {
        authenticatedRef.current = false;
        setAuthenticated(false);
        setAuthOpen(true);
        // Keep the cached desktop view usable while a session is unavailable.
        // The next auth.ready event will schedule the same refresh against LINE.
        scheduleLiveRefresh();
      }
    };
    const connect = async () => {
      if (connectInFlight) return;
      connectInFlight = true;
      try {
        await lineyEngine.start();
        // Warm-start from durable SQLite immediately. The engine serves these
        // read methods before session restore, so the previous desktop state
        // can appear while LINE authentication/network refresh continues in
        // parallel instead of leaving the sidebar empty.
        void loadLiveChats();
        void loadLiveFriends(false);
        void loadCallHistory();
        await refreshCapabilities();
      } catch (error) {
        setEngineState("error");
        if (isLineyWebAppRoute()) setAuthError(error instanceof Error ? error.message : String(error));
        scheduleReconnect();
      } finally {
        connectInFlight = false;
      }
    };
    const off = lineyEngine.on((event) => {
      if (event.type === "engine.ready") {
        if (typeof event.linejsVersion === "string") setEngineVersion(event.linejsVersion);
        if (event.clientIdentity && typeof event.clientIdentity === "object") setClientIdentity(event.clientIdentity as ClientIdentityResult);
      }
      if (event.type === "engine.error") setEngineState("error");
      if (event.type === "engine.closed") {
        setEngineState("error");
        setAuthBusy(false);
        liveChatEventGenerationRef.current.clear();
        scheduleReconnect();
      }
      if (event.type === "auth.persistence") {
        const mode = String(event.mode ?? "");
        if (mode === "wallet" || mode === "encrypted-file" || mode === "session-only") {
          setStorageMode(mode);
        }
      }
      if (event.type === "event.chats.updated" && authenticatedRef.current && Array.isArray(event.chats)) {
        const kind = event.kind === "friends" ? "friends" : event.kind === "openchat" ? "openchat" : "talk";
        const refreshGeneration = Number(event.refreshGeneration ?? 0);
        if (Number.isFinite(refreshGeneration) && refreshGeneration > 0) {
          const previousGeneration = liveChatEventGenerationRef.current.get(kind) ?? 0;
          if (refreshGeneration < previousGeneration) return;
          liveChatEventGenerationRef.current.set(kind, refreshGeneration);
        }
        const results = event.chats as LiveChatResult[];
        if (kind === "friends") {
          const mappedFriends = results.map(mapLiveFriendResult);
          const nextFriends = mergeLiveFriendSnapshots(liveFriendsRef.current, mappedFriends);
          liveFriendsRef.current = nextFriends;
          setLiveFriends(nextFriends);
          const previousChats = liveChatsRef.current ?? [];
          const nextChats = mergeFriendProfilesIntoChats(previousChats, nextFriends);
          const refreshedDirectChats = nextChats.some((chat, index) => chat !== previousChats[index]);
          if (refreshedDirectChats) {
            liveChatsRef.current = nextChats;
            setLiveChats(nextChats);
          }
        } else if (kind !== "openchat" || settingsRef.current.openchat) {
          const previous = liveChatsRef.current ?? [];
          const previousById = new Map(previous.map((chat) => [chat.id, chat]));
          const mappedRemote = results
            .filter((item) => kind === "openchat" ? item.kind === "openchat" : item.kind !== "openchat")
            .map((item, index) => {
              const mapped = mapLiveChatResult(item, index);
              const prior = previousById.get(mapped.id);
              const readThrough = localReadThroughTimeRef.current.get(mapped.id) ?? 0;
              const unread = (mapped.lastMessageTime ?? 0) <= readThrough
                ? undefined
                : Math.max(mapped.unread ?? 0, prior?.unread ?? 0) || undefined;
              return { ...mapped, unread };
            });
          const remoteIds = new Set(mappedRemote.map((chat) => chat.id));
          const next = sortLiveChats([
            ...mappedRemote,
            ...previous.filter((chat) =>
              !remoteIds.has(chat.id)
              && (settingsRef.current.openchat || chat.kind !== "openchat"),
            ),
          ]);
          liveChatsRef.current = next;
          setLiveChats(next);
          setActiveChatId((current) => next.some((chat) => chat.id === current)
            || Boolean(liveFriendsRef.current?.some((chat) => chat.id === current))
            ? current
            : (next[0]?.id ?? ""));
        }
      }
      if (event.type === "sync.start") {
        setSyncStatus("กำลังเตรียมข้อมูล LINE…");
        setSyncProgress({ visible: true, phase: "metadata", done: 0, total: 0, failed: 0 });
      }
      if (event.type === "sync.progress") {
        const phase = event.phase === "friends" || event.phase === "chats" || event.phase === "history" ? event.phase : "metadata";
        const done = Number(event.done ?? 0);
        const total = Number(event.total ?? 0);
        const failed = Number(event.failed ?? 0);
        setSyncProgress((current) => ({ ...current, visible: true, phase, done, total, failed }));
        if (phase === "friends") setSyncStatus(`ซิงก์เพื่อน ${done.toLocaleString("th-TH")} คน`);
        else if (phase === "chats") setSyncStatus(`ซิงก์รายการแชต ${done.toLocaleString("th-TH")} ห้อง`);
        else if (phase === "history") setSyncStatus(`ซิงก์ประวัติห้อง ${done}/${total}`);
      }
      if (event.type === "sync.ready") {
        const summary = event.summary && typeof event.summary === "object" ? event.summary as SyncProgressState["summary"] : undefined;
        setSyncStatus("");
        setSyncProgress((current) => ({ ...current, visible: true, phase: "complete", summary, failed: Number(summary?.failedHistories ?? current.failed) }));
        scheduleLiveRefresh();
        void loadCallHistory();
      }
      if (event.type === "sync.error") {
        setSyncStatus("ซิงก์บางส่วนไม่สำเร็จ");
        setSyncProgress((current) => ({
          ...current,
          visible: true,
          phase: "error",
          error: String(event.error ?? "ไม่ทราบสาเหตุ"),
        }));
      }
      if (event.type === "media.progress" && typeof event.jobId === "string") {
        const jobId = event.jobId;
        const phase = String(event.phase ?? "working");
        if (phase === "complete" || phase === "cancelled") {
          setMediaProgress((current) => {
            const next = { ...current };
            delete next[jobId];
            return next;
          });
        } else {
          setMediaProgress((current) => ({
            ...current,
            [jobId]: { phase, done: Number(event.done ?? 0), total: Number(event.total ?? 0) },
          }));
        }
      }
      if (event.type === "media.error" && typeof event.jobId === "string") {
        const jobId = event.jobId;
        setMediaProgress((current) => ({
          ...current,
          [jobId]: { phase: "error", done: 0, total: 0 },
        }));
      }
      if (event.type === "auth.qr" && typeof event.url === "string") {
        setQrUrl(event.url);
        setAuthError("");
      }
      if (event.type === "auth.pin" && typeof event.pin === "string") setPin(event.pin);
      if (event.type === "auth.ready") {
        authenticatedRef.current = true;
        setAuthBusy(false);
        setAuthenticated(true);
        setQrUrl("");
        setPin("");
        setAuthError("");
        setAuthOpen(false);
        if (
          event.storage === "wallet"
          || event.storage === "encrypted-file"
          || event.storage === "session-only"
        ) setStorageMode(event.storage);
        if (event.clientIdentity && typeof event.clientIdentity === "object") setClientIdentity(event.clientIdentity as ClientIdentityResult);
        if (event.profile && typeof event.profile === "object") setProfile(event.profile as ProfileResult);
        if (event.accountChanged === true) {
          liveChatsLoadGenerationRef.current += 1;
          liveFriendsLoadGenerationRef.current += 1;
          liveChatsRef.current = null;
          liveFriendsRef.current = null;
          localReadThroughTimeRef.current.clear();
          historyDiscoveredMessageIdsRef.current.clear();
          sidebarCatchupRef.current.clear();
          setLiveChats([]);
          setLiveFriends([]);
          setCallHistory([]);
          setActiveChatId("");
          setMessageMap({});
          setReplyTarget(null);
        }
        // The capabilities path can observe auth.ready in the same startup
        // window. Share one debounced refresh instead of launching both list
        // requests twice.
        scheduleLiveRefresh();
      }
      if (event.type === "auth.restore_failed") {
        authenticatedRef.current = false;
        setAuthBusy(false);
        setAuthenticated(false);
        setAuthOpen(true);
        setAuthError("Session เดิมใช้ต่อไม่ได้ กรุณาเข้าสู่ระบบด้วย QR หรือ Email/Password ใหม่");
      }
      if (event.type === "auth.logged_out") {
        authenticatedRef.current = false;
        setAuthBusy(false);
        setAuthenticated(false);
        liveChatsLoadGenerationRef.current += 1;
        liveFriendsLoadGenerationRef.current += 1;
        liveChatsRef.current = null;
        liveFriendsRef.current = null;
        liveEventDedupRef.current.clear();
        liveChatEventGenerationRef.current.clear();
        localReadThroughTimeRef.current.clear();
        historyDiscoveredMessageIdsRef.current.clear();
        sidebarCatchupRef.current.clear();
        setLiveChats([]);
        setLiveFriends([]);
        setCallHistory([]);
        setProfile(null);
        readMarkedRef.current.clear();
        setReplyTarget(null);
        setActiveChatId("");
        setMessageMap({});
        setMediaProgress({});
        setSyncProgress((current) => ({ ...current, visible: false }));
      }
      if (event.type === "message.sending" || event.type === "message.sent" || event.type === "message.failed") {
        const chatId = String(event.chatId ?? "").trim();
        const localId = String(event.localId ?? "").trim();
        const serverId = String(event.serverId ?? "").trim();
        if (chatId && localId) {
          setMessageMap((current) => ({
            ...current,
            [chatId]: (current[chatId] ?? []).map((item) => {
              if (item.id !== localId) return item;
              if (event.type === "message.sending") return { ...item, status: "sending", sendError: undefined };
              if (event.type === "message.failed") return {
                ...item,
                status: event.status === "unknown" ? "unknown" : "error",
                sendError: typeof event.errorMessage === "string" ? formatSendError(event.errorMessage) : item.sendError,
              };
              return {
                ...item,
                id: serverId && serverId !== localId ? serverId : item.id,
                status: "sent",
                sendError: undefined,
              };
            }),
          }));
        }
      }
      if (event.type === "event.message.updated" && event.message && typeof event.message === "object") {
        const raw = event.message as LiveMessageResult;
        const chatId = String(raw.chatId ?? event.chatId ?? "").trim();
        const messageId = String(raw.id ?? event.messageId ?? "").trim();
        if (chatId && messageId) {
          setMessageMap((current) => ({
            ...current,
            [chatId]: (current[chatId] ?? []).map((item) => item.id === messageId ? {
              ...item,
              senderId: raw.senderId ?? item.senderId,
              senderName: raw.senderName ?? item.senderName,
              senderAvatarUrl: raw.senderAvatarUrl ?? item.senderAvatarUrl,
              officialClientUrl: raw.officialClientUrl ?? item.officialClientUrl,
              isOfficialAccount: raw.isOfficialAccount ?? item.isOfficialAccount,
              text: raw.text !== undefined ? raw.text : item.text,
              contentType: raw.contentType ?? item.contentType,
              edited: raw.edited ?? item.edited,
              updatedTime: raw.updatedTime ?? item.updatedTime,
              filename: raw.filename ?? item.filename,
              stickerUrl: raw.stickerUrl ?? item.stickerUrl,
              flex: raw.flex ?? item.flex,
              raw: raw.raw ?? item.raw,
              rich: raw.rich ?? item.rich,
              call: raw.call ?? item.call,
              postNotification: raw.postNotification ?? item.postNotification,
              reactions: raw.reactions ?? item.reactions,
              replyTo: raw.replyTo ?? item.replyTo,
              replyToId: raw.replyToId ?? item.replyToId,
            } : item),
          }));
        }
      }
      if (event.type === "event.message.reaction") {
        const chatId = String(event.chatId ?? "").trim();
        const messageId = String(event.messageId ?? "").trim();
        const reactions = Array.isArray(event.reactions) ? event.reactions as Message["reactions"] : undefined;
        if (chatId && messageId) {
          setMessageMap((current) => ({
            ...current,
            [chatId]: (current[chatId] ?? []).map((item) => item.id === messageId ? { ...item, reactions } : item),
          }));
        }
      }
      if (event.type === "event.message.read") {
        const chatId = String(event.chatId ?? "").trim();
        const messageId = String(event.messageId ?? "").trim();
        const readerMid = String(event.readerMid ?? "").trim();
        if (chatId && messageId) {
          setMessageMap((current) => {
            const roomReaders = sessionReadReadersRef.current.get(chatId) ?? new Map<string, Set<string>>();
            sessionReadReadersRef.current.set(chatId, roomReaders);
            return {
              ...current,
              [chatId]: (current[chatId] ?? []).map((item) => {
                if (item.author !== "me" || !messageIdAtOrBefore(item.id, messageId)) return item;
                const readers = roomReaders.get(item.id) ?? new Set<string>();
                if (readerMid) readers.add(readerMid);
                roomReaders.set(item.id, readers);
                const readCount = Math.max(item.readCount ?? 0, readers.size, 1);
                return { ...item, readByPeer: true, readCount };
              }),
            };
          });
        }
      }
      if (event.type === "event.message.removed") {
        const chatId = String(event.chatId ?? "").trim();
        const messageId = String(event.messageId ?? "").trim();
        if (chatId && messageId) {
          setMessageMap((current) => ({
            ...current,
            [chatId]: (current[chatId] ?? []).filter((item) => item.id !== messageId),
          }));
          setCallHistory((current) => current?.filter((item) => item.id !== messageId) ?? current);
        }
      }
      if (event.type === "event.message.unsent") {
        const chatId = String(event.chatId ?? "").trim();
        const messageId = String(event.messageId ?? "").trim();
        if (chatId && messageId) {
          setMessageMap((current) => ({
            ...current,
            [chatId]: (current[chatId] ?? []).map((item) => item.id === messageId ? {
              ...item,
              text: "ยกเลิกข้อความแล้ว",
              image: undefined,
              stickerUrl: undefined,
              flex: undefined,
              postNotification: undefined,
              reactions: undefined,
              replyTo: undefined,
              replyToId: undefined,
              call: undefined,
              unsent: true,
              status: "sent",
            } : item),
          }));
          setCallHistory((current) => current?.filter((item) => item.id !== messageId) ?? current);
        }
      }
      if (event.type === "event.message" && event.message && typeof event.message === "object") {
        const raw = event.message as LiveMessageResult;
        const chatId = String(raw.chatId ?? "").trim();
        const contentType = Number(raw.contentType ?? 0);
        const preview = liveMessagePreview(raw);
        const eventMessageId = String(raw.id ?? raw.localId ?? "").trim();
        const rawEventSource = String(event.source ?? "");
        const systemNotificationTracked = rawEventSource === "talk-system" || Boolean(raw.systemNotificationTracked);
        const eventSource = rawEventSource.startsWith("openchat") ? "openchat" : "talk";
        const eventDedupKey = eventMessageId && chatId
          ? `${eventSource}:${chatId}:${eventMessageId}`
          : "";
        const now = Date.now();
        for (const [key, at] of liveEventDedupRef.current) {
          if (now - at > 10 * 60_000) liveEventDedupRef.current.delete(key);
        }
        const duplicateLiveEvent = Boolean(eventDedupKey && liveEventDedupRef.current.has(eventDedupKey));
        if (eventDedupKey) liveEventDedupRef.current.set(eventDedupKey, now);
        if (chatId && (preview || contentType > 0 || raw.stickerUrl || raw.flex || raw.postNotification)) {
          const knownChat = [...(liveChatsRef.current ?? []), ...(liveFriendsRef.current ?? [])]
            .find((chat) => chat.id === chatId);
          const chatKind = knownChat?.kind ?? (event.source === "openchat"
            ? "openchat"
            : chatId.startsWith("u") ? "dm" : "group");

          // A live delivery owns its unread increment. Mark it immediately so
          // an overlapping history reconciliation cannot discover the same
          // incoming message again and increment unread twice.
          if (!raw.isMine && eventMessageId) {
            historyDiscoveredMessageIdsRef.current.add(`${chatId}:${eventMessageId}`);
          }

          if (eventSource === "talk" && contentType === 6 && raw.call) {
            const callEntry: LiveCallHistoryResult = {
              id: eventMessageId,
              chatId,
              kind: chatKind === "group" ? "group" : "dm",
              name: knownChat?.name || raw.senderName || (chatId.startsWith("u") ? "LINE User" : "LINE Group"),
              avatarUrl: knownChat?.avatarUrl || raw.senderAvatarUrl,
              isMine: raw.isMine,
              createdTime: Number(raw.createdTime || Date.now()),
              call: raw.call,
            };
            setCallHistory((current) => [callEntry, ...(current ?? []).filter((item) => item.id !== callEntry.id)]
              .sort((left, right) => right.createdTime - left.createdTime));
          }

          // Update the denormalized sidebar locally as soon as the event
          // arrives. A later list refresh is only needed for a newly-created
          // or previously hidden room.
          setLiveChats((current) => {
            if (!current) return current;
            const existing = current.find((chat) => chat.id === chatId);
            let next = current;
            if (existing) {
              next = current.map((chat) => chat.id === chatId
                ? {
                  ...chat,
                  subtitle: preview,
                  time: formatListTime(raw.createdTime || Date.now()),
                  lastMessageTime: Math.max(chat.lastMessageTime ?? 0, raw.createdTime || Date.now()),
                  unread: raw.isMine
                    ? chat.unread
                    : systemNotificationTracked
                      ? Math.max(0, Number(raw.trackedUnread ?? 0)) || undefined
                      : duplicateLiveEvent ? chat.unread : (chat.unread ?? 0) + 1,
                }
                : chat);
            } else {
              const friend = liveFriendsRef.current?.find((chat) => chat.id === chatId);
              if (friend && chatKind === "dm") {
                next = [...current, {
                  ...friend,
                  subtitle: preview,
                  time: formatListTime(raw.createdTime || Date.now()),
                  lastMessageTime: raw.createdTime || Date.now(),
                  unread: raw.isMine ? undefined : 1,
                }];
              }
            }
            next = sortLiveChats(next);
            liveChatsRef.current = next;
            return next;
          });
          if (!knownChat || !(liveChatsRef.current ?? []).some((chat) => chat.id === chatId)) scheduleLiveChatRefresh();
          const autoLoadOpenChatMedia = event.source !== "openchat" || settingsRef.current.autoMedia;
          const sentKey = `${chatId}\u0000${raw.text}`;
          const queue = recentSentRef.current.get(sentKey) ?? [];
          while (queue.length && Date.now() - queue[0].at >= 15_000) queue.shift();
          const pendingEcho = raw.isMine
            ? (raw.localId ? queue.find((entry) => entry.localId === raw.localId) : undefined) ?? queue.shift()
            : undefined;
          if (raw.localId) {
            const index = queue.findIndex((entry) => entry.localId === raw.localId);
            if (index >= 0) queue.splice(index, 1);
          }
          if (queue.length) recentSentRef.current.set(sentKey, queue);
          else recentSentRef.current.delete(sentKey);
          if (raw.isMine && pendingEcho) {
            setMessageMap((current) => ({
              ...current,
              [chatId]: (current[chatId] ?? []).map((item) =>
                item.id === pendingEcho.localId
                  ? {
                    ...item,
                    id: raw.id || item.id,
                    createdTime: raw.createdTime || item.createdTime,
                    time: formatTime(raw.createdTime || item.createdTime || Date.now()),
                    contentType: raw.contentType,
                     stickerUrl: raw.stickerUrl,
                     flex: raw.flex,
                     rich: raw.rich,
                     call: raw.call,
                     reactions: raw.reactions,
                    readCount: Math.max(item.readCount ?? 0, Number(raw.readCount ?? 0)),
                    readByPeer: item.readByPeer || Number(raw.readCount ?? 0) > 0,
                    edited: raw.edited ?? item.edited,
                    updatedTime: raw.updatedTime ?? item.updatedTime,
                    replyTo: raw.replyTo ?? (raw.replyToId ? { id: raw.replyToId, text: "ข้อความ" } : undefined),
                    replyToId: raw.replyToId,
                    unsent: raw.unsent,
                    text: raw.rich || raw.contentType === 7 && raw.stickerUrl || raw.contentType === 22 && raw.flex ? undefined : item.text,
                    status: "sent",
                  }
                  : item
              ),
            }));
            return;
          }
          const serverMessageId = raw.id || raw.localId || crypto.randomUUID();
          const message: Message = {
            id: serverMessageId,
            author: raw.isMine ? "me" : "them",
            text: raw.rich || raw.contentType === 7 && raw.stickerUrl || raw.contentType === 22 && raw.flex
              ? undefined
              : raw.contentType === 1 ? (autoLoadOpenChatMedia ? "กำลังโหลดรูป…" : "รูปภาพ") : raw.text,
            time: formatTime(raw.createdTime || Date.now()),
            createdTime: raw.createdTime || Date.now(),
            contentType: raw.contentType,
             stickerUrl: raw.stickerUrl,
             flex: raw.flex,
             rich: raw.rich,
             call: raw.call,
             filename: raw.filename,
             senderId: raw.senderId,
             senderName: raw.senderName,
             senderAvatarUrl: raw.senderAvatarUrl,
             officialClientUrl: raw.officialClientUrl,
             isOfficialAccount: raw.isOfficialAccount,
             postNotification: raw.postNotification,
            reactions: raw.reactions,
            replyTo: raw.replyTo ?? (raw.replyToId ? { id: raw.replyToId, text: "ข้อความ" } : undefined),
            replyToId: raw.replyToId,
            unsent: raw.unsent,
            readCount: Math.max(0, Number(raw.readCount ?? 0)),
            readByPeer: Number(raw.readCount ?? 0) > 0,
            edited: raw.edited,
            updatedTime: raw.updatedTime,
            status: raw.status ?? "sent",
          };
          setMessageMap((current) => {
            const existing = current[chatId] ?? [];
            const optimisticIndex = raw.isMine
              ? existing.findIndex((item) => item.id === raw.localId || (
                Number(raw.contentType ?? 0) > 0 && Number(item.contentType ?? 0) > 0 && item.status === "sending" &&
                Math.abs((item.createdTime ?? 0) - (raw.createdTime || Date.now())) < 60_000
              ))
              : -1;
            if (optimisticIndex >= 0) {
              const next = [...existing];
              next[optimisticIndex] = {
                ...next[optimisticIndex],
                id: raw.id || next[optimisticIndex].id,
                text: raw.rich || raw.contentType === 7 && raw.stickerUrl || raw.contentType === 22 && raw.flex
                  ? undefined
                  : raw.contentType === 1 && autoLoadOpenChatMedia ? undefined : raw.contentType === 1 ? "รูปภาพ" : raw.text,
                time: message.time,
                createdTime: message.createdTime,
                contentType: raw.contentType,
                 stickerUrl: raw.stickerUrl,
                 flex: raw.flex,
                 call: raw.call,
                 rich: raw.rich,
                filename: raw.filename,
                 senderId: raw.senderId,
                 senderName: raw.senderName,
                 senderAvatarUrl: raw.senderAvatarUrl,
                 officialClientUrl: raw.officialClientUrl,
                 isOfficialAccount: raw.isOfficialAccount,
                 reactions: raw.reactions,
                replyTo: raw.replyTo ?? (raw.replyToId ? { id: raw.replyToId, text: "ข้อความ" } : undefined),
                replyToId: raw.replyToId,
                unsent: raw.unsent,
                edited: raw.edited ?? next[optimisticIndex].edited,
                updatedTime: raw.updatedTime ?? next[optimisticIndex].updatedTime,
                status: "sent",
              };
              return { ...current, [chatId]: next };
            }
            if (existing.some((item) => item.id === serverMessageId)) return current;
            return { ...current, [chatId]: [...existing, message] };
          });
          if (!raw.isMine && !isChatActuallyVisible(chatId)) {
            const notificationKey = `${chatId}:${raw.id}:${raw.createdTime}:${raw.text}`;
            const now = Date.now();
            for (const [key, at] of notificationDedupRef.current) {
              if (now - at > 60_000) notificationDedupRef.current.delete(key);
            }
            if (!notificationDedupRef.current.has(notificationKey)) {
              notificationDedupRef.current.set(notificationKey, now);
              void notifyDesktop(
                notificationSenderName(raw, knownChat),
                settingsRef.current.notificationPreview ? (raw.text || "มีสื่อใหม่") : "มีข้อความใหม่",
                settingsRef.current.desktopNotifications,
                settingsRef.current.notificationSound,
                { chatId, messageId: message.id },
                () => jumpToNotification(chatId, message.id),
                chatKind === "dm"
                  ? (raw.senderAvatarUrl || knownChat?.avatarUrl)
                  : (knownChat?.avatarUrl || raw.senderAvatarUrl),
              );
            }
          }
          if (raw.contentType === 1 && autoLoadOpenChatMedia) {
            void hydrateImagePreview(chatId, message.id, event.source === "openchat" ? "openchat" : "talk");
          }
        }
      }
      if (event.type === "call.incoming" || event.type === "event.call.incoming") {
        const incoming = (event.event && typeof event.event === "object" ? event.event : event) as Record<string, unknown>;
        const peer = String(incoming.peer ?? incoming.from ?? "");
        const incomingId = String(incoming.callId ?? incoming.callMid ?? crypto.randomUUID());
        setCallId(incomingId);
        setCallPeer(peer);
        setCallMode("AUDIO");
        setCallRemoteVideoFrame("");
        setCallVideoCapable(false);
        setCallVideoEnabled(false);
        setCallScreenSharing(false);
        setCallDirection("incoming");
        setCallIdentity((current) => current?.peer === peer ? current : null);
        setCallState("incoming");
        setCallError("");
        setCallOpen(true);

        if (!callNotificationDedupRef.current.has(incomingId)) {
          callNotificationDedupRef.current.add(incomingId);
          if (callNotificationDedupRef.current.size > 32) {
            const oldest = callNotificationDedupRef.current.values().next().value;
            if (oldest) callNotificationDedupRef.current.delete(oldest);
          }
          const knownChat = (liveChatsRef.current ?? []).find((chat) => chat.id === peer)
            ?? (liveFriendsRef.current ?? []).find((chat) => chat.id === peer);
          const callerName = knownChat?.name?.trim() || "LINE User";
          if (settingsRef.current.callNotifications && lineyEngine.isNative) {
            void invoke("notify_call", {
              title: "สายเรียกเข้าจาก " + callerName,
              body: "แตะเพื่อเปิด Liney และรับสาย",
              peer,
              callId: incomingId,
            }).catch(() => undefined);
          }
        }
      }
      if (event.type === "event.call.identity") {
        const peer = String(event.peer ?? "");
        const name = String(event.name ?? "").trim();
        const avatarUrl = String(event.avatarUrl ?? "").trim() || undefined;
        if (peer && name) setCallIdentity({ peer, name, avatarUrl });
      }
      if (event.type === "event.call.state") {
        const next = String(event.state ?? "idle") as CallState;
        if (videoUpgradeInProgressRef.current && (next === "ended" || next === "idle")) return;
        setCallState(next);
        if (event.reason === "video-failed") {
          setCallVideoEnabled(false);
          setCallScreenSharing(false);
          setCallError("ส่งภาพวิดีโอไม่สำเร็จ · ตรวจกล้องหรือการแชร์หน้าจอแล้วลองอีกครั้ง");
        }
      }
      if (event.type === "event.call.videoFrame") {
        const frame = String(event.frame ?? "");
        if (frame.startsWith("data:image/png;base64,")) setCallRemoteVideoFrame(frame);
      }
      if (event.type === "event.call.ready") {
        setCallId((current) => String(event.callId ?? current));
        setCallPeer((current) => String(event.peer ?? current));
        setCallVideoCapable(Boolean(event.videoCapable));
        if (event.videoCapable) setCallMode("VIDEO");
        setCallState("in-call");
        setCallOpen(true);
      }
      if (event.type === "event.call.error") {
        const message = String(event.error ?? "สายเสียงขัดข้อง");
        if (message.startsWith("remote-video:")) {
          setCallError("รับภาพวิดีโอจากอีกฝั่งไม่สำเร็จ · " + message.slice("remote-video:".length).trim());
        } else if (message.startsWith("media-capture:")) {
          setCallVideoEnabled(false);
          setCallScreenSharing(false);
          setCallError("สื่อภาพหยุดทำงาน · " + message.slice("media-capture:".length).trim());
        } else {
          setCallError(message);
        }
      }
      if (event.type === "event.call.cancel" || event.type === "event.call.ended") {
        if (videoUpgradeInProgressRef.current) return;
        setCallState("ended");
        setCallRemoteVideoFrame("");
        setCallOpen(false);
        setCallDirection(null);
      }
    });
    void connect();
    return () => {
      off();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (liveChatRefreshTimer !== undefined) window.clearTimeout(liveChatRefreshTimer);
      if (liveFriendsRefreshTimer !== undefined) window.clearTimeout(liveFriendsRefreshTimer);
    };
  }, [usesEngineRuntime]);

  useEffect(() => {
    if (!lineyEngine.isNative || !callOpen || !authenticated) return;
    let active = true;
    void Promise.all([
      lineyEngine.request<{ outputs?: AudioDeviceResult[] }>("call.devices", {}, 8_000)
        .catch(() => ({ outputs: [] as AudioDeviceResult[] })),
      lineyEngine.request<{ hardware?: CallHardwareStatus }>("call.status", {}, 8_000)
        .catch(() => ({ hardware: undefined })),
      lineyEngine.request<{
        backend?: string;
        managedBySystem?: boolean;
        targets?: ScreenShareTargetResult[];
      }>("call.screenTargets", {}, 8_000)
        .catch(() => ({ targets: [] as ScreenShareTargetResult[], managedBySystem: false })),
    ]).then(([devices, status, screen]) => {
      if (!active) return;
      setCallOutputs((devices?.outputs ?? []).filter((device) => device.kind === "output"));
      setCallCameraAvailable(Boolean(status?.hardware?.camera?.available));
      setCallMicrophoneAvailable(Boolean(status?.hardware?.microphone?.available));
      setCallSpeakerAvailable(Boolean(status?.hardware?.speaker?.available));
      setCallScreenShareAvailable(Boolean(status?.hardware?.screenShare?.available));
      const targets = (screen?.targets ?? []).filter((target) => target.available);
      setCallScreenTargets(targets);
      setCallScreenManagedBySystem(Boolean(screen?.managedBySystem));
      setCallScreenTarget((current) => {
        if (targets.some((target) => target.id === current)) return current;
        return targets.find((target) => target.id === "desktop")?.id
          ?? targets.find((target) => target.primary)?.id
          ?? targets[0]?.id
          ?? "desktop";
      });
    });
    return () => { active = false; };
  }, [callOpen, authenticated]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemDark(media.matches);
    sync();
    media.addEventListener?.("change", sync);
    return () => media.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    try {
      localStorage.setItem("liney.themeMode", themeMode);
    } catch {}
  }, [dark, themeMode]);

  useEffect(() => {
    try {
      localStorage.setItem("liney.localPins", JSON.stringify(localPins));
    } catch {
      // Pin state is best-effort if WebView storage is unavailable.
    }
  }, [localPins]);

  const allFriends = useMemo(
    () => usesEngineRuntime ? (liveFriends ?? []) : seedChats.filter((chat) => chat.kind === "dm"),
    [liveFriends, usesEngineRuntime],
  );
  const favoriteFriendMap = useMemo(
    () => new Map(allFriends.filter((friend) => friend.isFavorite).map((friend) => [friend.id, friend])),
    [allFriends],
  );
  const allChats = useMemo(() => {
    const base = usesEngineRuntime
      ? (settings.openchat ? (liveChats ?? []) : (liveChats ?? []).filter((chat) => chat.kind !== "openchat"))
      : seedChats;
    return mergeFriendProfilesIntoChats(base, allFriends)
      .map((chat) => {
        const localPinTimestamp = localPins[chat.id] ?? 0;
        const remotePinTimestamp = chat.favoriteTimestamp ?? 0;
        const favorite = chat.kind === "dm" ? favoriteFriendMap.get(chat.id) : undefined;
        return {
          ...chat,
          avatarUrl: chat.kind === "dm" ? currentTalkAvatarUrl(chat) : chat.avatarUrl,
          ...(favorite ? { isFavorite: true, favoriteTime: favorite.favoriteTime } : {}),
          pinned: Boolean(chat.pinned || localPinTimestamp),
          favoriteTimestamp: Math.max(remotePinTimestamp, localPinTimestamp),
        };
      })
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        if ((a.lastMessageTime ?? 0) !== (b.lastMessageTime ?? 0)) return (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0);
        return (b.favoriteTimestamp ?? 0) - (a.favoriteTimestamp ?? 0);
      });
  }, [liveChats, allFriends, favoriteFriendMap, localPins, settings.openchat, usesEngineRuntime]);
  const totalUnread = useMemo(
    () => allChats.reduce((sum, chat) => sum + Math.max(0, chat.unread ?? 0), 0),
    [allChats],
  );
  const unreadChatCount = useMemo(
    () => allChats.filter((chat) => (chat.unread ?? 0) > 0 && chat.id !== "__liney__").length,
    [allChats],
  );
  const callChats = useMemo(() => {
    const latestByChat = new Map<string, LiveCallHistoryResult>();
    for (const entry of callHistory ?? []) {
      if (!latestByChat.has(entry.chatId)) latestByChat.set(entry.chatId, entry);
    }
    return [...latestByChat.values()].map((entry, index): Chat => {
      const base = allChats.find((chat) => chat.id === entry.chatId)
        ?? allFriends.find((friend) => friend.id === entry.chatId);
      const name = base?.name || entry.name || (entry.chatId.startsWith("u") ? "LINE User" : "LINE Group");
      return {
        ...(base ?? {
          id: entry.chatId,
          name,
          subtitle: "การโทร",
          time: "",
          kind: entry.kind,
          avatar: initials(name),
          accent: avatarColor(index),
        }),
        id: entry.chatId,
        name,
        subtitle: callMessagePreview(entry.call),
        time: formatListTime(entry.createdTime),
        lastMessageTime: entry.createdTime,
        unread: undefined,
      };
    });
  }, [allChats, allFriends, callHistory]);
  const visibleChats = useMemo(() => {
    const hasQuery = Boolean(query.trim());
    let items = section === "friends"
      ? allFriends
      : section === "openchat"
      ? settings.openchat ? allChats.filter((chat) => chat.kind === "openchat") : []
      : section === "calls"
      ? callChats
      : allChats;

    // The main search box says "ค้นหาแชตหรือเพื่อน". While searching from
    // the chat tab, include friends who do not have a recent chat row yet.
    if (section === "messages" && hasQuery) {
      const seen = new Set(items.map((chat) => chat.id));
      items = [...items, ...allFriends.filter((friend) => !seen.has(friend.id))];
    }

    if (listFilter === "unread") items = items.filter((chat) => Boolean(chat.unread));
    if (listFilter === "pinned") items = items.filter((chat) => Boolean(chat.pinned));
    if (listFilter === "favorites") items = items.filter((chat) => Boolean(chat.isFavorite));
    if (hasQuery) {
      const needle = query.trim().toLocaleLowerCase("th");
      items = items.filter((chat) => `${chat.name} ${chat.subtitle}`.toLocaleLowerCase("th").includes(needle));
    }
    return items;
  }, [query, section, listFilter, allChats, allFriends, callChats, settings.openchat]);

  useEffect(() => {
    if (!usesEngineRuntime || section !== "calls") return;
    void loadCallHistory();
  }, [section, authenticated, usesEngineRuntime]);

  const placeholderChat: Chat = {
    id: "__liney__",
    name: syncStatus ? "กำลังซิงก์ข้อมูล LINE" : authenticated ? "เลือกแชตเพื่อเริ่มใช้งาน" : "เชื่อมบัญชี LINE",
    subtitle: syncStatus || (authenticated ? "แชตและ OpenChat ของคุณจะอยู่ด้านซ้าย" : "กดโลโก้ L เพื่อเข้าสู่ระบบด้วย QR"),
    time: "",
    kind: "dm",
    avatar: "L",
    accent: "#22c55e",
  };
  const activePool = [...allChats, ...allFriends, ...callChats];
  const activeChat = activePool.find((chat) => chat.id === activeChatId) ?? visibleChats[0] ?? activePool[0] ?? placeholderChat;
  const callBaseChat = activePool.find((chat) => chat.id === callPeer);
  const callResolvedIdentity = callIdentity?.peer === callPeer ? callIdentity : null;
  const callDisplayName = (
    callResolvedIdentity?.name && callResolvedIdentity.name !== "LINE User"
      ? callResolvedIdentity.name
      : callBaseChat?.name
  ) || (callPeer && !callPeer.startsWith("u") ? callPeer : "LINE User");
  const callChat: Chat = {
    ...(callBaseChat ?? {
      id: callPeer || "__call__",
      name: callDisplayName,
      subtitle: "การโทร",
      time: "",
      kind: "dm",
      avatar: initials(callDisplayName),
      accent: senderAccent(callPeer || callDisplayName),
    }),
    id: callPeer || callBaseChat?.id || "__call__",
    name: callDisplayName,
    avatar: initials(callDisplayName),
    avatarUrl: callResolvedIdentity?.avatarUrl || callBaseChat?.avatarUrl,
    accent: callBaseChat?.accent ?? senderAccent(callPeer || callDisplayName),
  };
  const activeTimelineEmptyFallback = activeChat.kind === "dm"
    && Boolean(liveChats)
    && !liveChats?.some((item) => item.id === activeChat.id);

  // The sidebar can learn about a message from Talk metadata before the push
  // operation reaches the renderer. Observe only the active room in the external
  // timeline store so incoming messages do not rerender MainApp/sidebar.
  useEffect(() => {
    if (!usesEngineRuntime || !authenticated || activeChat.id === "__liney__") return;
    const chatId = activeChat.id;
    const target = Number(activeChat.lastMessageTime ?? 0);
    let timer: number | undefined;

    const evaluate = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      const messages = getTimelineRooms()[chatId];
      if (!messages) return;
      const latest = messages.reduce(
        (value, message) => Math.max(value, Number(message.createdTime ?? 0)),
        0,
      );
      if (!target || latest >= target) {
        sidebarCatchupRef.current.delete(chatId);
        return;
      }
      const previous = sidebarCatchupRef.current.get(chatId);
      const attempts = previous?.target === target ? previous.attempts : 0;
      if (attempts >= 6) return;
      timer = window.setTimeout(() => {
        sidebarCatchupRef.current.set(chatId, { target, attempts: attempts + 1 });
        setMessageRefreshNonce((value) => value + 1);
      }, attempts === 0 ? 250 : Math.min(2_000, 500 + attempts * 300));
    };

    evaluate();
    const unsubscribe = timelineStore.subscribe((state, previous) => {
      if (state.rooms[chatId] !== previous.rooms[chatId]) evaluate();
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [authenticated, activeChat.id, activeChat.lastMessageTime, messageRefreshNonce, usesEngineRuntime]);

  async function markChatReadAtBottom(chat: Chat, lastMessageId?: string, lastMessageTime?: number) {
    const unread = chat.unread ?? 0;
    if (!authenticated || !windowActive || !unread || chat.id === "__liney__") return;
    const readKey = `${chat.id}:${lastMessageId || unread}`;
    if (readMarkedRef.current.has(readKey)) return;
    clearReadMarks(chat.id);
    readMarkedRef.current.add(readKey);
    const previousReadThrough = localReadThroughTimeRef.current.get(chat.id);
    const readThrough = Math.max(
      previousReadThrough ?? 0,
      Number(chat.lastMessageTime ?? 0),
      Number(lastMessageTime ?? 0),
    );
    if (readThrough > 0) localReadThroughTimeRef.current.set(chat.id, readThrough);
    setLiveChats((current) => {
      if (!current) return current;
      const next = current.map((item) => item.id === chat.id ? { ...item, unread: undefined } : item);
      liveChatsRef.current = next;
      return next;
    });
    try {
      await lineyEngine.request("chat.mark_read", {
        chatId: chat.id,
        kind: chat.kind === "openchat" ? "openchat" : "talk",
        ...(lastMessageId ? { messageId: lastMessageId } : {}),
      }, 20_000);
    } catch {
      readMarkedRef.current.delete(readKey);
      if (previousReadThrough === undefined) localReadThroughTimeRef.current.delete(chat.id);
      else localReadThroughTimeRef.current.set(chat.id, previousReadThrough);
      setLiveChats((current) => current?.map((item) => item.id === chat.id
        ? { ...item, unread: Math.max(item.unread ?? 0, unread) }
        : item) ?? current);
    }
  }

  async function markAllUnreadChats(): Promise<{ total: number; marked: number; failed: number }> {
    const unreadChats = allChats.filter((chat) => (chat.unread ?? 0) > 0 && chat.id !== "__liney__");
    if (!authenticated || unreadChats.length === 0 || markAllReadBusy) return { total: 0, marked: 0, failed: 0 };

    setMarkAllReadBusy(true);
    setMarkAllReadProgress({ done: 0, total: unreadChats.length });
    let nextIndex = 0;
    let done = 0;
    let marked = 0;
    let failed = 0;
    const worker = async () => {
      while (nextIndex < unreadChats.length) {
        const chat = unreadChats[nextIndex++];
        try {
          await lineyEngine.request("chat.mark_read", {
            chatId: chat.id,
            kind: chat.kind === "openchat" ? "openchat" : "talk",
          }, 20_000);
          marked += 1;
          const readThrough = Math.max(localReadThroughTimeRef.current.get(chat.id) ?? 0, Number(chat.lastMessageTime ?? 0));
          if (readThrough > 0) localReadThroughTimeRef.current.set(chat.id, readThrough);
          setLiveChats((current) => {
            if (!current) return current;
            const next = current.map((item) => {
              if (item.id !== chat.id) return item;
              const remainingUnread = Math.max(0, (item.unread ?? 0) - (chat.unread ?? 0));
              return { ...item, unread: remainingUnread || undefined };
            });
            liveChatsRef.current = next;
            return next;
          });
        } catch {
          failed += 1;
        }
        done += 1;
        setMarkAllReadProgress({ done, total: unreadChats.length });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(2, unreadChats.length) }, () => worker()));
      return { total: unreadChats.length, marked, failed };
    } finally {
      setMarkAllReadBusy(false);
      setMarkAllReadProgress(null);
    }
  }

  async function refreshTalkReadState(chatId: string, messages: Message[], requestGeneration: number) {
    if (activeChatRef.current !== chatId) return;
    const messageIds = [...new Set(messages
      .filter((message) => message.author === "me" && /^\d+$/.test(message.id))
      .map((message) => message.id)
      .slice(-80))];
    if (!messageIds.length) return;
    try {
      const states = await lineyEngine.request<LiveMessageReadState[]>("message.read_state", {
        chatId,
        kind: "talk",
        messageIds,
      }, 20_000);
      if (activeChatRef.current !== chatId
        || messageLoadGenerationRef.current.get(chatId) !== requestGeneration) return;
      const byId = new Map(states.map((state) => [state.messageId, state]));
      const roomReaders = sessionReadReadersRef.current.get(chatId) ?? new Map<string, Set<string>>();
      sessionReadReadersRef.current.set(chatId, roomReaders);
      setMessageMap((current) => {
        if (activeChatRef.current !== chatId
          || messageLoadGenerationRef.current.get(chatId) !== requestGeneration) return current;
        const existing = current[chatId];
        if (!existing) return current;
        let changed = false;
        const nextMessages = existing.map((message) => {
          if (message.author !== "me") return message;
          const state = byId.get(message.id);
          if (!state) return message;
          const readers = roomReaders.get(message.id) ?? new Set<string>();
          for (const readerMid of state.readerMids ?? []) {
            if (readerMid) readers.add(readerMid);
          }
          if (readers.size) roomReaders.set(message.id, readers);
          const readCount = Math.max(message.readCount ?? 0, state.readCount, readers.size);
          if (readCount === (message.readCount ?? 0) && Boolean(message.readByPeer) === (readCount > 0)) return message;
          changed = true;
          return { ...message, readCount, readByPeer: readCount > 0 };
        });
        if (!changed) return current;
        const nextState = { ...current, [chatId]: nextMessages };
        messageMapRef.current = nextState;
        return nextState;
      });
    } catch {
      // Read ranges are supplementary metadata. Cached history must stay usable
      // when the endpoint is unavailable or the session is briefly offline.
    }
  }

  // LINE push + polling fallback live in the engine. The renderer only
  // reconciles occasionally for membership metadata or a rare missed edge;
  // aggressive 4s/12s polling here used to race the live stream and duplicate
  // unread/list work.
  useEffect(() => {
    if (!usesEngineRuntime || !authenticated || !settings.openchat || !settings.openchatRealtimeRefresh) return;
    const listTimer = window.setInterval(() => { void loadLiveChats(); }, 60_000);
    return () => window.clearInterval(listTimer);
  }, [authenticated, settings.openchat, settings.openchatRealtimeRefresh, usesEngineRuntime]);

  useEffect(() => {
    if (!usesEngineRuntime || !authenticated) return;
    let lastRefreshAt = 0;
    const refreshFriends = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefreshAt < 30_000) return;
      lastRefreshAt = now;
      void loadLiveFriends();
    };
    refreshFriends();
    const refreshTimer = window.setInterval(refreshFriends, 5 * 60_000);
    window.addEventListener("focus", refreshFriends);
    document.addEventListener("visibilitychange", refreshFriends);
    return () => {
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", refreshFriends);
      document.removeEventListener("visibilitychange", refreshFriends);
    };
  }, [authenticated, usesEngineRuntime]);

  useEffect(() => {
    if (!usesEngineRuntime || !authenticated || activeChat.kind !== "openchat" || !settings.openchatRealtimeRefresh) return;
    const messageTimer = window.setInterval(() => setMessageRefreshNonce((value) => value + 1), 30_000);
    return () => window.clearInterval(messageTimer);
  }, [authenticated, activeChat.id, activeChat.kind, settings.openchatRealtimeRefresh, usesEngineRuntime]);

  useEffect(() => {
    if (!usesEngineRuntime || !authenticated || !activeChatId) return;
    const chat = [...(liveChatsRef.current ?? []), ...(liveFriendsRef.current ?? []), ...callChats]
      .find((item) => item.id === activeChatId);
    if (!chat) return;
    const activeLoadEpoch = activeMessageLoadEpochRef.current;
    const requestGeneration = (messageLoadGenerationRef.current.get(chat.id) ?? 0) + 1;
    messageLoadGenerationRef.current.set(chat.id, requestGeneration);
    const isCurrentLoad = () => activeMessageLoadEpochRef.current === activeLoadEpoch
      && activeChatRef.current === chat.id
      && messageLoadGenerationRef.current.get(chat.id) === requestGeneration;

    const catchup = sidebarCatchupRef.current.get(chat.id);
    const forceRefresh = Boolean(catchup)
      || forcedHistoryRefreshRef.current.has(chat.id)
      || (chat.kind === "openchat" && settingsRef.current.openchatRealtimeRefresh && messageRefreshNonce > 0);
    // A short network-only debounce collapses A→B→C rapid clicks into one
    // history request while cached UI selection still changes immediately.
    const timer = window.setTimeout(() => {
      if (!isCurrentLoad()) return;
      void lineyEngine
      .request<LiveMessageResult[]>("message.list", {
        chatId: chat.id,
        kind: chat.kind === "openchat" ? "openchat" : "talk",
        limit: chat.kind === "openchat" ? 40 : 50,
        ...(forceRefresh ? { refresh: true } : {}),
      }, chat.kind === "openchat" ? 45_000 : 30_000)
      .then((list) => {
        if (!isCurrentLoad()) return;
        const sorted = [...list]
          .sort((a, b) => Number(a.createdTime) - Number(b.createdTime))
          .filter((item) => item.text || Number(item.contentType ?? 0) > 0);
        forcedHistoryRefreshRef.current.delete(chat.id);
        if (sorted.length) {
          sidebarCatchupRef.current.delete(chat.id);
        } else if (chat.kind !== "openchat" && Number(chat.lastMessageTime ?? 0) > 0) {
          // The engine already tried cursor, recent, box payload, and one
          // metadata refresh. Avoid a six-request loop over the same empty
          // remote result; the user can still request a fresh pass manually.
          sidebarCatchupRef.current.set(chat.id, {
            target: Number(chat.lastMessageTime),
            attempts: 6,
          });
        }
        const baseMapped = sorted.map<Message>((item) => ({
          id: item.id,
          author: item.isMine ? "me" : "them",
          text: item.rich || Number(item.contentType ?? 0) === 7 && item.stickerUrl || Number(item.contentType ?? 0) === 22 && item.flex
            ? undefined
            : Number(item.contentType ?? 0) === 1
              ? (chat.kind === "openchat" && !settingsRef.current.autoMedia ? "รูปภาพ" : "กำลังโหลดรูป…")
              : item.text,
          time: formatTime(item.createdTime),
          createdTime: item.createdTime,
          contentType: item.contentType,
          readCount: Math.max(0, Number(item.readCount ?? 0)),
          readByPeer: Number(item.readCount ?? 0) > 0,
          edited: item.edited,
          updatedTime: item.updatedTime,
          filename: item.filename,
          senderId: item.senderId,
          senderName: item.senderName,
          senderAvatarUrl: item.senderAvatarUrl,
          officialClientUrl: item.officialClientUrl,
          isOfficialAccount: item.isOfficialAccount,
          stickerUrl: item.stickerUrl,
          flex: item.flex,
           rich: item.rich,
           postNotification: item.postNotification,
           call: item.call,
           reactions: item.reactions,
          replyTo: item.replyTo ?? (item.replyToId ? { id: item.replyToId, text: "ข้อความ" } : undefined),
          replyToId: item.replyToId,
          unsent: item.unsent,
          status: item.status ?? "sent",
          sendError: item.sendError ? formatSendError(item.sendError) : undefined,
        }));
        const existingSnapshot = messageMapRef.current[chat.id] ?? [];
        const existingIds = new Set(existingSnapshot.map((item) => item.id));
        const previousNewestTime = existingSnapshot.reduce((latest, item) => Math.max(latest, Number(item.createdTime ?? 0)), 0);
        let discoveredUnread = 0;
        if (previousNewestTime > 0) {
          for (const item of baseMapped) {
            if (item.author !== "them" || existingIds.has(item.id) || Number(item.createdTime ?? 0) <= previousNewestTime) continue;
            const key = `${chat.id}:${item.id}`;
            if (historyDiscoveredMessageIdsRef.current.has(key)) continue;
            historyDiscoveredMessageIdsRef.current.add(key);
            discoveredUnread += 1;
          }
        }
        if (discoveredUnread > 0) {
          const latestRemote = sorted.at(-1);
          const latestPreview = latestRemote ? liveMessagePreview(latestRemote) : chat.subtitle;
          const latestTime = Number(latestRemote?.createdTime ?? chat.lastMessageTime ?? Date.now());
          setLiveChats((current) => {
            if (!current) return current;
            const next = sortLiveChats(current.map((item) => item.id === chat.id ? {
              ...item,
              subtitle: latestPreview || item.subtitle,
              time: formatListTime(latestTime),
              lastMessageTime: Math.max(item.lastMessageTime ?? 0, latestTime),
              unread: (item.unread ?? 0) + discoveredUnread,
            } : item));
            liveChatsRef.current = next;
            return next;
          });
        }
        setMessageMap((current) => {
          if (!isCurrentLoad()) return current;
          const existing = current[chat.id] ?? [];
          const previousById = new Map(existing.map((item) => [item.id, item]));
          // A history refresh recreates Message objects. Carry an already
          // hydrated preview forward so a sidebar refresh or room re-open
          // cannot make an image blank while media.preview runs again.
          const mapped = baseMapped.map((item) => {
            const previous = previousById.get(item.id);
            const keepImage = Boolean(previous?.image)
              && (chat.kind !== "openchat" || settingsRef.current.autoMedia);
            const readCount = Math.max(item.readCount ?? 0, previous?.readCount ?? 0);
            const readState = readCount > 0 || previous?.readByPeer ? { readByPeer: true, readCount } : {};
            return keepImage
              ? { ...item, image: previous?.image, text: undefined, ...readState }
              : { ...item, ...readState };
          });
          const serverIds = new Set(mapped.map((item) => item.id));
          const newestServerTime = mapped.reduce((max, item) => Math.max(max, item.createdTime ?? 0), 0);
          const localOnly = existing.filter((item) => {
            if (serverIds.has(item.id)) return false;
            // Keep optimistic/recent live messages while LINE's history
            // endpoint is still catching up. This applies to incoming events
            // too; otherwise a sidebar refresh could immediately erase a
            // message that was just delivered by the push stream.
            if (item.author === "me" && (item.status === "sending" || item.status === "error" || item.status === "unknown")) return true;
            return (item.createdTime ?? 0) > newestServerTime;
          });
          const merged = [...mapped, ...localOnly]
            .sort((a, b) => (a.createdTime ?? 0) - (b.createdTime ?? 0));
          const nextState = { ...current, [chat.id]: merged };
          messageMapRef.current = nextState;
          return nextState;
        });
        if (chat.kind !== "openchat") void refreshTalkReadState(chat.id, baseMapped, requestGeneration);
        void hydrateImagePreviews(chat.id, sorted, chat.kind === "openchat" ? "openchat" : "talk", requestGeneration);
      })
      .catch((error) => {
        if (!isCurrentLoad()) return;
        forcedHistoryRefreshRef.current.delete(chat.id);
        // Keep the last good SQLite history visible when a refresh fails.
        setMessageMap((current) => current[chat.id] ? current : ({ ...current, [chat.id]: [] }));
        setAuthError(error instanceof Error ? error.message : String(error));
      });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [activeChatId, authenticated, callChats, settings.autoMedia, messageRefreshNonce, usesEngineRuntime]);

  async function hydrateImagePreview(
    chatId: string,
    messageId: string,
    kind: "talk" | "openchat",
    requestGeneration?: number,
  ) {
    const stale = () => requestGeneration !== undefined
      && (activeChatRef.current !== chatId
        || messageLoadGenerationRef.current.get(chatId) !== requestGeneration);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stale()) return;
      try {
        const preview = await lineyEngine.request<MediaPreviewResult>(
          "media.preview",
          { messageId, chatId, kind, refresh: attempt > 0 },
          45_000,
        );
        if (!preview?.dataUrl) throw new Error("empty image preview");
        setMessageMap((current) => {
          if (stale()) return current;
          return {
            ...current,
            [chatId]: (current[chatId] ?? []).map((item) =>
              item.id === messageId ? { ...item, image: preview.dataUrl, text: undefined } : item
            ),
          };
        });
        return;
      } catch (error) {
        lastError = error;
        if (stale()) return;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 650));
      }
    }

    // Keep a usable fallback only after both the preview and retry path fail.
    setMessageMap((current) => {
      if (stale()) return current;
      return {
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) =>
          item.id === messageId && item.contentType === 1 ? { ...item, text: "รูปภาพ" } : item
        ),
      };
    });
    if (lastError) console.debug("LINE image preview unavailable", messageId, lastError);
  }

  async function hydrateImagePreviews(
    chatId: string,
    list: LiveMessageResult[],
    kind: "talk" | "openchat",
    requestGeneration?: number,
  ) {
    const stale = () => requestGeneration !== undefined
      && (activeChatRef.current !== chatId
        || messageLoadGenerationRef.current.get(chatId) !== requestGeneration);
    if (stale()) return;
    if (kind === "openchat" && !settingsRef.current.autoMedia) {
      setMessageMap((current) => {
        if (stale()) return current;
        return {
          ...current,
          [chatId]: (current[chatId] ?? []).map((item) =>
            item.contentType === 1 && !item.image ? { ...item, text: "รูปภาพ" } : item
          ),
        };
      });
      return;
    }
    const images = list.filter((item) => Number(item.contentType ?? 0) === 1).slice(-MAX_IMAGE_PREVIEWS_PER_REFRESH);
    // One preview at a time keeps the UI/network responsive on low-power Linux
    // machines; the next request is skipped immediately if the room changed.
    for (const image of images) {
      if (stale()) return;
      await hydrateImagePreview(chatId, image.id, kind, requestGeneration);
    }
  }

  async function loadOlderTimelineMessages(
    chat: Chat,
    before: Message,
  ): Promise<{ added: number; hasMore: boolean }> {
    if (chat.kind === "openchat") return { added: 0, hasMore: false };
    const page = await lineyEngine.request<LiveHistoryPage>("message.history", {
      chatId: chat.id,
      kind: "talk",
      beforeMessageId: before.id,
      beforeCreatedTime: Number(before.createdTime ?? 0),
      limit: 50,
    }, 30_000);
    const sorted = [...(Array.isArray(page?.messages) ? page.messages : [])]
      .sort((left, right) => Number(left.createdTime ?? 0) - Number(right.createdTime ?? 0))
      .filter((item) => item.text || Number(item.contentType ?? 0) > 0);
    const mapped = sorted.map((item) => mapLiveMessageResult(item, chat.kind, settingsRef.current.autoMedia));
    let added = 0;

    updateTimelineRoom(chat.id, (current) => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of mapped) {
        const previous = byId.get(message.id);
        if (!previous) {
          byId.set(message.id, message);
          added += 1;
          continue;
        }
        byId.set(message.id, {
          ...message,
          ...previous,
          readCount: Math.max(message.readCount ?? 0, previous.readCount ?? 0),
          readByPeer: Boolean(message.readByPeer || previous.readByPeer),
        });
      }
      return [...byId.values()].sort((left, right) => Number(left.createdTime ?? 0) - Number(right.createdTime ?? 0));
    });

    const requestGeneration = messageLoadGenerationRef.current.get(chat.id);
    if (requestGeneration !== undefined) void refreshTalkReadState(chat.id, mapped, requestGeneration);
    void hydrateImagePreviews(chat.id, sorted, "talk", requestGeneration);
    return { added, hasMore: Boolean(page?.hasMore) && added > 0 };
  }

  async function loadLiveChats() {
    const requestGeneration = ++liveChatsLoadGenerationRef.current;
    const includeOpenchat = settingsRef.current.openchat;
    const [talkResult, squareResult] = await Promise.allSettled([
      lineyEngine.request<LiveChatResult[]>("chats.list", {}, 45_000),
      includeOpenchat
        ? lineyEngine.request<LiveChatResult[]>("openchat.list", {}, 45_000)
        : Promise.resolve<LiveChatResult[]>([]),
    ]);
    if (liveChatsLoadGenerationRef.current !== requestGeneration) return;
    const talkSucceeded = talkResult.status === "fulfilled" && Array.isArray(talkResult.value);
    const squareSucceeded = squareResult.status === "fulfilled" && Array.isArray(squareResult.value);
    const talk = talkSucceeded ? talkResult.value : [];
    const square = squareSucceeded ? squareResult.value : [];
    const previous = liveChatsRef.current ?? [];
    const remoteIds = new Set([...talk, ...square].map((item) => item.id));
    const preserved = previous.filter((chat) =>
      !remoteIds.has(chat.id)
      && (includeOpenchat || chat.kind !== "openchat"),
    );
    const previousById = new Map(previous.map((chat) => [chat.id, chat]));
    const mappedRemote = [...talk, ...square].map((item, index) => {
      const mapped = mapLiveChatResult(item, index);
      const prior = previousById.get(mapped.id);
      const readThrough = localReadThroughTimeRef.current.get(mapped.id) ?? 0;
      const unread = (mapped.lastMessageTime ?? 0) <= readThrough
        ? undefined
        : Math.max(mapped.unread ?? 0, prior?.unread ?? 0) || undefined;
      return { ...mapped, unread };
    });
    const mappedById = new Map<string, Chat>();
    for (const chat of [...mappedRemote, ...preserved]) {
      if (!mappedById.has(chat.id)) mappedById.set(chat.id, chat);
    }
    const mapped = sortLiveChats([...mappedById.values()]);
    liveChatsRef.current = mapped;
    setLiveChats(mapped);
    setActiveChatId((current) => mapped.some((chat) => chat.id === current)
      || Boolean(liveFriendsRef.current?.some((chat) => chat.id === current))
      ? current
      : (mapped[0]?.id ?? ""));
    if (!talkSucceeded && !squareSucceeded) {
      const reason = talkResult.status === "rejected" ? String(talkResult.reason) : "ผลลัพธ์จาก LINE ไม่ถูกต้อง";
      setAuthError(`โหลดรายการแชตไม่สำเร็จ: ${reason}`);
    } else if (!talkSucceeded) {
      setAuthError("แชตปกติโหลดไม่สำเร็จในรอบนี้ จึงคงรายการแชตก่อนหน้าไว้");
    } else if (!squareSucceeded) {
      setAuthError("แชตปกติใช้ได้ แต่ OpenChat โหลดไม่สำเร็จในรอบนี้");
    }
  }

  async function loadCallHistory() {
    const requestGeneration = ++callHistoryLoadGenerationRef.current;
    try {
      const result = await lineyEngine.request<LiveCallHistoryResult[]>("call.history", { limit: 200 }, 20_000);
      if (callHistoryLoadGenerationRef.current !== requestGeneration) return;
      setCallHistory(Array.isArray(result) ? result : []);
    } catch (error) {
      if (callHistoryLoadGenerationRef.current !== requestGeneration) return;
      setCallHistory((current) => current ?? []);
      if (authenticatedRef.current) {
        const message = error instanceof Error ? error.message : String(error);
        setAuthError(`โหลดประวัติการโทรไม่สำเร็จ: ${message}`);
      }
    }
  }

  async function loadLiveFriends(allowRetry = true) {
    const requestGeneration = ++liveFriendsLoadGenerationRef.current;
    try {
      const result = await lineyEngine.request<LiveChatResult[]>("friends.list", {}, 60_000);
      if (liveFriendsLoadGenerationRef.current !== requestGeneration) return;
      const mapped = result.map(mapLiveFriendResult);
      const next = mergeLiveFriendSnapshots(liveFriendsRef.current, mapped);
      liveFriendsRef.current = next;
      setLiveFriends(next);
      const previousChats = liveChatsRef.current ?? [];
      const nextChats = mergeFriendProfilesIntoChats(previousChats, next);
      if (nextChats.some((chat, index) => chat !== previousChats[index])) {
        liveChatsRef.current = nextChats;
        setLiveChats(nextChats);
      }
    } catch (error) {
      if (liveFriendsLoadGenerationRef.current !== requestGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      // The sidecar may still be restoring the session right after the app
      // flipped to the authenticated view. Retry a couple times once auth is
      // actually confirmed, instead of hard-failing on a transient race.
      if (allowRetry && /not authenticated/i.test(message)) {
        window.setTimeout(() => { if (liveFriendsLoadGenerationRef.current === requestGeneration) void loadLiveFriends(false); }, 1_200);
        return;
      }
      setAuthError(`โหลดรายชื่อเพื่อนไม่สำเร็จ: ${message}`);
    }
  }

  function toggleLocalPin(chatId: string) {
    setLocalPins((current) => {
      const next = { ...current };
      if (next[chatId]) delete next[chatId];
      else next[chatId] = Date.now();
      return next;
    });
  }

  async function mergeDuplicateChats(aliasMid: string, canonicalMid: string) {
    const result = await lineyEngine.request<{ canonicalMid?: string }>(
      "chat.identity.merge",
      { aliasMid, canonicalMid },
      30_000,
    );
    const selectedMid = String(result?.canonicalMid || canonicalMid);
    setReplyTarget(null);
    setSection("messages");
    setListFilter("all");
    setActiveChatId(selectedMid);
    setMobileConversationOpen(true);
    setMessageMap((current) => {
      const next = { ...current };
      delete next[aliasMid];
      next[selectedMid] = [];
      return next;
    });
    setMessageRefreshNonce((current) => current + 1);
    setLocalPins((current) => {
      const next = { ...current };
      const sourcePin = next[aliasMid] ?? 0;
      const targetPin = next[selectedMid] ?? 0;
      if (sourcePin || targetPin) next[selectedMid] = Math.max(sourcePin, targetPin);
      delete next[aliasMid];
      return next;
    });
    await Promise.all([loadLiveChats(), loadLiveFriends()]);
    setActiveChatId(selectedMid);
  }

  function selectChat(chatId: string) {
    const chat = [...(liveChats ?? []), ...(liveFriends ?? []), ...callChats].find((item) => item.id === chatId);
    setReplyTarget(null);
    setActiveChatId(chatId);
    setMobileConversationOpen(true);
    if (!chat || !authenticated) return;

    // Keep unread state until the viewport reaches the newest message.
  }

  function startDirectChat(friend: Chat) {
    const draft: Chat = {
      ...friend,
      subtitle: friend.subtitle || "เพื่อน · LINE",
      time: "",
      lastMessageTime: friend.lastMessageTime ?? 0,
      unread: undefined,
      historyState: friend.historyState ?? "new",
    };
    setLiveChats((current) => {
      const existing = current ?? [];
      if (existing.some((chat) => chat.id === friend.id)) return current ?? existing;
      const next = sortLiveChats([...existing, draft]);
      liveChatsRef.current = next;
      return next;
    });
    setSection("messages");
    setListFilter("all");
    setQuery("");
    setReplyTarget(null);
    setActiveChatId(friend.id);
    setMobileConversationOpen(true);
    setNewChatOpen(false);
  }

  async function addFriendByLineId(userId: string): Promise<Chat> {
    const result = await lineyEngine.request<LiveChatResult>("friend.add_by_id", { userId }, 45_000);
    const friend = mapLiveFriendResult(result, liveFriendsRef.current?.length ?? 0);
    setLiveFriends((current) => {
      const existing = current ?? [];
      const next = sortLiveFriends([friend, ...existing.filter((item) => item.id !== friend.id)]);
      liveFriendsRef.current = next;
      return next;
    });
    return friend;
  }

  async function createGroupChat(name: string, memberMids: string[]): Promise<Chat> {
    const result = await lineyEngine.request<LiveChatResult>("chat.create_group", { name, memberMids }, 60_000);
    if (!result?.id) throw new Error("LINE ไม่ส่งรหัสกลุ่มกลับมา");
    const group = mapLiveChatResult({ ...result, kind: "group" }, liveChatsRef.current?.length ?? 0);
    setLiveChats((current) => {
      const existing = current ?? [];
      const next = sortLiveChats([group, ...existing.filter((item) => item.id !== group.id)]);
      liveChatsRef.current = next;
      return next;
    });
    setSection("messages");
    setListFilter("all");
    setQuery("");
    setReplyTarget(null);
    setActiveChatId(group.id);
    setMobileConversationOpen(true);
    setNewChatOpen(false);
    return group;
  }

  async function createOpenChatRoom(name: string, description: string, searchable: boolean): Promise<Chat> {
    const result = await lineyEngine.request<LiveChatResult>("openchat.create", { name, description, searchable }, 60_000);
    if (!result?.id) throw new Error("LINE ไม่ส่งรหัส OpenChat กลับมา");
    const room = mapLiveChatResult({ ...result, kind: "openchat" }, liveChatsRef.current?.length ?? 0);
    setLiveChats((current) => {
      const existing = current ?? [];
      const next = sortLiveChats([room, ...existing.filter((item) => item.id !== room.id)]);
      liveChatsRef.current = next;
      return next;
    });
    setSection("openchat");
    setListFilter("all");
    setQuery("");
    setReplyTarget(null);
    setActiveChatId(room.id);
    setMobileConversationOpen(true);
    setNewChatOpen(false);
    return room;
  }

  function startQrLogin() {
    if (engineState !== "ready" || authBusy) return;
    setAuthOpen(true);
    setAuthMode("qr");
    setQrUrl("");
    setPin("");
    setAuthError("");
    setAuthBusy(true);
    void lineyEngine.request("auth.qr.start", {}, 180_000)
      .catch((error) => {
        setQrUrl("");
        setPin("");
        setAuthError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setAuthBusy(false));
  }

  function beginKeyImport() {
    keyImportDialogOpenRef.current = true;
    setKeyImportMode(true);
    setKeyImportResult(null);
    setQrUrl("");
    setPin("");
    setAuthError("");
  }

  function startKeychainImport() {
    if (engineState !== "ready" || authBusy || !authenticated) return;
    keyImportDialogOpenRef.current = true;
    setAuthOpen(true);
    setKeyImportMode(true);
    setKeyImportResult(null);
    setQrUrl("");
    setPin("");
    setAuthError("");
    setAuthBusy(true);
    void lineyEngine.request<{ keychainImported?: boolean; generations?: number }>("auth.e2ee.qr_import", {}, 180_000)
      .then((result) => {
        if (!result?.keychainImported) throw new Error("LINE ไม่ได้ยืนยันการนำเข้า keychain");
        setKeyImportResult({ generations: Math.max(1, Number(result.generations ?? 1)) });
        setQrUrl("");
        setPin("");
        if (keyImportDialogOpenRef.current) setAuthOpen(true);
      })
      .catch((error) => {
        setQrUrl("");
        setPin("");
        setAuthError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setAuthBusy(false));
  }

  function startPasswordLogin() {
    if (engineState !== "ready" || authBusy) return;
    const email = authEmail.trim();
    const password = authPassword;
    if (!email || !password) {
      setAuthError("กรุณากรอก Email และ Password ให้ครบ");
      return;
    }
    setAuthOpen(true);
    setAuthMode("password");
    setQrUrl("");
    setPin("");
    setAuthError("");
    setAuthBusy(true);
    // Clear the password field immediately. The engine receives it over the
    // local JSONL pipe, but Liney never persists the password or puts it in
    // localStorage.
    setAuthPassword("");
    void lineyEngine.request("auth.password.start", { email, password }, 180_000)
      .catch((error) => {
        setAuthError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setAuthBusy(false));
  }

  async function sendMessage(textOverride?: string) {
    const text = (textOverride ?? composer).trim();
    if (!text) return;
    if (!authenticated || activeChat.id === "__liney__") {
      setAuthOpen(true);
      return;
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const chatId = activeChat.id;
    const chatKind = activeChat.kind;
    // Text replies are supported by both Talk and OpenChat.  Only the
    // media path has a separate limitation in the current LINEJS adapter.
    const reply = replyTarget;
    const message: Message = {
      id,
      author: "me",
      text,
      time: formatTime(now),
      createdTime: now,
      ...(reply ? { replyTo: reply, replyToId: reply.id } : {}),
      status: "sending",
    };
    const sentKey = `${chatId}\u0000${text}`;
    const pendingQueue = recentSentRef.current.get(sentKey) ?? [];
    pendingQueue.push({ at: now, localId: id });
    recentSentRef.current.set(sentKey, pendingQueue);
    setMessageMap((current) => ({
      ...current,
      [chatId]: [...(current[chatId] ?? []), message],
    }));
    // Update the sidebar immediately too; do not wait for LINE's list endpoint.
    // A direct chat can be started from the friend picker before LINE has ever
    // created a recent-conversation row, so insert that row on first send.
    setLiveChats((current) => {
      const existing = current ?? [];
      const preview = text.replace(/\s+/g, " ").trim();
      if (existing.some((chat) => chat.id === chatId)) {
        const next = sortLiveChats(existing.map((chat) =>
          chat.id === chatId
            ? { ...chat, subtitle: preview, time: formatListTime(now), lastMessageTime: now, unread: undefined, historyState: "available" }
            : chat
        ));
        liveChatsRef.current = next;
        return next;
      }
      const friend = liveFriendsRef.current?.find((item) => item.id === chatId);
      const nextChat: Chat = friend
        ? { ...friend, subtitle: preview, time: formatListTime(now), lastMessageTime: now, unread: undefined, historyState: "available" }
        : { ...activeChat, subtitle: preview, time: formatListTime(now), lastMessageTime: now, unread: undefined, historyState: "available" };
      const next = sortLiveChats([...existing, nextChat]);
      liveChatsRef.current = next;
      return next;
    });
    if (textOverride === undefined) setComposer("");
    setReplyTarget(null);
    try {
      await lineyEngine.request("message.send", {
        chatId,
        kind: chatKind === "openchat" ? "openchat" : "talk",
        text,
        localId: id,
        createdAt: now,
        sequence: pendingQueue.length,
        ...(reply ? { relatedMessageId: reply.id } : {}),
      }, 45_000);
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === id ? { ...item, status: "sent" } : item),
      }));
      window.setTimeout(() => void loadLiveChats(), 700);
    } catch (error) {
      const uncertain = error instanceof EngineRequestError && error.code === "TIMEOUT";
      if (!uncertain) {
        const pending = (recentSentRef.current.get(sentKey) ?? []).filter((entry) => entry.localId !== id);
        if (pending.length) recentSentRef.current.set(sentKey, pending);
        else recentSentRef.current.delete(sentKey);
      }
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === id ? { ...item, status: uncertain ? "unknown" : "error" } : item),
      }));
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendSticker(sticker: RecentSticker) {
    if (!authenticated || activeChat.id === "__liney__") {
      setAuthOpen(true);
      return;
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const chatId = activeChat.id;
    const chatKind = activeChat.kind;
    const stickerUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${encodeURIComponent(sticker.stickerId)}/android/${sticker.option === "A" ? "sticker_animation.png" : "sticker.png"}`;
    setMessageMap((current) => ({
      ...current,
      [chatId]: [...(current[chatId] ?? []), { id, author: "me", time: formatTime(now), createdTime: now, contentType: 7, stickerUrl, status: "sending" }],
    }));
    setLiveChats((current) => current?.map((chat) => chat.id === chatId
      ? { ...chat, subtitle: "สติกเกอร์", time: formatListTime(now), lastMessageTime: now, unread: undefined, historyState: "available" }
      : chat) ?? current);
    setReplyTarget(null);
    try {
      await lineyEngine.request("message.sendSticker", {
        chatId,
        kind: chatKind === "openchat" ? "openchat" : "talk",
        packageId: sticker.packageId,
        stickerId: sticker.stickerId,
        version: sticker.version,
        ...(sticker.option ? { option: sticker.option } : {}),
        localId: id,
        createdAt: now,
      }, 45_000);
      setMessageMap((current) => ({ ...current, [chatId]: (current[chatId] ?? []).map((item) => item.id === id ? { ...item, status: "sent" } : item) }));
      window.setTimeout(() => void loadLiveChats(), 700);
    } catch (error) {
      const uncertain = error instanceof EngineRequestError && error.code === "TIMEOUT";
      setMessageMap((current) => ({ ...current, [chatId]: (current[chatId] ?? []).map((item) => item.id === id ? { ...item, status: uncertain ? "unknown" : "error" } : item) }));
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendLineEmoji(emoji: RecentEmoji) {
    if (!authenticated || activeChat.id === "__liney__") {
      setAuthOpen(true);
      return;
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const chatId = activeChat.id;
    const chatKind = activeChat.kind;
    const emojiUrl = `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${encodeURIComponent(emoji.productId)}/android/${encodeURIComponent(emoji.sticonId)}.png`;
    setMessageMap((current) => ({
      ...current,
      [chatId]: [...(current[chatId] ?? []), { id, author: "me", time: formatTime(now), createdTime: now, emojiUrl, status: "sending" }],
    }));
    setLiveChats((current) => current?.map((chat) => chat.id === chatId
      ? { ...chat, subtitle: "LINE Emoji", time: formatListTime(now), lastMessageTime: now, unread: undefined, historyState: "available" }
      : chat) ?? current);
    setReplyTarget(null);
    try {
      await lineyEngine.request("message.sendEmoji", {
        chatId,
        kind: chatKind === "openchat" ? "openchat" : "talk",
        productId: emoji.productId,
        sticonId: emoji.sticonId,
        version: emoji.version,
        resourceType: emoji.resourceType,
        localId: id,
        createdAt: now,
      }, 45_000);
      setMessageMap((current) => ({ ...current, [chatId]: (current[chatId] ?? []).map((item) => item.id === id ? { ...item, status: "sent" } : item) }));
      window.setTimeout(() => void loadLiveChats(), 700);
    } catch (error) {
      const uncertain = error instanceof EngineRequestError && error.code === "TIMEOUT";
      setMessageMap((current) => ({ ...current, [chatId]: (current[chatId] ?? []).map((item) => item.id === id ? { ...item, status: uncertain ? "unknown" : "error" } : item) }));
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleFlexAction(action: FlexAction) {
    const type = String(action.type ?? "").toLowerCase();
    if (type === "message") {
      const text = typeof action.text === "string" ? action.text.trim() : "";
      if (text) void sendMessage(text);
      return;
    }
    if (type !== "uri") return;
    const desktopUri = action.altUri && typeof action.altUri === "object" && !Array.isArray(action.altUri)
      ? (action.altUri as Record<string, unknown>).desktop
      : undefined;
    const primaryUri = typeof action.uri === "string" ? action.uri : "";
    const raw = typeof desktopUri === "string" && /^https?:/i.test(desktopUri)
      ? desktopUri
      : primaryUri || (typeof desktopUri === "string" ? desktopUri : "");
    try {
      const url = new URL(raw);
      if (!["https:", "http:", "line:", "mailto:", "tel:"].includes(url.protocol)) throw new Error("unsupported link protocol");
      if (lineyEngine.isNative) {
        void invoke("open_external_url", { url: url.toString() })
          .catch((error) => setAuthError(`เปิดลิงก์ไม่ได้: ${error instanceof Error ? error.message : String(error)}`));
      } else {
        window.open(url.toString(), "_blank", "noopener,noreferrer");
      }
    } catch {
      setAuthError("ลิงก์ใน Flex Message ไม่ปลอดภัยหรือไม่ถูกต้อง");
    }
  }

  function openOfficialLineMessage(message: Message) {
    if (!activeChat.id || activeChat.id === "__liney__" || !message.id) return;
    const url = message.officialClientUrl || officialLineMessageUrl(activeChat.id, message.id);
    if (lineyEngine.isNative) {
      void invoke("open_external_url", { url }).catch((error) => {
        setAuthError(`เปิดข้อความใน LINE ทางการไม่ได้: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function retryMessage(localId: string, chatId: string) {
    setMessageMap((current) => ({
      ...current,
      [chatId]: (current[chatId] ?? []).map((item) => item.id === localId ? { ...item, status: "sending", sendError: undefined } : item),
    }));
    try {
      await lineyEngine.request("message.retry", { localId }, 60_000);
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === localId ? { ...item, status: "sent" } : item),
      }));
    } catch (error) {
      const uncertain = error instanceof EngineRequestError && error.code === "TIMEOUT";
      const sendError = formatSendError(error instanceof Error ? error.message : String(error));
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === localId
          ? { ...item, status: uncertain ? "unknown" : "error", sendError }
          : item),
      }));
      setAuthError(sendError);
    }
  }

  async function reactMessage(message: Message, type: number) {
    if (!authenticated || activeChat.id === "__liney__") return;
    const chatId = activeChat.id;
    const kind = activeChat.kind === "openchat" ? "openchat" : "talk";
    const previous = message.reactions;
    const selected = previous?.find((item) => item.mine)?.type;
    const effectiveType = selected === type && type !== 1 ? 1 : type;
    setMessageMap((current) => ({
      ...current,
      [chatId]: (current[chatId] ?? []).map((item) => item.id === message.id
        ? { ...item, reactions: optimisticReactions(previous, effectiveType) }
        : item),
    }));
    try {
      await lineyEngine.request("message.react", {
        chatId,
        kind,
        messageId: message.id,
        reaction: effectiveType,
      }, 45_000);
    } catch (error) {
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === message.id ? { ...item, reactions: previous } : item),
      }));
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  function beginReply(message: Message) {
    if (message.unsent) return;
    setReplyTarget({
      id: message.id,
      text: message.text || (message.contentType ? mediaLabel(message.contentType, message.filename ?? "") : "ข้อความ"),
      author: message.author,
      ...(message.senderName ? { senderName: message.senderName } : {}),
    });
  }

  async function deleteMessageForMe(message: Message) {
    if (!authenticated || activeChat.id === "__liney__") return;
    if (!window.confirm("ลบข้อความนี้เฉพาะคุณหรือไม่\nข้อความจะยังอยู่ใน LINE ของคนอื่น")) return;
    const chatId = activeChat.id;
    const kind = activeChat.kind === "openchat" ? "openchat" : "talk";
    try {
      await lineyEngine.request("message.delete_for_me", {
        chatId,
        kind,
        messageId: message.id,
      }, 30_000);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function unsendMessage(message: Message) {
    if (!authenticated || activeChat.id === "__liney__" || message.author !== "me" || message.unsent) return;
    if (!window.confirm("ยกเลิกข้อความนี้สำหรับทุกคนหรือไม่")) return;
    const chatId = activeChat.id;
    const kind = activeChat.kind === "openchat" ? "openchat" : "talk";
    try {
      await lineyEngine.request("message.unsend", {
        chatId,
        kind,
        messageId: message.id,
      }, 30_000);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendImage(file: File | null, selectedPath?: string) {
    if (!authenticated || activeChat.id === "__liney__") {
      setAuthOpen(true);
      return;
    }
    if (activeChat.kind === "openchat" && replyTarget) {
      // LINEJS documents that OpenChat media is created by OBS reqseq mode,
      // which has no relatedMessageId slot. Do not silently drop the reply.
      setAuthError("OpenChat ยังตอบกลับด้วยรูป/วิดีโอ/ไฟล์ไม่ได้ผ่าน LINE protocol ตอนนี้ — ยกเลิกการตอบกลับก่อนส่งสื่อ");
      return;
    }
    const filePath = selectedPath || (file as (File & { path?: string }) | null)?.path;
    const filename = file?.name || selectedPath?.split(/[\\/]/).at(-1) || defaultMediaFilename(file?.type);
    const mime = file?.type || mimeFromFilename(filename);
    if (file && file.size > 25 * 1024 * 1024) {
      setAuthError("ไฟล์ใหญ่เกิน 25 MB");
      return;
    }
    if (!file && !filePath) {
      setAuthError("ไม่พบไฟล์รูปภาพ");
      return;
    }
    const id = crypto.randomUUID();
    const contentType = mediaContentTypeForMime(mime);
    const previewUrl = file && contentType === 1 ? URL.createObjectURL(file) : "";
    let base64 = "";
    try {
      base64 = filePath ? "" : (await fileToDataUrl(file!)).split(",", 2)[1] ?? "";
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
      return;
    }
    const now = Date.now();
    const chatId = activeChat.id;
    const chatKind = activeChat.kind;
    const reply = chatKind === "openchat" ? null : replyTarget;
    const message: Message = {
      id,
      author: "me",
      ...(previewUrl ? { image: previewUrl } : {}),
      ...(!previewUrl ? { text: contentType === 1 ? "กำลังโหลดรูป…" : mediaLabel(contentType, filename) } : {}),
      filename,
      time: formatTime(now),
      createdTime: now,
      contentType,
      ...(reply ? { replyTo: reply, replyToId: reply.id } : {}),
      status: "sending",
    };
    setMessageMap((current) => ({ ...current, [chatId]: [...(current[chatId] ?? []), message] }));
    setLiveChats((current) => current?.map((chat) => chat.id === chatId
      ? { ...chat, subtitle: mediaLabel(contentType, filename), time: formatListTime(now), lastMessageTime: now, unread: undefined, historyState: "available" }
      : chat) ?? current);
    setReplyTarget(null);
    try {
      await lineyEngine.request("media.send", {
        chatId,
        kind: chatKind === "openchat" ? "openchat" : "talk",
        jobId: id,
        localId: id,
        createdAt: now,
        filename,
        mime,
        contentType,
        ...(reply ? { relatedMessageId: reply.id } : {}),
        ...(filePath ? { filePath } : { base64 }),
      }, 90_000);
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === id ? { ...item, status: "sent" } : item),
      }));
      window.setTimeout(() => void loadLiveChats(), 700);
    } catch (error) {
      const uncertain = error instanceof EngineRequestError && error.code === "TIMEOUT";
      const sendError = formatSendError(error instanceof Error ? error.message : String(error));
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === id
          ? { ...item, status: uncertain ? "unknown" : "error", sendError }
          : item),
      }));
      setAuthError(sendError);
    }
  }

  async function pasteNativeClipboardImage(showError = true) {
    try {
      const result = await invoke<NativeClipboardImageResult>("read_clipboard_image");
      if (!result?.base64) {
        if (showError) setAuthError("ไม่พบรูปภาพใน clipboard");
        return;
      }
      const binary = atob(result.base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const mime = result.mime || "image/png";
      const filename = result.filename || defaultMediaFilename(mime);
      await sendImage(new File([bytes], filename, { type: mime }));
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function pickImage() {
    if (!lineyEngine.isNative) return;
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
      });
      if (typeof selected === "string") await sendImage(null, selected);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function cancelMedia(localId: string) {
    try {
      const result = await lineyEngine.request<{ cancelled?: boolean }>("media.cancel", { jobId: localId }, 10_000);
      if (!result?.cancelled) return;
      setMessageMap((current) => {
        const chatId = Object.keys(current).find((key) => current[key]?.some((item) => item.id === localId));
        if (!chatId) return current;
        return {
          ...current,
          [chatId]: current[chatId].map((item) => item.id === localId ? { ...item, status: "error" } : item),
        };
      });
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function logout() {
    try {
      await lineyEngine.request("auth.logout", {}, 15_000);
    } finally {
      liveChatsLoadGenerationRef.current += 1;
      liveFriendsLoadGenerationRef.current += 1;
      liveChatsRef.current = null;
      liveFriendsRef.current = null;
      authenticatedRef.current = false;
      liveChatEventGenerationRef.current.clear();
      setAuthenticated(false);
      setLiveChats([]);
      setProfile(null);
      setMessageMap({});
      setMediaProgress({});
      setReplyTarget(null);
      setActiveChatId("");
      setMobileConversationOpen(false);
      setAuthOpen(false);
    }
  }

  async function startCall(kind: "AUDIO" | "VIDEO" = "AUDIO") {
    if (!authenticated || activeChat.id === "__liney__") {
      setAuthOpen(true);
      return;
    }
    if (!callAvailable || activeChat.kind !== "dm") {
      setCallPeer(activeChat.id);
      setCallState("failed");
      setCallError(callReason || "สายเสียง 1:1 ยังไม่พร้อมบนระบบนี้");
      setCallOpen(true);
      return;
    }
    setCallPeer(activeChat.id);
    setCallMode(kind);
    setCallDirection("outgoing");
    setCallState("acquiring");
    setCallError("");
    setCallMuted(false);
    setCallVideoCapable(false);
    setCallVideoEnabled(false);
    setCallScreenSharing(false);
    setCallRemoteVideoFrame("");
    setCallOpen(true);
    try {
      const result = await lineyEngine.request<{ callId?: string; state?: CallState; videoCapable?: boolean }>(
        "call.start",
        { peer: activeChat.id, kind },
        80_000,
      );
      setCallId(String(result?.callId ?? ""));
      setCallVideoCapable(Boolean(result?.videoCapable));
      setCallState(result?.state ?? "in-call");
      if (kind === "VIDEO" && !result?.videoCapable) {
        setCallError("LINE ยังไม่ได้เปิดช่องวิดีโอสำหรับสายนี้ · ใช้เสียงได้ แต่เปิดกล้องหรือแชร์จอไม่ได้");
      }
    } catch (error) {
      setCallState("failed");
      setCallError(error instanceof Error ? error.message : String(error));
    }
  }

  async function acceptCall(mode: "AUDIO" | "VIDEO" = "AUDIO") {
    setCallMode(mode);
    setCallError("");
    setCallState("connecting");
    setCallRemoteVideoFrame("");
    try {
      const result = await lineyEngine.request<{ callId?: string; state?: CallState; videoCapable?: boolean }>(
        "call.accept",
        { mode },
        60_000,
      );
      if (result?.callId) setCallId(result.callId);
      setCallVideoCapable(Boolean(result?.videoCapable));
      setCallVideoEnabled(false);
      setCallScreenSharing(false);
      setCallState(result?.state ?? "in-call");
      if (mode === "VIDEO" && !result?.videoCapable) {
        setCallError("LINE ยังไม่ได้เปิดช่องวิดีโอสำหรับสายนี้ · ใช้เสียงได้ แต่เปิดกล้องหรือแชร์จอไม่ได้");
      }
    } catch (error) {
      setCallState("failed");
      setCallError(error instanceof Error ? error.message : String(error));
    }
  }

  async function toggleCallVideo() {
    const next = !callVideoEnabled;
    try {
      const result = await lineyEngine.request<{
        enabled?: boolean;
        videoCapable?: boolean;
        cameraAvailable?: boolean;
        reason?: string;
        message?: string;
      }>(
        "call.setVideo",
        { enabled: next },
        15_000,
      );
      setCallVideoCapable(Boolean(result?.videoCapable));
      setCallCameraAvailable(Boolean(result?.cameraAvailable));
      setCallVideoEnabled(Boolean(result?.enabled));
      if (result?.enabled) {
        setCallScreenSharing(false);
        setCallError("");
      } else if (next && result?.reason === "no-camera") {
        setCallError("ไม่พบกล้อง · วิดีโอคอลยังใช้งานได้ แต่เปิดกล้องไม่ได้");
      } else if (next && result?.reason === "camera-capture-failed") {
        setCallError("เปิดกล้องไม่สำเร็จ · " + (result.message || "ตรวจสิทธิ์ใช้งานกล้องหรือปิดแอปอื่นที่กำลังใช้กล้อง"));
      } else if (next && result?.reason === "native-backend-missing") {
        setCallError("ไม่พบตัวจับภาพกล้องของ Liney · ติดตั้ง build ล่าสุดแล้วเปิดใหม่");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCallError(/video was not negotiated/i.test(message)
        ? "สายเสียงยังไม่มีช่องวิดีโอ · เปลี่ยนเป็นวิดีโอคอลก่อนแล้วลองอีกครั้ง"
        : "เปิดกล้องไม่สำเร็จ · " + message);
    }
  }

  async function toggleScreenShare() {
    const next = !callScreenSharing;
    try {
      const result = await lineyEngine.request<{
        enabled?: boolean;
        videoCapable?: boolean;
        screenShareAvailable?: boolean;
        target?: string;
        reason?: string;
      }>(
        "call.setScreenShare",
        {
          enabled: next,
          ...(next && callScreenTargets.length ? { target: callScreenTarget } : {}),
        },
        130_000,
      );
      setCallVideoCapable(Boolean(result?.videoCapable));
      setCallScreenShareAvailable(Boolean(result?.screenShareAvailable));
      setCallScreenSharing(Boolean(result?.enabled));
      if (result?.target) setCallScreenTarget(result.target);
      if (result?.enabled) {
        setCallVideoEnabled(false);
        setCallError("");
      } else if (next && result?.reason === "screen-share-backend") {
        setCallError("ระบบจับภาพหน้าจอไม่พร้อม · ตรวจสิทธิ์ Screen Capture ของเดสก์ท็อปแล้วลองใหม่");
      } else if (next && result?.reason === "screen-share-target") {
        setCallError("เป้าหมายที่เลือกใช้ไม่ได้แล้ว · เลือกหน้าจอหรือหน้าต่างใหม่แล้วลองอีกครั้ง");
      } else if (next && result?.reason === "screen-share-cancelled") {
        setCallError("ยกเลิกการเลือกหน้าจอแล้ว");
      } else if (next && result?.reason === "screen-share-failed") {
        setCallError("เริ่มแชร์หน้าจอไม่สำเร็จ · อนุญาตการจับภาพในหน้าต่างระบบแล้วลองอีกครั้ง");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCallError(/video was not negotiated/i.test(message)
        ? "สายเสียงยังไม่มีช่องวิดีโอ · เปลี่ยนเป็นวิดีโอคอลก่อนแล้วลองอีกครั้ง"
        : "แชร์หน้าจอไม่สำเร็จ · " + message);
    }
  }

  async function upgradeCallToVideo() {
    if (!callPeer || callState !== "in-call" || callMode === "VIDEO") return;
    const confirmed = window.confirm(
      "การเปิดกล้องหรือแชร์จอต้องเริ่มเป็นวิดีโอคอล สายเสียงปัจจุบันจะถูกวางและโทรหาอีกครั้ง ต้องการดำเนินการต่อไหม?",
    );
    if (!confirmed) return;

    const peer = callPeer;
    const previousDirection = callDirection;
    videoUpgradeInProgressRef.current = true;
    setCallMode("VIDEO");
    setCallState("connecting");
    setCallDirection("outgoing");
    setCallError("");
    setCallVideoCapable(false);
    setCallVideoEnabled(false);
    setCallScreenSharing(false);
    try {
      await lineyEngine.request("call.end", {}, 20_000);
    } catch (error) {
      videoUpgradeInProgressRef.current = false;
      setCallMode("AUDIO");
      setCallState("in-call");
      setCallDirection(previousDirection);
      setCallError("วางสายเสียงเพื่อเริ่มวิดีโอคอลไม่สำเร็จ · " + (error instanceof Error ? error.message : String(error)));
      return;
    }

    try {
      const result = await lineyEngine.request<{ callId?: string; state?: CallState; videoCapable?: boolean }>(
        "call.start",
        { peer, kind: "VIDEO" },
        80_000,
      );
      if (result?.callId) setCallId(result.callId);
      setCallVideoCapable(Boolean(result?.videoCapable));
      setCallState(result?.state ?? "in-call");
      if (!result?.videoCapable) {
        setCallError("LINE ยังไม่ได้เปิดช่องวิดีโอสำหรับสายนี้ · ใช้เสียงได้ แต่เปิดกล้องหรือแชร์จอไม่ได้");
      }
    } catch (error) {
      setCallState("failed");
      setCallError(error instanceof Error ? error.message : String(error));
    } finally {
      videoUpgradeInProgressRef.current = false;
    }
  }

  async function rejectCall() {
    try { await lineyEngine.request("call.reject", {}, 15_000); }
    catch (error) { setCallError(error instanceof Error ? error.message : String(error)); }
    setCallOpen(false);
    setCallState("ended");
    setCallDirection(null);
  }

  async function changeCallOutput(target: string) {
    const previous = callOutputTarget;
    setCallOutputTarget(target);
    try {
      const result = await lineyEngine.request<{ target?: string }>("call.setOutput", { target }, 8_000);
      setCallOutputTarget(String(result?.target ?? ""));
      setCallError("");
    } catch (error) {
      setCallOutputTarget(previous);
      setCallError(error instanceof Error ? error.message : String(error));
    }
  }

  async function endCall() {
    await lineyEngine.request("call.end", {}, 20_000).catch(() => undefined);
    setCallOpen(false);
    setCallState("ended");
    setCallDirection(null);
  }

  async function toggleCallMute() {
    if (!callMicrophoneAvailable) {
      setCallError("ไม่พบไมโครโฟน · ยังอยู่ในสายและฟังอีกฝั่งได้");
      return;
    }
    const muted = !callMuted;
    setCallMuted(muted);
    await lineyEngine.request("call.setMuted", { muted }, 10_000).catch((error) => {
      setCallMuted(!muted);
      setCallError(error instanceof Error ? error.message : String(error));
    });
  }

  function updateAppSettings(key: keyof AppSettings, value: boolean) {
    if (key === "openchat") settingsRef.current = { ...settingsRef.current, openchat: value };
    updateSetting(key, value);
    const selectedChat = [...(liveChatsRef.current ?? []), ...(liveFriendsRef.current ?? [])]
      .find((chat) => chat.id === activeChatRef.current);
    if (key === "openchat" && !value && selectedChat?.kind === "openchat") {
      const fallback = liveChatsRef.current?.find((chat) => chat.kind !== "openchat") ?? liveFriendsRef.current?.[0];
      setActiveChatId(fallback?.id ?? "");
    }
    if (key === "openchat" && value) void loadLiveChats();
  }

  async function clearLocalHistory() {
    if (typeof window !== "undefined" && !window.confirm("ล้างประวัติข้อความและ media cache ในเครื่องนี้หรือไม่?")) return;
    try {
      await lineyEngine.request("history.clear", {}, 20_000);
      setMessageMap({});
      setMediaProgress({});
      setAuthError("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearStickerCache() {
    if (typeof window !== "undefined" && !window.confirm("ล้างแคชรายการสติกเกอร์หรือไม่? ครั้งถัดไปจะดึงรายการที่คุณเป็นเจ้าของจาก LINE ใหม่")) return;
    try {
      await lineyEngine.request("sticker.cache.clear", {}, 10_000);
      setAuthError("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function startFullSync() {
    if (!authenticated) return;
    setAuthError("");
    try {
      await lineyEngine.request("sync.start", {}, 15 * 60_000);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function cancelFullSync() {
    let cancelled = false;
    try {
      const result = await lineyEngine.request<{ cancelled?: boolean }>("sync.cancel", {}, 10_000);
      cancelled = Boolean(result?.cancelled);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
    if (!cancelled) return;
    setSyncStatus("");
    setSyncProgress((current) => ({ ...current, visible: false }));
    void loadLiveChats();
    void loadLiveFriends();
  }

  async function openImageViewer(dataUrl: string) {
    if (!dataUrl || dataUrl === "food") return;
    const loadedImages = (getTimelineRooms()[activeChat.id] ?? [])
      .filter((message) => Boolean(message.image && message.image !== "food"))
      .map((message) => ({ id: message.id, src: message.image!, time: message.time }));
    const currentIndex = Math.max(0, loadedImages.findIndex((item) => item.src === dataUrl));
    const windowStart = Math.max(0, Math.min(currentIndex - 12, Math.max(0, loadedImages.length - 30)));
    const items = loadedImages.length
      ? loadedImages.slice(windowStart, windowStart + 30)
      : [{ id: `image-${Date.now()}`, src: dataUrl }];
    const payload: ImageGalleryPayload = {
      title: activeChat.name || "รูปภาพ",
      index: Math.max(0, items.findIndex((item) => item.src === dataUrl)),
      loop: settingsRef.current.loopImageGallery,
      items,
    };

    if (!lineyEngine.isNative || !settingsRef.current.openImagesInWindow) {
      setImageViewerSrc(dataUrl);
      return;
    }

    imageGalleryPayloadRef.current = payload;
    try {
      const existing = await WebviewWindow.getByLabel("image-viewer");
      if (existing) {
        await emitTo("image-viewer", "liney://image-gallery", payload);
        await existing.show();
        await existing.setFocus();
        return;
      }
      const viewer = new WebviewWindow("image-viewer", {
        url: "/?liney-view=image-viewer",
        title: `Liney · ${payload.title}`,
        width: 1120,
        height: 780,
        minWidth: 680,
        minHeight: 480,
        center: true,
        resizable: true,
      });
      viewer.once("tauri://created", () => { void viewer.setFocus(); });
      viewer.once("tauri://error", () => setImageViewerSrc(dataUrl));
    } catch {
      setImageViewerSrc(dataUrl);
    }
  }

  useEffect(() => {
    if (!lineyEngine.isNative) return;
    let unlisten: (() => void) | undefined;
    void listen("liney://image-viewer-ready", () => {
      const payload = imageGalleryPayloadRef.current;
      if (payload) void emitTo("image-viewer", "liney://image-gallery", payload);
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  const renderAuthDialog = (required: boolean) => (
    <AuthModal
      engineState={engineState}
      authenticated={authenticated}
      authMode={authMode}
      qrUrl={qrUrl}
      pin={pin}
      email={authEmail}
      password={authPassword}
      authBusy={authBusy}
      error={authError}
      profileName={profile?.displayName ?? ""}
      clientIdentity={clientIdentity}
      storageMode={storageMode}
      required={required}
      keyImportMode={keyImportMode}
      keyImportResult={keyImportResult}
      onBeginKeyImport={beginKeyImport}
      onImportKeys={startKeychainImport}
      onModeChange={(mode) => {
        if (authBusy) return;
        setAuthMode(mode);
        setQrUrl("");
        setPin("");
        setAuthError("");
        setAuthPassword("");
      }}
      onEmailChange={setAuthEmail}
      onPasswordChange={setAuthPassword}
      onStart={startQrLogin}
      onPasswordLogin={startPasswordLogin}
      onLogout={logout}
      onClose={() => {
        keyImportDialogOpenRef.current = false;
        setAuthOpen(false);
        setKeyImportMode(false);
        setKeyImportResult(null);
      }}
    />
  );

  if (usesEngineRuntime && !authenticated) {
    return <div className="auth-gate-shell">{renderAuthDialog(true)}</div>;
  }

  return (
    <div className={`app-shell ${mobileConversationOpen ? "mobile-conversation-open" : ""}`}>
      <NavRail section={section} onSection={(next) => { setSection(next); setListFilter("all"); setMobileConversationOpen(false); setReplyTarget(null); }} onNotifications={() => { setSection("messages"); setListFilter("unread"); setMobileConversationOpen(false); setReplyTarget(null); }} onSettings={() => { setSettingsInitialTab("ทั่วไป"); setSettingsOpen(true); }} onProfile={() => setAuthOpen(true)} authenticated={authenticated} openchatEnabled={settings.openchat} unreadCount={totalUnread} />
      <ChatList
        section={section}
        chats={visibleChats}
        activeId={activeChat.id}
        query={query}
        onQuery={setQuery}
        onSelect={selectChat}
        filter={listFilter}
        onFilter={setListFilter}
        onTogglePin={toggleLocalPin}
        mergeCandidates={allChats.filter((chat) => chat.kind === "dm")}
        onMerge={mergeDuplicateChats}
        onCreate={() => setNewChatOpen(true)}
        unreadChatCount={unreadChatCount}
        canMarkAllRead={authenticated}
        markAllReadBusy={markAllReadBusy}
        markAllReadProgress={markAllReadProgress}
        onMarkAllRead={markAllUnreadChats}
      />
      <TimelineConversation
        chat={activeChat}
        emptyFallback={activeTimelineEmptyFallback}
        onRetryHistory={() => {
          forcedHistoryRefreshRef.current.add(activeChat.id);
          setMessageRefreshNonce((value) => value + 1);
        }}
        onMergeHistory={(sourceMid, targetMid) => mergeDuplicateChats(sourceMid, targetMid)}
        composer={composer}
        onComposer={setComposer}
        onSend={sendMessage}
        onSendSticker={sendSticker}
        onSendEmoji={sendLineEmoji}
        onFlexAction={handleFlexAction}
        onViewImage={(src) => void openImageViewer(src)}
        onImage={sendImage}
        onNativeImage={pasteNativeClipboardImage}
        onPickImage={pickImage}
        onRetry={(id) => void retryMessage(id, activeChat.id)}
        mediaProgress={mediaProgress}
        onCancelMedia={(id) => void cancelMedia(id)}
        onReact={(message, type) => void reactMessage(message, type)}
        onReply={beginReply}
        onDeleteForMe={(message) => void deleteMessageForMe(message)}
        onUnsend={(message) => void unsendMessage(message)}
        onOpenOfficialMessage={openOfficialLineMessage}
        replyTarget={replyTarget}
        onCancelReply={() => setReplyTarget(null)}
        onBack={() => { setMobileConversationOpen(false); setReplyTarget(null); }}
         canSend={authenticated && activeChat.id !== "__liney__"}
        callAvailable={callAvailable && activeChat.kind === "dm"}
          onCall={() => void startCall("AUDIO")}
          onVideoCall={() => void startCall("VIDEO")}
        albumsAvailable={lineyEngine.isNative && authenticated && activeChat.kind !== "openchat"}
        onAlbums={() => setAlbumsOpen(true)}
        notesAvailable={lineyEngine.isNative && authenticated && /^[cs][a-f0-9]{30,}$/i.test(activeChat.id)}
        onNotes={() => setNotesRoom({ id: activeChat.id, title: activeChat.name })}
        manageAvailable={lineyEngine.isNative && authenticated && ((activeChat.kind === "group" && /^c[a-f0-9]{32}$/i.test(activeChat.id)) || (activeChat.kind === "dm" && /^u[a-f0-9]{32}$/i.test(activeChat.id)))}
        onManage={() => setManagedChat(activeChat)}
        windowActive={windowActive}
        markReadOnBottom={settings.markReadOnBottom}
        showUnreadDivider={settings.showUnreadDivider}
        autoScrollNewMessages={settings.autoScrollNewMessages}
        showReadCount={settings.showReadCount}
        developerFlexRaw={settings.developerFlexRaw}
        onReadLatest={(lastMessageId, lastMessageTime) => void markChatReadAtBottom(activeChat, lastMessageId, lastMessageTime)}
        onLoadOlder={(before) => loadOlderTimelineMessages(activeChat, before)}
        jumpToMessageId={notificationJump?.chatId === activeChat.id ? notificationJump.messageId : undefined}
        jumpNonce={notificationJump?.chatId === activeChat.id ? notificationJump.nonce : 0}
      />
      <EnginePill state={engineState} version={engineVersion} authenticated={authenticated} syncStatus={syncStatus} onClick={() => setAuthOpen(true)} />

      <AnimatePresence>
        {newChatOpen && (
          <NewChatModal
            friends={allFriends}
            onStartChat={startDirectChat}
            onAddFriend={addFriendByLineId}
            onCreateGroup={createGroupChat}
            onCreateOpenChat={createOpenChatRoom}
            onClose={() => setNewChatOpen(false)}
          />
        )}
        {imageViewerSrc && <ImageViewerOverlay src={imageViewerSrc} onClose={() => setImageViewerSrc(null)} />}
        {albumsOpen && <LineAlbumsModal onClose={() => setAlbumsOpen(false)} />}
        {notesRoom && <LineNotesModal homeId={notesRoom.id} title={notesRoom.title} onClose={() => setNotesRoom(null)} />}
        {managedChat && (managedChat.kind === "dm" || managedChat.kind === "group") && <LineChatManageModal room={{ id: managedChat.id, kind: managedChat.kind, name: managedChat.name }} friends={allFriends} onClose={() => setManagedChat(null)} />}
        {settingsOpen && <SettingsModal initialTab={settingsInitialTab} themeMode={themeMode} dark={dark} settings={settings} callAvailable={callAvailable} onThemeMode={setThemeMode} onSetting={updateAppSettings} onDensity={(value) => updateSetting("density", value)} onRadius={(value) => updateSetting("radius", value)} onClearHistory={() => void clearLocalHistory()} onClearStickerCache={() => void clearStickerCache()} onFullSync={() => void startFullSync()} onProfileChange={setProfile} onClose={() => setSettingsOpen(false)} />}
        {callOpen && <CallModal chat={callChat} peer={callPeer} remoteVideoFrame={callRemoteVideoFrame} state={callState} muted={callMuted} microphoneAvailable={callMicrophoneAvailable} speakerAvailable={callSpeakerAvailable} videoCapable={callVideoCapable} videoEnabled={callVideoEnabled} cameraAvailable={callCameraAvailable} screenSharing={callScreenSharing} screenShareAvailable={callScreenShareAvailable} screenTargets={callScreenTargets} screenTarget={callScreenTarget} screenManagedBySystem={callScreenManagedBySystem} error={callError} incomingSupported={callIncomingAvailable} outputDevices={callOutputs} outputTarget={callOutputTarget} onAccept={() => void acceptCall("AUDIO")} onAcceptVideo={() => void acceptCall("VIDEO")} onReject={() => void rejectCall()} onMute={() => void toggleCallMute()} onVideo={() => void toggleCallVideo()} onScreenShare={() => void toggleScreenShare()} onUpgradeVideo={() => void upgradeCallToVideo()} mode={callMode} onScreenTarget={setCallScreenTarget} onOutput={(target) => void changeCallOutput(target)} onClose={() => void endCall()} />}
        {usesEngineRuntime && authenticated && syncProgress.visible && (
          <FullSyncPopup
            progress={syncProgress}
            onCancel={() => void cancelFullSync()}
            onRetry={() => {
              setSyncProgress({ visible: true, phase: "metadata", done: 0, total: 0, failed: 0 });
              void startFullSync();
            }}
            onClose={() => setSyncProgress((current) => ({ ...current, visible: false }))}
          />
        )}
        {authOpen && renderAuthDialog(false)}
      </AnimatePresence>
    </div>
  );
}

function DetachedImageViewer() {
  const [gallery, setGallery] = useState<ImageGalleryPayload | null>(null);
  const [index, setIndex] = useState(0);
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ImageGalleryPayload>("liney://image-gallery", (event) => {
      const payload = event.payload;
      if (!payload?.items?.length) return;
      setGallery(payload);
      setIndex(Math.min(Math.max(0, payload.index ?? 0), payload.items.length - 1));
      document.title = `Liney · ${payload.title || "รูปภาพ"}`;
    }).then((fn) => {
      unlisten = fn;
      void emitTo("main", "liney://image-viewer-ready");
    });
    return () => unlisten?.();
  }, []);

  const move = useCallback((delta: number) => {
    if (!gallery?.items.length) return;
    setImageState("loading");
    setIndex((current) => {
      const next = current + delta;
      if (gallery.loop) return (next + gallery.items.length) % gallery.items.length;
      return Math.min(Math.max(next, 0), gallery.items.length - 1);
    });
  }, [gallery]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") move(-1);
      else if (event.key === "ArrowRight") move(1);
      else if (event.key === "Escape") void getCurrentWindow().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  if (!gallery?.items.length) {
    return <main className="detached-image-viewer loading"><LoaderCircle className="spin" size={24} /><span>กำลังเปิดรูปภาพ…</span></main>;
  }
  const item = gallery.items[index];
  const hasPrevious = gallery.loop || index > 0;
  const hasNext = gallery.loop || index < gallery.items.length - 1;
  return (
    <main className="detached-image-viewer">
      <header className="detached-image-header">
        <div><strong>{gallery.title}</strong><span>{index + 1} / {gallery.items.length}{item.time ? ` · ${item.time}` : ""}</span></div>
        <button className="icon-button" type="button" title="ปิด" onClick={() => void getCurrentWindow().close()}><X size={19} /></button>
      </header>
      <section className="detached-image-stage">
        <button className="gallery-nav previous" type="button" aria-label="รูปก่อนหน้า" disabled={!hasPrevious} onClick={() => move(-1)}><ArrowLeft size={24} /></button>
        <img
          key={item.id}
          className="detached-image-main"
          src={item.src}
          alt="รูปภาพ"
          draggable={false}
          onLoad={() => setImageState("ready")}
          onError={() => setImageState("error")}
        />
        {imageState === "loading" ? <span className="detached-image-status">กำลังโหลดรูปภาพ…</span> : null}
        {imageState === "error" ? <span className="detached-image-status error">โหลดรูปภาพหลักไม่สำเร็จ</span> : null}
        <button className="gallery-nav next" type="button" aria-label="รูปถัดไป" disabled={!hasNext} onClick={() => move(1)}><ArrowLeft size={24} /></button>
      </section>
      <footer className="detached-image-strip">
        {gallery.items.map((thumb, thumbIndex) => (
          <button key={thumb.id} className={thumbIndex === index ? "active" : ""} type="button" onClick={() => { setImageState("loading"); setIndex(thumbIndex); }}><img src={thumb.src} alt="" loading="lazy" /></button>
        ))}
      </footer>
    </main>
  );
}


function NavRail({ section, onSection, onNotifications, onSettings, onProfile, authenticated, openchatEnabled, unreadCount }: { section: Section; onSection: (s: Section) => void; onNotifications: () => void; onSettings: () => void; onProfile: () => void; authenticated: boolean; openchatEnabled: boolean; unreadCount: number }) {
  return (
    <aside className="nav-rail" aria-label="เมนูหลัก Liney">
      <button className={`brand-orb ${authenticated ? "connected" : ""}`} aria-label="Liney account" onClick={onProfile}>
        <img className="brand-logo-mark" src="/liney-logo.png" alt="" />
        {authenticated ? <span className="brand-connected-dot" /> : null}
      </button>
      <div className="nav-stack">
        {navItems.filter((item) => item.id !== "openchat" || openchatEnabled).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={`rail-button ${section === item.id ? "active" : ""}`}
              onClick={() => onSection(item.id)}
              title={item.label}
              aria-label={item.label}
              aria-current={section === item.id ? "page" : undefined}
            >
              <Icon size={20} strokeWidth={1.9} />
              <span className="rail-tooltip">{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="nav-bottom">
        <button className="rail-button" onClick={onNotifications} title={unreadCount ? `ยังไม่อ่าน ${unreadCount} ข้อความ` : "ไม่มีข้อความที่ยังไม่อ่าน"}>
          <Bell size={19} />
          {unreadCount > 0 ? <span className="nav-unread-badge">{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
          <span className="rail-tooltip">ยังไม่อ่าน</span>
        </button>
        <button className="rail-button" onClick={onSettings} title="ตั้งค่า">
          <Settings size={19} />
          <span className="rail-tooltip">ตั้งค่า</span>
        </button>
      </div>
    </aside>
  );
}

function ChatList({
  section,
  chats,
  activeId,
  query,
  onQuery,
  onSelect,
  filter,
  onFilter,
  onTogglePin,
  mergeCandidates,
  onMerge,
  onCreate,
  unreadChatCount,
  canMarkAllRead,
  markAllReadBusy,
  markAllReadProgress,
  onMarkAllRead,
}: {
  section: Section;
  chats: Chat[];
  activeId: string;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (id: string) => void;
  filter: "all" | "unread" | "pinned" | "favorites";
  onFilter: (filter: "all" | "unread" | "pinned" | "favorites") => void;
  onTogglePin: (id: string) => void;
  mergeCandidates: Chat[];
  onMerge: (aliasMid: string, canonicalMid: string) => Promise<void>;
  onCreate: () => void;
  unreadChatCount: number;
  canMarkAllRead: boolean;
  markAllReadBusy: boolean;
  markAllReadProgress: { done: number; total: number } | null;
  onMarkAllRead: () => Promise<{ total: number; marked: number; failed: number }>;
}) {
  const [contextMenu, setContextMenu] = useState<{ chat: Chat; x: number; y: number } | null>(null);
  const [mergeDialogChat, setMergeDialogChat] = useState<Chat | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const [readAllFeedback, setReadAllFeedback] = useState("");
  const [showUnresolvedArchives, setShowUnresolvedArchives] = useState(false);
  const [filterMoreOpen, setFilterMoreOpen] = useState(false);
  const filterMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filterMoreOpen) return;
    const onOutside = (event: PointerEvent) => {
      if (!filterMoreRef.current?.contains(event.target as Node)) setFilterMoreOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterMoreOpen(false);
    };
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [filterMoreOpen]);
  const unresolvedArchives = useMemo(
    () => section === "messages" ? chats.filter(isUnresolvedGroupArchive) : [],
    [chats, section],
  );
  // Keep all archived rooms accessible under one explicit control. Never
  // delete them or silently exclude them from searches, unread or favorites.
  const visibleChats = useMemo(() =>
    section === "messages" && filter === "all" && !query.trim() && !showUnresolvedArchives
      ? chats.filter((chat) => !isUnresolvedGroupArchive(chat) || chat.unread || chat.pinned || chat.isFavorite)
      : chats,
    [chats, section, filter, query, showUnresolvedArchives],
  );
  async function handleMarkAllRead() {
    setReadAllFeedback("");
    const result = await onMarkAllRead();
    if (!result.total) return;
    setReadAllFeedback(result.failed
      ? "อ่านแล้ว " + result.marked + " ห้อง · ค้าง " + result.failed + " ห้อง"
      : "อ่านแล้ว " + result.marked + " ห้อง");
  }
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);
  const title = section === "openchat" ? "OpenChat" : section === "friends" ? "เพื่อน" : section === "calls" ? "ประวัติการโทร" : "แชต";
  // Virtualize the full list instead of silently dropping contacts past 120.
  // Rows are measured in the same scroll container that owns the sidebar.
  const chatItemsRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      if (document.querySelector(".settings-modal, .new-chat-modal, .auth-modal, .identity-merge-dialog")) return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  const chatListVirtualizer = useVirtualizer({
    count: visibleChats.length,
    getScrollElement: () => chatItemsRef.current,
    estimateSize: () => 68,
    overscan: 7,
    getItemKey: (index) => visibleChats[index]?.id ?? index,
  });
  useEffect(() => {
    if (chatItemsRef.current) chatItemsRef.current.scrollTop = 0;
  }, [section, filter, query]);
  return (
    <section className="chat-list-panel">
      <header className="list-header">
        <div className="list-heading">
          <p className="eyebrow">LINEY</p>
          <div className="list-heading-title">
            <h1>{title}</h1>
            {unreadChatCount > 0 && section === "messages" ? <span className="list-unread-count" title={unreadChatCount + " ห้องยังไม่อ่าน"}>{unreadChatCount > 99 ? "99+" : unreadChatCount}</span> : null}
          </div>
          {readAllFeedback && !markAllReadBusy ? <span className="mark-all-read-status" role="status" aria-live="polite">{readAllFeedback}</span> : null}
        </div>
        <div className="list-heading-actions">
          {(section === "messages" || section === "openchat") && unreadChatCount > 0 ? (
            <button className="icon-button list-mark-read" type="button" disabled={!canMarkAllRead || markAllReadBusy}
              onClick={() => void handleMarkAllRead()}
              title={markAllReadBusy && markAllReadProgress ? "กำลังอ่าน " + markAllReadProgress.done + "/" + markAllReadProgress.total : "ทำเครื่องหมายอ่านแล้วทุกห้อง"}
              aria-label="ทำเครื่องหมายอ่านแล้วทุกห้อง"
            >{markAllReadBusy ? <LoaderCircle size={19} className="spin" /> : <CheckCheck size={19} />}</button>
          ) : null}
          <button className="icon-button list-new-chat" type="button" onClick={onCreate} title="เริ่มแชตใหม่" aria-label="เริ่มแชตใหม่"><Plus size={20} /></button>
        </div>
      </header>
      <div className="search-box">
        <Search size={16} />
        <input ref={searchInputRef} value={query} onChange={(e) => onQuery(e.target.value)} placeholder="ค้นหาแชตหรือเพื่อน" aria-label="ค้นหาแชตหรือเพื่อน" />
        {query ? <button className="search-clear" type="button" title="ล้างคำค้นหา" aria-label="ล้างคำค้นหา" onClick={() => { onQuery(""); searchInputRef.current?.focus(); }}><X size={15} /></button> : <kbd>Ctrl K</kbd>}
      </div>
      <div className="list-filter-row" aria-label="กรองรายการ">
        <button type="button" className={`filter-chip ${filter === "all" ? "active" : ""}`} aria-pressed={filter === "all"} onClick={() => { onFilter("all"); setFilterMoreOpen(false); }}>ทั้งหมด</button>
        {section === "friends" ? (
          <button type="button" className={`filter-chip ${filter === "favorites" ? "active" : ""}`} aria-pressed={filter === "favorites"} onClick={() => { onFilter("favorites"); setFilterMoreOpen(false); }}><Star size={14} /> รายการโปรด</button>
        ) : (
          <>
            <button type="button" className={`filter-chip ${filter === "unread" ? "active" : ""}`} aria-pressed={filter === "unread"} onClick={() => { onFilter("unread"); setFilterMoreOpen(false); }}>ยังไม่อ่าน</button>
            <div className="filter-more" ref={filterMoreRef}>
              <button
                type="button"
                className={`filter-chip filter-more-trigger ${filter === "favorites" || filter === "pinned" || showUnresolvedArchives ? "active" : ""}`}
                onClick={() => setFilterMoreOpen((open) => !open)}
                aria-expanded={filterMoreOpen}
                aria-haspopup="menu"
                aria-label="ตัวกรองเพิ่มเติม"
              >
                {filter === "favorites" ? <Star size={14} /> : filter === "pinned" ? <PinIcon size={14} /> : <Ellipsis size={16} />}
                <span>{filter === "favorites" ? "รายการโปรด" : filter === "pinned" ? "ปักหมุด" : "เพิ่มเติม"}</span>
                <ChevronDown className="filter-more-chevron" size={13} />
              </button>
              {filterMoreOpen ? (
                <div className="filter-more-menu" role="menu" aria-label="เลือกตัวกรอง">
                  {section === "messages" ? <button role="menuitemradio" aria-checked={filter === "favorites"} type="button" onClick={() => { onFilter("favorites"); setFilterMoreOpen(false); }}><Star size={15} />รายการโปรด{filter === "favorites" ? <CheckCheck size={15} className="filter-checked" /> : null}</button> : null}
                  <button role="menuitemradio" aria-checked={filter === "pinned"} type="button" onClick={() => { onFilter("pinned"); setFilterMoreOpen(false); }}><PinIcon size={15} />ปักหมุด{filter === "pinned" ? <CheckCheck size={15} className="filter-checked" /> : null}</button>
                  {section === "messages" && !query.trim() && unresolvedArchives.length > 0 ? (
                    <button role="menuitemcheckbox" aria-checked={showUnresolvedArchives} type="button" onClick={() => { onFilter("all"); setShowUnresolvedArchives((shown) => !shown); setFilterMoreOpen(false); }}>
                      <Archive size={15} />{showUnresolvedArchives ? "ซ่อนกลุ่มเก่า" : `แสดงกลุ่มเก่า (${unresolvedArchives.length})`}
                      {showUnresolvedArchives ? <CheckCheck size={15} className="filter-checked" /> : null}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
      <div className="chat-items" ref={chatItemsRef}>
        <div className="chat-items-virtual" style={{ height: chatListVirtualizer.getTotalSize() }}>
        {chatListVirtualizer.getVirtualItems().map((virtualItem) => {
          const chat = visibleChats[virtualItem.index];
          return <button
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={chatListVirtualizer.measureElement}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualItem.start}px)` }}
            className={`chat-item ${activeId === chat.id ? "selected" : ""}`}
            onClick={() => onSelect(chat.id)}
            onContextMenu={(event) => {
              if (section === "friends" || section === "calls") return;
              event.preventDefault();
              setContextMenu({ chat, x: event.clientX, y: event.clientY });
            }}
          >
            <Avatar chat={chat} />
            <span className="chat-copy">
              <span className="chat-title-line">
                <strong>{chat.name}</strong>
                <span className="chat-title-flags">
                  {chat.isFavorite ? <Star size={12} className="favorite-icon" fill="currentColor" aria-label="รายการโปรด" /> : null}
                  {chat.pinned ? <PinIcon size={12} className="pin-icon" fill="currentColor" aria-label="ปักหมุด" /> : null}
                  <time>{chat.time}</time>
                </span>
              </span>
              <span className="chat-preview-line">
                <span className="chat-preview">{chat.subtitle}</span>
                {chat.unread ? <span className="unread-badge">{chat.unread > 99 ? "99+" : chat.unread}</span> : null}
              </span>
            </span>
          </button>;
        })}
        </div>
        {visibleChats.length === 0 && <div className="empty-list">ไม่พบรายการ</div>}
      </div>
      {contextMenu ? (
        <div
          className="chat-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            onClick={() => {
              onTogglePin(contextMenu.chat.id);
              setContextMenu(null);
            }}
          >
            <PinIcon size={15} fill={contextMenu.chat.pinned ? "currentColor" : "none"} />
            {contextMenu.chat.pinned ? "เลิกปักหมุด" : "ปักหมุด"}
          </button>
          {section === "messages" && contextMenu.chat.kind === "dm" ? (
            <button
              onClick={() => {
                const firstTarget = mergeCandidates.find((chat) => chat.id !== contextMenu.chat.id);
                setMergeTargetId(firstTarget?.id ?? "");
                setMergeError("");
                setMergeDialogChat(contextMenu.chat);
                setContextMenu(null);
              }}
            >
              <Link2 size={15} />
              รวมแชตที่ซ้ำ…
            </button>
          ) : null}
        </div>
      ) : null}
      {mergeDialogChat ? (
        <div className="modal-backdrop identity-merge-backdrop" onMouseDown={() => { if (!mergeBusy) setMergeDialogChat(null); }}>
          <section
            className="identity-merge-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="identity-merge-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="identity-merge-icon"><Link2 size={19} /></div>
            <h2 id="identity-merge-title">รวมแชตของบัญชีเดียวกัน</h2>
            <p className="identity-merge-description">
              เลือกแชตปลายทางที่จะเก็บชื่อและรูปโปรไฟล์ไว้ ประวัติข้อความจาก “{mergeDialogChat.name}” จะถูกรวมเข้าไปด้วย
            </p>
            <label className="identity-merge-label" htmlFor="identity-merge-target">เก็บข้อมูลไว้ที่</label>
            <select
              id="identity-merge-target"
              className="identity-merge-select"
              value={mergeTargetId}
              onChange={(event) => setMergeTargetId(event.target.value)}
              disabled={mergeBusy}
            >
              <option value="">เลือกแชตปลายทาง</option>
              {mergeCandidates.filter((chat) => chat.id !== mergeDialogChat.id).map((chat) => (
                <option key={chat.id} value={chat.id}>{chat.name}</option>
              ))}
            </select>
            <p className="identity-merge-note">
              Liney จะจำการเชื่อมนี้ในเครื่องนี้ เก็บชื่อและรูปของแชตปลายทาง รวมประวัติที่มีในเครื่อง และส่งข้อความครั้งต่อไปไปยังแชตปลายทางที่คุณเลือก
            </p>
            {mergeError ? <p className="identity-merge-error" role="alert">{mergeError}</p> : null}
            <div className="identity-merge-actions">
              <button type="button" className="secondary-button" disabled={mergeBusy} onClick={() => setMergeDialogChat(null)}>ยกเลิก</button>
              <button
                type="button"
                className="identity-merge-confirm"
                disabled={!mergeTargetId || mergeBusy || mergeCandidates.length < 2}
                onClick={() => {
                  if (!mergeDialogChat || !mergeTargetId) return;
                  setMergeBusy(true);
                  setMergeError("");
                  void onMerge(mergeDialogChat.id, mergeTargetId)
                    .then(() => setMergeDialogChat(null))
                    .catch((error) => setMergeError(error instanceof Error ? error.message : String(error)))
                    .finally(() => setMergeBusy(false));
                }}
              >
                {mergeBusy ? "กำลังรวม…" : "รวมแชต"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function Avatar({ chat, size = "normal" }: { chat: Chat; size?: "normal" | "large" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [chat.avatarUrl]);
  return (
    <span className={`avatar ${size === "large" ? "avatar-large" : ""}`} style={{ "--avatar-color": chat.accent } as React.CSSProperties}>
      {chat.avatarUrl && !failed ? (
        <RemoteImage
          src={chat.avatarUrl}
          alt={chat.name}
          loading="lazy"
          fallback={chat.avatar}
          onStatus={(status) => { if (status === "failed") setFailed(true); }}
        />
      ) : chat.avatar}
      {chat.kind === "openchat" ? <span className="openchat-mark"><Sparkles size={11} strokeWidth={2.5} /></span> : null}
    </span>
  );
}

function senderAccent(seed: string) {
  const palette = ["#5b8def", "#8b6fe8", "#e07b67", "#d69c42", "#3ba887", "#ce6f9b", "#6f8f3d"];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function MessageAvatar({ message, chat }: { message: Message; chat: Chat }) {
  const [failed, setFailed] = useState(false);
  const name = message.senderName || (chat.kind === "dm" ? chat.name : "LINE User");
  const url = message.senderAvatarUrl || (chat.kind === "dm" ? chat.avatarUrl : undefined);
  const fallback = initials(name);
  return (
    <span
      className="avatar message-sender-avatar"
      style={{ "--avatar-color": senderAccent(message.senderId || name) } as React.CSSProperties}
      title={name}
    >
      {url && !failed ? (
        <RemoteImage
          src={url}
          alt={name}
          loading="lazy"
          fallback={fallback}
          onStatus={(status) => { if (status === "failed") setFailed(true); }}
        />
      ) : fallback}
    </span>
  );
}

function MessageSenderLabel({ message, chat, onOpenOfficialMessage }: { message: Message; chat: Chat; onOpenOfficialMessage: (message: Message) => void }) {
  if (message.author !== "them" || chat.kind === "dm") return null;
  const name = String(message.senderName ?? "").trim() || "LINE User";
  return (
    <div className="message-sender-name">
      {message.isOfficialAccount ? (
        <button className="message-sender-link" type="button" title="เปิดข้อความนี้ใน LINE ทางการ" onClick={() => onOpenOfficialMessage(message)}>{name}</button>
      ) : name}
    </div>
  );
}

function CallHistoryCard({ data }: { data: NonNullable<Message["call"]> }) {
  return (
    <div className={`call-history-card call-history-${data.status}`} role="status">
      <span className="call-history-icon"><Phone size={17} /></span>
      <span className="call-history-copy">
        <strong>{callMessagePreview(data)}</strong>
        <span>โทรด้วยเสียงผ่าน LINE</span>
      </span>
    </div>
  );
}

function OfficialMessageFallback({ message, chat, onOpenOfficialMessage }: { message: Message; chat: Chat; onOpenOfficialMessage: (message: Message) => void }) {
  if (message.author === "me" || chat.kind === "openchat" || !message.isOfficialAccount) return null;
  return <button className="official-message-link" type="button" title="เปิดข้อความนี้ใน LINE ทางการ" onClick={() => onOpenOfficialMessage(message)}>เปิดข้อความใน LINE ทางการ</button>;
}

function stickerCandidateUrls(src: string): string[] {
  try {
    const url = new URL(src);
    const match = url.pathname.match(/^(.*\/sticker\/[^/]+)\/(android|ios|iPhone|ANDROID)\/(sticker(?:_animation)?(?:@2x)?\.png)$/i);
    if (!match) return [src];
    const base = `${url.origin}${match[1]}`;
    const preferred = match[3].includes("sticker_animation") ? "sticker_animation.png" : "sticker.png";
    const alternate = preferred === "sticker.png" ? "sticker_animation.png" : "sticker.png";
    return [...new Set([
      `android/${preferred}`,
      `ANDROID/${preferred}`,
      `iPhone/${preferred.replace(".png", "@2x.png")}`,
      `android/${alternate}`,
      `ANDROID/${alternate}`,
      `iPhone/${alternate.replace(".png", "@2x.png")}`,
    ].map((asset) => `${base}/${asset}`))];
  } catch {
    return [src];
  }
}

function stickerPackCoverCandidates(packageId: string): string[] {
  const base = `https://stickershop.line-scdn.net/stickershop/v1/product/${encodeURIComponent(packageId)}`;
  return [`${base}/android/main.png`, `${base}/ANDROID/main.png`, `${base}/android/tab_on.png`];
}

function isArrangedStickerUrl(src: string): boolean {
  try {
    return /\/sticker\/651698630\//.test(new URL(src).pathname);
  } catch {
    return false;
  }
}

function StickerImage({
  src,
  className = "message-sticker",
  fallback,
}: {
  src: string;
  className?: string;
  fallback?: React.ReactNode;
}) {
  const candidates = useMemo(() => stickerCandidateUrls(src), [src]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const imageSrc = candidates[candidateIndex] ?? src;

  if (isArrangedStickerUrl(src)) {
    return (
      <div className="sticker-unavailable" role="img" aria-label="สติกเกอร์จัดวางจาก LINE">
        <TriangleAlert size={18} />
        <div>
          <strong>สติกเกอร์จัดวางจาก LINE</strong>
          <span>LINE ไม่ได้ส่งภาพที่ประกอบจริงมาให้ไคลเอนต์นี้</span>
        </div>
      </div>
    );
  }

  if (failed) return fallback ?? <div className="bubble">สติกเกอร์</div>;
  return (
    <img
      className={className}
      src={imageSrc}
      alt="สติกเกอร์"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (candidateIndex + 1 < candidates.length) {
          setCandidateIndex((current) => current + 1);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}

function StickerPackCover({ packageId, fallback }: { packageId: string; fallback: React.ReactNode }) {
  const candidates = useMemo(() => stickerPackCoverCandidates(packageId), [packageId]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img
      className="sticker-pack-cover"
      src={candidates[candidateIndex]}
      alt="ปกแพ็กสติกเกอร์"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        if (candidateIndex + 1 < candidates.length) setCandidateIndex((current) => current + 1);
        else setFailed(true);
      }}
    />
  );
}

function Conversation({
  chat,
  messages,
  composer,
  onComposer,
  onSend,
  onSendSticker,
  onSendEmoji,
  onFlexAction,
  onViewImage,
  onImage,
  onNativeImage,
  onPickImage,
  onRetry,
  onRetryHistory,
  onMergeHistory,
  mediaProgress,
  onCancelMedia,
  onReact,
  onReply,
  onDeleteForMe,
  onUnsend,
  onOpenOfficialMessage,
  replyTarget,
  onCancelReply,
  onBack,
  canSend,
  callAvailable,
  onCall,
  onVideoCall,
  albumsAvailable,
  onAlbums,
  notesAvailable,
  onNotes,
  manageAvailable,
  onManage,
  windowActive,
  markReadOnBottom,
  showUnreadDivider,
  autoScrollNewMessages,
  showReadCount,
  developerFlexRaw,
  onReadLatest,
  onLoadOlder,
  jumpToMessageId,
  jumpNonce,
}: {
  chat: Chat;
  messages: Message[] | undefined;
  composer: string;
  onComposer: (value: string) => void;
  onSend: () => void | Promise<void>;
  onSendSticker: (sticker: RecentSticker) => void | Promise<void>;
  onSendEmoji: (emoji: RecentEmoji) => void | Promise<void>;
  onFlexAction: (action: FlexAction) => void | Promise<void>;
  onViewImage: (src: string) => void;
  onImage: (file: File) => void | Promise<void>;
  onNativeImage: (showError?: boolean) => void | Promise<void>;
  onPickImage: () => void | Promise<void>;
  onRetry: (id: string) => void;
  onRetryHistory: () => void;
  onMergeHistory: (sourceMid: string, targetMid: string) => Promise<void>;
  mediaProgress: Record<string, MediaProgress>;
  onCancelMedia: (id: string) => void;
  onReact: (message: Message, type: number) => void | Promise<void>;
  onReply: (message: Message) => void;
  onDeleteForMe: (message: Message) => void | Promise<void>;
  onUnsend: (message: Message) => void | Promise<void>;
  onOpenOfficialMessage: (message: Message) => void;
  replyTarget: ReplyTarget | null;
  onCancelReply: () => void;
  onBack: () => void;
  canSend: boolean;
  callAvailable: boolean;
  onCall: () => void;
  onVideoCall: () => void;
  albumsAvailable: boolean;
  onAlbums: () => void;
  notesAvailable: boolean;
  onNotes: () => void;
  manageAvailable: boolean;
  onManage: () => void;
  windowActive: boolean;
  markReadOnBottom: boolean;
  showUnreadDivider: boolean;
  autoScrollNewMessages: boolean;
  showReadCount: boolean;
  developerFlexRaw: boolean;
  onReadLatest: (lastMessageId?: string, lastMessageTime?: number) => void;
  onLoadOlder: (before: Message) => Promise<{ added: number; hasMore: boolean }>;
  jumpToMessageId?: string;
  jumpNonce: number;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageStageRef = useRef<HTMLDivElement>(null);
  const unreadDividerRef = useRef<HTMLDivElement>(null);
  const onReadLatestRef = useRef(onReadLatest);
  const stickToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const previousChatRef = useRef(chat.id);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerActionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!headerMenuOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!headerActionsRef.current?.contains(event.target as Node)) setHeaderMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHeaderMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [headerMenuOpen]);
  useEffect(() => setHeaderMenuOpen(false), [chat.id]);
  const [messageMenuId, setMessageMenuId] = useState<string | null>(null);
  const [reactionMenuId, setReactionMenuId] = useState<string | null>(null);
  const messageActionAnchorRefs = useRef(new Map<string, HTMLDivElement>());
  const messageActionTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const messageRowRefs = useRef(new Map<string, HTMLDivElement>());
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const messageMenuRef = useRef<HTMLDivElement>(null);
  const [messageMenuPosition, setMessageMenuPosition] = useState({ left: 8, top: 8, ready: false });
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [pickerTab, setPickerTab] = useState<"sticker" | "emoji">("sticker");
  const [recentStickers, setRecentStickers] = useState<RecentSticker[]>([]);
  const [recentEmoji, setRecentEmoji] = useState<RecentEmoji[]>([]);
  const [stickerPickerLoading, setStickerPickerLoading] = useState(false);
  const [selectedStickerPackId, setSelectedStickerPackId] = useState<string | null>(null);
  const [selectedEmojiPackId, setSelectedEmojiPackId] = useState<string | null>(null);
  const empty = chat.id === "__liney__";
  const historyState = chat.historyState ?? "available";
  const lineSystemAccount = chat.id === LINE_SYSTEM_ACCOUNT_MID;
  const sidebarHasRecentActivity = Number(chat.lastMessageTime ?? 0) > 0;
  const missingRecentHistory = chat.kind !== "openchat"
    && !lineSystemAccount
    && messages?.length === 0
    && sidebarHasRecentActivity;
  const historyUnavailable = historyState === "unavailable" || missingRecentHistory;
  const unresolvedGroupArchive = isUnresolvedGroupArchive(chat);
  const neverChatted = historyState === "new" && !lineSystemAccount && !sidebarHasRecentActivity;
  const canLoadOlderHistory = chat.kind !== "openchat" && !lineSystemAccount && !empty;
  const [rawMessageIds, setRawMessageIds] = useState<Set<string>>(() => new Set());
  useEffect(() => { if (!developerFlexRaw) setRawMessageIds(new Set()); }, [developerFlexRaw]);
  const toggleRawMessage = (id: string) => setRawMessageIds((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const [historyLoadState, setHistoryLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [historyCandidates, setHistoryCandidates] = useState<HistoryCandidate[] | null>(null);
  const [historyCandidateId, setHistoryCandidateId] = useState("");
  const [historyCandidateQuery, setHistoryCandidateQuery] = useState("");
  const [historyRecoveryBusy, setHistoryRecoveryBusy] = useState(false);
  const [historyRecoveryError, setHistoryRecoveryError] = useState("");
  const historyHasMoreRef = useRef(canLoadOlderHistory);
  const historyRequestTokenRef = useRef(0);
  const historyRequestChatRef = useRef<string | null>(null);
  const pendingHistoryAnchorRef = useRef<{
    chatId: string;
    firstMessageId: string;
    scrollTop: number;
    scrollHeight: number;
  } | null>(null);
  const lastMessage = messages?.at(-1);
  const lastMessageId = lastMessage?.id;

  useEffect(() => {
    setHistoryCandidates(null);
    setHistoryCandidateId("");
    setHistoryCandidateQuery("");
    setHistoryRecoveryError("");
  }, [chat.id]);

  async function searchSavedHistoryCandidates() {
    if (historyRecoveryBusy || !lineyEngine.isNative) return;
    setHistoryRecoveryBusy(true);
    setHistoryRecoveryError("");
    try {
      const candidates = await lineyEngine.request<HistoryCandidate[]>("message.history_candidates", { chatId: chat.id }, 10_000);
      setHistoryCandidates(candidates);
      setHistoryCandidateId("");
      setHistoryCandidateQuery("");
    } catch (error) {
      setHistoryRecoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryRecoveryBusy(false);
    }
  }

  async function mergeSavedHistoryCandidate() {
    if (!historyCandidateId || historyRecoveryBusy) return;
    setHistoryRecoveryBusy(true);
    setHistoryRecoveryError("");
    try {
      await onMergeHistory(historyCandidateId, chat.id);
      setHistoryCandidates(null);
      setHistoryCandidateId("");
      setHistoryCandidateQuery("");
    } catch (error) {
      setHistoryRecoveryError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryRecoveryBusy(false);
    }
  }

  const normalizedHistoryCandidateQuery = historyCandidateQuery.trim().toLocaleLowerCase();
  const filteredHistoryCandidates = (historyCandidates ?? []).filter((candidate) =>
    candidate.name.toLocaleLowerCase().includes(normalizedHistoryCandidateQuery)
      || candidate.id.toLocaleLowerCase().includes(normalizedHistoryCandidateQuery),
  );
  const lastMessageTime = Number(lastMessage?.createdTime ?? 0);
  const lastMessageImage = lastMessage?.image;
  const activeMenuMessage = messages?.find((item) => item.id === messageMenuId);
  const activeMenuMessageId = activeMenuMessage?.id;
  const activeMenuMessageAuthor = activeMenuMessage?.author;
  const unreadStartIndex = useMemo(() => {
    const unread = chat.unread ?? 0;
    if (!messages?.length || unread <= 0) return -1;
    let remaining = unread;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].author !== "me") remaining -= 1;
      if (remaining <= 0) return index;
    }
    return 0;
  }, [chat.unread, messages]);

  // oxlint-disable-next-line react/incompatible-library -- virtualization is intentional here; React Compiler may skip this component.
  const messageVirtualizer = useVirtualizer({
    count: messages?.length ?? 0,
    getScrollElement: () => messageStageRef.current,
    estimateSize: () => 92,
    getItemKey: (index) => messages?.[index]?.id ?? index,
    overscan: 8,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    // WebKitGTK can deliver ResizeObserver callbacks while a Wayland surface is
    // being reconfigured during move/resize. Defer measurement work to the next
    // animation frame to avoid synchronous layout/scroll feedback into wlroots.
    useAnimationFrameWithResizeObserver: true,
  });

  useEffect(() => {
    if (!jumpToMessageId || !jumpNonce || chat.id === "__liney__" || !messages?.length) return;
    const index = messages.findIndex((item) => item.id === jumpToMessageId);
    if (index < 0) return;
    let clearTimer: number | undefined;
    messageVirtualizer.scrollToIndex(index, { align: "center" });
    const frame = requestAnimationFrame(() => {
      setHighlightedMessageId(jumpToMessageId);
      clearTimer = window.setTimeout(() => setHighlightedMessageId((current) => current === jumpToMessageId ? null : current), 2_600);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (clearTimer !== undefined) window.clearTimeout(clearTimer);
    };
  }, [chat.id, jumpToMessageId, jumpNonce, messages, messageVirtualizer]);

  useEffect(() => {
    if (!messageMenuId && !reactionMenuId) return;
    const closeMenus = () => {
      setMessageMenuId(null);
      setReactionMenuId(null);
    };
    document.addEventListener("pointerdown", closeMenus);
    return () => document.removeEventListener("pointerdown", closeMenus);
  }, [messageMenuId, reactionMenuId]);

  useEffect(() => {
    if (!stickerPickerOpen || !canSend) return;
    let cancelled = false;
    void Promise.all([
      lineyEngine.request<RecentSticker[]>("sticker.recent", { limit: 36 }),
      lineyEngine.request<RecentEmoji[]>("emoji.recent", { limit: 72 }),
    ])
      .then(([stickers, emoji]) => {
        if (!cancelled) {
          setRecentStickers(Array.isArray(stickers) ? stickers : []);
          setRecentEmoji(Array.isArray(emoji) ? emoji : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecentStickers([]);
          setRecentEmoji([]);
        }
      })
      .finally(() => {
        if (!cancelled) setStickerPickerLoading(false);
      });
    return () => { cancelled = true; };
  }, [stickerPickerOpen, canSend]);

  const stickerPacks = useMemo(() => {
    const grouped = new Map<string, RecentSticker[]>();
    for (const sticker of recentStickers) {
      const group = grouped.get(sticker.packageId) ?? [];
      group.push(sticker);
      grouped.set(sticker.packageId, group);
    }
    return [...grouped.entries()];
  }, [recentStickers]);

  const emojiPacks = useMemo(() => {
    const grouped = new Map<string, RecentEmoji[]>();
    for (const emoji of recentEmoji) {
      const group = grouped.get(emoji.productId) ?? [];
      group.push(emoji);
      grouped.set(emoji.productId, group);
    }
    return [...grouped.entries()];
  }, [recentEmoji]);

  const activeStickerPackId = stickerPacks.some(([id]) => id === selectedStickerPackId)
    ? selectedStickerPackId
    : stickerPacks[0]?.[0] ?? null;
  const activeEmojiPackId = emojiPacks.some(([id]) => id === selectedEmojiPackId)
    ? selectedEmojiPackId
    : emojiPacks[0]?.[0] ?? null;
  const selectedStickerPack = stickerPacks.find(([id]) => id === activeStickerPackId);
  const selectedEmojiPack = emojiPacks.find(([id]) => id === activeEmojiPackId);

  useLayoutEffect(() => {
    if (!messageMenuId || !activeMenuMessageId || !activeMenuMessageAuthor) return;

    const updateMenuPosition = () => {
      const trigger = messageActionTriggerRefs.current.get(messageMenuId);
      const anchor = messageActionAnchorRefs.current.get(messageMenuId);
      const menu = messageMenuRef.current;
      if (!trigger || !menu) return;

      const triggerRect = trigger.getBoundingClientRect();
      const anchorRect = anchor?.getBoundingClientRect() ?? triggerRect;
      const menuRect = menu.getBoundingClientRect();
      const viewportPadding = 8;
      const gap = 8;
      const maxLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
      const preferredLeft = activeMenuMessageAuthor === "me"
        ? anchorRect.right - menuRect.width
        : anchorRect.left;
      const left = Math.min(Math.max(preferredLeft, viewportPadding), maxLeft);
      const belowTop = anchorRect.bottom + gap;
      const aboveTop = anchorRect.top - gap - menuRect.height;
      const maxTop = Math.max(viewportPadding, window.innerHeight - menuRect.height - viewportPadding);
      const top = belowTop + menuRect.height <= window.innerHeight - viewportPadding
        ? belowTop
        : aboveTop >= viewportPadding
          ? aboveTop
          : Math.min(Math.max(triggerRect.top + (triggerRect.height - menuRect.height) / 2, viewportPadding), maxTop);

      setMessageMenuPosition((current) => (
        current.ready && current.left === left && current.top === top
          ? current
          : { left, top, ready: true }
      ));
    };

    const frame = requestAnimationFrame(updateMenuPosition);
    const stage = messageStageRef.current;
    window.addEventListener("resize", updateMenuPosition);
    stage?.addEventListener("scroll", updateMenuPosition, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateMenuPosition);
      stage?.removeEventListener("scroll", updateMenuPosition);
    };
  }, [activeMenuMessageAuthor, activeMenuMessageId, messageMenuId, reactionMenuId]);

  useEffect(() => {
    onReadLatestRef.current = onReadLatest;
  }, [onReadLatest]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const stage = messageStageRef.current;
    if (!stage) return;
    stickToBottomRef.current = true;
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
    if (messages?.length) messageVirtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior });
    else stage.scrollTo({ top: stage.scrollHeight, behavior });
    setShowScrollBottom(false);
    if (markReadOnBottom && windowActive && (chat.unread ?? 0) > 0) {
      window.setTimeout(() => onReadLatestRef.current(lastMessageId, lastMessageTime), behavior === "smooth" ? 620 : 0);
    }
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, behavior === "smooth" ? 650 : 80);
  }, [chat.unread, lastMessageId, lastMessageTime, markReadOnBottom, messageVirtualizer, messages?.length, windowActive]);

  const requestOlderMessages = useCallback(async () => {
    const before = messages?.[0];
    const stage = messageStageRef.current;
    if (!canLoadOlderHistory || !historyHasMoreRef.current || !before || !stage
      || historyRequestChatRef.current === chat.id) return;

    const requestToken = ++historyRequestTokenRef.current;
    historyRequestChatRef.current = chat.id;
    pendingHistoryAnchorRef.current = stage.scrollHeight > stage.clientHeight + 40
      ? {
        chatId: chat.id,
        firstMessageId: before.id,
        scrollTop: stage.scrollTop,
        scrollHeight: stage.scrollHeight,
      }
      : null;
    setHistoryLoadState("loading");

    try {
      const result = await onLoadOlder(before);
      if (requestToken !== historyRequestTokenRef.current || previousChatRef.current !== chat.id) return;
      const progressed = Number(result?.added ?? 0) > 0;
      historyHasMoreRef.current = progressed && Boolean(result?.hasMore);
      if (!progressed) pendingHistoryAnchorRef.current = null;
      setHistoryLoadState("idle");
    } catch {
      if (requestToken !== historyRequestTokenRef.current || previousChatRef.current !== chat.id) return;
      pendingHistoryAnchorRef.current = null;
      setHistoryLoadState("error");
    } finally {
      if (requestToken === historyRequestTokenRef.current && historyRequestChatRef.current === chat.id) {
        historyRequestChatRef.current = null;
      }
    }
  }, [canLoadOlderHistory, chat.id, messages, onLoadOlder]);

  useLayoutEffect(() => {
    const anchor = pendingHistoryAnchorRef.current;
    if (!anchor || anchor.chatId !== chat.id || !messages?.length || messages[0]?.id === anchor.firstMessageId) return;
    const stage = messageStageRef.current;
    pendingHistoryAnchorRef.current = null;
    if (!stage) return;
    const heightDelta = stage.scrollHeight - anchor.scrollHeight;
    stage.scrollTop = Math.max(0, anchor.scrollTop + heightDelta);
  }, [chat.id, messages, messages?.length, messages?.[0]?.id]);

  useEffect(() => {
    if (!canLoadOlderHistory || !historyHasMoreRef.current || historyLoadState !== "idle" || !messages?.length) return;
    const frame = requestAnimationFrame(() => {
      const stage = messageStageRef.current;
      if (stage && stage.scrollHeight <= stage.clientHeight + 40) void requestOlderMessages();
    });
    return () => cancelAnimationFrame(frame);
  }, [canLoadOlderHistory, chat.id, historyLoadState, messages?.length, requestOlderMessages]);

  useEffect(() => () => {
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
  }, []);

  // Unread rooms open at the first unread message. Once the user reaches the
  // newest message the divider disappears and the room is acknowledged.
  useLayoutEffect(() => {
    const changedChat = previousChatRef.current !== chat.id;
    if (changedChat) {
      previousChatRef.current = chat.id;
      historyRequestTokenRef.current += 1;
      historyRequestChatRef.current = null;
      historyHasMoreRef.current = canLoadOlderHistory;
      pendingHistoryAnchorRef.current = null;
      setHistoryLoadState("idle");
      setMessageMenuId(null);
      setReactionMenuId(null);
      setStickerPickerOpen(false);
      setHighlightedMessageId(null);
      setMessageMenuPosition({ left: 8, top: 8, ready: false });
      messageActionAnchorRefs.current.clear();
      messageActionTriggerRefs.current.clear();
      messageRowRefs.current.clear();
      if (programmaticScrollTimerRef.current !== null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
        programmaticScrollTimerRef.current = null;
        programmaticScrollRef.current = false;
      }
      if ((chat.unread ?? 0) > 0 && showUnreadDivider && unreadStartIndex >= 0) {
        stickToBottomRef.current = false;
        const frame = requestAnimationFrame(() => {
          messageVirtualizer.scrollToIndex(unreadStartIndex, { align: "start" });
          setShowScrollBottom(true);
        });
        return () => cancelAnimationFrame(frame);
      }
      stickToBottomRef.current = true;
    }
    if (!stickToBottomRef.current || !autoScrollNewMessages) return;
    const frame = requestAnimationFrame(() => scrollToBottom("auto"));
    return () => cancelAnimationFrame(frame);
  }, [chat.id, chat.unread, messages?.length, lastMessageId, lastMessageImage, showUnreadDivider, autoScrollNewMessages, scrollToBottom, unreadStartIndex, messageVirtualizer]);

  const handleMessageScroll = () => {
    const stage = messageStageRef.current;
    if (!stage) return;
    const distanceFromBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight;
    const nearBottom = distanceFromBottom < 72;
    const nearTopWithHistory = stage.scrollTop <= 80
      && stage.scrollHeight - stage.clientHeight > 40
      && canLoadOlderHistory
      && historyHasMoreRef.current
      && historyLoadState === "idle";
    if (nearTopWithHistory && !programmaticScrollRef.current) {
      stickToBottomRef.current = false;
      void requestOlderMessages();
    }
    if (programmaticScrollRef.current) {
      if (nearBottom) {
        stickToBottomRef.current = true;
        setShowScrollBottom(false);
      }
      return;
    }
    if (nearBottom) {
      stickToBottomRef.current = true;
      setShowScrollBottom(false);
      if (markReadOnBottom && windowActive && (chat.unread ?? 0) > 0) onReadLatestRef.current(lastMessageId, lastMessageTime);
      return;
    }

    // Any non-programmatic movement away from the bottom is user intent. Do
    // not snap back while the user is browsing older messages.
    stickToBottomRef.current = false;
    setShowScrollBottom(distanceFromBottom > 140);
  };

  useEffect(() => {
    if (!markReadOnBottom || !windowActive || (chat.unread ?? 0) <= 0 || !stickToBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      const stage = messageStageRef.current;
      if (!stage) return;
      const distanceFromBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight;
      if (distanceFromBottom < 72) onReadLatestRef.current(lastMessageId, lastMessageTime);
    });
    return () => cancelAnimationFrame(frame);
  }, [chat.id, chat.unread, lastMessageId, lastMessageTime, markReadOnBottom, windowActive]);

  const stopFollowingBottom = () => {
    stickToBottomRef.current = false;
    programmaticScrollRef.current = false;
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
      programmaticScrollTimerRef.current = null;
    }
    const stage = messageStageRef.current;
    if (!stage) return;
    const distanceFromBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight;
    setShowScrollBottom(distanceFromBottom > 140);
  };

  return (
    <main className="conversation-panel">
      <header className="conversation-header">
        <button className="conversation-back-button" type="button" aria-label="กลับไปยังรายการแชต" title="กลับไปยังรายการแชต" onClick={onBack}><ArrowLeft size={18} /></button>
        <div className="conversation-person">
          <Avatar chat={chat} />
          <div>
            <div className="conversation-title-row">
              <h2>{chat.name}</h2>
              {chat.kind === "openchat" && <span className="openchat-chip">OpenChat</span>}
            </div>
            <span>{chat.detail ?? chat.subtitle}</span>
          </div>
        </div>
        <div className="header-actions" ref={headerActionsRef}>
          <button className="icon-button call-action" onClick={onCall} title={callAvailable ? "โทรเสียง" : "สายเสียงยังไม่พร้อม"} aria-label="โทรเสียง" disabled={!canSend || !callAvailable}><Phone size={18} /></button>
          <button className="icon-button video-action" onClick={onVideoCall} title={callAvailable ? "วิดีโอคอล (ทดลอง)" : "ระบบโทรยังไม่พร้อม"} aria-label="วิดีโอคอล" disabled={!canSend || !callAvailable}><Video size={19} /></button>
          {(albumsAvailable || notesAvailable || manageAvailable) ? (
            <div className="conversation-more">
              <button className="icon-button more-action" type="button" onClick={() => setHeaderMenuOpen((open) => !open)} aria-label="ตัวเลือกเพิ่มเติมของแชต" aria-haspopup="menu" aria-expanded={headerMenuOpen} title="ตัวเลือกเพิ่มเติม"><Ellipsis size={20} /></button>
              {headerMenuOpen ? (
                <div className="conversation-more-menu" role="menu" aria-label="ตัวเลือกของแชต">
                  {manageAvailable ? <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); onManage(); }}><Info size={17} />ข้อมูลและจัดการแชต</button> : null}
                  {albumsAvailable ? <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); onAlbums(); }}><Image size={17} />อัลบั้มรูปภาพ</button> : null}
                  {notesAvailable ? <button type="button" role="menuitem" onClick={() => { setHeaderMenuOpen(false); onNotes(); }}><Pencil size={17} />โน้ต</button> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <div className="message-stage-wrap">
      <div
        ref={messageStageRef}
         className={`message-stage ${empty ? "message-stage-empty" : ""}`}
        onScroll={handleMessageScroll}
        onWheel={(event) => {
          if (event.deltaY < 0) stopFollowingBottom();
        }}
        onTouchMove={(event) => {
          if (event.touches.length > 0) stopFollowingBottom();
        }}
        onPointerDown={(event) => {
          // Treat grabbing the native scrollbar as intentional history browsing.
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX >= rect.right - 18) stopFollowingBottom();
        }}
        onKeyDown={(event) => {
          if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stopFollowingBottom();
        }}
        tabIndex={-1}
      >
        {historyLoadState !== "idle" ? (
          <div className={`history-page-status ${historyLoadState}`} role={historyLoadState === "error" ? "alert" : "status"} aria-live="polite">
            {historyLoadState === "loading" ? (
              <><LoaderCircle size={14} className="spin" /><span>กำลังโหลดข้อความเก่า…</span></>
            ) : (
              <><span>โหลดข้อความเก่าไม่สำเร็จ</span><button type="button" onClick={() => void requestOlderMessages()}>ลองอีกครั้ง</button></>
            )}
          </div>
        ) : null}
        {empty ? (
          <div className="conversation-empty-state">
            <div className="empty-logo"><img src="/liney-logo.png" alt="" /></div>
            <h3>{chat.name}</h3>
            <p>{chat.subtitle}</p>
          </div>
        ) : messages === undefined ? (
          <div className="message-loading-state"><LoaderCircle size={22} className="spin" /><span>กำลังโหลดข้อความ…</span></div>
        ) : messages.length === 0 ? (
          lineSystemAccount ? (
            <div className="history-empty-layout">
            <section className="official-client-only-state" role="status">
              <div className="official-client-icon"><ShieldCheck size={25} /></div>
              <h3>ยังโหลดประวัติจาก LINE ไม่ได้</h3>
              <p>LINE ส่งข้อมูลห้องและเวลาให้ แต่รอบนี้ไม่ส่งข้อความเก่าผ่าน history API ที่ Liney ใช้อยู่</p>
              <span>ข้อความใหม่ที่ LINE ส่งให้ Liney ขณะออนไลน์จะแสดงและบันทึกได้</span>
            </section>
            </div>
          ) : historyUnavailable ? (
            <div className="history-empty-layout">
            <section className="official-client-only-state" role="status">
              <div className="official-client-icon"><Archive size={25} /></div>
              <h3>{unresolvedGroupArchive ? "ข้อมูลกลุ่มเก่ายังไม่พร้อม" : missingRecentHistory ? "ยังโหลดข้อความล่าสุดไม่ได้" : "ไม่พบประวัติที่เปิดอ่านได้"}</h3>
              <p>{unresolvedGroupArchive
                ? "Liney พบเพียงรหัสกลุ่มเก่าในแคช แต่ LINE ไม่ส่งชื่อ รูป หรือประวัติกลุ่มกลับมา ห้องนี้ยังถูกเก็บไว้ในเครื่องและแสดงในหมวดกลุ่มเก่าที่ข้อมูลไม่ครบ"
                : missingRecentHistory
                ? "Liney ลองอ่านจาก cursor, recent window และ MessageBox แล้ว แต่ LINE ไม่ส่งข้อความกลับมา ถ้าเคยคุยผ่าน MID เก่า ให้ค้นหาประวัติในเครื่องด้านล่าง"
                : "LINEJS ยังไม่ส่งข้อความเก่าของห้องนี้กลับมา และไม่มีข้อความที่กู้ได้จากแคชในเครื่อง"}</p>
              <span>{unresolvedGroupArchive
                ? "Liney เก็บข้อมูลห้องนี้ไว้ แต่ยังไม่ยืนยันว่ากลุ่มยังเข้าถึงได้"
                : "หาก LINE ส่งข้อความใหม่เข้ามาขณะ Liney ออนไลน์ ข้อความนั้นจะปรากฏและถูกบันทึกในเครื่อง"}</span>
              <button className="history-retry-button" type="button" onClick={onRetryHistory}><RefreshCw size={15} /> ตรวจสอบประวัติอีกครั้ง</button>
              {missingRecentHistory ? (
                <>
                  {chat.kind === "dm" ? (
                    <button className="history-retry-button" type="button" onClick={() => void searchSavedHistoryCandidates()} disabled={historyRecoveryBusy}>
                      {historyRecoveryBusy && historyCandidates === null ? "กำลังค้นหาประวัติในเครื่อง…" : "ค้นหาประวัติจาก MID เก่า"}
                    </button>
                  ) : null}
                  {historyCandidates?.length ? (
                    <>
                      <span>ผลค้นหาเป็นแชตที่มีสำเนาในเครื่อง ยังไม่ได้ยืนยันว่าเป็นคนเดียวกัน พิมพ์ชื่อเดิมหรือ MID แล้วเลือกแชตที่จำได้</span>
                      <input
                        className="identity-merge-search"
                        type="search"
                        value={historyCandidateQuery}
                        onChange={(event) => {
                          setHistoryCandidateQuery(event.target.value);
                          setHistoryCandidateId("");
                        }}
                        placeholder="ค้นหาชื่อแชตเดิมหรือ MID"
                        aria-label="ค้นหาชื่อแชตเดิมหรือ MID"
                        disabled={historyRecoveryBusy}
                      />
                      {normalizedHistoryCandidateQuery ? filteredHistoryCandidates.length ? (
                        <>
                          <select
                            className="identity-merge-select"
                            value={historyCandidateId}
                            onChange={(event) => setHistoryCandidateId(event.target.value)}
                            disabled={historyRecoveryBusy}
                            aria-label="เลือกแชตเก่าที่มีประวัติ"
                          >
                            <option value="">เลือกแชตเก่าที่ตรงกับคำค้น</option>
                            {filteredHistoryCandidates.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>
                                {candidate.name} · {candidate.messageCount} ข้อความ
                              </option>
                            ))}
                          </select>
                          <button className="history-retry-button" type="button" onClick={() => void mergeSavedHistoryCandidate()} disabled={!historyCandidateId || historyRecoveryBusy}>
                            {historyRecoveryBusy ? "กำลังรวมประวัติ…" : "รวมประวัติจากแชตนี้"}
                          </button>
                        </>
                      ) : (
                        <span>ไม่พบแชตที่ตรงกับคำค้นในสำเนาที่เก็บไว้</span>
                      ) : (
                        <span>พิมพ์ชื่อแชตเดิมเพื่อกรองรายการก่อนเลือก</span>
                      )}
                    </>
                  ) : historyCandidates ? (
                    <span>ไม่พบประวัติข้อความจาก MID อื่นในเครื่อง</span>
                  ) : null}
                  {historyRecoveryError ? <span role="alert">{historyRecoveryError}</span> : null}
                </>
              ) : null}
            </section>
            </div>
          ) : (
            <div className="message-list-empty-state">
              <MessageCircle size={24} />
              <strong>{neverChatted ? "ยังไม่เคยคุยกัน" : "ยังไม่มีข้อความ"}</strong>
              <span>{neverChatted ? `ส่งข้อความแรกถึง ${chat.name} เพื่อเริ่มการสนทนา` : "ส่งข้อความแรกเพื่อเริ่มการสนทนา"}</span>
            </div>
          )
        ) : (
          <>
            {historyUnavailable && !lineSystemAccount ? (
              <div className="official-history-banner" role="status">
                <ShieldCheck size={15} />
                <span><strong>Live mode</strong> · อ่านประวัติเก่าบางส่วนไม่ได้ แต่ข้อความใหม่ใน Liney ใช้งานได้ตามปกติ</span>
              </div>
            ) : null}
            <div className="date-divider"><span>ล่าสุด</span></div>
            <div
              className="virtual-message-list"
              style={{ height: `${messageVirtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}
            >
            {messageVirtualizer.getVirtualItems().map((virtualItem) => {
              const index = virtualItem.index;
              const message = messages[index];
              const showMessageText = hasUserVisibleMessageText(message);
              return (
              <div
                key={`message-wrap-${message.id}`}
                ref={messageVirtualizer.measureElement}
                data-index={virtualItem.index}
                className="message-wrap"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                {showUnreadDivider && index === unreadStartIndex ? (
                  <div ref={unreadDividerRef} className="unread-divider"><span>ข้อความใหม่</span></div>
                ) : null}
              <div
                key={message.id}
                ref={(element) => {
                  if (element) messageRowRefs.current.set(message.id, element);
                  else messageRowRefs.current.delete(message.id);
                }}
                className={`message-row ${message.author === "me" ? "mine" : "theirs"} ${highlightedMessageId === message.id ? "notification-target" : ""}`}
              >
                {message.author === "them" ? <MessageAvatar message={message} chat={chat} /> : null}
                <div className="message-cluster">
                  <MessageSenderLabel message={message} chat={chat} onOpenOfficialMessage={onOpenOfficialMessage} />
                  <div
                    className="message-action-anchor"
                    ref={(element) => {
                      if (element) messageActionAnchorRefs.current.set(message.id, element);
                      else messageActionAnchorRefs.current.delete(message.id);
                    }}
                  >
                    {message.replyTo ? (
                      <div className="reply-reference">
                        <Reply size={14} />
                        <div>
                          <strong>{message.replyTo.author === "me" ? "คุณ" : message.replyTo.senderName || "ข้อความที่ตอบกลับ"}</strong>
                          <span>{message.replyTo.text || "ข้อความ"}</span>
                        </div>
                      </div>
                    ) : null}
                    {message.unsent ? (
                      <div className="bubble bubble-unsent"><Undo2 size={14} /><span>ยกเลิกข้อความแล้ว</span></div>
                    ) : (
                      <>
                        {message.rich || message.flex ? (
                          <div className="liney-raw-message">
                            {developerFlexRaw && <button type="button" className="liney-raw-toggle" onClick={() => toggleRawMessage(message.id)} aria-pressed={!rawMessageIds.has(message.id)}>
                              {rawMessageIds.has(message.id) ? "แสดง Raw JSON" : "แสดง Flex / Rich"}
                            </button>}
                            {developerFlexRaw && !rawMessageIds.has(message.id) ? (
                              <div className="liney-raw-inspector">
                                <div className="liney-raw-actions">
                                  <span>{message.raw != null ? "Original LINE Payload" : "Parsed message (original unavailable)"}</span>
                                  <button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(message.raw ?? message.rich ?? message.flex, null, 2))}>Copy JSON</button>
                                </div>
                                <pre className="liney-raw-json">{JSON.stringify(message.raw ?? message.rich ?? message.flex, null, 2)}</pre>
                                {message.raw != null ? <details><summary>Parsed Flex / Rich</summary><pre className="liney-raw-json">{JSON.stringify(message.rich ?? message.flex, null, 2)}</pre></details> : null}
                              </div>
                            ) : message.rich ? (
                              <RichMessage data={message.rich} onAction={onFlexAction} />
                            ) : message.flex ? (
                              <FlexMessage data={message.flex} onAction={onFlexAction} />
                            ) : null}
                          </div>
                        ) : null}
                        {!message.rich && message.stickerUrl ? <StickerImage key={message.stickerUrl} src={message.stickerUrl} /> : null}
                        {!message.rich && message.emojiUrl ? <img className="message-line-emoji" src={message.emojiUrl} alt="LINE Emoji" loading="lazy" referrerPolicy="no-referrer" /> : null}
                        {!message.rich && message.image ? (
                          message.image === "food" ? <FoodCard /> : <button className="message-image-button" type="button" title="เปิดดูรูปภาพ" onClick={() => onViewImage(message.image!)}><img className="message-image" src={message.image} alt="รูปภาพ" /></button>
                        ) : null}
                          {message.contentType === 6 ? (
                            <CallHistoryCard data={message.call ?? { durationMs: 0, result: "", cause: "", status: "unknown" }} />
                          ) : !message.rich && message.postNotification ? (
                            <PostNotificationCard data={message.postNotification} />
                         ) : !message.rich && showMessageText ? (
                           <div className={`bubble ${message.status === "error" ? "bubble-error" : ""}`}><MessageTextWithLinks text={message.text!} /></div>
                         ) : null}
                          {showMessageText && message.status !== "sending" ? <LinkPreviewFor text={message.text!} /> : null}
                          {!message.rich && !message.flex && !message.stickerUrl && !message.emojiUrl
                            && !message.image && !message.postNotification && !message.call && !showMessageText
                            && (Boolean(message.filename)
                              || [1, 2, 3, 14].includes(Number(message.contentType ?? 0))
                              || (message.author === "me" && (message.status === "error" || message.status === "unknown"))) ? (
                              <div className="bubble bubble-media-fallback">
                                {message.filename
                                  ? mediaLabel(Number(message.contentType || 14), message.filename)
                                  : [1, 2, 3, 14].includes(Number(message.contentType ?? 0))
                                    ? mediaLabel(Number(message.contentType), "")
                                    : Number(message.contentType) === 7
                                      ? "สติกเกอร์"
                                      : "ไม่มีรายละเอียดข้อความที่บันทึกไว้"}
                              </div>
                            ) : null}
                          <OfficialMessageFallback message={message} chat={chat} onOpenOfficialMessage={onOpenOfficialMessage} />
                      </>
                    )}
                    {message.status !== "sending" ? (
                      <>
                        <button
                          className="message-action-trigger"
                          type="button"
                          title="การกระทำกับข้อความ"
                          aria-label="การกระทำกับข้อความ"
                          ref={(element) => {
                            if (element) messageActionTriggerRefs.current.set(message.id, element);
                            else messageActionTriggerRefs.current.delete(message.id);
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            setMessageMenuPosition({ left: 8, top: 8, ready: false });
                            setMessageMenuId((current) => current === message.id ? null : message.id);
                            setReactionMenuId(null);
                          }}
                        >
                          <Ellipsis size={16} />
                        </button>
                      </>
                    ) : null}
                  </div>
                  <div className="message-meta">
                    {message.reaction && <button className="reaction-pill">{message.reaction}</button>}
                    {message.reactions?.map((reaction) => {
                      const label = reactionOptions.find((option) => option.type === reaction.type)?.label || "รีแอคชั่น";
                      return (
                        <button
                          key={reaction.type}
                          className={`reaction-pill ${reaction.mine ? "active" : ""}`}
                          type="button"
                          title="เปลี่ยนรีแอคชั่น"
                          onClick={() => {
                            setMessageMenuId(message.id);
                            setReactionMenuId(message.id);
                          }}
                        >
                          {label} {reaction.count}
                        </button>
                      );
                    })}
                    {message.status === "sending" ? (
                      <>
                        <span className="send-state">
                          {mediaProgress[message.id]?.total
                            ? `${mediaProgress[message.id].phase === "reading" ? "กำลังเตรียม" : "กำลังส่ง"} ${Math.min(100, Math.round((mediaProgress[message.id].done / mediaProgress[message.id].total) * 100))}%`
                            : "กำลังส่ง…"}
                        </span>
                        {message.contentType && message.contentType > 0 ? <button className="message-retry" type="button" onClick={() => onCancelMedia(message.id)}>ยกเลิก</button> : null}
                      </>
                    ) : null}
                    {message.status === "error" || message.status === "unknown" ? (
                      <>
                        <span className="send-state send-error">{message.status === "unknown" ? "ตรวจสอบสถานะการส่ง" : "ส่งไม่สำเร็จ"}</span>
                        {message.sendError ? <span className="send-error-detail" title={message.sendError}>{message.sendError}</span> : null}
                        {message.sendError?.includes("ต้องเชื่อมบัญชี LINE ใหม่")
                          ? <span className="send-error-detail">เชื่อมบัญชีใหม่ก่อน แล้วค่อยลองส่งอีกครั้ง</span>
                          : <button className="message-retry" type="button" onClick={() => onRetry(message.id)}>ลองใหม่</button>}
                      </>
                    ) : null}
                    {message.edited && !message.unsent ? <span className="message-edited">แก้ไขแล้ว</span> : null}
                    {message.author === "me" && (message.readByPeer || (message.readCount ?? 0) > 0) ? (
                      <span className="message-read-receipt">
                        {showReadCount && (message.readCount ?? 0) > 1 ? `อ่านแล้ว ${message.readCount} คน` : "อ่านแล้ว"}
                      </span>
                    ) : null}
                    <time>{message.time}</time>
                  </div>
                </div>
              </div>
              </div>
            );
            })}
            </div>
          </>
        )}
      </div>
      <AnimatePresence>
        {showScrollBottom && !empty ? (
          <motion.button
            className="scroll-bottom-button"
            type="button"
            title="ไปข้อความล่าสุด"
            aria-label="ไปข้อความล่าสุด"
            initial={{ opacity: 0, y: 8, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.92 }}
            onClick={() => scrollToBottom("smooth")}
          >
            <ChevronDown size={20} strokeWidth={2.3} />
          </motion.button>
        ) : null}
      </AnimatePresence>
      {activeMenuMessage && typeof document !== "undefined" ? createPortal(
        <div
          ref={messageMenuRef}
          className="message-action-menu"
          style={{
            left: messageMenuPosition.left,
            top: messageMenuPosition.top,
            visibility: messageMenuPosition.ready ? "visible" : "hidden",
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {reactionMenuId === activeMenuMessage.id ? (
            <>
              <div className="message-action-menu-title">รีแอคชั่น</div>
              <div className="reaction-picker">
                {reactionOptions.map((option) => (
                  <button
                    key={option.type}
                    type="button"
                    className="reaction-choice"
                    onClick={() => {
                      setMessageMenuId(null);
                      setReactionMenuId(null);
                      void onReact(activeMenuMessage, option.type);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button className="message-action-back" type="button" onClick={() => setReactionMenuId(null)}>กลับ</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setReactionMenuId(activeMenuMessage.id)}><Smile size={15} />รีแอคชั่น</button>
              <button type="button" onClick={() => { setMessageMenuId(null); onReply(activeMenuMessage); }}><Reply size={15} />ตอบกลับ</button>
              <button type="button" onClick={() => { setMessageMenuId(null); void onDeleteForMe(activeMenuMessage); }}><Trash size={15} />ลบเฉพาะคุณ</button>
              {activeMenuMessage.author === "me" && activeMenuMessage.status === "sent" ? (
                <button className="danger-action" type="button" onClick={() => { setMessageMenuId(null); void onUnsend(activeMenuMessage); }}><Undo2 size={15} />ยกเลิกข้อความ</button>
              ) : null}
            </>
          )}
        </div>,
        document.body,
      ) : null}
      </div>

      <div className="conversation-composer">
        {replyTarget ? (
          <div className="reply-composer-bar">
            <Reply size={15} />
            <div>
              <strong>ตอบกลับ {replyTarget.author === "me" ? "คุณ" : replyTarget.senderName || "ข้อความ"}</strong>
              <span>{replyTarget.text || "ข้อความ"}</span>
            </div>
            <button type="button" title="ยกเลิกการตอบกลับ" aria-label="ยกเลิกการตอบกลับ" onClick={onCancelReply}><X size={15} /></button>
          </div>
        ) : null}
      <div className={`composer-area ${!canSend ? "composer-disabled" : ""}`}>
        <div className="composer-tools">
          <button className="plain-icon" disabled={!canSend} onClick={() => lineyEngine.isNative ? void onPickImage() : fileInputRef.current?.click()} title="ส่งไฟล์"><Paperclip size={19} /></button>
          <button className="plain-icon" disabled={!canSend} onClick={() => lineyEngine.isNative ? void onPickImage() : fileInputRef.current?.click()} title="ส่งรูปภาพ"><Image size={19} /></button>
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            accept="image/*,video/*,audio/*,.pdf,.zip,.txt,.doc,.docx,.xls,.xlsx"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void onImage(file);
            }}
          />
          <button
            className={`plain-icon ${stickerPickerOpen ? "active" : ""}`}
            disabled={!canSend}
            type="button"
            title="สติกเกอร์และ LINE Emoji"
            aria-label="สติกเกอร์และ LINE Emoji"
            onClick={() => {
              if (!stickerPickerOpen) setStickerPickerLoading(true);
              setStickerPickerOpen((open) => !open);
            }}
          ><Smile size={19} /></button>
        </div>
        <textarea
          value={composer}
          onChange={(e) => onComposer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          onPaste={(event) => {
            if (!canSend) return;
            const image = clipboardImageFromData(event.clipboardData);
            if (image) {
              event.preventDefault();
              void onImage(image);
              return;
            }
            const hasImageType = Array.from(event.clipboardData.types)
              .some((type) => type.toLowerCase().startsWith("image/"));
            if (hasImageType && lineyEngine.isNative) {
              event.preventDefault();
              void onNativeImage();
              return;
            }
            // Some WebKitGTK clipboard providers expose no image item at all.
            // Probe the native clipboard only when there is no text payload so
            // normal text paste remains untouched.
            if (lineyEngine.isNative && !event.clipboardData.getData("text/plain")) {
              void onNativeImage(false);
            }
          }}
          placeholder={canSend ? `ส่งข้อความถึง ${chat.name}` : "เข้าสู่ระบบ LINE เพื่อเริ่มแชต"}
          rows={1}
          disabled={!canSend}
        />
        <button className={`send-button ${composer.trim() && canSend ? "enabled" : ""}`} onClick={() => void onSend()} disabled={!composer.trim() || !canSend}>
          <Send size={18} />
        </button>
        {stickerPickerOpen ? (
          <div className="sticker-picker" role="dialog" aria-label="เลือกสติกเกอร์หรือ LINE Emoji">
            <div className="sticker-picker-title"><strong>สติกเกอร์ของคุณ</strong><button type="button" title="ปิด" onClick={() => setStickerPickerOpen(false)}><X size={15} /></button></div>
            <div className="sticker-picker-tabs"><button className={pickerTab === "sticker" ? "active" : ""} type="button" onClick={() => setPickerTab("sticker")}>สติกเกอร์</button><button className={pickerTab === "emoji" ? "active" : ""} type="button" onClick={() => setPickerTab("emoji")}>LINE Emoji</button></div>
            {stickerPickerLoading ? <div className="sticker-picker-empty">กำลังโหลดคลัง…</div> : null}
            {!stickerPickerLoading && pickerTab === "sticker" && stickerPacks.length === 0 ? <div className="sticker-picker-empty">ไม่พบสติกเกอร์ที่บัญชีนี้เป็นเจ้าของ</div> : null}
            {!stickerPickerLoading && pickerTab === "emoji" && emojiPacks.length === 0 ? <div className="sticker-picker-empty">ยังไม่มี LINE Emoji ในประวัติแชต</div> : null}
            {!stickerPickerLoading && pickerTab === "sticker" && selectedStickerPack ? <div className="sticker-chooser"><section className="sticker-pack-page"><div className="sticker-pack-label"><span>แพ็ก #{selectedStickerPack[0]}</span><small>ของคุณ</small></div><div className="sticker-picker-grid">{selectedStickerPack[1].map((sticker) => { const src = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${encodeURIComponent(sticker.stickerId)}/android/${sticker.option === "A" ? "sticker_animation.png" : "sticker.png"}`; return <button key={`${sticker.packageId}:${sticker.stickerId}`} type="button" title="ส่งสติกเกอร์ของคุณ" onClick={() => { setStickerPickerOpen(false); void onSendSticker(sticker); }}><StickerImage src={src} className="sticker-picker-image" fallback={<span className="sticker-picker-unavailable">ไม่พร้อม</span>} /></button>; })}</div></section><div className="sticker-pack-tabs" role="tablist" aria-label="แพ็กสติกเกอร์">{stickerPacks.map(([packageId, stickers]) => { const first = stickers[0]; const fallback = first ? <StickerImage src={`https://stickershop.line-scdn.net/stickershop/v1/sticker/${encodeURIComponent(first.stickerId)}/android/${first.option === "A" ? "sticker_animation.png" : "sticker.png"}`} className="sticker-pack-tab-image" fallback={<span className="sticker-picker-unavailable">ไม่พร้อม</span>} /> : <span className="sticker-picker-unavailable">ไม่พร้อม</span>; return <button key={packageId} className={packageId === selectedStickerPack[0] ? "active" : ""} role="tab" aria-selected={packageId === selectedStickerPack[0]} type="button" title={`แพ็ก #${packageId}`} onClick={() => setSelectedStickerPackId(packageId)}><StickerPackCover packageId={packageId} fallback={fallback} /></button>; })}</div></div> : null}
            {!stickerPickerLoading && pickerTab === "emoji" && selectedEmojiPack ? <div className="sticker-chooser"><section className="sticker-pack-page"><div className="sticker-pack-label"><span>LINE Emoji #{selectedEmojiPack[0]}</span><small>{selectedEmojiPack[1].some((item) => item.owned) ? "ของคุณ" : "พบในแชต"}</small></div><div className="sticker-picker-grid emoji-picker-grid">{selectedEmojiPack[1].map((item) => { const src = `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${encodeURIComponent(item.productId)}/android/${encodeURIComponent(item.sticonId)}.png`; return <button key={`${item.productId}:${item.sticonId}`} type="button" title={`ส่ง LINE Emoji · ${item.owned ? "ของคุณ" : "พบในแชต"}`} onClick={() => { setStickerPickerOpen(false); void onSendEmoji(item); }}><img src={src} alt="LINE Emoji" loading="lazy" referrerPolicy="no-referrer" /></button>; })}</div></section><div className="sticker-pack-tabs" role="tablist" aria-label="แพ็ก LINE Emoji">{emojiPacks.map(([productId, items]) => { const first = items[0]; const src = first ? `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${encodeURIComponent(first.productId)}/android/${encodeURIComponent(first.sticonId)}.png` : ""; return <button key={productId} className={productId === selectedEmojiPack[0] ? "active" : ""} role="tab" aria-selected={productId === selectedEmojiPack[0]} type="button" title={`LINE Emoji #${productId}`} onClick={() => setSelectedEmojiPackId(productId)}>{src ? <img src={src} alt="LINE Emoji" loading="lazy" referrerPolicy="no-referrer" /> : null}</button>; })}</div></div> : null}
          </div>
        ) : null}
      </div>
      </div>
    </main>
  );
}

function TimelineConversation({
  emptyFallback = false,
  ...props
}: Omit<Parameters<typeof Conversation>[0], "messages"> & { emptyFallback?: boolean }) {
  const timeline = useTimelineRoom(props.chat.id);
  const messages = props.chat.id === "__liney__"
    ? []
    : timeline ?? (emptyFallback ? [] : undefined);
  return <Conversation {...props} messages={messages} />;
}

function PostNotificationCard({ data }: { data: NonNullable<Message["postNotification"]> }) {
  const isAlbum = data.kind === "album";
  const label = isAlbum ? "อัลบั้ม" : "โน้ต";
  const action = isAlbum
    ? data.action === "created" ? "สร้างอัลบั้ม" : data.action === "added" ? "เพิ่มรูปภาพในอัลบั้ม" : "อัปเดตอัลบั้ม"
    : "โพสต์ในโน้ต";
  return (
    <div className={`post-notification-card ${isAlbum ? "album-card" : "note-card"}`}>
      <div className="post-notification-thumb">
        {isAlbum ? <Image size={21} /> : <MessageCircle size={20} />}
      </div>
      <div className="post-notification-copy">
        <div className="post-notification-topline"><span>{label}</span><small>{action}</small></div>
        <strong>{data.title}</strong>
        {!isAlbum && data.body ? <p>{data.body}</p> : null}
      </div>
      <span className="post-notification-arrow">›</span>
    </div>
  );
}

const LINK_URL_RE = /(https?:\/\/[^\s<>"']+)/;
const MESSAGE_LINK_RE = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_LINK_PUNCTUATION_RE = /[.,;:!?\]}>]+$/;

function normalizedMessageHref(value: string): string {
  return /^www\./i.test(value) ? `https://${value}` : value;
}

function splitTrailingLinkPunctuation(value: string): { link: string; trailing: string } {
  let link = value;
  let trailing = "";
  while (TRAILING_LINK_PUNCTUATION_RE.test(link)) {
    trailing = link.slice(-1) + trailing;
    link = link.slice(0, -1);
  }
  // A closing parenthesis is punctuation only when the URL did not open one.
  while (link.endsWith(")") && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) {
    trailing = ")" + trailing;
    link = link.slice(0, -1);
  }
  return { link, trailing };
}

function openMessageLink(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
  event.preventDefault();
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (lineyEngine.isNative) {
      void invoke("open_external_url", { url: url.toString() });
    } else {
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    }
  } catch {
    // Invalid URLs remain visible as text but are not opened.
  }
}

function MessageTextWithLinks({ text }: { text: string }) {
  const source = String(text || "");
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(MESSAGE_LINK_RE)) {
    if (match.index > lastIndex) nodes.push(source.slice(lastIndex, match.index));
    const raw = match[0];
    const { link, trailing } = splitTrailingLinkPunctuation(raw);
    const href = normalizedMessageHref(link);
    if (link) {
      nodes.push(
        <a
          key={`${match.index}:${link}`}
          className="message-text-link"
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => openMessageLink(event, href)}
        >
          {link}
        </a>,
      );
    }
    if (trailing) nodes.push(trailing);
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < source.length) nodes.push(source.slice(lastIndex));
  return <>{nodes.length ? nodes : source}</>;
}

function LinkPreviewFor({ text }: { text: string }) {
  const match = LINK_URL_RE.exec(String(text || ""));
  const url = match?.[1]?.replace(/[.,;:!?]+$/, "");
  if (!url) return null;
  return <LinkPreview key={url} url={url} />;
}

function LinkPreview({ url }: { url: string }) {
  const deferredRef = useRef<HTMLDivElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(() => !lineyEngine.isNative);
  const [state, setState] = useState<{ title: string; description?: string; image?: string; siteName?: string } | "error" | null>(
    () => lineyEngine.isNative ? null : "error",
  );

  useEffect(() => {
    if (!lineyEngine.isNative || shouldLoad) return;
    const target = deferredRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      queueMicrotask(() => setShouldLoad(true));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setShouldLoad(true);
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!lineyEngine.isNative || !shouldLoad) return;
    let alive = true;
    lineyEngine
      .request<{ title?: string; description?: string; image?: string; siteName?: string }>("link.preview", { url }, 12_000)
      .then((r) => { if (alive) setState(r?.title ? { title: r.title, description: r.description, image: r.image, siteName: r.siteName } : "error"); })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, [url, shouldLoad]);

  if (!shouldLoad) {
    return <div ref={deferredRef} className="link-preview-deferred" aria-hidden="true" />;
  }
  if (state === null) {
    return <div className="link-preview link-preview-loading"><span className="link-preview-skeleton" /></div>;
  }
  if (state === "error") {
    return <a className="link-preview link-preview-fallback" href={url} target="_blank" rel="noreferrer noopener">{url}</a>;
  }
  const s = state;
  return (
    <a className="link-preview" href={url} target="_blank" rel="noreferrer noopener">
      {s.image ? (
        <div className="link-preview-thumb">
          <RemoteImage
            className="link-preview-image"
            src={s.image}
            alt={s.title || s.siteName || "Link preview image"}
            loading="lazy"
            maxAspectRatio={4.5}
            preferProxy
            fallback={<span className="link-preview-thumb-fallback" aria-hidden="true"><Link2 size={20} /></span>}
          />
        </div>
      ) : null}
      <div className="link-preview-copy">
        {s.siteName ? <span className="link-preview-site">{s.siteName}</span> : null}
        <strong className="link-preview-title">{s.title}</strong>
        {s.description ? <span className="link-preview-desc">{s.description}</span> : null}
        <span className="link-preview-url">{url}</span>
      </div>
    </a>
  );
}

function FoodCard() {
  return (
    <div className="photo-card" aria-label="mock photo">
      <div className="plate plate-a"><span /></div>
      <div className="plate plate-b"><span /></div>
      <div className="drink drink-a" />
      <div className="drink drink-b" />
      <div className="photo-label">Cafe lunch · mock media</div>
    </div>
  );
}

function EnginePill({ state, version, authenticated, syncStatus, onClick }: { state: EngineState; version: string; authenticated: boolean; syncStatus: string; onClick: () => void }) {
  const copy = syncStatus || (state === "ready" ? `LINEJS ${version} · ${authenticated ? "Signed in" : "Engine ready"}` : state === "starting" ? "Starting LINE engine…" : state === "error" ? "LINE engine offline" : "Browser mock mode");
  return (
    <button className={`engine-pill engine-${state}`} onClick={onClick}>
      <span className="engine-led" />
      {copy}
    </button>
  );
}

function FullSyncPopup({
  progress,
  onCancel,
  onRetry,
  onClose,
}: {
  progress: SyncProgressState;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const formatCount = (value: number) => value.toLocaleString("th-TH");
  const copy = progress.phase === "metadata"
    ? { title: "กำลังเตรียม Full Sync", detail: "กำลังเชื่อมข้อมูลบัญชี LINE" }
    : progress.phase === "friends"
      ? { title: "กำลังซิงก์เพื่อน", detail: formatCount(progress.done) + " / " + formatCount(progress.total) + " คน" }
      : progress.phase === "chats"
        ? { title: "กำลังซิงก์รายการแชต", detail: formatCount(progress.done) + " / " + formatCount(progress.total) + " ห้อง" }
        : progress.phase === "history"
          ? { title: "กำลังซิงก์ประวัติข้อความ", detail: "ห้อง " + formatCount(progress.done) + " จาก " + formatCount(progress.total) + (progress.failed ? " · ข้ามแล้ว " + formatCount(progress.failed) : "") }
          : progress.phase === "complete"
            ? { title: "Full Sync เสร็จแล้ว", detail: formatCount(Number(progress.summary?.friends ?? 0)) + " เพื่อน · " + formatCount(Number(progress.summary?.talkChats ?? 0) + Number(progress.summary?.openChats ?? 0)) + " ห้อง" + (progress.failed ? " · " + formatCount(progress.failed) + " ห้องมีปัญหา" : "") }
            : { title: "Full Sync มีบางส่วนไม่สำเร็จ", detail: "เกิดปัญหาระหว่างซิงก์ ลองใหม่ได้อีกครั้ง" };
  const hasMeasuredProgress = progress.total > 0 && progress.phase !== "metadata";
  const isIndeterminate = progress.phase !== "complete" && progress.phase !== "error" && !hasMeasuredProgress;
  const percent = hasMeasuredProgress ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;
  const fill = progress.phase === "complete" ? 100 : isIndeterminate ? 32 : (percent ?? 0);

  return (
    <motion.div
      className="full-sync-popup-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="presentation"
    >
      <motion.section
        className={"full-sync-card sync-progress-" + progress.phase}
        initial={{ scale: 0.96, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.98, y: 6 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="full-sync-title"
        aria-describedby="full-sync-detail"
        aria-live="polite"
      >
        <img src="/liney-logo.png" alt="Liney" className="full-sync-logo" />
        <div className="full-sync-icon">
          {progress.phase === "complete"
            ? <ShieldCheck size={25} />
            : progress.phase === "error"
              ? <TriangleAlert size={25} />
              : <LoaderCircle size={25} className="spin" />}
        </div>
        <span className="full-sync-eyebrow">LINEY · FULL SYNC</span>
        <h1 id="full-sync-title">{copy.title}</h1>
        <p id="full-sync-detail">{copy.detail}</p>
        {progress.phase === "error" && progress.error
          ? <p className="full-sync-error">{progress.error}</p>
          : null}
        <div
          className={"full-sync-track" + (isIndeterminate ? " sync-progress-indeterminate" : "")}
          role="progressbar"
          aria-label="ความคืบหน้าในขั้นตอนปัจจุบัน"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? (progress.phase === "complete" ? 100 : undefined)}
          aria-valuetext={percent === null ? "กำลังเตรียมข้อมูล" : formatCount(progress.done) + " จาก " + formatCount(progress.total)}
        >
          <i style={{ width: fill + "%" }} />
        </div>
        {percent !== null || progress.phase === "complete"
          ? <strong className="full-sync-percent">{progress.phase === "complete" ? "100" : String(percent)}%</strong>
          : null}
        <small>
          {progress.phase === "complete"
            ? "ซิงก์ข้อมูลที่มีให้เสร็จแล้ว"
            : progress.phase === "error"
              ? "แชตที่บันทึกไว้ในเครื่องยังคงอยู่"
              : "กำลังซิงก์ข้อมูลจริงจากบัญชี LINE"}
        </small>
        {progress.phase === "error" ? (
          <div className="full-sync-actions">
            <button className="secondary-button" type="button" onClick={onClose}>ปิด</button>
            <button className="primary-button" type="button" onClick={onRetry}>ลองใหม่</button>
          </div>
        ) : progress.phase !== "complete" ? (
          <button className="secondary-button full-sync-cancel" type="button" onClick={onCancel}>ยกเลิก Full Sync</button>
        ) : null}
      </motion.section>
    </motion.div>
  );
}

function describeAuthError(raw: string): { title: string; message: string; code?: string } {
  const value = raw.toUpperCase();
  if (value.includes("INVALID_IDENTITY_CREDENTIAL")) return { title: "เข้าสู่ระบบไม่สำเร็จ", message: "LINE ไม่ยอมรับอีเมลหรือรหัสผ่าน กรุณาตรวจสอบข้อมูลบัญชีแล้วลองอีกครั้ง", code: "INVALID_IDENTITY_CREDENTIAL" };
  if (/TOO_MANY|RATE_LIMIT|429|FLOOD/.test(value)) return { title: "ลองเข้าสู่ระบบบ่อยเกินไป", message: "กรุณารอสักครู่ก่อนลองใหม่ เพื่อหลีกเลี่ยงการจำกัดบัญชี" };
  if (/TIMEOUT|TIMED OUT|ETIMEDOUT/.test(value)) return { title: "การเชื่อมต่อหมดเวลา", message: "LINE ไม่ตอบกลับทันเวลา กรุณาลองอีกครั้ง" };
  if (/ECONN|NETWORK|FETCH FAILED|ENOTFOUND|OFFLINE/.test(value)) return { title: "เชื่อมต่อ LINE ไม่ได้", message: "ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง" };
  if (/VERIF|PIN_REQUIRED|TWO_FACTOR|CHALLENGE/.test(value)) return { title: "ต้องยืนยันตัวตนเพิ่มเติม", message: "ตรวจสอบคำขอยืนยันการเข้าสู่ระบบบนมือถือ" };
  if (/SESSION|TOKEN_EXPIRED|UNAUTHORIZED/.test(value)) return { title: "เซสชันหมดอายุ", message: "กรุณาเข้าสู่ระบบใหม่อีกครั้ง" };
  if (/REQUEST INTERNAL FAILED|\{.*\}|STACK|AT .*\(/i.test(raw)) return { title: "ดำเนินการไม่สำเร็จ", message: "Liney พบข้อผิดพลาดระหว่างเชื่อมต่อ กรุณาลองใหม่อีกครั้ง" };
  return { title: "เกิดข้อผิดพลาด", message: raw };
}

function AuthModal({
  engineState,
  authenticated,
  authMode,
  qrUrl,
  pin,
  email,
  password,
  authBusy,
  error,
  profileName,
  clientIdentity,
  storageMode,
  required,
  keyImportMode,
  keyImportResult,
  onBeginKeyImport,
  onImportKeys,
  onModeChange,
  onEmailChange,
  onPasswordChange,
  onStart,
  onPasswordLogin,
  onLogout,
  onClose,
}: {
  engineState: EngineState;
  authenticated: boolean;
  authMode: AuthMode;
  qrUrl: string;
  pin: string;
  email: string;
  password: string;
  authBusy: boolean;
  error: string;
  profileName: string;
  clientIdentity: ClientIdentityResult | null;
  storageMode: "wallet" | "encrypted-file" | "session-only";
  required: boolean;
  keyImportMode: boolean;
  keyImportResult: { generations: number } | null;
  onBeginKeyImport: () => void;
  onImportKeys: () => void;
  onModeChange: (mode: AuthMode) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onStart: () => void;
  onPasswordLogin: () => void;
  onLogout: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const canLogin = engineState === "ready" && !authBusy && riskAcknowledged;

  return (
    <motion.div className="modal-backdrop auth-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.section className={`auth-modal ${required ? "auth-modal-required" : ""}`} initial={{ opacity: 0, scale: .96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: .97, y: 8 }} aria-modal="true" role="dialog">
        {!required ? <button className="auth-close icon-button" onClick={onClose} aria-label="ปิด"><X size={18}/></button> : null}
        <div className="auth-brand"><img src="/liney-logo.png" alt="" /></div>
        <p className="eyebrow">LINEJS · {clientIdentity?.displayName || clientIdentity?.device || "DESKTOPWIN"}</p>
        <h2>{keyImportMode ? "รับคีย์ E2EE จากมือถือ" : authenticated ? (profileName || "เชื่อม LINE แล้ว") : "เชื่อมบัญชี LINE"}</h2>
        <p className="auth-copy">{keyImportMode
          ? "สแกนด้วยมือถือที่มีคีย์เดิม โดยใช้บัญชีเดียวกับ Desktop"
          : authenticated ? "บัญชีนี้เชื่อมต่อกับ Liney แล้ว" : "ต้องเข้าสู่ระบบก่อนจึงจะใช้แชตและฟีเจอร์ของ Liney ได้"}</p>

        {authenticated ? (
          keyImportMode ? (
            <>
              {keyImportResult ? (
                <div className="auth-success">
                  <ShieldCheck size={34}/>
                  <strong>นำเข้า keychain สำเร็จ</strong>
                  <span>เปิดใช้คีย์ที่มือถือเลือกแล้ว และเก็บคีย์เดิมไว้ {keyImportResult.generations} รุ่น</span>
                  <button className="auth-primary" onClick={onClose}>เรียบร้อย</button>
                </div>
              ) : qrUrl ? (
                <div className="qr-zone">
                  <div className="qr-card"><QRCodeSVG value={qrUrl} size={188} level="M" /></div>
                  <div className="qr-instruction"><QrCode size={18}/><div><strong>สแกนด้วย LINE บนมือถือเครื่องเดิม</strong><span>เปิด LINE → สแกน QR Code → อนุญาตการเข้าสู่ระบบบัญชีเดียวกัน</span></div></div>
                  {pin ? <div className="pin-card"><span>รหัสยืนยัน</span><strong>{pin}</strong></div> : null}
                </div>
              ) : (
                <>
                  <div className="auth-idle">
                    <div className="auth-engine-icon">{authBusy ? <LoaderCircle className="spin" size={26}/> : <QrCode size={27}/>}</div>
                    <strong>{authBusy ? "กำลังสร้าง QR Code" : "พร้อมนำเข้าคีย์จากมือถือ"}</strong>
                    <span>{authBusy ? "รอการยืนยันจาก LINE…" : "คีย์จะถูกเก็บในเครื่องนี้โดยไม่ล้างประวัติแชต"}</span>
                  </div>
                  <button className="auth-primary" disabled={engineState !== "ready" || authBusy} onClick={onImportKeys}>
                    {authBusy ? <LoaderCircle className="spin" size={17}/> : <QrCode size={17}/>} {authBusy ? "กำลังรอมือถือ…" : "สร้าง QR สำหรับนำเข้าคีย์"}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              <div className="auth-success">
                <ShieldCheck size={34}/>
                <strong>พร้อมใช้งานจริง</strong>
                <span>แชตปกติ, OpenChat และการส่งข้อความเชื่อมผ่าน {clientIdentity?.displayName || "Liney"}</span>
              </div>
              <button className="auth-primary" disabled={engineState !== "ready" || authBusy} onClick={onBeginKeyImport}>
                <QrCode size={17}/> รับคีย์เข้ารหัสจาก LINE มือถือ
              </button>
            </>
          )
        ) : (
          <>
            <div className="auth-mode-switch" role="tablist" aria-label="วิธีเข้าสู่ระบบ">
              <button type="button" role="tab" aria-selected={authMode === "qr"} className={authMode === "qr" ? "active" : ""} disabled={authBusy} onClick={() => onModeChange("qr")}>
                <QrCode size={15}/> QR Code
              </button>
              <button type="button" role="tab" aria-selected={authMode === "password"} className={authMode === "password" ? "active" : ""} disabled={authBusy} onClick={() => onModeChange("password")}>
                <Mail size={15}/> Email / Password
              </button>
            </div>

            {authMode === "qr" ? (
              qrUrl ? (
                <div className="qr-zone">
                  <div className="qr-card"><QRCodeSVG value={qrUrl} size={188} level="M" /></div>
                  <div className="qr-instruction"><QrCode size={18}/><div><strong>สแกนด้วย LINE บนมือถือ</strong><span>เปิด LINE → สแกน QR Code → อนุญาตการเข้าสู่ระบบ</span></div></div>
                  {pin ? <div className="pin-card"><span>รหัสยืนยัน</span><strong>{pin}</strong></div> : null}
                </div>
              ) : (
                <div className="auth-idle">
                  <div className="auth-engine-icon">{engineState === "starting" || authBusy ? <LoaderCircle className="spin" size={26}/> : <QrCode size={27}/>}</div>
                  <strong>{authBusy ? "กำลังสร้างการเชื่อมต่อ" : engineState === "ready" ? "LINE engine พร้อม" : "กำลังเตรียม LINE engine"}</strong>
                  <span>{authBusy ? "รอการยืนยันจาก LINE…" : "สร้าง QR Code แล้วสแกนจากมือถือเพียงครั้งแรก"}</span>
                </div>
              )
            ) : (
              <form className="auth-password-form" onSubmit={(event) => { event.preventDefault(); if (canLogin) onPasswordLogin(); }}>
                <label className="auth-field">
                  <span>Email ของบัญชี LINE</span>
                  <div className="auth-input-wrap"><Mail size={16}/><input type="email" autoComplete="username" spellCheck={false} value={email} onChange={(event) => onEmailChange(event.currentTarget.value)} placeholder="name@example.com" required /></div>
                </label>
                <label className="auth-field">
                  <span>Password ของบัญชี LINE</span>
                  <div className="auth-input-wrap"><KeyRound size={16}/><input type="password" autoComplete="current-password" value={password} onChange={(event) => onPasswordChange(event.currentTarget.value)} placeholder="กรอกรหัสผ่าน" required /></div>
                </label>
                {pin ? <div className="pin-card"><span>รหัสยืนยันจาก LINE</span><strong>{pin}</strong></div> : null}
                <button className="auth-primary" type="submit" disabled={!canLogin || !email.trim() || !password}>
                  {authBusy ? <LoaderCircle className="spin" size={17}/> : <LogIn size={17}/>} {authBusy ? "กำลังตรวจสอบบัญชี…" : "เข้าสู่ระบบด้วย Email"}
                </button>
                <p className="auth-password-note">บางบัญชีอาจต้องยืนยันรหัสบนโทรศัพท์ หรืออาจไม่รองรับการล็อกอินแบบนี้</p>
              </form>
            )}

            <details className="auth-disclaimer" role="note"><summary><TriangleAlert size={18}/> ข้อควรระวังการใช้งาน <span>อ่านรายละเอียด</span></summary><div className="auth-disclaimer-body">
              <div>
                <strong>การใช้งานแอปที่ไม่เป็นทางการ</strong>
                <p>Liney ไม่ใช่แอป Official ของ LINE และไม่ได้รับการรับรองจาก LY Corporation การใช้ LINEJS อาจไม่สอดคล้องหรืออาจขัดกับ TOS ของ LINE บัญชีอาจถูกจำกัดหรือระงับ ใช้งานด้วยความระมัดระวังและความเสี่ยงของคุณเอง</p>
              </div></div>
            </details>
            <label className="auth-consent"><input type="checkbox" checked={riskAcknowledged} onChange={(event) => setRiskAcknowledged(event.currentTarget.checked)} /><span>ฉันอ่านคำเตือนแล้วและยอมรับความเสี่ยง</span></label>

            {authMode === "qr" && !qrUrl ? (
              <button className="auth-primary" disabled={!canLogin} onClick={onStart}>
                {authBusy ? <LoaderCircle className="spin" size={17}/> : <QrCode size={17}/>} {authBusy ? "กำลังสร้าง QR Code…" : "สร้าง QR Code"}
              </button>
            ) : null}
          </>
        )}

        {error && !(engineState === "ready" && !authBusy && !qrUrl && /SESSION|TOKEN_EXPIRED|UNAUTHORIZED/i.test(error)) ? <div className="auth-error" role="alert"><strong>{describeAuthError(error).title}</strong><span>{describeAuthError(error).message}</span>{describeAuthError(error).code ? <small>รหัสข้อผิดพลาด: {describeAuthError(error).code}</small> : null}</div> : null}
        {authenticated && !keyImportMode ? (
          <button className="auth-secondary-danger" onClick={() => void onLogout()}>ออกจากระบบบนเครื่องนี้</button>
        ) : null}
        <div className="auth-footnote">Client: {clientIdentity?.displayName || "Liney-Linux"} · Credential: {storageMode === "wallet" ? "Wallet / Secret Service" : storageMode === "encrypted-file" ? "Encrypted local fallback (AES-256-GCM · ย้ายเข้า Wallet อัตโนมัติเมื่อพร้อม)" : "session-only (ไม่ persist credential)"} · E2EE storage อยู่ที่ ~/.local/share/liney · ไม่มี Liney server กลาง</div>
      </motion.section>
    </motion.div>
  );
}

type NewChatTab = "chat" | "friend" | "group" | "openchat";

function NewChatModal({
  friends,
  onStartChat,
  onAddFriend,
  onCreateGroup,
  onCreateOpenChat,
  onClose,
}: {
  friends: Chat[];
  onStartChat: (friend: Chat) => void;
  onAddFriend: (userId: string) => Promise<Chat>;
  onCreateGroup: (name: string, memberMids: string[]) => Promise<Chat>;
  onCreateOpenChat: (name: string, description: string, searchable: boolean) => Promise<Chat>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<NewChatTab>("chat");
  const [search, setSearch] = useState("");
  const [lineId, setLineId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [openChatName, setOpenChatName] = useState("");
  const [openChatDescription, setOpenChatDescription] = useState("");
  const [openChatSearchable, setOpenChatSearchable] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const filteredFriends = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("th");
    if (!needle) return friends;
    return friends.filter((friend) => `${friend.name} ${friend.subtitle ?? ""}`.toLocaleLowerCase("th").includes(needle));
  }, [friends, search]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const addFriend = async () => {
    const value = lineId.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      const friend = await onAddFriend(value);
      setLineId("");
      onStartChat(friend);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createGroup = async () => {
    const name = groupName.trim();
    if (!name || selected.length === 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreateGroup(name, selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const createOpenChat = async () => {
    const name = openChatName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreateOpenChat(name, openChatDescription.trim(), openChatSearchable);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const switchTab = (next: NewChatTab) => {
    setTab(next);
    setSearch("");
    setError("");
  };

  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.section
        className="new-chat-modal"
        initial={{ opacity: 0, scale: 0.97, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.16 }}
        role="dialog"
        aria-modal="true"
        aria-label="เริ่มแชตใหม่"
      >
        <header className="new-chat-header">
          <div><p className="eyebrow">LINEY NEW</p><h2>เริ่มแชตใหม่</h2></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} title="ปิด"><X size={19} /></button>
        </header>

        <div className="new-chat-tabs" role="tablist">
          <button type="button" className={tab === "chat" ? "active" : ""} onClick={() => switchTab("chat")}><MessageCircle size={15}/> แชตใหม่</button>
          <button type="button" className={tab === "friend" ? "active" : ""} onClick={() => switchTab("friend")}><UserPlus size={15}/> เพิ่มเพื่อน</button>
          <button type="button" className={tab === "group" ? "active" : ""} onClick={() => switchTab("group")}><Users size={15}/> สร้างกลุ่ม</button>
          <button type="button" className={tab === "openchat" ? "active" : ""} onClick={() => switchTab("openchat")}><Sparkles size={15}/> OpenChat</button>
        </div>

        {error ? <div className="new-chat-error"><TriangleAlert size={15}/><span>{error}</span></div> : null}

        {tab === "friend" ? (
          <div className="new-chat-pane add-friend-pane">
            <div className="new-chat-hero"><UserPlus size={24}/><div><strong>เพิ่มเพื่อนด้วย LINE ID</strong><span>ค้นหา LINE ID แล้วเพิ่มเข้ารายชื่อเพื่อนโดยตรง</span></div></div>
            <label className="new-chat-field">
              <span>LINE ID</span>
              <div className="new-chat-input-row">
                <input
                  value={lineId}
                  onChange={(event) => setLineId(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void addFriend(); }}
                  placeholder="เช่น namnarak หรือ @official"
                  autoFocus
                  disabled={busy}
                />
                <button className="primary-button" type="button" onClick={() => void addFriend()} disabled={!lineId.trim() || busy}>
                  {busy ? <LoaderCircle className="spin" size={15}/> : <UserPlus size={15}/>} เพิ่มเพื่อน
                </button>
              </div>
            </label>
            <div className="new-chat-note"><Info size={14}/><span>บัญชีที่ปิดการค้นหาด้วย LINE ID จะค้นหาไม่พบตามข้อจำกัดของ LINE</span></div>
          </div>
        ) : tab === "openchat" ? (
          <div className="new-chat-pane add-friend-pane">
            <div className="new-chat-hero"><Sparkles size={24}/><div><strong>สร้าง OpenChat</strong><span>สร้าง Square/OpenChat ใหม่ผ่าน LINE โดยตรง</span></div></div>
            <label className="new-chat-field">
              <span>ชื่อ OpenChat</span>
              <input maxLength={50} value={openChatName} onChange={(event) => setOpenChatName(event.target.value)} placeholder="ชื่อ OpenChat" autoFocus disabled={busy} />
            </label>
            <label className="new-chat-field">
              <span>คำอธิบาย</span>
              <textarea maxLength={500} value={openChatDescription} onChange={(event) => setOpenChatDescription(event.target.value)} placeholder="รายละเอียดของ OpenChat (ไม่บังคับ)" disabled={busy} />
            </label>
            <button type="button" className={`new-chat-switch ${openChatSearchable ? "on" : ""}`} onClick={() => setOpenChatSearchable((value) => !value)} disabled={busy}>
              <span><strong>ค้นหา OpenChat นี้ได้</strong><small>อนุญาตให้คนอื่นค้นหาห้องจาก LINE</small></span>
              <span className="new-chat-switch-knob" />
            </button>
            <div className="new-chat-openchat-action">
              <button className="primary-button" type="button" onClick={() => void createOpenChat()} disabled={!openChatName.trim() || busy}>
                {busy ? <LoaderCircle className="spin" size={15}/> : <Sparkles size={15}/>} สร้าง OpenChat
              </button>
            </div>
          </div>
        ) : (
          <div className="new-chat-pane">
            {tab === "group" ? (
              <label className="new-chat-field group-name-field">
                <span>ชื่อกลุ่ม</span>
                <input maxLength={50} value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="ตั้งชื่อกลุ่ม" autoFocus />
              </label>
            ) : null}
            <div className="new-chat-search"><Search size={16}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === "group" ? "ค้นหาเพื่อนเพื่อเพิ่มเข้ากลุ่ม" : "ค้นหาเพื่อน"} /></div>
            <div className="new-chat-friends">
              {filteredFriends.length ? filteredFriends.map((friend) => {
                const checked = selected.includes(friend.id);
                return (
                  <button
                    type="button"
                    key={friend.id}
                    className={`new-chat-friend ${checked ? "selected" : ""}`}
                    onClick={() => {
                      if (tab === "chat") {
                        onStartChat(friend);
                        return;
                      }
                      setSelected((current) => checked ? current.filter((mid) => mid !== friend.id) : [...current, friend.id]);
                    }}
                  >
                    <Avatar chat={friend} />
                    <span className="new-chat-friend-copy"><strong>{friend.name}</strong><span>{friend.subtitle || "เพื่อน · LINE"}</span></span>
                    {tab === "group" ? <span className={`new-chat-check ${checked ? "checked" : ""}`}>{checked ? "✓" : ""}</span> : <MessageCircle size={17}/>}
                  </button>
                );
              }) : <div className="new-chat-empty"><Search size={22}/><strong>ไม่พบเพื่อน</strong><span>ลองค้นหาด้วยชื่ออื่น หรือเพิ่มเพื่อนด้วย LINE ID</span></div>}
            </div>
            {tab === "group" ? (
              <footer className="new-chat-footer">
                <span>เลือกแล้ว {selected.length.toLocaleString("th-TH")} คน</span>
                <button className="primary-button" type="button" onClick={() => void createGroup()} disabled={!groupName.trim() || selected.length === 0 || busy}>
                  {busy ? <LoaderCircle className="spin" size={15}/> : <Users size={15}/>} สร้างกลุ่ม
                </button>
              </footer>
            ) : null}
          </div>
        )}
      </motion.section>
    </motion.div>
  );
}

function SettingsModal({ initialTab, themeMode, dark, settings, callAvailable, onThemeMode, onSetting, onDensity, onRadius, onClearHistory, onClearStickerCache, onFullSync, onProfileChange, onClose }: {
  initialTab: string;
  themeMode: ThemeMode;
  dark: boolean;
  settings: AppSettings;
  callAvailable: boolean;
  onThemeMode: (value: ThemeMode) => void;
  onSetting: (key: keyof AppSettings, value: boolean) => void;
  onDensity: (value: AppSettings["density"]) => void;
  onRadius: (value: AppSettings["radius"]) => void;
  onClearHistory: () => void;
  onClearStickerCache: () => void;
  onFullSync: () => void;
  onProfileChange: (profile: ProfileResult) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const groups = [
    { title: "บัญชีและหน้าตา", pages: [
      { id: "ทั่วไป", name: "ทั่วไป", icon: Settings, description: "ภาษา ฟอนต์ และการเริ่มต้นแอป" },
      { id: "โปรไฟล์", name: "โปรไฟล์", icon: Users, description: "ดูและแก้ไขข้อมูลบัญชี LINE" },
      { id: "Appearance", name: "หน้าตาแอป", icon: Monitor, description: "ธีม ขนาดรายการ และรูปแบบการแสดงผล" },
    ] },
    { title: "การสื่อสาร", pages: [
      { id: "แชต", name: "แชต", icon: MessageCircle, description: "วิธีอ่าน ส่งข้อความ และจัดการประวัติ" },
      { id: "การแจ้งเตือน", name: "การแจ้งเตือน", icon: Bell, description: "เลือกข้อความและสายที่ต้องการแจ้งเตือน" },
      { id: "รูปภาพ", name: "รูปภาพและสื่อ", icon: Image, description: "การดูรูป ดาวน์โหลดสื่อ และการจัดเก็บแคช" },
      { id: "โทร", name: "การโทร", icon: Phone, description: "สถานะการโทรและความสามารถที่รองรับ" },
      { id: "เพื่อน", name: "เพื่อน", icon: UserPlus, description: "ตรวจสอบรายชื่อเพื่อนและการซิงก์" },
      { id: "OpenChat", name: "OpenChat", icon: Sparkles, description: "จัดการการแสดงผลและข้อมูลห้อง OpenChat" },
    ] },
    { title: "ระบบ", pages: [
      { id: "ขั้นสูง", name: "ขั้นสูง", icon: ShieldCheck, description: "ข้อมูลในเครื่องและเครื่องมือการซิงก์" },
      { id: "นักพัฒนา", name: "นักพัฒนา", icon: KeyRound, description: "เครื่องมือสำหรับตรวจสอบและแก้ปัญหา" },
      { id: "เกี่ยวกับ", name: "เกี่ยวกับ Liney", icon: Info, description: "รายละเอียดแอปและเวอร์ชัน" },
    ] },
  ];
  const currentGroup = groups.find((group) => group.pages.some((page) => page.id === tab));
  const currentPage = currentGroup?.pages.find((page) => page.id === tab);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <motion.div className="modal-backdrop settings-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <motion.section className="settings-modal settings-modal-refresh" role="dialog" aria-modal="true" aria-labelledby="liney-settings-heading" initial={{ opacity: 0, scale: 0.97, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: 8 }} transition={{ duration: 0.18 }}>
        <aside className="settings-nav" aria-label="หมวดหมู่การตั้งค่า">
          <div className="settings-nav-brand">
            <img src="/liney-logo.png" alt="" />
            <span><strong>Liney</strong><small>ตั้งค่าแอปพลิเคชัน</small></span>
          </div>
          <nav className="settings-nav-list" aria-label="หน้าในการตั้งค่า">
            {groups.map((group) => (
              <div className="settings-nav-group" key={group.title}>
                <p className="settings-nav-group-label">{group.title}</p>
                {group.pages.map((page) => {
                  const Icon = page.icon;
                  return (
                    <button type="button" key={page.id} className={tab === page.id ? "active" : ""}
                      aria-current={tab === page.id ? "page" : undefined}
                      onClick={() => setTab(page.id)}>
                      <Icon size={16} strokeWidth={1.9} /><span>{page.name}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="settings-nav-footer"><ShieldCheck size={14} />จัดการข้อมูลจากแอป Liney</div>
        </aside>
        <div className="settings-content">
          <header className="settings-header">
            <div className="settings-header-meta">
              <span className="settings-header-breadcrumb">ตั้งค่า / {currentGroup?.title ?? "ทั่วไป"}</span>
              <h2 id="liney-settings-heading">{currentPage?.name ?? tab}</h2>
              <p className="settings-header-description">{currentPage?.description ?? "การตั้งค่า Liney"}</p>
            </div>
            <button type="button" className="icon-button settings-close" onClick={onClose} title="ปิดหน้าตั้งค่า" aria-label="ปิดหน้าตั้งค่า"><X size={19} /></button>
          </header>
          {tab === "ทั่วไป" && <GeneralSettings settings={settings} themeMode={themeMode} dark={dark} onThemeMode={onThemeMode} onSetting={onSetting} />}
          {tab === "โปรไฟล์" && (lineyEngine.isNative ? <LineProfileSettings onUpdated={onProfileChange} /> : <FeatureSettings title="โปรไฟล์" body="เปิด LINE จากแอป Liney บน Linux เพื่อแก้โปรไฟล์" />)}
          {tab === "Appearance" && <AppearanceSettings settings={settings} themeMode={themeMode} dark={dark} onThemeMode={onThemeMode} onDensity={onDensity} onRadius={onRadius} />}
          {tab === "OpenChat" && <OpenChatSettings settings={settings} onSetting={onSetting} />}
          {tab === "การแจ้งเตือน" && <NotificationSettings settings={settings} onSetting={onSetting} />}
          {tab === "แชต" && <ChatSettings settings={settings} onSetting={onSetting} onClearHistory={onClearHistory} onClearStickerCache={onClearStickerCache} />}
          {tab === "รูปภาพ" && <MediaSettings settings={settings} onSetting={onSetting} />}
          {tab === "โทร" && <CallSettings available={callAvailable} />}
          {tab === "เพื่อน" && <div className="settings-scroll"><FriendSyncDiagnostics /></div>}
          {tab === "ขั้นสูง" && <AdvancedSettings onClearHistory={onClearHistory} onFullSync={onFullSync} />}
          {tab === "นักพัฒนา" && <DeveloperSettings settings={settings} onSetting={onSetting} />}
          {tab === "เกี่ยวกับ" && <AboutSettings />}
        </div>
      </motion.section>
    </motion.div>
  );
}

function GeneralSettings({ settings, themeMode, dark, onThemeMode, onSetting }: { settings: AppSettings; themeMode: ThemeMode; dark: boolean; onThemeMode: (v: ThemeMode) => void; onSetting: (key: keyof AppSettings, value: boolean) => void }) {
  return <div className="settings-scroll">
    <SettingsGroup title="ภาษาและฟอนต์">
      <SettingRow title="ภาษา" subtitle="ภาษาที่ใช้แสดงในแอป"><SelectLike value="ภาษาไทย" /></SettingRow>
      <SettingRow title="ฟอนต์" subtitle="ใช้ฟอนต์ของระบบเป็นค่าเริ่มต้น"><SelectLike value="System UI" /></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="เริ่มต้นระบบ">
      <SettingRow title="เปิดแอปพร้อมระบบ" subtitle="เริ่ม Liney เมื่อเข้าสู่เดสก์ท็อป"><Toggle checked={settings.startup} onChange={(checked) => onSetting("startup", checked)} /></SettingRow>
      <SettingRow title="ย่อไว้ใน System Tray" subtitle="ปิดหน้าต่างโดยไม่ออกจากระบบ"><Toggle checked={settings.tray} onChange={(checked) => onSetting("tray", checked)} /></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="Appearance">
      <SettingRow title="ปรับตามธีมระบบ" subtitle="ติดตาม Light / Dark ของเดสก์ท็อประบบแบบอัตโนมัติ"><Toggle checked={themeMode === "system"} onChange={(checked) => onThemeMode(checked ? "system" : (dark ? "dark" : "light"))} /></SettingRow>
      <ThemeCards themeMode={themeMode} dark={dark} onThemeMode={onThemeMode} />
    </SettingsGroup>
  </div>;
}

function AppearanceSettings({ settings, themeMode, dark, onThemeMode, onDensity, onRadius }: { settings: AppSettings; themeMode: ThemeMode; dark: boolean; onThemeMode: (v: ThemeMode) => void; onDensity: (value: AppSettings["density"]) => void; onRadius: (value: AppSettings["radius"]) => void }) {
  return <div className="settings-scroll">
    <SettingsGroup title="ธีม"><ThemeCards themeMode={themeMode} dark={dark} onThemeMode={onThemeMode} /></SettingsGroup>
    <SettingsGroup title="ความหนาแน่น">
      <SettingRow title="ระยะห่างของรายการ" subtitle="กำหนดความแน่นของรายการแชต"><Segment options={["Compact", "Comfortable", "Spacious"]} selected={settings.density} onChange={(value) => onDensity(value as AppSettings["density"])} /></SettingRow>
      <SettingRow title="มุมโค้ง" subtitle="ใช้มุมโค้งแบบ modern desktop"><Segment options={["Soft", "Round"]} selected={settings.radius} onChange={(value) => onRadius(value as AppSettings["radius"])} /></SettingRow>
    </SettingsGroup>
  </div>;
}

function NotificationSettings({ settings, onSetting }: { settings: AppSettings; onSetting: (key: keyof AppSettings, value: boolean) => void }) {
  return <div className="settings-scroll">
    <SettingsGroup title="วิธีการแจ้งเตือน">
      <SettingRow title="แจ้งเตือนบนเดสก์ท็อป" subtitle="ใช้ระบบแจ้งเตือนของเดสก์ท็อปที่กำลังใช้งาน"><Toggle checked={settings.desktopNotifications} onChange={(checked) => onSetting("desktopNotifications", checked)} /></SettingRow>
      <SettingRow title="แสดงตัวอย่างข้อความ" subtitle="แสดงเนื้อหาใน notification"><Toggle checked={settings.notificationPreview} onChange={(checked) => onSetting("notificationPreview", checked)} /></SettingRow>
      <SettingRow title="เสียงแจ้งเตือนข้อความ" subtitle="เล่นเสียงเมื่อมีข้อความใหม่"><Toggle checked={settings.notificationSound} onChange={(checked) => onSetting("notificationSound", checked)} /></SettingRow>
      <SettingRow title="แจ้งเตือนสายเข้า" subtitle="แสดงการแจ้งเตือนของเดสก์ท็อปเมื่อมีคนโทรเข้า"><Toggle checked={settings.callNotifications} onChange={(checked) => onSetting("callNotifications", checked)} /></SettingRow>
      <SettingRow title="เสียงสายโทร" subtitle="เล่น ringtone ตอนสายเข้า และ ringback ตอนโทรออก"><Toggle checked={settings.callSound} onChange={(checked) => onSetting("callSound", checked)} /></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="เสียง">
      <SettingRow title="เสียงเริ่มต้น" subtitle="Liney Soft + Liney Call"><span className="settings-status status-good">เสียงข้อความและเสียงโทรตั้งค่าแยกกัน</span></SettingRow>
    </SettingsGroup>
  </div>;
}

function OpenChatSettings({ settings, onSetting }: { settings: AppSettings; onSetting: (key: keyof AppSettings, value: boolean) => void }) {
  return <div className="settings-scroll">
    <div className="feature-banner">
      <div className="feature-icon"><Sparkles size={21}/></div>
      <div><strong>OpenChat powered by LINEJS Square</strong><p>รายการและ event โหลดจาก LINEJS โดยตรงเมื่อเปิดใช้งาน</p></div>
      <span className="beta-chip">ENGINE READY</span>
    </div>
    <SettingsGroup title="OpenChat">
      <SettingRow title="แสดง OpenChat แยกจากแชตปกติ" subtitle="เพิ่มแท็บ OpenChat บนแถบซ้าย"><Toggle checked={settings.openchat} onChange={(checked) => onSetting("openchat", checked)} /></SettingRow>
      <SettingRow title="LiveTalk" subtitle="จะเปิดเมื่อมี implementation และ live test ครบ"><span className="settings-status">ยังไม่รองรับ</span></SettingRow>
      <SettingRow title="อัปเดตแบบ Realtime" subtitle="ใช้ push event และ polling fallback เมื่อ stream ของ Square เงียบ"><Toggle checked={settings.openchatRealtimeRefresh} onChange={(checked) => onSetting("openchatRealtimeRefresh", checked)} /></SettingRow>
      <SettingRow title="ดาวน์โหลดสื่ออัตโนมัติ" subtitle="รูปภาพจากห้อง OpenChat"><Toggle checked={settings.autoMedia} onChange={(checked) => onSetting("autoMedia", checked)} /></SettingRow>
    </SettingsGroup>
  </div>;
}

function ChatSettings({ settings, onSetting, onClearHistory, onClearStickerCache }: { settings: AppSettings; onSetting: (key: keyof AppSettings, value: boolean) => void; onClearHistory: () => void; onClearStickerCache: () => void }) {
  return <div className="settings-scroll">
    <SettingsGroup title="การอ่านข้อความ">
      <SettingRow title="อ่านเมื่อเลื่อนถึงข้อความล่าสุด" subtitle="ข้อความใหม่จะยังไม่ถูกอ่านจนกว่าจะเลื่อนถึงด้านล่าง"><Toggle checked={settings.markReadOnBottom} onChange={(checked) => onSetting("markReadOnBottom", checked)} /></SettingRow>
      <SettingRow title="เส้นข้อความใหม่" subtitle="แสดงคำว่า ‘ข้อความใหม่’ ก่อนข้อความที่ยังไม่ได้อ่าน"><Toggle checked={settings.showUnreadDivider} onChange={(checked) => onSetting("showUnreadDivider", checked)} /></SettingRow>
      <SettingRow title="จำนวนคนที่อ่าน" subtitle="ข้อความที่คุณส่งจะแสดงจำนวนผู้อ่านเมื่อ LINE ส่งข้อมูลมา"><Toggle checked={settings.showReadCount} onChange={(checked) => onSetting("showReadCount", checked)} /></SettingRow>
      <SettingRow title="ตามข้อความล่าสุดอัตโนมัติ" subtitle="ถ้าอยู่ท้ายแชต ให้เลื่อนตามข้อความใหม่โดยไม่เด้งตอนกำลังอ่านข้อความเก่า"><Toggle checked={settings.autoScrollNewMessages} onChange={(checked) => onSetting("autoScrollNewMessages", checked)} /></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="ประวัติและแคช">
      <SettingRow title="ล้างประวัติในเครื่อง" subtitle="ล้าง SQLite history และ media cache โดยไม่ลบข้อความบน LINE"><button className="secondary-button danger-outline" type="button" onClick={onClearHistory}>ล้างประวัติ</button></SettingRow>
      <SettingRow title="ล้างแคชสติกเกอร์" subtitle="ดึงรายการสติกเกอร์ที่เป็นเจ้าของใหม่"><button className="secondary-button" type="button" onClick={onClearStickerCache}>ล้างแคช</button></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="การส่งข้อความ"><SettingRow title="Outbox recovery" subtitle="ข้อความมี local ID, retry และกู้สถานะหลัง timeout"><span className="settings-status status-good">เปิดใช้งาน</span></SettingRow></SettingsGroup>
  </div>;
}

function MediaSettings({ settings, onSetting }: { settings: AppSettings; onSetting: (key: keyof AppSettings, value: boolean) => void }) {
  return <div className="settings-scroll">
    <SettingsGroup title="ตัวดูรูปภาพ">
      <SettingRow title="เปิดรูปในหน้าต่างแยก" subtitle="ใช้หน้าต่างดูรูปแบบ LINE และไม่บังหน้าต่างแชตหลัก"><Toggle checked={settings.openImagesInWindow} onChange={(checked) => onSetting("openImagesInWindow", checked)} /></SettingRow>
      <SettingRow title="วนรูปเมื่อถึงรูปสุดท้าย" subtitle="กดลูกศรถัดไปจากรูปสุดท้ายเพื่อกลับไปรูปแรก"><Toggle checked={settings.loopImageGallery} onChange={(checked) => onSetting("loopImageGallery", checked)} /></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="การโหลดสื่อ">
      <SettingRow title="โหลดรูป OpenChat อัตโนมัติ" subtitle="ปิดได้หากต้องการลดการใช้เน็ตใน OpenChat"><Toggle checked={settings.autoMedia} onChange={(checked) => onSetting("autoMedia", checked)} /></SettingRow>
      <SettingRow title="รูปในแชต" subtitle="แคช preview ในเครื่องและเปิดรูปเต็มจากหน้าต่างดูรูป"><span className="settings-status status-good">Cache-first</span></SettingRow>
    </SettingsGroup>
  </div>;
}

function CallSettings({ available }: { available: boolean }) {
  return <div className="settings-scroll">
    <div className="feature-banner"><div className="feature-icon"><Phone size={21}/></div><div><strong>เสียง 1:1</strong><p>{available ? "PipeWire + Opus พร้อม · ขาออกใช้ PLANET และขาเข้าใช้ Andromeda answer flow" : "ยังไม่รองรับบนระบบนี้"}</p></div><span className={`beta-chip ${available ? "status-good" : ""}`}>{available ? "CALL READY" : "DISABLED"}</span></div>
    <SettingsGroup title="ขอบเขตการโทร">
      <SettingRow title="เสียง 1:1 ขาออก" subtitle="PLANET/Cassini · โทรออก mute เลือกลำโพง และวางสาย"><span className={`settings-status ${available ? "status-good" : ""}`}>{available ? "เปิดใช้งาน" : "ยังไม่พร้อม"}</span></SettingRow>
      <SettingRow title="สายเรียกเข้า" subtitle="Andromeda INVITE → 100/180/200 → ACK + SRTP/Opus"><span className={`settings-status ${available ? "status-good" : ""}`}>{available ? "Experimental · เปิดรับสาย" : "ยังไม่พร้อม"}</span></SettingRow>
      <SettingRow title="ปฏิเสธสาย" subtitle="ปิดหน้ารับสายในเครื่อง; LINEJS 3.4.2 ยังไม่มี reject RPC ระดับสูง"><span className="settings-status">Local dismiss</span></SettingRow>
      <SettingRow title="วิดีโอ / group call / LiveTalk" subtitle="ยังไม่เปิดจนกว่า media lifecycle และ live test จะครบ"><span className="settings-status">ปิดไว้</span></SettingRow>
    </SettingsGroup>
  </div>;
}

function FeatureSettings({ title, body }: { title: string; body: string }) {
  return <div className="settings-scroll"><div className="settings-placeholder"><div className="placeholder-orb"><Users size={25}/></div><h3>{title}</h3><p>{body}</p><span className="settings-status status-good">เชื่อมกับ LINE โดยตรง</span></div></div>;
}

function AdvancedSettings({ onClearHistory, onFullSync }: { onClearHistory: () => void; onFullSync: () => void }) {
  return <div className="settings-scroll"><SettingsGroup title="การดูแลข้อมูล"><SettingRow title="ล้างข้อมูลในเครื่อง" subtitle="ใช้เมื่อจะส่งต่อเครื่องหรือแก้ปัญหา database"><button className="secondary-button danger-outline" type="button" onClick={onClearHistory}>ล้างประวัติ</button></SettingRow></SettingsGroup><SettingsGroup title="การเชื่อมต่อ"><SettingRow title="Full sync" subtitle="ซิงก์ friends, Talk, OpenChat และประวัติล่าสุดเมื่อสั่งแบบเต็ม"><button className="secondary-button" type="button" onClick={onFullSync}>เริ่ม Full sync</button></SettingRow></SettingsGroup></div>;
}

function DeveloperSettings({ settings, onSetting }: { settings: AppSettings; onSetting: (key: keyof AppSettings, value: boolean) => void }) {
  return <div className="settings-scroll">
    <SettingsGroup title="เครื่องมือสำหรับนักพัฒนา">
      <SettingRow title="Flex / Rich → Raw JSON" subtitle="แสดง JSON แทนการ์ดข้อความ Flex และ Rich เพื่อ Debug สามารถสลับกลับในแต่ละข้อความได้ และอาจมีข้อมูลส่วนตัวของข้อความ">
        <Toggle checked={settings.developerFlexRaw} onChange={(enabled) => onSetting("developerFlexRaw", enabled)} />
      </SettingRow>
    </SettingsGroup>
  </div>;
}

function AboutSettings() {
  return <div className="settings-scroll"><div className="settings-placeholder"><div className="placeholder-orb"><Info size={25}/></div><h3>Liney 0.1.0</h3><p>Unofficial LINE client สำหรับ Linux · React + Tauri WebView · SQLite history · ไม่มีเซิร์ฟเวอร์กลาง</p><span className="settings-status status-good">production patch</span></div></div>;
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="settings-group"><h3>{title}</h3><div className="settings-card">{children}</div></section>;
}

function SettingRow({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}</strong><span>{subtitle}</span></div><div className="setting-control">{children}</div></div>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange?: (checked: boolean) => void }) {
  return <button type="button" className={`toggle ${checked ? "on" : ""}`} aria-pressed={checked} onClick={() => onChange?.(!checked)}><span /></button>;
}

function SelectLike({ value }: { value: string }) {
  return <output className="settings-static-value">{value}</output>;
}

function Segment({ options, selected, onChange }: { options: string[]; selected: string; onChange: (value: string) => void }) {
  return <div className="segment">{options.map((item) => <button type="button" key={item} className={selected === item ? "active" : ""} onClick={() => onChange(item)}>{item}</button>)}</div>;
}

function ThemeCards({ themeMode, dark, onThemeMode }: { themeMode: ThemeMode; dark: boolean; onThemeMode: (v: ThemeMode) => void }) {
  return <div className="theme-cards">
    <button className={`theme-card ${themeMode === "system" ? "active" : ""}`} onClick={() => onThemeMode("system")}><Monitor size={18}/><div className={`theme-preview ${dark ? "dark-preview" : "light-preview"}`}><i/><i/><i/></div><span>System</span></button>
    <button className={`theme-card ${themeMode === "light" ? "active" : ""}`} onClick={() => onThemeMode("light")}><Sun size={18}/><div className="theme-preview light-preview"><i/><i/><i/></div><span>Light</span></button>
    <button className={`theme-card ${themeMode === "dark" ? "active" : ""}`} onClick={() => onThemeMode("dark")}><Moon size={18}/><div className="theme-preview dark-preview"><i/><i/><i/></div><span>Dark</span></button>
  </div>;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsDataURL(file);
  });
}

function clipboardImageFromData(data: DataTransfer | null): File | null {
  if (!data) return null;

  const directFile = Array.from(data.files).find((file) => file.type.toLowerCase().startsWith("image/"));
  if (directFile) return directFile;

  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.toLowerCase().startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

function defaultMediaFilename(mime?: string): string {
  const value = mime?.toLowerCase();
  const extension = value === "image/png"
    ? "png"
    : value === "image/gif"
      ? "gif"
      : value === "image/webp"
        ? "webp"
        : value === "image/avif"
          ? "avif"
          : value === "image/bmp"
            ? "bmp"
            : value === "image/jpeg"
              ? "jpg"
              : "jpg";
  return `pasted-image.${extension}`;
}

function mimeFromFilename(filename: string): string {
  const extension = filename.toLowerCase().split(".").at(-1);
  return ({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    mp4: "video/mp4",
    m4v: "video/x-m4v",
    mov: "video/quicktime",
    webm: "video/webm",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    pdf: "application/pdf",
    zip: "application/zip",
    txt: "text/plain",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function mediaContentTypeForMime(mime: string): number {
  const value = mime.toLowerCase();
  if (value.startsWith("image/")) return 1;
  if (value.startsWith("video/")) return 2;
  if (value.startsWith("audio/")) return 3;
  return 14;
}

function formatSendError(value: unknown): string {
  const raw = String(value ?? "").trim();
  const normalized = raw.toLowerCase();
  if (normalized.includes("still rejects") || normalized.includes("reconnect this line account")) {
    return "LINE ยังปฏิเสธคีย์เข้ารหัสหลังต่ออายุแล้ว ต้องเชื่อมบัญชี LINE ใหม่ด้วย QR";
  }
  if (raw.includes("E2EE_UPDATE_SENDER_KEY") || normalized.includes("invalid sender key")) {
    return "LINE ปฏิเสธคีย์เข้ารหัสเดิม กดลองใหม่เพื่อให้ Liney ต่ออายุคีย์ก่อนส่ง";
  }
  return raw.length > 180 ? raw.slice(0, 177) + "…" : raw;
}

function mediaLabel(contentType: number, filename: string): string {
  const label = contentType === 2 ? "วิดีโอ" : contentType === 3 ? "เสียง" : contentType === 14 ? "ไฟล์" : "รูปภาพ";
  return filename ? `${label}: ${filename}` : label;
}

function hasUserVisibleMessageText(message: Message): boolean {
  const text = String(message.text ?? "").trim();
  if (!text) return false;
  const placeholders: Record<number, string[]> = {
    1: ["รูปภาพ", "image", "photo"],
    2: ["วิดีโอ", "video"],
    3: ["ข้อความเสียง", "เสียง", "audio"],
    14: ["ไฟล์", "file"],
  };
  return !(placeholders[Number(message.contentType ?? 0)] ?? []).includes(text.toLowerCase());
}

function formatListTime(value: number) {
  const date = new Date(Number(value));
  if (!value || Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  const delta = now.getTime() - date.getTime();
  if (delta < 7 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat("th-TH", { weekday: "short" }).format(date);
  }
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short" }).format(date);
}

function formatTime(value: number) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "ตอนนี้";
  return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2)).toUpperCase();
}

function avatarColor(index: number) {
  const palette = ["#f28bad", "#4f8cff", "#ffb86b", "#2fcf78", "#a78bfa", "#55c2c3", "#ef7a64", "#6f86d6"];
  return palette[index % palette.length];
}

function CallModal({
  chat,
  peer,
  remoteVideoFrame,
  state,
  muted,
  microphoneAvailable,
  speakerAvailable,
  videoCapable,
  videoEnabled,
  mode,
  cameraAvailable,
  screenSharing,
  screenShareAvailable,
  screenTargets,
  screenTarget,
  screenManagedBySystem,
  error,
  incomingSupported,
  outputDevices,
  outputTarget,
  onAccept,
  onAcceptVideo,
  onReject,
  onMute,
  onVideo,
  onScreenShare,
  onUpgradeVideo,
  onScreenTarget,
  onOutput,
  onClose,
}: {
  chat: Chat;
  peer: string;
  remoteVideoFrame: string;
  state: CallState;
  muted: boolean;
  microphoneAvailable: boolean;
  speakerAvailable: boolean;
  videoCapable: boolean;
  videoEnabled: boolean;
  mode: "AUDIO" | "VIDEO";
  cameraAvailable: boolean;
  screenSharing: boolean;
  screenShareAvailable: boolean;
  screenTargets: ScreenShareTargetResult[];
  screenTarget: string;
  screenManagedBySystem: boolean;
  error: string;
  incomingSupported: boolean;
  outputDevices: AudioDeviceResult[];
  outputTarget: string;
  onAccept: () => void;
  onAcceptVideo: () => void;
  onReject: () => void;
  onMute: () => void;
  onVideo: () => void;
  onScreenShare: () => void;
  onUpgradeVideo: () => void;
  onScreenTarget: (target: string) => void;
  onOutput: (target: string) => void;
  onClose: () => void;
}) {
  const status = state === "incoming"
    ? "สายเรียกเข้า"
    : state === "acquiring"
      ? "กำลังเตรียมการโทร…"
      : state === "connecting"
        ? "กำลังเชื่อมต่อ…"
        : state === "ringing"
          ? "กำลังเรียก…"
          : state === "in-call"
            ? "กำลังสนทนา"
            : state === "failed"
              ? "สายเสียงไม่พร้อม"
              : state === "ended"
                ? "สิ้นสุดการโทร"
                : "สายเสียง";
  return <motion.div className="call-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.div className={"call-card" + (remoteVideoFrame ? " has-video" : "")} initial={{ scale: .94, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: .96, y: 10 }}>
      <button className="call-expand" type="button" aria-label="ปิดหน้าต่าง" onClick={onClose}><Maximize2 size={16}/></button>
      {remoteVideoFrame
        ? <img className="call-remote-video" src={remoteVideoFrame} alt={"วิดีโอจาก " + (chat.name || peer)} />
        : <Avatar chat={chat} size="large" />}
      <h2>{chat.name || peer}</h2>
      <p>{status}</p>
      {error ? <div className="call-note call-error" role="status" aria-live="polite">{error}</div> : null}
      {state === "in-call" ? <div className="call-wave" aria-label={muted ? "ปิดไมโครโฟน" : "กำลังสนทนา"}><i/><i/><i/><i/><i/></div> : null}
      {state === "in-call" && videoCapable && !remoteVideoFrame
        ? <div className="call-remote-wait">รอภาพจากอีกฝั่ง · ภาพจะแสดงเมื่อเขาเปิดกล้อง</div>
        : null}
      {state === "incoming" ? (
        <div className="call-actions">
          <button className="hangup" type="button" onClick={onReject}><Phone size={20}/><span>ปฏิเสธ</span></button>
          <button type="button" disabled={!incomingSupported} title={incomingSupported ? "รับเป็นสายเสียง" : "ระบบรับสายยังไม่พร้อมบนเครื่องนี้"} onClick={onAccept}><Phone size={20}/><span>{incomingSupported ? "รับเสียง" : "รับสายยังไม่พร้อม"}</span></button>
          <button type="button" disabled={!incomingSupported} title={incomingSupported ? "รับเป็นวิดีโอคอล" : "ระบบรับสายยังไม่พร้อมบนเครื่องนี้"} onClick={onAcceptVideo}><Video size={20}/><span>รับวิดีโอ</span></button>
        </div>
      ) : state === "failed" || state === "ended" ? (
        <button className="secondary-button" type="button" onClick={onClose}>ปิด</button>
      ) : (
        <div className="call-actions">
          <button
            type="button"
            className={muted ? "active" : ""}
            disabled={!microphoneAvailable}
            title={microphoneAvailable ? (muted ? "เปิดไมค์" : "ปิดไมค์") : "ไม่พบไมโครโฟน · สายยังทำงานและฟังอีกฝั่งได้"}
            onClick={onMute}
          ><Mic size={19}/><span>{microphoneAvailable ? (muted ? "เปิดไมค์" : "ปิดไมค์") : "ไม่มีไมค์"}</span></button>
          <button
            type="button"
            className={videoEnabled ? "active" : ""}
            aria-pressed={videoEnabled}
            disabled={!videoCapable || !cameraAvailable}
            title={!videoCapable ? (mode === "AUDIO" ? "สายเสียงต้องเปลี่ยนเป็นวิดีโอคอลก่อน" : "LINE ยังไม่ได้เจรจาช่องวิดีโอ") : !cameraAvailable ? "ไม่พบกล้อง · แชร์หน้าจอยังใช้ได้" : videoEnabled ? "ปิดกล้อง" : "เปิดกล้อง"}
            onClick={onVideo}
          ><Video size={20}/><span>{videoEnabled ? "ปิดกล้อง" : cameraAvailable ? "กล้อง" : "ไม่มีกล้อง"}</span></button>
          <button
            type="button"
            className={screenSharing ? "active" : ""}
            aria-pressed={screenSharing}
            disabled={!videoCapable || !screenShareAvailable}
            title={!videoCapable ? (mode === "AUDIO" ? "สายเสียงต้องเปลี่ยนเป็นวิดีโอคอลก่อน" : "LINE ยังไม่ได้เจรจาช่องวิดีโอ") : !screenShareAvailable ? "ระบบจับภาพหน้าจอยังไม่พร้อม" : screenSharing ? "หยุดแชร์หน้าจอ" : "แชร์หน้าจอ"}
            onClick={onScreenShare}
          ><Monitor size={20}/><span>{screenSharing ? "หยุดแชร์" : "แชร์จอ"}</span></button>
          {!screenManagedBySystem && screenTargets.length ? <label className="call-device-picker" title={screenSharing ? "หยุดแชร์ก่อนเปลี่ยนเป้าหมาย" : "เลือกจอ หน้าต่าง หรือพื้นที่ที่ต้องการแชร์"}>
            <Monitor size={19}/>
            <span>เป้าหมาย</span>
            <select
              aria-label="เป้าหมายแชร์หน้าจอ"
              value={screenTarget}
              onChange={(event) => onScreenTarget(event.target.value)}
              disabled={screenSharing}
            >
              {screenTargets.map((target) => <option key={target.id} value={target.id}>
                {target.kind === "desktop" ? "ทั้งเดสก์ท็อป" : target.kind === "monitor" ? "จอ · " + target.name : target.kind === "window" ? "หน้าต่าง · " + target.name : "เลือกพื้นที่ด้วยเมาส์"}
              </option>)}
            </select>
          </label> : null}
          <label className="call-device-picker" title={speakerAvailable && outputDevices.length ? "เลือกอุปกรณ์เสียงออก" : "ไม่พบลำโพง · สายยังเชื่อมต่อได้"}>
            <Volume2 size={19}/>
            <span>{speakerAvailable ? "ลำโพง" : "ไม่มีลำโพง"}</span>
            <select aria-label="อุปกรณ์เสียงออก" value={outputTarget} onChange={(event) => onOutput(event.target.value)} disabled={!speakerAvailable || !outputDevices.length}>
              <option value="">ค่าเริ่มต้น</option>
              {outputDevices.map((device) => <option key={device.id} value={device.id}>{device.description || device.name}</option>)}
            </select>
          </label>
          <button className="hangup" type="button" onClick={onClose}><Phone size={20}/><span>วางสาย</span></button>
        </div>
      )}
      {state === "in-call" && !videoCapable && mode === "AUDIO" ? (
        <div className="call-video-upgrade">
          <span>กล้องและแชร์จอต้องเริ่มผ่านวิดีโอคอล</span>
          <button type="button" onClick={onUpgradeVideo}>เริ่มวิดีโอคอลใหม่</button>
        </div>
      ) : null}
      {state === "in-call" && !videoCapable && mode === "VIDEO" ? (
        <div className="call-capability-note" role="status">LINE ยังไม่ได้เปิดช่องวิดีโอสำหรับสายนี้</div>
      ) : null}
      <div className="call-note">
        {state === "incoming"
          ? "LINE 1:1 · สายเรียกเข้า"
          : state === "in-call"
            ? videoCapable
              ? screenSharing ? "กำลังแชร์หน้าจอ" : videoEnabled ? "กำลังส่งวิดีโอ" : remoteVideoFrame ? "กำลังรับวิดีโอจากอีกฝั่ง" : "วิดีโอพร้อม · รออีกฝั่งเปิดกล้อง"
              : mode === "AUDIO" ? "สายเสียง 1:1" : "สายวิดีโอ 1:1"
            : "LINE 1:1"}
      </div>
    </motion.div>
  </motion.div>;
}
