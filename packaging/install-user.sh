#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOME_DIR=${HOME:?HOME is required}
APP_ROOT=${LINEY_INSTALL_BASE:-"$HOME_DIR/.local/lib/liney"}
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
DESKTOP_DIR="$HOME_DIR/.local/share/applications"
ICON_DIR="$HOME_DIR/.local/share/icons/hicolor/512x512/apps"
EXECUTABLES="liney liney-engine liney-media liney-audio liney-screen liney-screen-wayland liney-screen-x11"
FILES="$EXECUTABLES liney.desktop liney.png"

for name in $FILES; do
  test -f "$ROOT/$name" || { echo "Missing release file: $ROOT/$name" >&2; exit 1; }
done
for name in $EXECUTABLES; do
  test -x "$ROOT/$name" || { echo "Release file is not executable: $ROOT/$name" >&2; exit 1; }
done

fingerprint=$(
  for name in $FILES; do
    sha256sum "$ROOT/$name" | cut -d ' ' -f 1
  done | sha256sum | cut -c 1-20
)
RELEASE_ID=${LINEY_RELEASE_ID:-"sha256-$fingerprint"}
case "$RELEASE_ID" in
  ""|.|..|*[!A-Za-z0-9._-]*)
    echo "Invalid release id: $RELEASE_ID" >&2
    exit 1
    ;;
esac

RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
STAGE_DIR=""
CURRENT_TEMP=""
DESKTOP_TEMP=""
ICON_TEMP=""
cleanup() {
  [ -z "$STAGE_DIR" ] || rm -rf -- "$STAGE_DIR"
  [ -z "$CURRENT_TEMP" ] || rm -f -- "$CURRENT_TEMP"
  [ -z "$DESKTOP_TEMP" ] || rm -f -- "$DESKTOP_TEMP"
  [ -z "$ICON_TEMP" ] || rm -f -- "$ICON_TEMP"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$RELEASES_DIR" "$DESKTOP_DIR" "$ICON_DIR"

if [ -e "$RELEASE_DIR" ] || [ -L "$RELEASE_DIR" ]; then
  [ -d "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ] || {
    echo "Release destination is not a directory: $RELEASE_DIR" >&2
    exit 1
  }
  for name in $FILES; do
    cmp -s "$ROOT/$name" "$RELEASE_DIR/$name" || {
      echo "Release id already contains different files: $RELEASE_ID" >&2
      exit 1
    }
  done
else
  STAGE_DIR="$RELEASES_DIR/.stage-$RELEASE_ID-$$"
  mkdir -m 700 "$STAGE_DIR"
  for name in $EXECUTABLES; do
    install -m 755 "$ROOT/$name" "$STAGE_DIR/$name"
  done
  install -m 644 "$ROOT/liney.desktop" "$STAGE_DIR/liney.desktop"
  install -m 644 "$ROOT/liney.png" "$STAGE_DIR/liney.png"
  for name in $FILES; do
    test -s "$STAGE_DIR/$name" || {
      echo "Staged release file is empty: $name" >&2
      exit 1
    }
  done
  mv -- "$STAGE_DIR" "$RELEASE_DIR"
  STAGE_DIR=""
fi

# Prepare the launcher and icon before switching the one stable release link.
DESKTOP_TEMP="$DESKTOP_DIR/.liney.desktop.new.$$"
sed \
  -e "s|^Exec=.*$|Exec=$APP_ROOT/current/liney|" \
  -e "s|^Icon=.*$|Icon=$ICON_DIR/liney.png|" \
  "$ROOT/liney.desktop" > "$DESKTOP_TEMP"
chmod 644 "$DESKTOP_TEMP"
ICON_TEMP="$ICON_DIR/.liney.png.new.$$"
install -m 644 "$ROOT/liney.png" "$ICON_TEMP"

# All binaries live in the immutable generation above. Replacing this symlink
# switches the complete executable set in one same-filesystem rename.
if { [ -e "$CURRENT_LINK" ] || [ -L "$CURRENT_LINK" ]; } && [ ! -L "$CURRENT_LINK" ]; then
  echo "Current release pointer must be a symlink: $CURRENT_LINK" >&2
  exit 1
fi
CURRENT_TEMP="$APP_ROOT/.current.new.$$"
ln -s "releases/$RELEASE_ID" "$CURRENT_TEMP"
mv -Tf -- "$CURRENT_TEMP" "$CURRENT_LINK"
CURRENT_TEMP=""

# Publish the menu entry only after the complete release is reachable.
mv -f -- "$ICON_TEMP" "$ICON_DIR/liney.png"
ICON_TEMP=""
mv -f -- "$DESKTOP_TEMP" "$DESKTOP_DIR/liney.desktop"
DESKTOP_TEMP=""

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
fi

printf 'Installed Liney release %s for %s\n' "$RELEASE_ID" "${USER:-$(id -un)}"
printf 'Current: %s -> %s\n' "$CURRENT_LINK" "$(readlink "$CURRENT_LINK")"
printf 'Launcher: %s/liney.desktop\n' "$DESKTOP_DIR"
