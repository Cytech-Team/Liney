import { existsSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";


function resolveNamedLineySidecar(
  name: string,
  explicitEnv: string | undefined,
): string | undefined {
  const candidates: string[] = [];
  const explicit = explicitEnv?.trim();
  if (explicit) candidates.push(explicit);

  const addSiblingCandidates = (executable: string | undefined) => {
    if (!executable) return;
    const directory = dirname(executable);
    const executableName = basename(executable);
    candidates.push(join(directory, name));
    if (executableName.startsWith("liney-engine-")) {
      candidates.push(join(directory, executableName.replace(/^liney-engine-/, name + "-")));
    }
  };

  addSiblingCandidates(process.execPath);
  try {
    addSiblingCandidates(readlinkSync("/proc/" + process.ppid + "/exe"));
  } catch {}

  candidates.push(join(homedir(), ".local", "lib", "liney", name));

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const filename = basename(candidate).toLowerCase();
    if (filename === name || filename.startsWith(name + "-")) return candidate;
  }
  return undefined;
}

export function resolveLineyMediaBinary(): string | undefined {
  const candidates: string[] = [];
  const explicit = process.env.LINEY_MEDIA_BINARY?.trim();
  if (explicit) candidates.push(explicit);

  const addSiblingCandidates = (executable: string | undefined) => {
    if (!executable) return;
    const directory = dirname(executable);
    const executableName = basename(executable);
    candidates.push(join(directory, "liney-media"));
    if (executableName.startsWith("liney-engine-")) {
      candidates.push(join(directory, executableName.replace(/^liney-engine-/, "liney-media-")));
    }
  };

  addSiblingCandidates(process.execPath);
  try {
    addSiblingCandidates(readlinkSync("/proc/" + process.ppid + "/exe"));
  } catch {
    // /proc may be unavailable in containers or non-Linux development shells.
  }

  candidates.push(join(homedir(), ".local", "lib", "liney", "liney-media"));

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const name = basename(candidate).toLowerCase();
    if (name === "liney-media" || name.startsWith("liney-media-")) return candidate;
  }
  return undefined;
}


export function resolveLineyAudioBinary(): string | undefined {
  const candidates: string[] = [];
  const explicit = process.env.LINEY_AUDIO_BINARY?.trim();
  if (explicit) candidates.push(explicit);

  const addSiblingCandidates = (executable: string | undefined) => {
    if (!executable) return;
    const directory = dirname(executable);
    const executableName = basename(executable);
    candidates.push(join(directory, "liney-audio"));
    if (executableName.startsWith("liney-engine-")) {
      candidates.push(join(directory, executableName.replace(/^liney-engine-/, "liney-audio-")));
    }
  };

  addSiblingCandidates(process.execPath);
  try {
    addSiblingCandidates(readlinkSync("/proc/" + process.ppid + "/exe"));
  } catch {}

  candidates.push(join(homedir(), ".local", "lib", "liney", "liney-audio"));

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const name = basename(candidate).toLowerCase();
    if (name === "liney-audio" || name.startsWith("liney-audio-")) return candidate;
  }
  return undefined;
}


export function resolveLineyScreenBinary(): string | undefined {
  const candidates: string[] = [];
  const explicit = process.env.LINEY_SCREEN_BINARY?.trim();
  if (explicit) candidates.push(explicit);

  const addSiblingCandidates = (executable: string | undefined) => {
    if (!executable) return;
    const directory = dirname(executable);
    const executableName = basename(executable);
    candidates.push(join(directory, "liney-screen"));
    if (executableName.startsWith("liney-engine-")) {
      candidates.push(join(directory, executableName.replace(/^liney-engine-/, "liney-screen-")));
    }
  };

  addSiblingCandidates(process.execPath);
  try {
    addSiblingCandidates(readlinkSync("/proc/" + process.ppid + "/exe"));
  } catch {}

  candidates.push(join(homedir(), ".local", "lib", "liney", "liney-screen"));

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const name = basename(candidate).toLowerCase();
    if (name === "liney-screen" || name.startsWith("liney-screen-")) return candidate;
  }
  return undefined;
}


export function resolveLineyScreenWaylandBinary(): string | undefined {
  return resolveNamedLineySidecar("liney-screen-wayland", process.env.LINEY_SCREEN_WAYLAND_BINARY);
}

export function resolveLineyScreenX11Binary(): string | undefined {
  return resolveNamedLineySidecar("liney-screen-x11", process.env.LINEY_SCREEN_X11_BINARY);
}
