# Liney 0.2 — Native UI and LINEJS Engine in one process

A Linux-native **Slint** presentation layer that follows the original Liney
React design (70px navy navigation, 309px chat list, LINE-green bubbles,
penguin logo, light/dark color tokens). It uses Node.js Worker Threads for
the *existing* LINEJS engine **within the same operating-system process**.

This implementation does **not** use WebKitGTK, Chromium, HTML/CSS,
Electron, an HTTP server, or a standalone Bun engine process.

## Native features implemented

- Three-column chat UI, search, unread/group filters and virtualized chat list
- Chat selection, message history, outgoing text UI and pending/error states
- Cache-first conversation metadata, event-driven list model updates
- Native dark/light palette (original Liney token values)
- QR code rendered from an in-memory native RGBA image; no token logs
- Original Liney brand icon
- Real LINEJS Engine 3.5.0 loads and responds in same PID via Node Worker
- SQLite compatibility for Bun and Node without changing schema

## Development smoke test (isolated, NEVER a real account)

Requires a build machine with Node 22, Bun build tool, X11/Wayland and Slint
Linux native runtime libraries.

From repository root:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm ci --prefix app-unified --ignore-scripts
bun build engine/main.ts --target=node --packages=external --outfile app-unified/dist/engine.mjs
bun build engine/runtime/sqlite.ts --target=node --external bun:sqlite --outfile app-unified/dist/sqlite.mjs
npm test --prefix app-unified

export LINEY_UNIFIED_TEST=1
export LINEY_DISABLE_AUTO_RESTORE=1
export LINEY_DATA_DIR="$(mktemp -d)"
node app-unified/main.mjs
```

For an offline **mock** demo of the visual conversation UI:

```sh
LINEY_UNIFIED_TEST=1 LINEY_UNIFIED_MOCK_ENGINE=1 LINEY_DATA_DIR="$(mktemp -d)" node app-unified/main.mjs
```

The root `.npmrc` pins the `@jsr` scope to JSR's npm-compatible registry;
`@evex/linejs` is not published to the default npm registry.

## Not ready for production yet

**This is a native migration preview, not a complete Liney replacement.**
Production LINE QR/email auth, session restore/E2EE, image/avatar/sticker
rendering, Flex content, calls, media transfer, tray, notifications, offline
reconnection, and native app packaging need feature parity + real-account
end-to-end tests. Existing call media helpers can spawn child processes;
audit them before claiming every optional feature is zero-child-process.

Slint Node bindings are beta and Node 22 `node:sqlite` is experimental.
Bun + Slint directly crashed in testing due unsupported `uv_backend_fd` in
Bun 1.4.4; the approved route is **Node + Slint**, with Bun used only for
builds/legacy runtimes.

Keep the stable 0.1.3 Tauri app and private `~/.local/share/liney` database
untouched until the new build passes all migration gates. No credentials,
sessions, QR tokens or real LINE histories belong in the repo or CI.

See [architecture](../docs/ARCHITECTURE.md) and
[Draft PR #8](https://github.com/Cytech-Team/Liney/pull/8).
