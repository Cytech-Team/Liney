#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
CONF="$HOME/.config/liney-web"
DATA="$HOME/.local/share/liney-web"
TOKEN_FILE="$CONF/runner.token"
if [[ "$#" -gt 0 ]]; then
 if [[ "$1" == "--show-token" ]]; then
  test -s "$TOKEN_FILE" || { echo "Start the local engine first" >&2; exit 1; }
  cat "$TOKEN_FILE"; exit 0
 fi
 if [[ "$1" == "--help" ]]; then
  echo "Run this on the user's device: bash scripts/start-local-web-engine.sh"; exit 0
 fi
 echo "Unsupported argument" >&2;exit 2
fi
umask 077
mkdir -p "$CONF" "$DATA"
chmod 700 "$CONF" "$DATA"
if [[ ! -s "$TOKEN_FILE" ]]; then
 python3 - "$TOKEN_FILE" <<'PY'
from pathlib import Path
import secrets,sys
p=Path(sys.argv[1])
p.write_text(secrets.token_urlsafe(48)+"\n")
p.chmod(0o600)
PY
fi
chmod 600 "$TOKEN_FILE"
case "$(uname -m)" in
 x86_64|amd64) DEFAULT_ENGINE="$ROOT/build/liney-engine-x86_64-unknown-linux-gnu";;
 aarch64|arm64) DEFAULT_ENGINE="$ROOT/build/liney-engine-aarch64-unknown-linux-gnu";;
 *) echo "Unsupported architecture" >&2;exit 1;;
esac
ENGINE="$DEFAULT_ENGINE"
if [[ -n "$(printenv LINEY_ENGINE_PATH || true)" ]]; then ENGINE="$(printenv LINEY_ENGINE_PATH)"; fi
if [[ ! -x "$ENGINE" ]]; then
 echo "Engine not found: $ENGINE; build first with bun run engine:build" >&2;exit 1
fi
echo "Local LINE engine: http://127.0.0.1:39211/liney-runner"
echo "Token stored on this device at $TOKEN_FILE"
echo "Show it with: bash scripts/start-local-web-engine.sh --show-token"
echo "Paste token in Liney Connector; stop with Ctrl+C."
export LINEY_RUNNER_HOST=127.0.0.1
export LINEY_RUNNER_PORT=39211
export LINEY_RUNNER_PREFIX=/liney-runner
export LINEY_PUBLIC_ENABLED=0\nexport LINEY_LOCAL_ONLY=1
export LINEY_RUNNER_TOKEN="$(<"$TOKEN_FILE")"
export LINEY_DATA_DIR="$DATA"
export LINEY_ENGINE_PATH="$ENGINE"
export LINEY_CLIENT_CHANNEL=Website
export LINEY_CLIENT_SUFFIX=Local-Web
exec node "$ROOT/runner/home-runner.js"
