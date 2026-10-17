#!/usr/bin/env bash
# Publish source + prebuilt Liney PKGBUILDs only when an AUR SSH account is configured.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(bun -e 'console.log(require(process.argv[1]).version)' "$ROOT/package.json")
TAG="v${VERSION}"
URL="https://github.com/Cytech-Team/Liney"
AUR_BASE="ssh://aur@aur.archlinux.org"
for command in curl git ssh sha256sum makepkg; do command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 1; }; done
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
checksum() {
  local file=$1 url=$2
  curl --fail --location --retry 3 --silent --show-error "$url" -o "$TMP/$file"
  sha256sum "$TMP/$file" | cut -d' ' -f1
}
SOURCE_SHA=$(checksum "Liney-${VERSION}.tar.gz" "$URL/archive/refs/tags/$TAG.tar.gz")
BIN_X86_SHA=$(checksum "Liney-${VERSION}-linux-x86_64.tar.gz" "$URL/releases/download/$TAG/Liney-${VERSION}-linux-x86_64.tar.gz")
BIN_ARM_SHA=$(checksum "Liney-${VERSION}-linux-aarch64.tar.gz" "$URL/releases/download/$TAG/Liney-${VERSION}-linux-aarch64.tar.gz")

mkdir -p "$TMP/liney" "$TMP/liney-bin"
cp "$ROOT/packaging/arch/PKGBUILD" "$TMP/liney/PKGBUILD"
cp "$ROOT/packaging/arch/liney-bin/PKGBUILD" "$TMP/liney-bin/PKGBUILD"
python3 - "$TMP" "$SOURCE_SHA" "$BIN_X86_SHA" "$BIN_ARM_SHA" <<'PY'
import sys
from pathlib import Path
root, src_sha, x86_sha, arm_sha = sys.argv[1:]
p=Path(root)/'liney'/'PKGBUILD'
s=p.read_text().replace("sha256sums=('SKIP')",f"sha256sums=('{src_sha}')")
p.write_text(s)
p=Path(root)/'liney-bin'/'PKGBUILD'
s=p.read_text().replace("sha256sums_x86_64=('SKIP')",f"sha256sums_x86_64=('{x86_sha}')").replace("sha256sums_aarch64=('SKIP')",f"sha256sums_aarch64=('{arm_sha}')")
p.write_text(s)
PY
for pkg in liney liney-bin; do
  (cd "$TMP/$pkg" && makepkg --printsrcinfo > .SRCINFO)
done
printf 'Validated Release v%s, AUR metadata and source/portable SHA256 checksums.\n' "$VERSION"
if ! timeout 15 ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -T aur@aur.archlinux.org help >/dev/null 2>"$TMP/ssh-error"; then
  echo 'AUR account/SSH host authentication unavailable. No package was published.' >&2
  sed -n '1,5p' "$TMP/ssh-error" >&2
  echo 'Register an SSH public key in your AUR account, verify the SSH host key, then rerun this script.' >&2
  exit 2
fi
for pkg in liney liney-bin; do
  git clone "$AUR_BASE/$pkg.git" "$TMP/aur-$pkg"
  cp "$TMP/$pkg/PKGBUILD" "$TMP/$pkg/.SRCINFO" "$TMP/aur-$pkg/"
  (
    cd "$TMP/aur-$pkg"
    git add PKGBUILD .SRCINFO
    if ! git diff --cached --quiet; then
      git -c user.name='Cytech Team Development' -c user.email='builder@liney.local' commit -m "Update $pkg to $VERSION"
      git push origin HEAD:master
    fi
  )
done
printf 'Published AUR liney and liney-bin for version %s\n' "$VERSION"
