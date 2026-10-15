#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOME_DIR=${HOME:-/home/namkrub}
BUN=${BUN:-$HOME_DIR/.bun/bin/bun}
TARGET=${LINEY_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}
ENGINE_BUILD="$ROOT/build/liney-engine-$TARGET"
INSTALL_DIR="$HOME_DIR/.local/lib/liney"
STATE_DIR="$HOME_DIR/.local/state/liney"
LOCK_FILE="$STATE_DIR/linejs-auto-update.lock"
STATUS_FILE="$STATE_DIR/linejs-auto-update.status"

mkdir -p "$STATE_DIR" "$INSTALL_DIR/binaries"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "LINEJS auto-update is already running"
  exit 0
fi

test -x "$BUN" || { echo "bun not found: $BUN" >&2; exit 1; }
cd "$ROOT"

# The scheduled user timer is check-only by default. Updating installed code
# requires an explicit --apply and a clean source tree; a green unit suite is
# not enough to silently swap binaries for a logged-in LINE session.
MODE=${1:---check}
case "$MODE" in
  --check|--apply) ;;
  *) echo "Usage: $0 [--check|--apply]" >&2; exit 2 ;;
esac

current_version() {
  "$BUN" -e 'const p=require("./package.json"); const s=p.dependencies["@evex/linejs"]; const m=s.match(/@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/); if(!m) process.exit(2); console.log(m[1])'
}

BEFORE=$(current_version)
if [ "$MODE" = "--check" ]; then
  CHECK_OUTPUT=$(mktemp "$STATE_DIR/linejs-check.XXXXXX")
  trap 'rm -f "$CHECK_OUTPUT"' EXIT HUP INT TERM
  GITHUB_OUTPUT="$CHECK_OUTPUT" "$BUN" scripts/update-linejs-release.ts --check
  LATEST=$(sed -n 's/^latest=//p' "$CHECK_OUTPUT" | tail -1)
  AVAILABLE=$(sed -n 's/^update_available=//p' "$CHECK_OUTPUT" | tail -1)
  printf 'checked current=%s latest=%s available=%s at=%s\n' "$BEFORE" "$LATEST" "$AVAILABLE" "$(date -Is)" > "$STATUS_FILE"
  exit 0
fi

# Refuse to overwrite local feature development, including untracked files.
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "LINEJS apply refused: Git worktree contains uncommitted work. Use upstream update PR instead." >&2
  exit 2
fi
BACKUP=$(mktemp -d "$STATE_DIR/linejs-update.XXXXXX")
cp package.json bun.lock engine/linejs/adapter.ts "$BACKUP/"
UPDATED=0

rollback() {
  code=$?
  if [ "$UPDATED" = 1 ] && [ "$code" -ne 0 ]; then
    echo "LINEJS update failed; restoring $BEFORE" >&2
    cp "$BACKUP/package.json" package.json
    cp "$BACKUP/bun.lock" bun.lock
    cp "$BACKUP/adapter.ts" engine/linejs/adapter.ts
    "$BUN" install --frozen-lockfile >/dev/null 2>&1 || true
    printf 'failed version=%s at=%s\n' "$BEFORE" "$(date -Is)" > "$STATUS_FILE"
  fi
  rm -rf "$BACKUP"
  exit "$code"
}
trap rollback EXIT HUP INT TERM

"$BUN" scripts/update-linejs-release.ts
AFTER=$(current_version)
if [ "$AFTER" = "$BEFORE" ]; then
  printf 'current version=%s checked=%s\n' "$BEFORE" "$(date -Is)" > "$STATUS_FILE"
  echo "LINEJS already current: $BEFORE"
  exit 0
fi
UPDATED=1

echo "Verifying LINEJS $BEFORE -> $AFTER"
"$BUN" test
"$BUN" run lint
"$BUN" run web:build
"$BUN" run engine:build

test -x "$ENGINE_BUILD"
TMP_ENGINE="$INSTALL_DIR/binaries/.liney-engine.new.$$"
install -m755 "$ENGINE_BUILD" "$TMP_ENGINE"
mv -f "$TMP_ENGINE" "$INSTALL_DIR/binaries/liney-engine"

# Keep the legacy sidecar location synchronized for older launchers/tools.
TMP_LEGACY="$INSTALL_DIR/.liney-engine.new.$$"
install -m755 "$ENGINE_BUILD" "$TMP_LEGACY"
mv -f "$TMP_LEGACY" "$INSTALL_DIR/liney-engine"

printf 'updated from=%s to=%s at=%s\n' "$BEFORE" "$AFTER" "$(date -Is)" > "$STATUS_FILE"
echo "LINEJS auto-update installed: $BEFORE -> $AFTER"
UPDATED=0
