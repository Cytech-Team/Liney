#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { printf '%s\n' "release verification failed: $*" >&2; exit 1; }

if command -v bun >/dev/null 2>&1; then BUN=$(command -v bun); else BUN=${HOME:-}/.bun/bin/bun; fi
test -x "$BUN" || fail 'bun is required'
PATH=$(dirname "$BUN"):$PATH
export PATH

grep -q '"version": "0.1.0"' "$ROOT/package.json" || fail 'package.json version is not 0.1.0'
grep -q 'name = "liney"' "$ROOT/app/Cargo.toml" || fail 'native Cargo package is not named liney'
grep -q 'version = "0.1.0"' "$ROOT/app/Cargo.toml" || fail 'native Cargo version is not 0.1.0'
grep -q 'dev.liney.desktop' "$ROOT/app/src/main.rs" || fail 'native application id is wrong'
test -f "$ROOT/packaging/liney.desktop" || fail 'desktop entry is missing'
test -f "$ROOT/packaging/liney.png" || fail 'PNG icon is missing'
test -f "$ROOT/README.md" || fail 'README is missing'
test -f "$ROOT/LICENSE" || fail 'license is missing'

if grep -Eiq 'libwebkit|webkit2gtk|tauri build|src-tauri/target/release/liney|src-tauri/binaries/liney-engine' \
  "$ROOT/scripts/package-arch.sh" "$ROOT/scripts/package-tar.sh" \
  "$ROOT/packaging/arch/PKGBUILD" "$ROOT/.github/workflows/release.yml"; then
  fail 'native release path still references WebKit/Tauri app packaging'
fi

python3 - "$ROOT/package.json" <<'PY'
import json, sys
scripts = json.load(open(sys.argv[1]))['scripts']
for key in ('dev', 'build', 'desktop:dev', 'desktop:build'):
    value = scripts.get(key, '')
    if 'tauri' in value.lower() or 'vite' in value.lower():
        raise SystemExit(f'{key} still routes to a WebView/web dev path: {value}')
if 'app' not in scripts.get('desktop:dev', '') or 'app' not in scripts.get('desktop:build', ''):
    raise SystemExit('desktop commands do not route to native GTK4')
PY

"$BUN" run test:unit
cargo check --manifest-path "$ROOT/app/Cargo.toml"
"$BUN" run engine:build
cargo build --release --manifest-path "$ROOT/app/Cargo.toml"

APP="$ROOT/app/target/release/liney"
test -x "$APP" || fail 'native release binary is missing'
DEPS=$(ldd "$APP" 2>/dev/null || true)
printf '%s\n' "$DEPS" | grep -q 'libgtk-4' || fail 'native binary is not linked to GTK4'
if printf '%s\n' "$DEPS" | grep -Eiq 'webkit|javascriptcoregtk'; then
  fail 'native binary links WebKit/JavaScriptCore'
fi

sidecar=$(find "$ROOT/build" -maxdepth 1 -type f -name 'liney-engine-*' -perm -0100 -print -quit)
test -n "$sidecar" || fail 'compiled engine sidecar is missing or not executable'

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$ROOT/packaging/liney.desktop"
fi

for artifact in "$@"; do
  test -f "$artifact" || fail "artifact does not exist: $artifact"
  case "$artifact" in
    *.pkg.tar.zst) members=$(tar --use-compress-program=unzstd -tf "$artifact") ;;
    *.tar.gz|*.tgz) members=$(tar -tzf "$artifact") ;;
    *) fail "unsupported native release artifact: $artifact" ;;
  esac
  if printf '%s\n' "$members" | grep -Eiq '(^|[/[:space:]])(auth\.json|linejs-session\.json)([/[:space:]]|$)'; then
    fail "credential/session file is present in $artifact"
  fi
  printf '%s\n' "$members" | grep -Eq '(^|/)README\.md$' || fail "README is missing from $artifact"
  printf '%s\n' "$members" | grep -Eq '(^|/)LICENSE$' || fail "LICENSE is missing from $artifact"
  actual_hash=$(sha256sum "$artifact")
  if test -n "${LINEY_HASH_FILE:-}"; then
    test -s "$LINEY_HASH_FILE" || fail "hash file is empty: $LINEY_HASH_FILE"
    grep -Fqx "$actual_hash" "$LINEY_HASH_FILE" || fail "hash mismatch for $artifact"
  fi
  printf '%s\n' "$actual_hash"
done

if test -n "${LINEY_SBOM_PATH:-}"; then
  test -s "$LINEY_SBOM_PATH" || fail "SBOM is empty: $LINEY_SBOM_PATH"
  grep -q 'SPDX' "$LINEY_SBOM_PATH" || fail "SBOM is not SPDX JSON: $LINEY_SBOM_PATH"
fi

printf '%s\n' 'release verification passed: native GTK4, no WebView runtime'
