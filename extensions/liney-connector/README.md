# Liney Connector

Chrome extension bridge for `https://liney.namnarak.in.th/app`.

Default transport:

```text
Liney Web App -> Liney Connector extension -> Liney Home Runner -> local Liney JSONL engine -> LINE
```

Default runner URL:

```text
https://cdn.cytechteam.site/liney-runner
```

The connector stores only its runner URL/token in `chrome.storage.local`. It does not include a hard-coded runner token and does not use Cloudflare Worker relay by default.

## Dev install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load unpacked: `extensions/liney-connector`.
4. Open the extension popup, set the Home Runner token, then open Liney Web App.

## Package

```sh
bun run extension:zip
```
