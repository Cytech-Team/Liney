# Liney Electron Preview 0.1.5

Liney 0.1.5 wires AppImage auto-update to GitHub Releases and cleans up the
About page so an up-to-date install simply says so and stops.

## Highlights

- **GitHub update feed:** packaged AppImage builds resolve the update feed
  from `Cytech-Team/Liney` releases out of the box (`latest-linux.yml` +
  `.blockmap` with SHA-512/signature metadata). No manual feed URL needed;
  `LINEY_UPDATE_FEED_URL` remains as a self-hosted generic-feed override.
  Preview and Stable stay separate via stable releases vs prereleases.
- **Up-to-date UX:** when no update is available, About reports the latest
  version and ends — no stale "new version" subtitle, no leftover
  release-notes or error blocks.
- **English UI coverage:** full English localization alongside Thai, with
  automatic selection from the system locale and a manual switch in Settings.
- **Native editing shortcuts:** Ctrl+A/C/V/X (including Thai input) verified
  in packaged builds.
- **Portable package verification:** Linux package checks no longer depend on
  a host RPM database, and Talk sync waits for readiness before disabling
  polling fallback.

## Linux downloads

The release pipeline publishes x86_64 AppImage, DEB, RPM, and Flatpak
packages, now including the `latest-linux.yml` update metadata and blockmap
for AppImage auto-update. Native GUI and packaged-worker smoke checks run in
CI; Flatpak build output is verified before publication.

## Notes

Liney is an independent, unofficial desktop client for LINE and is not
affiliated with or endorsed by LINE Corporation.
