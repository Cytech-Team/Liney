import { describe, expect, test } from "bun:test";
import { buildArgs } from "./electron-build.mjs";

describe("electron build arguments", () => {
  test("keeps preview identity and artifact names by default", () => {
    const args = buildArgs("preview");

    expect(args).toContain("--config.extraMetadata.lineyChannel=preview");
    expect(args.join(" ")).not.toContain("dev.cytechteam.liney ");
    expect(args.join(" ")).not.toContain("Liney-${version}-${arch}.AppImage");
  });

  test("switches identity, channel and artifact names for stable", () => {
    const args = buildArgs("stable");

    expect(args).toContain("--config.appId=dev.cytechteam.liney");
    expect(args).toContain("--config.extraMetadata.lineyChannel=stable");
    expect(args).toContain("--config.appImage.artifactName=Liney-${version}-${arch}.AppImage");
    expect(args).toContain("--config.deb.artifactName=Liney-${version}-${arch}.deb");
    expect(args).toContain("--config.rpm.artifactName=Liney-${version}-${arch}.rpm");
    expect(args).toContain("--config.linux.desktop.entry.StartupWMClass=dev.cytechteam.liney");
  });

  test("passes ${version} literally so the shell cannot expand it", () => {
    for (const arg of buildArgs("stable")) {
      expect(arg).not.toContain("Liney-Electron-Preview");
    }
  });
});
