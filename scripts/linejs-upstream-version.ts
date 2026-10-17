/** JSR package metadata is the source of truth for installable upstream releases. */
export type JsrPackageMetadata = {
  latest?: string;
  scope?: string;
  name?: string;
  githubRepository?: { owner?: string; name?: string };
  versions?: Record<string, { yanked?: boolean }>;
};

export function parseStableVersion(version: string): [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareStableVersions(a: string, b: string): number {
  const left = parseStableVersion(a);
  const right = parseStableVersion(b);
  if (!left || !right) throw new Error(`Expected stable versions, got ${a} and ${b}`);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

export function latestStableLinejs(metadata: JsrPackageMetadata): string {
  if (metadata.scope !== "evex" || metadata.name !== "linejs" || !metadata.versions) {
    throw new Error("Unexpected JSR package metadata for @evex/linejs");
  }
  if (metadata.githubRepository &&
      (metadata.githubRepository.owner !== "evex-dev" || metadata.githubRepository.name !== "linejs")) {
    throw new Error("LINEJS metadata points to an unexpected GitHub repository");
  }
  const candidates = Object.entries(metadata.versions)
    .filter(([version, info]) => parseStableVersion(version) && !info?.yanked)
    .map(([version]) => version)
    .sort(compareStableVersions);
  const latest = candidates.at(-1);
  if (!latest) throw new Error("JSR has no published non-yanked stable LINEJS version");
  return latest;
}
