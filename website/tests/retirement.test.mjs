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
test("legacy Web App links redirect to the Desktop download page", () => {
  const redirects = fs.readFileSync(path.join(output, "_redirects"), "utf8");
  for (const route of ["/app", "/app.html", "/compatibility.html"]) {
    assert.ok(redirects.includes(route + " /download.html"), route + " must redirect");
  }
});
test("former PWA service worker is a retirement shim, not a cache or LINE client", () => {
  const code = fs.readFileSync(path.join(output, "liney-app-sw.js"), "utf8");
  assert.match(code,/registration\.unregister/);
  assert.match(code,/caches\.delete/);
  assert.doesNotMatch(code,/addAll\(|\/api\/|linejs/);
});
