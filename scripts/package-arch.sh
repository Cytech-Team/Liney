#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
resolve_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return; fi
  if test -x "${HOME:-}/.bun/bin/bun"; then printf '%s\n' "${HOME}/.bun/bin/bun"; return; fi
  return 1
}

APP_BINARY=${LINEY_APP_BINARY:-}
ENGINE_BINARY=${LINEY_ENGINE_BINARY:-}
if test -z "$APP_BINARY" || test -z "$ENGINE_BINARY"; then
  BUN=$(resolve_bun) || { echo 'bun is required to build Liney' >&2; exit 1; }
  PATH=$(dirname "$BUN"):$PATH
  export PATH
  "$BUN" run engine:build
  cargo build --release --manifest-path "$ROOT/app/Cargo.toml"
  APP_BINARY=${APP_BINARY:-$ROOT/app/target/release/liney}
  if test -z "$ENGINE_BINARY"; then
    ENGINE_BINARY=$(find "$ROOT/build" -maxdepth 1 -type f -name 'liney-engine-*' -perm -0100 -print -quit)
  fi
fi

test -x "$APP_BINARY" || { printf '%s\n' "missing native GTK4 binary: $APP_BINARY" >&2; exit 1; }
test -x "$ENGINE_BINARY" || { printf '%s\n' "missing engine binary: $ENGINE_BINARY" >&2; exit 1; }

BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT INT TERM
cp "$ROOT/packaging/arch/PKGBUILD" "$BUILD_DIR/PKGBUILD"
cp "$APP_BINARY" "$BUILD_DIR/liney-bin"
cp "$ENGINE_BINARY" "$BUILD_DIR/liney-engine"
cat > "$BUILD_DIR/liney-launcher" <<'LAUNCHER'
#!/bin/sh
exec /usr/lib/liney/liney-bin "$@"
LAUNCHER
chmod 0755 "$BUILD_DIR/liney-launcher"
cp "$ROOT/packaging/liney.desktop" "$BUILD_DIR/liney.desktop"
cp "$ROOT/packaging/liney.png" "$BUILD_DIR/liney.png"
cp "$ROOT/README.md" "$BUILD_DIR/README.md"
cp "$ROOT/LICENSE" "$BUILD_DIR/LICENSE"
cp "$ROOT/branding/liney-logo.jpg" "$BUILD_DIR/liney-logo.jpg"
cp "$ROOT/branding/README.md" "$BUILD_DIR/branding-README.md"

(cd "$BUILD_DIR" && makepkg --force --clean --noconfirm)
mkdir -p "$ROOT/dist/arch"
cp "$BUILD_DIR"/liney-*.pkg.tar.zst "$ROOT/dist/arch/"
printf '%s\n' "Arch package written to $ROOT/dist/arch"
