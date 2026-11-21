import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const CHANNEL_DIRS = {
  stable: "liney",
  preview: "liney-electron-preview",
  dev: "liney-electron-dev",
};

/**
 * Canonicalise the parent directory (which normally already exists) and keep
 * the final component. This is stable whether or not Liney has created the
 * data directory yet, and it folds symlinked home/data roots together.
 */
function canonicalPath(value) {
  const absolute = resolve(value);
  try {
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}

function customNamespace(explicitDataDir) {
  return "custom-" + createHash("sha256").update(canonicalPath(explicitDataDir)).digest("hex").slice(0, 12);
}

/**
 * Only the packaged manifest can declare a stable build. Unknown or missing
 * values must fall back to preview so a broken build never claims stability.
 */
export function channelFromManifest(manifest) {
  return manifest && manifest.lineyChannel === "stable" ? "stable" : "preview";
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
  // A packaged manifest decides the channel. The environment flag is only a
  // fallback for builds that predate the embedded marker; otherwise a preview
  // AppImage launched with the flag would take the stable dir and lock.
  const stable = !isPackaged
    ? false
    : buildChannel === undefined
      ? env.LINEY_ELECTRON_STABLE === "1"
      : buildChannel === "stable";
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
