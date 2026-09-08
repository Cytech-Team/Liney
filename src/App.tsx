import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createPortal } from "react-dom";
import {
  Bell,
  ChevronDown,
  Ellipsis,


  KeyRound,
  Image,
  Info,
  LoaderCircle,
  LogIn,
  Maximize2,
  Mail,
  MessageCircle,
  Mic,
  Minus,
  Moon,
  Monitor,
  Paperclip,
  Pin as PinIcon,
  Phone,
  Plus,
  QrCode,
  Reply,
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
  Video,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import "./App.css";
import { chats as seedChats, messages as seedMessages, type Chat, type Message } from "./data/mock";
import { FlexMessage, type FlexAction } from "./components/FlexMessage";
import { RichMessage } from "./components/RichMessage";
import { EngineRequestError, lineyEngine } from "./lib/engine";

type Section = "messages" | "friends" | "openchat" | "calls";
type ImageEditorTool = "view" | "draw" | "blur" | "text";
type ThemeMode = "system" | "light" | "dark";
type AuthMode = "qr" | "password";
type EngineState = "browser-mock" | "starting" | "ready" | "error";
type CallState = "idle" | "incoming" | "acquiring" | "connecting" | "ringing" | "in-call" | "ending" | "ended" | "failed";
type LiveChatResult = { id: string; name: string; kind: "dm" | "group" | "openchat"; avatarUrl?: string; preview?: string; unread?: number; lastMessageTime?: number; memberCount?: number; pinned?: boolean; favoriteTimestamp?: number; statusMessage?: string; isFavorite?: boolean; favoriteTime?: number };
type LiveMessageResult = {
  id: string;
  localId?: string;
  text: string;
  isMine: boolean;
  createdTime: number;
  chatId?: string;
  contentType?: number;
  senderId?: string;
  senderName?: string;
  senderAvatarUrl?: string;
  stickerUrl?: string;
  emojiUrl?: string;
  flex?: Message["flex"];
  filename?: string;
  postNotification?: Message["postNotification"];
  rich?: Message["rich"];
  reactions?: Message["reactions"];
  replyTo?: Message["replyTo"];
  replyToId?: string;
  unsent?: boolean;
  readByPeer?: boolean;
  status?: Message["status"];
};
type ReplyTarget = NonNullable<Message["replyTo"]>;
type MediaPreviewResult = { dataUrl: string };
type NativeClipboardImageResult = { base64: string; mime: string; filename: string };
type MediaProgress = { phase: string; done: number; total: number };
type AudioDeviceResult = { id: string; name: string; description: string; kind: "input" | "output" };
type ProfileResult = { displayName?: string; mid?: string; pictureStatus?: string; statusMessage?: string };
type RecentSticker = { packageId: string; stickerId: string; version: string; option?: string; owned: boolean };
type RecentEmoji = { productId: string; sticonId: string; version: string; resourceType: string; owned: boolean };
type SyncProgressState = { visible: boolean; phase: "metadata" | "friends" | "chats" | "history" | "complete" | "error"; done: number; total: number; failed: number; summary?: { friends?: number; talkChats?: number; openChats?: number; histories?: number; failedHistories?: number; elapsedMs?: number } };

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
  openchat: boolean;
  liveTalk: boolean;
  autoMedia: boolean;
  density: "Compact" | "Comfortable" | "Spacious";
  radius: "Soft" | "Round";
};

const defaultSettings: AppSettings = {
  startup: true,
  tray: true,
  desktopNotifications: true,
  notificationPreview: true,
  notificationSound: true,
  openchat: true,
  liveTalk: false,
  autoMedia: true,
  density: "Comfortable",
  radius: "Round",
};

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

function liveMessagePreview(message: LiveMessageResult): string {
  const richAltText = String(message.rich?.altText ?? "").replace(/\s+/g, " ").trim();
  if (Number(message.contentType ?? 0) === 17 && richAltText) return richAltText;
  const text = String(message.text ?? "").replace(/\s+/g, " ").trim();
  if (text && !["IMAGE", "VIDEO", "AUDIO", "STICKER", "FILE", "FLEX"].includes(text.toUpperCase())) return text;
  switch (Number(message.contentType ?? 0)) {
    case 1: return "รูปภาพ";
    case 2: return "วิดีโอ";
    case 3: return "เสียง";
    case 7: return "สติกเกอร์";
    case 14: return "ไฟล์";
    case 16: return "มีโพสต์ใหม่";
    case 17: return richAltText || "Rich message";
    case 22: return "Flex message";
    default: return text || "ข้อความใหม่";
  }
}

async function notifyDesktop(
  title: string,
  body: string,
  enabled: boolean,
  soundEnabled: boolean,
  target: { chatId: string; messageId: string },
  onFallbackClick: () => void,
): Promise<void> {
  if (!enabled) return;
  try {
    if (lineyEngine.isNative) {
      await invoke("notify_message", { title, body, chatId: target.chatId, messageId: target.messageId, sound: soundEnabled });
      return;
    }
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return;
    const notification = new Notification(title, { body });
    notification.onclick = () => { window.focus(); onFallbackClick(); notification.close(); };
  } catch {
    // Notification availability is owned by the desktop environment.
  }
}

const navItems: { id: Section; label: string; icon: typeof MessageCircle }[] = [
  { id: "messages", label: "แชต", icon: MessageCircle },
  { id: "friends", label: "เพื่อน", icon: Users },
  { id: "openchat", label: "OpenChat", icon: Sparkles },
  { id: "calls", label: "โทร", icon: Phone },
];

export default function App() {
  return <MainApp />;
}

