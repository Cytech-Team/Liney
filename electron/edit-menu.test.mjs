import { describe, expect, test } from "bun:test";
import { EDIT_MENU_TEMPLATE, getEditActionCalls, hasNativeEditShortcuts, installNativeEditMenu, resetEditActionCalls } from "./edit-menu.mjs";

describe("Electron native Edit menu", () => {
  test("registers explicit Control/Command accelerators for all four edit actions", () => {
    const items = EDIT_MENU_TEMPLATE[0].submenu;
    const expected = [
      ["Cut", "CommandOrControl+X"],
      ["Copy", "CommandOrControl+C"],
      ["Paste", "CommandOrControl+V"],
      ["Select All", "CommandOrControl+A"],
    ];
    for (const [label, accelerator] of expected) {
      const item = items.find((entry) => entry.label === label);
      expect(item?.accelerator).toBe(accelerator);
      expect(item?.registerAccelerator).toBe(true);
      expect(typeof item?.click).toBe("function");
    }
  });

  test("routes each accelerator to the focused webContents edit method", () => {
    resetEditActionCalls();
    const calls = [];
    const focusedWindow = {
      webContents: {
        isDestroyed: () => false,
        cut: () => calls.push("cut"),
        copy: () => calls.push("copy"),
        paste: () => calls.push("paste"),
        selectAll: () => calls.push("selectAll"),
      },
    };
    const items = EDIT_MENU_TEMPLATE[0].submenu;
    for (const label of ["Cut", "Copy", "Paste", "Select All"]) {
      items.find((item) => item.label === label).click({}, focusedWindow);
    }
    expect(calls).toEqual(["cut", "copy", "paste", "selectAll"]);
    expect(getEditActionCalls()).toEqual(["cut", "copy", "paste", "selectAll"]);
  });

  test("installs and validates the application Edit menu", () => {
    let installed;
    const fakeMenu = { items: [{ label: "Edit", submenu: { items: EDIT_MENU_TEMPLATE[0].submenu } }] };
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

  test("fails closed when any accelerator is absent or unregistered", () => {
    expect(EDIT_MENU_TEMPLATE[0].submenu.find((item) => item.label === "Copy").click({}, {})).toBeUndefined();
    const incompleteMenu = {
      items: [{ label: "Edit", submenu: { items: [
        { label: "Copy", accelerator: "CommandOrControl+C", registerAccelerator: false, click() {} },
        { label: "Paste", accelerator: "CommandOrControl+V", registerAccelerator: true, click() {} },
      ] } }],
    };

    expect(hasNativeEditShortcuts(incompleteMenu)).toBe(false);
    expect(hasNativeEditShortcuts(null)).toBe(false);
  });
});
