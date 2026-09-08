import { createHash } from "node:crypto";
import type { ChatKind, OutboxRecord } from "./database";

export type FingerprintInput = {
  chatId: string;
  kind: ChatKind;
  contentType: number;
  text?: string;
  createdAt: number;
  sequence?: number;
  relatedMessageId?: string;
};

export type EchoCandidate = {
  chatId: string;
  kind: ChatKind;
  contentType?: number;
  text?: string;
  filename?: string;
  createdTime?: number;
  id?: string;
  relatedMessageId?: string;
};

function canonicalText(text: string | undefined): string {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

export function messageFingerprint(input: FingerprintInput): string {
  const payload = [
    input.chatId,
    input.kind,
    String(input.contentType),
    canonicalText(input.text),
    String(Math.floor(input.createdAt / 1_000)),
    String(input.sequence ?? 0),
    String(input.relatedMessageId ?? ""),
  ].join("\u001f");
  return createHash("sha256").update(payload).digest("hex");
}

export function isRetryableError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return /timeout|timed out|network|fetch|socket|econn|offline|temporar|429|5\d\d/.test(message);
}

export function isUncertainSendError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return /timeout|timed out|socket hang up|econnreset|connection reset|network/.test(message);
}

export function retryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 8));
  const base = Math.min(60_000, 1_000 * 2 ** safeAttempt);
  const jitter = Math.floor(base * 0.15 * Math.random());
  return base + jitter;
}

export function echoMatches(record: OutboxRecord, candidate: EchoCandidate): boolean {
  if (record.chatId !== candidate.chatId || record.kind !== candidate.kind) return false;
  if (candidate.contentType !== undefined && candidate.contentType !== record.contentType) return false;
  const time = candidate.createdTime ?? Date.now();
  if (Math.abs(time - record.createdAt) > 45_000) return false;
  if (record.filename && candidate.filename && record.filename !== candidate.filename) return false;
  if (record.relatedMessageId && candidate.relatedMessageId !== record.relatedMessageId) return false;
  if (record.contentType !== 0 && !record.text) return true;
  return canonicalText(record.text) === canonicalText(candidate.text);
}

export function outboxToMessage(record: OutboxRecord): {
  id: string;
  chatId: string;
  kind: ChatKind;
  text?: string;
  isMine: true;
  createdTime: number;
  contentType: number;
  status: OutboxRecord["status"];
  replyToId?: string;
} {
  return {
    id: record.localId,
    chatId: record.chatId,
    kind: record.kind,
    text: record.text,
    isMine: true,
    createdTime: record.createdAt,
    contentType: record.contentType,
    ...(record.relatedMessageId ? { replyToId: record.relatedMessageId } : {}),
    status: record.status,
  };
}
