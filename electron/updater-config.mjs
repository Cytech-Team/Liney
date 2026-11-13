/**
 * Pure update-feed resolution for Liney Electron.
 *
 * Renderer shows "Update feed is not configured" whenever the main process
 * reports `configured: false`. Packaged AppImage builds must resolve to the
 * baked-in GitHub Releases feed so auto-update works without manual env vars.
 * System packages (deb/rpm/flatpak) update via their package manager.
 */

const DEFAULT_OWNER = "Cytech-Team";
const DEFAULT_REPO = "Liney";

export function resolveUpdaterConfig({ isPackaged, appImagePath, feedUrlEnv, updateChannelEnv }) {
  const displayChannel = updateChannelEnv === "stable" ? "stable" : "preview";
  const allowPrerelease = displayChannel === "preview";

  if (!isPackaged) {
    return {
      configured: false,
      displayChannel,
      allowPrerelease,
      autoUpdaterChannel: null,
      reason: "Updates are disabled in development builds",
    };
  }

  if (appImagePath === undefined || appImagePath === null || appImagePath === "") {
    return {
      configured: false,
      displayChannel,
      allowPrerelease,
      autoUpdaterChannel: null,
      reason: "Automatic updates require the AppImage package",
    };
  }

  const feedBase = String(feedUrlEnv || "").trim().replace(/\/+$/, "");
  if (feedBase) {
    return {
      configured: true,
      provider: "generic",
      url: `${feedBase}/${displayChannel}/`,
      displayChannel,
      allowPrerelease,
      autoUpdaterChannel: null,
      reason: null,
    };
  }

  return {
    configured: true,
    provider: "github",
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    displayChannel,
    allowPrerelease,
    autoUpdaterChannel: null,
    reason: null,
  };
}
