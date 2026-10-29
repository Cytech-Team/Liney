// Legacy Tauri import kept only for type compatibility. Electron takes the
// native-worker branch in src/lib/engine.ts; this method must never run.
export class Command {
  static sidecar():never { throw new Error("Tauri sidecars are disabled in Electron"); }
}
