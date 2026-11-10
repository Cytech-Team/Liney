#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="$(realpath "${1:-release-electron}")"
VERSION="$(node -p 'require("./package.json").version')"
APPIMAGE="$OUTPUT_DIR/Liney-Electron-Preview-${VERSION}-x86_64.AppImage"
DEB="$OUTPUT_DIR/Liney-Electron-Preview-${VERSION}-amd64.deb"
RPM="$OUTPUT_DIR/Liney-Electron-Preview-${VERSION}-x86_64.rpm"

for tool in file dpkg-deb rpm rpm2cpio cpio xvfb-run xdotool timeout ldd; do
  command -v "$tool" >/dev/null || {
    echo "Missing required package verification tool: $tool" >&2
    exit 1
  }
done

for artifact in "$APPIMAGE" "$DEB" "$RPM"; do
  test -s "$artifact"
  file "$artifact"
done

PACKAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$PACKAGE_ROOT"' EXIT

# Validate package metadata without relying on a host RPM database.
[[ "$(dpkg-deb --field "$DEB" Package)" == "liney" ]]
[[ "$(dpkg-deb --field "$DEB" Version)" == "$VERSION" ]]
[[ "$(dpkg-deb --field "$DEB" Architecture)" == "amd64" ]]
mkdir -p "$PACKAGE_ROOT/rpmdb"
rpm --dbpath "$PACKAGE_ROOT/rpmdb" --initdb
RPM_ID="$(rpm --dbpath "$PACKAGE_ROOT/rpmdb" -qp --queryformat '%{VERSION} %{ARCH}' "$RPM")"
[[ "$RPM_ID" == "${VERSION} x86_64" ]]
rpm --dbpath "$PACKAGE_ROOT/rpmdb" -qpl "$RPM" > "$PACKAGE_ROOT/rpm-files.txt"
grep -Fqx '/opt/Liney Electron Preview/liney' "$PACKAGE_ROOT/rpm-files.txt"
dpkg-deb --extract "$DEB" "$PACKAGE_ROOT/deb"
DEB_APP="$PACKAGE_ROOT/deb/opt/Liney Electron Preview/liney"
test -x "$DEB_APP"
test -s "$PACKAGE_ROOT/deb/opt/Liney Electron Preview/resources/app.asar"
test -x "$PACKAGE_ROOT/deb/opt/Liney Electron Preview/resources/app.asar.unpacked/electron/native/liney-media"
grep -Fqx 'Exec="/opt/Liney Electron Preview/liney" %U' \
  "$PACKAGE_ROOT/deb/usr/share/applications/dev.cytechteam.liney.electron-preview.desktop"

mkdir -p "$PACKAGE_ROOT/rpm"
rpm2cpio "$RPM" | (cd "$PACKAGE_ROOT/rpm" && cpio -idm --quiet)
RPM_APP="$PACKAGE_ROOT/rpm/opt/Liney Electron Preview/liney"
test -x "$RPM_APP"
test -s "$PACKAGE_ROOT/rpm/opt/Liney Electron Preview/resources/app.asar"

for payload in deb rpm; do
  NATIVE="$PACKAGE_ROOT/$payload/opt/Liney Electron Preview/resources/app.asar.unpacked/electron/native"
  for helper in liney-media liney-audio liney-screen liney-screen-wayland liney-screen-x11; do
    test -x "$NATIVE/$helper"
    ldd "$NATIVE/$helper" > "$PACKAGE_ROOT/${payload}-${helper}.ldd" 2>&1
    ! grep -q 'not found' "$PACKAGE_ROOT/${payload}-${helper}.ldd"
  done
  "$NATIVE/liney-media" --liney-keyring-probe > "$PACKAGE_ROOT/${payload}-keyring.json"
  grep -q '"available":' "$PACKAGE_ROOT/${payload}-keyring.json"
done

run_smoke() {
  local label="$1"
  local logfile="$PACKAGE_ROOT/${label}.log"
  shift
  local data_dir="$PACKAGE_ROOT/data-${label}"
  mkdir -m 700 "$data_dir"

  echo "=== Smoke test: ${label} ==="
  set +e
  LINEY_DATA_DIR="$data_dir" \
    LINEY_DISABLE_AUTO_RESTORE=1 \
    LINEY_ELECTRON_SMOKE=1 \
    timeout -k 2s 60s xvfb-run -a --server-args='-screen 0 1280x800x24' \
      env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET "$@" --no-sandbox --ozone-platform=x11 >"$logfile" 2>&1
  local status=$?
  set -e
  cat "$logfile"
  if [[ "$status" -ne 0 ]]; then
    echo "${label} smoke test exited with status ${status}" >&2
    return "$status"
  fi

  for marker in \
    '"authDialog":true' \
    '"logoLoaded":true' \
    '"menuHidden":true' \
    '"nativeEditMenu":true' \
    '"selectAll":true' \
    '"copy":true' \
    '"cut":true' \
    '"paste":true' \
    '"nativeHelpers":5' \
    '"enginePong":true'; do
    grep -Fq "$marker" "$logfile" || {
      echo "${label} smoke test did not report ${marker}" >&2
      return 1
    }
  done
}

# Extract the AppImage without requiring FUSE, then smoke-test its real binary.
mkdir -p "$PACKAGE_ROOT/appimage"
(
  cd "$PACKAGE_ROOT/appimage"
  "$APPIMAGE" --appimage-extract >/dev/null
)
run_smoke appimage "$PACKAGE_ROOT/appimage/squashfs-root/liney"

# Exercise the executable and resources from the actual DEB archive without
# installing anything into the CI runner.
run_smoke deb "$DEB_APP"

# Extract the RPM payload without installing it into the CI runner.
run_smoke rpm "$RPM_APP"

echo "All AppImage, DEB and RPM package checks passed for ${VERSION}."
