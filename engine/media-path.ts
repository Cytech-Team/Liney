import { resolve, sep } from "node:path";

/**
 * A prefix check without a separator lets `/tmp/upload-tmp-evil` pass for
 * `/tmp/upload-tmp`. Resolve both paths and require the directory boundary.
 */
export function isOwnedPath(root: string, candidate: string): boolean {
  if (!candidate) return false;
  const base = resolve(root);
  const target = resolve(candidate);
  return target !== base && target.startsWith(base + sep);
}
