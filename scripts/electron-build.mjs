import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * electron-builder reads `${version}` and `${arch}` from the argument array.
 * They must never pass through a shell, which would expand them to empty.
 */
export function buildArgs(channel) {
  const args = ["--linux", "AppImage", "deb", "rpm", "--publish", "never"];
  if (channel === "stable") {
    args.push(
      "--config.appId=dev.cytechteam.liney",
      "--config.extraMetadata.lineyChannel=stable",
      "--config.extraMetadata.desktopName=dev.cytechteam.liney",
      "--config.appImage.artifactName=Liney-${version}-${arch}.AppImage",
      "--config.deb.artifactName=Liney-${version}-${arch}.deb",
      "--config.rpm.artifactName=Liney-${version}-${arch}.rpm",
      "--config.linux.desktop.entry.StartupWMClass=dev.cytechteam.liney",
    );
  } else {
    args.push("--config.extraMetadata.lineyChannel=preview");
  }
  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function main() {
  const channel = process.argv[2] === "stable" ? "stable" : "preview";
  console.log(`Building Liney ${channel} packages`);
  run("npm", ["run", "electron:engine"]);
  run("npm", ["run", "electron:web"]);
  run("npm", ["run", "electron:helpers"]);
  run(join(root, "node_modules", ".bin", "electron-builder"), buildArgs(channel));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
