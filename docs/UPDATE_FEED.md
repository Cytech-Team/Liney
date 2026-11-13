# Liney Electron Update Feed

AppImage auto-update uses `electron-updater` with the GitHub Releases feed
baked into the packaged app. No manual `LINEY_UPDATE_FEED_URL` is needed for
normal installs.

## How it works

- `package.json → build.publish` points at `Cytech-Team/Liney` (`provider: github`).
  `electron-builder` writes `release-electron/latest-linux.yml` (+ `.blockmap`)
  alongside the AppImage. The `.yml` carries `version`, file `url`, `sha512`
  and signature metadata. The updater verifies these before downloading.
- `electron/main.mjs` resolves the feed via `electron/updater-config.mjs`:
  - dev (`!app.isPackaged`) → `unconfigured`, reason "disabled in development".
  - packaged non-AppImage (deb/rpm/flatpak, no `$APPIMAGE`) → `unconfigured`,
    reason "requires AppImage". Those formats update via apt/dnf/flatpak.
  - packaged AppImage, no env override → `configured: true`, provider `github`.
  - packaged AppImage + `LINEY_UPDATE_FEED_URL` → `configured: true`,
    provider `generic`, URL `${feed}/${channel}/` expecting `latest-linux.yml`.
- `autoUpdater.channel` is left at the default (`latest`) on purpose so the
  updater looks for `latest-linux.yml`. Setting it to `preview`/`stable` would
  make it look for `preview-linux.yml`, which `electron-builder` never emits.

## Preview vs Stable

- Display channel (`preview`/`stable`) comes from `LINEY_UPDATE_CHANNEL`
  (default `preview`). It only affects the About UI and `allowPrerelease`.
- `allowPrerelease = channel === "preview"`.
  - Preview builds see prereleases + stable releases (newest first from feed).
  - Stable builds (`LINEY_UPDATE_CHANNEL=stable`) see stable releases only
    (`/releases/latest`).
- Channels stay separate via GitHub stable releases vs prereleases, matching
  the About footnote. No extra hosting is required.

## CI requirements

- `release.yml` uploads `*.yml` + `*.blockmap` with the AppImage to the
  GitHub Release. Without `latest-linux.yml` in the release assets,
  `checkForUpdates()` reports `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`.
- `scripts/verify-linux-packages.sh` asserts `latest-linux.yml` exists,
  contains `version: $VERSION` and a `sha512` entry.
- Renderer (`src/App.tsx` → About → Software Updates) already handles
  `idle/checking/available/downloading/downloaded/current/unconfigured/error`
  via `liney:updater:event`. No UI change needed.

## Manual test

```sh
# Source build (expect unconfigured, dev reason)
LINEY_DATA_DIR=$(mktemp -d) npm run electron:smoke

# Packaged AppImage without network (expect checking → current/error,
# never "Update feed is not configured")
./release-electron/Liney-Electron-Preview-0.1.4-x86_64.AppImage --appimage-extract-and-run

# Self-hosted generic feed override
LINEY_UPDATE_FEED_URL=https://updates.example.com \
LINEY_UPDATE_CHANNEL=preview \
./release-electron/Liney-Electron-Preview-0.1.4-x86_64.AppImage --appimage-extract-and-run
# Serve preview/latest-linux.yml + AppImage under https://updates.example.com/preview/
```
