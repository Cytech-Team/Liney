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

# HMR is intentionally opt-in. The canonical Tauri config has no localhost
# URL, so normal/static development and release builds cannot accidentally
# depend on a dev server. Only this explicit script opens port 1420.
exec "$BUN" x tauri dev \
  --config '{"build":{"beforeDevCommand":"bun run web:dev --host 127.0.0.1 --port 1420","devUrl":"http://127.0.0.1:1420"}}' \
  "$@"
