import { describe, expect, test } from "bun:test";
import { EDIT_MENU_TEMPLATE, hasNativeEditShortcuts, installNativeEditMenu } from "./edit-menu.mjs";

describe("Electron native Edit menu", () => {
  test("registers cut, copy, paste and select-all roles", () => {
    const roles = EDIT_MENU_TEMPLATE[0].submenu
      .filter((item) => item.role)
      .map((item) => item.role);

    expect(roles).toEqual(["undo", "redo", "cut", "copy", "paste", "delete", "selectAll"]);
    for (const role of ["cut", "copy", "paste", "selectAll"]) {
      const item = EDIT_MENU_TEMPLATE[0].submenu.find((entry) => entry.role === role);
      expect(item?.registerAccelerator).toBe(true);
    }
  });

  test("installs the native Edit menu as the application menu", () => {
    let installed;
    const fakeMenu = {
      items: [{
        label: "Edit",
        submenu: { items: EDIT_MENU_TEMPLATE[0].submenu },
      }],
    };
    const fakeElectronMenu = {
      buildFromTemplate(template) {
        expect(template).toBe(EDIT_MENU_TEMPLATE);
        return fakeMenu;
      },
      setApplicationMenu(menu) {
        installed = menu;
      },
    };

    expect(installNativeEditMenu(fakeElectronMenu)).toBe(fakeMenu);
    expect(installed).toBe(fakeMenu);
    expect(hasNativeEditShortcuts(installed)).toBe(true);
  });

  test("fails closed when an editing accelerator role is missing", () => {
    const incompleteMenu = {
      items: [{ label: "Edit", submenu: { items: [{ role: "copy", registerAccelerator: false }, { role: "paste", registerAccelerator: true }] } }],
    };

    expect(hasNativeEditShortcuts(incompleteMenu)).toBe(false);
    expect(hasNativeEditShortcuts(null)).toBe(false);
  });
});
