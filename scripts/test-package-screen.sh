#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
PACKAGE_MARKER="$ROOT/build/screen-package-gate.ok"
rm -f "$PACKAGE_MARKER"

VERSION=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("package.json", "utf8")).version)')
case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) echo "Unsupported package architecture: $(uname -m)" >&2; exit 1 ;;
esac
NAME="Liney-$VERSION-linux-$ARCH"

if command -v bun >/dev/null 2>&1; then BUN=$(command -v bun); else BUN="$HOME/.bun/bin/bun"; fi
"$BUN" run build

APPIMAGE=$(find "$ROOT/src-tauri/target/release/bundle/appimage" -maxdepth 1 -type f -name '*.AppImage' -print -quit)
DEB=$(find "$ROOT/src-tauri/target/release/bundle/deb" -maxdepth 1 -type f -name '*.deb' -print -quit)
RPM=$(find "$ROOT/src-tauri/target/release/bundle/rpm" -maxdepth 1 -type f -name '*.rpm' -print -quit)
for artifact in "$APPIMAGE" "$DEB" "$RPM"; do
  [ -n "$artifact" ] && [ -s "$artifact" ] || { echo "missing current Tauri package artifact: $artifact" >&2; exit 1; }
done

TMP_PARENT=${LINEY_TMPDIR:-"$ROOT/build/tmp"}
mkdir -p "$TMP_PARENT"
TMP=$(mktemp -d "$TMP_PARENT/liney-package-screen.XXXXXX")
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT HUP INT TERM

TARGET=$(rustc -vV | sed -n 's/^host: //p')
SOURCE_X11="$ROOT/build/liney-screen-x11-$TARGET"
[ -x "$SOURCE_X11" ] || { echo "current X11 helper is not built" >&2; exit 1; }

DEB_ROOT="$TMP/deb"
mkdir -p "$DEB_ROOT"
dpkg-deb --extract "$DEB" "$DEB_ROOT"
[ -x "$DEB_ROOT/usr/bin/liney-screen-x11" ]
cmp -s "$SOURCE_X11" "$DEB_ROOT/usr/bin/liney-screen-x11"

RPM_ROOT="$TMP/rpm"
mkdir -p "$RPM_ROOT"
if command -v rpm2cpio >/dev/null 2>&1 && command -v cpio >/dev/null 2>&1; then
  (cd "$RPM_ROOT" && rpm2cpio "$RPM" | cpio -idmu 2>/dev/null)
elif command -v bsdtar >/dev/null 2>&1; then
  (cd "$RPM_ROOT" && bsdtar -xf "$RPM")
elif command -v rpm >/dev/null 2>&1; then
  rpm -qpl "$RPM" | grep -q 'usr/bin/liney-screen-x11'
else
  echo "cannot inspect RPM contents" >&2
  exit 1
fi
[ -x "$RPM_ROOT/usr/bin/liney-screen-x11" ]
cmp -s "$SOURCE_X11" "$RPM_ROOT/usr/bin/liney-screen-x11"

(
  cd "$TMP"
  "$APPIMAGE" --appimage-extract >/dev/null 2>&1
)
[ -x "$TMP/squashfs-root/usr/bin/liney-screen-x11" ]
command -v readelf >/dev/null 2>&1 || { echo "readelf is required to inspect the AppImage helper build id" >&2; exit 1; }
elf_build_id() {
  readelf -n "$1" | sed -n 's/.*Build ID: //p' | head -n 1
}
SOURCE_BUILD_ID=$(elf_build_id "$SOURCE_X11")
APPIMAGE_BUILD_ID=$(elf_build_id "$TMP/squashfs-root/usr/bin/liney-screen-x11")
[ -n "$SOURCE_BUILD_ID" ] && [ "$SOURCE_BUILD_ID" = "$APPIMAGE_BUILD_ID" ] || {
  echo "AppImage X11 helper build id does not match the source helper" >&2
  exit 1
}

PORTABLE="$ROOT/build/local-deploy/$NAME"
rm -rf -- "$PORTABLE"
mkdir -p "$(dirname -- "$PORTABLE")" "$PORTABLE"
install -m 755 "$ROOT/src-tauri/target/release/liney" "$PORTABLE/liney"
for name in liney-engine liney-media liney-audio liney-screen liney-screen-wayland liney-screen-x11; do
  install -m 755 "$ROOT/build/$name-$TARGET" "$PORTABLE/$name"
done
install -m 755 "$ROOT/packaging/install-user.sh" "$PORTABLE/install-user.sh"
install -m 644 "$ROOT/packaging/liney.desktop" "$PORTABLE/liney.desktop"
install -m 644 "$ROOT/packaging/liney.png" "$PORTABLE/liney.png"
install -m 644 "$ROOT/README.md" "$PORTABLE/README.md"
install -m 644 "$ROOT/LICENSE" "$PORTABLE/LICENSE"

sh "$ROOT/scripts/test-atomic-deploy.sh" "$PORTABLE"
X11_DIGEST=$(sha256sum "$SOURCE_X11" | cut -d ' ' -f 1)
printf '%s %s\n' "$VERSION" "$X11_DIGEST" > "$PACKAGE_MARKER"

echo "PACKAGE_SCREEN_OK"
