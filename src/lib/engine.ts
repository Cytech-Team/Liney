import { Command, type Child } from "@tauri-apps/plugin-shell";

const PROTOCOL_VERSION = 1;

export type EngineEvent = Record<string, unknown> & { type?: string };
export type EngineErrorPayload = {
  code?: string;
  message?: string;
  retryable?: boolean;
};

export class EngineRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = "ENGINE_ERROR", retryable = false) {
    super(message);
    this.name = "EngineRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Browser-side Liney uses localhost directly; no extension or remote runner.
const LOCAL_ENGINE_URL = "http://127.0.0.1:39211/liney-runner";
const LOCAL_TOKEN_KEY = "liney.web.localEngineToken";

type LocalResult<T> = {
  ok?: boolean;
  result?: T;
  error?: { message?: string; code?: string; retryable?: boolean };
};

class LineyEngine {
  private child: Child | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: EngineEvent) => void>();
  private started = false;
  private startPromise: Promise<boolean> | null = null;
  private lifecycleGeneration = 0;
  private lineBuffer = "";
  private webStarted = false;
  private webEventCursor = 0;
  private webEventTimer: ReturnType<typeof setInterval> | null = null;

  private localAccessToken = "";

  setLocalToken(token: string): void {
    const value = token.trim();
    if (!/^[A-Za-z0-9_-]{48,160}$/.test(value)) {
      throw new EngineRequestError("กรอก Local Engine token ที่แสดงจากเครื่องนี้", "LOCAL_TOKEN_INVALID");
    }
    this.localAccessToken = value;
    // Per-tab session storage only. No token or LINE data is sent to Cloudflare.
    try { sessionStorage.setItem(LOCAL_TOKEN_KEY, value); } catch { /* private browsing */ }
  }

  hasLocalToken(): boolean {
    if (this.isNative) return true;
    if (this.localAccessToken) return true;
    try { return Boolean(sessionStorage.getItem(LOCAL_TOKEN_KEY)); } catch { return false; }
  }

  private readLocalToken(): string {
    if (this.localAccessToken) return this.localAccessToken;
    try { return sessionStorage.getItem(LOCAL_TOKEN_KEY) || ""; } catch { return ""; }
  }

  get isNative() {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  }

