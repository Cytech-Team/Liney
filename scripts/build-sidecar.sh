#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -n "${LINEY_TARGET_TRIPLE:-}" ]; then
  TARGET=$LINEY_TARGET_TRIPLE
else
  TARGET=$(rustc -vV | sed -n 's/^host: //p')
fi
OUT="$ROOT/build/liney-engine-$TARGET"
TAURI_OUT="$ROOT/src-tauri/binaries/liney-engine-$TARGET"
mkdir -p "$(dirname "$OUT")"
mkdir -p "$(dirname "$TAURI_OUT")"
# Tauri's build.rs checks *all* externalBin paths during the first Cargo
# invocation. On a clean CI checkout the first `cargo build --bin liney-media`
# otherwise fails before the later audio/screen helpers are built. Bootstrap
# every declared external binary up front and replace each placeholder with
# its real compiled executable before packaging.
for binary in liney-engine liney-media liney-audio liney-screen liney-screen-wayland liney-screen-x11; do
  destination="$ROOT/src-tauri/binaries/$binary-$TARGET"
  if [ ! -e "$destination" ]; then
    : > "$destination"
    chmod +x "$destination"
  fi
done

USER_HOME=${HOME:-/home/namkrub}
if command -v bun >/dev/null 2>&1; then BUN=$(command -v bun); else BUN="$USER_HOME/.bun/bin/bun"; fi
test -x "$BUN" || { echo 'bun is required to build liney-engine' >&2; exit 1; }
PATH=$(dirname "$BUN"):$PATH
export PATH
case "$TARGET" in
  x86_64-*) BUN_TARGET=bun-linux-x64 ;;
  aarch64-*|arm64-*) BUN_TARGET=bun-linux-arm64 ;;
  *)
    echo "unsupported Liney sidecar target: $TARGET" >&2
    exit 1
    ;;
esac
"$BUN" build "$ROOT/engine/main.ts" --compile --target="$BUN_TARGET" --outfile "$OUT"
chmod +x "$OUT"
cp "$OUT" "$TAURI_OUT"
chmod +x "$TAURI_OUT"
printf 'Built %s\n' "$OUT"
printf 'Staged Tauri sidecar %s\n' "$TAURI_OUT"


MEDIA_OUT="$ROOT/build/liney-media-$TARGET"
MEDIA_TAURI_OUT="$ROOT/src-tauri/binaries/liney-media-$TARGET"
# tauri-build validates externalBin paths before Cargo compiles this binary.
# Bootstrap a private executable placeholder on clean checkouts; it is replaced
# immediately by the real media sidecar below.
if [ ! -e "$MEDIA_TAURI_OUT" ]; then
  : > "$MEDIA_TAURI_OUT"
  chmod +x "$MEDIA_TAURI_OUT"
fi
HOST_TARGET=$(rustc -vV | sed -n 's/^host: //p')
if [ "$TARGET" = "$HOST_TARGET" ]; then
  cargo build --release --manifest-path "$ROOT/src-tauri/Cargo.toml" --bin liney-media --features media-sidecar
  MEDIA_BUILT="$ROOT/src-tauri/target/release/liney-media"
else
  cargo build --release --manifest-path "$ROOT/src-tauri/Cargo.toml" --bin liney-media --features media-sidecar --target "$TARGET"
  MEDIA_BUILT="$ROOT/src-tauri/target/$TARGET/release/liney-media"
fi
test -x "$MEDIA_BUILT"
cp "$MEDIA_BUILT" "$MEDIA_OUT"
cp "$MEDIA_BUILT" "$MEDIA_TAURI_OUT"
chmod +x "$MEDIA_OUT" "$MEDIA_TAURI_OUT"
printf 'Built %s\n' "$MEDIA_OUT"
printf 'Staged Tauri media sidecar %s\n' "$MEDIA_TAURI_OUT"


AUDIO_OUT="$ROOT/build/liney-audio-$TARGET"
AUDIO_TAURI_OUT="$ROOT/src-tauri/binaries/liney-audio-$TARGET"
if [ ! -e "$AUDIO_TAURI_OUT" ]; then
  : > "$AUDIO_TAURI_OUT"
  chmod +x "$AUDIO_TAURI_OUT"
fi
if [ "$TARGET" = "$HOST_TARGET" ]; then
  cargo build --release --manifest-path "$ROOT/src-tauri/Cargo.toml" --bin liney-audio --features audio-sidecar
  AUDIO_BUILT="$ROOT/src-tauri/target/release/liney-audio"
else
  cargo build --release --manifest-path "$ROOT/src-tauri/Cargo.toml" --bin liney-audio --features audio-sidecar --target "$TARGET"
  AUDIO_BUILT="$ROOT/src-tauri/target/$TARGET/release/liney-audio"
