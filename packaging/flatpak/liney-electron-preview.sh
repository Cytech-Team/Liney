#!/bin/sh
set -eu
# Flatpak already provides the outer application sandbox; Chromium's setuid
# sandbox cannot be used inside it.
exec "/app/opt/Liney/liney" --no-sandbox "$@"
