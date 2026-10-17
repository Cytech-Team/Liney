# LINEy Linux distribution

The release workflow for tag `v0.1.2` builds `.deb`, `.rpm`, `.AppImage`, portable `.tar.gz` on x86_64 and aarch64, plus an x86_64 `.flatpak` bundle with GNOME Platform 50. Checksums are included. Download from GitHub Releases.

## Arch Linux / CachyOS

`packaging/arch/PKGBUILD` builds from source. `packaging/arch/liney-bin/PKGBUILD` installs the prebuilt portable release. Use `makepkg -si` in the appropriate folder only after checksum verification, or use `yay -S liney-bin` once the package is actually published on AUR. `yay` reads AUR metadata and does not publish packages itself.

AUR publishing requires a separate AUR account with an uploaded SSH public key; GitHub authentication cannot substitute for AUR SSH authorization. These in-tree manifest templates are not AUR listings until pushed to aur.archlinux.org. Before publishing, replace every `SKIP` checksum with a verified SHA256 and generate `.SRCINFO` (`makepkg --printsrcinfo`).

## Flatpak

`packaging/flatpak/com.cyoriasmp.Liney.yml` consumes a local `.deb` named `Liney-release.deb` (copied from the same release). It installs Tauri and six sidecars into the sandbox and uses GNOME Platform 50. To make a local bundle after installing `flatpak-builder`, `org.gnome.Sdk//50` and `org.gnome.Platform//50`:

```sh
cp release/Liney-0.1.2-linux-x86_64.deb packaging/flatpak/Liney-release.deb
flatpak-builder --user --install-deps-from=flathub --force-clean --repo=flatpak-repo flatpak-build packaging/flatpak/com.cyoriasmp.Liney.yml
flatpak build-bundle flatpak-repo release/Liney-0.1.2-linux-x86_64.flatpak com.cyoriasmp.Liney --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo
```

An `.flatpak` on GitHub Releases does not automatically make the app available on Flathub: Flathub admission requires a separate submission PR and review. The Flatpak runtime may not support every native sidecar feature out of the box; verify permissions, calls and screen sharing on each environment.

## AppImage

The AppImage is re-packed after build to ensure the Bun engine binary matches the original, because patching compiled Bun ELF binaries may corrupt the runtime. Test on a compatible Linux desktop before announcing stable availability.
