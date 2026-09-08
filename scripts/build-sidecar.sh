#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET=$(rustc -vV | sed -n 's/^host: //p')
OUT="$ROOT/build/liney-engine-$TARGET"
mkdir -p "$(dirname "$OUT")"
USER_HOME=${HOME:-/home/namkrub}
if command -v bun >/dev/null 2>&1; then BUN=$(command -v bun); else BUN="$USER_HOME/.bun/bin/bun"; fi
test -x "$BUN" || { echo 'bun is required to build liney-engine' >&2; exit 1; }
PATH=$(dirname "$BUN"):$PATH
export PATH
"$BUN" build "$ROOT/engine/main.ts" --compile --outfile "$OUT"
chmod +x "$OUT"
printf 'Built %s\n' "$OUT"
