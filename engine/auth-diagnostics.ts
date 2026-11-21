import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type AuthDiagnosticEntry = {
  at: string;
  event: string;
  [key: string]: unknown;
};

const SECRET_KEY = /(?:token|secret|password|passwd|authorization|cookie|credential)/i;
const JWT = /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\b(?:Bearer\s+)?(?:accessToken|refreshToken|authToken|authorization|token)\s*[:=]\s*[^\s,;]+/gi;
const PASSWORD = /\b(?:password|passwd)\s*[:=]\s*[^\s,;]+/gi;
// Opaque credentials (base64url / long hex) that are not in a keyed field.
const OPAQUE_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;
const MID = /\bu[0-9a-f]{32}\b/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MAX_STRING = 500;

export function redactDiagnosticString(value: string): string {
  return value
    .replace(JWT, "[redacted]")
    .replace(BEARER, "[redacted]")
    .replace(PASSWORD, "password=[redacted]")
    .replace(OPAQUE_TOKEN, "[redacted]")
    .replace(MID, "[mid]")
    .replace(EMAIL, "[email]")
    .slice(0, MAX_STRING);
}

export function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return redactDiagnosticString(value);
  if (Array.isArray(value)) return value.map(redactDiagnosticValue);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY.test(key) ? "[redacted]" : redactDiagnosticValue(item);
    }
    return output;
  }
  return value;
}

/**
 * Small, redacted auth journal for diagnosing session loss on a user machine.
 * It deliberately stores no tokens, credentials, message bodies or profile data.
 */
export class AuthDiagnostics {
  private readonly now: () => Date;
  private readonly maxBytes: number;

  constructor(
    private readonly path: string,
    now: () => Date = () => new Date(),
    options: { maxBytes?: number } = {},
  ) {
    this.now = now;
    this.maxBytes = options.maxBytes ?? 256 * 1024;
  }

  record(event: string, fields: Record<string, unknown> = {}): void {
    try {
      const redacted = redactDiagnosticValue(fields) as Record<string, unknown>;
      const entry: AuthDiagnosticEntry = {
        ...redacted,
        at: this.now().toISOString(),
        event: redactDiagnosticString(event),
      };
      const line = `${JSON.stringify(entry)}\n`;
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        if (statSync(this.path).size + Buffer.byteLength(line) > this.maxBytes) {
          renameSync(this.path, `${this.path}.1`);
        }
      } catch {
        // The file does not exist yet.
      }
      appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Diagnostics must never break authentication.
    }
  }

  tail(limit = 200): AuthDiagnosticEntry[] {
    try {
      const lines = readFileSync(this.path, "utf8").trim().split("\n").filter(Boolean);
      return lines.slice(-Math.max(1, limit)).flatMap((line) => {
        try {
          return [JSON.parse(line) as AuthDiagnosticEntry];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }
}
