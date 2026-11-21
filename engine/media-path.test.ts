import { describe, expect, test } from "bun:test";
import { isOwnedPath } from "./media-path";

describe("owned media temp paths", () => {
  const root = "/home/liney/.local/share/liney/media-upload-tmp";

  test("accepts a file inside the owned directory", () => {
    expect(isOwnedPath(root, `${root}/abc.upload`)).toBe(true);
    expect(isOwnedPath(root, `${root}/nested/abc.upload`)).toBe(true);
  });

  test("rejects sibling directories that share the prefix", () => {
    expect(isOwnedPath(root, `${root}-evil/abc.upload`)).toBe(false);
    expect(isOwnedPath(root, `${root}evil/abc.upload`)).toBe(false);
  });

  test("rejects traversal and the directory itself", () => {
    expect(isOwnedPath(root, `${root}/../secret`)).toBe(false);
    expect(isOwnedPath(root, root)).toBe(false);
    expect(isOwnedPath(root, "/etc/passwd")).toBe(false);
    expect(isOwnedPath(root, "")).toBe(false);
  });
});
