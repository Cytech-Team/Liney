#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$ROOT/scripts/check-linux-deps.sh"
USER_HOME=${HOME:-/home/namkrub}

if command -v bun >/dev/null 2>&1; then
  BUN=$(command -v bun)
else
  BUN="$USER_HOME/.bun/bin/bun"
fi
test -x "$BUN" || { echo 'bun is required to run Liney' >&2; exit 1; }

PATH=$(dirname "$BUN"):$PATH
export PATH

TARGET=${LINEY_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}
SIDECAR="$ROOT/src-tauri/binaries/liney-engine-$TARGET"
if [ ! -x "$SIDECAR" ]; then
  LINEY_TARGET_TRIPLE="$TARGET" "$ROOT/scripts/build-sidecar.sh"
fi

# Build the local frontend once, then let Tauri load frontendDist through its
# application protocol. No Vite server, localhost listener, or occupied port
# is needed in this mode; use `bun run dev:web` when HMR is wanted.
"$BUN" run web:build
exec "$BUN" x tauri dev --no-dev-server "$@"
