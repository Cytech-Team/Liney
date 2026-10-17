# Liney Local Connector

Liney Web's browser UI is static. LINEJS needs a local Liney Engine process
because browsers cannot run the existing Bun/Node protocol engine directly.
The extension talks to 127.0.0.1 on the user's device, not to Home Server,
Cloudflare Workers, or a maintainer-owned relay.

## Linux / ChromeOS with Linux development environment enabled

1. Download or build Liney's local engine binary for your architecture.
2. Run bash scripts/start-local-web-engine.sh from the Liney repo.
3. Read the token from ~/.config/liney-web/runner.token.
4. In Chromium, open chrome://extensions, enable developer mode and load
   extensions/liney-connector as unpacked (if policy allows).
5. Paste the token into its popup, enable Local Engine, save, and check it.
6. Open https://liney.namnarak.in.th/app and scan LINE QR.

Do not publish the token or paste it into website URLs. All LINE credential
and chat data stays on the user's machine. The site is delivered by
Cloudflare Pages as static assets; no Cloudflare Workers handle LINE traffic.

A locked Chromebook that forbids installing extensions and Linux helpers
cannot currently use this full Liney protocol engine. Plain PWA cannot
access needed Node/Bun APIs or arbitrary LINE cross-origin endpoints.
Remote runner URLs from earlier releases are rejected, not silently reused.
