# Liney Web: Device-First (No Hosted LINE Engine)

## Non-negotiable default

Liney Web must never auto-create a session on Cytech's Home Server or on
Cloudflare Workers. Cloudflare Pages distributes static UI/PWA assets only.
All LINEJS processing, LINE authentication, E2EE keys, chat history, session
storage and outgoing LINE requests run on the user's OWN machine.

## Tested architecture for devices that permit a local helper

Browser / PWA (served as static assets by Cloudflare Pages)
  |
  | Local Chrome extension content bridge
  v
Liney Connector (Chrome extension; validates page origin)
  |
  | Authenticated localhost HTTP over 127.0.0.1, never the public internet
  v
Liney local engine process (Bun-compiled LINEJS / SQLite / E2EE)
  |
  v
LINE services directly

On Linux and ChromeOS with Crostini enabled:
- Run bash scripts/start-local-web-engine.sh from the repo, or package
  the bundled local sidecar + launcher for supported architectures.
- Extension settings accept ONLY http://127.0.0.1, localhost or IPv6 loopback.
- Local runner binds 127.0.0.1, rejects public sessions, requires a unique
  strong private token, and disables wildcard CORS responses.
- Credentials, message DB, E2EE keys and data remain in
  ~/.local/share/liney-web; local runner token at
  ~/.config/liney-web/runner.token (0600 permissions).
- Desktop Tauri mode continues using its bundled on-device engine.

## Chromebook / browser limitations

A standard PWA CAN render UI, cache assets for offline access and store app
data in IndexedDB/OPFS, but CANNOT transparently run the existing Node/Bun
LINEJS engine, bypass CORS or use raw TCP/UDP. Installing a Chrome extension
does not by itself port LINEJS from Node/Bun to browser runtime.

- Admin-locked Chromebook that blocks both extensions and Linux development
  environment: full LINE Web chat is not supported by this architecture.
- Admin-approved Chrome extension + Linux helper: technically feasible when
  the device's actual policies and localhost forwarding permit it.
- Enterprise Isolated Web Apps (IWA) with Direct Sockets may eventually
  support fully device-side connections without a helper, but this requires
  a separate engine port and admin-approved IWA installation.
- Closing the PWA does not guarantee notifications; service workers are
  suspended by browsers. Full background chat requires an allowed native
  or other device-local long-running component.

## Public web release gate

1. Confirm local engine ping / capabilities through localhost with token.
2. Install the connector and verify the QR flow on a non-production test
   LINE account.
3. Confirm fetch chat list, text send, text receive and session recovery on
   actual supported Chromium/Linux and managed Chromebook configurations.
4. Check no outgoing network requests to maintainer-owned runner endpoints.
5. Only then describe the Web App as live-supported. Static app shell being
   deployed does not prove real chat works.

No cloud LINE storage, no remote fallback, no public proxy, no central LINE
credentials. Chrome/Workspace Admin can still delete or restrict local data.
