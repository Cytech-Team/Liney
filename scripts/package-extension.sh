#!/usr/bin/env sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
EXT="$ROOT/extensions/liney-connector"
OUT_DIR="$ROOT/release"
OUT="$OUT_DIR/Liney-Connector-0.1.0.zip"
mkdir -p "$OUT_DIR"
rm -f "$OUT"
python - "$EXT" "$OUT" <<'PY'
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
