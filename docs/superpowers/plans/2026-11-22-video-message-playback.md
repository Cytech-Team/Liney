# Video Message Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Play video inside Liney instead of showing a still image or a “วิดีโอ” placeholder.

**Architecture:** Two independent paths. LINE OA Rich videos carry a public MP4 `videoUri` in `MARKUP_JSON`; the renderer can play that URL directly with the cover image as poster. Ordinary chat videos (`contentType = 2`, usually E2EE chunks or an OBS object) are downloaded and decrypted only when the user presses play, cached under the app data dir, and served to the sandboxed renderer through a private `liney-media://` protocol that supports HTTP Range requests.

**Tech Stack:** React 19, TypeScript, Electron 44, Node Worker (liney-engine), Bun tests, SQLite cache metadata.

**Spec:** the user’s screenshot and request in this session (“ไม่ Support Video หรอ” → “ทำให้อวรับ”). Scope agreed verbally: both Rich video and normal chat video, lazy-loaded, no autoplay.

## Global Constraints

- Renderer stays sandboxed (`contextIsolation=true`, `sandbox=true`); never expose Node or raw file paths.
- Media is lazy-loaded. Do not auto-download videos when a chat opens.
- No private chat payloads, tokens, chunks or local paths in logs.
- Only HTTPS URLs may cross from engine to renderer. Reject `http:`, `javascript:`, `data:` for Rich video metadata.
- Video cache files are `0600` in a `0700` directory; protocol tokens are SHA-256 hex only.
- Keep the existing 25 MB outgoing-media limit unchanged in this change.
- All new UI strings need Thai, English and zh-TW translations.

## File Structure

- `engine/rich.ts` — parse Rich video URL/poster/button from `MARKUP_JSON`.
- `src/data/mock.ts` — shared `RichMessageData` video fields; `Message.durationMs`.
- `src/components/RichMessage.tsx` — render `<video controls poster>` for Rich video.
- `engine/media-duration.ts` (new) — parse `contentMetadata.DURATION`.
- `engine/video-cache.ts` (new) — hashed, LRU-trimmed video file cache.
- `engine/main.ts` — include contentType 2 in media source cache; `media.video` RPC; `durationMs` on normalized messages.
- `electron/media-protocol.mjs` (new) — `liney-media://video/<token>` handler with Range support.
- `electron/main.mjs` — register the scheme and handler; use `<stateDir>/video-cache`.
- `electron/csp.mjs` — allow `liney-media:` in `media-src`.
- `src/components/VideoMessage.tsx` (new) — idle / loading / error / ready video card.
- `src/App.tsx` — lazy load on click, per-chat video state, render the card.
- `src/lib/i18n.tsx` — new strings.
- Tests: `engine/rich.test.ts`, `tests/rich-message.test.tsx`, `engine/media-duration.test.ts`,
  `engine/video-cache.test.ts`, `tests/video-message.test.tsx`, `electron/media-protocol.test.ts`,
  `electron/csp.test.ts`.

### Task 1: Rich video metadata

**Files:** `engine/rich.ts`, `src/data/mock.ts`, `engine/rich.test.ts`

**Interfaces:**
- Produces: `RichMessageData.videoUrl?: string`, `videoPosterUrl?: string`,
  `videoButton?: { label: string; link: string }`.
- `parseRichMessage` reads `scenes[initialScene].video` with `videoUri`/`videoUrl`,
  `previewUri`/`previewUrl`, and `button`. Only HTTPS passes.

- [x] Test: MARKUP_JSON with `video.videoUri` returns `videoUrl` and keeps `imageUrl` as the
  cover. A `javascript:` video URI is dropped. A `button` with HTTPS link becomes `videoButton`.
- [x] Implement `parseRichMessage` additions.
- [x] `bun test engine/rich.test.ts`.

### Task 2: Rich video rendering

**Files:** `src/components/RichMessage.tsx`, `src/App.css`, `tests/rich-message.test.tsx`

**Interfaces:**
- Consumes Task 1 fields.
- Produces markup: `<video class="rich-message-video" controls playsInline preload="metadata">`
  with `poster` = `videoPosterUrl ?? imageUrl`, `aria-label` = alt text.
- Renders `videoButton` below the video; `onAction({ type: "uri", uri })` on click.
- On video error, fall back to the still image + actions (never a blank card).

- [x] Test static markup contains `video`, `src`, `poster`, `controls`, button label.
- [x] Implement + CSS (width 100%, max-height 70vh, object-fit contain, black background).
- [x] `bun test tests/rich-message.test.tsx`.

