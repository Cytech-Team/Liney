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