function MainApp() {
  const [section, setSection] = useState<Section>("messages");
  const [activeChatId, setActiveChatId] = useState(lineyEngine.isNative ? "" : "nagi");
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [callState, setCallState] = useState<CallState>("idle");
  const [, setCallId] = useState("");
  const [callPeer, setCallPeer] = useState("");
  const [callMuted, setCallMuted] = useState(false);
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
  const [imageViewerSrc, setImageViewerSrc] = useState<string | null>(null);
  const [notificationJump, setNotificationJump] = useState<{ chatId: string; messageId: string; nonce: number } | null>(null);
  const [liveChats, setLiveChats] = useState<Chat[] | null>(null);
  const [liveFriends, setLiveFriends] = useState<Chat[] | null>(null);
  const [listFilter, setListFilter] = useState<"all" | "unread" | "pinned" | "favorites">("all");
  const [localPins, setLocalPins] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem("liney.localPins");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [profile, setProfile] = useState<ProfileResult | null>(null);
  const [composer, setComposer] = useState("");
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [messageMap, setMessageMap] = useState<Record<string, Message[]>>(lineyEngine.isNative ? {} : seedMessages);
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
  const [engineState, setEngineState] = useState<EngineState>(lineyEngine.isNative ? "starting" : "browser-mock");
  const [engineVersion, setEngineVersion] = useState("3.3.2");
  const [syncStatus, setSyncStatus] = useState("");
  const [syncProgress, setSyncProgress] = useState<SyncProgressState>({ visible: false, phase: "metadata", done: 0, total: 0, failed: 0 });
  const [storageMode, setStorageMode] = useState<"wallet" | "session-only">("session-only");
  const [settings, setSettings] = useState<AppSettings>(readSettings);
  const [windowActive, setWindowActive] = useState(() =>
    document.visibilityState === "visible" && document.hasFocus()
  );
  const settingsRef = useRef(settings);
  const activeChatRef = useRef(activeChatId);
  const liveChatsRef = useRef<Chat[] | null>(null);
  const liveFriendsRef = useRef<Chat[] | null>(null);
  const liveChatsLoadGenerationRef = useRef(0);
  const liveFriendsLoadGenerationRef = useRef(0);
  const messageLoadGenerationRef = useRef(new Map<string, number>());
  const readMarkedRef = useRef(new Set<string>());
  const notificationDedupRef = useRef(new Map<string, number>());
  const liveEventDedupRef = useRef(new Map<string, number>());

  // Being the selected chat is not enough to acknowledge a message.  KDE can
  // leave the webview selected while the window is minimized or behind another
  // app, so only send read receipts while the user can actually see it.
  const isChatActuallyVisible = (chatId: string) =>
    chatId === activeChatRef.current
    && document.visibilityState === "visible"
    && document.hasFocus();

  useEffect(() => {
    activeChatRef.current = activeChatId;
  }, [activeChatId]);

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
    if (!syncProgress.visible || syncProgress.phase !== "complete") return;
    const timer = window.setTimeout(() => setSyncProgress((current) => ({ ...current, visible: false })), 750);
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
    if (!lineyEngine.isNative) return;
    let reconnectTimer: number | undefined;
    let liveChatRefreshTimer: number | undefined;
    let connectInFlight = false;
    const scheduleLiveChatRefresh = () => {
      if (liveChatRefreshTimer !== undefined) return;
      liveChatRefreshTimer = window.setTimeout(() => {
        liveChatRefreshTimer = undefined;
        void loadLiveChats();
      }, 700);
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
      const caps = await lineyEngine.request<{ linejsVersion?: string; authenticated?: boolean; features?: string[]; storage?: { mode?: "wallet" | "session-only" }; call?: { enabled?: boolean; incomingAnswer?: boolean; reason?: string } }>("capabilities", {}, 120_000);
      if (caps?.linejsVersion) setEngineVersion(caps.linejsVersion);
      setCallAvailable(Boolean(caps?.call?.enabled || caps?.features?.includes("call-audio-1to1")));
      setCallIncomingAvailable(Boolean(caps?.call?.incomingAnswer));
      setCallReason(String(caps?.call?.reason ?? ""));
      if (caps?.storage?.mode === "wallet" || caps?.storage?.mode === "session-only") setStorageMode(caps.storage.mode);
      setEngineState("ready");
      if (caps?.authenticated) {
        setAuthenticated(true);
        try {
          const restoredProfile = await lineyEngine.request<ProfileResult>("profile.get", {}, 20_000);
          setProfile(restoredProfile);
        } catch {}
        void loadLiveChats();
        void loadLiveFriends();
      } else {
        setAuthenticated(false);
        setAuthOpen(true);
      }
    };
    const connect = async () => {
      if (connectInFlight) return;
      connectInFlight = true;
      try {
        await lineyEngine.start();
        await refreshCapabilities();
      } catch {
        setEngineState("error");
        scheduleReconnect();
      } finally {
        connectInFlight = false;
      }
    };
    const off = lineyEngine.on((event) => {
      if (event.type === "engine.ready" && typeof event.linejsVersion === "string") setEngineVersion(event.linejsVersion);
      if (event.type === "engine.error") setEngineState("error");
      if (event.type === "engine.closed") {
        setEngineState("error");
        setAuthBusy(false);
        scheduleReconnect();
      }
      if (event.type === "auth.persistence") setStorageMode("session-only");
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
      }
      if (event.type === "sync.error") {
        setSyncStatus("ซิงก์บางส่วนไม่สำเร็จ");
        setSyncProgress((current) => ({ ...current, visible: true, phase: "error" }));
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
        setAuthBusy(false);
        setAuthenticated(true);
        setQrUrl("");
        setPin("");
        setAuthError("");
        setAuthOpen(false);
        if (event.storage === "wallet" || event.storage === "session-only") setStorageMode(event.storage);
        if (event.profile && typeof event.profile === "object") setProfile(event.profile as ProfileResult);
        void loadLiveChats();
        void loadLiveFriends();
      }
      if (event.type === "auth.restore_failed") {
        setAuthBusy(false);
        setAuthenticated(false);
        setAuthOpen(true);
        setAuthError("Session เดิมใช้ต่อไม่ได้ กรุณาเข้าสู่ระบบด้วย QR หรือ Email/Password ใหม่");
      }
      if (event.type === "auth.logged_out") {
        setAuthBusy(false);
        setAuthenticated(false);
        liveChatsLoadGenerationRef.current += 1;
        liveFriendsLoadGenerationRef.current += 1;
        liveChatsRef.current = null;
        liveFriendsRef.current = null;
        liveEventDedupRef.current.clear();
        setLiveChats([]);
        setLiveFriends([]);
        setProfile(null);
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
              if (event.type === "message.sending") return { ...item, status: "sending" };
              if (event.type === "message.failed") return {
                ...item,
                status: event.status === "unknown" ? "unknown" : "error",
              };
              return {
                ...item,
                id: serverId && serverId !== localId ? serverId : item.id,
                status: "sent",
              };
            }),
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
        if (chatId && messageId) {
          setMessageMap((current) => ({
            ...current,
            [chatId]: (current[chatId] ?? []).map((item) => (
              item.author === "me" && messageIdAtOrBefore(item.id, messageId)
                ? { ...item, readByPeer: true }
                : item
            )),
          }));
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
              unsent: true,
              status: "sent",
            } : item),
          }));
        }
      }
      if (event.type === "event.message" && event.message && typeof event.message === "object") {
        const raw = event.message as LiveMessageResult;
        const chatId = String(raw.chatId ?? "").trim();
        const contentType = Number(raw.contentType ?? 0);
        const preview = liveMessagePreview(raw);
        const eventMessageId = String(raw.id ?? raw.localId ?? "").trim();
        const eventSource = String(event.source ?? "").startsWith("openchat") ? "openchat" : "talk";
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

          // Update the denormalized sidebar locally as soon as the event
          // arrives. A later list refresh is only needed for a newly-created
          // or previously hidden room.
          setLiveChats((current) => {
            if (!current) return current;
            const existing = current.find((chat) => chat.id === chatId);
            if (existing) {
              return current.map((chat) => chat.id === chatId
                ? {
                  ...chat,
                  subtitle: preview,
                  time: formatListTime(raw.createdTime || Date.now()),
                  lastMessageTime: Math.max(chat.lastMessageTime ?? 0, raw.createdTime || Date.now()),
                  unread: raw.isMine || isChatActuallyVisible(chatId)
                    ? undefined
                    : duplicateLiveEvent ? chat.unread : (chat.unread ?? 0) + 1,
                }
                : chat);
            }
            const friend = liveFriendsRef.current?.find((chat) => chat.id === chatId);
            if (friend && chatKind === "dm") {
              return [...current, {
                ...friend,
                subtitle: preview,
                time: formatListTime(raw.createdTime || Date.now()),
                lastMessageTime: raw.createdTime || Date.now(),
                unread: raw.isMine ? undefined : 1,
              }];
            }
            return current;
          });
          if (!knownChat || !(liveChatsRef.current ?? []).some((chat) => chat.id === chatId)) scheduleLiveChatRefresh();
          if (!raw.isMine && isChatActuallyVisible(chatId)) {
            void lineyEngine.request("chat.mark_read", {
              chatId,
              kind: chatKind === "openchat" ? "openchat" : "talk",
            }, 20_000).catch(() => undefined);
          }
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
                    reactions: raw.reactions,
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
            filename: raw.filename,
            senderId: raw.senderId,
            senderName: raw.senderName,
            senderAvatarUrl: raw.senderAvatarUrl,
            postNotification: raw.postNotification,
            reactions: raw.reactions,
            replyTo: raw.replyTo ?? (raw.replyToId ? { id: raw.replyToId, text: "ข้อความ" } : undefined),
            replyToId: raw.replyToId,
            unsent: raw.unsent,
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
                rich: raw.rich,
                filename: raw.filename,
                senderId: raw.senderId,
                senderName: raw.senderName,
                senderAvatarUrl: raw.senderAvatarUrl,
                reactions: raw.reactions,
                replyTo: raw.replyTo ?? (raw.replyToId ? { id: raw.replyToId, text: "ข้อความ" } : undefined),
                replyToId: raw.replyToId,
                unsent: raw.unsent,
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
                raw.senderName || "LINE",
                settingsRef.current.notificationPreview ? (raw.text || "มีสื่อใหม่") : "มีข้อความใหม่",
                settingsRef.current.desktopNotifications,
                settingsRef.current.notificationSound,
                { chatId, messageId: message.id },
                () => jumpToNotification(chatId, message.id),
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
        setCallState("incoming");
        setCallError("");
        setCallOpen(true);
      }
      if (event.type === "event.call.state") {
        const next = String(event.state ?? "idle") as CallState;
        setCallState(next);
      }
      if (event.type === "event.call.ready") {
        setCallId((current) => String(event.callId ?? current));
        setCallPeer((current) => String(event.peer ?? current));
        setCallState("in-call");
        setCallOpen(true);
      }
      if (event.type === "event.call.error") setCallError(String(event.error ?? "สายเสียงขัดข้อง"));
      if (event.type === "event.call.cancel") {
        setCallState("ended");
        setCallOpen(false);
      }
      if (event.type === "event.call.ended") {
        setCallState("ended");
        setCallOpen(false);
      }
    });
    void connect();
    return () => {
      off();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (liveChatRefreshTimer !== undefined) window.clearTimeout(liveChatRefreshTimer);
    };
  }, []);

  useEffect(() => {
    if (!lineyEngine.isNative || !callOpen || !authenticated) return;
    let active = true;
    void lineyEngine.request<{ outputs?: AudioDeviceResult[] }>("call.devices", {}, 8_000)
      .then((result) => {
        if (active) setCallOutputs((result?.outputs ?? []).filter((device) => device.kind === "output"));
      })
      .catch(() => {
        if (active) setCallOutputs([]);
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
    () => lineyEngine.isNative ? (authenticated ? (liveFriends ?? []) : []) : seedChats.filter((chat) => chat.kind === "dm"),
    [authenticated, liveFriends],
  );
  const favoriteFriendMap = useMemo(
    () => new Map(allFriends.filter((friend) => friend.isFavorite).map((friend) => [friend.id, friend])),
    [allFriends],
  );
  const allChats = useMemo(() => {
    const base = lineyEngine.isNative ? (authenticated ? (liveChats ?? []) : []) : seedChats;
    return base
      .map((chat) => {
        const localPinTimestamp = localPins[chat.id] ?? 0;
        const remotePinTimestamp = chat.favoriteTimestamp ?? 0;
        const favorite = chat.kind === "dm" ? favoriteFriendMap.get(chat.id) : undefined;
        return {
          ...chat,
          ...(favorite ? { isFavorite: true, favoriteTime: favorite.favoriteTime } : {}),
          pinned: Boolean(chat.pinned || localPinTimestamp),
          favoriteTimestamp: Math.max(remotePinTimestamp, localPinTimestamp),
        };
      })
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        if ((a.favoriteTimestamp ?? 0) !== (b.favoriteTimestamp ?? 0)) return (b.favoriteTimestamp ?? 0) - (a.favoriteTimestamp ?? 0);
        return (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0);
      });
  }, [authenticated, liveChats, favoriteFriendMap, localPins]);
  const visibleChats = useMemo(() => {
    const hasQuery = Boolean(query.trim());
    let items = section === "friends"
      ? allFriends
      : section === "openchat"
      ? settings.openchat ? allChats.filter((chat) => chat.kind === "openchat") : []
      : section === "calls"
      ? []
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
  }, [query, section, listFilter, allChats, allFriends, settings.openchat]);

  const placeholderChat: Chat = {
    id: "__liney__",
    name: syncStatus ? "กำลังซิงก์ข้อมูล LINE" : authenticated ? "เลือกแชตเพื่อเริ่มใช้งาน" : "เชื่อมบัญชี LINE",
    subtitle: syncStatus || (authenticated ? "แชตและ OpenChat ของคุณจะอยู่ด้านซ้าย" : "กดโลโก้ L เพื่อเข้าสู่ระบบด้วย QR"),
    time: "",
    kind: "dm",
    avatar: "L",
    accent: "#22c55e",
  };
  const activePool = [...allChats, ...allFriends];
  const activeChat = activePool.find((chat) => chat.id === activeChatId) ?? visibleChats[0] ?? activePool[0] ?? placeholderChat;
  const activeMessages = activeChat.id === "__liney__"
    ? []
    : messageMap[activeChat.id] ?? (activeChat.kind === "dm" && liveChats && !liveChats.some((item) => item.id === activeChat.id) ? [] : undefined);

  // Auto-selected rooms must not be acknowledged while Liney is in the
  // background.  When the app becomes active again this effect runs and marks
  // only the conversation the user can see as read.
  useEffect(() => {
    if (!windowActive || !authenticated || !liveChats || !activeChatId) return;
    const chat = liveChats.find((item) => item.id === activeChatId);
    if (!chat?.unread) return;
    const readKey = `${activeChatId}:${chat.unread}`;
    if (readMarkedRef.current.has(readKey)) return;
    readMarkedRef.current.add(readKey);
    void lineyEngine.request("chat.mark_read", {
      chatId: chat.id,
      kind: chat.kind === "openchat" ? "openchat" : "talk",
    }, 20_000).catch(() => undefined);
  }, [windowActive, authenticated, activeChatId, liveChats]);

  useEffect(() => {
    if (!authenticated || !liveChats || !activeChatId) return;
    const chat = [...liveChats, ...(liveFriends ?? [])].find((item) => item.id === activeChatId);
    if (!chat) return;
    const requestGeneration = (messageLoadGenerationRef.current.get(chat.id) ?? 0) + 1;
    messageLoadGenerationRef.current.set(chat.id, requestGeneration);

    void lineyEngine
      .request<LiveMessageResult[]>("message.list", {
        chatId: chat.id,
        kind: chat.kind === "openchat" ? "openchat" : "talk",
        limit: chat.kind === "openchat" ? 40 : 50,
      }, chat.kind === "openchat" ? 45_000 : 30_000)
      .then((list) => {
        if (messageLoadGenerationRef.current.get(chat.id) !== requestGeneration) return;
        const sorted = [...list]
          .sort((a, b) => Number(a.createdTime) - Number(b.createdTime))
          .filter((item) => item.text || Number(item.contentType ?? 0) > 0);
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
          filename: item.filename,
          senderId: item.senderId,
          senderName: item.senderName,
          senderAvatarUrl: item.senderAvatarUrl,
          stickerUrl: item.stickerUrl,
          flex: item.flex,
          rich: item.rich,
          postNotification: item.postNotification,
          reactions: item.reactions,
          replyTo: item.replyTo ?? (item.replyToId ? { id: item.replyToId, text: "ข้อความ" } : undefined),
          replyToId: item.replyToId,
          unsent: item.unsent,
          status: item.status ?? "sent",
        }));
        setMessageMap((current) => {
          if (messageLoadGenerationRef.current.get(chat.id) !== requestGeneration) return current;
          const existing = current[chat.id] ?? [];
          const previousById = new Map(existing.map((item) => [item.id, item]));
          // A history refresh recreates Message objects. Carry an already
          // hydrated preview forward so a sidebar refresh or room re-open
          // cannot make an image blank while media.preview runs again.
          const mapped = baseMapped.map((item) => {
            const previous = previousById.get(item.id);
            const keepImage = Boolean(previous?.image)
              && (chat.kind !== "openchat" || settingsRef.current.autoMedia);
            return keepImage
              ? { ...item, image: previous?.image, text: undefined, ...(previous?.readByPeer ? { readByPeer: true } : {}) }
              : previous?.readByPeer ? { ...item, readByPeer: true } : item;
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
          return { ...current, [chat.id]: merged };
        });
        void hydrateImagePreviews(chat.id, sorted, chat.kind === "openchat" ? "openchat" : "talk", requestGeneration);
      })
      .catch((error) => {
        if (messageLoadGenerationRef.current.get(chat.id) !== requestGeneration) return;
        // Keep the last good SQLite history visible when a refresh fails.
        setMessageMap((current) => current[chat.id] ? current : ({ ...current, [chat.id]: [] }));
        setAuthError(error instanceof Error ? error.message : String(error));
      });
  }, [activeChatId, authenticated, liveChats, liveFriends, settings.autoMedia]);

  async function hydrateImagePreview(
    chatId: string,
    messageId: string,
    kind: "talk" | "openchat",
    requestGeneration?: number,
  ) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const preview = await lineyEngine.request<MediaPreviewResult>(
          "media.preview",
          { messageId, chatId, kind, refresh: attempt > 0 },
          45_000,
        );
        if (!preview?.dataUrl) throw new Error("empty image preview");
        setMessageMap((current) => {
          if (requestGeneration !== undefined
            && messageLoadGenerationRef.current.get(chatId) !== requestGeneration) return current;
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
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 650));
      }
    }

    // Keep a usable fallback only after both the preview and retry path fail.
    setMessageMap((current) => {
      if (requestGeneration !== undefined
        && messageLoadGenerationRef.current.get(chatId) !== requestGeneration) return current;
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
    if (kind === "openchat" && !settingsRef.current.autoMedia) {
      setMessageMap((current) => {
        if (requestGeneration !== undefined
          && messageLoadGenerationRef.current.get(chatId) !== requestGeneration) return current;
        return {
          ...current,
          [chatId]: (current[chatId] ?? []).map((item) =>
            item.contentType === 1 && !item.image ? { ...item, text: "รูปภาพ" } : item
          ),
        };
      });
      return;
    }
    const images = list.filter((item) => Number(item.contentType ?? 0) === 1);
    const workers = Array.from({ length: Math.min(4, images.length) }, async (_, workerIndex) => {
      for (let index = workerIndex; index < images.length; index += 4) {
        await hydrateImagePreview(chatId, images[index].id, kind, requestGeneration);
      }
    });
    await Promise.all(workers);
  }

  async function loadLiveChats() {
    const requestGeneration = ++liveChatsLoadGenerationRef.current;
    const [talkResult, squareResult] = await Promise.allSettled([
      lineyEngine.request<LiveChatResult[]>("chats.list", {}, 45_000),
      lineyEngine.request<LiveChatResult[]>("openchat.list", {}, 45_000),
    ]);
    if (liveChatsLoadGenerationRef.current !== requestGeneration) return;
    const talkSucceeded = talkResult.status === "fulfilled" && Array.isArray(talkResult.value);
    const squareSucceeded = squareResult.status === "fulfilled" && Array.isArray(squareResult.value);
    const talk = talkSucceeded ? talkResult.value : [];
    const square = squareSucceeded ? squareResult.value : [];
    const previous = liveChatsRef.current ?? [];
    const previousTalkCount = previous.filter((chat) => chat.kind !== "openchat").length;
    const previousSquareCount = previous.filter((chat) => chat.kind === "openchat").length;
    const remoteIds = new Set([...talk, ...square].map((item) => item.id));
    const preserved = previous.filter((chat) => {
      if (remoteIds.has(chat.id)) return false;
      const isOpenChat = chat.kind === "openchat";
      const keepCategory = isOpenChat
        ? !squareSucceeded || square.length === 0 || square.length < previousSquareCount
        : !talkSucceeded || talk.length === 0 || talk.length < previousTalkCount;
      return keepCategory;
    });
    const mappedRemote = [...talk, ...square]
      .map<Chat>((item, index) => ({
        id: item.id,
        name: item.name,
        subtitle: item.preview || (item.kind === "openchat" ? "OpenChat" : item.kind === "dm" ? "เพื่อน · LINE" : "กลุ่ม · LINE"),
        detail: item.kind === "openchat"
          ? `OpenChat${item.memberCount ? ` · ${item.memberCount.toLocaleString("th-TH")} คน` : ""}`
          : item.kind === "dm" ? "เพื่อน · LINE" : "กลุ่ม · LINE",
        time: formatListTime(item.lastMessageTime ?? 0),
        unread: item.unread || undefined,
        kind: item.kind,
        avatar: initials(item.name),
        avatarUrl: item.avatarUrl || undefined,
        accent: avatarColor(index),
        lastMessageTime: item.lastMessageTime ?? 0,
        pinned: item.pinned,
        favoriteTimestamp: item.favoriteTimestamp,
      }));
    const mappedById = new Map<string, Chat>();
    for (const chat of [...mappedRemote, ...preserved]) {
      if (!mappedById.has(chat.id)) mappedById.set(chat.id, chat);
    }
    const mapped = [...mappedById.values()]
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        if ((a.favoriteTimestamp ?? 0) !== (b.favoriteTimestamp ?? 0)) return (b.favoriteTimestamp ?? 0) - (a.favoriteTimestamp ?? 0);
        return (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0);
      });
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

  async function loadLiveFriends(allowRetry = true) {
    const requestGeneration = ++liveFriendsLoadGenerationRef.current;
    try {
      const result = await lineyEngine.request<LiveChatResult[]>("friends.list", {}, 60_000);
      if (liveFriendsLoadGenerationRef.current !== requestGeneration) return;
      const mapped = result.map<Chat>((item, index) => ({
        id: item.id,
        name: item.name,
        subtitle: item.statusMessage?.trim() || "เพื่อน · LINE",
        detail: "เพื่อน · LINE",
        time: "",
        kind: "dm",
        avatar: initials(item.name),
        avatarUrl: item.avatarUrl || undefined,
        accent: avatarColor(index),
        isFavorite: item.isFavorite,
        favoriteTime: item.favoriteTime,
      }));
      mapped.sort((a, b) => {
        if (Boolean(a.isFavorite) !== Boolean(b.isFavorite)) return a.isFavorite ? -1 : 1;
        if ((a.favoriteTime ?? 0) !== (b.favoriteTime ?? 0)) return (b.favoriteTime ?? 0) - (a.favoriteTime ?? 0);
        return a.name.localeCompare(b.name, "th");
      });
      const next = mapped.length || !liveFriendsRef.current ? mapped : liveFriendsRef.current;
      liveFriendsRef.current = next;
      setLiveFriends(next);
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

  function selectChat(chatId: string) {
    const chat = [...(liveChats ?? []), ...(liveFriends ?? [])].find((item) => item.id === chatId);
    setReplyTarget(null);
    setActiveChatId(chatId);
    if (!chat || !authenticated) return;

    // LINE Desktop clears unread immediately when the conversation is opened.
    // Keep that responsive UX locally, then persist the read receipt upstream.
    setLiveChats((current) => current?.map((item) =>
      item.id === chatId ? { ...item, unread: undefined } : item
    ) ?? current);

    const currentMessages = messageMap[chatId] ?? [];
    const lastMessageId = currentMessages.length
      ? currentMessages[currentMessages.length - 1]?.id
      : undefined;
    void lineyEngine.request(
      "chat.mark_read",
      {
        chatId,
        kind: chat.kind === "openchat" ? "openchat" : "talk",
        messageId: lastMessageId,
      },
      20_000,
    ).catch(() => undefined);
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
    setLiveChats((current) => current?.map((chat) =>
      chat.id === chatId
        ? { ...chat, subtitle: text.replace(/\s+/g, " ").trim(), time: formatListTime(now), lastMessageTime: now, unread: undefined }
        : chat
    ) ?? current);
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
    const stickerUrl = `https://stickershop.line-scdn.net/stickershop/v1/sticker/${encodeURIComponent(sticker.stickerId)}/android/${sticker.option === "A" ? "sticker_animation.png" : "sticker.png"}`;
    setMessageMap((current) => ({
      ...current,
      [chatId]: [...(current[chatId] ?? []), { id, author: "me", time: formatTime(now), createdTime: now, contentType: 7, stickerUrl, status: "sending" }],
    }));
    setLiveChats((current) => current?.map((chat) => chat.id === chatId
      ? { ...chat, subtitle: "สติกเกอร์", time: formatListTime(now), lastMessageTime: now, unread: undefined }
      : chat) ?? current);
    try {
      await lineyEngine.request("message.sendSticker", {
        chatId,
        kind: activeChat.kind === "openchat" ? "openchat" : "talk",
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
    if (!authenticated || activeChat.id === "__liney__") return;
    const id = crypto.randomUUID();
    const now = Date.now();
    const chatId = activeChat.id;
    const emojiUrl = `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${encodeURIComponent(emoji.productId)}/android/${encodeURIComponent(emoji.sticonId)}.png`;
    setMessageMap((current) => ({
      ...current,
      [chatId]: [...(current[chatId] ?? []), { id, author: "me", time: formatTime(now), createdTime: now, emojiUrl, status: "sending" }],
    }));
    try {
      await lineyEngine.request("message.sendEmoji", {
        chatId,
        kind: activeChat.kind === "openchat" ? "openchat" : "talk",
        productId: emoji.productId,
        sticonId: emoji.sticonId,
        version: emoji.version,
        resourceType: emoji.resourceType,
        localId: id,
        createdAt: now,
      }, 45_000);
      setMessageMap((current) => ({ ...current, [chatId]: (current[chatId] ?? []).map((item) => item.id === id ? { ...item, status: "sent" } : item) }));
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

  async function retryMessage(localId: string, chatId: string) {
    setMessageMap((current) => ({
      ...current,
      [chatId]: (current[chatId] ?? []).map((item) => item.id === localId ? { ...item, status: "sending" } : item),
    }));
    try {
      await lineyEngine.request("message.retry", { localId }, 60_000);
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === localId ? { ...item, status: "sent" } : item),
      }));
    } catch (error) {
      const uncertain = error instanceof EngineRequestError && error.code === "TIMEOUT";
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === localId ? { ...item, status: uncertain ? "unknown" : "error" } : item),
      }));
      setAuthError(error instanceof Error ? error.message : String(error));
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
    } catch (error) {
      const uncertain = error instanceof EngineRequestError && error.code === "TIMEOUT";
      setMessageMap((current) => ({
        ...current,
        [chatId]: (current[chatId] ?? []).map((item) => item.id === id ? { ...item, status: uncertain ? "unknown" : "error" } : item),
      }));
      setAuthError(error instanceof Error ? error.message : String(error));
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
      setAuthenticated(false);
      setLiveChats([]);
      setProfile(null);
      setMessageMap({});
      setMediaProgress({});
      setReplyTarget(null);
      setActiveChatId("");
      setAuthOpen(false);
    }
  }

  async function startCall() {
    if (!authenticated || activeChat.id === "__liney__") {
      setAuthOpen(true);
      return;
    }
    if (!callAvailable || activeChat.kind !== "dm") {
      setCallPeer(activeChat.name);
      setCallState("failed");
      setCallError(callReason || "สายเสียง 1:1 ยังไม่พร้อมบนระบบนี้");
      setCallOpen(true);
      return;
    }
    setCallPeer(activeChat.name);
    setCallState("acquiring");
    setCallError("");
    setCallMuted(false);
    setCallOpen(true);
    try {
      const result = await lineyEngine.request<{ callId?: string; state?: CallState }>("call.start", { peer: activeChat.id }, 80_000);
      setCallId(String(result?.callId ?? ""));
      setCallState(result?.state ?? "in-call");
    } catch (error) {
      setCallState("failed");
      setCallError(error instanceof Error ? error.message : String(error));
    }
  }

  async function acceptCall() {
    setCallError("");
    setCallState("connecting");
    try {
      await lineyEngine.request("call.accept", {}, 60_000);
      setCallState("in-call");
    } catch (error) {
      setCallState("failed");
      setCallError(error instanceof Error ? error.message : String(error));
    }
  }

  async function rejectCall() {
    try { await lineyEngine.request("call.reject", {}, 15_000); }
    catch (error) { setCallError(error instanceof Error ? error.message : String(error)); }
    setCallOpen(false);
    setCallState("ended");
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
  }

  async function toggleCallMute() {
    const muted = !callMuted;
    setCallMuted(muted);
    await lineyEngine.request("call.setMuted", { muted }, 10_000).catch((error) => {
      setCallMuted(!muted);
      setCallError(error instanceof Error ? error.message : String(error));
    });
  }

  function updateAppSettings(key: keyof AppSettings, value: boolean) {
    updateSetting(key, value);
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

  async function openImageViewer(dataUrl: string) {
    if (!dataUrl || dataUrl === "food") return;
    // The thumbnail is already loaded by this WebKit view. Opening here avoids
    // the Linux WebKitGTK cross-window storage boundary that caused silent opens.
    setImageViewerSrc(dataUrl);
  }

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
      storageMode={storageMode}
      required={required}
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
      onClose={() => setAuthOpen(false)}
    />
  );

  if (lineyEngine.isNative && !authenticated) {
    return <div className="auth-gate-shell">{renderAuthDialog(true)}</div>;
  }

  if (lineyEngine.isNative && authenticated && syncProgress.visible && syncProgress.phase !== "error") {
    return <FullSyncGate progress={syncProgress} />;
  }

  return (
    <div className="app-shell">
      <NavRail section={section} onSection={(next) => { setSection(next); setListFilter("all"); }} onSettings={() => setSettingsOpen(true)} onProfile={() => setAuthOpen(true)} authenticated={authenticated} openchatEnabled={settings.openchat} />
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
      />
      <Conversation
        key={activeChat.id}
        chat={activeChat}
        messages={activeMessages}
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
        replyTarget={replyTarget}
        onCancelReply={() => setReplyTarget(null)}
        canSend={authenticated && activeChat.id !== "__liney__"}
        callAvailable={callAvailable && activeChat.kind === "dm"}
        onCall={() => void startCall()}
        jumpToMessageId={notificationJump?.chatId === activeChat.id ? notificationJump.messageId : undefined}
        jumpNonce={notificationJump?.chatId === activeChat.id ? notificationJump.nonce : 0}
      />
      <EnginePill state={engineState} version={engineVersion} authenticated={authenticated} syncStatus={syncStatus} onClick={() => setAuthOpen(true)} />

      <AnimatePresence>
        {imageViewerSrc && <ImageViewerOverlay src={imageViewerSrc} onClose={() => setImageViewerSrc(null)} />}
        {settingsOpen && <SettingsModal themeMode={themeMode} dark={dark} settings={settings} callAvailable={callAvailable} onThemeMode={setThemeMode} onSetting={updateAppSettings} onDensity={(value) => updateSetting("density", value)} onRadius={(value) => updateSetting("radius", value)} onClearHistory={() => void clearLocalHistory()} onClearStickerCache={() => void clearStickerCache()} onClose={() => setSettingsOpen(false)} />}
        {callOpen && <CallModal chat={activeChat} peer={callPeer} state={callState} muted={callMuted} error={callError} incomingSupported={callIncomingAvailable} outputDevices={callOutputs} outputTarget={callOutputTarget} onAccept={() => void acceptCall()} onReject={() => void rejectCall()} onMute={() => void toggleCallMute()} onOutput={(target) => void changeCallOutput(target)} onClose={() => void endCall()} />}
        {authOpen && renderAuthDialog(false)}
      </AnimatePresence>
    </div>
  );
}

