#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
EXT="$ROOT/extensions/liney-connector"
OUT_DIR="$ROOT/release"
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$EXT/manifest.json")
OUT="$OUT_DIR/Liney-Connector-$VERSION.zip"
mkdir -p "$OUT_DIR"
rm -f "$OUT"
python3 - "$EXT" "$OUT" <<'PY'
import sys
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
ext = Path(sys.argv[1])
out = Path(sys.argv[2])
files = [
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "README.md",
    "icons/liney-logo.png",
]
with ZipFile(out, "w", ZIP_DEFLATED) as zf:
    for name in files:
        zf.write(ext / name, name)
print(out)
PY
