# Liney Architecture

Liney is an Electron desktop application with a React renderer and a dedicated LINEJS engine worker. Electron owns the desktop runtime and build chain.

```text
Electron Main Process
  ├─ BrowserWindow + Chromium renderer
  ├─ preload.cjs (contextBridge, explicit IPC surface)
  ├─ Native desktop integration (Tray, notifications, dialogs, windows)
  └─ LINEJS Engine Worker (Bun-built JavaScript)
       ├─ LINE protocol / sync
       ├─ SQLite local state
       └─ verified native helpers (media, audio, screen capture)
```

## Development

```sh
npm install
npm run electron:dev
```

## Build

```sh
npm run electron:build:appimage
# or all Linux package formats
npm run electron:build
```

The renderer has no Node.js integration. `contextIsolation` and sandboxing remain enabled; all privileged operations go through the narrow Electron preload bridge.
