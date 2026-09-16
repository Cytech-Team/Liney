# Liney Web App Mode

Liney Web is the Chromebook / locked-device path for users who cannot install a native Linux app.
The goal is to keep the same privacy posture as desktop as much as the browser allows.

## Product requirement

- The user can open `liney.namnarak.in.th` and use Liney from a normal browser.
- No LINE password is stored by Liney Web.
- No central Liney message database is created.
- Human operators should not be able to browse user chats, tokens, or media.
- The runtime may process requests transiently so the app can function.
- The client label must make the login source clear, for example:
  - `Liney-CachyOS`
  - `Liney-Ubuntu`
  - `Liney-Linux`
  - `Liney-Website`
  - `Liney-Chromebook`

## Architecture decision

A static Cloudflare Pages site alone is not enough for real LINE chat in a browser.
Browsers cannot safely talk to LINE's desktop endpoints directly because of CORS, headers,
long-polling, push, and credential handling. For Chromebook support we need a web runtime:

```text
Browser PWA
  ├─ UI, local vault, IndexedDB cache, WebCrypto keys
  ├─ holds user passphrase/PIN locally only
  └─ calls a stateless relay only when LINE network access is needed

Cloudflare Worker relay
  ├─ no message database
  ├─ no token/session persistence
  ├─ no request/response body logging
  ├─ allowlisted LINE hosts only
  └─ transiently forwards protocol requests

LINE services
  └─ official LINE backend used by the user's session
```

## Privacy wording

Use precise language:

- Correct: `Liney does not store your LINE password on our servers.`
- Correct: `The Web relay is designed as a transient processor, not a message database.`
- Correct: `Human operators cannot browse a Liney inbox database because the project does not create one.`
- Incorrect: `Liney servers can never see any data.`

The relay may process auth headers and response payloads in memory to forward LINE requests.
For E2EE messages, decryption should happen in the browser/runtime wherever possible. For
non-E2EE metadata or plaintext protocol responses, the relay path must be treated as transient
processing and documented honestly.

## Storage model

### Browser

- IndexedDB for cache.
- WebCrypto-protected local vault for refresh/session material when web login supports restore.
- Password fields are never written to localStorage/sessionStorage.
- User can clear all local web data from settings.

### Server / Worker

- No KV/D1/R2 user message store by default.
- No credential persistence by default.
- Logs must redact authorization-like headers and message bodies.
- CORS allowlist: production domain, Pages preview domain, local dev.
- Host allowlist: LINE endpoints only.

## Implementation phases

### Phase 1 — Web entry and policy

- `/app` explains Web App mode for Chromebook users.
- Privacy notice includes web runtime wording.
- Desktop/native continues to be the stable path.

### Phase 2 — Browser vault

- Add a browser engine adapter separate from Tauri `lineyEngine`.
- Add IndexedDB cache and WebCrypto vault.
- Add clear-data controls.

### Phase 3 — Stateless relay

- Add Cloudflare Worker relay with CORS + LINE host allowlist.
- Strip logs and reject unknown hosts/methods.
- Add rate limiting / abuse guard before production exposure.

### Phase 4 — Web login

- QR login first.
- Client label: `Liney-Website` or `Liney-Chromebook`.
- Email/password only if it can follow the same no-password-storage rule.

### Phase 5 — Web chat MVP

- Chat list.
- Message history.
- Send text.
- Read receipts.
- Local cache.
- Clear data.

### Phase 6 — Media / push / offline

- Media preview and upload.
- E2EE media where browser crypto is reliable.
- Push/poll fallback.
- PWA installability for Chromebook.

## Non-goals

- Do not run an open generic proxy.
- Do not store LINE credentials in Cloudflare KV/D1/R2.
- Do not claim the server never processes data if the relay is in the request path.
- Do not hide the unofficial/TOS risk warning.
