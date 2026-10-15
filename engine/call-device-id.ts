import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadOrCreateCallDeviceId(configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")): string {
  const dir = join(configRoot, "liney");
  const path = join(dir, "call-device-id");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const saved = readFileSync(path, "utf8").trim();
    if (isCallDeviceId(saved)) {
      chmodSync(path, 0o600);
      return saved;
    }
  } catch {
    // Create a new installation-scoped identifier below.
  }
  const value = randomBytes(32).toString("base64");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return value;
}

export function isCallDeviceId(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}
