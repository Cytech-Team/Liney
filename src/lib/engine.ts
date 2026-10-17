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

class LineyEngine {
  private child: Child | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(event: EngineEvent) => void>();
  private started = false;
  private startPromise: Promise<boolean> | null = null;
  private lifecycleGeneration = 0;
  private lineBuffer = "";
  get isNative() {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  }

  async start() {
    if (!this.isNative) throw new EngineRequestError("Liney is available as a Desktop app only", "DESKTOP_ONLY");
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
    if (!this.isNative) throw new EngineRequestError("Desktop engine required", "DESKTOP_ONLY");
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
