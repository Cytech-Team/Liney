# Electron Runtime

Liney now uses Electron as its only desktop shell. The former Rust desktop shell, CLI dependencies, plugins, and packaging pipeline have been removed.

- React renders inside Electron Chromium.
- `electron/main.mjs` owns windows, tray, notifications, dialogs, updater and the LINEJS engine worker.
- `electron/preload.cjs` exposes a narrow context-isolated IPC API.
- `src/lib/desktop-api/` is the renderer-side typed wrapper for that Electron bridge.
- `engine/main.ts` is built into `electron/dist/engine.mjs` and runs in the Electron main process worker.
- Native helpers are staged from verified release assets; they are not built through the desktop shell.

## Commands

- `npm run electron:dev` — launch the desktop app (dev channel, isolated data dir).
- `npm run electron:build:appimage` — build AppImage.
- `npm run electron:build:preview` — build preview AppImage, DEB and RPM.
- `npm run electron:build:stable` — build stable AppImage, DEB and RPM (`dev.cytechteam.liney`).
- `npm run electron:smoke` — isolated UI/engine smoke test.

The renderer keeps `contextIsolation=true`, `sandbox=true`, and `nodeIntegration=false`.
The packaged renderer also serves a Content Security Policy, every IPC handler
rejects senders outside the app frame, and navigation is compared by protocol
and host rather than by URL prefix. The smoke run fails on any CSP violation.

## Release channels

`electron/runtime-paths.mjs` assigns each build its own data directory and
credential namespace so dev, preview and stable can never rotate the same LINE
refresh token. See `docs/LINEJS_UPSTREAM_AUTOMATION.md` for the channel table,
the release gate and the stable auto-update policy.

## Push and notifications

- The Talk sync cursor is persisted per account in SQLite (`sync_state` key
  `talk-sync-cursor`), restored before PUSH/polling attach, and sampled every
  five seconds. Without it every launch requested a full account sync, which
  could outlive the PUSH handshake window and delay notifications.
- The first Talk Sync handshake waits 8 seconds, then keeps the same PUSH
  connection open for up to 60 more seconds instead of reconnecting from
  revision zero. REST polling stays held back during that window because PUSH
  and polling share one Talk revision cursor.
- An HTTP 410 on either transport resets the cursor so the next attempt does a
  full sync.
- `auth-diagnostics.jsonl` records `push.handshake` and `push.connected` lines,
  so a "no notification" report can be checked against real transport state.

## LINE LEGY `/enc` outage (since 2026-11-18)

LINE's encrypted gateway returns empty `404` responses for `/enc` across
regions and clients. Liney therefore defaults to the plain `/S4` transport
(`legy.encrypted=false`) for QR, password and token logins, and keeps that
transport for the rest of the session. Set `LINEY_ENABLE_LEGY_ENCRYPTION=1` to
test the encrypted path; remove that opt-out once LINE restores the gateway.

Do not re-scan the QR repeatedly while `/enc` is down: upstream reports that
the QR step can log out the previous session before the new token is usable.
