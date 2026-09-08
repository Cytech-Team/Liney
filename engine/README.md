# engine/ — data + protocol

```
engine/
  protocol/  → versioned JSONL (protocol.ts)
  linejs/    → adapter (linejs-adapter.ts)
  sync/      → SyncCoordinator (sync-coordinator.ts)
  auth/      → secure-storage, call-manager
  media/     → media-cache, media-worker
  outbox/    → outbox
  repository/→ database (SQLite)
```

UI ห้าม import @evex/linejs ตรง — ผ่าน linejs/adapter เท่านั้น
