#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
VERSION=$(node -p 'require("./package.json").version')
DEB="release-electron/Liney-Electron-Preview-${VERSION}-amd64.deb"
FLATPAK_DIR="packaging/flatpak"
MANIFEST="$FLATPAK_DIR/com.cyoriasmp.liney.yml"
REPO="release-electron/flatpak-repo"
BUILD_DIR=".flatpak-builder"
OUTPUT="release-electron/Liney-Electron-Preview-${VERSION}-x86_64.flatpak"
SOURCE="$FLATPAK_DIR/Liney-Electron-Preview.deb"
if [ ! -s "$DEB" ]; then
  echo "Missing Electron DEB: $DEB" >&2
  echo "Run npm run build:deb first." >&2
  exit 1
fi
for tool in flatpak flatpak-builder; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool" >&2; exit 1; }
done
cleanup() { rm -f "$SOURCE"; }
trap cleanup EXIT HUP INT TERM
cp "$DEB" "$SOURCE"
flatpak-builder --force-clean --repo="$REPO" "$BUILD_DIR" "$MANIFEST"
flatpak build-bundle "$REPO" "$OUTPUT" com.cyoriasmp.liney preview
echo "Built $OUTPUT"
