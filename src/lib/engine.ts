import {desktop} from "./electron-bridge";

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

class LineyEngine {
  private electronUnsubscribe: (()=>void) | null = null;
  private listeners = new Set<(event: EngineEvent) => void>();
  private started = false;
  private startPromise: Promise<boolean> | null = null;
  private lifecycleGeneration = 0;
  get isNative() {
    return typeof window !== "undefined" && Boolean(window.lineyDesktop);
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
    this.electronUnsubscribe = desktop().onEngine((packet)=>{
      if (generation !== this.lifecycleGeneration) return;
      const event=packet.type && packet.payload && typeof packet.payload==="object"
        ? {...packet,...packet.payload as Record<string,unknown>}:packet;
      this.emit(event as EngineEvent);
    });
    try {
      await desktop().start();
      this.started=true;
      await this.request("ping",{},8000);
      return true;
    } catch (error) {
      this.electronUnsubscribe?.();
      this.electronUnsubscribe=null;
      this.started=false;
      throw error;
    }
  }

  on(listener: (event: EngineEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeout = 15_000): Promise<T> {
    if (!this.isNative) throw new EngineRequestError("Desktop engine required", "DESKTOP_ONLY");
    if (!this.started) throw new EngineRequestError("LINE engine is not running", "ENGINE_CLOSED", true);
    try { return await desktop().request<T>(method, params, timeout); }
    catch (error) {
      const code=(error as {code?:string})?.code||"ENGINE_ERROR";
      throw new EngineRequestError(error instanceof Error?error.message:String(error),code,true);
    }
  }

  async stop() {
    this.lifecycleGeneration += 1;
    this.electronUnsubscribe?.();
    this.electronUnsubscribe=null;
    this.started=false;
    await desktop().stop().catch(()=>undefined);
  }

  private emit(event: EngineEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

export const lineyEngine = new LineyEngine();
