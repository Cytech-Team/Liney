# Following LINEJS upstream safely

- **Source of truth:** `https://jsr.io/@evex/linejs/meta.json`.
  The updater chooses the highest published, non-yanked stable semantic version;
  it does not install prerelease packages or a GitHub-only, unpublished tag.
- **Dependency:** exact `npm:@jsr/evex__linejs@VERSION` pin, lockfile, and
  `LINEJS_VERSION` in the adapter are advanced together.
- **GitHub Actions:** every six hours (and manually) the LINEJS update workflow
  checks JSR. When a newer stable version exists, it builds and tests the
  candidate and opens an **unmerged PR** with upstream notes and the review
  checklist.
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

## Release channels

`electron/runtime-paths.mjs` resolves one channel per process. Channels never
share a data directory, a Wallet item, or an encrypted fallback file: two
processes rotating the same refresh token is what silently logs one of them out.

| Build | Channel | Data directory | Wallet namespace |
| --- | --- | --- | --- |
| unpackaged (`electron .`) | `dev` | `~/.local/share/liney-electron-dev` | `liney:dev:*` |
| packaged preview | `preview` | `~/.local/share/liney-electron-preview` | legacy item names |
| packaged stable | `stable` | `~/.local/share/liney` | `liney:stable:*` |

The packaged channel comes from `lineyChannel` in the app manifest, written by
`electron-builder` (`build.extraMetadata.lineyChannel`). A user does not need to
set `LINEY_ELECTRON_STABLE`; the environment flag remains as a debug override.

Both preview and stable take a `requestSingleInstanceLock()` scoped to their
own `userData` directory, so a second copy of the same channel focuses the first
instead of rotating the same session.

## Release gate

A tag (`v*`) or a manual dispatch runs `.github/workflows/release.yml`:

1. `verify` resolves the channel and runs `npm run verify:release`
   (website content build, tests, lint, engine bundle, React production build,
   whitespace check). Publish jobs `needs: verify`.
2. `release-linux` builds through `scripts/electron-build.mjs <channel>`.
   Stable uses `dev.cytechteam.liney` and `Liney-<version>-<arch>` artifacts;
   preview keeps the `Liney-Electron-Preview-*` identity.
3. `flatpak` is preview-only until a stable Flathub app id and branch exist.
4. `publish-release` marks a tag as a prerelease unless it matches
   `vMAJOR.MINOR.PATCH` (no suffix).

`Liney-Electron-Preview-*` releases stay prereleases so stable clients ignore
them; stable clients only see `vX.Y.Z` releases.

## Stable auto-update policy (not enabled yet)

Target policy, in order of risk:

- **Patch:** may be auto-released after the full gate plus a canary run against
  a real LINE account.
- **Minor:** open a PR and wait for an adapter review; never auto-merge.
- **Major:** open an issue only.

The canary is the blocker. It must run on a self-hosted runner with a persistent
data directory, `concurrency: 1`, and a dedicated LINE account. GitHub-hosted
runners change IP on every run, which can trigger LINE risk control and looks
exactly like a Liney logout bug. Until that runner exists, the automated
workflow keeps opening PRs and no release is tagged automatically.

## Diagnosing a logout report

Every engine writes a redacted journal at
`<data dir>/auth-diagnostics.jsonl` (rotated at 256 KiB). It records storage
probe results, credential source, restore/ready/rotation/session-end events and
LINE error codes. It never records tokens, passwords, MIDs, emails or message
content. Ask for that file, not a screenshot of the console.
