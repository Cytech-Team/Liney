#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOME_DIR=${HOME:?HOME is required}
APP_DIR="$HOME_DIR/.local/lib/liney"
DESKTOP_DIR="$HOME_DIR/.local/share/applications"
ICON_DIR="$HOME_DIR/.local/share/icons/hicolor/512x512/apps"

for file in liney liney-engine liney.desktop liney.png; do
  test -f "$ROOT/$file" || { echo "Missing release file: $file" >&2; exit 1; }
done

mkdir -p "$APP_DIR" "$DESKTOP_DIR" "$ICON_DIR"

install_atomic() {
  source=$1
  target=$2
  mode=$3
  temp="${target}.new.$$"
  install -m"$mode" "$source" "$temp"
  mv -f "$temp" "$target"
}

install_atomic "$ROOT/liney" "$APP_DIR/liney" 755
install_atomic "$ROOT/liney-engine" "$APP_DIR/liney-engine" 755
install_atomic "$ROOT/liney.png" "$ICON_DIR/liney.png" 644

sed "s|^Exec=.*$|Exec=$APP_DIR/liney|" "$ROOT/liney.desktop" > "$DESKTOP_DIR/liney.desktop.new.$$"
chmod 644 "$DESKTOP_DIR/liney.desktop.new.$$"
mv -f "$DESKTOP_DIR/liney.desktop.new.$$" "$DESKTOP_DIR/liney.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

printf 'Installed Liney for %s\n' "$USER"
printf 'Launcher: %s\n' "$DESKTOP_DIR/liney.desktop"
