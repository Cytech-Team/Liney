#!/bin/sh
# Run native preview independently of existing installed Liney.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /usr/bin/python3 "$HERE/main.py" "$@"