function ImageViewerOverlay({ src, onClose }: { src: string; onClose: () => void }) {
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<ImageEditorTool>("view");
  const [ready, setReady] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const sourceRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const undoRef = useRef<ImageData[]>([]);

  function context() {
    const canvas = canvasRef.current;
    return canvas ? canvas.getContext("2d") : null;
  }

  function snapshot() {
    const canvas = canvasRef.current;
    const ctx = context();
    if (!canvas || !ctx) return;
    undoRef.current = [...undoRef.current, ctx.getImageData(0, 0, canvas.width, canvas.height)].slice(-20);
    setUndoCount(undoRef.current.length);
  }

  function pointFor(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
      y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
    };
  }

  function initialiseCanvas() {
    const image = sourceRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas || !image.naturalWidth || !image.naturalHeight) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    undoRef.current = [];
    setUndoCount(0);
    setReady(true);
  }

  function draw(from: { x: number; y: number }, to: { x: number; y: number }) {
    const canvas = canvasRef.current;
    const ctx = context();
    if (!canvas || !ctx) return;
    const size = Math.max(5, Math.round(canvas.width / 180));
    if (tool === "draw") {
      ctx.save();
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (tool === "blur") {
      const radius = size * 3;
      ctx.save();
      ctx.beginPath();
      ctx.arc(to.x, to.y, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.filter = "blur(12px)";
      ctx.drawImage(canvas, to.x - radius, to.y - radius, radius * 2, radius * 2, to.x - radius, to.y - radius, radius * 2, radius * 2);
      ctx.restore();
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!ready || tool === "view") return;
    const point = pointFor(event);
    if (tool === "text") {
      const text = window.prompt("ใส่ข้อความ");
      if (!text?.trim()) return;
      const canvas = canvasRef.current;
      const ctx = context();
      if (!canvas || !ctx) return;
      snapshot();
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "rgba(0,0,0,.75)";
      ctx.lineWidth = Math.max(3, canvas.width / 380);
      ctx.font = `700 ${Math.max(22, Math.round(canvas.width / 24))}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.strokeText(text.trim(), point.x, point.y);
      ctx.fillText(text.trim(), point.x, point.y);
      ctx.restore();
      return;
    }
    snapshot();
    drawingRef.current = true;
    lastPointRef.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    draw(point, point);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !lastPointRef.current) return;
    const point = pointFor(event);
    draw(lastPointRef.current, point);
    lastPointRef.current = point;
  }

  function stopDrawing() {
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function undo() {
    const canvas = canvasRef.current;
    const ctx = context();
    const previous = undoRef.current.pop();
    if (!canvas || !ctx || !previous) return;
    ctx.putImageData(previous, 0, 0);
    setUndoCount(undoRef.current.length);
  }

  function clearEdits() {
    initialiseCanvas();
  }

  function saveImage() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `liney-edited-${Date.now()}.png`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }, "image/png");
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(3, Number((value + 0.2).toFixed(1))));
      if (event.key === "-") setZoom((value) => Math.max(0.4, Number((value - 0.2).toFixed(1))));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <motion.div className="image-viewer-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button className="image-viewer-backdrop" type="button" aria-label="ปิดหน้าดูรูปภาพ" onClick={onClose} />
      <main className="image-viewer-window" role="dialog" aria-modal="true" aria-label="ดูรูปภาพ">
      <header className="image-viewer-toolbar">
        <strong>ดูรูปภาพ</strong>
        <div>
          <button className={tool === "view" ? "active" : ""} type="button" title="เลื่อนดูรูป" onClick={() => setTool("view")}>ดู</button>
          <button className={tool === "draw" ? "active" : ""} type="button" title="วาดรูป" onClick={() => setTool("draw")}>วาด</button>
          <button className={tool === "blur" ? "active" : ""} type="button" title="เบลอ" onClick={() => setTool("blur")}>เบลอ</button>
          <button className={tool === "text" ? "active" : ""} type="button" title="ใส่ข้อความ" onClick={() => setTool("text")}>Text</button>
          <button type="button" title="ย้อนกลับ" disabled={!undoCount} onClick={undo}><Undo2 size={17} /></button>
          <button type="button" title="ล้างการแก้ไข" disabled={!ready} onClick={clearEdits}><Trash size={17} /></button>
          <button type="button" title="บันทึกรูปที่แก้ไข" disabled={!ready} onClick={saveImage}>บันทึก</button>
          <button type="button" title="ย่อ" onClick={() => setZoom((value) => Math.max(0.4, Number((value - 0.2).toFixed(1))))}><Minus size={17} /></button>
          <button type="button" title="ขนาดจริง" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" title="ขยาย" onClick={() => setZoom((value) => Math.min(3, Number((value + 0.2).toFixed(1))))}><Plus size={17} /></button>
          <button type="button" title="ปิด" onClick={onClose}><X size={17} /></button>
        </div>
      </header>
      <section className="image-viewer-canvas">
        <img ref={sourceRef} className="image-viewer-source" src={src} alt="" onLoad={initialiseCanvas} onError={() => setError("ไม่สามารถโหลดไฟล์รูปภาพนี้ได้")} />
        <canvas ref={canvasRef} className={`image-editor-canvas ${tool === "draw" || tool === "blur" ? "editing" : ""}`} style={{ transform: `scale(${zoom})` }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stopDrawing} onPointerCancel={stopDrawing} />
        {!ready && !error ? <span>กำลังเปิดรูปภาพ…</span> : null}
        {error ? <span className="image-viewer-error">{error}</span> : null}
      </section>
      </main>
    </motion.div>
  );
}

function NavRail({ section, onSection, onSettings, onProfile, authenticated, openchatEnabled }: { section: Section; onSection: (s: Section) => void; onSettings: () => void; onProfile: () => void; authenticated: boolean; openchatEnabled: boolean }) {
  return (
    <aside className="nav-rail">
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
            >
              <Icon size={20} strokeWidth={1.9} />
              <span className="rail-tooltip">{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="nav-bottom">
        <button className="rail-button" title="การแจ้งเตือน">
          <Bell size={19} />
          <span className="status-dot" />
        </button>
        <button className="rail-button" onClick={onSettings} title="ตั้งค่า">
          <Settings size={19} />
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
}) {
  const [contextMenu, setContextMenu] = useState<{ chat: Chat; x: number; y: number } | null>(null);
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
  return (
    <section className="chat-list-panel">
      <header className="list-header">
        <div>
          <p className="eyebrow">LINE DESKTOP</p>
          <h1>{title}</h1>
        </div>
        <button className="icon-button" type="button" disabled title="สร้างแชตใหม่ยังไม่รองรับ"><Plus size={19} /></button>
      </header>
      <div className="search-box">
        <Search size={16} />
        <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="ค้นหาแชตหรือเพื่อน" />
        <kbd>⌘ K</kbd>
      </div>
      <div className="list-filter-row">
        <button className={`filter-chip ${filter === "all" ? "active" : ""}`} onClick={() => onFilter("all")}>ทั้งหมด</button>
        {section === "friends" ? (
          <button className={`filter-chip ${filter === "favorites" ? "active" : ""}`} onClick={() => onFilter("favorites")}><Star size={12} /> รายการโปรด</button>
        ) : (
          <>
            <button className={`filter-chip ${filter === "unread" ? "active" : ""}`} onClick={() => onFilter("unread")}>ยังไม่อ่าน</button>
            {section === "messages" ? (
              <button className={`filter-chip ${filter === "favorites" ? "active" : ""}`} onClick={() => onFilter("favorites")}><Star size={12} /> รายการโปรด</button>
            ) : null}
            <button className={`filter-chip ${filter === "pinned" ? "active" : ""}`} onClick={() => onFilter("pinned")}><PinIcon size={12} /> ปักหมุด</button>
          </>
        )}
      </div>
      <div className="chat-items">
        {chats.map((chat) => (
          <button
            key={chat.id}
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
          </button>
        ))}
        {chats.length === 0 && <div className="empty-list">ไม่พบรายการ</div>}
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
        </div>
      ) : null}
    </section>
  );
}

function Avatar({ chat, size = "normal" }: { chat: Chat; size?: "normal" | "large" }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`avatar ${size === "large" ? "avatar-large" : ""}`} style={{ "--avatar-color": chat.accent } as React.CSSProperties}>
      {chat.avatarUrl && !failed ? (
        <img src={chat.avatarUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
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
      {url && !failed ? <img src={url} alt={name} loading="lazy" onError={() => setFailed(true)} /> : fallback}
    </span>
  );
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
  mediaProgress,
  onCancelMedia,
  onReact,
  onReply,
  onDeleteForMe,
  onUnsend,
  replyTarget,
  onCancelReply,
  canSend,
  callAvailable,
  onCall,
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
  mediaProgress: Record<string, MediaProgress>;
  onCancelMedia: (id: string) => void;
  onReact: (message: Message, type: number) => void | Promise<void>;
  onReply: (message: Message) => void;
  onDeleteForMe: (message: Message) => void | Promise<void>;
  onUnsend: (message: Message) => void | Promise<void>;
  replyTarget: ReplyTarget | null;
  onCancelReply: () => void;
  canSend: boolean;
  callAvailable: boolean;
  onCall: () => void;
  jumpToMessageId?: string;
  jumpNonce: number;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageStageRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const previousChatRef = useRef(chat.id);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
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
  const lastMessage = messages?.at(-1);
  const lastMessageId = lastMessage?.id;
  const lastMessageImage = lastMessage?.image;
  const activeMenuMessage = messages?.find((item) => item.id === messageMenuId);
  const activeMenuMessageId = activeMenuMessage?.id;
  const activeMenuMessageAuthor = activeMenuMessage?.author;
  const lastReadMineId = messages?.reduce<string | undefined>((latest, message) => (
    message.author === "me" && message.readByPeer ? message.id : latest
  ), undefined);

  useEffect(() => {
    if (!jumpToMessageId || !jumpNonce || chat.id === "__liney__") return;
    let clearTimer: number | undefined;
    const frame = requestAnimationFrame(() => {
      const target = messageRowRefs.current.get(jumpToMessageId);
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      setHighlightedMessageId(jumpToMessageId);
      clearTimer = window.setTimeout(() => setHighlightedMessageId((current) => current === jumpToMessageId ? null : current), 2_600);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (clearTimer !== undefined) window.clearTimeout(clearTimer);
    };
  }, [chat.id, jumpToMessageId, jumpNonce, messages?.length]);

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

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    const stage = messageStageRef.current;
    if (!stage) return;
    stickToBottomRef.current = true;
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
    stage.scrollTo({ top: stage.scrollHeight, behavior });
    setShowScrollBottom(false);
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, behavior === "smooth" ? 650 : 80);
  };

  useEffect(() => () => {
    if (programmaticScrollTimerRef.current !== null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
  }, []);

  // A newly opened chat should start at the newest message, like LINE Desktop.
  useLayoutEffect(() => {
    if (previousChatRef.current !== chat.id) {
      previousChatRef.current = chat.id;
      stickToBottomRef.current = true;
    }
    if (!stickToBottomRef.current) return;
    const frame = requestAnimationFrame(() => scrollToBottom("auto"));
    return () => cancelAnimationFrame(frame);
  }, [chat.id, messages?.length, lastMessageId, lastMessageImage]);

  // Images/activity cards can change height after render. Keep the viewport pinned
  // only while the user is already following the newest messages.
  useEffect(() => {
    const stage = messageStageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollToBottom("auto");
    });
    for (const child of Array.from(stage.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [chat.id, messages?.length]);

  const handleMessageScroll = () => {
    const stage = messageStageRef.current;
    if (!stage) return;
    const distanceFromBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight;
    const nearBottom = distanceFromBottom < 72;
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
      return;
    }

    // Any non-programmatic movement away from the bottom is user intent. Do
    // not snap back while the user is browsing older messages.
    stickToBottomRef.current = false;
    setShowScrollBottom(distanceFromBottom > 140);
  };

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
        <div className="header-actions">
          <button className="icon-button" onClick={onCall} title={callAvailable ? "โทรเสียง" : "สายเสียงยังไม่พร้อม"} disabled={!canSend || !callAvailable}><Phone size={18} /></button>
          <button className="icon-button" title="วิดีโอคอลยังไม่รองรับ" disabled><Video size={19} /></button>
          <button className="icon-button" disabled={empty}><Search size={18} /></button>
          <button className="icon-button" disabled={empty}><Info size={19} /></button>
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
        {empty ? (
          <div className="conversation-empty-state">
            <div className="empty-logo"><img src="/liney-logo.png" alt="" /></div>
            <h3>{chat.name}</h3>
            <p>{chat.subtitle}</p>
          </div>
        ) : messages === undefined ? (
          <div className="message-loading-state"><LoaderCircle size={22} className="spin" /><span>กำลังโหลดข้อความ…</span></div>
        ) : messages.length === 0 ? (
          <div className="message-list-empty-state">
            <MessageCircle size={24} />
            <strong>ยังไม่มีข้อความ</strong>
            <span>ส่งข้อความแรกเพื่อเริ่มการสนทนา</span>
          </div>
        ) : (
          <>
            <div className="date-divider"><span>ล่าสุด</span></div>
            {messages.map((message, index) => (
              <motion.div
                key={message.id}
                ref={(element) => {
                  if (element) messageRowRefs.current.set(message.id, element);
                  else messageRowRefs.current.delete(message.id);
                }}
                className={`message-row ${message.author === "me" ? "mine" : "theirs"} ${highlightedMessageId === message.id ? "notification-target" : ""}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: Math.min(index * 0.015, 0.08) }}
              >
                {message.author === "them" ? <MessageAvatar message={message} chat={chat} /> : null}
                <div className="message-cluster">
                  {message.author === "them" && chat.kind !== "dm" && message.senderName ? (
                    <div className="message-sender-name">{message.senderName}</div>
                  ) : null}
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
                        {message.rich ? <RichMessage data={message.rich} onAction={onFlexAction} /> : null}
                        {!message.rich && message.flex ? <FlexMessage data={message.flex} onAction={onFlexAction} /> : null}
                        {!message.rich && message.stickerUrl ? <StickerImage key={message.stickerUrl} src={message.stickerUrl} /> : null}
                        {!message.rich && message.emojiUrl ? <img className="message-line-emoji" src={message.emojiUrl} alt="LINE Emoji" loading="lazy" referrerPolicy="no-referrer" /> : null}
                        {!message.rich && message.image ? (
                          message.image === "food" ? <FoodCard /> : <button className="message-image-button" type="button" title="เปิดดูรูปภาพ" onClick={() => onViewImage(message.image!)}><img className="message-image" src={message.image} alt="รูปภาพ" /></button>
                        ) : null}
                         {!message.rich && message.postNotification ? (
                           <PostNotificationCard data={message.postNotification} />
                         ) : !message.rich && message.text ? (
                           <div className={`bubble ${message.status === "error" ? "bubble-error" : ""}`}>{message.text}</div>
                         ) : null}
                         {message.text && message.status !== "sending" ? <LinkPreviewFor text={message.text} /> : null}
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
                        <button className="message-retry" type="button" onClick={() => onRetry(message.id)}>ลองใหม่</button>
                      </>
                    ) : null}
                    {message.id === lastReadMineId ? <span className="message-read-receipt">อ่านแล้ว</span> : null}
                    <time>{message.time}</time>
                  </div>
                </div>
              </motion.div>
            ))}
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

