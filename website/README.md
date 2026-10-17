# Liney public website

Static public pages hosted on Cloudflare Pages at https://liney.namnarak.in.th.

## Cache-safe deployment

Static assets are cached by Cloudflare for up to 4 hours. After a redesign,
loading a fresh HTML page with a stale `styles.css` or `site.js` could break
the layout and prevent the theme control from appearing. The `build.mjs` script
now emits content-addressed CSS and JavaScript names (e.g.
`styles.<sha256>.css`) and replaces HTML references during deployment.
HTML references always point at exactly the version they were built with.
`app.html` and Web App assets remain unchanged.

Run `bun run test:website` to verify hash references and theme behavior.

## Cloudflare Pages production

Production is the Cloudflare Pages project `liney` (`liney.pages.dev`),
connected to `Cytech-Team/Liney` on branch `master`. Its custom domain is
`liney.namnarak.in.th` (CNAME -> `liney.pages.dev`).

Project Build configuration (configure in Cloudflare Pages settings):
- Root directory: `website`
- Build command: `node build.mjs`
- Build output directory: `dist` (relative to the root directory)
- Production branch: `master`

**Important:** Deploying the sibling Cloudflare Worker named `liney` using
`website/wrangler.jsonc` does *not* update the actual custom domain. This
domain is bound to Cloudflare Pages, not the Worker. Building from `website/`
also avoids trying to install the entire desktop app with a Bun version too old
to parse the repository root lockfile. The Pages build must run
`build.mjs` or Pages will copy raw files from `website/` and the HTML will
continue to reference unversioned CSS/JS. Build output only contains public
artifacts and intentionally excludes project metadata and scripts.

## Configure repository links

Edit `site-config.js` when publishing repository/release links:

```js
window.LINEY_SITE_CONFIG = {
  repositoryUrl: "https://github.com/Cytech-Team/Liney",
  releaseUrl: "https://github.com/Cytech-Team/Liney/releases",
  contactEmail: "namnarak@namnarak.in.th",
  effectiveDate: "2026-09-05",
};
```

The repository is public. Keep the repository and release URL pointed at Cytech-Team/Liney so all buttons resolve to the real project.

## 2026 website redesign

The product website uses a fresh light editorial design with a responsive navigation,
and a true multi-page structure: `index.html` (overview), `features.html`
(feature catalog), `technology.html` (architecture), `roadmap.html`
(development direction), and `download.html` (releases and install).
CSS-only illustrative desktop chat mock (explicitly marked as a concept), bento-style
feature summaries, developer architecture, Linux-first roadmap, and an interactive
installer/download guide. Legal and privacy pages use the same design system.
This intentionally does not change the separately deployed Web App runtime UI.

The shared stylesheet is website/styles.css; all public pages use the same
navigation, footer and System/Light/Dark selector.
It reads a saved preference from localStorage (if available) before stylesheet
parsing, follows OS color preference in System mode, and persists manual choices.
The separate Web App remains unchanged. Theme bootstrapping uses theme-init.js
and the dark design layer is theme.css.

Mobile navigation uses site.js and download metadata uses release.js.
Test pages at desktop/mobile widths and run `bun run test:website` to check
links, anchors, theme persistence, cached asset hashes and built pages.

## Liney Web (device-local compute)

The experimental /app route uses a LOCAL connector and LINEJS Engine on the
visitor's device. It does not create a Home Server public session or invoke
Cloudflare Workers for LINE traffic. Cloudflare Pages supplies only the PWA UI.
Without a working extension and local Engine, the browser cannot log in.

On Linux or Chromebook with a permitted Linux environment:

1. Build or install the corresponding Liney Engine on the same device.
2. Start bash scripts/start-local-web-engine.sh; this uses localhost only.
3. Install the extensions/liney-connector v0.3.0 unpacked in Chrome/Chromium,
   enable the local connection, and provide its unique local token.
4. Open https://liney.namnarak.in.th/app, verify the connector, then QR-login.

In managed/locked Chromebooks without extension or local process permissions,
LINEJS cannot currently run through a plain PWA. Do not claim all
Chromebooks are supported. Real QR and message send/receive must be validated
on a dedicated test account before advertising live Web chat support.
See docs/WEB_APP_MODE.md in the repository.

## Published packages and feature status

The landing page and download guide must describe features present in current source.
Calls (especially incoming/video), Album and Note have components that still require
live verification and must not be described as fully validated. Liney Lite and
Windows/macOS are only ideas under consideration.

release.js reads GitHub's *published* releases/latest API and matches assets by
exact filename, Linux architecture and format. It never invents download URLs for
missing artifacts; if the API is unavailable, users are sent to GitHub Releases.
AUR cannot be promoted before an actual AUR listing exists. GitHub's Flatpak bundle
is not an official listing on Flathub.

For local previews run the build and inspect both x86_64 and aarch64 download states.
Browser-side GitHub API reads do not involve LINE credentials.

## Local preview

From the repository root:

```sh
python3 -m http.server 4173 --directory website
```

Or preview the exact deployment output:

```sh
cd website
bun run build
python3 -m http.server 4173 --directory dist
```

## Pages

- `index.html` — concise landing page linking into detailed pages
- `features.html` — feature catalog with implementation status
- `technology.html` — technical architecture and desktop stack
- `roadmap.html` — current priorities and non-committed future ideas
- `download.html` — packages, requirements, and FAQ
- `notice.html` — safety and unofficial-client notice
- `privacy.html` — local-first privacy notice
- `terms.html` — Liney Terms of Use draft
- `license.html` — MIT License summary
- `LICENSE.txt` — canonical license text
- `404.html` — fallback page

The Terms and Privacy pages are project drafts, not legal advice. Review them
for the intended jurisdiction and distribution model before treating them as
binding legal documents.
