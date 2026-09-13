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

The repository is currently private, so leave those URLs empty until they are
intended to be visible to public website visitors.

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
- `license.html` — summary of The Liney License 1.0
- `LICENSE.txt` — canonical license text
- `404.html` — fallback page

The Terms and Privacy pages are project drafts, not legal advice. Review them
for the intended jurisdiction and distribution model before treating them as
binding legal documents.
