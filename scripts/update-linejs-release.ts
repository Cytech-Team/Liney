import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { compareStableVersions, latestStableLinejs, type JsrPackageMetadata } from "./linejs-upstream-version";

const root = resolve(import.meta.dir, "..");
const packagePath = resolve(root, "package.json");
const lockPath = resolve(root, "bun.lock");
const adapterPath = resolve(root, "engine/linejs/adapter.ts");
const packageName = "@evex/linejs";
const registryUrl = "https://jsr.io/@evex/linejs/meta.json";
const checkOnly = process.argv.includes("--check");

function dependencyVersion(spec: string): string {
  const match = spec.match(/@jsr\/evex__linejs@(?:\^|~)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  if (!match) throw new Error(`Unsupported ${packageName} dependency spec: ${spec}`);
  return match[1];
}

function output(name: string, value: string | boolean) {
  const path = process.env.GITHUB_OUTPUT;
  if (path) writeFileSync(path, `${name}=${String(value)}\n`, { flag: "a" });
}

const response = await fetch(registryUrl, {
  headers: { Accept: "application/json", "User-Agent": "liney-upstream-checker/1.0" },
});
if (!response.ok) throw new Error(`JSR registry API failed: ${response.status} ${response.statusText}`);
const latest = latestStableLinejs(await response.json() as JsrPackageMetadata);

const packageBefore = readFileSync(packagePath, "utf8");
const lockBefore = readFileSync(lockPath, "utf8");
const adapterBefore = readFileSync(adapterPath, "utf8");
const packageJson = JSON.parse(packageBefore) as { dependencies?: Record<string, string> };
const currentSpec = packageJson.dependencies?.[packageName];
if (!currentSpec) throw new Error(`${packageName} is missing from package.json`);
const current = dependencyVersion(currentSpec);

output("current", current);
output("latest", latest);
output("release_url", `https://jsr.io/@evex/linejs@${latest}`);
output("update_available", compareStableVersions(latest, current) > 0);

if (compareStableVersions(latest, current) <= 0) {
  output("updated", false);
  console.log(`LINEJS is current: ${current} (latest JSR stable: ${latest})`);
  process.exit(0);
}

if (checkOnly) {
  output("updated", false);
  console.log(`LINEJS update available: ${current} -> ${latest} (check-only; no files changed)`);
  process.exit(0);
}

packageJson.dependencies![packageName] = `npm:@jsr/evex__linejs@${latest}`;
const adapterAfter = adapterBefore.replace(
  /export const LINEJS_VERSION = "[^"]+";/,
  `export const LINEJS_VERSION = "${latest}";`,
);
if (adapterAfter === adapterBefore) throw new Error("Could not update LINEJS_VERSION in adapter.ts");
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(adapterPath, adapterAfter);

const install = Bun.spawnSync([process.execPath, "install"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

if (install.exitCode !== 0) {
  writeFileSync(packagePath, packageBefore);
  writeFileSync(lockPath, lockBefore);
  writeFileSync(adapterPath, adapterBefore);
  output("updated", false);
  output("published", false);
  console.log(`LINEJS ${latest} is published in JSR metadata but its npm-compatible package was not installable; leaving ${current} pinned.`);
  process.exit(0);
}

output("updated", true);
output("published", true);
output("version", latest);
console.log(`Updated LINEJS ${current} -> ${latest}`);
