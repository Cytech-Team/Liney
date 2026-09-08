import { describe, expect, test } from "bun:test";
import {
  echoMatches,
  isRetryableError,
  isUncertainSendError,
  messageFingerprint,
  retryDelayMs,
} from "./outbox";
import type { OutboxRecord } from "./database";

const record: OutboxRecord = {
  localId: "local-1",
  chatId: "u-peer",
  kind: "dm",
  contentType: 0,
  text: "hello",
  fingerprint: "fingerprint",
  status: "unknown",
  attempts: 1,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe("outbox reconciliation", () => {
  test("fingerprints repeated text by sequence and content metadata", () => {
    const first = messageFingerprint({ chatId: "u-peer", kind: "dm", contentType: 0, text: "hello", createdAt: record.createdAt, sequence: 0 });
    const second = messageFingerprint({ chatId: "u-peer", kind: "dm", contentType: 0, text: "hello", createdAt: record.createdAt, sequence: 1 });
    const image = messageFingerprint({ chatId: "u-peer", kind: "dm", contentType: 1, text: "hello", createdAt: record.createdAt, sequence: 0 });
    expect(first).not.toBe(second);
    expect(first).not.toBe(image);
    expect(messageFingerprint({
      chatId: "u-peer",
      kind: "dm",
      contentType: 0,
      text: "hello",
      createdAt: record.createdAt,
      relatedMessageId: "parent-1",
    })).not.toBe(messageFingerprint({
      chatId: "u-peer",
      kind: "dm",
      contentType: 0,
      text: "hello",
      createdAt: record.createdAt,
    }));
  });

  test("does not reconcile a same-text echo from another room", () => {
    expect(echoMatches(record, { chatId: "u-peer", kind: "dm", contentType: 0, text: "hello", createdTime: record.createdAt })).toBe(true);
    expect(echoMatches({ ...record, relatedMessageId: "parent-1" }, {
      chatId: "u-peer",
      kind: "dm",
      contentType: 0,
      text: "hello",
      relatedMessageId: "other-parent",
      createdTime: record.createdAt,
    })).toBe(false);
    expect(echoMatches(record, { chatId: "u-other", kind: "dm", contentType: 0, text: "hello", createdTime: record.createdAt })).toBe(false);
    expect(echoMatches(record, { chatId: "u-peer", kind: "dm", contentType: 1, text: "hello", createdTime: record.createdAt })).toBe(false);
    expect(echoMatches(record, { chatId: "u-peer", kind: "dm", contentType: 0, text: "different", createdTime: record.createdAt })).toBe(false);
    expect(echoMatches(record, { chatId: "u-peer", kind: "dm", contentType: 0, text: "hello", createdTime: record.createdAt + 60_000 })).toBe(false);
  });

  test("reconciles media by room, type, time and filename without text", () => {
    const media: OutboxRecord = {
      ...record,
      localId: "media-1",
      contentType: 2,
      text: undefined,
      filename: "clip.mp4",
    };
    expect(echoMatches(media, {
      chatId: "u-peer",
      kind: "dm",
      contentType: 2,
      filename: "clip.mp4",
      text: "วิดีโอ",
      createdTime: record.createdAt,
    })).toBe(true);
    expect(echoMatches(media, {
      chatId: "u-peer",
      kind: "dm",
      contentType: 2,
      filename: "other.mp4",
      createdTime: record.createdAt,
    })).toBe(false);
  });

  test("classifies transport failures and applies bounded backoff", () => {
    expect(isUncertainSendError(new Error("request timed out"))).toBe(true);
    expect(isRetryableError(new Error("HTTP 503 temporarily unavailable"))).toBe(true);
    expect(isUncertainSendError(new Error("invalid message content"))).toBe(false);
    expect(retryDelayMs(1)).toBeGreaterThanOrEqual(2_000);
    expect(retryDelayMs(99)).toBeLessThanOrEqual(69_000);
  });
});
