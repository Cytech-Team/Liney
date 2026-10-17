import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDirectory } from "./secure-storage";
import { normalizeJsonValue, parseJsonValue } from "./serialization";

export type ChatKind = "dm" | "group" | "openchat";
export type ChatHistoryState = "available" | "new" | "unavailable";
export type TalkIdentityAlias = { aliasMid: string; canonicalMid: string };

export type DatabaseChat = {
  id: string;
  kind: ChatKind;
  name: string;
  avatarUrl?: string;
  preview?: string;
  unread?: number;
  lastMessageTime?: number;
  memberCount?: number;
  pinned?: boolean;
  favoriteTimestamp?: number;
  statusMessage?: string;
  isFavorite?: boolean;
  favoriteTime?: number;
  historyState?: ChatHistoryState;
  raw?: unknown;
};

export type DatabaseMessage = {
  id: string;
  chatId: string;
  kind: ChatKind;
  text?: string;
  filename?: string;
  isMine: boolean;
  createdTime: number;
  contentType?: number;
  senderId?: string;
  senderName?: string;
  senderAvatarUrl?: string;
  isOfficialAccount?: boolean;
  postNotification?: unknown;
  reactions?: unknown;
  replyToId?: string;
  unsent?: boolean;
  status?: "sending" | "sent" | "error" | "unknown";
  sendError?: string;
  raw?: unknown;
};

export type DatabaseMessageSource = {
  chatId: string;
  kind: ChatKind;
  contentType: number;
  raw?: unknown;
};

export type OutboxRecord = {
  localId: string;
  chatId: string;
  kind: ChatKind;
  contentType: number;
  text?: string;
  filePath?: string;
  filename?: string;
  mime?: string;
  durationMs?: number;
  contentMetadata?: Record<string, string>;
  fingerprint: string;
  status: "queued" | "sending" | "sent" | "failed" | "unknown";
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  serverId?: string;
  lastError?: string;
  relatedMessageId?: string;
};

export type SyncState = {
  key: string;
  cursor?: string;
  generation: number;
  status: "idle" | "running" | "ready" | "error";
  error?: string;
  updatedAt: number;
};

export type ProtocolEventRecord = {
  eventKey: string;
  source: string;
  opType: string;
  revision?: string;
  createdTime: number;
  param1?: string;
  param2?: string;
  param3?: string;
  raw?: unknown;
  capturedAt?: number;
};

function asJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(normalizeJsonValue(value)); } catch { return null; }
}

function fromJson(value: unknown): unknown {
  return parseJsonValue(value);
}

function fromMessageJson(value: unknown): unknown {
  return parseJsonValue(value, true);
}

export class LineyDatabase {
  readonly path: string;
  private readonly db: Database;

