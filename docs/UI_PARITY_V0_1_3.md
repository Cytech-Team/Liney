# Liney v0.1.3 → v0.2 Native UI parity checklist

**Source of truth:** `src/App.tsx`, `src/App.css`,
`src/liney-desktop-refresh.css` in the stable React/Tauri client.
A native UI is not considered visually migrated merely because it shares
Liney's colors.

## Unauthenticated shell: original must win

Original 0.1.3: `if (usesEngineRuntime && !authenticated)` renders
`auth-gate-shell` and `AuthModal(required=true)`, **not the chat sidebar**.
Includes penguin branding, LINEJS/device eyebrow, Thai heading/copy,
QR / Email-Password tabs, LINE native login QR, PIN, risk warning,
acknowledgement checkbox, action and local credential footnote.

Native v0.2: `app-unified/ui/auth.slint` renders a fullscreen gated
auth shell; only `auth.ready` or a confirmed authenticated capability
may unlock the chat UI. Cache count must not be mistaken for authenticated.

## Authenticated shell: exact original structure

| React source | Native Slint | Gate |
|---|---|---|
| `nav-rail` 70px, logo, chat/friends/openchat/calls, bell/settings | `main.slint` rail | Structural |
| `chat-list-panel` ≈284–358px, LINEY heading, Thai แชต, create button | `main.slint` sidebar | Structural |
| Search with "ค้นหาแชตหรือเพื่อน" | Native `TextInput` | Basic |
| Filters ทั้งหมด / ยังไม่อ่าน / เพิ่มเติม | Native selectors | More-menu still TODO |
| Rows 68px, avatar, preview, unread, badges | Virtualized `ListView` | Avatar images / special badges TODO |
| Conversation title, group/openchat info, call/video/more | Native header | Call/actions TODO |
| Bubbles, sender, timestamps, reactions, media, read states | Native `Bubble` | Text only; reaction/media TODO |
| Composer attachment/photo, emoji/sticker, send text | Native composer | File/sticker UI/backend TODO |
| Settings, dialogs, tray, notifications, call screens | Native migration | TODO |

## Absolute release blockers

Real login, credentials, event subscriptions, message send/read,
media rendering, sticker/Flex, notifications, native system integration,
and screenshot comparisons in system/light/dark/HiDPI with identical test data.
Do not mark parity-complete or replace old Liney until tests pass.

Never ship a user's real chats or credentials in screenshots/fixtures.
