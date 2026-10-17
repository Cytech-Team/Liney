#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HOME_DIR=${HOME:?HOME is required}
VERSION=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("package.json", "utf8")).version)')
case "$(uname -m)" in
  x86_64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) echo "Unsupported deployment architecture: $(uname -m)" >&2; exit 1 ;;
esac

NAME="Liney-$VERSION-linux-$ARCH"
PORTABLE="$ROOT/build/local-deploy/$NAME"
[ -x "$PORTABLE/install-user.sh" ] || { echo "verified local deployment bundle missing: $PORTABLE" >&2; exit 1; }
PACKAGE_MARKER="$ROOT/build/screen-package-gate.ok"
[ -s "$PACKAGE_MARKER" ] || { echo "current package gate has not passed" >&2; exit 1; }
read -r MARKER_VERSION MARKER_DIGEST < "$PACKAGE_MARKER"
[ "$MARKER_VERSION" = "$VERSION" ] || { echo "package marker is for a different version" >&2; exit 1; }
TARGET=$(rustc -vV | sed -n 's/^host: //p')
SOURCE_X11="$ROOT/build/liney-screen-x11-$TARGET"
[ -x "$SOURCE_X11" ] || { echo "current X11 helper is not built" >&2; exit 1; }
SOURCE_DIGEST=$(sha256sum "$SOURCE_X11" | cut -d ' ' -f 1)
[ "$SOURCE_DIGEST" = "$MARKER_DIGEST" ] || { echo "source X11 helper changed after package verification" >&2; exit 1; }
cmp -s "$SOURCE_X11" "$PORTABLE/liney-screen-x11" || { echo "deployment bundle helper differs from verified package" >&2; exit 1; }

# The gate runner continues after failures. Refuse the live install unless all
# earlier gates are current, so a failed regression cannot deploy a package.
GATE_CHECK="$HOME_DIR/.codex/skills/unlazy/scripts/gate-check.mjs"
[ -f "$GATE_CHECK" ] || { echo "Unlazy gate checker is unavailable" >&2; exit 1; }
set +e
GATE_STATUS=$(node "$GATE_CHECK" --status "$ROOT/GATES.md" 2>&1)
GATE_STATUS_CODE=$?
set -e
[ "$GATE_STATUS_CODE" -eq 0 ] || [ "$GATE_STATUS_CODE" -eq 1 ] || { printf '%s\n' "$GATE_STATUS" >&2; exit "$GATE_STATUS_CODE"; }
if ! { printf '%s\n' "$GATE_STATUS" | grep -Fq 'UNMET: 1 (met: 11)' && printf '%s\n' "$GATE_STATUS" | grep -Fq 'GATES:G11'; } \
  && ! { printf '%s\n' "$GATE_STATUS" | grep -Fq 'UNMET: 2 (met: 10' && printf '%s\n' "$GATE_STATUS" | grep -Fq 'GATES:G10,G11'; } \
  && ! printf '%s\n' "$GATE_STATUS" | grep -q '^ALL MET'; then
  printf '%s\n' "$GATE_STATUS" >&2
  echo "deployment refused because a preceding Unlazy gate is unmet" >&2
  exit 1
fi

TMP_PARENT=${LINEY_TMPDIR:-"$ROOT/build/tmp"}
mkdir -p "$TMP_PARENT"
TMP=$(mktemp -d "$TMP_PARENT/liney-user-deploy.XXXXXX")
cleanup() { rm -rf -- "$TMP"; }
trap cleanup EXIT HUP INT TERM

INSTALL_BASE=${LINEY_INSTALL_BASE:-"$HOME_DIR/.local/lib/liney"}
HOME="$HOME_DIR" LINEY_INSTALL_BASE="$INSTALL_BASE" sh "$PORTABLE/install-user.sh" >"$TMP/install.log"
[ -L "$INSTALL_BASE/current" ] || { cat "$TMP/install.log" >&2; echo "current release pointer was not installed" >&2; exit 1; }
case "$(readlink "$INSTALL_BASE/current")" in
  releases/*) ;;
  *) echo "unexpected current release pointer: $(readlink "$INSTALL_BASE/current")" >&2; exit 1 ;;
esac

LINEY_INSTALL_DIR="$INSTALL_BASE/current" sh "$ROOT/scripts/test-installed-liney-screen.sh"
echo "DEPLOY_AND_INSTALLED_OK"
