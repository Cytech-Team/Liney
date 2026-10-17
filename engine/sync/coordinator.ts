import type { LineyDatabase } from "./database";

/**
 * SyncCoordinator — single owner of sync policy per AGENTS.md:9
 * Owns: priority, concurrency, cancellation, retries, freshness decisions.
 * Normal startup uses delta/background refresh (cache-first handlers).
 * Full sync is explicit via sync.start and touches all rooms bounded.
 */
export type SyncPriority = "active" | "unread" | "recent" | "other" | "media";
export type SyncMode = "full" | "delta";

const PRE_SYNCED_ROOM_MEMORY_LIMIT = 48;

type SyncJob = {
  kind: "talk" | "openchat";
  id: string;
  limit: number;
  priority: SyncPriority;
};

export class SyncCoordinator {
  private generation = 0;
  private promise: Promise<void> | null = null;
  private get accountId(): string { return this.deps.currentAccountId(); }

  constructor(
    private readonly database: LineyDatabase,
    private readonly emit: (payload: unknown) => void,
    private readonly deps: {
      currentAccountId: () => string;
      loadFriends: () => Promise<any[]>;
      loadChats: () => Promise<any[]>;
      loadOpenChats: () => Promise<any[]>;
      loadCachedFriends?: () => any[];
      loadCachedChats?: () => any[];
      loadCachedOpenChats?: () => any[];
      fetchTalk: (chatId: string, limit: number) => Promise<any[]>;
      fetchOpen: (chatId: string, limit: number) => Promise<any[]>;
      persistLists: (friends: any[], chats: any[], openChats: any[]) => void;
      persist: (chatId: string, isSquare: boolean, messages: any[]) => void;
      isHidden: (chatId: string, isSquare: boolean, messageId: string, kind: string) => boolean;
      isLiveOverlay?: (cacheKey: string) => boolean;
      warmImage: (id: string, square: boolean) => Promise<void>;
      // shared mutable caches owned by engine/main.ts — coordinator updates them
      getPreSynced: () => { chats: any[] | null; friends: any[] | null; openChats: any[] | null; messages: Map<string, any[]> };
      setPreSynced: (next: { chats?: any[] | null; friends?: any[] | null; openChats?: any[] | null }) => void;
    },
  ) {}

  status() {
    return {
      generation: this.generation,
      running: this.promise !== null,
      state: this.database.getSyncState(this.accountId, "account"),
      stats: this.database.stats(this.accountId),
    };
  }

  cancel() {
    this.generation += 1;
    this.promise = null;
    this.database.setSyncState(this.accountId, {
      key: "account",
      generation: this.generation,
      status: "idle",
    });
  }