function LinkPreviewFor({ text }: { text: string }) {
  const match = LINK_URL_RE.exec(String(text || ""));
  const url = match?.[1]?.replace(/[.,;:!?]+$/, "");
  if (!url) return null;
  return <LinkPreview url={url} />;
}

function LinkPreview({ url }: { url: string }) {
  const [state, setState] = useState<{ title: string; description?: string; image?: string; siteName?: string } | "loading" | "error">("loading");
  useEffect(() => {
    if (!lineyEngine.isNative) { setState("error"); return; }
    let alive = true;
    lineyEngine
      .request<{ title?: string; description?: string; image?: string; siteName?: string }>("link.preview", { url }, 12_000)
      .then((r) => { if (alive) setState(r?.title ? { title: r.title, description: r.description, image: r.image, siteName: r.siteName } : "error"); })
      .catch(() => { if (alive) setState("error"); });
    return () => { alive = false; };
  }, [url]);

  if (state === "loading") {
    return <div className="link-preview link-preview-loading"><span className="link-preview-skeleton" /></div>;
  }
  if (state === "error") {
    return <a className="link-preview link-preview-fallback" href={url} target="_blank" rel="noreferrer noopener">{url}</a>;
  }
  const s = state;
  return (
    <a className="link-preview" href={url} target="_blank" rel="noreferrer noopener">
      {s.image ? <div className="link-preview-thumb"><img src={s.image} alt="" loading="lazy" referrerPolicy="no-referrer" /></div> : null}
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

function FullSyncGate({ progress }: { progress: SyncProgressState }) {
  const copy = progress.phase === "metadata"
    ? { title: "กำลังเตรียม Full Sync", detail: "กำลังเชื่อมข้อมูลบัญชี LINE" }
    : progress.phase === "friends"
      ? { title: "กำลังซิงก์เพื่อน", detail: `${progress.done.toLocaleString("th-TH")} คน` }
      : progress.phase === "chats"
        ? { title: "กำลังซิงก์รายการแชต", detail: `${progress.done.toLocaleString("th-TH")} ห้อง` }
        : progress.phase === "history"
          ? { title: "กำลังซิงก์ประวัติข้อความ", detail: `ห้อง ${progress.done} จาก ${progress.total}${progress.failed ? ` · ข้ามแล้ว ${progress.failed}` : ""}` }
          : progress.phase === "complete"
            ? { title: "Full Sync เสร็จแล้ว", detail: `${Number(progress.summary?.friends ?? 0).toLocaleString("th-TH")} เพื่อน · ${Number(progress.summary?.talkChats ?? 0) + Number(progress.summary?.openChats ?? 0)} ห้อง${progress.failed ? ` · ${progress.failed} ห้องมีปัญหา` : ""}` }
            : { title: "Full Sync มีบางส่วนไม่สำเร็จ", detail: "แชตที่มีอยู่ในเครื่องยังไม่ถูกลบ" };
  const percent = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;
  return (
    <main className={`full-sync-gate sync-progress-${progress.phase}`} aria-live="polite">
      <section className="full-sync-card">
        <img src="/liney-logo.png" alt="Liney" className="full-sync-logo" />
        <div className="full-sync-icon">{progress.phase === "complete" ? <ShieldCheck size={25} /> : <LoaderCircle size={25} className="spin" />}</div>
        <span className="full-sync-eyebrow">LINEY · FULL SYNC</span>
        <h1>{copy.title}</h1>
        <p>{copy.detail}</p>
        <div className="full-sync-track" aria-label={`ความคืบหน้า ${percent}%`}><i style={{ width: `${progress.phase === "complete" ? 100 : percent}%` }} /></div>
        <strong className="full-sync-percent">{progress.phase === "complete" ? "100" : percent}%</strong>
        <small>กำลังเตรียมข้อมูลให้ครบก่อนเปิดหน้าแชต คุณจะเข้าใช้งานได้ทันทีเมื่อเสร็จ</small>
      </section>
    </main>
  );
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
  storageMode,
  required,
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
  storageMode: "wallet" | "session-only";
  required: boolean;
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
        <p className="eyebrow">LINEJS · DESKTOPWIN</p>
        <h2>{authenticated ? (profileName || "เชื่อม LINE แล้ว") : "เชื่อมบัญชี LINE"}</h2>
        <p className="auth-copy">{authenticated ? "บัญชีนี้เชื่อมต่อกับ Liney แล้ว" : "ต้องเข้าสู่ระบบก่อนจึงจะใช้แชตและฟีเจอร์ของ Liney ได้"}</p>

        {authenticated ? (
          <div className="auth-success">
            <ShieldCheck size={34}/>
            <strong>พร้อมใช้งานจริง</strong>
            <span>แชตปกติ, OpenChat และการส่งข้อความเชื่อม LINEJS แล้ว</span>
          </div>
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

            <div className="auth-disclaimer" role="note">
              <TriangleAlert size={18}/>
              <div>
                <strong>ข้อควรระวังการใช้งาน</strong>
                <p>Liney ไม่ใช่แอป Official ของ LINE และไม่ได้รับการรับรองจาก LY Corporation การใช้ LINEJS อาจไม่สอดคล้องหรืออาจขัดกับ TOS ของ LINE บัญชีอาจถูกจำกัดหรือระงับ ใช้งานด้วยความระมัดระวังและความเสี่ยงของคุณเอง</p>
              </div>
            </div>
            <label className="auth-consent"><input type="checkbox" checked={riskAcknowledged} onChange={(event) => setRiskAcknowledged(event.currentTarget.checked)} /><span>ฉันอ่านคำเตือนแล้วและยอมรับความเสี่ยง</span></label>

            {authMode === "qr" && !qrUrl ? (
              <button className="auth-primary" disabled={!canLogin} onClick={onStart}>
                {authBusy ? <LoaderCircle className="spin" size={17}/> : <QrCode size={17}/>} {authBusy ? "กำลังสร้าง QR Code…" : "สร้าง QR Code"}
              </button>
            ) : null}
          </>
        )}

        {error ? <div className="auth-error">{error}</div> : null}
        {authenticated ? (
          <button className="auth-secondary-danger" onClick={() => void onLogout()}>ออกจากระบบบนเครื่องนี้</button>
        ) : null}
        <div className="auth-footnote">Credential: {storageMode === "wallet" ? "Wallet / Secret Service" : "session-only (ไม่เขียน token ลงไฟล์)"} · E2EE storage อยู่ที่ ~/.local/share/liney · ไม่มี Liney server กลาง</div>
      </motion.section>
    </motion.div>
  );
}

function SettingsModal({ themeMode, dark, settings, callAvailable, onThemeMode, onSetting, onDensity, onRadius, onClearHistory, onClearStickerCache, onClose }: {
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
  onClose: () => void;
}) {
  const [tab, setTab] = useState("ทั่วไป");
  const tabs = ["ทั่วไป", "การแจ้งเตือน", "แชต", "โทร", "เพื่อน", "OpenChat", "Appearance", "ขั้นสูง", "เกี่ยวกับ"];
  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.section className="settings-modal" initial={{ opacity: 0, scale: 0.97, y: 14 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: 8 }} transition={{ duration: 0.18 }}>
        <aside className="settings-nav">
          <div className="settings-nav-title">ตั้งค่า</div>
          {tabs.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>)}
        </aside>
        <div className="settings-content">
          <header className="settings-header">
            <div><p className="eyebrow">LINEY SETTINGS</p><h2>{tab}</h2></div>
            <button className="icon-button" onClick={onClose}><X size={19} /></button>
          </header>
          {tab === "ทั่วไป" && <GeneralSettings settings={settings} themeMode={themeMode} dark={dark} onThemeMode={onThemeMode} onSetting={onSetting} />}
          {tab === "Appearance" && <AppearanceSettings settings={settings} themeMode={themeMode} dark={dark} onThemeMode={onThemeMode} onDensity={onDensity} onRadius={onRadius} />}
          {tab === "OpenChat" && <OpenChatSettings settings={settings} onSetting={onSetting} />}
          {tab === "การแจ้งเตือน" && <NotificationSettings settings={settings} onSetting={onSetting} />}
          {tab === "แชต" && <ChatSettings onClearHistory={onClearHistory} onClearStickerCache={onClearStickerCache} />}
          {tab === "โทร" && <CallSettings available={callAvailable} />}
          {tab === "เพื่อน" && <FeatureSettings title="เพื่อน" body="รายชื่อเพื่อนและรายการโปรดมาจาก LINE โดยตรง" />}
          {tab === "ขั้นสูง" && <AdvancedSettings onClearHistory={onClearHistory} />}
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
      <SettingRow title="ปรับตามธีมระบบ" subtitle="ติดตาม Light / Dark ของ KDE แบบอัตโนมัติ"><Toggle checked={themeMode === "system"} onChange={(checked) => onThemeMode(checked ? "system" : (dark ? "dark" : "light"))} /></SettingRow>
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
      <SettingRow title="แจ้งเตือนบนเดสก์ท็อป" subtitle="ใช้ระบบแจ้งเตือนของ KDE"><Toggle checked={settings.desktopNotifications} onChange={(checked) => onSetting("desktopNotifications", checked)} /></SettingRow>
      <SettingRow title="แสดงตัวอย่างข้อความ" subtitle="แสดงเนื้อหาใน notification"><Toggle checked={settings.notificationPreview} onChange={(checked) => onSetting("notificationPreview", checked)} /></SettingRow>
      <SettingRow title="เสียงแจ้งเตือน" subtitle="เล่นเสียงเมื่อมีข้อความใหม่"><Toggle checked={settings.notificationSound} onChange={(checked) => onSetting("notificationSound", checked)} /></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="เสียง">
      <SettingRow title="เสียงเริ่มต้น" subtitle="Liney Soft"><span className="settings-status status-good">ใช้กับ notification ที่เปิดเสียง</span></SettingRow>
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
      <SettingRow title="ดาวน์โหลดสื่ออัตโนมัติ" subtitle="รูปภาพจากห้อง OpenChat"><Toggle checked={settings.autoMedia} onChange={(checked) => onSetting("autoMedia", checked)} /></SettingRow>
    </SettingsGroup>
  </div>;
}

