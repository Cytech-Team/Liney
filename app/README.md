# Liney 0.2 — native GTK4 + Libadwaita migration preview

This is a **separate experimental desktop shell**, not a stable replacement
for Liney 0.1.3. It draws its own GTK4 widgets. **No WebKitGTK, Tauri,
Electron, Chromium, React or embedded WebView is used by this UI**.

Current scope: native window, virtualized chat/message lists, cached history,
desktop-native search, JSONL engine integration, session status, QR login
(with optional `python3-qrcode` for rendering a scannable code), and text
send with outbox confirmation.

Not yet ported: full media rendering, attachment uploads, audio/video calls,
advanced chat settings, system tray, notifications, full authentication
fallback and all React-era interaction parity. Do not mark this alpha stable.

## Test on Linux

Requires Python 3, PyGObject, GTK4 and Libadwaita; distribution packages
normally provide these together (e.g. Fedora `python3-gobject gtk4 libadwaita`).
To show a QR image, also install `python3-qrcode`.

Build the **existing**, standalone `liney-engine` sidecar using the normal
build pipeline, then:

```sh
LINEY_ENGINE_BIN=/absolute/path/to/liney-engine ./app/run-dev.sh
```

The native shell uses the existing `LINEY_DATA_DIR` and engine IPC v1.
Never run the same LINE account in both the native and legacy UI concurrently.
Do not delete or migrate the existing SQLite database during testing.

Smoke-test the native UI without credentials/network/SQLite:

```sh
LINEY_ENGINE_BIN="$PWD/app/tests/fake_engine.py" ./app/run-dev.sh
python3 -m unittest discover -s app/tests -p 'test_*.py'
```

Future distribution must bundle its own tested `liney-engine` binary alongside
this UI; end users must **not** install Bun or LINEJS separately.

## Migration plan

1. Establish secure engine IPC and GTK4 window/layout without replacing the
   old release (this milestone).
2. Complete native authentication, lazy media, notifications, tray and
   stateful message updates; test offline cache-first startup.
3. Move development and packaging entry points from Tauri to GTK4, implement
   Flatpak/AppImage/RPM/DEB packaging and cross-distro release gates.
4. Remove archived React/Tauri after feature parity and public testing.

Protocol/SQLite/LINEJS remain engine-owned; native UI never stores secrets
or parses raw LINE network traffic.
