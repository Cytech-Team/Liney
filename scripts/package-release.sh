#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
npm test
npm run lint
npm run electron:build:appimage
npm run build:deb
mkdir -p release
for artifact in release-electron/*.AppImage release-electron/*.deb; do
  [ -s "$artifact" ] || continue
  cp "$artifact" release/
done
(cd release && sha256sum ./*.AppImage ./*.deb > SHA256SUMS)