### Task 3: Video cache and duration helpers

**Files:** `engine/video-cache.ts`, `engine/media-duration.ts` + tests

**Interfaces:**
- `LineyVideoCache(root, maxBytes = 1 GiB, maxEntries = 200)`
  - `tokenFor(key: string): string` — sha256 hex.
  - `get(key): Promise<{ path, size } | null>`; `put(key, blob): Promise<{ path, size }>`;
    `remove(key)`, `clear()`. Atomic writes, mode 0600, LRU trim by atime.
  - Rejects empty or > 250 MB blobs.
- `mediaDurationMs(raw): number | undefined` — reads object or JSON-string `contentMetadata`,
  accepts positive `DURATION`/`duration`.

- [x] Tests for put/get/remove/trim and duration parsing.
- [x] Implement; `bun test engine/video-cache.test.ts engine/media-duration.test.ts`.

### Task 4: `media.video` engine RPC

**Files:** `engine/main.ts`, `engine/linejs/adapter.ts` (only if a missing export is found)

**Interfaces:**
- RPC `media.video` params `{ messageId, chatId, kind: "talk"|"openchat", refresh?: boolean }`.
- Result `{ url: string, size: number, durationMs?: number, cached: boolean }`.
- URL is `liney-media://video/<sha256(account:kind:messageId)>`.
- `rememberMessageMedia` accepts contentType 1, 2, 17.
- `fetchMessageVideoBlob`: E2EE `chunks` → `downloadMediaByE2EE`; otherwise full OBS →
  SDK full → HTTPS `DOWNLOAD_URL`. Reject empty and > 250 MB.
- Normalized messages and stored messages expose `durationMs` for contentType 2.
- Errors are Thai and never include raw payloads.

- [x] Implement helpers and RPC beside `media.preview`.
- [x] `bun test engine/*.test.ts` (existing) and engine build.

### Task 5: Private media protocol

**Files:** `electron/media-protocol.mjs` (new), `electron/main.mjs`, `electron/csp.mjs`,
`electron/media-protocol.test.ts`, `electron/csp.test.ts`

**Interfaces:**
- `isVideoToken(value): boolean` — `/^[a-f0-9]{64}$/`.
- `parseByteRange(header, size)` → `{ start, end } | null`, invalid ranges signal 416.
- `handleLineyMediaRequest({ request, folder })` — validates host `video`, token, path
  containment; returns 200/206/416 with `Content-Type: video/mp4`, `Accept-Ranges`,
  `Content-Length`, `Content-Range`, `Cache-Control: private, max-age=31536000, immutable`.
- `main.mjs`: register `liney-media` privileged (standard, secure, fetch, stream) and handle it.
- CSP: `media-src 'self' data: blob: https: liney-media:`.

- [x] Tests for token validation, closed/open ranges, suffix ranges, invalid ranges.
- [x] Implement handler; `bun test electron/media-protocol.test.ts electron/csp.test.ts`.

### Task 6: Video card and lazy loading

**Files:** `src/components/VideoMessage.tsx` (new), `src/App.tsx`,
`src/lib/message-presentation.ts`, `src/lib/i18n.tsx`, `tests/video-message.test.tsx`

**Interfaces:**
- `VideoMessageState = { status: "loading"|"ready"|"error"; url?: string; error?: string }`.
- `VideoMessage({ message, state, onPlay })`:
  - No state → dark card, play icon, duration badge, label “วิดีโอ”.
  - `loading` → spinner + “กำลังโหลดวิดีโอ…”.
  - `error` → retry button + Thai error.
  - `ready` → `<video controls autoPlay playsInline preload="metadata" src={url}>`.
- App state key `${chatId}:${messageId}`; `loadVideo` requests `media.video` once with a 180 s timeout.
- contentType 2 no longer renders the text bubble or the generic media fallback.
- Preview text stays “วิดีโอ”.

- [x] Tests: static markup for idle and ready; App type-check.
- [x] Implement, add i18n keys.

### Task 7: Verification

- [x] `bun test`
- [x] `npm run lint`
- [x] `npm run electron:engine`
- [x] `npm run electron:web`
- [x] `git diff --check`

## Review Focus

- A video larger than the cache entry limit must fail with a clear message, not a blank player.
- An expired LINE media object must keep the card usable and show a retry.
- A malicious Rich `MARKUP_JSON` must never inject a non-HTTPS URL or a path into the protocol.
- Seeking in a cached video must not require re-downloading it.
- A second click while loading must not start a duplicate download.
