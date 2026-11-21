import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist");

test("public site has no browser LINE login or cloud API", () => {
  for (const name of ["app.html", "compatibility.html", "liney-manifest.webmanifest", "app-assets", "api"]) {
    assert.equal(fs.existsSync(path.join(output, name)), false, name + " should not be shipped");
  }
  for (const name of ["index.html", "download.html", "features.html", "roadmap.html", "privacy.html"]) {
    const content = fs.readFileSync(path.join(output, name), "utf8");
    assert.doesNotMatch(content, /href="app\.html"|data-web-app-link|Web App<\/a>/, name);
  }
});
test("legacy Web App links redirect to the clean Desktop download URL", () => {
  const redirects = fs.readFileSync(path.join(output, "_redirects"), "utf8");
  for (const route of ["/app", "/app/", "/app.html", "/web", "/compatibility", "/compatibility.html"]) {
    assert.ok(redirects.includes(route + " /download 302"), route + " must redirect to /download");
  }
  const redirectLines = redirects.split("\n").map((line) => line.trim());
  assert.ok(redirectLines.includes("/download/ /download 301"), "trailing slash should normalize to /download");
  assert.ok(!redirectLines.includes("/download /download.html 200"));
  assert.ok(!redirectLines.includes("/download/ /download.html 200"),
    "do not rewrite /download to download.html: Pages clean URLs would redirect it back");
});
test("former PWA service worker is a retirement shim, not a cache or LINE client", () => {
  const code = fs.readFileSync(path.join(output, "liney-app-sw.js"), "utf8");
  assert.match(code,/registration\.unregister/);
  assert.match(code,/caches\.delete/);
  assert.doesNotMatch(code,/addAll\(|\/api\/|linejs/);
});
