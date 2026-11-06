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
        click: (_item, focusedWindow) => runEditAction("cut", focusedWindow?.webContents),
      },
      {
        label: "Copy",
        accelerator: "CommandOrControl+C",
        registerAccelerator: true,
        click: (_item, focusedWindow) => runEditAction("copy", focusedWindow?.webContents),
      },
      {
        label: "Paste",
        accelerator: "CommandOrControl+V",
        registerAccelerator: true,
        click: (_item, focusedWindow) => runEditAction("paste", focusedWindow?.webContents),
      },
      { role: "delete" },
      { type: "separator" },
      {
        label: "Select All",
        accelerator: "CommandOrControl+A",
        registerAccelerator: true,
        click: (_item, focusedWindow) => runEditAction("selectAll", focusedWindow?.webContents),
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

function runEditAction(action, webContents) {
  editActionCalls.push(action);
  if (!webContents || (typeof webContents.isDestroyed === "function" && webContents.isDestroyed())) return;
  switch (action) {
    case "cut": webContents.cut(); break;
    case "copy": webContents.copy(); break;
    case "paste": webContents.paste(); break;
    case "selectAll": webContents.selectAll(); break;
  }
}

const EDIT_KEY_ACTIONS = new Map([
  ["KeyA", "selectAll"],
  ["KeyC", "copy"],
  ["KeyX", "cut"],
  ["KeyV", "paste"],
]);

/**
 * Handle the four standard editing chords at Electron's per-window input
 * boundary. Using KeyboardEvent.code keeps the shortcuts independent of the
 * active keyboard layout or IME-produced character while leaving composition
 * and ordinary text input untouched.
 */
export function installNativeEditShortcuts(webContents) {
  const onBeforeInput = (event, input) => {
    if (input.type !== "keyDown" || input.alt || input.shift || (!input.control && !input.meta)) return;
    const action = EDIT_KEY_ACTIONS.get(input.code);
    if (!action) return;
    event.preventDefault();
    runEditAction(action, webContents);
  };
  webContents.on("before-input-event", onBeforeInput);
  return () => webContents.removeListener("before-input-event", onBeforeInput);
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
