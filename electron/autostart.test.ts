import { describe, expect, test } from "bun:test";
import { autostartEntry } from "./autostart.mjs";

describe("autostart desktop entry", () => {
  test("points XDG autostart at the actual executable", () => {
    const entry = autostartEntry("/home/liney/Applications/Liney-0.1.10-x86_64.AppImage");
    expect(entry).toContain("[Desktop Entry]");
    expect(entry).toContain('Exec="/home/liney/Applications/Liney-0.1.10-x86_64.AppImage"');
    expect(entry).toContain("X-GNOME-Autostart-enabled=true");
  });

  test("cannot inject extra desktop-entry lines through the path", () => {
    const entry = autostartEntry('/tmp/a"\nHidden=true');
    expect(entry.split("\n").some((line) => line.startsWith("Hidden="))).toBe(false);
    expect(entry.split("\n").filter((line) => line.startsWith("Exec="))).toHaveLength(1);
  });
});
