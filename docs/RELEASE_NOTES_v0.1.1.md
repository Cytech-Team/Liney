# Liney v0.1.1 — Linux Developer Preview

This is an **unofficial, experimental LINE client for Linux** by Cytech Team Development. It is a **pre-release, not a stable release**. Not affiliated with or endorsed by LY Corporation.

## Included

- LINEJS 3.5.0 behind a versioned adapter, with review-gated upstream updates.
- QR/password session login, local SQLite cache and encrypted credential persistence / Secret Service fallback.
- Talk and OpenChat messaging, media and stickers, message edit/react/read paths, SQLite outbox and cache-first chat history.
- Experimental 1:1 audio/video calling, native audio helpers and H.264 receive pipeline.
- Experimental Wayland (XDG Desktop Portal/PipeWire) and X11 screen sharing with native helper binaries.
- Linux-only packaging. No Chrome extension or external Bun installation required for packaged builds.

## Known limitations

- **Real LINE login, calls, E2EE and screen sharing still need multi-account interoperability testing.** Passing unit tests does not validate live services.
- Video, screen sharing, Albums and some OpenChat functions remain experimental.
- Upstream unofficial LINE protocol changes may cause sessions to fail or be restricted by the provider.
- Desktop UI is legacy Tauri/React; the planned GTK4/Libadwaita frontend is not yet shipped.
- AppImage is **not included** in this preview; Bun's standalone Engine ELF currently causes linuxdeploy/GTK's dependency scanner to fail. DEB, RPM, and portable tarball are the supported preview artifacts.

Do not use a critical account without understanding the risks. Keep local sessions and keys private. Check `.sha256` files for downloaded packages. This prerelease does not auto-merge future upstream changes.

- Packaging fix: stage all native sidecar placeholders before Cargo validates the external binary set.
