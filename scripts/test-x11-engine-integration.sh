#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
bun test
bun run lint
bun run web:build
bun run engine:build
sh scripts/test-engine-screen-targets.sh
echo "X11_ENGINE_INTEGRATION_OK"
