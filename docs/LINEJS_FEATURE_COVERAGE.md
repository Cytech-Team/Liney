# LINEJS upstream → Liney feature coverage

Baseline: LINEJS **3.5.0** (2026-10-10). Coverage is measured against the actual
Liney Linux worktree, **not** the newest package number. Not every LINEJS protocol
method is an end-user LINE Desktop feature.

## Upstream chronology (from the first published release)

| LINEJS history | Feature family / changes | Liney today |
|---|---|---|
| 0.0.1 onwards (Aug 2024) | Protocol client foundation and Thrift transport | Integrated through LINEJS adapter |
| 1.x | Core Talk, Square/OpenChat, E2EE and session APIs | Integrated in messaging engine, not live revalidated this release |
| 2.x | Media, friend/relation, secure QR login, extended Square/VOOM/Note APIs | Messaging, contacts and QR integrated; VOOM/Note page not implemented |
| 2.8.x | VOOM/Timeline channel token, feed and Notes service | Native VOOM read UI + Note CRUD/reactions/comments UI and RPC implemented; live service unverified |
| 3.0–3.1 | PLANET/Cassini 1:1 audio, group join primitives, Android token work | Liney call engine is experimental; live interoperability must be checked |
| 3.2.x | OpenChat media upload and Note media helpers | OpenChat media exposed via existing media worker; Note media UI pending |
| 3.3.x | Edited message events, E2EE keychain, reliable IDs, retries and transport fixes | Used by Liney; some compatibility handled by custom adapter |
| 3.4.0 | Album/Moa read APIs, channel-token cache and updated Thrift definitions | **Album list/photo list/preview newly wired into Liney (experimental, read-only)** |
| 3.4.1 | Listener resilience and reaction request sequence fixes | Upstream dependency and Liney supervised push logic |
| 3.4.2 | E2EE video DURATION metadata | LINEJS dependency; Liney media path accepts duration metadata |
| 3.5.0 | Opt-in incoming 1:1 audio, group EAS2 audio fixes, push rejection handling | Audio call path experimental; group audio not yet user-validated |

Release sources: https://github.com/evex-dev/linejs/releases
Historical releases: https://github.com/evex-dev/linejs/releases?page=2

## Client surface: what belongs in Liney

| Feature | State | User-facing status |
|---|---|---|
| QR / password login, saved session and Secret Service | Implemented | Needs live regression per LINEJS release |
| Talk / OpenChat, read/unread, reactions, undo send, stickers, emoji | Implemented/partial by operation | Check account/device capability; server behavior varies |
| Offline SQLite, outbox, media caching, reconnection and sync | Liney implementation | Test separately from upstream |
| Letter Sealing (text/media), key import / recovery | Implemented with guards | Verify on test accounts; do not silently regenerate mismatched keys |
| Album/Moa listing, photo lists, on-demand still image preview | **New: read-only client UI and RPC** | Synthetic tests pass; live service unverified |
| VOOM / Timeline feed | Native modal + read RPC | Parses LINEJS `result` payload; live compatibility unverified |
| LINE Notes | Native room modal + list/get/create/update/delete/like/comment RPC | Group-scoped text and JPEG-attachment create implemented; live permission behavior needs separate validation |
| Group management | Native chat modal + rename/invite/leave | Confirmed only by mocked LINEJS calls; server permissions vary |
| Friend management | Native chat modal + rename/favorite/mute | Confirmed only by mocked LINEJS calls |
| Own profile | Native Settings tab: name/status/avatar upload | Uses LINEJS high-level APIs; live upload unverified |
| E2EE failed-message recovery | SQLite pending lookup + retry after QR keychain import | Best-effort retry of locally retained ciphertext, not guaranteed recoverability |
| Outgoing 1:1 calls, incoming audio answer | Experimental | Verify actual PLANET/Opus and audio device behavior |
| Group audio / LiveTalk | Protocol primitives only | No unconditional user capability claim |
| Video Call / Screen Sharing | Experimental Liney native code | Not guaranteed by upstream LINEJS APIs |
| LIFF / premium / account management / payments | Not automatically exposed | LIFF requires app-specific consent and context; payments are not generic desktop chat controls |
| Bulk messaging, automation and account farming | **Not a client feature** | Do not expose as end-user automation |
| Chrome-extension transport | **Excluded from Linux desktop product** | No Chrome dependency |

## Per-release adoption contract

1. Track every stable LINEJS release, not only major releases.
2. Update pinned dependency in a **reviewable branch/PR**, include upstream release notes and file diff.
3. Map upstream APIs to typed Liney adapter methods. Never import LINEJS directly in React/Tauri UI.
4. Advertise only capabilities that Liney actually implements; mark experiments separately from *live validated*.
5. For each new feature: add RPC, UX states, permissions/consent, mock/contract tests, and a test plan using a separate authorized account.
6. Run Bun tests, lint, TypeScript + Vite build, standalone sidecar build, and offline startup contract tests.
7. Do not merge or ship automatically on a green unit-test suite. CALL/E2EE/PUSH require separate integration validation.
8. Keep UI native to the Linux app; never require the LINE Chrome extension.
9. Never commit tokens, QR payloads, raw messages, E2EE key material, captures, or device identities.

**State terminology:** "Implemented" means code exists, not guaranteed live LINE
interoperability. "Experimental" means disabled or labelled until real account
testing is completed. This matrix is a maintained backlog, not a percentage of
upstream code copied into Liney.
