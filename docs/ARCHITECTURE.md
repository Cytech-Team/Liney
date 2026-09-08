# Liney 0.2 Architecture

> Manager 1-page: ดูโฟลเดอร์แล้วรู้ว่าไฟล์ไหนทำอะไร

```
Liney (GTK4 + Bun)
  ├─ app/                 # หน้าจอ GTK4 ล้วน ห้าม import LINEJS ตรง
  │   ├─ application/     # เริ่มแอพ, ตั้งค่า window, tray
  │   ├─ state/           # auth, connection, navigation, selection, sync, preferences (กลาง)
  │   ├─ repository/      # คุย engine ผ่าน JSONL (bridge)
  │   ├─ models/          # Chat, Message, Profile
  │   ├─ ui/              # ListView แชต/ข้อความ, composer, dialogs
  │   ├─ theme/           # System/Light/Dark + Liney Green accent เดียว
  │   └─ bridge/          # EngineBridge (spawn sidecar)
  ├─ engine/              # ข้อมูล + โปรโตคอล ห้ามให้ UI เรียก LINEJS ตรง
  │   ├─ protocol/        # versioned JSONL contract
  │   ├─ linejs/          # LineJsAdapter ครอบ @evex/linejs
  │   ├─ auth/            # QR, password, restore, keyring
  │   ├─ sync/            # SyncCoordinator (priority/concurrency)
  │   ├─ events/          # push (primary) + poll fallback
  │   ├─ media/           # lazy viewport, disk+memory cache
  │   ├─ outbox/          # offline-first queue
  │   └─ repository/      # SQLite source of truth
  ├─ packaging/           # Flatpak/AppImage/DEB/RPM/Arch/tar
  └─ website/             # docs + landing
```

## กฎสั้นๆ สำหรับ manager

1. **UI ห้ามเรียก LINEJS** — ต้องผ่าน `app/bridge` → `engine/linejs`
2. **SQLite เป็น truth** — เปิดแอพโชว์ cache ก่อน, network เติมทีหลัง
3. **Sync ตัวเดียว** — `SyncCoordinator` คุมคิว, ห้าม sync ซ้อน
4. **Push หลัก Poll สำรอง** — poll หยุดเมื่อ push ดี
5. **Theme ที่เดียว** — สี/ฟอนต์/มุม มาจาก `app/theme`

## Startup ปกติ (cache-first)

```
open SQLite → render cache → restore auth → connect push → delta sync → update UI
```

Full Sync เป็นปุ่ม manual ใน Settings เท่านั้น

## คำสั่ง manager

```
make help     # ดูทั้งหมด
make check    # cargo check + bun test
make run      # รันแอพ
make package  # สร้าง tar
```

Legacy `src/` + `src-tauri/` เก็บไว้ดูอย่างเดียว ไม่ได้ build