  async startFull(mode: SyncMode = "full"): Promise<void> {
    if (this.promise) return this.promise;
    const transient = this.deps.getPreSynced();
    if (mode === "full") {
      transient.messages.clear();
      this.deps.setPreSynced({ chats: null, friends: null, openChats: null });
    }
    const previousTalk = new Map((this.deps.loadCachedChats?.() ?? []).map((room: any) => [String(room.id), room]));
    const previousOpen = new Map((this.deps.loadCachedOpenChats?.() ?? []).map((room: any) => [String(room.id), room]));
    const generation = ++this.generation;
    const startedAt = Date.now();
    this.database.setSyncState(this.accountId, { key: "account", generation, status: "running" });
    this.emit({ type: "sync.start", phase: "metadata", mode, generation });

    const runPool = async <T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) => {
      let cursor = 0;
      const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (cursor < items.length) {
          const index = cursor++;
          if (generation !== this.generation) return;
          await worker(items[index], index);
        }
      });
      await Promise.all(runners);
    };

    this.promise = (async () => {
      try {
        const metadataFailures: string[] = [];
        const loadMetadata = async (
          kind: string,
          load: () => Promise<any[]>,
          loadCached?: () => any[],
        ): Promise<any[]> => {
          try {
            return await load();
          } catch (error) {
            const message = String(error instanceof Error ? error.message : error);
            metadataFailures.push(kind);
            let cached: any[] = [];
            try { cached = loadCached?.() ?? []; } catch { /* use an empty fallback */ }
            this.emit({
              type: "sync.metadata_error",
              kind,
              error: message,
              usingCache: cached.length > 0,
              generation,
            });
            return cached;
          }
        };

        // Independent metadata calls run together; slow friend loading must not
        // delay discovery of chats and OpenChats.
        const [friends, freshTalkChats, freshOpenChats] = await Promise.all([
          loadMetadata("friends", this.deps.loadFriends, this.deps.loadCachedFriends),
          loadMetadata("chats", this.deps.loadChats, this.deps.loadCachedChats),
          loadMetadata("openchats", this.deps.loadOpenChats, this.deps.loadCachedOpenChats),
        ]);
        if (generation !== this.generation) return;
        this.deps.setPreSynced({ friends });
        this.emit({ type: "sync.progress", phase: "friends", done: friends.length, total: friends.length, mode, generation });

        // Never drop cached conversations just because a remote listing is partial.
        const mergeRooms = (fresh: any[], cached: any[] = []) => {
          const byId = new Map<string, any>();
          for (const room of cached) if (room?.id) byId.set(String(room.id), room);
          for (const room of fresh) if (room?.id) byId.set(String(room.id), room);
          return [...byId.values()];
        };
        const talkChats = mergeRooms(freshTalkChats, this.deps.loadCachedChats?.());
        const openChats = mergeRooms(freshOpenChats, this.deps.loadCachedOpenChats?.());
        if (generation !== this.generation) return;
        this.deps.persistLists(friends, talkChats, openChats);
        this.deps.setPreSynced({ chats: talkChats, openChats });
        this.emit({ type: "sync.progress", phase: "chats", done: talkChats.length + openChats.length, total: talkChats.length + openChats.length, mode, generation });

        // Priority: active/unread/recent first — sort by lastMessageTime/unread
        const prioritized = (chats: any[], kind: "talk" | "openchat"): SyncJob[] =>
          chats
            .map((c) => ({
              kind,
              id: String(c.id),
              limit: kind === "openchat" ? 25 : 35,
              priority: (c.unread > 0 ? "unread" : c.lastMessageTime > Date.now() - 7 * 24 * 60 * 60_000 ? "recent" : "other") as SyncPriority,
            }))
            .sort((a, b) => {
              const order: Record<SyncPriority, number> = { active: 0, unread: 1, recent: 2, other: 3, media: 4 };
              return order[a.priority] - order[b.priority];
            });

        const priorityRank: Record<SyncPriority, number> = { active: 0, unread: 1, recent: 2, other: 3, media: 4 };
        const jobs: SyncJob[] = [...prioritized(talkChats, "talk"), ...prioritized(openChats, "openchat")]
          .filter((job) => {
            if (mode === "full") return true;
            const old = (job.kind === "talk" ? previousTalk : previousOpen).get(job.id);
            const fresh = (job.kind === "talk" ? talkChats : openChats).find((room: any) => String(room.id) === job.id);
            const priorState = this.database.getSyncState(this.accountId, `${job.kind}:${job.id}`);
            return !old || priorState?.status !== "ready"
              || Number(fresh?.unread ?? 0) > 0
              || Number(fresh?.lastMessageTime ?? 0) > Number(old?.lastMessageTime ?? 0);
          })
          .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
        let done = 0;
        let failed = 0;
        await runPool(jobs, 4, async (job) => {
          try {
            const messages = job.kind === "openchat" ? await this.deps.fetchOpen(job.id, job.limit) : await this.deps.fetchTalk(job.id, job.limit);
            if (generation !== this.generation) return;
            const cacheKey = `${job.kind}:${job.id}`;
            const cached = this.deps.getPreSynced().messages;
            const isHidden = (msg: any) => this.deps.isHidden(job.id, job.kind === "openchat", String(msg?.id ?? ""), job.kind === "openchat" ? "openchat" : "dm");
            const visible = messages.filter((m: any) => !isHidden(m));
            if (this.deps.isLiveOverlay?.(cacheKey)) {
              // live event already provided fresher data; keep SQLite persist but don't overwrite in-memory overlay
            } else {
              cached.delete(cacheKey);
              cached.set(cacheKey, visible);
              while (cached.size > PRE_SYNCED_ROOM_MEMORY_LIMIT) {
                const first = cached.keys().next().value;
                if (!first) break;
                cached.delete(first);
              }
            }
            this.deps.persist(job.id, job.kind === "openchat", visible);
            this.database.setSyncState(this.accountId, { key: `${job.kind}:${job.id}`, generation, status: "ready" });
          } catch (e) {
            if (generation !== this.generation) return;
            failed += 1;
            this.database.setSyncState(this.accountId, { key: `${job.kind}:${job.id}`, generation, status: "error", error: String(e instanceof Error ? e.message : e) });
            this.emit({ type: "sync.room_error", kind: job.kind, chatId: job.id, error: String(e instanceof Error ? e.message : e), generation });
          } finally {
            done += 1;
            if (generation === this.generation && (done === jobs.length || done % 5 === 0)) {
              this.emit({ type: "sync.progress", phase: "history", done, total: jobs.length, failed, mode, generation });
            }
          }
        });

        // Bounded media warm (viewport will lazy-load rest)
        const imageJobs: { id: string; square: boolean }[] = [];
        for (const [key, messages] of this.deps.getPreSynced().messages) {
          const square = key.startsWith("openchat:");
          const recent = [...messages].reverse().filter((m: any) => m.contentType === 1).slice(0, 1);
          for (const item of recent) imageJobs.push({ id: String(item.id), square });
          if (imageJobs.length >= 24) break;
        }
        await runPool(imageJobs.slice(0, 24), 3, async (item) => {
          try { await this.deps.warmImage(item.id, item.square); } catch { /* lazy retry */ }
        });

        if (generation !== this.generation) return;
        this.emit({ type: "sync.ready", mode, generation, summary: { friends: friends.length, talkChats: talkChats.length, openChats: openChats.length, histories: this.deps.getPreSynced().messages.size, failedHistories: failed, failedMetadata: metadataFailures, elapsedMs: Date.now() - startedAt } });
        const syncError = failed
          ? `${failed} room(s) failed`
          : metadataFailures.length
            ? `Using cached data for: ${metadataFailures.join(", ")}`
            : undefined;
        this.database.setSyncState(this.accountId, { key: "account", generation, status: failed || metadataFailures.length ? "error" : "ready", error: syncError });
        if (mode === "full" && !failed && !metadataFailures.length) {
          this.database.setSyncState(this.accountId, { key: "full-complete", generation, status: "ready" });
        }
      } catch (error) {
        if (generation !== this.generation) return;
        const message = String(error instanceof Error ? error.message : error);
        this.database.setSyncState(this.accountId, { key: "account", generation, status: "error", error: message });
        this.emit({ type: "sync.error", mode, generation, error: message });
        throw error;
      } finally {
        if (this.generation === generation) this.promise = null;
      }
    })();
    return this.promise;
  }
}
