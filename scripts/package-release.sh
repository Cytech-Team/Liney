#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOME_DIR=${HOME:-/home/namkrub}
TMPDIR=${LINEY_TMPDIR:-$ROOT/build/tmp-release}
mkdir -p "$TMPDIR"
export TMPDIR
if command -v bun >/dev/null 2>&1; then BUN=$(command -v bun); else BUN="$HOME_DIR/.bun/bin/bun"; fi
test -x "$BUN" || { echo "bun is required" >&2; exit 1; }

cd "$ROOT"
VERSION=$($BUN -e 'console.log(require("./package.json").version)')
case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) echo "Unsupported release architecture: $(uname -m)" >&2; exit 1 ;;
esac

OUT="$ROOT/release"
WORK="$OUT/.stage-$ARCH"
rm -rf "$WORK"
mkdir -p "$OUT" "$WORK"

"$BUN" run doctor
"$BUN" test
"$BUN" run lint
"$BUN" run build

APP="$ROOT/src-tauri/target/release/liney"
TARGET=$(rustc -vV | sed -n 's/^host: //p')
ENGINE="$ROOT/src-tauri/binaries/liney-engine-$TARGET"
APPIMAGE=$(find "$ROOT/src-tauri/target/release/bundle/appimage" -maxdepth 1 -type f -name '*.AppImage' -print -quit)
DEB=$(find "$ROOT/src-tauri/target/release/bundle/deb" -maxdepth 1 -type f -name '*.deb' -print -quit)
RPM=$(find "$ROOT/src-tauri/target/release/bundle/rpm" -maxdepth 1 -type f -name '*.rpm' -print -quit 2>/dev/null || true)

test -x "$APP"
test -x "$ENGINE"
test -n "$APPIMAGE" && test -f "$APPIMAGE"
test -n "$DEB" && test -f "$DEB"

APPIMAGE_OUT="$OUT/Liney-${VERSION}-linux-${ARCH}.AppImage"
DEB_OUT="$OUT/Liney-${VERSION}-linux-${ARCH}.deb"
cp "$APPIMAGE" "$APPIMAGE_OUT"
cp "$DEB" "$DEB_OUT"
chmod +x "$APPIMAGE_OUT"

if [ -n "$RPM" ] && [ -f "$RPM" ]; then
  RPM_OUT="$OUT/Liney-${VERSION}-linux-${ARCH}.rpm"
  cp "$RPM" "$RPM_OUT"
fi

PORTABLE_NAME="Liney-${VERSION}-linux-${ARCH}"
PORTABLE="$WORK/$PORTABLE_NAME"
mkdir -p "$PORTABLE"
install -m755 "$APP" "$PORTABLE/liney"
install -m755 "$ENGINE" "$PORTABLE/liney-engine"
install -m755 "$ROOT/packaging/install-user.sh" "$PORTABLE/install-user.sh"
install -m644 "$ROOT/packaging/liney.desktop" "$PORTABLE/liney.desktop"
install -m644 "$ROOT/packaging/liney.png" "$PORTABLE/liney.png"
install -m644 "$ROOT/README.md" "$PORTABLE/README.md"
install -m644 "$ROOT/LICENSE" "$PORTABLE/LICENSE"

tar -C "$WORK" -czf "$OUT/$PORTABLE_NAME.tar.gz" "$PORTABLE_NAME"

APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE_OUT" --appimage-version >/dev/null
if command -v dpkg-deb >/dev/null 2>&1; then
  dpkg-deb --info "$DEB_OUT" >/dev/null
  dpkg-deb --contents "$DEB_OUT" | grep -q 'usr/bin/liney-engine'
fi

ENGINE_SMOKE="$TMPDIR/liney-engine-smoke.log"
rm -f "$ENGINE_SMOKE"
set +e
(printf '%s\n' '{"id":"release-smoke","version":1,"method":"ping","params":{}}'; sleep 1) \
  | timeout 4 "$PORTABLE/liney-engine" > "$ENGINE_SMOKE" 2>&1
ENGINE_SMOKE_STATUS=$?
set -e
if [ "$ENGINE_SMOKE_STATUS" -ne 0 ] && [ "$ENGINE_SMOKE_STATUS" -ne 124 ]; then
  cat "$ENGINE_SMOKE" >&2
  exit "$ENGINE_SMOKE_STATUS"
fi
grep -q '"pong":true' "$ENGINE_SMOKE"

CHECKSUM="$OUT/Liney-${VERSION}-linux-${ARCH}.sha256"
(
  cd "$OUT"
  files="Liney-${VERSION}-linux-${ARCH}.AppImage Liney-${VERSION}-linux-${ARCH}.deb $PORTABLE_NAME.tar.gz"
  if [ -f "Liney-${VERSION}-linux-${ARCH}.rpm" ]; then files="$files Liney-${VERSION}-linux-${ARCH}.rpm"; fi
  # shellcheck disable=SC2086
  sha256sum $files
) > "$CHECKSUM"

rm -rf "$WORK"
printf 'Release artifacts ready in %s\n' "$OUT"
ls -lh "$OUT"/Liney-${VERSION}-linux-${ARCH}*
