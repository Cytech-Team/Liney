# Linux Packaging

Liney is packaged with Electron Builder. The desktop shell is Electron; no separate Rust desktop-shell build is involved.

## Build packages

```sh
npm ci
npm run electron:build:appimage
# AppImage, DEB and RPM
npm run electron:build
```

Artifacts are written to `release-electron/`. Native helpers are staged and SHA-256 verified by `scripts/electron-stage-helpers.mjs`.

## Flatpak

Flatpak is built from the Electron DEB; it does not use the retired Tauri bundle.

```sh
npm run electron:build:appimage # or build:deb to create the required DEB
npm run build:flatpak
```

Install the resulting `release-electron/Liney-Electron-Preview-<version>-x86_64.flatpak` with:

```sh
flatpak install --user ./release-electron/Liney-Electron-Preview-<version>-x86_64.flatpak
flatpak run com.cyoriasmp.liney
```

The build requires `flatpak`, `flatpak-builder`, and the Flathub GNOME 50 runtime/SDK. The Flatpak application ID is `com.cyoriasmp.liney` (lowercase, standards-compliant); the bundle uses the `preview` branch. The manifest grants network, desktop/audio, Secret Service, StatusNotifier, and PipeWire portal access; it does not grant unrestricted host filesystem access.
