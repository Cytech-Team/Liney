#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET=$(rustc -vV | sed -n 's/^host: //p')
ENGINE="$ROOT/build/liney-engine-$TARGET"
X11="$ROOT/build/liney-screen-x11-$TARGET"
[ -x "$ENGINE" ] || { echo "engine sidecar is not built" >&2; exit 1; }
[ -x "$X11" ] || { echo "x11 screen sidecar is not built" >&2; exit 1; }
command -v Xvfb >/dev/null 2>&1 || { echo "Xvfb is required for this development test" >&2; exit 1; }
command -v xrandr >/dev/null 2>&1 || { echo "xrandr is required to create the RandR monitor fixture" >&2; exit 1; }
command -v xmessage >/dev/null 2>&1 || { echo "xmessage is required for the window target fixture" >&2; exit 1; }

DISPLAY_NUM=""
for n in 91 92 93 94 95 96 97 98 99; do
  if [ ! -e "/tmp/.X11-unix/X$n" ]; then DISPLAY_NUM=$n; break; fi
done
[ -n "$DISPLAY_NUM" ] || { echo "no free Xvfb display" >&2; exit 1; }
DISPLAY_VALUE=":$DISPLAY_NUM"
TMP=$(mktemp -d)
XPID=""
WPID=""
cleanup() {
  [ -z "$WPID" ] || kill "$WPID" 2>/dev/null || true
  [ -z "$XPID" ] || kill "$XPID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY_VALUE" -screen 0 1280x720x24 -nolisten tcp >"$TMP/xvfb.log" 2>&1 &
XPID=$!
ready=0
for _ in $(seq 1 50); do
  if DISPLAY="$DISPLAY_VALUE" "$X11" --probe >"$TMP/probe.json" 2>/dev/null; then
    if grep -q '"available":true' "$TMP/probe.json"; then ready=1; break; fi
  fi
  sleep 0.1
done
[ "$ready" -eq 1 ] || { cat "$TMP/xvfb.log" >&2; exit 1; }

DISPLAY="$DISPLAY_VALUE" xrandr --setmonitor LineyGate 1280/400x720/225+0+0 none >/dev/null
DISPLAY="$DISPLAY_VALUE" xmessage -name Liney-X11-Gate -geometry 480x240+100+100 "Liney X11 gate" >/dev/null 2>&1 &
WPID=$!
sleep 0.3

ISOLATED="$TMP/engine"
cp "$ENGINE" "$ISOLATED"
chmod +x "$ISOLATED"
mkdir -p "$TMP/home" "$TMP/state" "$TMP/config"
printf '%s\n' '{"id":"targets","version":1,"method":"call.screenTargets","params":{}}' \
  | (
      cd "$TMP"
      env \
        HOME="$TMP/home" \
        XDG_STATE_HOME="$TMP/state" \
        XDG_CONFIG_HOME="$TMP/config" \
        XDG_SESSION_TYPE=x11 \
        WAYLAND_DISPLAY= \
        DISPLAY="$DISPLAY_VALUE" \
        LINEY_SCREEN_BINARY=/nonexistent \
        LINEY_SCREEN_WAYLAND_BINARY=/nonexistent \
        LINEY_SCREEN_X11_BINARY="$X11" \
        timeout 8s ./engine 2>/dev/null
    ) \
  | grep '"id":"targets"' >"$TMP/result.json"

python - "$TMP/result.json" <<'PY'
import json, sys
r=json.load(open(sys.argv[1], encoding="utf-8"))["result"]
assert r["backend"] == "x11-native", r
assert r["managedBySystem"] is False, r
targets=r.get("targets", [])
kinds={t["kind"] for t in targets if t.get("available")}
assert {"desktop", "monitor", "region", "window"} <= kinds, targets
print("ENGINE_X11_TARGETS_OK", len(targets))
PY
