# Liney public website

Static public pages for GitHub Pages. This directory intentionally has no
runtime dependency or build step: the GitHub Pages workflow publishes it as
the site root.

## Configure the repository links

Edit `site-config.js` when using a custom domain or a non-standard Pages URL:

```js
window.LINEY_SITE_CONFIG = {
  repositoryUrl: "https://github.com/OWNER/REPOSITORY",
  releaseUrl: "https://github.com/OWNER/REPOSITORY/releases",
  contactEmail: "namnarak@namnarak.in.th",
  effectiveDate: "2026-09-05",
};
```

For a normal `OWNER.github.io/REPOSITORY` Pages site, `site.js` derives the
repository and Releases URL automatically. Before publishing, replace the
placeholder only if the inferred URL is not correct.

## Local preview

From the repository root:

```sh
python3 -m http.server 4173 --directory website
```

Then open <http://127.0.0.1:4173/>. The download and GitHub buttons remain
disabled locally until `repositoryUrl` is configured; this prevents the site
from inventing a repository URL.

## Pages

- `index.html` — landing page
- `download.html` — packages, requirements, and FAQ
- `notice.html` — safety and unofficial-client notice
- `privacy.html` — local-first privacy notice
- `terms.html` — Liney Terms of Use draft
- `license.html` — summary of The Liney License 1.0
- `LICENSE.txt` — canonical license text copied from the repository root at deploy time
- `404.html` — GitHub Pages fallback page

The Terms and Privacy pages are project drafts, not legal advice. Review them
for the intended jurisdiction and distribution model before treating them as
binding legal documents.
