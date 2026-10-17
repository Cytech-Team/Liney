#!/bin/sh
set -eu

HOME_DIR=${HOME:?HOME is required}
DEST=${LINEY_INSTALL_DIR:-"$HOME_DIR/.local/lib/liney/current"}
for name in liney liney-engine liney-media liney-audio liney-screen liney-screen-wayland liney-screen-x11; do
  [ -x "$DEST/$name" ] || { echo "missing installed $DEST/$name" >&2; exit 1; }
done

command -v Xvfb >/dev/null 2>&1 || { echo "Xvfb is required for installed screen self-test" >&2; exit 1; }
command -v dbus-run-session >/dev/null 2>&1 || { echo "dbus-run-session is required for isolated UI startup smoke" >&2; exit 1; }
DISPLAY_NUM=""
for n in 71 72 73 74 75 76 77 78 79; do
  if [ ! -e "/tmp/.X11-unix/X$n" ]; then DISPLAY_NUM=$n; break; fi
done
[ -n "$DISPLAY_NUM" ] || { echo "no free Xvfb display" >&2; exit 1; }
D=":$DISPLAY_NUM"

TMP_PARENT=${LINEY_TMPDIR:-/tmp}
TMP=$(mktemp -d "$TMP_PARENT/liney-installed-screen.XXXXXX")
Xvfb "$D" -screen 0 800x600x24 -nolisten tcp >"$TMP/xvfb.log" 2>&1 &
XPID=$!
cleanup() { kill "$XPID" 2>/dev/null || true; rm -rf -- "$TMP"; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$TMP/home/data" "$TMP/home/config" "$TMP/home/cache" "$TMP/home/state"

ready=0
for _ in $(seq 1 50); do
  if DISPLAY="$D" "$DEST/liney-screen-x11" --self-test >"$TMP/self.log" 2>/dev/null; then
    if grep -q X11_SELF_TEST_OK "$TMP/self.log"; then ready=1; break; fi
  fi
  sleep 0.1
done
[ "$ready" -eq 1 ] || { cat "$TMP/xvfb.log" >&2; cat "$TMP/self.log" >&2; exit 1; }

set +e
timeout 3s env DISPLAY="$D" XDG_SESSION_TYPE=x11 WAYLAND_DISPLAY= "$DEST/liney-screen-x11" --capture --target desktop >"$TMP/installed.h264" 2>"$TMP/capture.log"
capture_status=$?
set -e
[ "$capture_status" -eq 0 ] || [ "$capture_status" -eq 124 ] || { cat "$TMP/capture.log" >&2; exit "$capture_status"; }
[ -s "$TMP/installed.h264" ] || { cat "$TMP/capture.log" >&2; echo "installed X11 helper emitted no H.264" >&2; exit 1; }
if command -v ffprobe >/dev/null 2>&1; then
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$TMP/installed.h264" | grep -q '^h264$'
else
  python - "$TMP/installed.h264" <<'PY'
import sys
b=open(sys.argv[1],"rb").read(4096)
assert b"\x00\x00\x00\x01" in b or b"\x00\x00\x01" in b
PY
fi

set +e
(printf '%s\n' '{"id":"installed-ping","version":1,"method":"ping","params":{}}'; sleep 1) | env HOME="$TMP/home" XDG_DATA_HOME="$TMP/home/data" XDG_CONFIG_HOME="$TMP/home/config" XDG_CACHE_HOME="$TMP/home/cache" XDG_STATE_HOME="$TMP/home/state" timeout 4s "$DEST/liney-engine" >"$TMP/engine.log" 2>&1
engine_status=$?
set -e
[ "$engine_status" -eq 0 ] || [ "$engine_status" -eq 124 ] || { cat "$TMP/engine.log" >&2; exit "$engine_status"; }
grep -q '"pong":true' "$TMP/engine.log" || { cat "$TMP/engine.log" >&2; echo "installed engine ping failed" >&2; exit 1; }

# Start the packaged UI on the isolated X server and isolated user-data paths.
# timeout's 124 result confirms it stayed alive until the smoke window ended.
set +e
dbus-run-session -- timeout --signal=TERM --kill-after=2s 12s env HOME="$TMP/home" XDG_DATA_HOME="$TMP/home/data" XDG_CONFIG_HOME="$TMP/home/config" XDG_CACHE_HOME="$TMP/home/cache" XDG_STATE_HOME="$TMP/home/state" DISPLAY="$D" GDK_BACKEND=x11 XDG_SESSION_TYPE=x11 WAYLAND_DISPLAY= "$DEST/liney" >"$TMP/liney.log" 2>&1
app_status=$?
set -e
[ "$app_status" -eq 124 ] || { cat "$TMP/liney.log" >&2; echo "installed Liney UI exited before completing its startup window (status $app_status)" >&2; exit 1; }

echo "INSTALLED_SCREEN_OK"
