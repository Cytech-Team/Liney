# Liney Agent Instructions

## Product Direction

Liney 0.2 is a Linux-first unofficial LINE desktop client designed to run across as many desktop Linux distributions as practical.

The project direction is a clean architecture reset of the presentation layer while preserving the useful protocol/core work that already exists.

## Architecture Rules

1. GTK4 + Libadwaita is the only main desktop UI stack.
2. Legacy React/Tauri UI is not the future product path. Keep it only for migration/reference until removed or archived.
3. UI must never import or depend on LINEJS directly.
4. `@evex/linejs` must live behind a LineJS adapter in `liney-engine`.
5. GTK communicates with `liney-engine` through a stable versioned IPC/RPC contract.
6. SQLite is the local source of truth for user-visible cached state.
7. Startup must be cache-first: render local data first, then restore auth and refresh network state in the background.
8. Network work must never block the initial usable UI when cached data exists.
9. A single SyncCoordinator owns sync policy, priority, concurrency, cancellation, retries and freshness decisions.
10. LINE push is the primary live transport. Polling is fallback-only and must stop when push is healthy again.
11. Full Sync must not run automatically on normal startup. Normal startup uses delta/background refresh.
12. Media is lazy-loaded and viewport-driven. Do not warm large batches of media on startup.
13. Message/chat UI updates must be incremental. Do not clear and rebuild entire lists for normal events.
14. Prefer GTK model/view APIs such as `gio::ListStore`, `gtk::ListView`, selection models and list-item factories for large dynamic lists.
15. Theme values must come from a centralized design system. Do not scatter hard-coded colors, spacing, radii or typography across widgets.
16. Support System / Light / Dark through a single theme manager; Liney green is the product accent, not a replacement for semantic theme colors.
17. App state must be explicit and centralized: auth, connection, navigation, selection, sync and UI preferences.
18. Engine events are normalized, persisted, then exposed to UI. Do not maintain competing authoritative copies of the same state.
19. Outbox is offline-first: persist pending sends locally, show them immediately, reconcile server IDs/ACKs later.
20. Logging must be minimal by default and must never dump raw private chat/profile payloads, credentials, tokens, QR data or passwords.

## Target Structure

```text
Liney/
├── app/                 # GTK4 + Libadwaita UI v2
│   ├── application/
│   ├── state/
│   ├── repository/
│   ├── models/
│   ├── ui/
│   ├── theme/
│   └── bridge/
├── engine/
│   ├── protocol/
│   ├── linejs/
│   ├── auth/
│   ├── sync/
│   ├── events/
│   ├── media/
│   ├── outbox/
│   └── repository/
├── packaging/
│   ├── flatpak/
│   ├── appimage/
│   ├── deb/
│   ├── rpm/
│   └── arch/
├── tests/
├── docs/
└── website/
```

Migration may be incremental, but new code should converge toward this structure instead of extending legacy UI architecture.

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
- GNOME, KDE Plasma, XFCE, Cinnamon, MATE, LXQt and other common Linux desktops where GTK4 is supported.

Do not require end users to install Bun, Node.js, Deno or LINEJS manually. Build `liney-engine` as a standalone distributable sidecar with the pinned LINEJS dependency bundled.

For x86_64 engine release builds, prefer a broad-compatibility baseline target over CPU-specific optimizations that unnecessarily exclude older supported hardware.

## Release Workflow

Release artifacts must come from CI/reproducible build environments rather than a developer rolling-release workstation.

Each release should validate at minimum:

- engine unit tests
- RPC contract tests
- native GTK build/check
- cache-first startup behavior
- offline cached startup
- push/polling fallback behavior
- memory/CPU idle behavior
- no sensitive raw logs
- package smoke tests on representative distributions

A release should not be marked stable while normal idle/startup behavior can cause runaway CPU, repeated full sync, unbounded event processing or private-data logging.

## LINEJS Integration

Use `https://github.com/evex-dev/linejs` / `@evex/linejs` as the current protocol implementation, but treat it as replaceable infrastructure.

Do not spread LINEJS-specific calls throughout the application. Keep compatibility work inside the adapter so future LINEJS API changes, protocol breakage or alternative implementations do not require rewriting the GTK UI.

Pin and document the tested LINEJS version for each release.

## Public Distribution Safety

Liney is unofficial software. Keep product branding visually distinct from official LINE applications and retain clear independence/risk notices in public documentation.

Never ship developer credentials, session files, auth data, private logs, local SQLite databases, temporary media, personal profile/chat dumps or machine-specific paths inside release artifacts.
