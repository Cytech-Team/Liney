import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const CHANNEL_DIRS = {
  stable: "liney",
  preview: "liney-electron-preview",
  dev: "liney-electron-dev",
};

function customNamespace(explicitDataDir) {
  return "custom-" + createHash("sha256").update(resolve(explicitDataDir)).digest("hex").slice(0, 12);
}

/**
 * Resolve the runtime channel and data locations.
 *
 * Preview keeps the legacy directory and keyring names so existing preview
 * installs keep their session. Dev and stable are isolated so two Liney
 * processes can never rotate the same refresh token at the same time.
 */
export function resolveRuntimePaths({ isPackaged, env = {}, home, xdgDataHome, buildChannel }) {
  const explicitDataDir = String(env.LINEY_DATA_DIR || "").trim();
  const stable = env.LINEY_ELECTRON_STABLE === "1" || buildChannel === "stable";
  const channel = !isPackaged ? "dev" : stable ? "stable" : "preview";
  const dataRoot = xdgDataHome || join(home, ".local/share");
  const stateDir = explicitDataDir || join(dataRoot, CHANNEL_DIRS[channel]);
  const credentialNamespace = explicitDataDir
    ? customNamespace(explicitDataDir)
    : channel === "preview"
      ? ""
      : channel;
  const userDataDir = explicitDataDir || channel !== "stable" ? stateDir : null;

  return { channel, stateDir, userDataDir, credentialNamespace };
}
