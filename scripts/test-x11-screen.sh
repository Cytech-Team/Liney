#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET=$(rustc -vV | sed -n 's/^host: //p')
HELPER="$ROOT/build/liney-screen-x11-$TARGET"
[ -x "$HELPER" ] || HELPER="$ROOT/native/liney-screen-x11/target/release/liney-screen-x11"
[ -x "$HELPER" ] || { echo "liney-screen-x11 is not built" >&2; exit 1; }
command -v Xvfb >/dev/null 2>&1 || { echo "Xvfb is required for this development test" >&2; exit 1; }
command -v xrandr >/dev/null 2>&1 || { echo "xrandr is required to create the RandR monitor fixture" >&2; exit 1; }
command -v xmessage >/dev/null 2>&1 || { echo "xmessage is required for the window capture fixture" >&2; exit 1; }

DISPLAY_NUM=""
for n in 81 82 83 84 85 86 87 88 89; do
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
  if DISPLAY="$DISPLAY_VALUE" "$HELPER" --probe >"$TMP/probe.json" 2>/dev/null; then
    if grep -q '"available":true' "$TMP/probe.json"; then ready=1; break; fi
  fi
  sleep 0.1
done
[ "$ready" -eq 1 ] || { cat "$TMP/xvfb.log" >&2; exit 1; }

DISPLAY="$DISPLAY_VALUE" xrandr --setmonitor LineyGate 1280/400x720/225+0+0 none >/dev/null
DISPLAY="$DISPLAY_VALUE" xmessage -name Liney-X11-Smoke -geometry 480x240+100+100 "Liney X11 smoke" >/dev/null 2>&1 &
WPID=$!
sleep 0.3
DISPLAY="$DISPLAY_VALUE" "$HELPER" --probe >"$TMP/probe.json"

DISPLAY="$DISPLAY_VALUE" "$HELPER" --self-test >/dev/null

python - "$TMP/probe.json" >"$TMP/targets.txt" <<'PY'
import json,sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
assert d["available"] is True
targets=["desktop"]
monitors=[t["id"] for t in d["targets"] if t.get("available") and t.get("kind")=="monitor"]
assert monitors, d["targets"]
targets += monitors
window=next((t["id"] for t in d["targets"] if t.get("available") and t.get("kind")=="window"), None)
assert window is not None, d["targets"]
targets.append(window)
targets.append("region:64,64,320,240")
print("\n".join(dict.fromkeys(targets)))
PY

verify_h264() {
  file=$1
  [ -s "$file" ] || { echo "empty H.264 output: $file" >&2; return 1; }
  if command -v ffprobe >/dev/null 2>&1; then
    ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 "$file" \
      | grep -q '^h264,'
  else
    python - "$file" <<'PY'
import sys
b=open(sys.argv[1],"rb").read(4096)
assert b"\x00\x00\x00\x01" in b or b"\x00\x00\x01" in b
PY
  fi
}

i=0
while IFS= read -r target; do
  [ -n "$target" ] || continue
  out="$TMP/capture-$i.h264"
  err="$TMP/capture-$i.err"
  set +e
  timeout 3s env DISPLAY="$DISPLAY_VALUE" XDG_SESSION_TYPE=x11 WAYLAND_DISPLAY= \
    "$HELPER" --capture --target "$target" >"$out" 2>"$err"
  status=$?
  set -e
  [ "$status" -eq 0 ] || [ "$status" -eq 124 ] || { cat "$err" >&2; exit "$status"; }
  verify_h264 "$out" || { cat "$err" >&2; exit 1; }
  i=$((i+1))
done <"$TMP/targets.txt"

out="$TMP/baseline-getimage.h264"
err="$TMP/baseline-getimage.err"
set +e
timeout 3s env \
  DISPLAY="$DISPLAY_VALUE" \
  XDG_SESSION_TYPE=x11 \
  WAYLAND_DISPLAY= \
  LINEY_X11_DISABLE_SHM=1 \
  LINEY_X11_DISABLE_DAMAGE=1 \
  LINEY_X11_DISABLE_COMPOSITE=1 \
  LINEY_X11_DISABLE_XFIXES=1 \
  "$HELPER" --capture --target desktop >"$out" 2>"$err"
status=$?
set -e
[ "$status" -eq 0 ] || [ "$status" -eq 124 ] || { cat "$err" >&2; exit "$status"; }
verify_h264 "$out" || { cat "$err" >&2; exit 1; }
grep -q 'backend=x11-get-image' "$err"

echo "X11_SCREEN_SMOKE_OK"
