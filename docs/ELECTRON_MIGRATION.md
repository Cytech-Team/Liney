# Electron Runtime

Liney now uses Electron as its only desktop shell. The former Rust desktop shell, CLI dependencies, plugins, and packaging pipeline have been removed.

- React renders inside Electron Chromium.
- `electron/main.mjs` owns windows, tray, notifications, dialogs, updater and the LINEJS engine worker.
- `electron/preload.cjs` exposes a narrow context-isolated IPC API.
- `src/lib/desktop-api/` is the renderer-side typed wrapper for that Electron bridge.
- `engine/main.ts` is built into `electron/dist/engine.mjs` and runs in the Electron main process worker.
- Native helpers are staged from verified release assets; they are not built through the desktop shell.

## Commands

- `npm run electron:dev` — launch the desktop app.
- `npm run electron:build:appimage` — build AppImage.
- `npm run electron:build` — build AppImage, DEB and RPM.
- `npm run electron:smoke` — isolated UI/engine smoke test.

The renderer keeps `contextIsolation=true`, `sandbox=true`, and `nodeIntegration=false`.
