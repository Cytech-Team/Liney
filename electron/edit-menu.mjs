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
        click: (_item, focusedWindow) => runEditAction("cut", focusedWindow),
      },
      {
        label: "Copy",
        accelerator: "CommandOrControl+C",
        registerAccelerator: true,
        click: (_item, focusedWindow) => runEditAction("copy", focusedWindow),
      },
      {
        label: "Paste",
        accelerator: "CommandOrControl+V",
        registerAccelerator: true,
        click: (_item, focusedWindow) => runEditAction("paste", focusedWindow),
      },
      { role: "delete" },
      { type: "separator" },
      {
        label: "Select All",
        accelerator: "CommandOrControl+A",
        registerAccelerator: true,
        click: (_item, focusedWindow) => runEditAction("selectAll", focusedWindow),
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

const editActionCalls = [];

function runEditAction(action, focusedWindow) {
  editActionCalls.push(action);
  const webContents = focusedWindow?.webContents;
  if (!webContents || (typeof webContents.isDestroyed === "function" && webContents.isDestroyed())) return;
  switch (action) {
    case "cut": webContents.cut(); break;
    case "copy": webContents.copy(); break;
    case "paste": webContents.paste(); break;
    case "selectAll": webContents.selectAll(); break;
  }
}

export function resetEditActionCalls() {
  editActionCalls.length = 0;
}

export function getEditActionCalls() {
  return [...editActionCalls];
}

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
