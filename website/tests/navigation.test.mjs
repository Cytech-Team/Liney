import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(import.meta.dirname,"../dist");
const publicPages = [
  "index.html", "features.html", "technology.html", "roadmap.html",
  "download.html", "notice.html", "privacy.html", "terms.html",
  "license.html", "404.html",
];
const mainPages = new Map([
  ["index.html","index.html"], ["features.html","features.html"],
  ["technology.html","technology.html"], ["roadmap.html","roadmap.html"],
  ["download.html","download.html"],
]);
const html = (name) => fs.readFileSync(path.join(dist,name),"utf8");

test("all public pages share navigation, light/dark themes and an H1", () => {
  for (const page of publicPages) {
    const source=html(page);
    assert.match(source,/<header class="site-header">/);
    assert.match(source,/<footer class="site-footer">/);
    assert.match(source,/<main id="main-content"(?:\s|>)/);
    assert.match(source,/<h1(?:\s|>)/);
    assert.match(source,/<script src="theme-init\.[a-f0-9]{12}\.js"><\/script>/);
    assert.match(source,/<link rel="stylesheet" href="theme\.[a-f0-9]{12}\.css">/);
    for (const target of mainPages.keys()) {
      assert.ok(source.includes('href="'+target+'"'),page+" missing navigation to "+target);
    }
    const active = [...source.matchAll(/<a\b[^>]*\baria-current="page"[^>]*>/g)];
    assert.equal(active.length, mainPages.has(page)?1:0,page+": exactly one active page");
    if (mainPages.has(page)) assert.match(active[0][0],new RegExp('href="'+page.replaceAll(".","\\.")+'"'));
  }
});
test("all local pages and anchors resolve", () => {
  for (const page of publicPages) {
    const doc = html(page);
    const identifiers=[...doc.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
    assert.equal(new Set(identifiers).size,identifiers.length,page+" duplicate id");
    for (const item of doc.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const ref=item[1];
      if (/^(?:https?:|mailto:|tel:|data:|javascript:)/.test(ref)) continue;
      const [name,fragment] = ref.split("#",2);
      const target = path.join(dist,(name||page).replace(/^\/+/,""));
      assert.ok(fs.existsSync(target),page+" => "+ref+" does not exist");
      if (fragment && target.endsWith(".html"))
        assert.ok(html(path.basename(target)).includes('id="'+fragment+'"'),page+" => "+ref+" missing fragment");
    }
  }
  for (const detail of ["features.html","technology.html","roadmap.html"])
    assert.ok(html("index.html").includes('href="'+detail+'"'),"Homepage cannot reach "+detail);
});
test("new pages have standalone content, not homepage redirects", () => {
  for (const [name,topic] of [
    ["features.html","feature-catalog"],
    ["technology.html","how-it-works"],
    ["roadmap.html","roadmap-list"],
  ]) {
    assert.match(html(name),new RegExp(topic));
    assert.doesNotMatch(html(name),/http-equiv="refresh"/i);
  }
});