function ChatSettings({ onClearHistory, onClearStickerCache }: { onClearHistory: () => void; onClearStickerCache: () => void }) {
  return <div className="settings-scroll">
    <SettingsGroup title="ประวัติข้อความ">
      <SettingRow title="เก็บประวัติไว้ในเครื่อง" subtitle="SQLite จะเก็บจนกว่าจะกดล้างด้วยตัวเอง"><span className="settings-status status-good">เปิดใช้งาน</span></SettingRow>
      <SettingRow title="แคชสติกเกอร์ของคุณ" subtitle="รายการแพ็กจากบัญชี LINE เก็บในไฟล์ส่วนตัว 7 วัน เพื่อเปิด picker ให้เร็ว"><button className="secondary-button" type="button" onClick={onClearStickerCache}>ล้างแคชสติกเกอร์</button></SettingRow>
      <SettingRow title="ล้างประวัติและ media cache" subtitle="ลบข้อมูลข้อความในเครื่องนี้ ไม่กระทบข้อความบน LINE"><button className="secondary-button danger-outline" type="button" onClick={onClearHistory}>ล้างข้อมูล</button></SettingRow>
    </SettingsGroup>
    <SettingsGroup title="การส่งข้อความ"><SettingRow title="ส่งผ่าน outbox" subtitle="ข้อความมี local ID และกู้คืนสถานะหลัง timeout"><span className="settings-status status-good">พร้อมใช้งาน</span></SettingRow></SettingsGroup>
  </div>;
}

