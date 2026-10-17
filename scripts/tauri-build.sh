#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$ROOT/scripts/check-linux-deps.sh"
USER_HOME=${HOME:-/home/namkrub}

# Do not let AppImage/linuxdeploy exhaust a small tmpfs (/tmp is commonly
# memory-backed). Keep release extraction/work files on the project filesystem
# unless the caller explicitly provides LINEY_TMPDIR.
TMPDIR=${LINEY_TMPDIR:-$ROOT/build/tmp}
mkdir -p "$TMPDIR"
export TMPDIR

if command -v bun >/dev/null 2>&1; then
  BUN=$(command -v bun)
else
  BUN="$USER_HOME/.bun/bin/bun"
fi
test -x "$BUN" || { echo 'bun is required to build Liney' >&2; exit 1; }

# Tauri runs beforeBuildCommand through /bin/sh. Keep the same Bun discovery
# available to that child process even when the user launched this script from
# a desktop terminal whose PATH does not contain ~/.bun/bin.
PATH=$(dirname "$BUN"):$PATH
export PATH

# Tauri currently consumes linuxdeploy-plugin-gtk from its cache. On rolling
# distributions the upstream plugin can hit an existing module symlink and
# abort because it uses "ln -s" without overwrite semantics. Pre-cache the
# official MIT-licensed plugin and apply the narrow upstream-compatible -f
# workaround before Tauri invokes linuxdeploy.
if [ "$(uname -s)" = "Linux" ]; then
  TAURI_CACHE="${XDG_CACHE_HOME:-$USER_HOME/.cache}/tauri"
  GTK_PLUGIN="$TAURI_CACHE/linuxdeploy-plugin-gtk.sh"
  mkdir -p "$TAURI_CACHE"
  if [ ! -f "$GTK_PLUGIN" ]; then
    curl -fsSL \
      https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh \
      -o "$GTK_PLUGIN"
  fi
  if grep -q 'ln \$verbose -s ' "$GTK_PLUGIN"; then
    sed -i 's/ln \$verbose -s /ln \$verbose -sf /g' "$GTK_PLUGIN"
  fi
  chmod +x "$GTK_PLUGIN"
fi

TARGET=${LINEY_TARGET_TRIPLE:-${TAURI_ENV_TARGET_TRIPLE:-}}
TARGET_VALUE=0
for ARG in "$@"; do
  if [ "$TARGET_VALUE" = 1 ]; then
    TARGET=$ARG
    TARGET_VALUE=0
    continue
  fi
  case "$ARG" in
    --target=*) TARGET=${ARG#--target=} ;;
    --target) TARGET_VALUE=1 ;;
  esac
done
if [ -z "$TARGET" ]; then
  TARGET=$(rustc -vV | sed -n 's/^host: //p')
fi

# Tauri/linuxdeploy can reuse a stale AppDir. The GTK plugin creates several
# symlinks without overwrite semantics, so a previous AppDir can make a clean
# package build fail even though the source is valid. Always remove bundle
# staging before packaging; compiled Cargo artifacts remain cached.
HOST_TARGET=$(rustc -vV | sed -n 's/^host: //p')
if [ "$TARGET" = "$HOST_TARGET" ]; then
  BUNDLE_DIR="$ROOT/src-tauri/target/release/bundle"
else
  BUNDLE_DIR="$ROOT/src-tauri/target/$TARGET/release/bundle"
fi
rm -rf "$BUNDLE_DIR"

# externalBin is resolved before Tauri bundles the app, so a clean checkout
# must build and stage the target-triple sidecar as part of the normal build.
LINEY_TARGET_TRIPLE="$TARGET" "$ROOT/scripts/build-sidecar.sh"

# linuxdeploy's bundled strip is older than the RELR ELF sections emitted by
# current Linux distributions. NO_STRIP is the portable default; users may
# explicitly opt back in with NO_STRIP=false when using a compatible toolchain.
: "${NO_STRIP:=true}"
export NO_STRIP

