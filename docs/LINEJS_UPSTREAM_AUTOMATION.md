# Following LINEJS upstream safely

- **Source of truth:** `https://jsr.io/@evex/linejs/meta.json`.
  The updater chooses the highest published, non-yanked stable semantic version;
  it does not install prerelease packages or a GitHub-only, unpublished tag.
- **Dependency:** exact `npm:@jsr/evex__linejs@VERSION` pin, lockfile, and
  `LINEJS_VERSION` in the adapter are advanced together.
- **GitHub Actions:** every six hours (and manually) the LINEJS update workflow
  checks JSR. When a newer stable version exists, it builds and tests the
  candidate and opens an **unmerged PR** with upstream notes and the review
  checklist. No automatic release, deployment, or merge.
- **Local desktop timer:** every six hours it runs `--check` only. It reports
  results at `~/.local/state/liney/linejs-auto-update.status`, without modifying
  the source, session, application binary, or running LINE client.
- **Opt-in local apply:** `sh scripts/auto-update-linejs-local.sh --apply` is
  available for a developer with a **clean** worktree; it runs the full tests,
  lint, frontend build, and sidecar build before changing installed binaries.
  Manual live login, E2EE, PUSH, media and call verification remains mandatory
  before publishing a stable release.

Liney must retain its LINEJS adapter boundary. Upstream library support does
not automatically make every LINE/LINEJS API a working Linux client feature.
