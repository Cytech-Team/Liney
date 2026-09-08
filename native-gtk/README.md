# Liney

This directory contains the primary Liney desktop application for Linux. The
UI is native GTK4 and talks to `liney-engine` through a private JSONL
stdin/stdout pipe. It does not start an HTTP server, bind a localhost port, or
embed a browser/WebView.

The historical React/Tauri frontend is retained in the repository only as a
legacy migration/reference implementation. It is not the default desktop
build and is not used by the native packaging scripts.

```sh
bun run desktop:dev
```

Build the native release binary with:

```sh
bun run desktop:build
```
