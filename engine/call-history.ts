export type CallHistoryStatus = "completed" | "canceled" | "rejected" | "no-response" | "unknown";

export type CallHistoryData = {
  durationMs: number;
  result: string;
  cause: string;
  status: CallHistoryStatus;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function contentMetadata(raw: Record<string, unknown>): Record<string, unknown> {
  const value = raw.contentMetadata;
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

function clean(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function legacyCallText(value: unknown): { durationMs?: number; cause?: string } {
  const match = /^call\s+history\s*:\s*(\d+(?:\.\d+)?)\s*millisecs?\s*,\s*result\s*:\s*([^\s]+)$/i.exec(String(value ?? "").trim());
  if (!match) return {};
  return {
    durationMs: nonNegativeNumber(match[1]),
    cause: clean(match[2]),
  };
}

function callStatus(result: string, cause: string): CallHistoryStatus {
  if (result === "NORMAL" || cause === "16") return "completed";
  if (result === "CANCELED" || cause === "77") return "canceled";
  if (result === "REJECTED" || cause === "21") return "rejected";
  if (result === "NO_RESPONSE" || result === "NO_ANSWER" || cause === "18") return "no-response";
  return "unknown";
}

export function parseCallHistory(value: unknown): CallHistoryData | null {
  const raw = record(value);
  const contentType = raw.contentType;
  if (Number(contentType) !== 6 && String(contentType ?? "").trim().toUpperCase() !== "CALL") return null;

  const metadata = contentMetadata(raw);
  const legacy = legacyCallText(raw.text);
  const durationMs = nonNegativeNumber(metadata.DURATION) ?? legacy.durationMs ?? 0;
  const result = clean(metadata.RESULT);
  const cause = clean(metadata.CAUSE) || legacy.cause || "";
  return {
    durationMs,
    result,
    cause,
    status: callStatus(result, cause),
  };
}

export function formatCallDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  if (!totalSeconds) return "";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds} วินาที`;
  if (!seconds) return `${minutes} นาที`;
  return `${minutes} นาที ${seconds} วินาที`;
}

export function callHistoryStatusLabel(status: CallHistoryStatus): string {
  switch (status) {
    case "completed": return "โทรสำเร็จ";
    case "canceled": return "ยกเลิกการโทร";
    case "rejected": return "ปฏิเสธสาย";
    case "no-response": return "ไม่มีการตอบรับ";
    default: return "การโทร";
  }
}

export function callHistoryPreview(call: CallHistoryData | null | undefined): string {
  if (!call) return "การโทร";
  const duration = formatCallDuration(call.durationMs);
  return duration ? `${callHistoryStatusLabel(call.status)} · ${duration}` : callHistoryStatusLabel(call.status);
}