  async start() {
    if (!this.isNative) return this.startWebConnector();
    if (this.started) return this.started;
    if (this.startPromise) return this.startPromise;
    const promise = this.startInternal();
    this.startPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = null;
    }
  }

  private async startWebConnector(): Promise<boolean> {
    if (this.webStarted) return true;
    try {
      if (!this.hasLocalToken()) {
        throw new EngineRequestError("ต้องเปิด Local Engine บนเครื่องนี้และกรอก token ก่อน ไม่จำเป็นต้องใช้ Extension", "LOCAL_TOKEN_REQUIRED");
      }
      const health = await this.localFetch<{ mode?: string; transport?: string }>("/health", undefined, 6_000);
      if (health.mode !== "local-device" || health.transport !== "loopback") {
        throw new EngineRequestError("ต้องใช้ Liney Local Engine ที่รันบนเครื่องนี้เท่านั้น", "LOCAL_ONLY");
      }
      const capabilities = await this.webRequest<Record<string, unknown>>("capabilities", {}, 8_000);
      this.webStarted = true;
      this.started = true;
      this.startWebEventPolling();
      this.emit({
        type: "engine.ready",
        engine: "liney-local-engine",
        linejsVersion: String(capabilities.linejsVersion ?? "local"),
        device: String(capabilities.device ?? "DESKTOPWIN"),
        clientIdentity: capabilities.clientIdentity,
      });
      return true;
    } catch (error) {
      this.webStarted = false;
      this.started = false;
      this.emit({ type: "engine.error", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async localFetch<T>(path: string, requestBody?: Record<string, unknown>, timeout = 15_000): Promise<T> {
    if (typeof window === "undefined") {
      throw new EngineRequestError("Web browser required", "LOCAL_ENGINE_UNAVAILABLE");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeout));
    try {
      const response = await fetch(LOCAL_ENGINE_URL + path, {
        method: requestBody ? "POST" : "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        // Chromium's Local Network Access prompt checks loopback permission;
        // this also opts local HTTP out of public-origin mixed-content blocking.
        ...({ targetAddressSpace: "loopback" } as RequestInit),
        headers: path === "/health" ? {} : {
          ...(requestBody ? { "Content-Type": "application/json" } : {}),
          Authorization: "Bearer " + this.readLocalToken(),
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        signal: controller.signal,
      });
      const payload = await response.json() as LocalResult<T> & T;
      if (!response.ok || payload.ok === false) {
        throw new EngineRequestError(
          String(payload.error?.message || "Local Engine rejected request"),
          String(payload.error?.code || "LOCAL_ENGINE_ERROR"),
          response.status >= 500,
        );
      }
      return payload.result !== undefined ? payload.result : payload as T;
    } catch (error) {
      if (error instanceof EngineRequestError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new EngineRequestError("Local Engine ตอบกลับไม่ทันเวลา", "TIMEOUT", true);
      }
      throw new EngineRequestError(
        "ไม่พบ Local Engine ที่ 127.0.0.1:39211 หรือ Chrome ยังไม่อนุญาต Local network; เปิด Engine บนเครื่องนี้ก่อน",
        "LOCAL_ENGINE_UNAVAILABLE",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async webRequest<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = 15_000): Promise<T> {
    if (!this.hasLocalToken()) throw new EngineRequestError("กรอก Local Engine token ก่อน", "LOCAL_TOKEN_REQUIRED");
    if (method === "connector.events") {
      const after = Number(params.after ?? 0);
      return this.localFetch<T>("/events?after=" + encodeURIComponent(String(Number.isFinite(after) ? after : 0)), undefined, timeout);
    }
    return this.localFetch<T>("/rpc", { method, params, timeout }, timeout);
  }

  private startWebEventPolling() {
    if (typeof window === "undefined" || this.webEventTimer) return;
    const poll = async () => {
      try {
        const result = await this.webRequest<{ cursor?: number; events?: EngineEvent[] }>("connector.events", { after: this.webEventCursor }, 8_000);
        const events = Array.isArray(result.events) ? result.events : [];
        if (typeof result.cursor === "number") this.webEventCursor = Math.max(this.webEventCursor, result.cursor);
        for (const event of events) {
          const seq = typeof event.seq === "number" ? event.seq : Number(event.seq ?? 0);
          if (seq > this.webEventCursor) this.webEventCursor = seq;
          this.emit(event);
        }
      } catch {
        // Keep polling lightweight; foreground requests surface actionable errors.
      }
    };
    void poll();
    this.webEventTimer = window.setInterval(() => void poll(), 1_000);
  }

  private stopWebEventPolling() {
    if (this.webEventTimer) window.clearInterval(this.webEventTimer);
    this.webEventTimer = null;
  }

  private async startInternal(): Promise<boolean> {
    const generation = ++this.lifecycleGeneration;
    // Bun's native fetch pool defaults to a very high concurrency. LINEJS's
    // long-lived PUSH/polling traffic can otherwise fan out into hundreds of
    // SYN-SENT sockets when a LINE edge is slow/unreachable, eventually
    // freezing the desktop process. Keep the sidecar pool intentionally small;
    // Liney's normal RPC/media workload does not need hundreds of simultaneous
    // HTTP connections.
    const command = Command.sidecar("binaries/liney-engine", [], {
      env: { BUN_CONFIG_MAX_HTTP_REQUESTS: "8" },
    });
    command.stdout.on("data", (data) => {
      if (generation === this.lifecycleGeneration) this.consume(String(data));
    });
    command.stderr.on("data", (data) => {
      if (generation === this.lifecycleGeneration) this.emit({ type: "engine.stderr", message: String(data) });
    });
    command.on("error", (error) => {
      if (generation === this.lifecycleGeneration) this.emit({ type: "engine.error", message: String(error) });
    });
    command.on("close", ({ code }) => {
      if (generation !== this.lifecycleGeneration) return;
      this.started = false;
      this.child = null;
      this.lineBuffer = "";
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new EngineRequestError(`LINE engine closed${code === null ? "" : ` (code ${code})`}`, "ENGINE_CLOSED", true));
      }
      this.pending.clear();
      this.emit({ type: "engine.closed", code });
    });
    const child = await command.spawn();
    if (generation !== this.lifecycleGeneration) {
      await child.kill().catch(() => undefined);
      throw new EngineRequestError("LINE engine stopped", "ENGINE_STOPPED", true);
    }
    this.child = child;
    this.started = true;
    try {
      await this.request("ping", {}, 8_000);
    } catch (error) {
      if (generation === this.lifecycleGeneration) await this.stop();
      throw error;
    }
    return true;
  }

  on(listener: (event: EngineEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = 15_000): Promise<T> {
    if (!this.isNative) return this.webRequest<T>(method, params, timeout);
    if (!this.child) throw new Error("LINE engine is not running");
    const id = crypto.randomUUID();
    const payload = `${JSON.stringify({ id, version: PROTOCOL_VERSION, method, params })}\n`;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineRequestError(`${method} timed out`, "TIMEOUT", true));
      }, timeout);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
    try {
      await this.child.write(payload);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return promise;
  }

  async stop() {
    if (!this.isNative) {
      this.stopWebEventPolling();
      this.webStarted = false;
      this.started = false;
      return;
    }
    this.lifecycleGeneration += 1;
    const child = this.child;
    this.child = null;
    this.started = false;
    this.lineBuffer = "";
    if (child) await child.kill().catch(() => undefined);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new EngineRequestError("LINE engine stopped", "ENGINE_STOPPED", true));
    }
    this.pending.clear();
  }

  private consume(raw: string) {
    this.lineBuffer += raw;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed) as Record<string, unknown>;
        const id = typeof message.id === "string" ? message.id : undefined;
        if (id && this.pending.has(id)) {
          const pending = this.pending.get(id)!;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          if (message.ok === false) {
            const error = message.error;
            if (error && typeof error === "object") {
              const payload = error as EngineErrorPayload;
              pending.reject(new EngineRequestError(
                String(payload.message ?? "engine request failed"),
                String(payload.code ?? "ENGINE_ERROR"),
                Boolean(payload.retryable),
              ));
            } else {
              pending.reject(new EngineRequestError(String(error ?? "engine request failed")));
            }
          }
          else pending.resolve(message.result);
          continue;
        }
        const event = message.type && message.payload && typeof message.payload === "object"
          ? { ...message, ...(message.payload as Record<string, unknown>) }
          : message;
        this.emit(event as EngineEvent);
      } catch {
        this.emit({ type: "engine.raw", message: trimmed });
      }
    }
  }

  private emit(event: EngineEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

export const lineyEngine = new LineyEngine();