function CallSettings({ available }: { available: boolean }) {
  return <div className="settings-scroll">
    <div className="feature-banner"><div className="feature-icon"><Phone size={21}/></div><div><strong>เสียง 1:1</strong><p>{available ? "PipeWire และ LINEJS call transport พร้อมใช้งาน · ต้องทดสอบกับบัญชีปลายทางจริง" : "ยังไม่รองรับบนระบบนี้"}</p></div><span className={`beta-chip ${available ? "status-good" : ""}`}>{available ? "LOCAL READY" : "DISABLED"}</span></div>
    <SettingsGroup title="ขอบเขตการโทร"><SettingRow title="เสียง 1:1 ขาออก" subtitle="โทรออก mute เลือกลำโพง และวางสาย"><span className={`settings-status ${available ? "status-good" : ""}`}>{available ? "เปิดใช้งาน" : "ยังไม่พร้อม"}</span></SettingRow><SettingRow title="สายเรียกเข้า" subtitle="จะแจ้งเตือนสายเข้า แต่ปุ่มรับสายยังปิดไว้จนกว่า LINEJS จะมี answer flow ที่เสถียร"><span className="settings-status">แจ้งเตือนเท่านั้น</span></SettingRow><SettingRow title="วิดีโอ / group call / LiveTalk" subtitle="ยังไม่เปิดจนกว่าจะมี implementation และ test แยกครบ"><span className="settings-status">ปิดไว้</span></SettingRow></SettingsGroup>
  </div>;
}

