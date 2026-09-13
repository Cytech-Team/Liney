export type MessagePreviewLike = {
  text?: unknown;
  contentType?: unknown;
  rich?: { altText?: unknown } | null;
  call?: { durationMs?: unknown; status?: unknown } | null;
};

export type NotificationMessageLike = {
  senderName?: unknown;
};

export type NotificationChatLike = {
  name?: unknown;
};

export function liveMessagePreview(message: MessagePreviewLike): string {
  const richAltText = String(message.rich?.altText ?? "").replace(/\s+/g, " ").trim();
  if (Number(message.contentType ?? 0) === 17 && richAltText) return richAltText;
  if (Number(message.contentType ?? 0) === 6) return callMessagePreview(message.call);
  const text = String(message.text ?? "").replace(/\s+/g, " ").trim();
  if (text && !["IMAGE", "VIDEO", "AUDIO", "STICKER", "FILE", "FLEX"].includes(text.toUpperCase())) return text;
  switch (Number(message.contentType ?? 0)) {
    case 1: return "รูปภาพ";
    case 2: return "วิดีโอ";
    case 3: return "เสียง";
    case 6: return "การโทร";
    case 7: return "สติกเกอร์";
    case 14: return "ไฟล์";
    case 16: return "มีโพสต์ใหม่";
    case 17: return richAltText || "Rich message";
    case 22: return "Flex message";
    default: return text || "ข้อความใหม่";
  }
}

function formatCallDuration(durationMs: unknown): string {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs ?? 0) / 1_000));
  if (!totalSeconds) return "";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds} วินาที`;
  if (!seconds) return `${minutes} นาที`;
  return `${minutes} นาที ${seconds} วินาที`;
}

export function callMessagePreview(call: MessagePreviewLike["call"]): string {
  const labels: Record<string, string> = {
    completed: "โทรสำเร็จ",
    canceled: "ยกเลิกการโทร",
    rejected: "ปฏิเสธสาย",
    "no-response": "ไม่มีการตอบรับ",
  };
  const label = labels[String(call?.status ?? "")] || "การโทร";
  const duration = formatCallDuration(call?.durationMs);
  return duration ? `${label} · ${duration}` : label;
}

export function isPlaceholderSenderName(value: unknown): boolean {
  const name = String(value ?? "").trim().toLocaleLowerCase("en-US");
  return !name || name === "line user" || name === "line official account" || name === "unknown";
}

export function notificationSenderName(message: NotificationMessageLike, chat?: NotificationChatLike): string {
  if (!isPlaceholderSenderName(message.senderName)) return String(message.senderName).trim();
  if (chat?.name && !isPlaceholderSenderName(chat.name)) return String(chat.name).trim();
  return "LINE";
}

// Keep this in one place so the official-client fallback and notification
// deep-link behavior cannot drift apart between the engine and WebView.
export function officialLineMessageUrl(chatId: string, messageId: string): string {
  const params = new URLSearchParams({ chatId, messageId });
  return `line://nv/chatMsg?${params.toString()}`;
}
