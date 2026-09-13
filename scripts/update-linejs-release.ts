import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packagePath = resolve(root, "package.json");
const lockPath = resolve(root, "bun.lock");
const adapterPath = resolve(root, "engine/linejs/adapter.ts");
const packageName = "@evex/linejs";
const upstream = "evex-dev/linejs";

function coreVersion(value: string): [number, number, number] {
  const match = value.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Unsupported LINEJS version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: string, b: string): number {
  const left = coreVersion(a);
  const right = coreVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function dependencyVersion(spec: string): string {
  const match = spec.match(/@jsr\/evex__linejs@(?:\^|~)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  if (!match) throw new Error(`Unsupported ${packageName} dependency spec: ${spec}`);
  return match[1];
}

function output(name: string, value: string | boolean) {
  const path = process.env.GITHUB_OUTPUT;
  if (path) writeFileSync(path, `${name}=${String(value)}\n`, { flag: "a" });
}

const headers: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "liney-linejs-updater",
  "X-GitHub-Api-Version": "2022-11-28",
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const response = await fetch(`https://api.github.com/repos/${upstream}/releases/latest`, { headers });
if (!response.ok) throw new Error(`GitHub releases API failed: ${response.status} ${response.statusText}`);
const release = await response.json() as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
if (!release.tag_name || release.draft || release.prerelease) throw new Error("GitHub did not return a stable LINEJS release");

const latest = release.tag_name.replace(/^v/, "");
coreVersion(latest);

const packageBefore = readFileSync(packagePath, "utf8");
const lockBefore = readFileSync(lockPath, "utf8");
const adapterBefore = readFileSync(adapterPath, "utf8");
const packageJson = JSON.parse(packageBefore) as { dependencies?: Record<string, string> };
const currentSpec = packageJson.dependencies?.[packageName];
if (!currentSpec) throw new Error(`${packageName} is missing from package.json`);
const current = dependencyVersion(currentSpec);

output("current", current);
output("latest", latest);
output("release_url", release.html_url ?? `https://github.com/${upstream}/releases/tag/${release.tag_name}`);

if (compare(latest, current) <= 0) {
  output("updated", false);
  console.log(`LINEJS is current: ${current} (latest stable: ${latest})`);
  process.exit(0);
}

packageJson.dependencies![packageName] = `npm:@jsr/evex__linejs@${latest}`;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const adapterAfter = adapterBefore.replace(
  /export const LINEJS_VERSION = "[^"]+";/,
  `export const LINEJS_VERSION = "${latest}";`,
);
if (adapterAfter === adapterBefore) throw new Error("Could not update LINEJS_VERSION in adapter.ts");
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
  console.log(`LINEJS ${latest} exists on GitHub but is not installable from JSR yet; leaving ${current} pinned.`);
  process.exit(0);
}

output("updated", true);
output("published", true);
output("version", latest);
console.log(`Updated LINEJS ${current} -> ${latest}`);
