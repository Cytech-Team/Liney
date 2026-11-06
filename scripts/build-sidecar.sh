#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
exec bun build engine/main.ts --target=node --packages=external --outfile electron/dist/engine.mjs