fi
test -x "$AUDIO_BUILT"
cp "$AUDIO_BUILT" "$AUDIO_OUT"
cp "$AUDIO_BUILT" "$AUDIO_TAURI_OUT"
chmod +x "$AUDIO_OUT" "$AUDIO_TAURI_OUT"
printf 'Built %s\n' "$AUDIO_OUT"
printf 'Staged Tauri audio sidecar %s\n' "$AUDIO_TAURI_OUT"


SCREEN_OUT="$ROOT/build/liney-screen-$TARGET"
SCREEN_TAURI_OUT="$ROOT/src-tauri/binaries/liney-screen-$TARGET"
if [ ! -e "$SCREEN_TAURI_OUT" ]; then
  : > "$SCREEN_TAURI_OUT"
  chmod +x "$SCREEN_TAURI_OUT"
fi
if [ "$TARGET" = "$HOST_TARGET" ]; then
  cargo build --release --manifest-path "$ROOT/src-tauri/Cargo.toml" --bin liney-screen --features screen-sidecar
  SCREEN_BUILT="$ROOT/src-tauri/target/release/liney-screen"
else
  cargo build --release --manifest-path "$ROOT/src-tauri/Cargo.toml" --bin liney-screen --features screen-sidecar --target "$TARGET"
  SCREEN_BUILT="$ROOT/src-tauri/target/$TARGET/release/liney-screen"
fi
test -x "$SCREEN_BUILT"
cp "$SCREEN_BUILT" "$SCREEN_OUT"
cp "$SCREEN_BUILT" "$SCREEN_TAURI_OUT"
chmod +x "$SCREEN_OUT" "$SCREEN_TAURI_OUT"
printf 'Built %s\n' "$SCREEN_OUT"
printf 'Staged Tauri screen sidecar %s\n' "$SCREEN_TAURI_OUT"


WAYLAND_SCREEN_OUT="$ROOT/build/liney-screen-wayland-$TARGET"
WAYLAND_SCREEN_TAURI_OUT="$ROOT/src-tauri/binaries/liney-screen-wayland-$TARGET"
X11_SCREEN_OUT="$ROOT/build/liney-screen-x11-$TARGET"
X11_SCREEN_TAURI_OUT="$ROOT/src-tauri/binaries/liney-screen-x11-$TARGET"

for placeholder in "$WAYLAND_SCREEN_TAURI_OUT" "$X11_SCREEN_TAURI_OUT"; do
  if [ ! -e "$placeholder" ]; then
    : > "$placeholder"
    chmod +x "$placeholder"
  fi
done

if [ "$TARGET" = "$HOST_TARGET" ]; then
  cargo build --release --manifest-path "$ROOT/native/liney-screen-wayland/Cargo.toml"
  WAYLAND_SCREEN_BUILT="$ROOT/native/liney-screen-wayland/target/release/liney-screen-wayland"
  cargo build --release --manifest-path "$ROOT/native/liney-screen-x11/Cargo.toml"
  X11_SCREEN_BUILT="$ROOT/native/liney-screen-x11/target/release/liney-screen-x11"
else
  cargo build --release --manifest-path "$ROOT/native/liney-screen-wayland/Cargo.toml" --target "$TARGET"
  WAYLAND_SCREEN_BUILT="$ROOT/native/liney-screen-wayland/target/$TARGET/release/liney-screen-wayland"
  cargo build --release --manifest-path "$ROOT/native/liney-screen-x11/Cargo.toml" --target "$TARGET"
  X11_SCREEN_BUILT="$ROOT/native/liney-screen-x11/target/$TARGET/release/liney-screen-x11"
fi

test -x "$WAYLAND_SCREEN_BUILT"
test -x "$X11_SCREEN_BUILT"
cp "$WAYLAND_SCREEN_BUILT" "$WAYLAND_SCREEN_OUT"
cp "$WAYLAND_SCREEN_BUILT" "$WAYLAND_SCREEN_TAURI_OUT"
cp "$X11_SCREEN_BUILT" "$X11_SCREEN_OUT"
cp "$X11_SCREEN_BUILT" "$X11_SCREEN_TAURI_OUT"
chmod +x "$WAYLAND_SCREEN_OUT" "$WAYLAND_SCREEN_TAURI_OUT" "$X11_SCREEN_OUT" "$X11_SCREEN_TAURI_OUT"
printf 'Built %s\n' "$WAYLAND_SCREEN_OUT"
printf 'Built %s\n' "$X11_SCREEN_OUT"
printf 'Staged Tauri Wayland screen sidecar %s\n' "$WAYLAND_SCREEN_TAURI_OUT"
printf 'Staged Tauri X11 screen sidecar %s\n' "$X11_SCREEN_TAURI_OUT"
