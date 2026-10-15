import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCallDeviceId, loadOrCreateCallDeviceId } from "./call-device-id";

describe("call installation device id", () => {
  test("creates one stable private 32-byte base64 id", () => {
    const root = mkdtempSync(join(tmpdir(), "liney-call-id-"));
    const first = loadOrCreateCallDeviceId(root);
    const second = loadOrCreateCallDeviceId(root);
    expect(first).toBe(second);
    expect(isCallDeviceId(first)).toBe(true);
    const path = join(root, "liney", "call-device-id");
    expect(readFileSync(path, "utf8").trim()).toBe(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
