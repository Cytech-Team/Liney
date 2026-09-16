# Liney Connector Extension

Chrome MV3 connector for Liney Web App.

Goal:

- Keep `/app` as the same React UI as the desktop app.
- Avoid Cloudflare Worker or a central Liney relay as the default path.
- Let the user's browser extension perform allowed cross-origin LINE requests.

## Local install for testing

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `extensions/liney-connector`.
5. Open `https://liney.namnarak.in.th/app`.

## Chrome Web Store unlisted release

Zip the extension folder and upload it to the Chrome Web Store Developer Dashboard as **Unlisted**.

```sh
bun run extension:zip
```

The zip is created at `release/Liney-Connector-0.1.0.zip`.

## Current runtime status

Implemented now:

- content-script bridge from `liney.namnarak.in.th/app`
- extension background request handler
- connector capabilities / ping
- cross-origin relay fetch from the extension, not from Cloudflare Worker
- empty safe responses for list/history calls so the desktop UI can boot on web

Pending:

- browser-safe LINEJS QR login flow
- session persistence in extension storage
- chat sync/send mapping through the connector transport
