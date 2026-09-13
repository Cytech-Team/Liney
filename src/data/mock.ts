export type ChatKind = "dm" | "group" | "openchat";

export type Chat = {
  id: string;
  name: string;
  subtitle: string;
  time: string;
  unread?: number;
  kind: ChatKind;
  avatar: string;
  avatarUrl?: string;
  accent: string;
  detail?: string;
  lastMessageTime?: number;
  muted?: boolean;
  pinned?: boolean;
  favoriteTimestamp?: number;
  isFavorite?: boolean;
  favoriteTime?: number;
  historyState?: "available" | "new" | "unavailable";
};

export type PostNotification = {
  kind: "album" | "note" | "post";
  action?: "created" | "added" | "posted";
  title: string;
  body?: string;
  link?: string;
};

export type FlexMessageData = {
  contents: Record<string, unknown>;
  altText?: string;
  version?: string;
  effectTag?: string;
};

export type MessageReaction = {
  type: number;
  count: number;
  mine?: boolean;
};

export type CallHistoryStatus = "completed" | "canceled" | "rejected" | "no-response" | "unknown";

export type CallHistoryData = {
  durationMs: number;
  result: string;
  cause: string;
  status: CallHistoryStatus;
};

export type ReplyReference = {
  id: string;
  text?: string;
  author?: "me" | "them";
  senderName?: string;
};

export type RichMessageAction = {
  x: number;
  y: number;
  width: number;
  height: number;
  link: string;
};

export type RichMessageData = {
  imageUrl: string;
  altText?: string;
  width?: number;
  height?: number;
  actions?: RichMessageAction[];
};

export type Message = {
  id: string;
  author: "me" | "them";
  text?: string;
  time: string;
  image?: string;
  stickerUrl?: string;
  emojiUrl?: string;
  flex?: FlexMessageData;
  filename?: string;
  reaction?: string;
  reactions?: MessageReaction[];
  replyTo?: ReplyReference;
  replyToId?: string;
  rich?: RichMessageData;
  unsent?: boolean;
  readByPeer?: boolean;
  readCount?: number;
  edited?: boolean;
  updatedTime?: number;
  status?: "sending" | "sent" | "error" | "unknown";
  createdTime?: number;
  contentType?: number;
  senderId?: string;
  senderName?: string;
  senderAvatarUrl?: string;
  officialClientUrl?: string;
  isOfficialAccount?: boolean;
  postNotification?: PostNotification;
  call?: CallHistoryData;
};

export const chats: Chat[] = [
  { id: "nagi", name: "Nagi Rin", subtitle: "ส่งรูปมาให้ดูด้วยนะ", time: "11:24", unread: 2, kind: "dm", avatar: "NR", accent: "#f28bad" },
  { id: "cytech", name: "Cytech Team", subtitle: "ประชุมวันศุกร์ 10 โมง", time: "10:46", kind: "group", avatar: "CT", accent: "#4f8cff" },
  { id: "study", name: "Design Study", subtitle: "May: เดี๋ยวลอง layout ใหม่", time: "09:18", kind: "group", avatar: "DS", accent: "#ffb86b" },
  { id: "open1", name: "Linux Thailand", subtitle: "OpenChat · 1.2K members", time: "08:52", unread: 14, kind: "openchat", avatar: "LT", accent: "#2fcf78" },
  { id: "open2", name: "Vtuber Talk", subtitle: "OpenChat · Nagi posted a photo", time: "เมื่อวาน", kind: "openchat", avatar: "VT", accent: "#a78bfa" },
  { id: "yoga", name: "Yoga club", subtitle: "Saturday 8 AM", time: "พฤ.", kind: "group", avatar: "YC", accent: "#55c2c3" },
];

export const messages: Record<string, Message[]> = {
  nagi: [
    { id: "m1", author: "them", text: "วันนี้ไปคาเฟ่มา ร้านสวยมาก", time: "11:03" },
    { id: "m2", author: "them", image: "food", time: "11:04", reaction: "♡ 3" },
    { id: "m3", author: "me", text: "เมนูน่ากินจัด เดี๋ยวไว้ไปลอง", time: "11:05" },
    { id: "m4", author: "them", text: "ไปดิ เดี๋ยวส่งโลเคชั่นให้", time: "11:06" },
  ],
  cytech: [
    { id: "c1", author: "them", text: "mock LINE client ตัวใหม่เป็นไงบ้าง", time: "10:41" },
    { id: "c2", author: "me", text: "กำลังยกขึ้น Tauri + LINEJS อยู่", time: "10:43" },
    { id: "c3", author: "them", text: "เอา UI ให้สวยก่อน ที่เหลือค่อยเสียบ", time: "10:44", reaction: "✓" },
  ],
  study: [
    { id: "s1", author: "them", text: "Spacing 16 / 20 / 24 ดูลงตัวสุด", time: "09:11" },
    { id: "s2", author: "me", text: "เอา desktop feel อย่าให้เป็น SaaS dashboard", time: "09:12" },
  ],
  open1: [
    { id: "o1", author: "them", text: "ใครลอง Artix + KDE 6.5 แล้วบ้าง", time: "08:47" },
    { id: "o2", author: "me", text: "ใช้อยู่ ลื่นดี แต่ต้องจัด service เองนิดหน่อย", time: "08:49" },
    { id: "o3", author: "them", text: "OpenChat ใน client นี้ต่อ Square ของ LINEJS ได้เลยนะ", time: "08:50", reaction: "♡ 8" },
  ],
};
