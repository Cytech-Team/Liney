import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthDiagnostics } from "./auth-diagnostics";

function tempPath(name = "auth-diagnostic.jsonl") {
  return join(mkdtempSync(join(tmpdir(), "liney-auth-diagnostics-")), name);
}

describe("auth diagnostics", () => {
  test("writes redacted JSONL entries without credentials or account identifiers", () => {
    const path = tempPath();
    const diagnostics = new AuthDiagnostics(path, () => new Date("2026-01-02T03:04:05.000Z"));

    diagnostics.record("restore.failed", {
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      password: "hunter2",
      authorization: "Bearer secret-bearer",
      cookie: "session=secret-cookie",
      nested: { refresh_token: "nested-secret", safe: "kept" },
      error: "failed for u0123456789abcdef0123456789abcdef token=abc123 email=user@example.com",
      reason: "SESSION_REJECTED",
    });

    const text = readFileSync(path, "utf8");
    expect(text).toContain('"event":"restore.failed"');
    expect(text).toContain('"reason":"SESSION_REJECTED"');
    expect(text).toContain('"safe":"kept"');
    expect(text).not.toContain("secret-access");
    expect(text).not.toContain("secret-refresh");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secret-bearer");
    expect(text).not.toContain("secret-cookie");
    expect(text).not.toContain("nested-secret");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("user@example.com");
    expect(text).not.toContain("u0123456789abcdef0123456789abcdef");
  });

  test("returns the newest entries from tail", () => {
    const path = tempPath();
    const diagnostics = new AuthDiagnostics(path);
    diagnostics.record("one");
    diagnostics.record("two");
    diagnostics.record("three");

    expect(diagnostics.tail(2).map((entry) => entry.event)).toEqual(["two", "three"]);
  });

  test("rotates the file when it grows past the configured limit", () => {
    const path = tempPath();
    const diagnostics = new AuthDiagnostics(path, undefined, { maxBytes: 240 });
    diagnostics.record("first", { detail: "x".repeat(120) });
    diagnostics.record("second", { detail: "y".repeat(120) });

    const text = readFileSync(path, "utf8");
    expect(text).not.toContain('"event":"first"');
    expect(text).toContain('"event":"second"');
  });

  test("does not throw when the diagnostics directory cannot be written", () => {
    const path = join(mkdtempSync(join(tmpdir(), "liney-auth-diagnostics-")), "not-a-directory");
    writeFileSync(path, "file", { mode: 0o600 });
    const diagnostics = new AuthDiagnostics(join(path, "auth.jsonl"));

    expect(() => diagnostics.record("safe", { reason: "ok" })).not.toThrow();
  });
});
