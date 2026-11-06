# Liney Agent Instructions

## Product Direction

Liney 0.2 is a Linux-first unofficial LINE desktop client designed to run across as many desktop Linux distributions as practical.

The project direction is Electron (Chromium) as the desktop shell, reusing the existing React UI and the `liney-engine` core verbatim — no UI reimplementation. See `docs/ELECTRON_MIGRATION.md` for the preview scope and the feature gates before merge/release.

## Architecture Rules

1. Electron is the main desktop shell: Chromium renderer + Node.js Worker thread running `engine/main.ts` in-process. No separate engine service process, no localhost HTTP port.
2. The React UI in `src/` is the product UI. Electron is the only desktop shell; do not add a second desktop runtime.
3. Renderer must never import or depend on LINEJS directly.
4. `@evex/linejs` must live behind a LineJS adapter in `liney-engine`.
5. Renderer talks to the engine only through the preload bridge (`electron/preload.cjs`) and the `src/lib/desktop-api/` typed adapter layer mapping desktop commands/events to Electron IPC. No direct Node access from the renderer (`contextIsolation=true`, `sandbox=true`).
6. SQLite is the local source of truth for user-visible cached state.
7. Startup must be cache-first: render local data first, then restore auth and refresh network state in the background.
8. Network work must never block the initial usable UI when cached data exists.
9. A single SyncCoordinator owns sync policy, priority, concurrency, cancellation, retries and freshness decisions.
10. LINE push is the primary live transport. Polling is fallback-only and must stop when push is healthy again.
11. Full Sync must not run automatically on normal startup. Normal startup uses delta/background refresh.
12. Media is lazy-loaded and viewport-driven. Do not warm large batches of media on startup.
13. Message/chat UI updates must be incremental. Do not clear and rebuild entire lists for normal events.
14. Large dynamic lists must stay virtualized (`@tanstack/react-virtual`) with incremental updates. Do not clear and rebuild entire lists for normal events.
15. Theme values must come from a centralized design system. Do not scatter hard-coded colors, spacing, radii or typography across widgets.
16. Support System / Light / Dark through a single theme manager; Liney green is the product accent, not a replacement for semantic theme colors.
17. App state must be explicit and centralized: auth, connection, navigation, selection, sync and UI preferences.
18. Engine events are normalized, persisted, then exposed to UI. Do not maintain competing authoritative copies of the same state.
19. Outbox is offline-first: persist pending sends locally, show them immediately, reconcile server IDs/ACKs later.
20. Logging must be minimal by default and must never dump raw private chat/profile payloads, credentials, tokens, QR data or passwords.

## Target Structure

```text
Liney/
├── electron/            # Electron shell: main.mjs, preload.cjs, staged native helpers
│   ├── main.mjs
│   ├── preload.cjs
│   └── native/          # staged liney-media/audio/screen/wayland/x11 (gitignored, CI-staged)
├── src/                 # React product UI (reused verbatim under Electron)
│   ├── lib/desktop-api/     # typed desktop API mapped to the Electron preload bridge
│   └── components/
├── engine/              # liney-engine core, runs in Node Worker under Electron
│   ├── protocol/
│   ├── linejs/
│   ├── auth/
│   ├── sync/
│   ├── events/
│   ├── media/
│   ├── outbox/
│   └── repository/
├── electron/            # main process, preload and worker runtime
├── packaging/
│   ├── flatpak/
│   ├── appimage/
│   ├── deb/
│   ├── rpm/
│   └── arch/
├── tests/
├── docs/                # ELECTRON_MIGRATION.md is the gate list
└── website/
```

New desktop functionality must use Electron main-process APIs and the narrow preload bridge.

## Startup Workflow

Expected normal startup:

```text
process start
-> load settings
-> open SQLite
-> render cached chats/messages immediately
-> restore authentication in background
-> connect push transport
-> evaluate freshness/sync state
-> run bounded delta sync
-> normalize incoming changes
-> commit SQLite transaction
-> incrementally update UI models
```

Offline or degraded network state must still allow cached history to remain usable.

## Sync Priorities

Default priority order:

1. Active conversation
2. Unread conversations
3. Recently active conversations
4. Other metadata/history
5. Media prefetch/background maintenance

Keep concurrency bounded. Full-account sync is an explicit maintenance operation, not the default startup behavior.

## Distribution Strategy

Primary distribution targets:

- Flatpak / Flathub: recommended general Linux distribution path.
- AppImage: portable fallback.
- Native packages: DEB, RPM and Arch package/AUR for convenience.
- Portable tarball: testing/manual fallback.

Target architectures:

- x86_64
- aarch64

Target desktop/display environments:

- Wayland
- X11/XWayland compatibility where needed
- GNOME, KDE Plasma, XFCE, Cinnamon, MATE, LXQt and other common Linux desktops where Electron/Chromium runs.

Do not require end users to install Bun, Node.js, Deno or LINEJS manually. The Electron AppImage/DEB/RPM must bundle the engine Worker, its pinned LINEJS dependency and the verified native helpers.

For x86_64 engine release builds, prefer a broad-compatibility baseline target over CPU-specific optimizations that unnecessarily exclude older supported hardware.

## Release Workflow

Release artifacts must come from CI/reproducible build environments rather than a developer rolling-release workstation.

Each release should validate at minimum:

- engine unit tests
- RPC contract tests
- Electron source + packaged smoke (engine pong, auth dialog, preload bridge, no WebKit, sandbox on)
- cache-first startup behavior
- offline cached startup
- push/polling fallback behavior
- memory/CPU idle behavior
- no sensitive raw logs
- package smoke tests on representative distributions

A release should not be marked stable while normal idle/startup behavior can cause runaway CPU, repeated full sync, unbounded event processing or private-data logging.

## LINEJS Integration

Use `https://github.com/evex-dev/linejs` / `@evex/linejs` as the current protocol implementation, but treat it as replaceable infrastructure.

Do not spread LINEJS-specific calls throughout the application. Keep compatibility work inside the adapter so future LINEJS API changes, protocol breakage or alternative implementations do not require rewriting the React UI or the Electron shell.

Pin and document the tested LINEJS version for each release.

## Public Distribution Safety

Liney is unofficial software. Keep product branding visually distinct from official LINE applications and retain clear independence/risk notices in public documentation.

Never ship developer credentials, session files, auth data, private logs, local SQLite databases, temporary media, personal profile/chat dumps or machine-specific paths inside release artifacts.
