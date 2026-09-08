#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
USER_HOME=${HOME:-/home/namkrub}
APPDIR="$USER_HOME/.local/lib/liney"
BINDIR="$USER_HOME/.local/bin"
DESKTOPDIR="$USER_HOME/.local/share/applications"
ICONDIR="$USER_HOME/.local/share/icons/hicolor/512x512/apps"
TARGET=$(rustc -vV | sed -n 's/^host: //p')

if command -v bun >/dev/null 2>&1; then BUN=$(command -v bun); else BUN="$USER_HOME/.bun/bin/bun"; fi
test -x "$BUN" || { echo 'bun is required to build Liney' >&2; exit 1; }
PATH=$(dirname "$BUN"):$PATH
export PATH
"$BUN" run desktop:build

APP_BINARY="$ROOT/app/target/release/liney"
ENGINE_BINARY=${LINEY_ENGINE_BINARY:-$ROOT/build/liney-engine-$TARGET}
test -x "$APP_BINARY" || { echo "native Liney binary is missing: $APP_BINARY" >&2; exit 1; }
test -x "$ENGINE_BINARY" || { echo "engine sidecar is missing: $ENGINE_BINARY" >&2; exit 1; }

mkdir -p "$APPDIR" "$BINDIR" "$DESKTOPDIR" "$ICONDIR"
install -m 0755 "$APP_BINARY" "$APPDIR/liney"
install -m 0755 "$ENGINE_BINARY" "$APPDIR/liney-engine"
install -m 0644 "$ROOT/packaging/liney.png" "$ICONDIR/liney.png"
ln -sfn "$APPDIR/liney" "$BINDIR/liney"
cat > "$DESKTOPDIR/liney.desktop" <<DESKTOP
[Desktop Entry]
Name=Liney
Comment=Native GTK4 LINE desktop client for Linux
GenericName=LINE Client
Exec=$BINDIR/liney
Icon=liney
Terminal=false
Type=Application
Categories=Network;InstantMessaging;Chat;
StartupNotify=true
StartupWMClass=dev.liney.desktop
Keywords=LINE;chat;messaging;
DESKTOP
chmod 0644 "$DESKTOPDIR/liney.desktop"
rm -f "$BINDIR/liney-native" "$DESKTOPDIR/liney-native.desktop"
rm -rf "$USER_HOME/.local/lib/liney-native"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOPDIR" >/dev/null 2>&1 || true
printf 'Installed native Liney to %s\n' "$APPDIR"