  constructor(path: string) {
    this.path = path;
    ensurePrivateDirectory(dirname(path));
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        mid TEXT,
        display_name TEXT NOT NULL DEFAULT '',
        profile_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chats (
        account_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar_url TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        unread INTEGER NOT NULL DEFAULT 0,
        last_message_time INTEGER NOT NULL DEFAULT 0,
        member_count INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        favorite_timestamp INTEGER NOT NULL DEFAULT 0,
        status_message TEXT NOT NULL DEFAULT '',
        is_favorite INTEGER NOT NULL DEFAULT 0,
        favorite_time INTEGER NOT NULL DEFAULT 0,
        history_state TEXT NOT NULL DEFAULT 'available',
        raw_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS chat_members (
        account_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, chat_id, member_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        account_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        server_id TEXT,
        text TEXT,
        filename TEXT,
        content_type INTEGER NOT NULL DEFAULT 0,
        is_mine INTEGER NOT NULL DEFAULT 0,
        created_time INTEGER NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        sender_avatar_url TEXT,
        is_official_account INTEGER NOT NULL DEFAULT 0,
        post_notification_json TEXT,
        reactions_json TEXT,
        reply_to_id TEXT,
        unsent INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'sent',
        raw_json TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, chat_id, id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_server_id
        ON messages(account_id, chat_id, server_id)
        WHERE server_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS messages_chat_created
        ON messages(account_id, chat_id, created_time, id);
      CREATE INDEX IF NOT EXISTS messages_cursor_lookup
        ON messages(account_id, id, created_time);
      CREATE INDEX IF NOT EXISTS messages_content_created
        ON messages(account_id, content_type, created_time DESC, id DESC);
      CREATE TABLE IF NOT EXISTS outbox (
        account_id TEXT NOT NULL,
        local_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_type INTEGER NOT NULL DEFAULT 0,
        text TEXT,
        file_path TEXT,
        filename TEXT,
        mime TEXT,
        duration_ms INTEGER,
        content_metadata_json TEXT,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        next_attempt_at INTEGER,
        server_id TEXT,
        last_error TEXT,
        related_message_id TEXT,
        PRIMARY KEY (account_id, local_id)
      );
      CREATE INDEX IF NOT EXISTS outbox_due
        ON outbox(account_id, status, next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS sync_state (
        account_id TEXT NOT NULL,
        state_key TEXT NOT NULL,
        cursor TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        error TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, state_key)
      );
      CREATE TABLE IF NOT EXISTS protocol_events (
        account_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        source TEXT NOT NULL,
        op_type TEXT NOT NULL,
        revision TEXT,
        created_time INTEGER NOT NULL DEFAULT 0,
        param1 TEXT,
        param2 TEXT,
        param3 TEXT,
        raw_json TEXT,
        captured_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS protocol_events_captured
        ON protocol_events(account_id, captured_at DESC);
      CREATE TABLE IF NOT EXISTS media_cache (
        account_id TEXT NOT NULL,
        media_key TEXT NOT NULL,
        path TEXT NOT NULL,
        mime TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        accessed_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, media_key)
      );
      CREATE TABLE IF NOT EXISTS link_previews (
        account_id TEXT NOT NULL,
        url TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, url)
      );
      CREATE INDEX IF NOT EXISTS link_previews_accessed
        ON link_previews(account_id, accessed_at DESC);
      CREATE TABLE IF NOT EXISTS hidden_messages (
        account_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        message_id TEXT NOT NULL,
        hidden_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, chat_id, kind, message_id)
      );
      CREATE INDEX IF NOT EXISTS hidden_messages_chat
        ON hidden_messages(account_id, chat_id, kind);
      CREATE TABLE IF NOT EXISTS talk_identity_aliases (
        account_id TEXT NOT NULL,
        alias_mid TEXT NOT NULL,
        canonical_mid TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, alias_mid),
        CHECK(alias_mid <> canonical_mid)
      );
      CREATE INDEX IF NOT EXISTS talk_identity_aliases_canonical
        ON talk_identity_aliases(account_id, canonical_mid);
    `);
    const chatColumns = this.db.query("PRAGMA table_info(chats)").all() as Array<{ name?: string }>;
    if (!chatColumns.some((column) => column.name === "history_state")) {
      this.db.exec("ALTER TABLE chats ADD COLUMN history_state TEXT NOT NULL DEFAULT 'available'");
      // Existing rows with no locally visible message are safest to treat as
      // brand-new until the next Talk metadata refresh can distinguish them
      // from genuinely unavailable old history.
      this.db.exec(`
        UPDATE chats SET history_state = 'new'
        WHERE preview = ''
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.account_id = chats.account_id AND m.chat_id = chats.chat_id
          )
      `);
    }
    const outboxColumns = this.db.query("PRAGMA table_info(outbox)").all() as Array<{ name?: string }>;
    if (!outboxColumns.some((column) => column.name === "duration_ms")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN duration_ms INTEGER");
    }
    if (!outboxColumns.some((column) => column.name === "content_metadata_json")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN content_metadata_json TEXT");
    }
    const messageColumns = this.db.query("PRAGMA table_info(messages)").all() as Array<{ name?: string }>;
    if (!messageColumns.some((column) => column.name === "filename")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN filename TEXT");
    }
    if (!messageColumns.some((column) => column.name === "reactions_json")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN reactions_json TEXT");
    }
    if (!messageColumns.some((column) => column.name === "reply_to_id")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN reply_to_id TEXT");
    }
    if (!messageColumns.some((column) => column.name === "unsent")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN unsent INTEGER NOT NULL DEFAULT 0");
    }
    if (!messageColumns.some((column) => column.name === "is_official_account")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN is_official_account INTEGER NOT NULL DEFAULT 0");
    }
    if (!outboxColumns.some((column) => column.name === "related_message_id")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN related_message_id TEXT");
    }
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) {
        try { chmodSync(file, 0o600); } catch { /* best effort */ }
      }
    }
  }

  upsertAccount(accountId: string, profile: { mid?: string; displayName?: string } | undefined): void {
    const now = Date.now();
    this.db.query(`
      INSERT INTO accounts(account_id, mid, display_name, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        mid=excluded.mid,
        display_name=excluded.display_name,
        updated_at=excluded.updated_at
    `).run(accountId, profile?.mid ?? null, profile?.displayName ?? "", now);
  }

  getAccount(accountId: string): { mid: string; displayName: string } | null {
    const row = this.db.query(
      "SELECT mid, display_name FROM accounts WHERE account_id = ? LIMIT 1",
    ).get(accountId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      mid: String(row.mid ?? ""),
      displayName: String(row.display_name ?? ""),
    };
  }

  listTalkIdentityAliases(accountId: string): TalkIdentityAlias[] {
    const rows = this.db.query(
      "SELECT alias_mid, canonical_mid FROM talk_identity_aliases WHERE account_id = ? ORDER BY created_at",
    ).all(accountId) as Array<{ alias_mid?: unknown; canonical_mid?: unknown }>;
    return rows.map((row) => ({
      aliasMid: String(row.alias_mid ?? ""),
      canonicalMid: String(row.canonical_mid ?? ""),
    })).filter((row) => row.aliasMid && row.canonicalMid && row.aliasMid !== row.canonicalMid);
  }

  resolveTalkIdentityMid(accountId: string, mid: string): string {
    let current = String(mid ?? "").trim();
    if (!/^u[0-9a-f]{32}$/i.test(current)) return current;
    const aliases = new Map(
      this.listTalkIdentityAliases(accountId).map(({ aliasMid, canonicalMid }) => [aliasMid, canonicalMid]),
    );
    const seen = new Set([current]);
    for (let depth = 0; depth < aliases.size; depth += 1) {
      const next = aliases.get(current);
      if (!next || seen.has(next)) break;
      current = next;
      seen.add(current);
    }
    return current;
  }

  /**
   * Merge two DM MIDs after the engine has established a shared identity key
   * or the user has confirmed the relationship. Stored messages and per-chat
   * state move in one SQLite transaction, while the alias mapping keeps future
   * LINE snapshots for the old MID grouped under the selected canonical MID.
   */
  mergeTalkIdentity(accountId: string, aliasMid: string, canonicalMid: string): boolean {
    const aliasInput = String(aliasMid ?? "").trim();
    const canonicalInput = String(canonicalMid ?? "").trim();
    if (!/^u[0-9a-f]{32}$/i.test(aliasInput) || !/^u[0-9a-f]{32}$/i.test(canonicalInput)) return false;

    return this.transactionResult(() => {
      const aliasRows = this.db.query(
        "SELECT alias_mid, canonical_mid FROM talk_identity_aliases WHERE account_id = ?",
      ).all(accountId) as Array<{ alias_mid?: unknown; canonical_mid?: unknown }>;
      const aliases = new Map(aliasRows.map((row) => [String(row.alias_mid ?? ""), String(row.canonical_mid ?? "")]));
      const resolve = (input: string): string => {
        let current = input;
        const seen = new Set([current]);
        for (let depth = 0; depth < aliases.size; depth += 1) {
          const next = aliases.get(current);
          if (!next || seen.has(next)) break;
          current = next;
          seen.add(current);
        }
        return current;
      };
      const target = resolve(canonicalInput);
      let source = aliasInput;
      if (source === target) return false;

      let sourceChat = this.db.query(
        "SELECT * FROM chats WHERE account_id = ? AND chat_id = ? AND kind = 'dm' LIMIT 1",
      ).get(accountId, source) as Record<string, unknown> | null;
      if (!sourceChat) {
        source = resolve(aliasInput);
        if (source === target) return false;
        sourceChat = this.db.query(
          "SELECT * FROM chats WHERE account_id = ? AND chat_id = ? AND kind = 'dm' LIMIT 1",
        ).get(accountId, source) as Record<string, unknown> | null;
      }
      const targetChat = this.db.query(
        "SELECT * FROM chats WHERE account_id = ? AND chat_id = ? AND kind = 'dm' LIMIT 1",
      ).get(accountId, target) as Record<string, unknown> | null;
      if (!sourceChat || !targetChat) return false;

      const now = Date.now();
      this.db.query("INSERT OR IGNORE INTO messages(account_id, chat_id, kind, id, server_id, text, filename, content_type, is_mine, created_time, sender_id, sender_name, sender_avatar_url, is_official_account, post_notification_json, reactions_json, reply_to_id, unsent, status, raw_json, updated_at) SELECT account_id, ?, kind, id, server_id, text, filename, content_type, is_mine, created_time, sender_id, sender_name, sender_avatar_url, is_official_account, post_notification_json, reactions_json, reply_to_id, unsent, status, raw_json, updated_at FROM messages WHERE account_id = ? AND chat_id = ?").run(target, accountId, source);

      this.db.query("DELETE FROM hidden_messages WHERE account_id = ? AND chat_id = ? AND EXISTS (SELECT 1 FROM hidden_messages target WHERE target.account_id = hidden_messages.account_id AND target.chat_id = ? AND target.kind = hidden_messages.kind AND target.message_id = hidden_messages.message_id)").run(accountId, source, target);
      this.db.query("UPDATE hidden_messages SET chat_id = ? WHERE account_id = ? AND chat_id = ?").run(target, accountId, source);

      this.db.query("DELETE FROM chat_members WHERE account_id = ? AND chat_id = ? AND EXISTS (SELECT 1 FROM chat_members target WHERE target.account_id = chat_members.account_id AND target.chat_id = ? AND target.member_id = chat_members.member_id)").run(accountId, source, target);
      this.db.query("UPDATE chat_members SET chat_id = ? WHERE account_id = ? AND chat_id = ?").run(target, accountId, source);
      this.db.query("UPDATE outbox SET chat_id = ?, updated_at = ? WHERE account_id = ? AND chat_id = ?").run(target, now, accountId, source);

      this.db.query("UPDATE chats SET preview = CASE WHEN ? >= last_message_time AND ? <> '' THEN ? ELSE preview END, last_message_time = MAX(last_message_time, ?), unread = MIN(2147483647, unread + ?), pinned = MAX(pinned, ?), favorite_timestamp = MAX(favorite_timestamp, ?), status_message = CASE WHEN status_message = '' THEN ? ELSE status_message END, is_favorite = MAX(is_favorite, ?), favorite_time = MAX(favorite_time, ?), history_state = CASE WHEN EXISTS (SELECT 1 FROM messages WHERE account_id = ? AND chat_id = ?) THEN 'available' WHEN history_state = 'available' OR ? = 'available' THEN 'available' WHEN history_state = 'new' OR ? = 'new' THEN 'new' ELSE 'unavailable' END, updated_at = ? WHERE account_id = ? AND chat_id = ?").run(
        Number(sourceChat.last_message_time ?? 0),
        String(sourceChat.preview ?? ""),
        String(sourceChat.preview ?? ""),
        Number(sourceChat.last_message_time ?? 0),
        Number(sourceChat.unread ?? 0),
        Number(sourceChat.pinned ?? 0),
        Number(sourceChat.favorite_timestamp ?? 0),
        String(sourceChat.status_message ?? ""),
        Number(sourceChat.is_favorite ?? 0),
        Number(sourceChat.favorite_time ?? 0),
        accountId,
        target,
        String(targetChat.history_state ?? ""),
        String(sourceChat.history_state ?? ""),
        now,
        accountId,
        target,
      );

      this.db.query("DELETE FROM messages WHERE account_id = ? AND chat_id = ?").run(accountId, source);
      this.db.query("DELETE FROM chats WHERE account_id = ? AND chat_id = ?").run(accountId, source);
      this.db.query("UPDATE talk_identity_aliases SET canonical_mid = ? WHERE account_id = ? AND canonical_mid = ?").run(target, accountId, source);
      this.db.query("INSERT INTO talk_identity_aliases(account_id, alias_mid, canonical_mid, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, alias_mid) DO UPDATE SET canonical_mid = excluded.canonical_mid, created_at = excluded.created_at").run(accountId, source, target, now);
      this.db.query("DELETE FROM talk_identity_aliases WHERE account_id = ? AND alias_mid = canonical_mid").run(accountId);
      return true;
    });
  }

  consolidateTalkIdentityAliases(accountId: string): number {
    const aliases = this.listTalkIdentityAliases(accountId);
    let migrated = 0;
    for (const row of aliases) {
      const canonicalMid = this.resolveTalkIdentityMid(accountId, row.canonicalMid);
      if (row.aliasMid === canonicalMid) continue;
      const sourceExists = this.db.query(
        "SELECT 1 FROM chats WHERE account_id = ? AND chat_id = ? AND kind = 'dm' LIMIT 1",
      ).get(accountId, row.aliasMid);
      const targetExists = this.db.query(
        "SELECT 1 FROM chats WHERE account_id = ? AND chat_id = ? AND kind = 'dm' LIMIT 1",
      ).get(accountId, canonicalMid);
      if (sourceExists && targetExists && this.mergeTalkIdentity(accountId, row.aliasMid, canonicalMid)) migrated += 1;
    }
    return migrated;
  }

  findAccountIdByMid(mid: string): string | null {
    const normalized = mid.trim();
    if (!normalized) return null;
    const row = this.db.query(
      "SELECT account_id FROM accounts WHERE mid = ? ORDER BY updated_at DESC LIMIT 1",
    ).get(normalized) as { account_id?: unknown } | null;
    return row?.account_id ? String(row.account_id) : null;
  }

  latestAccountId(): string | null {
    const row = this.db.query(
      "SELECT account_id FROM accounts ORDER BY updated_at DESC LIMIT 1",
    ).get() as { account_id?: unknown } | null;
    return row?.account_id ? String(row.account_id) : null;
  }

  /** Move a legacy/default account only when the destination has no data. */
  rekeyAccount(fromAccountId: string, toAccountId: string): boolean {
    if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) return fromAccountId === toAccountId;
    const tables = ["accounts", "chats", "chat_members", "messages", "outbox", "sync_state", "protocol_events", "media_cache", "link_previews", "hidden_messages", "talk_identity_aliases"] as const;
    return this.transactionResult(() => {
      for (const table of tables) {
        const existing = this.db.query(`SELECT 1 FROM ${table} WHERE account_id = ? LIMIT 1`).get(toAccountId);
        if (existing) return false;
      }
      for (const table of tables) {
        this.db.query(`UPDATE ${table} SET account_id = ? WHERE account_id = ?`).run(toAccountId, fromAccountId);
      }
      return true;
    });
  }

  upsertChat(accountId: string, chat: DatabaseChat): void {
    const now = Date.now();
    this.db.query(`
      INSERT INTO chats(
        account_id, chat_id, kind, name, avatar_url, preview, unread,
        last_message_time, member_count, pinned, favorite_timestamp,
        status_message, is_favorite, favorite_time, raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, chat_id) DO UPDATE SET
        kind=excluded.kind,
        name=CASE
          WHEN excluded.name <> '' AND excluded.name NOT IN ('LINE Chat', 'LINE User') THEN excluded.name
          ELSE chats.name
        END,
        avatar_url=CASE WHEN excluded.avatar_url <> '' THEN excluded.avatar_url ELSE chats.avatar_url END,
        preview=CASE WHEN excluded.preview <> '' THEN excluded.preview ELSE chats.preview END,
        unread=excluded.unread,
        last_message_time=MAX(excluded.last_message_time, chats.last_message_time),
        member_count=CASE WHEN excluded.member_count > 0 THEN excluded.member_count ELSE chats.member_count END,
        pinned=excluded.pinned, favorite_timestamp=excluded.favorite_timestamp,
        status_message=CASE WHEN excluded.status_message <> '' THEN excluded.status_message ELSE chats.status_message END,
        is_favorite=excluded.is_favorite,
        favorite_time=excluded.favorite_time,
        raw_json=COALESCE(excluded.raw_json, chats.raw_json),
        updated_at=excluded.updated_at
    `).run(
      accountId,
      chat.id,
      chat.kind,
      chat.name,
      chat.avatarUrl ?? "",
      chat.preview ?? "",
      chat.unread ?? 0,
      chat.lastMessageTime ?? 0,
      chat.memberCount ?? 0,
      chat.pinned ? 1 : 0,
      chat.favoriteTimestamp ?? 0,
      chat.statusMessage ?? "",
      chat.isFavorite ? 1 : 0,
      chat.favoriteTime ?? 0,
      asJson(chat.raw),
      now,
    );
    if (chat.historyState) {
      this.db.query(
        "UPDATE chats SET history_state = ?, updated_at = ? WHERE account_id = ? AND chat_id = ?",
      ).run(chat.historyState, now, accountId, chat.id);
    }
  }

  upsertChats(accountId: string, chats: DatabaseChat[]): void {
    this.transaction(() => {
      for (const chat of chats) this.upsertChat(accountId, chat);
    });
  }

  listChats(accountId: string, kind?: ChatKind): DatabaseChat[] {
    const rows = (kind
      ? this.db.query("SELECT * FROM chats WHERE account_id = ? AND kind = ? ORDER BY pinned DESC, last_message_time DESC").all(accountId, kind)
      : this.db.query("SELECT * FROM chats WHERE account_id = ? ORDER BY pinned DESC, last_message_time DESC").all(accountId)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.chat_id),
      kind: String(row.kind) as ChatKind,
      name: String(row.name),
      avatarUrl: String(row.avatar_url ?? ""),
      preview: String(row.preview ?? ""),
      unread: Number(row.unread ?? 0),
      lastMessageTime: Number(row.last_message_time ?? 0),
      memberCount: Number(row.member_count ?? 0),
      pinned: Boolean(row.pinned),
      favoriteTimestamp: Number(row.favorite_timestamp ?? 0),
      statusMessage: String(row.status_message ?? ""),
      isFavorite: Boolean(row.is_favorite),
      favoriteTime: Number(row.favorite_time ?? 0),
      historyState: (["available", "new", "unavailable"].includes(String(row.history_state)) ? String(row.history_state) : "available") as ChatHistoryState,
      raw: fromJson(row.raw_json),
    }));
  }

  getLatestPeerName(accountId: string, chatId: string): string | undefined {
    const row = this.db.query([
      "SELECT sender_name",
      "FROM messages",
      "WHERE account_id = ? AND chat_id = ? AND sender_id = ?",
      "  AND kind = 'dm' AND is_mine = 0",
      "  AND trim(coalesce(sender_name, '')) <> ''",
      "  AND lower(trim(sender_name)) NOT IN ('line user', 'line chat')",
      "  AND NOT EXISTS (",
      "    SELECT 1 FROM hidden_messages h",
      "    WHERE h.account_id = messages.account_id",
      "      AND h.chat_id = messages.chat_id",
      "      AND h.kind = messages.kind",
      "      AND h.message_id = messages.id",
      "  )",
      "ORDER BY created_time DESC, id DESC",
      "LIMIT 1",
    ].join("\n")).get(accountId, chatId, chatId) as { sender_name?: unknown } | null;
    const name = String(row?.sender_name ?? "").trim();
    return name || undefined;
  }

  restorePlaceholderDmNamesFromHistory(accountId: string): number {
    const placeholders = this.listChats(accountId, "dm").filter((chat) =>
      ["line user", "line chat"].includes(chat.name.trim().toLowerCase()),
    );
    let restored = 0;
    for (const chat of placeholders) {
      const name = this.getLatestPeerName(accountId, chat.id);
      if (!name) continue;
      this.db.query([
        "UPDATE chats",
        "SET name = ?, updated_at = ?",
        "WHERE account_id = ? AND chat_id = ? AND kind = 'dm'",
        "  AND lower(trim(name)) IN ('line user', 'line chat')",
      ].join("\n")).run(name, Date.now(), accountId, chat.id);
      restored += 1;
    }
    return restored;
  }

  listConversationChats(accountId: string, kind?: Exclude<ChatKind, "openchat">): DatabaseChat[] {
    const rows = (kind
      ? this.db.query(`
            SELECT c.*, EXISTS (
              SELECT 1 FROM messages m
              WHERE m.account_id = c.account_id AND m.chat_id = c.chat_id
            ) AS has_message_history
            FROM chats c
            WHERE c.account_id = ? AND c.kind = ?
            AND (
              c.last_message_time > 0 OR c.preview <> '' OR c.history_state IN ('new', 'unavailable') OR
              EXISTS (SELECT 1 FROM messages m WHERE m.account_id = c.account_id AND m.chat_id = c.chat_id)
            )
          ORDER BY c.pinned DESC, c.last_message_time DESC
        `).all(accountId, kind)
      : this.db.query(`
            SELECT c.*, EXISTS (
              SELECT 1 FROM messages m
              WHERE m.account_id = c.account_id AND m.chat_id = c.chat_id
            ) AS has_message_history
            FROM chats c
            WHERE c.account_id = ? AND c.kind IN ('dm', 'group')
            AND (
              c.last_message_time > 0 OR c.preview <> '' OR c.history_state IN ('new', 'unavailable') OR
              EXISTS (SELECT 1 FROM messages m WHERE m.account_id = c.account_id AND m.chat_id = c.chat_id)
            )
          ORDER BY c.pinned DESC, c.last_message_time DESC
        `).all(accountId)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.chat_id),
      kind: String(row.kind) as ChatKind,
      name: String(row.name),
      avatarUrl: String(row.avatar_url ?? ""),
      preview: String(row.preview ?? ""),
      unread: Number(row.unread ?? 0),
      lastMessageTime: Number(row.last_message_time ?? 0),
      memberCount: Number(row.member_count ?? 0),
      pinned: Boolean(row.pinned),
      favoriteTimestamp: Number(row.favorite_timestamp ?? 0),
      statusMessage: String(row.status_message ?? ""),
      isFavorite: Boolean(row.is_favorite),
      favoriteTime: Number(row.favorite_time ?? 0),
      historyState: row.has_message_history
        ? "available"
        : (["available", "new", "unavailable"].includes(String(row.history_state)) ? String(row.history_state) : "new") as ChatHistoryState,
      raw: fromJson(row.raw_json),
    }));
  }

  upsertMessage(accountId: string, message: DatabaseMessage, serverId?: string): void {
    const now = Date.now();
    this.db.query(`
      INSERT INTO messages(
        account_id, chat_id, kind, id, server_id, text, filename, content_type, is_mine,
        created_time, sender_id, sender_name, sender_avatar_url,
        is_official_account, post_notification_json, reactions_json, reply_to_id, unsent, status, raw_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, chat_id, id) DO UPDATE SET
        server_id=COALESCE(excluded.server_id, messages.server_id),
        text=CASE WHEN messages.unsent = 1 THEN messages.text ELSE excluded.text END,
        filename=CASE WHEN messages.unsent = 1 THEN messages.filename ELSE COALESCE(excluded.filename, messages.filename) END,
        content_type=CASE WHEN messages.unsent = 1 THEN messages.content_type ELSE excluded.content_type END,
        is_mine=excluded.is_mine, created_time=excluded.created_time,
        sender_id=excluded.sender_id, sender_name=excluded.sender_name,
        sender_avatar_url=excluded.sender_avatar_url,
        is_official_account=MAX(messages.is_official_account, excluded.is_official_account),
        post_notification_json=excluded.post_notification_json,
        reactions_json=COALESCE(excluded.reactions_json, messages.reactions_json),
        reply_to_id=COALESCE(excluded.reply_to_id, messages.reply_to_id),
        unsent=MAX(messages.unsent, excluded.unsent),
        status=excluded.status,
        raw_json=COALESCE(excluded.raw_json, messages.raw_json),
        updated_at=excluded.updated_at
    `).run(
      accountId,
      message.chatId,
      message.kind,
      message.id,
      serverId ?? null,
      message.text ?? null,
      message.filename ?? null,
      message.contentType ?? 0,
      message.isMine ? 1 : 0,
      message.createdTime,
      message.senderId ?? null,
      message.senderName ?? null,
      message.senderAvatarUrl ?? null,
      message.isOfficialAccount ? 1 : 0,
      asJson(message.postNotification),
      asJson(message.reactions),
      message.replyToId ?? null,
      message.unsent ? 1 : 0,
      message.status ?? "sent",
      asJson(message.raw),
      now,
    );
    this.db.query(
      "UPDATE chats SET history_state = 'available', updated_at = ? WHERE account_id = ? AND chat_id = ?",
    ).run(now, accountId, message.chatId);
  }

  reconcileMessage(accountId: string, localId: string, message: DatabaseMessage, serverId?: string): void {
    this.transaction(() => {
      const local = this.db.query(
        "SELECT filename, raw_json, reactions_json, reply_to_id FROM messages WHERE account_id = ? AND chat_id = ? AND id = ?",
      ).get(accountId, message.chatId, localId) as {
        filename?: string | null;
        raw_json?: string | null;
        reactions_json?: string | null;
        reply_to_id?: string | null;
      } | null;
      const reconciled = {
        ...message,
        ...(message.filename ? {} : { filename: local?.filename ?? undefined }),
        ...(message.raw ? {} : { raw: fromMessageJson(local?.raw_json) }),
        ...(message.reactions === undefined ? { reactions: fromJson(local?.reactions_json) } : {}),
        ...(message.replyToId === undefined ? { replyToId: local?.reply_to_id ?? undefined } : {}),
      };
      if (localId !== message.id) {
        this.db.query("DELETE FROM messages WHERE account_id = ? AND chat_id = ? AND id = ?")
          .run(accountId, message.chatId, localId);
      }
      this.upsertMessage(accountId, reconciled, serverId);
    });
  }

  upsertMessages(accountId: string, messages: DatabaseMessage[]): void {
    this.transaction(() => {
      for (const message of messages) this.upsertMessage(accountId, message);
    });
  }

  /**
   * Update the denormalized chat row when a message arrives from the live
   * event stream. Keeping this separate from upsertChat is important: a
   * partial live event must not overwrite pinned/favorite/name metadata with
   * empty values or reset an unread count.
   */
  recordMessageActivity(
    accountId: string,
    activity: {
      chatId: string;
      kind: ChatKind;
      name?: string;
      avatarUrl?: string;
      preview?: string;
      createdTime: number;
      isMine: boolean;
      /**
       * Live event sources can overlap (PUSH and REST polling). Callers pass
       * false when the message was already present so unread counts remain
       * idempotent even when the same operation is delivered twice.
       */
      isNew?: boolean;
    },
  ): void {
    const chatId = String(activity.chatId ?? "").trim();
    if (!chatId) return;
    const existing = this.db.query(
      "SELECT chat_id FROM chats WHERE account_id = ? AND chat_id = ? LIMIT 1",
    ).get(accountId, chatId);
    if (!existing) {
      this.upsertChat(accountId, {
        id: chatId,
        kind: activity.kind,
        name: activity.name?.trim() || (activity.kind === "openchat" ? "OpenChat" : "LINE Chat"),
        avatarUrl: activity.avatarUrl ?? "",
        preview: activity.preview ?? "",
        unread: activity.isMine || activity.isNew === false ? 0 : 1,
        lastMessageTime: activity.createdTime,
        historyState: "available",
      });
      return;
    }
    const preview = String(activity.preview ?? "");
    const createdTime = Number.isFinite(activity.createdTime) ? activity.createdTime : Date.now();
    this.db.query(`
      UPDATE chats SET
        preview = CASE WHEN ? <> '' AND ? >= last_message_time THEN ? ELSE preview END,
        unread = unread + ?,
        last_message_time = MAX(last_message_time, ?),
        history_state = 'available',
        updated_at = ?
      WHERE account_id = ? AND chat_id = ?
    `).run(
      preview,
      createdTime,
      preview,
      activity.isMine || activity.isNew === false ? 0 : 1,
      createdTime,
      Date.now(),
      accountId,
      chatId,
    );
  }

  setTrackedChatActivity(
    accountId: string,
    chatId: string,
    activity: { preview: string; createdTime: number; unread: number },
  ): void {
    const createdTime = Number.isFinite(activity.createdTime) ? activity.createdTime : Date.now();
    const unread = Math.max(0, Number.isFinite(activity.unread) ? activity.unread : 0);
    this.db.query(`
      UPDATE chats SET
        preview = CASE WHEN ? <> '' THEN ? ELSE preview END,
        unread = ?,
        last_message_time = MAX(last_message_time, ?),
        history_state = 'unavailable',
        updated_at = ?
      WHERE account_id = ? AND chat_id = ?
    `).run(
      activity.preview,
      activity.preview,
      unread,
      createdTime,
      Date.now(),
      accountId,
      chatId,
    );
  }

  markChatRead(accountId: string, chatId: string): void {
    this.db.query(
      "UPDATE chats SET unread = 0, updated_at = ? WHERE account_id = ? AND chat_id = ?",
    ).run(Date.now(), accountId, chatId);
  }

  updateMessageStatus(accountId: string, chatId: string, id: string, status: DatabaseMessage["status"]): void {
    this.db.query("UPDATE messages SET status = ?, updated_at = ? WHERE account_id = ? AND chat_id = ? AND id = ?")
      .run(status ?? "sent", Date.now(), accountId, chatId, id);
  }

  updateMessageReactions(accountId: string, chatId: string, id: string, reactions: unknown): void {
    this.db.query(`
      UPDATE messages SET reactions_json = ?, updated_at = ?
      WHERE account_id = ? AND chat_id = ? AND (id = ? OR server_id = ?)
    `).run(asJson(reactions), Date.now(), accountId, chatId, id, id);
  }

  hideMessageForMe(accountId: string, chatId: string, kind: ChatKind, messageId: string): void {
    this.transaction(() => {
      const now = Date.now();
      const stored = this.db.query(
        "SELECT id, server_id FROM messages WHERE account_id = ? AND chat_id = ? AND (id = ? OR server_id = ?) LIMIT 1",
      ).get(accountId, chatId, messageId, messageId) as { id?: string; server_id?: string | null } | null;
      const hiddenIds = [...new Set([
        messageId,
        stored?.id,
        stored?.server_id ?? undefined,
      ].filter((value): value is string => Boolean(value)))];
      for (const hiddenId of hiddenIds) {
        this.db.query(`
          INSERT OR IGNORE INTO hidden_messages(account_id, chat_id, kind, message_id, hidden_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(accountId, chatId, kind, hiddenId, now);
      }
      this.db.query(`
        DELETE FROM messages
        WHERE account_id = ? AND chat_id = ? AND (id = ? OR server_id = ?)
      `).run(accountId, chatId, messageId, messageId);
      this.db.query("DELETE FROM outbox WHERE account_id = ? AND local_id = ?")
        .run(accountId, messageId);
    });
  }

  isMessageHidden(accountId: string, chatId: string, kind: ChatKind, messageId: string): boolean {
    return Boolean(this.db.query(`
      SELECT 1 FROM hidden_messages
      WHERE account_id = ? AND chat_id = ? AND kind = ? AND message_id = ?
      LIMIT 1
    `).get(accountId, chatId, kind, messageId));
  }

  markMessageUnsent(accountId: string, chatId: string, id: string): void {
    this.db.query(`
      UPDATE messages SET
        text = 'ยกเลิกข้อความแล้ว', filename = NULL, content_type = 0,
        post_notification_json = NULL, reactions_json = NULL, reply_to_id = NULL,
        unsent = 1, status = 'sent', raw_json = NULL, updated_at = ?
      WHERE account_id = ? AND chat_id = ? AND (id = ? OR server_id = ?)
    `).run(Date.now(), accountId, chatId, id, id);
  }

  getMessage(accountId: string, chatId: string, id: string): DatabaseMessage | null {
    const row = this.db.query(`
      SELECT * FROM messages
      WHERE account_id = ? AND chat_id = ? AND (id = ? OR server_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM hidden_messages h
          WHERE h.account_id = messages.account_id
            AND h.chat_id = messages.chat_id
            AND h.kind = messages.kind
            AND h.message_id = messages.id
        )
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(accountId, chatId, id, id) as Record<string, unknown> | null;
    return row ? this.messageFromRow(row) : null;
  }

  findTalkChatForCursorMessage(
    accountId: string,
    currentChatId: string,
    messageId: string,
    deliveredTime: number,
  ): string | null {
    const normalizedId = String(messageId ?? "").trim();
    const cursorTime = Number(deliveredTime);
    if (!normalizedId || !Number.isFinite(cursorTime) || cursorTime <= 0) return null;

    const rows = this.db.query(`
      SELECT m.chat_id AS chat_id, m.created_time AS created_time
      FROM messages m
      INNER JOIN chats c
        ON c.account_id = m.account_id AND c.chat_id = m.chat_id
      WHERE m.account_id = ? AND m.chat_id <> ?
        AND c.kind = 'dm' AND m.kind = 'dm'
        AND (m.id = ? OR m.server_id = ?)
      ORDER BY ABS(m.created_time - ?) ASC
      LIMIT 32
    `).all(accountId, currentChatId, normalizedId, normalizedId, cursorTime) as Array<{
      chat_id?: unknown;
      created_time?: unknown;
    }>;
    const matched = new Set(rows
      .filter((row) => Math.abs(Number(row.created_time ?? 0) - cursorTime) <= 5 * 60_000)
      .map((row) => String(row.chat_id ?? "").trim())
      .filter(Boolean));
    return matched.size === 1 ? [...matched][0] : null;
  }

  listTalkHistoryCandidates(
    accountId: string,
    currentChatId: string,
    limit = 200,
  ): Array<{ id: string; name: string; messageCount: number; latestMessageTime: number }> {
    const rows = this.db.query(`
      SELECT c.chat_id AS chat_id, c.name AS name,
        COUNT(m.id) AS message_count, MAX(m.created_time) AS latest_message_time
      FROM chats c
      INNER JOIN messages m
        ON m.account_id = c.account_id AND m.chat_id = c.chat_id AND m.kind = 'dm'
      WHERE c.account_id = ? AND c.kind = 'dm' AND c.chat_id <> ?
        AND NOT EXISTS (
          SELECT 1 FROM hidden_messages h
          WHERE h.account_id = m.account_id
            AND h.chat_id = m.chat_id
            AND h.kind = m.kind
            AND h.message_id = m.id
        )
      GROUP BY c.account_id, c.chat_id
      ORDER BY MAX(m.created_time) DESC, COUNT(m.id) DESC
      LIMIT ?
    `).all(accountId, currentChatId, Math.max(1, Math.min(limit, 1000))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.chat_id ?? ""),
      name: String(row.name ?? "LINE User"),
      messageCount: Number(row.message_count ?? 0),
      latestMessageTime: Number(row.latest_message_time ?? 0),
    })).filter((row) => row.id && row.messageCount > 0);
  }

  listMessages(accountId: string, chatId: string, limit = 100): DatabaseMessage[] {
    const rows = this.db.query(`
      SELECT messages.*, outbox.last_error AS send_error, outbox.filename AS outbox_filename
      FROM messages
      LEFT JOIN outbox
        ON outbox.account_id = messages.account_id
        AND outbox.chat_id = messages.chat_id
        AND outbox.local_id = messages.id
      WHERE messages.account_id = ? AND messages.chat_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM hidden_messages h
          WHERE h.account_id = messages.account_id
            AND h.chat_id = messages.chat_id
            AND h.kind = messages.kind
            AND h.message_id = messages.id
        )
      ORDER BY created_time DESC, id DESC
      LIMIT ?
    `).all(accountId, chatId, Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[];
    return rows.reverse().map((row) => this.messageFromRow(row));
  }

  listMessagesBefore(
    accountId: string,
    chatId: string,
    beforeCreatedTime: number,
    beforeId: string,
    limit = 50,
  ): { messages: DatabaseMessage[]; hasMore: boolean } {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.db.query(`
      SELECT messages.*, outbox.last_error AS send_error, outbox.filename AS outbox_filename
      FROM messages
      LEFT JOIN outbox
        ON outbox.account_id = messages.account_id
        AND outbox.chat_id = messages.chat_id
        AND outbox.local_id = messages.id
      WHERE messages.account_id = ? AND messages.chat_id = ?
        AND (messages.created_time < ? OR (messages.created_time = ? AND messages.id < ?))
        AND NOT EXISTS (
          SELECT 1 FROM hidden_messages h
          WHERE h.account_id = messages.account_id
            AND h.chat_id = messages.chat_id
            AND h.kind = messages.kind
            AND h.message_id = messages.id
        )
      ORDER BY messages.created_time DESC, messages.id DESC
      LIMIT ?
    `).all(accountId, chatId, beforeCreatedTime, beforeCreatedTime, beforeId, safeLimit + 1) as Record<string, unknown>[];
    const hasMore = rows.length > safeLimit;
    return {
      messages: rows.slice(0, safeLimit).reverse().map((row) => this.messageFromRow(row)),
      hasMore,
    };
  }

  listPendingE2EEMessages(accountId: string, limit = 200): DatabaseMessage[] {
    const rows = this.db.query(`
      SELECT * FROM messages
      WHERE account_id = ? AND kind IN ('dm', 'group')
        AND unsent = 0 AND raw_json LIKE '%lineyE2eeDecodeError%'
      ORDER BY created_time DESC, id DESC
      LIMIT ?
    `).all(accountId, Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[];
    return rows.map((row) => this.messageFromRow(row)).filter((message) => {
      const raw = message.raw;
      return raw !== null && typeof raw === "object"
        && !Array.isArray(raw)
        && (raw as Record<string, unknown>).lineyE2eeDecodeError === true;
    });
  }

  listMessagesByContentType(accountId: string, contentType: number, limit = 100): DatabaseMessage[] {
    const rows = this.db.query(`
      SELECT * FROM messages
      WHERE account_id = ? AND content_type = ?
        AND kind IN ('dm', 'group')
        AND NOT EXISTS (
          SELECT 1 FROM hidden_messages h
          WHERE h.account_id = messages.account_id
            AND h.chat_id = messages.chat_id
            AND h.kind = messages.kind
            AND h.message_id = messages.id
        )
      ORDER BY created_time DESC, id DESC
      LIMIT ?
    `).all(accountId, contentType, Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[];
    return rows.map((row) => this.messageFromRow(row));
  }

  private messageFromRow(row: Record<string, unknown>): DatabaseMessage {
    const storedStatus = String(row.status ?? "sent");
    return {
      id: String(row.id),
      chatId: String(row.chat_id),
      kind: String(row.kind) as ChatKind,
      text: row.text === null ? undefined : String(row.text ?? ""),
      filename: row.filename ? String(row.filename) : row.outbox_filename ? String(row.outbox_filename) : undefined,
      isMine: Boolean(row.is_mine),
      createdTime: Number(row.created_time ?? 0),
      contentType: Number(row.content_type ?? 0),
      senderId: row.sender_id ? String(row.sender_id) : undefined,
      senderName: row.sender_name ? String(row.sender_name) : undefined,
      senderAvatarUrl: row.sender_avatar_url ? String(row.sender_avatar_url) : undefined,
      isOfficialAccount: Boolean(row.is_official_account),
      postNotification: fromJson(row.post_notification_json),
      reactions: fromJson(row.reactions_json),
      replyToId: row.reply_to_id ? String(row.reply_to_id) : undefined,
      unsent: Boolean(row.unsent),
      status: storedStatus === "failed" || storedStatus === "error"
        ? "error"
        : storedStatus === "queued" || storedStatus === "sending"
          ? "sending"
          : storedStatus === "unknown" ? "unknown" : "sent",
      sendError: row.send_error ? String(row.send_error) : undefined,
      raw: fromMessageJson(row.raw_json),
    };
  }

  getMessageSource(
    accountId: string,
    messageId: string,
    chatId?: string,
    kind?: ChatKind,
  ): DatabaseMessageSource | null {
    let row: Record<string, unknown> | null;
    if (chatId) {
      row = this.db.query(`
        SELECT chat_id, kind, content_type, raw_json
        FROM messages
        WHERE account_id = ? AND chat_id = ? AND id = ?
        LIMIT 1
      `).get(accountId, chatId, messageId) as Record<string, unknown> | null;
    } else if (kind === "openchat") {
      row = this.db.query(`
        SELECT chat_id, kind, content_type, raw_json
        FROM messages
        WHERE account_id = ? AND kind = 'openchat' AND id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(accountId, messageId) as Record<string, unknown> | null;
    } else if (kind === "dm" || kind === "group") {
      row = this.db.query(`
        SELECT chat_id, kind, content_type, raw_json
        FROM messages
        WHERE account_id = ? AND kind = ? AND id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(accountId, kind, messageId) as Record<string, unknown> | null;
    } else {
      row = this.db.query(`
        SELECT chat_id, kind, content_type, raw_json
        FROM messages
        WHERE account_id = ? AND id = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(accountId, messageId) as Record<string, unknown> | null;
    }
    if (!row) return null;
    return {
      chatId: String(row.chat_id),
      kind: String(row.kind) as ChatKind,
      contentType: Number(row.content_type ?? 0),
      raw: fromMessageJson(row.raw_json),
    };
  }

  listRecentStickers(accountId: string, limit = 36): Array<{ packageId: string; stickerId: string; version: string; option?: string; owned: boolean }> {
    const rows = this.db.query(`
      SELECT raw_json, is_mine FROM messages
      WHERE account_id = ? AND content_type = 7
      ORDER BY created_time DESC, id DESC
      LIMIT ?
    `).all(accountId, Math.max(1, Math.min(limit * 4, 200))) as Array<{ raw_json?: unknown; is_mine?: unknown }>;
    const seen = new Set<string>();
    const result: Array<{ packageId: string; stickerId: string; version: string; option?: string; owned: boolean }> = [];
    for (const row of rows) {
      const raw = fromMessageJson(row.raw_json) as { contentMetadata?: unknown } | undefined;
      const metadata = raw?.contentMetadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
      const values = metadata as Record<string, unknown>;
      const packageId = String(values.STKPKGID ?? "").trim();
      const stickerId = String(values.STKID ?? "").trim();
      // 30563/651698630 is LINE's public placeholder for Sticker Arranging,
      // not a sendable reconstruction of the original arrangement.
      if (!/^\d{1,20}$/.test(packageId) || !/^\d{1,20}$/.test(stickerId) || (packageId === "30563" && stickerId === "651698630")) continue;
      const key = `${packageId}:${stickerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        packageId,
        stickerId,
        version: String(values.STKVER ?? "1").trim() || "1",
        ...(String(values.STKOPT ?? "").trim() ? { option: String(values.STKOPT).trim() } : {}),
        owned: Boolean(row.is_mine),
      });
      if (result.length >= limit) break;
    }
    return result;
  }

  listRecentEmoji(accountId: string, limit = 72): Array<{ productId: string; sticonId: string; version: string; resourceType: string; owned: boolean }> {
    const rows = this.db.query(`
      SELECT raw_json, is_mine FROM messages
      WHERE account_id = ? AND content_type = 0
      ORDER BY created_time DESC, id DESC
      LIMIT ?
    `).all(accountId, Math.max(1, Math.min(limit * 5, 500))) as Array<{ raw_json?: unknown; is_mine?: unknown }>;
    const seen = new Set<string>();
    const result: Array<{ productId: string; sticonId: string; version: string; resourceType: string; owned: boolean }> = [];
    for (const row of rows) {
      const raw = fromMessageJson(row.raw_json) as { contentMetadata?: unknown } | undefined;
      const metadata = raw?.contentMetadata;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
      const replace = (metadata as Record<string, unknown>).REPLACE;
      if (typeof replace !== "string") continue;
      try {
        const parsed = JSON.parse(replace) as { sticon?: { resources?: unknown } };
        const resources = Array.isArray(parsed?.sticon?.resources) ? parsed.sticon.resources : [];
        for (const value of resources) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const resource = value as Record<string, unknown>;
          const productId = String(resource.productId ?? "").trim();
          const sticonId = String(resource.sticonId ?? "").trim();
          if (!/^\d{1,30}$/.test(productId) || !/^\d{1,30}$/.test(sticonId)) continue;
          const key = `${productId}:${sticonId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          result.push({ productId, sticonId, version: String(resource.version ?? "1") || "1", resourceType: String(resource.resourceType ?? "STATIC") || "STATIC", owned: Boolean(row.is_mine) });
          if (result.length >= limit) return result;
        }
      } catch {
        // A malformed decoration must not hide the remaining valid history.
      }
    }
    return result;
  }

  saveOutbox(accountId: string, record: OutboxRecord): void {
    this.db.query(`
      INSERT INTO outbox(
        account_id, local_id, chat_id, kind, content_type, text, file_path,
        filename, mime, duration_ms, content_metadata_json, fingerprint, status, attempts, created_at, updated_at,
        next_attempt_at, server_id, last_error, related_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, local_id) DO UPDATE SET
        chat_id=excluded.chat_id, kind=excluded.kind, content_type=excluded.content_type,
        text=excluded.text, file_path=excluded.file_path, filename=excluded.filename,
        mime=excluded.mime, duration_ms=excluded.duration_ms, content_metadata_json=excluded.content_metadata_json, fingerprint=excluded.fingerprint, status=excluded.status,
        attempts=excluded.attempts, updated_at=excluded.updated_at,
        next_attempt_at=excluded.next_attempt_at, server_id=excluded.server_id,
        last_error=excluded.last_error, related_message_id=excluded.related_message_id
    `).run(
      accountId, record.localId, record.chatId, record.kind, record.contentType,
      record.text ?? null, record.filePath ?? null, record.filename ?? null,
      record.mime ?? null, record.durationMs ?? null, asJson(record.contentMetadata), record.fingerprint, record.status, record.attempts,
      record.createdAt, record.updatedAt, record.nextAttemptAt ?? null,
      record.serverId ?? null, record.lastError ?? null, record.relatedMessageId ?? null,
    );
  }

  listPendingOutbox(accountId: string, now = Date.now()): OutboxRecord[] {
    const rows = this.db.query(`
      SELECT * FROM outbox
      WHERE account_id = ?
        AND status IN ('queued', 'sending', 'unknown')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at ASC
    `).all(accountId, now) as Record<string, unknown>[];
    return rows.map((row) => ({
      localId: String(row.local_id), chatId: String(row.chat_id),
      kind: String(row.kind) as ChatKind, contentType: Number(row.content_type ?? 0),
      text: row.text ? String(row.text) : undefined,
      filePath: row.file_path ? String(row.file_path) : undefined,
      filename: row.filename ? String(row.filename) : undefined,
      mime: row.mime ? String(row.mime) : undefined,
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      contentMetadata: fromJson(row.content_metadata_json) as Record<string, string> | undefined,
      fingerprint: String(row.fingerprint),
      status: String(row.status) as OutboxRecord["status"], attempts: Number(row.attempts ?? 0),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      nextAttemptAt: row.next_attempt_at === null ? undefined : Number(row.next_attempt_at),
      serverId: row.server_id ? String(row.server_id) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
      relatedMessageId: row.related_message_id ? String(row.related_message_id) : undefined,
    }));
  }

  getOutbox(accountId: string, localId: string): OutboxRecord | null {
    const row = this.db.query("SELECT * FROM outbox WHERE account_id = ? AND local_id = ?").get(accountId, localId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      localId: String(row.local_id), chatId: String(row.chat_id),
      kind: String(row.kind) as ChatKind, contentType: Number(row.content_type ?? 0),
      text: row.text ? String(row.text) : undefined,
      filePath: row.file_path ? String(row.file_path) : undefined,
      filename: row.filename ? String(row.filename) : undefined,
      mime: row.mime ? String(row.mime) : undefined,
      durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
      contentMetadata: fromJson(row.content_metadata_json) as Record<string, string> | undefined,
      fingerprint: String(row.fingerprint), status: String(row.status) as OutboxRecord["status"],
      attempts: Number(row.attempts ?? 0), createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      nextAttemptAt: row.next_attempt_at === null ? undefined : Number(row.next_attempt_at),
      serverId: row.server_id ? String(row.server_id) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
      relatedMessageId: row.related_message_id ? String(row.related_message_id) : undefined,
    };
  }

  deleteOutbox(accountId: string, localId: string): void {
    this.db.query("DELETE FROM outbox WHERE account_id = ? AND local_id = ?").run(accountId, localId);
  }

  setSyncState(accountId: string, state: Omit<SyncState, "updatedAt"> & { updatedAt?: number }): SyncState {
    const value: SyncState = { ...state, updatedAt: state.updatedAt ?? Date.now() };
    this.db.query(`
      INSERT INTO sync_state(account_id, state_key, cursor, generation, status, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, state_key) DO UPDATE SET
        cursor=excluded.cursor, generation=excluded.generation, status=excluded.status,
        error=excluded.error, updated_at=excluded.updated_at
    `).run(accountId, value.key, value.cursor ?? null, value.generation, value.status, value.error ?? null, value.updatedAt);
    return value;
  }

  getSyncState(accountId: string, key: string): SyncState | null {
    const row = this.db.query("SELECT * FROM sync_state WHERE account_id = ? AND state_key = ?").get(accountId, key) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      key: String(row.state_key), cursor: row.cursor ? String(row.cursor) : undefined,
      generation: Number(row.generation ?? 0), status: String(row.status) as SyncState["status"],
      error: row.error ? String(row.error) : undefined, updatedAt: Number(row.updated_at ?? 0),
    };
  }

  recordProtocolEvent(accountId: string, event: ProtocolEventRecord, maxEntries = 200): void {
    const capturedAt = event.capturedAt ?? Date.now();
    this.transaction(() => {
      this.db.query(`
        INSERT OR IGNORE INTO protocol_events(
          account_id, event_key, source, op_type, revision, created_time,
          param1, param2, param3, raw_json, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        accountId,
        event.eventKey,
        event.source,
        event.opType,
        event.revision ?? null,
        event.createdTime,
        event.param1 ?? null,
        event.param2 ?? null,
        event.param3 ?? null,
        asJson(event.raw),
        capturedAt,
      );
      this.db.query(`
        DELETE FROM protocol_events
        WHERE account_id = ? AND event_key IN (
          SELECT event_key FROM protocol_events
          WHERE account_id = ?
          ORDER BY captured_at DESC, event_key DESC
          LIMIT -1 OFFSET ?
        )
      `).run(accountId, accountId, Math.max(1, maxEntries));
    });
  }

  listProtocolEvents(accountId: string, limit = 200): ProtocolEventRecord[] {
    const rows = this.db.query(`
      SELECT * FROM protocol_events
      WHERE account_id = ?
      ORDER BY captured_at DESC, event_key DESC
      LIMIT ?
    `).all(accountId, Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[];
    return rows.map((row) => ({
      eventKey: String(row.event_key),
      source: String(row.source),
      opType: String(row.op_type),
      revision: row.revision === null ? undefined : String(row.revision),
      createdTime: Number(row.created_time ?? 0),
      param1: row.param1 === null ? undefined : String(row.param1),
      param2: row.param2 === null ? undefined : String(row.param2),
      param3: row.param3 === null ? undefined : String(row.param3),
      raw: fromJson(row.raw_json),
      capturedAt: Number(row.captured_at ?? 0),
    }));
  }

  saveMedia(accountId: string, mediaKey: string, path: string, mime: string, size: number): void {
    this.db.query(`
      INSERT INTO media_cache(account_id, media_key, path, mime, size, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, media_key) DO UPDATE SET
        path=excluded.path, mime=excluded.mime, size=excluded.size, accessed_at=excluded.accessed_at
    `).run(accountId, mediaKey, path, mime, size, Date.now());
  }

  touchMedia(accountId: string, mediaKey: string): void {
    this.db.query("UPDATE media_cache SET accessed_at = ? WHERE account_id = ? AND media_key = ?").run(Date.now(), accountId, mediaKey);
  }

  deleteMedia(accountId: string, mediaKey: string): void {
    this.db.query("DELETE FROM media_cache WHERE account_id = ? AND media_key = ?").run(accountId, mediaKey);
  }

  getMedia(accountId: string, mediaKey: string): { path: string; mime: string; size: number; accessedAt: number } | null {
    const row = this.db.query("SELECT path, mime, size, accessed_at FROM media_cache WHERE account_id = ? AND media_key = ?")
      .get(accountId, mediaKey) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      path: String(row.path ?? ""),
      mime: String(row.mime ?? ""),
      size: Number(row.size ?? 0),
      accessedAt: Number(row.accessed_at ?? 0),
    };
  }

  getLinkPreview(accountId: string, url: string, maxAgeMs = 7 * 24 * 60 * 60_000): Record<string, unknown> | null {
    const row = this.db.query(`
      SELECT preview_json, updated_at
      FROM link_previews
      WHERE account_id = ? AND url = ?
      LIMIT 1
    `).get(accountId, url) as { preview_json?: unknown; updated_at?: unknown } | null;
    if (!row) return null;
    const updatedAt = Number(row.updated_at ?? 0);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > Math.max(0, maxAgeMs)) {
      this.db.query("DELETE FROM link_previews WHERE account_id = ? AND url = ?").run(accountId, url);
      return null;
    }
    const preview = fromJson(row.preview_json);
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
      this.db.query("DELETE FROM link_previews WHERE account_id = ? AND url = ?").run(accountId, url);
      return null;
    }
    this.db.query("UPDATE link_previews SET accessed_at = MAX(accessed_at, ?) + 1 WHERE account_id = ? AND url = ?")
      .run(Date.now(), accountId, url);
    return preview as Record<string, unknown>;
  }

  saveLinkPreview(accountId: string, url: string, preview: Record<string, unknown>, maxEntries = 400): void {
    const now = Date.now();
    const json = asJson(preview);
    if (!json) return;
    this.transaction(() => {
      this.db.query(`
        INSERT INTO link_previews(account_id, url, preview_json, updated_at, accessed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, url) DO UPDATE SET
          preview_json=excluded.preview_json,
          updated_at=excluded.updated_at,
          accessed_at=excluded.accessed_at
      `).run(accountId, url, json, now, now);
      this.db.query(`
        DELETE FROM link_previews
        WHERE account_id = ? AND url IN (
          SELECT url FROM link_previews
          WHERE account_id = ?
          ORDER BY accessed_at DESC, updated_at DESC, rowid DESC
          LIMIT -1 OFFSET ?
        )
      `).run(accountId, accountId, Math.max(1, Math.floor(maxEntries)));
    });
  }

  pruneMessageCache(
    accountId: string,
    options: { maxPerChat?: number; maxTotal?: number; keepPerChat?: number } = {},
  ): { removed: number; remaining: number } {
    const maxPerChat = Math.max(1, Math.floor(options.maxPerChat ?? 180));
    const maxTotal = Math.max(maxPerChat, Math.floor(options.maxTotal ?? 12_000));
    const keepPerChat = Math.max(1, Math.min(maxPerChat, Math.floor(options.keepPerChat ?? 12)));
    const beforeRow = this.db.query(
      "SELECT COUNT(*) AS count FROM messages WHERE account_id = ?",
    ).get(accountId) as { count?: unknown } | null;
    const before = Number(beforeRow?.count ?? 0);
    if (before <= maxPerChat) return { removed: 0, remaining: before };

    this.transaction(() => {
      // Message list RPCs expose at most a bounded recent window. Keep a wider
      // durable window than the UI needs, but do not let a few very active rooms
      // grow SQLite forever. Pending/failed outbox rows are deliberately not
      // touched here; only already-sent history is cache-evictable.
      this.db.query(`
        WITH ranked AS (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY chat_id
                   ORDER BY created_time DESC, id DESC
                 ) AS rank_in_chat
          FROM messages
          WHERE account_id = ? AND status = 'sent'
        )
        DELETE FROM messages
        WHERE rowid IN (
          SELECT rowid FROM ranked WHERE rank_in_chat > ?
        )
      `).run(accountId, maxPerChat);

      const countRow = this.db.query(
        "SELECT COUNT(*) AS count FROM messages WHERE account_id = ?",
      ).get(accountId) as { count?: unknown } | null;
      const current = Number(countRow?.count ?? 0);
      const excess = Math.max(0, current - maxTotal);
      if (excess > 0) {
        // Preserve a small recent tail for every room so reopening an old room
        // still has useful offline context. Evict oldest rows beyond that tail
        // until the account-wide cap is satisfied.
        this.db.query(`
          WITH ranked AS (
            SELECT rowid, created_time,
                   ROW_NUMBER() OVER (
                     PARTITION BY chat_id
                     ORDER BY created_time DESC, id DESC
                   ) AS rank_in_chat
            FROM messages
            WHERE account_id = ? AND status = 'sent'
          )
          DELETE FROM messages
          WHERE rowid IN (
            SELECT rowid FROM ranked
            WHERE rank_in_chat > ?
            ORDER BY created_time ASC, rowid ASC
            LIMIT ?
          )
        `).run(accountId, keepPerChat, excess);
      }
    });

    const afterRow = this.db.query(
      "SELECT COUNT(*) AS count FROM messages WHERE account_id = ?",
    ).get(accountId) as { count?: unknown } | null;
    const remaining = Number(afterRow?.count ?? 0);
    return { removed: Math.max(0, before - remaining), remaining };
  }

  clearHistory(accountId: string): void {
    this.transaction(() => {
      this.db.query("DELETE FROM messages WHERE account_id = ?").run(accountId);
      this.db.query("DELETE FROM hidden_messages WHERE account_id = ?").run(accountId);
      this.db.query("DELETE FROM outbox WHERE account_id = ?").run(accountId);
      this.db.query("DELETE FROM media_cache WHERE account_id = ?").run(accountId);
      this.db.query("DELETE FROM link_previews WHERE account_id = ?").run(accountId);
      this.db.query("DELETE FROM protocol_events WHERE account_id = ?").run(accountId);
    });
  }

  clearAccount(accountId: string): void {
    this.transaction(() => {
      for (const table of ["chats", "chat_members", "messages", "outbox", "sync_state", "protocol_events", "media_cache", "link_previews", "hidden_messages", "talk_identity_aliases"] as const) {
        this.db.query(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
      }
      this.db.query("DELETE FROM accounts WHERE account_id = ?").run(accountId);
    });
  }

  stats(accountId: string): { chats: number; messages: number; pending: number } {
    const row = this.db.query(`
      SELECT
        (SELECT COUNT(*) FROM chats WHERE account_id = ?) AS chats,
        (SELECT COUNT(*) FROM messages m
          WHERE m.account_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM hidden_messages h
              WHERE h.account_id = m.account_id
                AND h.chat_id = m.chat_id
                AND h.kind = m.kind
                AND h.message_id = m.id
            )) AS messages,
        (SELECT COUNT(*) FROM outbox WHERE account_id = ? AND status NOT IN ('sent', 'failed')) AS pending
    `).get(accountId, accountId, accountId) as Record<string, unknown>;
    return { chats: Number(row?.chats ?? 0), messages: Number(row?.messages ?? 0), pending: Number(row?.pending ?? 0) };
  }

  close(): void {
    this.db.close();
  }

  private transactionResult<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  private transaction(fn: () => void): void {
    this.transactionResult(() => {
      fn();
      return undefined;
    });
  }
}
