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

const WEB_CONNECTOR_PAGE_SOURCE = "liney-web-app";
const WEB_CONNECTOR_SOURCE = "liney-connector";
const WEB_CONNECTOR_REQUEST = "liney.connector.request";
const WEB_CONNECTOR_RESPONSE = "liney.connector.response";

type WebConnectorError = {
  message?: string;
  code?: string;
  retryable?: boolean;
};

type WebConnectorResponse = {
  source?: string;
  type?: string;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: WebConnectorError | string;
};

type HomeRunnerResponse<T = unknown> = {
  ok?: boolean;
  result?: T;
  error?: WebConnectorError | string;
};

type HomeRunnerConfig = {
  url: string;
  token: string;
};

const DEFAULT_HOME_RUNNER_URL = "https://cdn.cytechteam.site/liney-runner";
const HOME_RUNNER_URL_KEY = "liney.homeRunner.url";
const HOME_RUNNER_TOKEN_KEY = "liney.homeRunner.token";

declare global {
  interface Window {
    lineyConnector?: {
      request<T = unknown>(method: string, params?: Record<string, unknown>, timeout?: number): Promise<T>;
    };
  }
}

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

  private homeRunnerConfig(): HomeRunnerConfig | null {
    if (typeof window === "undefined") return null;
    const search = new URLSearchParams(window.location.search);
    const urlFromQuery = search.get("runner") || search.get("lineyRunner") || search.get("liney-runner");
    const tokenFromQuery = search.get("runnerToken") || search.get("lineyToken") || search.get("liney-token");
    if (urlFromQuery) window.localStorage.setItem(HOME_RUNNER_URL_KEY, urlFromQuery);
    if (tokenFromQuery) window.localStorage.setItem(HOME_RUNNER_TOKEN_KEY, tokenFromQuery);
    if (urlFromQuery || tokenFromQuery) {
      search.delete("runner");
      search.delete("lineyRunner");
      search.delete("liney-runner");
      search.delete("runnerToken");
      search.delete("lineyToken");
      search.delete("liney-token");
      const nextUrl = `${window.location.pathname}${search.toString() ? `?${search}` : ""}${window.location.hash}`;
      window.history.replaceState({}, "", nextUrl);
    }
    const url = (window.localStorage.getItem(HOME_RUNNER_URL_KEY) || DEFAULT_HOME_RUNNER_URL).replace(/\/$/, "");
    let token = window.localStorage.getItem(HOME_RUNNER_TOKEN_KEY) || "";
    if (!token && window.location.pathname === "/app") {
      token = window.prompt("ใส่ Liney Home Runner token เพื่อเชื่อม Home Server โดยไม่ใช้ extension")?.trim() || "";
      if (token) window.localStorage.setItem(HOME_RUNNER_TOKEN_KEY, token);
    }
    return token ? { url, token } : null;
  }

  private async homeRunnerFetch<T>(path: string, init: RequestInit = {}, timeout = 15_000): Promise<T> {
    const config = this.homeRunnerConfig();
    if (!config) {
      throw new EngineRequestError(
        "Liney Home Runner token is missing. Open /app with ?runnerToken=... once, or set localStorage liney.homeRunner.token.",
        "RUNNER_TOKEN_REQUIRED",
        false,
      );
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${config.url}${path}`, {
        ...init,
        signal: controller.signal,
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.token}`,
          ...(init.headers || {}),
        },
      });
      const data = await response.json() as HomeRunnerResponse<T>;
      if (!response.ok || !data.ok) {
        const rawError = data.error;
        if (rawError && typeof rawError === "object") {
          throw new EngineRequestError(
            String(rawError.message ?? "Liney Home Runner request failed"),
            String(rawError.code ?? "RUNNER_ERROR"),
            Boolean(rawError.retryable),
          );
        }
        throw new EngineRequestError(String(rawError ?? `Liney Home Runner HTTP ${response.status}`), "RUNNER_ERROR", response.status >= 500);
      }
      return data.result as T;
    } catch (error) {
      if (error instanceof EngineRequestError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new EngineRequestError("Liney Home Runner timed out", "TIMEOUT", true);
      }
      throw new EngineRequestError(error instanceof Error ? error.message : String(error), "RUNNER_UNAVAILABLE", true);
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async homeRunnerRequest<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = 15_000): Promise<T> {
    if (method === "connector.events") {
      const after = Number(params.after ?? 0);
      return this.homeRunnerFetch<T>(`/events?after=${encodeURIComponent(String(after))}`, { method: "GET" }, timeout);
    }
    return this.homeRunnerFetch<T>("/rpc", {
      method: "POST",
      body: JSON.stringify({ method, params, timeout }),
    }, timeout);
  }

  private async startWebConnector(): Promise<boolean> {
    if (this.webStarted) return true;
    try {
      const capabilities = await this.webRequest<Record<string, unknown>>("capabilities", {}, 8_000);
      this.webStarted = true;
      this.started = true;
      this.startWebEventPolling();
      this.emit({
        type: "engine.ready",
        engine: "liney-connector",
        linejsVersion: String(capabilities.linejsVersion ?? "connector"),
        device: String(capabilities.device ?? "WEBEXT"),
        clientIdentity: capabilities.clientIdentity,
      });
      return true;
    } catch (error) {
      this.webStarted = false;
      this.started = false;
      this.emit({
        type: "engine.error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async webRequest<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = 15_000): Promise<T> {
    if (typeof window === "undefined") {
      throw new EngineRequestError("Liney Web runtime requires a browser window", "CONNECTOR_UNAVAILABLE", true);
    }
    if (this.homeRunnerConfig()) return this.homeRunnerRequest<T>(method, params, timeout);
    if (window.lineyConnector?.request) return window.lineyConnector.request<T>(method, params, timeout);

    const id = crypto.randomUUID();
    const targetOrigin = window.location.origin;
    const payload = {
      source: WEB_CONNECTOR_PAGE_SOURCE,
      type: WEB_CONNECTOR_REQUEST,
      id,
      method,
      params,
    };
    const promise = new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new EngineRequestError(
          "Liney Home Runner token is missing and no connector fallback responded",
          "RUNNER_TOKEN_REQUIRED",
          true,
        ));
      }, timeout);

      const onMessage = (event: MessageEvent<WebConnectorResponse>) => {
        if (event.source !== window || event.origin !== targetOrigin) return;
        const data = event.data;
        if (data?.source !== WEB_CONNECTOR_SOURCE || data.type !== WEB_CONNECTOR_RESPONSE || data.id !== id) return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (data.ok) {
          resolve(data.result as T);
          return;
        }
        const rawError = data.error;
        if (rawError && typeof rawError === "object") {
          reject(new EngineRequestError(
            String(rawError.message ?? "Liney Connector request failed"),
            String(rawError.code ?? "CONNECTOR_ERROR"),
            Boolean(rawError.retryable),
          ));
        } else {
          reject(new EngineRequestError(String(rawError ?? "Liney Connector request failed"), "CONNECTOR_ERROR"));
        }
      };

      window.addEventListener("message", onMessage);
    });

    window.postMessage(payload, targetOrigin);
    return promise;
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
    const command = Command.sidecar("binaries/liney-engine");
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
    if (!this.isNative) {
      this.stopWebEventPolling();
      this.webStarted = false;
    }
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
