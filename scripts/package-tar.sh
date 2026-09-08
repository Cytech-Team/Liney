#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
OUTPUT_DIR=${LINEY_OUTPUT_DIR:-$ROOT/release}
ARCHIVE="$OUTPUT_DIR/Liney-${VERSION}-linux-x64.tar.gz"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/liney-tar.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT INT TERM

if command -v bun >/dev/null 2>&1; then BUN=$(command -v bun); else BUN=${HOME:-}/.bun/bin/bun; fi
test -x "$BUN" || { echo 'bun is required to build Liney' >&2; exit 1; }
PATH=$(dirname "$BUN"):$PATH
export PATH
"$BUN" run engine:build
cargo build --release --manifest-path "$ROOT/native-gtk/Cargo.toml"

APP_BINARY=${LINEY_APP_BINARY:-$ROOT/native-gtk/target/release/liney}
ENGINE_BINARY=${LINEY_ENGINE_BINARY:-}
if test -z "$ENGINE_BINARY"; then
  ENGINE_BINARY=$(find "$ROOT/build" -maxdepth 1 -type f -name 'liney-engine-*' -perm -0100 -print -quit)
fi
test -x "$APP_BINARY" || { echo "native Liney binary is missing: $APP_BINARY" >&2; exit 1; }
test -x "$ENGINE_BINARY" || { echo "engine sidecar is missing: $ENGINE_BINARY" >&2; exit 1; }

PACKAGE_DIR="$STAGE/Liney-${VERSION}-linux-x64"
mkdir -p "$PACKAGE_DIR"
install -m 0755 "$APP_BINARY" "$PACKAGE_DIR/liney"
install -m 0755 "$ENGINE_BINARY" "$PACKAGE_DIR/liney-engine"
install -m 0755 "$ROOT/packaging/run.sh" "$PACKAGE_DIR/run.sh"
install -m 0644 "$ROOT/packaging/liney.desktop" "$PACKAGE_DIR/liney.desktop"
install -m 0644 "$ROOT/packaging/liney.png" "$PACKAGE_DIR/liney.png"
install -m 0644 "$ROOT/packaging/liney.svg" "$PACKAGE_DIR/liney-mark.svg"
install -m 0644 "$ROOT/README.md" "$PACKAGE_DIR/README.md"
install -m 0644 "$ROOT/LICENSE" "$PACKAGE_DIR/LICENSE"
mkdir -p "$PACKAGE_DIR/branding"
install -m 0644 "$ROOT/branding/README.md" "$PACKAGE_DIR/branding/README.md"
install -m 0644 "$ROOT/branding/liney-logo.jpg" "$PACKAGE_DIR/branding/liney-logo.jpg"
mkdir -p "$OUTPUT_DIR"
rm -rf "$OUTPUT_DIR/Liney-${VERSION}-linux-x64"
mkdir -p "$OUTPUT_DIR/Liney-${VERSION}-linux-x64"
cp -a "$PACKAGE_DIR/." "$OUTPUT_DIR/Liney-${VERSION}-linux-x64/"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='UTC 1970-01-01' -czf "$ARCHIVE" -C "$STAGE" "Liney-${VERSION}-linux-x64"
printf '%s\n' "$ARCHIVE"
