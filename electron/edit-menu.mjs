/**
 * Keep Chromium's native text-edit actions registered even though Liney hides
 * the menu bar. Explicit accelerators avoid Electron's platform-specific
 * default registration behavior for the built-in cut/copy/paste roles.
 */
export const EDIT_MENU_TEMPLATE = [
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      {
        label: "Cut",
        accelerator: "CommandOrControl+X",
        registerAccelerator: true,
        click: (_item, focusedWindow) => focusedWindow?.webContents.cut(),
      },
      {
        label: "Copy",
        accelerator: "CommandOrControl+C",
        registerAccelerator: true,
        click: (_item, focusedWindow) => focusedWindow?.webContents.copy(),
      },
      {
        label: "Paste",
        accelerator: "CommandOrControl+V",
        registerAccelerator: true,
        click: (_item, focusedWindow) => focusedWindow?.webContents.paste(),
      },
      { role: "delete" },
      { type: "separator" },
      {
        label: "Select All",
        accelerator: "CommandOrControl+A",
        registerAccelerator: true,
        click: (_item, focusedWindow) => focusedWindow?.webContents.selectAll(),
      },
    ],
  },
];

const REQUIRED_EDIT_ACCELERATORS = [
  ["Cut", "CommandOrControl+X"],
  ["Copy", "CommandOrControl+C"],
  ["Paste", "CommandOrControl+V"],
  ["Select All", "CommandOrControl+A"],
];

export function installNativeEditMenu(Menu) {
  const menu = Menu.buildFromTemplate(EDIT_MENU_TEMPLATE);
  Menu.setApplicationMenu(menu);
  return menu;
}

export function hasNativeEditShortcuts(menu) {
  const editMenu = menu?.items?.find((item) => item.label === "Edit");
  const items = editMenu?.submenu?.items ?? [];
  return REQUIRED_EDIT_ACCELERATORS.every(([label, accelerator]) => (
    items.some((item) => (
      item.label === label
      && item.accelerator === accelerator
      && item.registerAccelerator === true
      && typeof item.click === "function"
    ))
  ));
}
