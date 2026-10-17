#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BUNDLE=${1:?usage: test-atomic-deploy.sh PORTABLE_BUNDLE_DIR}
INSTALLER="$BUNDLE/install-user.sh"
[ -x "$INSTALLER" ] || [ -f "$INSTALLER" ] || { echo "portable installer missing: $INSTALLER" >&2; exit 1; }

TMP_PARENT=${LINEY_TMPDIR:-"$ROOT/build/tmp"}
mkdir -p "$TMP_PARENT"
TMP=$(mktemp -d "$TMP_PARENT/liney-atomic-deploy.XXXXXX")
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT HUP INT TERM

TEST_HOME="$TMP/home"
APP_ROOT="$TEST_HOME/.local/lib/liney"
mkdir -p "$TEST_HOME"

install_bundle() {
  bundle=$1
  release_id=$2
  HOME="$TEST_HOME" \
    LINEY_INSTALL_BASE="$APP_ROOT" \
    LINEY_RELEASE_ID="$release_id" \
    sh "$bundle/install-user.sh"
}

verify_generation() {
  generation=$1
  for name in liney liney-engine liney-media liney-audio liney-screen liney-screen-wayland liney-screen-x11; do
    [ -x "$generation/$name" ] || { echo "generation is missing executable: $name" >&2; return 1; }
    cmp -s "$BUNDLE/$name" "$generation/$name" || { echo "generation differs from input: $name" >&2; return 1; }
  done
}

install_bundle "$BUNDLE" fixture-old
[ "$(readlink "$APP_ROOT/current")" = "releases/fixture-old" ]
verify_generation "$APP_ROOT/releases/fixture-old"

# A malformed candidate must fail before replacing the live release pointer.
BROKEN="$TMP/broken"
cp -a "$BUNDLE" "$BROKEN"
rm -f "$BROKEN/liney-screen-x11"
if install_bundle "$BROKEN" fixture-broken >"$TMP/broken.log" 2>&1; then
  echo "installer accepted an incomplete release" >&2
  exit 1
fi
[ "$(readlink "$APP_ROOT/current")" = "releases/fixture-old" ]
verify_generation "$APP_ROOT/releases/fixture-old"

install_bundle "$BUNDLE" fixture-new
[ "$(readlink "$APP_ROOT/current")" = "releases/fixture-new" ]
verify_generation "$APP_ROOT/current"
verify_generation "$APP_ROOT/releases/fixture-old"
grep -Fq "Exec=$APP_ROOT/current/liney" "$TEST_HOME/.local/share/applications/liney.desktop"

echo "ATOMIC_DEPLOY_OK"