# Some rolling distributions ship GdkPixbuf's loaders through glycin and do
# not provide the legacy directory expected by linuxdeploy-plugin-gtk. Shadow
# pkgconf only for that missing optional directory; on normal Debian/Ubuntu
# systems the real values pass through unchanged. This keeps AppImage builds
# usable without requiring root-owned compatibility symlinks under /usr.
TOOLS="$ROOT/build/tauri-tools"
GDK_FALLBACK="$TOOLS/gdk-pixbuf-loaders"
mkdir -p "$GDK_FALLBACK"
SYSTEM_PKGCONF=$(command -v pkgconf 2>/dev/null || command -v pkg-config 2>/dev/null || true)
if [ -n "$SYSTEM_PKGCONF" ]; then
  cat > "$TOOLS/pkgconf" <<EOF
#!/bin/sh
set -eu
system_pkgconf="$SYSTEM_PKGCONF"
fallback="$GDK_FALLBACK"
if [ "\${1:-}" = "--variable=gdk_pixbuf_binarydir" ] || [ "\${1:-}" = "--variable=gdk_pixbuf_moduledir" ]; then
   real="\$(command "\$system_pkgconf" --variable=\${1#--variable=} gdk-pixbuf-2.0 2>/dev/null || true)"
  if [ -n "\$real" ] && [ -d "\$real" ]; then
    printf '%s\\n' "\$real"
  else
    printf '%s\\n' "\$fallback"
  fi
  exit 0
fi
if [ "\${1:-}" = "--variable=gdk_pixbuf_cache_file" ]; then
   real="\$(command "\$system_pkgconf" --variable=gdk_pixbuf_cache_file gdk-pixbuf-2.0 2>/dev/null || true)"
  if [ -n "\$real" ] && [ -d "\$(dirname "\$real")" ]; then
    printf '%s\\n' "\$real"
  else
    printf '%s\\n' "\$fallback/loaders.cache"
  fi
  exit 0
fi
exec "\$system_pkgconf" "\$@"
EOF
  chmod +x "$TOOLS/pkgconf"
  PATH="$TOOLS:$PATH"
  export PATH
fi

# Normal Tauri packaging first. If linuxdeploy fails after creating a complete
# AppDir on some rolling Linux systems, package that staged tree directly.
# Never apply the fallback to deb/rpm or to an incomplete build.
if "$BUN" x tauri build "$@"; then
  "$ROOT/scripts/repair-appimage-engine.sh" "$BUNDLE_DIR"
  exit 0
fi
case " $* " in
  *" appimage "*) ;;
  *) exit 1 ;;
esac
APPDIR="$BUNDLE_DIR/appimage/Liney.AppDir"
PLUGIN="${XDG_CACHE_HOME:-$USER_HOME/.cache}/tauri/linuxdeploy-plugin-appimage.AppImage"
test -x "$APPDIR/usr/bin/liney" || exit 1
test -x "$APPDIR/usr/bin/liney-engine" || exit 1
test -x "$APPDIR/usr/bin/liney-media" || exit 1
test -f "$APPDIR/usr/share/applications/Liney.desktop" || exit 1
test -x "$PLUGIN" || exit 1
# Desktop entry names the icon 'liney'; Tauri stages it as 'Liney.png'.
if [ ! -e "$APPDIR/liney.png" ] && [ -f "$APPDIR/Liney.png" ]; then
  ln -s Liney.png "$APPDIR/liney.png"
fi
ARCH=$(uname -m)
VERSION=$(node -p "require('$ROOT/package.json').version")
case "$ARCH" in x86_64) SUFFIX=amd64 ;; aarch64) SUFFIX=aarch64 ;; *) exit 1 ;; esac
OUT="$BUNDLE_DIR/appimage/Liney_${VERSION}_${SUFFIX}.AppImage"
ARCH="$ARCH" LINUXDEPLOY_OUTPUT_VERSION="$VERSION" LDAI_OUTPUT="$OUT" \
  "$PLUGIN" --appimage-extract-and-run --appdir="$APPDIR"
test -s "$OUT"
"$ROOT/scripts/repair-appimage-engine.sh" "$BUNDLE_DIR"
printf 'AppImage fallback packaging OK: %s\n' "$OUT"
