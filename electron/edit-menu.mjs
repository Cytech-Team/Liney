/**
 * Keep Chromium's native text-edit actions registered even though Liney hides
 * the menu bar. On Linux, suppressing the application menu also removes the
 * default Edit menu and its platform keyboard bindings.
 */
export const EDIT_MENU_TEMPLATE = [
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut", registerAccelerator: true },
      { role: "copy", registerAccelerator: true },
      { role: "paste", registerAccelerator: true },
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll", registerAccelerator: true },
    ],
  },
];

const REQUIRED_EDIT_ROLES = ["cut", "copy", "paste", "selectAll"];

export function installNativeEditMenu(Menu) {
  const menu = Menu.buildFromTemplate(EDIT_MENU_TEMPLATE);
  Menu.setApplicationMenu(menu);
  return menu;
}

export function hasNativeEditShortcuts(menu) {
  const editMenu = menu?.items?.find((item) => item.label === "Edit");
  const items = editMenu?.submenu?.items ?? [];
  return REQUIRED_EDIT_ROLES.every((role) => (
    items.some((item) => item.role === role && item.registerAccelerator === true)
  ));
}
