import {
  CallSession,
  PlanetTransport,
  opusCodecFactory,
  type CallTransport,
  type CodecFactory,
  type CallSessionState,
} from "@evex/linejs/call";
import type { Client } from "@evex/linejs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

export type CallEvent = {
  type: "call.state" | "call.incoming" | "call.error" | "call.ready" | "call.ended";
  callId?: string;
  peer?: string;
  state?: CallSessionState | "incoming";
  reason?: string;
  error?: string;
  source?: "talk";
};

type CallClientLike = Client & {
  call: {
    startSession(opts: Record<string, unknown>): CallSession;
    setCodecFactory(factory: unknown): void;
  };
};

type AudioDevice = {
  id: string;
  name: string;
  description: string;
  kind: "input" | "output";
};

type PipeWireProbe = {
  available: boolean;
  reason?: string;
};

// Route acquisition and the peer's ringing window are both part of
// CallSession.start(). Keep the outer guard longer than PLANET's 60s answer
// wait so a normal unanswered call reaches the transport timeout first.
const CALL_SETUP_TIMEOUT_MS = 75_000;
const CALL_ANSWER_TIMEOUT_MS = 60_000;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 1;
const AUDIO_FRAME_MS = 20;
const AUDIO_FRAME_SAMPLES = (AUDIO_SAMPLE_RATE * AUDIO_FRAME_MS) / 1000;

function hasCommand(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return !result.error && (result.status === 0 || result.status === 1);
}

function safePipeWireTarget(value: unknown): string | undefined {
  const target = typeof value === "string" ? value.trim() : "";
  if (!target || target.length > 256 || target.includes("\u0000")) return undefined;
  return target;
}

