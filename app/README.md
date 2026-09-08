# app/ — GTK UI

Target per AGENTS.md:32

```
app/
  application/  → window, tray, lifecycle
  state/        → auth, connection, navigation, selection, sync, preferences
  repository/   → EngineBridge JSONL
  models/       → Chat, Message (serde)
  ui/           → ListView chat/message, composer, dialogs
  theme/        → System/Light/Dark + #06c755
  bridge/       → protocol
```

ตอนนี้: native-gtk/src/* คือ app/ จริง (theme.rs → app/theme/mod.rs แล้ว)
ค่อยๆ ย้าย main.rs 2300 บรรทัด → state/* + ui/* ทีละไฟล์ ไม่ให้ build พัง
