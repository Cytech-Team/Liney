# Liney v0.2 — Native Single-Process Architecture (Migration)

**Product requirement:** The release app must be a real native desktop app, preserve the original
Liney desktop appearance, contain its own LINEJS Engine, and avoid WebKitGTK, Chromium and WebView.
There must be **no localhost HTTP server** or standalone engine sidecar.

```text
Liney executable (ONE OS process)
  ├── Main Thread: Slint native UI
  │   ├── Original Liney three-column design, light/dark palette, penguin logo
  │   ├── Virtualized chat list and conversation bubbles
  │   ├── Native QR image generation (no HTML)
  │   └── Outbox UI & offline cached state
  └── Worker Thread (SAME PID): LINEJS Engine
      ├── Existing @evex/linejs adapter (pinned 3.5.0)
      ├── SyncCoordinator, push events, bounded polling
      ├── SQLite and session ownership
      ├── Message outbox, media, calls
      └── Versioned in-memory request/event messages
```

## Implemented

- `app-unified/ui/main.slint` is a native Slint scene, not a React/WebView wrapper.
- `app-unified/main.mjs` loads Engine in Node Worker, not a child process.
- `engine/main.ts` keeps compatibility with legacy stdin/stdout JSONL only for
  old v0.1.3; native Worker messaging is structured and in-memory.
- `engine/runtime/sqlite.ts` abstracts Bun SQLite and Node SQLite without
  destructive migration or schema resets.
- Original Liney visual palette and icon used; chat list, bubbles, search,
  filters, send text, cache-first rendering and QR UI implemented.
- Isolated mock UI smoke and real LINEJS startup/ping without account data.
- Actual network log-in, sending, media and calls are **not yet end-to-end verified**.

## Constraints

- One OS process does NOT mean one thread. Worker threads isolate sync and
  network operations from render loop, and maintain the same PID.
- Windows/GUI events stay on the main thread; engine callbacks must not block
  first paint. Database and credentials only belong to the Engine Worker.
- Slint Node runtime is beta, and Node 22's `node:sqlite` experimental.
  Bun+Slint crashed on the tested Bun 1.4.4 at `uv_backend_fd`.
- Calls and screen sharing may currently use external native helpers; audit
  these before advertising fully zero child processes for all features.
- Authentication QR URLs are sensitive and never appear in logs, telemetry,
  screenshots committed to source control, or CLI arguments.
- No real user data or credentials should be used for preview/CI tests.
- Do not delete, reset or overwrite `~/.local/share/liney` during migration.

## Release gates

1. Real auth (QR/email/session restore/E2EE) with a dedicated test account.
2. Messages, profile pictures, group avatars, media, stickers/Flex, read
   status, notifications, tray and calling feature parity.
3. Bazzite KDE/Wayland and X11, GTK font fallback, Thai Unicode, HiDPI.
4. Release bundles app + embedded Node runtime + native libraries as ONE
   installation with no user-provided Node/Bun tools; test RPM/AppImage.
5. Compare idle RAM/CPU, chat-list stress, startup and memory leaks against
   original v0.1.3 using identical data, without logging private payloads.
6. Satisfy Slint licensing/attribution requirements in actual release artifacts.

Keep legacy implementation as fallback until all gates pass.
