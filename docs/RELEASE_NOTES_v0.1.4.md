# Liney Electron Preview 0.1.4

Liney 0.1.4 moves the desktop client to an Electron-only runtime while keeping the existing React interface and LINEJS engine.

## Highlights

- **Electron desktop runtime:** runs the React UI in Chromium with a native Electron main process, preload bridge, desktop window controls, and system integration. The Tauri runtime and WebKitGTK dependency are removed.
- **LINEJS worker and local storage:** keeps LINEJS in the desktop process architecture with the existing engine interfaces and SQLite-backed runtime storage.
- **Native Linux helpers:** packages the verified media, audio, and screen helpers with the desktop app for Linux builds.
- **Linux package formats:** adds an Electron Flatpak package alongside AppImage, Debian, and RPM builds.
- **Favorites synchronization:** preserves locally known favorite state when a remote contact response omits its favorite timestamp, while respecting an explicit removal.
- **Safer startup behavior:** launch-at-login is disabled by default. Existing saved defaults are migrated to off unless the user explicitly opts in through Settings.
- **Desktop UI fixes:** retains the original React chat interface, corrects own-message alignment, and keeps the browser menu hidden in the desktop app.

## Linux downloads

The release pipeline publishes x86_64 AppImage, DEB, RPM, and Flatpak packages. Native GUI launch and packaged-worker smoke checks run in CI; Flatpak build output is verified before publication.

## Notes

Liney is an independent, unofficial desktop client for LINE and is not affiliated with or endorsed by LINE Corporation.