function probePipeWire(): PipeWireProbe {
  if (!hasCommand("pw-cat")) {
    return { available: false, reason: "PipeWire/pw-cat is unavailable" };
  }
  if (!hasCommand("pw-cli")) {
    return { available: false, reason: "PipeWire/pw-cli is unavailable" };
  }
  const result = spawnSync("pw-cli", ["info", "0"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return { available: false, reason: "PipeWire session is not reachable" };
  }
  return { available: true };
}

function listPipeWireDevices(): { inputs: AudioDevice[]; outputs: AudioDevice[] } {
  if (!hasCommand("pw-dump")) return { inputs: [], outputs: [] };
  const result = spawnSync("pw-dump", [], {
    encoding: "utf8",
    timeout: 3_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return { inputs: [], outputs: [] };
  }
  try {
    const nodes = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(nodes)) return { inputs: [], outputs: [] };
    const inputs: AudioDevice[] = [];
    const outputs: AudioDevice[] = [];
    for (const item of nodes) {
      if (!item || typeof item !== "object") continue;
      const record = item as { id?: unknown; info?: { props?: Record<string, unknown> } };
      const props = record.info?.props;
      const mediaClass = typeof props?.["media.class"] === "string" ? props["media.class"] : "";
      const kind = mediaClass === "Audio/Source"
        ? "input"
        : mediaClass === "Audio/Sink"
          ? "output"
          : undefined;
      if (!kind) continue;
      const id = String(record.id ?? "");
      const name = String(props?.["node.name"] ?? "");
      const description = String(props?.["node.description"] ?? props?.["node.nick"] ?? name);
      if (!id || !name) continue;
      const device = { id, name, description, kind } satisfies AudioDevice;
      if (kind === "input") inputs.push(device);
      else outputs.push(device);
    }
    return { inputs, outputs };
  } catch {
    return { inputs: [], outputs: [] };
  }
}

function toSamples(buffer: Buffer): Int16Array {
  const aligned = buffer.length - (buffer.length % Int16Array.BYTES_PER_ELEMENT);
  const copy = new Uint8Array(aligned);
  copy.set(buffer.subarray(0, aligned));
  return new Int16Array(copy.buffer);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type AsyncIteratorResult<T> = IteratorResult<T>;

async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<AsyncIteratorResult<T> | null> {
  if (signal.aborted) return null;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      resolve(null);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then((result) => {
      cleanup();
      resolve(result);
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function* abortablePackets<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      const result = await nextWithAbort(iterator, signal);
      if (!result || result.done) return;
      yield result.value;
    }
  } finally {
    // Do not await return(): a transport may be waiting on a socket read. The
    // owning CallManager closes that transport immediately during stop().
    void iterator.return?.();
  }
}

class PipeWireSource {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;

  constructor(private readonly target?: string) {}

  async *frames(opts: { signal?: AbortSignal } = {}): AsyncIterable<{ samples: Int16Array; sampleRate: number; channels: number }> {
    if (this.child) throw new Error("microphone source already consumed");
    const args = [
      "--raw", "--record", "--format", "s16", "--rate", String(AUDIO_SAMPLE_RATE),
      "--channels", String(AUDIO_CHANNELS), "--media-category", "Capture",
      "--media-role", "Communication", "--latency", `${AUDIO_FRAME_MS}ms`,
      ...(this.target ? ["--target", this.target] : []), "-",
    ];
    const child = spawn("pw-cat", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stderr.resume();
    let buffer = Buffer.alloc(0);
    const frameBytes = AUDIO_FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;
    const abort = () => this.close();
    opts.signal?.addEventListener("abort", abort, { once: true });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    try {
      for await (const chunk of child.stdout as Readable) {
        if (this.stopped || opts.signal?.aborted) return;
        buffer = Buffer.concat([buffer, Buffer.from(chunk as Uint8Array)]);
        while (buffer.length >= frameBytes) {
          const frame = buffer.subarray(0, frameBytes);
          buffer = buffer.subarray(frameBytes);
          yield { samples: toSamples(frame), sampleRate: 48_000, channels: 1 };
        }
      }
      if (spawnError) throw spawnError;
    } finally {
      opts.signal?.removeEventListener("abort", abort);
      await this.close();
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    if (child.exitCode === null) {
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
    }
    await waitForExit(child);
  }
}

class PipeWireSink {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;

  constructor(private target?: string) {}

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    this.child = spawn("pw-cat", [
      "--raw", "--playback", "--format", "s16", "--rate", String(AUDIO_SAMPLE_RATE),
      "--channels", String(AUDIO_CHANNELS), "--media-category", "Playback",
      "--media-role", "Communication", "--latency", `${AUDIO_FRAME_MS}ms`,
      ...(this.target ? ["--target", this.target] : []), "-",
    ], { stdio: ["pipe", "ignore", "pipe"] });
    this.child.stderr.resume();
    this.child.once("error", () => { this.stopped = true; });
    return this.child;
  }

  async write(frame: { samples: Int16Array }): Promise<void> {
    if (this.stopped) throw new Error("speaker output is unavailable");
    const child = this.ensureChild();
    const bytes = Buffer.from(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.stdin.off("error", onError);
        child.stdin.off("drain", onDrain);
        child.off("close", onClose);
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("speaker output closed")); };
      const onDrain = () => { cleanup(); resolve(); };
      child.stdin.once("error", onError);
      child.once("close", onClose);
      try {
        if (child.stdin.write(bytes)) {
          cleanup();
          resolve();
        } else {
          child.stdin.once("drain", onDrain);
        }
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async setTarget(target?: string): Promise<void> {
    if (this.target === target) return;
    const child = this.child;
    this.child = undefined;
    this.stopped = false;
    this.target = target;
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    await waitForExit(child);
  }

  async end(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    await waitForExit(child);
  }
}

class PlanetAudioTransport implements CallTransport {
  readonly planet: PlanetTransport;
  answer: { mediaReady?: boolean } | undefined;
  private rejectAnswer: ((error: Error) => void) | null = null;

  constructor(localMid: string, onRemoteEnd: () => void) {
    this.planet = new PlanetTransport({
      localMid,
      serviceKey: "freecall.audio",
      mediaKeyMode: "audio-reverse-stage",
      rtpTimestampStep: AUDIO_FRAME_SAMPLES,
      timeoutMs: 10_000,
      keepaliveIntervalMs: 5_000,
      debug: (event) => {
        if (event.type === "rel_req") {
          this.rejectAnswer?.(new Error("remote ended the call"));
          this.rejectAnswer = null;
          onRemoteEnd();
        }
      },
    });
  }

  connect(opts: Parameters<CallTransport["connect"]>[0]): Promise<void> {
    return this.planet.connect(opts);
  }

  invite(opts: { to: string }): Promise<unknown> {
    return this.planet.invite(opts);
  }

  async waitForAnswer(_opts?: { to: string }): Promise<unknown> {
    const remoteEnded = new Promise<never>((_, reject) => { this.rejectAnswer = reject; });
    try {
      this.answer = await Promise.race([
        this.planet.waitForAnswerDetailed({
          autoConnRsp: true,
          timeoutMs: CALL_ANSWER_TIMEOUT_MS,
        }),
        remoteEnded,
      ]);
      return this.answer;
    } finally {
      this.rejectAnswer = null;
    }
  }

  send(packet: Uint8Array): Promise<void> {
    return this.planet.send(packet, { timestampStep: AUDIO_FRAME_SAMPLES });
  }

  sendAudio(packet: Uint8Array): Promise<void> {
    return this.planet.send(packet, { timestampStep: AUDIO_FRAME_SAMPLES });
  }

  receive(): AsyncIterable<Uint8Array> {
    return this.planet.receive();
  }

  close(): Promise<void> {
    return this.planet.close();
  }
}

export class CallManager {
  private readonly emitEvent: (event: CallEvent) => void;
  private client: CallClientLike | null = null;
  private session: CallSession | null = null;
  private activeTransport: PlanetAudioTransport | null = null;
  private input: PipeWireSource | null = null;
  private output: PipeWireSink | null = null;
  private audioAbort: AbortController | null = null;
  private incoming: { callId: string; from: string; kind: string } | null = null;
  private muted = false;
  private inputTarget: string | undefined;
  private outputTarget: string | undefined;
  private codecReady: Promise<CodecFactory> | null = null;
  private stopInFlight: Promise<void> | null = null;

  constructor(emitEvent: (event: CallEvent) => void) {
    this.emitEvent = emitEvent;
  }

  get enabled(): boolean {
    return this.status.enabled;
  }

  get status(): {
    enabled: boolean;
    audio: boolean;
    transport: "planet" | "unavailable";
    incomingAnswer: boolean;
    liveValidated: boolean;
    reason?: string;
  } {
    if (process.env.LINEY_DISABLE_CALLS === "1" || process.env.LINEY_ENABLE_CALLS === "0") {
      return {
        enabled: false,
        audio: false,
        transport: "unavailable",
        incomingAnswer: false,
        liveValidated: false,
        reason: "calls are disabled by configuration",
      };
    }
    const pipewire = probePipeWire();
    if (!pipewire.available) {
      return {
        enabled: false,
        audio: false,
        transport: "unavailable",
        incomingAnswer: false,
        liveValidated: false,
        reason: pipewire.reason,
      };
    }
    const devices = listPipeWireDevices();
    if (!devices.inputs.length || !devices.outputs.length) {
      return {
        enabled: false,
        audio: false,
        transport: "unavailable",
        incomingAnswer: false,
        liveValidated: false,
        reason: "PipeWire microphone and speaker are required for calls",
      };
    }
    return {
      enabled: true,
      audio: true,
      transport: "planet",
      // LINEJS exposes incoming notifications, but not a stable modern
      // 1:1 answer flow. Do not advertise a button that cannot answer.
      incomingAnswer: false,
      liveValidated: process.env.LINEY_CALL_LIVE_VALIDATED === "1",
    };
  }

  get devices(): { inputs: AudioDevice[]; outputs: AudioDevice[] } {
    return listPipeWireDevices();
  }

  attach(client: Client): void {
    this.client = client as CallClientLike;
  }

  rememberIncoming(event: { callMid?: string; from?: string; kind?: string }): void {
    const callId = String(event.callMid ?? "");
    const from = String(event.from ?? "");
    if (!callId || !from) return;
    this.incoming = { callId, from, kind: String(event.kind ?? "AUDIO").toUpperCase() };
    this.emitEvent({ type: "call.incoming", callId, peer: from, state: "incoming", source: "talk" });
  }

  async start(peer: string): Promise<{ callId: string; state: CallSessionState }> {
    if (!this.enabled) throw new Error(this.status.reason ?? "call audio is unavailable");
    if (!this.client) throw new Error("not authenticated");
    if (this.session) throw new Error("another call is already active");
    this.muted = false;
    const profile = await this.client.getMyProfile();
    const localMid = String((profile as { mid?: string }).mid ?? "").trim();
    if (!localMid) throw new Error("LINE profile has no user mid for call setup");
    const codecs = await this.loadCodec();
    const transport = new PlanetAudioTransport(localMid, () => {
      void this.stop("remote-ended");
    });
    this.activeTransport = transport;
    const session = this.client.call.startSession({
      to: peer,
      kind: "AUDIO",
      fromEnvInfo: { devname: process.env.LINEY_CALL_DEVNAME?.trim() || "Android" },
      codecs,
      transport,
    });
    this.bindSession(session, peer);
    this.session = session;
    try {
      await withTimeout(session.start(), CALL_SETUP_TIMEOUT_MS, "outgoing call setup timed out");
      if (!transport.answer?.mediaReady) {
        throw new Error("peer answered, but LINE audio media negotiation was not ready");
      }
      await this.startAudioPipelines(transport, codecs);
      const callId = crypto.randomUUID();
      this.emitEvent({ type: "call.ready", callId, peer, state: "in-call" });
      return { callId, state: session.state };
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async accept(): Promise<void> {
    this.incoming = null;
    throw new Error("incoming LINE 1:1 answering is not exposed by the current LINEJS PLANET API");
  }

  async reject(): Promise<{ rejected: boolean; remoteNotified: boolean }> {
    this.incoming = null;
    // The notification stream does not expose a reject RPC. Clearing the local
    // prompt is honest; the remote LINE client will receive its own timeout or
    // cancel event rather than a fabricated answer.
    return { rejected: true, remoteNotified: false };
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    this.emitEvent({ type: "call.state", state: this.session?.state ?? "idle", reason: muted ? "muted" : "unmuted" });
  }

  async stop(reason = "user-ended"): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    const cleanup = this.stopInternal(reason);
    this.stopInFlight = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.stopInFlight === cleanup) this.stopInFlight = null;
    }
  }

  private async stopInternal(reason: string): Promise<void> {
    const session = this.session;
    this.session = null;
    this.incoming = null;
    this.muted = false;
    this.audioAbort?.abort();
    this.audioAbort = null;
    await this.input?.close().catch(() => undefined);
    await this.output?.end().catch(() => undefined);
    this.input = null;
    this.output = null;
    await session?.end(reason).catch(() => undefined);
    if (!session) await this.activeTransport?.close().catch(() => undefined);
    this.activeTransport = null;
    this.emitEvent({ type: "call.ended", reason, state: "ended" });
  }

  async setOutputTarget(value: unknown): Promise<{ target?: string }> {
    const target = safePipeWireTarget(value);
    if (target) {
      const { outputs } = this.devices;
      if (!outputs.length) throw new Error("no PipeWire output devices are available");
      if (!outputs.some((device) => device.id === target || device.name === target)) {
        throw new Error("selected PipeWire output was not found");
      }
    }
    this.outputTarget = target;
    await this.output?.setTarget(target);
    return target ? { target } : {};
  }

  private async loadCodec(): Promise<CodecFactory> {
    this.codecReady ??= opusCodecFactory();
    const codec = await this.codecReady;
    this.client?.call.setCodecFactory(codec);
    return codec;
  }

  private bindSession(session: CallSession, peer: string): void {
    session.on("state", (state) => this.emitEvent({ type: "call.state", peer, state }));
    session.on("error", (error) => this.emitEvent({ type: "call.error", peer, error: error.message }));
    session.on("ended", (reason) => {
      // CallManager.stop() clears the current session before asking
      // CallSession to close, so normal local cleanup emits exactly one
      // terminal event. Clean up a session that ends on its own.
      if (this.session === session) void this.stop(reason).catch(() => undefined);
    });
  }

  private async startAudioPipelines(transport: PlanetAudioTransport, codecs: CodecFactory): Promise<void> {
    const input = new PipeWireSource(this.inputTarget);
    const output = new PipeWireSink(this.outputTarget);
    const audioAbort = new AbortController();
    this.audioAbort = audioAbort;
    this.input = input;
    this.output = output;
    const fail = (error: unknown) => {
      if (audioAbort.signal.aborted) return;
      this.emitEvent({ type: "call.error", error: error instanceof Error ? error.message : String(error) });
      void this.stop("audio-failed");
    };
    const encoder = codecs.newEncoder({
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      frameDurationMs: AUDIO_FRAME_MS,
      signal: "voice",
      // PLANET's transport accepts raw Opus and builds RTP/SRTP itself. An
      // added leading byte corrupts the Opus packet at the receiver.
      bitrate: 32_000,
      bandwidth: "wideband",
      vbr: true,
    });
    const decoder = codecs.newDecoder({ sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS });
    void (async () => {
      try {
        for await (const frame of input.frames({ signal: audioAbort.signal })) {
          if (audioAbort.signal.aborted || this.muted) continue;
          const encoded = encoder.encode(frame);
          if (!encoded) continue;
          await transport.sendAudio(encoded);
        }
      } finally {
        encoder.close?.();
      }
    })().catch(fail);
    void (async () => {
      try {
        for await (const packet of abortablePackets(transport.receive(), audioAbort.signal)) {
          if (audioAbort.signal.aborted) return;
          try {
            const frame = decoder.decode(packet);
            if (frame) await output.write(frame);
          } catch {
            // Drop malformed/unsupported remote packets without killing the
            // call; authenticated transport packets can still continue.
          }
        }
      } finally {
        decoder.close?.();
        await output.end();
      }
    })().catch(fail);
  }
}
