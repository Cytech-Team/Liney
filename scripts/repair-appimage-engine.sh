#!/bin/sh
# Bun --compile binaries must not be modified by linuxdeploy/patchelf.
# Its ELF trailer holds embedded runtime code; adding a RUNPATH corrupts
# the sidecar even when the dynamic loader can locate all libraries.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET=${LINEY_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}
case "$TARGET" in
  x86_64-*) ARCH=x86_64; SUFFIX=amd64 ;;
  aarch64-*|arm64-*) ARCH=aarch64; SUFFIX=aarch64 ;;
  *) echo "Unsupported Liney AppImage architecture: $TARGET" >&2; exit 1 ;;
esac
if [ -n "${1:-}" ]; then
  BUNDLE_DIR=$1
elif [ "$TARGET" = "$(rustc -vV | sed -n 's/^host: //p')" ]; then
  BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
else
  BUNDLE_DIR="$ROOT/src-tauri/target/$TARGET/release/bundle"
fi
APPDIR="$BUNDLE_DIR/appimage/Liney.AppDir"
ENGINE="$ROOT/src-tauri/binaries/liney-engine-$TARGET"
BUNDLED_ENGINE="$APPDIR/usr/bin/liney-engine"
if [ ! -f "$BUNDLED_ENGINE" ]; then
  echo "AppImage not staged; no Bun sidecar to repair."
  exit 0
fi
test -x "$ENGINE" || { echo "Missing original Bun sidecar: $ENGINE" >&2; exit 1; }
PLUGIN="${XDG_CACHE_HOME:-$HOME/.cache}/tauri/linuxdeploy-plugin-appimage.AppImage"
test -x "$PLUGIN" || { echo "Missing AppImage packager: $PLUGIN" >&2; exit 1; }
VERSION=$(node -p "require('$ROOT/package.json').version")
OUT="$BUNDLE_DIR/appimage/Liney_${VERSION}_${SUFFIX}.AppImage"
test -s "$OUT" || { echo "Missing AppImage to repair: $OUT" >&2; exit 1; }

# Replace patchelf's modified copy with the exact original. This must run
# AFTER Tauri/linuxdeploy finishes, because it modifies ELF executables.
cp "$ENGINE" "$BUNDLED_ENGINE"
chmod 755 "$BUNDLED_ENGINE"
cmp -s "$ENGINE" "$BUNDLED_ENGINE"

# WebKitGTK ships with the AppImage but loads GStreamer plugins at runtime.
# linuxdeploy sets GST_PLUGIN_SYSTEM_PATH_1_0 to AppDir/usr/lib/gstreamer-1.0;
# without these files media initialization can fail and abort WebKitWebProcess.
# Package the basic plugins from the same GStreamer installation as the
# libgstreamer shared library that linuxdeploy bundled during this build.
GST_SRC=$(pkg-config --variable=pluginsdir gstreamer-1.0 2>/dev/null || true)
GST_DST="$APPDIR/usr/lib/gstreamer-1.0"
test -n "$GST_SRC" && test -d "$GST_SRC" || {
  echo "Missing local GStreamer plugins directory; refusing broken AppImage" >&2
  exit 1
}
mkdir -p "$GST_DST"
for name in app autodetect coreelements playback audioconvert audioresample volume videoconvertscale videorate typefindfunctions audiofx opengl subenc; do
  plugin="$GST_SRC/libgst$name.so"
  if [ -f "$plugin" ]; then cp -L "$plugin" "$GST_DST/"; fi
done
for required in libgstapp.so libgstautodetect.so libgstcoreelements.so libgstplayback.so; do
  test -s "$GST_DST/$required" || {
    echo "Missing mandatory GStreamer plugin for Liney WebKit: $required" >&2
    exit 1
  }
done

# GStreamer normally starts its plugin scanner in a separate process.
# AppImage has a private library search path, so copy the helper from the
# matching host GStreamer version and tell it the exact bundled location.
if [ -x "$GST_SRC/gst-plugin-scanner" ]; then
  cp -L "$GST_SRC/gst-plugin-scanner" "$GST_DST/gst-plugin-scanner"
  chmod 755 "$GST_DST/gst-plugin-scanner"
fi
mkdir -p "$APPDIR/apprun-hooks"
cat > "$APPDIR/apprun-hooks/liney-gstreamer.sh" <<'HOOK'
#!/bin/sh
if [ -n "${APPDIR:-}" ] && [ -x "$APPDIR/usr/lib/gstreamer-1.0/gst-plugin-scanner" ]; then
  export GST_PLUGIN_SCANNER="$APPDIR/usr/lib/gstreamer-1.0/gst-plugin-scanner"
fi
HOOK
chmod 755 "$APPDIR/apprun-hooks/liney-gstreamer.sh"

NEW="$OUT.new.$$"
mkdir -p "$ROOT/build/tmp"
TMP=$(mktemp -d "$ROOT/build/tmp/liney-appimage-validation.XXXXXX")
cleanup() { rm -f "$NEW"; rm -rf "$TMP"; }
trap cleanup EXIT HUP INT TERM
ARCH="$ARCH" LINUXDEPLOY_OUTPUT_VERSION="$VERSION" LDAI_OUTPUT="$NEW" \
  "$PLUGIN" --appimage-extract-and-run --appdir="$APPDIR"
test -s "$NEW"
# Verify the actual delivered AppImage payload, not only the AppDir staging.
(cd "$TMP" && "$NEW" --appimage-extract usr/bin/liney-engine >/dev/null)
cmp -s "$ENGINE" "$TMP/squashfs-root/usr/bin/liney-engine" || {
  echo "Repack changed the Bun engine binary; refusing unsafe release" >&2
  exit 1
}
chmod 755 "$NEW"
mv -f "$NEW" "$OUT"
echo "Verified AppImage Bun engine matches original: $OUT"