function FeatureSettings({ title, body }: { title: string; body: string }) {
  return <div className="settings-scroll"><div className="settings-placeholder"><div className="placeholder-orb"><Users size={25}/></div><h3>{title}</h3><p>{body}</p><span className="settings-status status-good">เชื่อมกับ LINE โดยตรง</span></div></div>;
}

function AdvancedSettings({ onClearHistory }: { onClearHistory: () => void }) {
  return <div className="settings-scroll"><SettingsGroup title="การดูแลข้อมูล"><SettingRow title="ล้างข้อมูลในเครื่อง" subtitle="ใช้เมื่อจะส่งต่อเครื่องหรือแก้ปัญหา database"><button className="secondary-button danger-outline" type="button" onClick={onClearHistory}>ล้างประวัติ</button></SettingRow></SettingsGroup><SettingsGroup title="การเชื่อมต่อ"><SettingRow title="Full sync" subtitle="ซิงก์ friends, Talk, OpenChat และประวัติล่าสุดเป็นค่าเริ่มต้น"><span className="settings-status status-good">เปิดใช้งาน</span></SettingRow></SettingsGroup></div>;
}

function AboutSettings() {
  return <div className="settings-scroll"><div className="settings-placeholder"><div className="placeholder-orb"><Info size={25}/></div><h3>Liney 0.1.0</h3><p>Native LINE client สำหรับ Linux · JSONL engine · SQLite history · ไม่มีเซิร์ฟเวอร์กลาง</p><span className="settings-status status-good">production patch</span></div></div>;
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
  return <button className="select-like" type="button" disabled><span>{value}</span><ChevronDown size={15}/></button>;
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

function mediaLabel(contentType: number, filename: string): string {
  const label = contentType === 2 ? "วิดีโอ" : contentType === 3 ? "เสียง" : contentType === 14 ? "ไฟล์" : "รูปภาพ";
  return filename ? `${label}: ${filename}` : label;
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
  state,
  muted,
  error,
  incomingSupported,
  outputDevices,
  outputTarget,
  onAccept,
  onReject,
  onMute,
  onOutput,
  onClose,
}: {
  chat: Chat;
  peer: string;
  state: CallState;
  muted: boolean;
  error: string;
  incomingSupported: boolean;
  outputDevices: AudioDeviceResult[];
  outputTarget: string;
  onAccept: () => void;
  onReject: () => void;
  onMute: () => void;
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
    <motion.div className="call-card" initial={{ scale: .94, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: .96, y: 10 }}>
      <button className="call-expand" type="button" aria-label="ปิดหน้าต่าง" onClick={onClose}><Maximize2 size={16}/></button>
      <Avatar chat={chat} size="large" />
      <h2>{peer || chat.name}</h2>
      <p>{status}</p>
      {error ? <div className="call-note call-error">{error}</div> : null}
      {state === "in-call" ? <div className="call-wave"><i/><i/><i/><i/><i/></div> : null}
      {state === "incoming" ? (
        <div className="call-actions">
          <button className="hangup" type="button" onClick={onReject}><Phone size={20}/><span>ปฏิเสธ</span></button>
          <button type="button" disabled={!incomingSupported} title={incomingSupported ? "รับสาย" : "LINEJS ยังไม่มีเส้นทางรับสายขาเข้าที่เสถียร"} onClick={onAccept}><Phone size={20}/><span>{incomingSupported ? "รับสาย" : "รับสายยังไม่พร้อม"}</span></button>
        </div>
      ) : state === "failed" || state === "ended" ? (
        <button className="secondary-button" type="button" onClick={onClose}>ปิด</button>
      ) : (
        <div className="call-actions">
          <button type="button" className={muted ? "active" : ""} onClick={onMute}><Mic size={19}/><span>{muted ? "เปิดไมค์" : "ปิดไมค์"}</span></button>
          <button type="button" disabled title="วิดีโอคอลยังไม่รองรับ"><Video size={20}/><span>วิดีโอ</span></button>
          <label className="call-device-picker" title={outputDevices.length ? "เลือกอุปกรณ์เสียงออก" : "ไม่พบอุปกรณ์เสียงออก"}>
            <Volume2 size={19}/>
            <span>ลำโพง</span>
            <select aria-label="อุปกรณ์เสียงออก" value={outputTarget} onChange={(event) => onOutput(event.target.value)} disabled={!outputDevices.length}>
              <option value="">ค่าเริ่มต้น</option>
              {outputDevices.map((device) => <option key={device.id} value={device.id}>{device.description || device.name}</option>)}
            </select>
          </label>
          <button className="hangup" type="button" onClick={onClose}><Phone size={20}/><span>วางสาย</span></button>
        </div>
      )}
      <div className="call-note">LINE audio · PipeWire · 1:1</div>
    </motion.div>
  </motion.div>;
}
