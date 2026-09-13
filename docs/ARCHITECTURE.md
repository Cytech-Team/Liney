# Liney 0.2 Architecture

> Manager 1-page: เปิดโฟลเดอร์แล้วรู้ว่าไฟล์ไหนเป็นเจ้าของความรับผิดชอบอะไร

```
Liney (React + Tauri WebView + Bun sidecar)
  ├─ src/                    # React UI; ไม่มี LINEJS โดยตรง
  │   ├─ App.tsx             # auth, navigation, lists, conversation, composer
  │   ├─ App.css             # centralized UI layout and visual tokens
  │   └─ lib/engine.ts       # versioned JSONL RPC client over Tauri sidecar
  ├─ src-tauri/              # desktop shell, native dialogs, notifications, tray
  │   ├─ src/lib.rs          # Tauri commands and native integration
  │   ├─ tauri.conf.json     # WebView, sidecar, window and package targets
  │   └─ capabilities/       # least-privilege Tauri permissions
  ├─ engine/                 # protocol and user-visible data ownership
  │   ├─ protocol/            # versioned JSONL contract
  │   ├─ linejs/              # LineJsAdapter around @evex/linejs
  │   ├─ sync/                # SyncCoordinator (priority/concurrency)
  │   ├─ database.ts          # SQLite source of truth
  │   ├─ media-*.ts           # lazy media cache, worker and format checks
  │   ├─ outbox.ts            # offline-first message queue
  │   └─ main.ts              # sidecar RPC/event entry point
  ├─ scripts/                # reproducible sidecar, dev and bundle helpers
  ├─ packaging/              # desktop metadata and distribution helpers
  └─ website/                # public docs and landing page
```

## กฎสั้น ๆ สำหรับ manager

1. **UI ห้ามเรียก LINEJS** — ต้องผ่าน `src/lib/engine.ts` → engine adapter
2. **SQLite เป็น truth** — เปิดแอพโชว์ cache ก่อน แล้วค่อย refresh network
3. **Sync ตัวเดียว** — `SyncCoordinator` คุมคิว, concurrency, cancellation และ full sync
4. **Push หลัก Poll สำรอง** — polling ต้องลด/หยุดเมื่อ push healthy
5. **Media lazy** — โหลดตาม viewport; ไม่ warm media จำนวนมากตอน startup
6. **Logging ปลอดภัย** — ห้ามเขียน token, password, QR หรือ raw chat/profile payload

## Startup ปกติ (cache-first)

```
open SQLite → render cache → restore auth → connect push → bounded refresh → update UI
```

Full Sync เป็นงาน maintenance แบบ explicit ผ่าน `sync.start` และยกเลิกได้ด้วย
`sync.cancel`; ไม่ทำอัตโนมัติใน normal startup/login.

## คำสั่งหลัก

```sh
bun run dev          # static Tauri WebView; ไม่เปิด localhost/server
bun run dev:web      # optional Vite HMR mode
bun run build        # .deb + AppImage
bun run build:deb    # Debian package only
bun run build:appimage
bun test             # engine and contract tests
bun run lint
```

`app/` GTK รุ่นเก่าไม่ใช่ product path แล้ว; โค้ดใหม่ต้องอยู่ใน WebView/engine
โครงสร้างด้านบน.
