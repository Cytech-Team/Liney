/**
 * XDG autostart entry for the packaged app. The path comes from the AppImage
 * runtime (APPIMAGE) or the packaged executable; strip newlines and quotes so
 * it cannot inject extra desktop-entry keys.
 */
export function autostartEntry(target) {
  const safe = String(target ?? "").replace(/[\r\n"]/g, "");
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Liney",
    `Exec="${safe}"`,
    "X-GNOME-Autostart-enabled=true",
    "Terminal=false",
    "",
  ].join("\n");
}
