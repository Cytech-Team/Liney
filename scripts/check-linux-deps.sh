#!/bin/sh
set -eu
[ "$(uname -s)" = "Linux" ] || exit 0
printf 'Liney Electron build prerequisites\n'
fail=0
for command_name in node npm bun file patchelf; do
  if command -v "$command_name" >/dev/null 2>&1; then printf '  ✓ %s\n' "$command_name"; else printf '  ✗ %s\n' "$command_name" >&2; fail=1; fi
done
if [ "$fail" -ne 0 ]; then exit 1; fi
printf '\nElectron bundles Chromium; no system web engine development package is required.\n'
