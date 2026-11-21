#!/usr/bin/env bash
# Stage a content-addressed immutable copy of the AppImage before execution.
# An AppImage updated in place while its squashfs is mounted can SIGBUS.
set -euo pipefail

source_image="${LINEY_APPIMAGE_SOURCE:-$HOME/.local/bin/Liney.AppImage}"
release_store="${LINEY_APPIMAGE_STORE:-$HOME/.local/lib/liney/appimage-versions}"
[[ -s "$source_image" && -x "$source_image" ]] || { echo "Liney AppImage missing: $source_image" >&2; exit 1; }
mkdir -p -- "$release_store"
exec 9>"$release_store/.stage.lock"
flock -x 9

staged=""
for attempt in 1 2 3; do
    digest=$(sha256sum -- "$source_image" | cut -d' ' -f1)
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || exit 1
    target="$release_store/$digest.AppImage"
    if [[ -e "$target" ]]; then
        actual=$(sha256sum -- "$target" | cut -d' ' -f1)
        if [[ "$actual" != "$digest" ]]; then
            echo "Refusing modified immutable Liney release: $target" >&2
            exit 1
        fi
    else
        tmp=$(mktemp "$release_store/.stage-XXXXXXXX")
        trap 'rm -f -- "${tmp:-}"' EXIT
        cp --reflink=auto -- "$source_image" "$tmp"
        chmod 755 "$tmp"
        actual=$(sha256sum -- "$tmp" | cut -d' ' -f1)
        if [[ "$actual" != "$digest" ]]; then
            rm -f -- "$tmp"
            tmp=""
            continue
        fi
        mv -n -- "$tmp" "$target"
        tmp=""
    fi
    # If the source changed while staging, repeat for the newer revision.
    current=$(sha256sum -- "$source_image" | cut -d' ' -f1)
    if [[ "$current" == "$digest" ]]; then
        staged="$target"
        break
    fi
done
[[ -n "$staged" ]] || { echo "Liney AppImage changed repeatedly during deployment" >&2; exit 1; }
flock -u 9
exec 9>&-
if [[ "${LINEY_STAGE_ONLY:-0}" == 1 ]]; then
    printf '%s\n' "$staged"
    exit 0
fi
exec "$staged" "$@"
