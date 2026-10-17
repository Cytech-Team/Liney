#!/bin/sh
set -eu

[ "$(uname -s)" = "Linux" ] || exit 0

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail=0

printf 'Liney source-build prerequisites\n'

for command_name in curl file patchelf; do
  if command -v "$command_name" >/dev/null 2>&1; then
    printf '  ✓ %s\n' "$command_name"
  else
    printf '  ✗ %s (required to build release artifacts)\n' "$command_name" >&2
    fail=1
  fi
done

if command -v pkg-config >/dev/null 2>&1; then
  PKG_CONFIG=$(command -v pkg-config)
elif command -v pkgconf >/dev/null 2>&1; then
  PKG_CONFIG=$(command -v pkgconf)
else
  printf '  ✗ pkg-config/pkgconf (required for source builds)\n' >&2
  fail=1
  PKG_CONFIG=""
fi

if [ -n "$PKG_CONFIG" ]; then
  for module in webkit2gtk-4.1 javascriptcoregtk-4.1 librsvg-2.0 alsa libpipewire-0.3 wayland-client; do
    if "$PKG_CONFIG" --exists "$module"; then
      printf '  ✓ %s\n' "$module"
    else
      printf '  ✗ %s (source-build prerequisite)\n' "$module" >&2
      fail=1
    fi
  done

  if "$PKG_CONFIG" --exists appindicator3-0.1; then
    printf '  ✓ appindicator3-0.1\n'
  elif "$PKG_CONFIG" --exists ayatana-appindicator3-0.1; then
    printf '  ✓ ayatana-appindicator3-0.1\n'
  else
    printf '  ✗ AppIndicator development files (source-build prerequisite)\n' >&2
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf '\nThese are developer/source-build requirements, not Liney runtime feature requirements.\n' >&2
  exit 1
fi

printf '\nLiney runtime capability model\n'

TARGET=$(rustc -vV 2>/dev/null | sed -n 's/^host: //p' || true)

pick_helper() {
  name=$1
  for candidate in \
    "$ROOT/build/$name-$TARGET" \
    "$ROOT/src-tauri/binaries/$name-$TARGET" \
    "$ROOT/src-tauri/target/release/$name" \
    "${HOME:-}/.local/lib/liney/$name"
  do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && [ -s "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

AUDIO=$(pick_helper liney-audio || true)
MEDIA=$(pick_helper liney-media || true)
SCREEN=$(pick_helper liney-screen || true)
SCREEN_WAYLAND=$(pick_helper liney-screen-wayland || true)
SCREEN_X11=$(pick_helper liney-screen-x11 || true)

if [ -n "$AUDIO" ]; then
  AUDIO_JSON=$("$AUDIO" --liney-media-audio-devices 2>/dev/null || true)
  if [ -n "$AUDIO_JSON" ]; then
    if printf '%s' "$AUDIO_JSON" | grep -q '"inputs":\[\]'; then
      printf '  — Microphone: Unavailable (calls remain usable)\n'
    else
      printf '  ✓ Microphone: Native system default\n'
    fi
    if printf '%s' "$AUDIO_JSON" | grep -q '"outputs":\[\]'; then
      printf '  — Speaker: Unavailable (calls remain usable)\n'
    else
      printf '  ✓ Speaker: Native system default\n'
    fi
  else
    printf '  — Audio: Unavailable (isolated; messaging/calls still launch)\n'
  fi
else
  printf '  ○ Audio helper: not built yet\n'
fi

CAMERA=""
for device in /dev/video*; do
  if [ -c "$device" ]; then
    CAMERA=$device
    break
  fi
done
if [ -n "$CAMERA" ]; then
  printf '  ✓ Camera: Native V4L2 (%s)\n' "$CAMERA"
else
  printf '  — Camera: Unavailable (video calls still usable without local camera)\n'
fi

SCREEN_READY=0

if [ -n "$SCREEN" ]; then
  SCREEN_JSON=$("$SCREEN" --liney-media-screen-share-probe 2>/dev/null || true)
  if printf '%s' "$SCREEN_JSON" | grep -q '"available":true'; then
    printf '  ✓ Screen share primary: XDG Desktop Portal + PipeWire\n'
    SCREEN_READY=1
  else
    printf '  ○ Screen share primary: Portal/PipeWire unavailable; probing native fallbacks\n'
  fi
fi

if [ -n "$SCREEN_WAYLAND" ] && { [ -n "${WAYLAND_DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; }; then
  WAYLAND_JSON=$("$SCREEN_WAYLAND" --probe 2>/dev/null || true)
  if printf '%s' "$WAYLAND_JSON" | grep -q '"available":true'; then
    if printf '%s' "$WAYLAND_JSON" | grep -q '"backend":"wayland-ext-image-copy"'; then
      printf '  ✓ Screen share Wayland fallback: ext-image-copy-capture'
      if printf '%s' "$WAYLAND_JSON" | grep -q '"wlrScreencopy":true'; then
        printf ' → wlr-screencopy retry'
      fi
      printf '\n'
    else
      printf '  ✓ Screen share Wayland fallback: wlr-screencopy\n'
    fi
    SCREEN_READY=1
  fi
fi

if [ "${XDG_SESSION_TYPE:-}" != "wayland" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && [ -n "${DISPLAY:-}" ] && [ -n "$SCREEN_X11" ]; then
  X11_JSON=$("$SCREEN_X11" --probe 2>/dev/null || true)
  if printf '%s' "$X11_JSON" | grep -q '"available":true'; then
    if printf '%s' "$X11_JSON" | grep -q '"backend":"x11-xshm"'; then
      printf '  ✓ Screen share X11 fallback: XShm → GetImage'
    else
      printf '  ✓ Screen share X11 fallback: core GetImage'
    fi
    if printf '%s' "$X11_JSON" | grep -q '"composite":true'; then printf ' · XComposite'; fi
    if printf '%s' "$X11_JSON" | grep -q '"damage":true'; then printf ' · XDamage'; fi
    if printf '%s' "$X11_JSON" | grep -q '"xfixes":true'; then printf ' · XFixes'; fi
    if printf '%s' "$X11_JSON" | grep -q '"randr":true'; then printf ' · RandR'; fi
    printf '\n'
    SCREEN_READY=1
  fi
fi

if [ "$SCREEN_READY" -eq 0 ]; then
  printf '  — Screen share: no supported capture protocol in this session\n'
fi

if [ -n "$MEDIA" ]; then
  WALLET_JSON=$("$MEDIA" --liney-keyring-probe 2>/dev/null || true)
  if printf '%s' "$WALLET_JSON" | grep -q '"available":true'; then
    printf '  ✓ Credentials: system Secret Service\n'
  else
    printf '  ✓ Credentials: encrypted local fallback (auto-migrates to Secret Service)\n'
  fi
else
  printf '  ○ Media/keyring helper: not built yet\n'
fi

printf '\nNo optional runtime capability above is a prerequisite for launching Liney.\n'
