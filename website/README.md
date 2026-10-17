# Liney public website

Static public pages deployed to Cloudflare Workers Static Assets.

## Cloudflare Workers Builds

The Cloudflare Worker `liney` is connected to `Cytech-Team/Liney` and should use:

- Production branch: `master`
- Root directory: `/website`
- Build command: `bun run build`
- Deploy command: `npx wrangler deploy`
- Wrangler config: `website/wrangler.jsonc`

`bun run build` copies only the public site files into `website/dist/`. Wrangler
then publishes `dist/` as static assets, so project metadata such as this README,
`package.json`, and `wrangler.jsonc` are not exposed as website assets.

For automatic builds, Cloudflare Workers Builds also needs a valid build API token.
If Cloudflare reports that the selected token was deleted or rolled, create/select a
new token in Worker Settings > Build > Build Configuration and retry the build.

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
CSS-only illustrative desktop chat mock (explicitly marked as a concept), bento-style
feature summaries, developer architecture, Linux-first roadmap, and an interactive
installer/download guide. Legal and privacy pages use the same design system.
This intentionally does not change the separately deployed Web App runtime UI.

The shared stylesheet is website/styles.css; the page-specific markup is in
index.html and download.html. The theme selector (System / Light / Dark) is shared by all static pages.\nIt reads a saved preference from localStorage (if available) before stylesheet\nparsing, follows OS color preference in System mode, and persists manual choices.\nThe separate Web App remains unchanged. Theme bootstrapping uses theme-init.js\nand the dark design layer is theme.css.\n\nMobile navigation uses site.js and download metadata
uses release.js. Test all pages at desktop/mobile widths, run the website build, and run
`bun run test:theme` for theme persistence and OS-preference behavior.

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

- `index.html` — landing page
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
