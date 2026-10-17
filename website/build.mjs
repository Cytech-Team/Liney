import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const files = [
  "404.html", "app.html", "download.html", "index.html", "license.html",
  "LICENSE.txt", "notice.html", "privacy.html", "robots.txt",
  "site-config.js", "site.js", "theme-init.js", "release.js",
  "styles.css", "theme.css", "terms.html", "favicon.svg",
  "icons.svg", "liney-logo.png", "liney-mark.svg",
];
const directories = ["assets", "app-assets", "api"];
const versioned = [
  "site-config.js", "site.js", "theme-init.js", "release.js",
  "styles.css", "theme.css",
];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const filename of files) {
  const from = path.join(root, filename);
  if (!existsSync(from)) throw new Error("Missing public website file: " + filename);
  cpSync(from, path.join(dist, filename));
}
for (const directory of directories) {
  const from = path.join(root, directory);
  if (!existsSync(from)) throw new Error("Missing website asset directory: " + directory);
  cpSync(from, path.join(dist, directory), { recursive: true });
}

// Content-based filenames prevent new HTML from loading stale CSS/JS from browser cache.
const aliases = new Map();
for (const filename of versioned) {
  const bytes = readFileSync(path.join(root, filename));
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const versionedName = base + "." + hash + ext;
  writeFileSync(path.join(dist, versionedName), bytes);
  aliases.set(filename, versionedName);
}
const pageNames = readdirSync(dist).filter((filename) => filename.endsWith(".html") && filename !== "app.html");
for (const filename of pageNames) {
  let html = readFileSync(path.join(dist, filename), "utf8");
  for (const [before, after] of aliases.entries()) {
    const matcher = new RegExp("((?:src|href)=[\"'])" + before.replaceAll(".", "\\.") + "(?=[\"'])", "g");
    html = html.replace(matcher, (_, attr) => attr + after);
  }
  // The separate interactive Web App is intentionally left untouched.
  writeFileSync(path.join(dist, filename), html);
}
for (const filename of ["index.html", "download.html", "notice.html"]) {
  const html = readFileSync(path.join(dist, filename), "utf8");
  for (const css of ["styles.css", "theme.css"]) {
    if (html.includes('href="' + css + '"')) {
      throw new Error("Build retained unversioned stylesheet: " + filename + " -> " + css);
    }
  }
}
console.log("Liney website: content-addressed asset build complete");
for (const [source, artifact] of aliases) console.log("  " + source + " -> " + artifact);
