#!/bin/sh
set -eu

[ "$(uname -s)" = "Linux" ] || exit 0

fail=0

for command_name in curl file patchelf; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Liney: missing Linux build tool: $command_name" >&2
    fail=1
  fi
done

if command -v pkg-config >/dev/null 2>&1; then
  PKG_CONFIG=$(command -v pkg-config)
elif command -v pkgconf >/dev/null 2>&1; then
  PKG_CONFIG=$(command -v pkgconf)
else
  echo "Liney: pkg-config/pkgconf is required for Linux desktop builds." >&2
  fail=1
  PKG_CONFIG=""
fi

if [ -n "$PKG_CONFIG" ]; then
  for module in webkit2gtk-4.1 javascriptcoregtk-4.1 librsvg-2.0; do
    if ! "$PKG_CONFIG" --exists "$module"; then
      echo "Liney: missing Linux build dependency: $module" >&2
      fail=1
    fi
  done

  if ! "$PKG_CONFIG" --exists appindicator3-0.1 \
    && ! "$PKG_CONFIG" --exists ayatana-appindicator3-0.1; then
    echo "Liney: missing Linux tray dependency: appindicator3-0.1 or ayatana-appindicator3-0.1" >&2
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  if command -v pacman >/dev/null 2>&1; then
    echo "Install build dependencies with:" >&2
    echo "  sudo pacman -S --needed webkit2gtk-4.1 libappindicator-gtk3 librsvg xdotool appmenu-gtk-module patchelf" >&2
  elif command -v apt-get >/dev/null 2>&1; then
    echo "Install build dependencies with:" >&2
    echo "  sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf" >&2
  elif command -v dnf >/dev/null 2>&1; then
    echo "Install WebKitGTK 4.1, libappindicator, librsvg and libxdo development packages." >&2
  fi
  exit 1
fi

if ! command -v secret-tool >/dev/null 2>&1; then
  echo "Liney: note: secret-tool is unavailable; credential storage will use session-only mode." >&2
fi

printf 'Liney Linux build dependencies: OK (WebKitGTK 4.1 + AppIndicator)\n'
