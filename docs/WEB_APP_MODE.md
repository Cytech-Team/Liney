# Liney Web: Local-first without extensions

Liney Web is static React/PWA assets delivered by Cloudflare Pages. The LINEJS
protocol engine, authenticated RPC, E2EE, SQLite and LINE account credentials
run on the user's OWN machine. No Home Server or Cloudflare Workers execute
the user's LINE session.

## What runs on the device?

Chrome / Chromium / PWA (static web client)
  |
  | HTTPS page -> allowed loopback-network request
  | HTTP http://127.0.0.1:39211/liney-runner
  | Origin verified, explicit bearer token, CORS allowlist
  v
Liney local process (Node launcher + LINEJS native engine)
  |
  +--> LOCAL SQLite, auth credentials and E2EE keys
  +--> LINE services directly

**No Chrome Extension required.** This does still require permission to start
a local process and, on recent Chrome, to allow the webpage to contact
loopback. The webpage cannot bypass ChromeOS Workspace Admin policies.

## Setup (Linux / Linux-enabled ChromeOS)

1. Obtain Liney's matching local engine binary for the device architecture.
2. Start `bash scripts/start-local-web-engine.sh` on THAT user's device.
3. Retrieve its locally generated token with
   `bash scripts/start-local-web-engine.sh --show-token`.
4. Open `https://liney.namnarak.in.th/compatibility.html`. Click the
   Local Engine probe and allow Chrome's loopback-network request.
5. Open `https://liney.namnarak.in.th/app`, paste the token into the Web App
   login UI and click Connect Local Engine.
6. Scan LINE's QR on the phone, then confirm actual chat send/receive on a
   test account before treating the device configuration as supported.

The token is stored in browser `sessionStorage` for that tab, not in any
Cloudflare database or public server. It only authenticates requests to
loopback. Clearing the tab session may require entry again.

The local process binds `127.0.0.1` only, disables public sessions, and accepts
CORS only from the Liney public origin (plus explicitly configured localhost
development origins), with Host header validation and bearer auth.

## Compatibility diagnostics

The static page `/compatibility.html` checks HTTPS, IndexedDB
read/write/delete, OPFS file write/read/delete, Web Crypto, service-worker
availability, storage quota and optional localhost connectivity. It does not
expose secrets or hardware identifiers to a maintainer server; sharing a
redacted report is optional. The local network probe only runs on click.

The website cannot enumerate every Workspace/ChromeOS policy. A denial of
loopback access cannot always be distinguished from an engine not running.

## ChromeOS limitations

ChromeOS that blocks the Linux environment/native helpers cannot run the
existing LINEJS engine. A static PWA alone cannot open unrestricted TCP.
Managed Chromebooks may restrict storage, loopback-network permission, PWA
installation, native apps or ephemeral profiles.

## Invitation codes

Invitation codes including one-use and expiring codes are only a design at
present. Secure redemption would need Cloudflare Worker + D1 or another
authorization service for beta-access metadata, NOT for LINE traffic.
Browser-only code checks are NOT secure download gating.

## Release caveat

The local runner health, bearer auth, CORS and ping have been smoke-tested.
QR login, message send and receive on a real LINE account still require
end-to-end testing. Static PWA compatibility does not certify live chat.
