import { Buffer } from "node:buffer";

const BINARY_TAG = "__liney_binary_v1__";

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function bytesToTag(value: Uint8Array): Record<string, string> {
  return { [BINARY_TAG]: Buffer.from(value).toString("base64") };
}

/**
 * Convert LINEJS objects into JSON-safe values without destroying binary
 * E2EE chunks. The tagged representation is forward compatible and avoids
 * relying on JSON's implementation-specific Uint8Array serialization.
 */
export function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (isBinary(value)) return bytesToTag(value);
  if (value instanceof ArrayBuffer) {
    return bytesToTag(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return bytesToTag(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "function") out[key] = normalizeJsonValue(item);
    }
    return out;
  }
  return value;
}

function isLegacyByteRecord(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (!keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    const item = value[String(index)];
    if (item === undefined || !Number.isInteger(item) || Number(item) < 0 || Number(item) > 255) {
      return false;
    }
  }
  return keys.length === Object.keys(value).filter((key) => /^\d+$/.test(key)).length;
}

function revive(value: unknown, legacyChunk = false): unknown {
  if (Array.isArray(value)) return value.map((item) => revive(item, legacyChunk));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (typeof record[BINARY_TAG] === "string" && Object.keys(record).length === 1) {
    try {
      return Buffer.from(record[BINARY_TAG], "base64");
    } catch {
      return value;
    }
  }
  if (legacyChunk && isLegacyByteRecord(record)) {
    return Buffer.from(Object.keys(record).sort((a, b) => Number(a) - Number(b)).map((key) => Number(record[key])));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    out[key] = revive(item, key === "chunks");
  }
  return out;
}

/** Restore a persisted LINE message, including legacy numeric chunk objects. */
export function reviveMessageRaw(value: unknown): unknown {
  return revive(value);
}

export function parseJsonValue(value: unknown, messageRaw = false): unknown {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return messageRaw ? reviveMessageRaw(parsed) : revive(parsed);
  } catch {
    return undefined;
  }
}

