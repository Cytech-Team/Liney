# Liney Electron: original React UI, not a redesigned client

This is an **isolated engineering preview**, not a replacement for 0.1.3.

## Scope

- Reuses the production React/TypeScript/CSS directly; unlike Slint there is no
  reimplementation of the app interface.
- Uses Electron Chromium on Linux instead of WebKitGTK.
- A Vite alias layer maps existing Tauri `invoke`, events, dialog, window and
  Tauri shell imports to a narrow Electron preload interface.
- Preserves original `src/lib/engine.ts` public API and dispatches requests to
  the same `engine/main.ts` via a Node.js Worker Thread.
- No Bun executable, localhost HTTP port or additional Engine service process.
  **Electron itself is multiprocess** (Chromium renderer, GPU and utilities).
- The original Tauri project and build scripts remain available for rollback.
- Actual LINE accounts, authentication, media, calls, E2EE and existing-wallet
  secrets are **not yet certified end-to-end** in Electron.

## Preview launch / packaging

```bash
npm ci
npm run electron:engine
npm run electron:web
npm run electron:dev            # Source preview
npm run electron:build:appimage # Self-contained Linux AppImage
```

The CI smoke tests use Xvfb with `--no-sandbox` **ONLY because the hosted
runner cannot enable the Chromium sandbox**. Published Linux launchers must
**never** set `--no-sandbox`; the AppImage must run on Bazzite/Fedora and other
Linux hosts with the Chromium sandbox active.

`app.asar` holds the app UI/Main/preload; Electron builder unpacks the Engine
Worker and its runtime Node dependencies for Node's module resolution. An
isolated synthetic test (`LINEY_ELECTRON_SMOKE=1`) asserts auth UI, logo,
preload, WebKit absence, and REAL LINEJS engine ping in a packaged build
without signing into LINE.

## Credentials / safety

Electron Preview always uses
`~/.local/share/liney-electron-preview` (or an explicit test
`LINEY_DATA_DIR`), NOT `~/.local/share/liney`.
Do not silently copy existing credentials, wallet secrets, private keys or
historic tokens into the preview. Production migration needs explicit
session-format tests and user data backup before touching the stable store.

Renderer has `contextIsolation=true`, `nodeIntegration=false`,
`sandbox=true`, and `webSecurity=true`. The preload exposes only a defined
Electron bridge; `open_external_url` validates HTTP(S) and prevents
file/javascript URLs. `lineyapp://app/` serves only files within the
bundled UI directory; external navigation and pop-up windows are denied.

## Feature gates before merging or public release

- Login QR/email/restore with a dedicated test account
- Real message send, receive, retries, history, E2EE
- Avatars/media, sticker, Flex, OpenChat, notifications
- Real file dialogs, window/gallery/tray, audio calls, settings and autostart
- SQLite data consistency and Secret Service/KWallet support
- Wayland and X11, GPU crash recovery, dark/light theme and fractional DPI
- Clean AppImage/DEB/RPM installs on Ubuntu, Fedora, Bazzite and Arch
- Update/rollback without session loss and without disabling the sandbox
- Baseline RAM PSS/CPU with 0/100/1000 chats and an idle authenticated account

The user-visible 0.1.3 must remain installed until these checks pass.

## Initial Bazzite results (October 29, 2026)

- AppImage approximately 132 MiB (x86_64), unpacked Electron 45.1.0.
- Launches on Bazzite KDE Wayland with **Chromium sandbox enabled**.
- Native Wayland GPU reports a Vulkan/Ozone warning: investigate before public
  release; do not claim GPU compatibility universally.
- After launch, aggregate process PSS approximately 336 MiB at login;
  not a steady-state authenticated-chat measurement and not evidence that it
  outperforms WebKitGTK.

## One-download Linux preview (x86_64)

`npm run electron:build:appimage` stages all five Liney native helpers:
`liney-media`, `liney-audio`, `liney-screen`,
`liney-screen-wayland`, `liney-screen-x11`. They ship in the same
AppImage as Electron/Chromium, the original React/CSS, LINEJS and SQLite.
No Bun/Node.js/WebKitGTK or secondary Liney executable is needed.

The helper binaries come from the **official Liney v0.1.3 Linux x86_64
release** and are verified against a pinned SHA-256 digest before staging.
Unsupported architectures fail packaging rather than shipping placeholders.

The packaged Electron main process supplies explicit
`LINEY_MEDIA_BINARY`, `LINEY_AUDIO_BINARY`, `LINEY_SCREEN_BINARY`,
`LINEY_SCREEN_WAYLAND_BINARY`, and `LINEY_SCREEN_X11_BINARY`
paths from `app.asar.unpacked/electron/native` to the LINEJS Node Worker.

**Host requirements still exist:** a compatible Linux kernel, glibc,
graphical session, system audio (ALSA/PipeWire), and DBus/Secret Service.
These are OS facilities rather than separate Liney downloads. Universal
Linux compatibility is not guaranteed.

Bazzite KDE Wayland validation: isolated fresh data, sandbox enabled,
original React login shown, LINEJS Worker ping succeeded, 5 bundled
executables present, and keyring probe from the packed native media
helper returned `{"available":true}`. Actual login, E2EE, media and
voice calls still need end-to-end testing before general release.

A first-time user downloads **one** `.AppImage`, marks it executable
if the file manager requires it, and opens it. No manual Liney-specific
dependency installation is needed.
