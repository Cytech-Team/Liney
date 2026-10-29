# Liney 0.2 — Native Linux architecture

## Current transition state

Liney 0.1.3 still ships the React + Tauri/WebKitGTK frontend, retained for
migration reference and to preserve feature parity. This is **not** the
destination architecture. The Liney 0.2 native preview lives under `app/`.

The planned public default is **GTK4 + Libadwaita** with no browser renderer.
Do not switch the release pipeline or deprecate the original frontend until
native smoke tests and existing user workflows have passed.

```text
                  Liney (GTK4 + Libadwaita)
                  app/ui/             app/bridge/
                  ┌──────────────────────────────┐
                  │ GTK ListView + Gio.ListStore │
                  │ Native login/chat/composer   │
                  └──────────────┬───────────────┘
                                 │ JSONL RPC v1
                                 ▼
                  ┌──────────────────────────────┐
                  │ liney-engine (Bun binary)    │
                  │ LINEJS behind adapter        │
                  │ SQLite / cache / auth        │
                  │ outbox / push / sync         │
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                           LINE services
```

## Ownership boundaries

- `app/ui/` owns GTK state and native accessibility/UI widgets only.
- `app/bridge/` owns versioned JSONL request ID, timeout, sidecar lifecycle,
  transport limits and event dispatch on the GTK main loop.
- `engine/` owns credentials, keyring, LINEJS, SQLite, media, synchronization,
  outbound queue, normalization and data authority.
- `src/` and `src-tauri/` remain transitional legacy UI.
- `native/` retains the non-UI native media/audio/screen helper work.

## Startup

Show GTK window immediately → request cached sidebar/history via engine →
restore authentication in background → push transport → bounded delta sync →
incrementally update visible GTK list models.

No full-account sync is permitted on ordinary startup. Network outages must
not block cached chat display.

## Performance and security

Use virtualized GTK `ListView` models, load media lazily, keep IPC
data-only, never evaluate network-provided UI code. The UI never imports
LINEJS. Never log raw engine lines, QR credentials or message bodies.

## Status

The `app/` prototype has a working GTK4 native window and v1 RPC bridge,
mock-engine smoke tests, cached chat/message lists, native search and text
send. It has **not** achieved functional parity with the 0.1.3 frontend
or production packaging.

See `app/README.md` for the local test procedure and migration milestones.
