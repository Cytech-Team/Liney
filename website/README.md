# Liney public website

Static public pages for Cloudflare Pages. This directory intentionally has no
runtime dependency or build step.

## Cloudflare Pages Git sync

Connect `Cytech-Team/Liney` to Cloudflare Pages and use:

- Production branch: `master`
- Build command: leave empty (or `exit 0` if the dashboard requires one)
- Build output directory: `website`
- Root directory: repository root

Cloudflare Pages will then deploy automatically for pushes to the connected
branch and can create preview deployments for other branches.

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

The repository is currently private, so leave those URLs empty until they are
intended to be visible to public website visitors.

## Local preview

From the repository root:

```sh
python3 -m http.server 4173 --directory website
```

Then open <http://127.0.0.1:4173/>.

## Pages

- `index.html` — landing page
- `download.html` — packages, requirements, and FAQ
- `notice.html` — safety and unofficial-client notice
- `privacy.html` — local-first privacy notice
- `terms.html` — Liney Terms of Use draft
- `license.html` — summary of The Liney License 1.0
- `LICENSE.txt` — canonical license text
- `404.html` — fallback page

The Terms and Privacy pages are project drafts, not legal advice. Review them
for the intended jurisdiction and distribution model before treating them as
binding legal documents.
