import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const publicPages = ["index.html", "features.html", "technology.html", "roadmap.html", "download.html", "notice.html", "privacy.html", "terms.html", "license.html", "404.html"];
const sourceAssets = ["site-config.js", "site.js", "theme-init.js", "release.js", "styles.css", "theme.css"];

test("all public HTML pages reference identical hash-versioned assets", () => {
  const mapped = new Map();
  for (const name of sourceAssets) {
    const content = fs.readFileSync(path.join(root, name));
    const ext = path.extname(name);
    const expected = path.basename(name, ext) + "." +
      createHash("sha256").update(content).digest("hex").slice(0, 12) + ext;
    assert.deepEqual(fs.readFileSync(path.join(dist, expected)), content);
    mapped.set(name, expected);
  }
  for (const name of publicPages) {
    const html = fs.readFileSync(path.join(dist, name), "utf8");
    for (const original of sourceAssets) {
      assert.doesNotMatch(html, new RegExp('(?:src|href)="' + original.replaceAll(".", "\\.") + '"'), name + " still uses an unversioned " + original);
      const source = fs.readFileSync(path.join(root, name), "utf8");
      if (source.includes('"' + original + '"')) {
        assert.ok(html.includes('"' + mapped.get(original) + '"'), name + " is missing " + mapped.get(original));
      }
    }
    assert.ok(html.indexOf(mapped.get("theme-init.js")) < html.indexOf(mapped.get("styles.css")), "theme bootstrap must run before stylesheet is evaluated");
  }
});
test("web app is not rewritten", () => {
  assert.deepEqual(fs.readFileSync(path.join(dist, "app.html")), fs.readFileSync(path.join(root, "app.html")));
});
test("identical content generates deterministic hashes; changed content generates different hashes", () => {
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const bytes = fs.readFileSync(path.join(root, "styles.css"));
  assert.equal(digest(bytes),digest(Buffer.from(bytes)));
  assert.notEqual(digest(bytes),digest(Buffer.concat([bytes,Buffer.from("/* next version */")])));
});
