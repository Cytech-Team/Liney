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

The production Web App uses the same React UI as desktop, but the browser does not run the full LINEJS Node runtime. Real LINE traffic is handled by a Public Home Runner hosted on the project Home Server.

```text
Browser Web App (static UI)
  ├─ creates an anonymous public runner session
  ├─ stores only the runner session id/token in Liney origin localStorage
  └─ sends RPC/events over HTTPS

Public Home Runner
  ├─ creates one isolated Liney engine process per public session
  ├─ uses a separate LINEY_DATA_DIR per session
  ├─ rate-limits session creation and RPC
  ├─ rejects non-allowlisted engine methods
  ├─ never accepts Home Server file paths from public media uploads
  ├─ deletes session data on close/expiry
  └─ does not use a Cloudflare Worker or Chrome extension in the default path

LINE services
  └─ reached by LINEJS running inside the isolated Home Runner engine
```

## Privacy wording

Use precise language:

- Correct: `Liney Web uses an isolated Public Home Runner session.`
- Correct: `The browser does not need an admin Home Runner token.`
- Correct: `Public Web login uses QR Code and does not expose email/password login.`
- Correct: `Session/E2EE/cache data is temporarily stored on the Home Server inside the user's isolated session directory.`
- Incorrect: `Liney Web has no central server.`
- Incorrect: `The server can never access user data.`

The Home Runner is a real server-side runtime and necessarily processes LINE protocol data. The host administrator has system-level access to the machine, so privacy claims must not imply cryptographic blindness from the server operator.

## Storage model

### Browser

- Stores a random public session id/token for the Home Runner.
- Does not store the user's LINE password in localStorage/sessionStorage.
- Can clear Liney site data to discard the browser-side runner session reference.

### Public Home Runner

- Separate engine process and `LINEY_DATA_DIR` for each public session.
- Temporary SQLite/E2EE/cache/session files may exist while the session is active.
- Session directories are deleted when the public session is explicitly closed or expires.
- Gateway logs method names/status, not request bodies or credentials.
- Public RPC has an allowlist, rate limiting, and blocks server-local file path uploads.

## Production flow

1. `/app` loads the same React UI as the desktop app.
2. The browser creates a public Home Runner session automatically; no admin token is requested.
3. The runner starts an isolated Liney engine with a unique `LINEY_DATA_DIR`.
4. QR login and chat RPC calls are routed to that session's engine.
5. Engine events are polled back to the browser.
6. Closing/expiring the public session stops the engine and removes its session directory.

## Non-goals

- Do not run an open generic proxy.
- Do not store LINE credentials in Cloudflare KV/D1/R2.
- Do not claim the server never processes data if the relay is in the request path.
- Do not hide the unofficial/TOS risk warning.
