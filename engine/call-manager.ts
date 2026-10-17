import {
  LineJsAdapter,
  type CallSession,
  PlanetTransport,
  opusCodecFactory,
  type CallTransport,
  type CodecFactory,
  type CallSessionState,
  type LineClient,
} from "./linejs/adapter";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { framePlanetOneToOneOpus, unframePlanetOneToOneOpus } from "./call-audio-framing";
import { adaptivePlaybackPrebufferMs } from "./call-playback-buffer";
import { normalizeIncomingCallKind } from "./call-incoming";
import { loadOrCreateCallDeviceId } from "./call-device-id";
import { resilientCallCodecFactory } from "./call-codec-resilience";
import { RtpJitterBuffer, type RtpMediaPacket } from "./rtp-jitter-buffer";
import { AnnexBStream, H264FrameAssembler, packetizeH264Frame } from "./call-h264";
import { H264RtpDepacketizer } from "./call-h264-receive";
import {
  resolveLineyAudioBinary,
  resolveLineyMediaBinary,
  resolveLineyScreenBinary,
  resolveLineyScreenWaylandBinary,
  resolveLineyScreenX11Binary,
} from "./native-sidecar";

export type CallEvent = {
  type: "call.state" | "call.incoming" | "call.error" | "call.ready" | "call.ended" | "call.videoFrame";
  callId?: string;
  peer?: string;
  state?: CallSessionState | "incoming";
  reason?: string;
  error?: string;
  source?: "talk";
  videoCapable?: boolean;
  frame?: string;
};

type CallClientLike = LineClient;

type AudioDevice = {
  id: string;
  name: string;
  description: string;
  kind: "input" | "output";
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

const CALL_DIAGNOSTIC_MAX_BYTES = 512 * 1024;
const CALL_DIAGNOSTIC_PATH = join(
  process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"),
  "liney",
  "call-diagnostic.jsonl",
);
const callDiagnosticLastAt = new Map<string, number>();

function discoverCameraDevice(): string | undefined {
  const explicit = process.env.LINEY_VIDEO_DEVICE?.trim();
  if (explicit) {
    try {
      if (existsSync(explicit) && statSync(explicit).isCharacterDevice()) return explicit;
    } catch {}
    return undefined;
  }

  for (let index = 0; index < 64; index += 1) {
    const candidate = "/dev/video" + index;
    try {
      if (existsSync(candidate) && statSync(candidate).isCharacterDevice()) return candidate;
    } catch {
      // Device may disappear during hotplug; keep probing the remaining nodes.
    }
  }
  return undefined;
}

type ScreenShareBackendName =
  | "portal-pipewire"
  | "wayland-ext-image-copy"
  | "wayland-wlr-screencopy"
  | "x11-native"
  | "unavailable";

type ScreenShareBackendSelection = {
  available: boolean;
  backend: ScreenShareBackendName;
  binary?: string;
  captureArgs: string[];
  fallbackCaptureArgs?: string[];
  details?: Record<string, unknown>;
};

type ScreenShareTarget = {
  id: string;
  kind: "desktop" | "monitor" | "window" | "region";
  name: string;
  available: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  primary?: boolean;
};

function screenTargetsFromSelection(selection: ScreenShareBackendSelection): ScreenShareTarget[] {
  if (selection.backend !== "x11-native") return [];
  const rawTargets = selection.details?.targets;
  if (!Array.isArray(rawTargets)) return [];
  const allowedKinds = new Set(["desktop", "monitor", "window", "region"]);
  const targets: ScreenShareTarget[] = [];
  for (const raw of rawTargets) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const kind = typeof value.kind === "string" ? value.kind : "";
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!id || !name || !allowedKinds.has(kind)) continue;
    targets.push({
      id,
      kind: kind as ScreenShareTarget["kind"],
      name,
      available: value.available !== false,
      ...(typeof value.x === "number" ? { x: value.x } : {}),
      ...(typeof value.y === "number" ? { y: value.y } : {}),
      ...(typeof value.width === "number" ? { width: value.width } : {}),
      ...(typeof value.height === "number" ? { height: value.height } : {}),
      ...(typeof value.primary === "boolean" ? { primary: value.primary } : {}),
    });
  }
  return targets.slice(0, 160);
}

let screenShareProbeCache: {
  checkedAt: number;
  selection: ScreenShareBackendSelection;
} | null = null;

function probeScreenHelper(
  binary: string | undefined,
  args: string[],
): { available: boolean; backend?: string; details?: Record<string, unknown> } {
  if (!binary) return { available: false };
  const probe = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (probe.error || probe.status !== 0 || typeof probe.stdout !== "string") {
    return { available: false };
  }
  try {
    const parsed = JSON.parse(probe.stdout) as Record<string, unknown>;
    return {
      available: Boolean(parsed.available),
      backend: typeof parsed.backend === "string" ? parsed.backend : undefined,
      details: parsed,
    };
  } catch {
    return { available: false };
  }
}

function selectScreenShareBackend(force = false): ScreenShareBackendSelection {
  const now = Date.now();
  if (!force && screenShareProbeCache && now - screenShareProbeCache.checkedAt < 5_000) {
    return screenShareProbeCache.selection;
  }

  const portalBinary = resolveLineyScreenBinary();
  const portal = probeScreenHelper(portalBinary, ["--liney-media-screen-share-probe"]);
  if (portal.available && portalBinary) {
    const selection: ScreenShareBackendSelection = {
      available: true,
      backend: "portal-pipewire",
      binary: portalBinary,
      captureArgs: ["--liney-media-screen-share"],
      details: portal.details,
    };
    screenShareProbeCache = { checkedAt: now, selection };
    return selection;
  }

  const waylandSession = Boolean(process.env.WAYLAND_DISPLAY?.trim())
    || process.env.XDG_SESSION_TYPE?.trim().toLowerCase() === "wayland";
  if (waylandSession) {
    const waylandBinary = resolveLineyScreenWaylandBinary();
    const direct = probeScreenHelper(waylandBinary, ["--probe"]);
    const backend = direct.backend === "wayland-ext-image-copy"
      ? "wayland-ext-image-copy"
      : direct.backend === "wayland-wlr-screencopy"
        ? "wayland-wlr-screencopy"
        : "unavailable";
    if (direct.available && waylandBinary && backend !== "unavailable") {
      const protocols = direct.details?.protocols;
      const wlrAvailable = Boolean(
        protocols
        && typeof protocols === "object"
        && (protocols as Record<string, unknown>).wlrScreencopy,
      );
      const selection: ScreenShareBackendSelection = {
        available: true,
        backend,
        binary: waylandBinary,
        captureArgs: ["--capture"],
        ...(backend === "wayland-ext-image-copy" && wlrAvailable
          ? { fallbackCaptureArgs: ["--capture-wlr"] }
          : {}),
        details: direct.details,
      };
      screenShareProbeCache = { checkedAt: now, selection };
      return selection;
    }

    // DISPLAY normally points at XWayland inside a Wayland session. Do not
    // silently downgrade to X11 capture because that can omit native Wayland
    // windows and give the user a misleading "shared desktop".
    const selection: ScreenShareBackendSelection = {
      available: false,
      backend: "unavailable",
      captureArgs: [],
      details: direct.details,
    };
    screenShareProbeCache = { checkedAt: now, selection };
    return selection;
  }

  if (process.env.DISPLAY?.trim()) {
    const x11Binary = resolveLineyScreenX11Binary();
    const x11 = probeScreenHelper(x11Binary, ["--probe"]);
    if (x11.available && x11Binary) {
      const selection: ScreenShareBackendSelection = {
        available: true,
        backend: "x11-native",
        binary: x11Binary,
        captureArgs: ["--capture"],
        details: x11.details,
      };
      screenShareProbeCache = { checkedAt: now, selection };
      return selection;
    }
  }

  const selection: ScreenShareBackendSelection = {
    available: false,
    backend: "unavailable",
    captureArgs: [],
  };
  screenShareProbeCache = { checkedAt: now, selection };
  return selection;
}

function screenShareBackendAvailable(force = false): boolean {
  return selectScreenShareBackend(force).available;
}

function sanitizeCallDiagnosticString(value: string): string {
  return value
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/u[a-f0-9]{32}/gi, "[mid]")
    .replace(/[A-Za-z0-9_-]{48,}/g, "[redacted]")
    .slice(0, 160);
}

function sanitizeCallDiagnostic(event: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "type", "state", "reason", "endpoint", "family", "port", "sourcePort", "currentPort", "backend",
    "payloadType", "rtpPayloadType", "mediaKeyMode", "activeMediaKeyMode", "mode", "ccTag", "mcTag",
    "send", "recv", "mediaKeySwitched", "bytes", "payloadBytes", "bodyBytes",
    "timestampStep", "marker", "result", "relCode",
    "targetMs", "bufferedMs", "frameMs", "correlated", "consecutive",
    "underflows", "droppedFrames", "jitterMs", "bufferedPackets",
    "reordered", "lateDrops", "lostPackets", "videoCapable", "videoEnabled",
    "videoPayloadType", "device",
  ] as const;
  const sanitized: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = event[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = typeof value === "string" ? sanitizeCallDiagnosticString(value) : value;
    }
  }
  return sanitized;
}

function writeCallDiagnostic(event: Record<string, unknown>): void {
  if (process.env.LINEY_CALL_DIAGNOSTICS === "0") return;
  const type = typeof event.type === "string" ? event.type : "unknown";
  const now = Date.now();
  const throttleMs = type === "media_send" || type === "media_recv"
    ? 5_000
    : type === "media_decrypt_fail" || type === "video_probe"
      ? 1_000
      : 0;
  const lastAt = callDiagnosticLastAt.get(type) ?? 0;
  if (throttleMs && now - lastAt < throttleMs) return;
  callDiagnosticLastAt.set(type, now);

  try {
    mkdirSync(dirname(CALL_DIAGNOSTIC_PATH), { recursive: true, mode: 0o700 });
    try {
      if (statSync(CALL_DIAGNOSTIC_PATH).size >= CALL_DIAGNOSTIC_MAX_BYTES) {
        const rotated = `${CALL_DIAGNOSTIC_PATH}.1`;
        try { unlinkSync(rotated); } catch { /* no previous log */ }
        renameSync(CALL_DIAGNOSTIC_PATH, rotated);
      }
    } catch { /* first log entry */ }
    const payload = {
      ts: new Date(now).toISOString(),
      ...sanitizeCallDiagnostic(event),
    };
    appendFileSync(CALL_DIAGNOSTIC_PATH, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Diagnostics must never make a call fail.
  }
}

function safeAudioTarget(value: unknown): string | undefined {
  const target = typeof value === "string" ? value.trim() : "";
  if (!target) return undefined;
  return /^output:\d+$/.test(target) ? target : undefined;
}

function listNativeAudioDevices(): { inputs: AudioDevice[]; outputs: AudioDevice[] } {
  const binary = resolveLineyAudioBinary();
  if (!binary) return { inputs: [], outputs: [] };

  const result = spawnSync(binary, ["--liney-media-audio-devices"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 512 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return { inputs: [], outputs: [] };
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      inputs?: unknown;
      outputs?: unknown;
    };
    const normalize = (items: unknown, kind: "input" | "output"): AudioDevice[] => {
      if (!Array.isArray(items)) return [];
      return items.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        const name = typeof record.name === "string" ? record.name : "";
        const description = typeof record.description === "string" ? record.description : name;
        if (!id || !name || !new RegExp("^" + kind + ":\\d+$").test(id)) return [];
        return [{ id, name, description, kind }];
      });
    };
    return {
      inputs: normalize(parsed.inputs, "input"),
      outputs: normalize(parsed.outputs, "output"),
    };
  } catch {
    return { inputs: [], outputs: [] };
  }
}

function nativeAudioBackendAvailable(): boolean {
  return Boolean(resolveLineyAudioBinary());
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

class NativeAudioSource {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;

  constructor(private readonly target?: string) {}

  async *frames(opts: { signal?: AbortSignal } = {}): AsyncIterable<{ samples: Int16Array; sampleRate: number; channels: number }> {
    if (this.child) throw new Error("microphone source already consumed");

    const binary = resolveLineyAudioBinary();
    const frameSamples = AUDIO_FRAME_SAMPLES * AUDIO_CHANNELS;
    const silence = () => ({
      samples: new Int16Array(frameSamples),
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
    });
    const sleepFrame = () => new Promise((resolve) => setTimeout(resolve, AUDIO_FRAME_MS));

    if (!binary) {
      writeCallDiagnostic({ type: "audio_input_fallback", result: "native-helper-missing" });
      while (!this.stopped && !opts.signal?.aborted) {
        yield silence();
        await sleepFrame();
      }
      return;
    }

    const args = [
      "--liney-media-audio-input",
      ...(this.target ? ["--device", this.target] : []),
    ];
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let stderrTail = "";
    void (async () => {
      for await (const chunk of child.stderr as Readable) {
        stderrTail = (stderrTail + Buffer.from(chunk as Buffer).toString("utf8")).slice(-1024);
      }
    })();

    let buffer = Buffer.alloc(0);
    const frameBytes = frameSamples * Int16Array.BYTES_PER_ELEMENT;
    const abort = () => { void this.close(); };
    opts.signal?.addEventListener("abort", abort, { once: true });
    let producedAudio = false;

    try {
      for await (const chunk of child.stdout as Readable) {
        if (this.stopped || opts.signal?.aborted) return;
        buffer = Buffer.concat([buffer, Buffer.from(chunk as Uint8Array)]);
        while (buffer.length >= frameBytes) {
          const frame = buffer.subarray(0, frameBytes);
          buffer = buffer.subarray(frameBytes);
          producedAudio = true;
          yield { samples: toSamples(frame), sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS };
        }
      }
    } catch {
      // Hardware failure degrades to silence; it must never tear down the call.
    } finally {
      opts.signal?.removeEventListener("abort", abort);
      if (this.child === child) this.child = undefined;
      if (child.exitCode === null) {
        try { child.kill("SIGTERM"); } catch {}
      }
      await waitForExit(child);
    }

    if (!this.stopped && !opts.signal?.aborted) {
      writeCallDiagnostic({
        type: "audio_input_fallback",
        result: producedAudio ? "device-disconnected" : (stderrTail.trim().slice(-120) || "device-unavailable"),
      });
    }
    while (!this.stopped && !opts.signal?.aborted) {
      yield silence();
      await sleepFrame();
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

class NativeAudioSink {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  private queue: Array<{ bytes: Buffer; durationMs: number }> = [];
  private queuedDurationMs = 0;
  private arrivalDeltasMs: number[] = [];
  private lastArrivalAt: number | undefined;
  private playoutStarted = false;
  private playoutLoop?: Promise<void>;
  private playoutError?: Error;
  private targetMs = 80;
  private lastFrameBytes = 0;
  private lastFrameDurationMs = 20;
  private underflows = 0;
  private droppedFrames = 0;
  private lastStatsAt = 0;

  constructor(private target?: string) {}

  private ensureChild(): ChildProcessWithoutNullStreams | undefined {
    if (this.child) return this.child;
    const binary = resolveLineyAudioBinary();
    if (!binary) {
      this.playoutError = undefined;
      return undefined;
    }

    const child = spawn(binary, [
      "--liney-media-audio-output",
      ...(this.target ? ["--device", this.target] : []),
    ], { stdio: ["pipe", "ignore", "pipe"] });
    this.child = child;
    child.stderr.resume();
    child.once("error", () => {
      if (this.child === child) this.child = undefined;
      this.playoutError = undefined;
      writeCallDiagnostic({ type: "audio_output_fallback", result: "device-unavailable" });
    });
    child.once("close", () => {
      if (this.child === child) this.child = undefined;
      this.playoutError = undefined;
    });
    return child;
  }

  async write(frame: { samples: Int16Array; sampleRate: number; channels: number }): Promise<void> {
    if (this.stopped) return;

    const now = performance.now();
    if (this.lastArrivalAt !== undefined) {
      const delta = now - this.lastArrivalAt;
      if (delta > 0 && delta < 1_000) {
        this.arrivalDeltasMs.push(delta);
        if (this.arrivalDeltasMs.length > 24) this.arrivalDeltasMs.shift();
      }
    }
    this.lastArrivalAt = now;

    const sampleRate = frame.sampleRate > 0 ? frame.sampleRate : AUDIO_SAMPLE_RATE;
    const channels = frame.channels > 0 ? frame.channels : AUDIO_CHANNELS;
    const frameDurationMs = (frame.samples.length / (sampleRate * channels)) * 1_000;
    if (!Number.isFinite(frameDurationMs) || frameDurationMs <= 0) return;

    // Copy because codec-owned PCM buffers may be reused after write() returns.
    const view = new Uint8Array(
      frame.samples.buffer,
      frame.samples.byteOffset,
      frame.samples.byteLength,
    );
    const bytes = Buffer.from(view);
    this.queue.push({ bytes, durationMs: frameDurationMs });
    this.queuedDurationMs += frameDurationMs;
    this.lastFrameDurationMs = frameDurationMs;
    this.targetMs = adaptivePlaybackPrebufferMs(frameDurationMs, this.arrivalDeltasMs);

    if (!this.playoutStarted) {
      const enoughObservations =
        this.arrivalDeltasMs.length >= 2 || this.queuedDurationMs >= 160;
      if (!enoughObservations || this.queuedDurationMs < this.targetMs) return;

      this.playoutStarted = true;
      writeCallDiagnostic({
        type: "audio_playback_auto",
        targetMs: this.targetMs,
        bufferedMs: Math.round(this.queuedDurationMs),
        frameMs: Math.round(frameDurationMs),
      });
      this.playoutLoop = this.runPlayoutLoop().catch((error) => {
        this.playoutError = error instanceof Error ? error : new Error(String(error));
      });
      return;
    }

    this.trimExcessLatency();
    this.writeStatsMaybe();
  }

  private trimExcessLatency(): void {
    const frameMs = Math.max(1, this.lastFrameDurationMs);
    const maxQueueMs = Math.min(
      800,
      Math.max(this.targetMs * 1.75, this.targetMs + frameMs * 4),
    );
    while (this.queue.length > 2 && this.queuedDurationMs > maxQueueMs) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      this.queuedDurationMs = Math.max(0, this.queuedDurationMs - dropped.durationMs);
      this.droppedFrames += 1;
    }
  }

  private async runPlayoutLoop(): Promise<void> {
    let nextDeadline = performance.now();
    while (!this.stopped) {
      const item = this.queue.shift();
      let durationMs = this.lastFrameDurationMs;

      if (item) {
        this.queuedDurationMs = Math.max(0, this.queuedDurationMs - item.durationMs);
        this.lastFrameBytes = item.bytes.length;
        this.lastFrameDurationMs = item.durationMs;
        durationMs = item.durationMs;
        await this.writeBytes(item.bytes);
      } else if (this.lastFrameBytes > 0) {
        // Keep PipeWire's audio clock continuous when one network/decode frame
        // arrives late. A short silence is much less destructive than an
        // underrun followed by a burst of late PCM.
        this.underflows += 1;
        durationMs = this.lastFrameDurationMs;
        await this.writeBytes(Buffer.alloc(this.lastFrameBytes));
      } else {
        await this.delay(5);
        nextDeadline = performance.now();
        continue;
      }

      this.trimExcessLatency();
      this.writeStatsMaybe();

      nextDeadline += durationMs;
      const now = performance.now();
      // Never "catch up" by bursting several frames after a late event-loop
      // wakeup; reset the schedule instead.
      if (nextDeadline < now - durationMs) nextDeadline = now;
      const waitMs = nextDeadline - performance.now();
      if (waitMs > 0) await this.delay(waitMs);
    }
  }

  private writeStatsMaybe(): void {
    const now = performance.now();
    if (now - this.lastStatsAt < 1_000) return;
    this.lastStatsAt = now;
    writeCallDiagnostic({
      type: "audio_playback_stats",
      targetMs: Math.round(this.targetMs),
      bufferedMs: Math.round(this.queuedDurationMs),
      frameMs: Math.round(this.lastFrameDurationMs),
      underflows: this.underflows,
      droppedFrames: this.droppedFrames,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));
  }

  async writeClocked(frame: { samples: Int16Array; sampleRate: number; channels: number }): Promise<void> {
    if (this.stopped) return;
    const bytes = Buffer.from(
      frame.samples.buffer,
      frame.samples.byteOffset,
      frame.samples.byteLength,
    );
    await this.writeBytes(Buffer.from(bytes));
  }

  private async writeBytes(bytes: Buffer): Promise<void> {
    const child = this.ensureChild();
    if (!child || child.exitCode !== null || child.stdin.destroyed) return;

    await new Promise<void>((resolve) => {
      const cleanup = () => {
        child.stdin.off("error", onError);
        child.stdin.off("drain", onDrain);
        child.off("close", onClose);
      };
      const degrade = () => {
        cleanup();
        if (this.child === child) this.child = undefined;
        writeCallDiagnostic({ type: "audio_output_fallback", result: "device-disconnected" });
        resolve();
      };
      const onError = () => degrade();
      const onClose = () => degrade();
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
      } catch {
        degrade();
      }
    });
  }

  private resetPlayoutState(): void {
    this.queue = [];
    this.queuedDurationMs = 0;
    this.arrivalDeltasMs = [];
    this.lastArrivalAt = undefined;
    this.playoutStarted = false;
    this.playoutLoop = undefined;
    this.playoutError = undefined;
    this.targetMs = 80;
    this.lastFrameBytes = 0;
    this.lastFrameDurationMs = 20;
    this.underflows = 0;
    this.droppedFrames = 0;
    this.lastStatsAt = 0;
  }

  async setTarget(target?: string): Promise<void> {
    if (this.target === target) return;
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    if (child) {
      try { child.stdin.end(); } catch { /* already closed */ }
    }
    await Promise.allSettled([
      this.playoutLoop ?? Promise.resolve(),
      child ? waitForExit(child) : Promise.resolve(),
    ]);
    this.target = target;
    this.resetPlayoutState();
    this.stopped = false;
  }

  async end(): Promise<void> {
    this.stopped = true;
    this.queue = [];
    this.queuedDurationMs = 0;
    const child = this.child;
    this.child = undefined;
    if (child) {
      try { child.stdin.end(); } catch { /* already closed */ }
    }
    await Promise.allSettled([
      this.playoutLoop ?? Promise.resolve(),
      child ? waitForExit(child) : Promise.resolve(),
    ]);
    this.resetPlayoutState();
  }
}

class PlanetAudioTransport implements CallTransport {
  readonly planet: PlanetTransport;
  answer: { mediaReady?: boolean } | undefined;
  private rejectAnswer: ((error: Error) => void) | null = null;

  constructor(
    localMid: string,
    onRemoteEnd: () => void,
    onDebug: (event: Record<string, unknown>) => void,
    videoEnabled = false,
  ) {
    this.planet = new PlanetTransport({
      localMid,
      serviceKey: videoEnabled ? "freecall.video" : "freecall.audio",
      enableVideo: videoEnabled,
      videoBitrateKbps: 800,
      videoFps: 15,
      // Let LINEJS probe SRTP key derivation candidates. Hard-coding
      // audio-reverse-stage made the call fragile across peer implementations.
      mediaKeyMode: "auto",
      rtpTimestampStep: AUDIO_FRAME_SAMPLES,
      timeoutMs: 10_000,
      // Do not override keepalive cadence: LINEJS follows the interval
      // negotiated by PLANET and sends the initial keepalive itself.
      debug: (event) => {
        onDebug(event as Record<string, unknown>);
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
    // Native LINE PLANET 1:1 RTP payloads carry a one-byte 0x00 prefix
    // before the raw Opus packet. LINEJS PlanetTransport intentionally wraps
    // whatever payload it is given, so apply that native framing here.
    return this.planet.send(framePlanetOneToOneOpus(packet), { timestampStep: AUDIO_FRAME_SAMPLES });
  }

  async *receive(): AsyncIterable<Uint8Array> {
    for await (const packet of this.planet.receive()) {
      yield unframePlanetOneToOneOpus(packet);
    }
  }

  videoReady(): boolean {
    const ready = (this.planet as PlanetTransport & { videoReady?: () => boolean }).videoReady;
    return typeof ready === "function" && ready.call(this.planet);
  }

  onVideoReady(handler: () => void): void {
    const subscribe = (this.planet as PlanetTransport & { onVideoReady?: (handler: () => void) => void }).onVideoReady;
    if (typeof subscribe === "function") subscribe.call(this.planet, handler);
  }

  receiveVideoMediaDetailed(): AsyncIterable<RtpMediaPacket> {
    const receive = (this.planet as PlanetTransport & {
      receiveVideoMediaDetailed?: () => AsyncIterable<RtpMediaPacket>;
    }).receiveVideoMediaDetailed;
    if (typeof receive !== "function") {
      throw new Error("LINEJS PLANET video RTP receive API is unavailable");
    }
    return receive.call(this.planet);
  }

  sendVideo(payload: Uint8Array, opts: { endOfFrame?: boolean; timestampStep?: number } = {}): Promise<void> {
    const send = (this.planet as PlanetTransport & {
      sendVideo?: (payload: Uint8Array, opts?: { endOfFrame?: boolean; timestampStep?: number }) => Promise<void>;
    }).sendVideo;
    if (typeof send !== "function") throw new Error("LINEJS PLANET video send API is unavailable");
    return send.call(this.planet, payload, opts);
  }

  close(): Promise<void> {
    return this.planet.close();
  }
}

class ConnectedPlanetAudioTransport implements CallTransport {
  constructor(readonly planet: PlanetTransport) {}

  connect(): Promise<void> {
    // answerIncoming() returns an already connected/media-ready transport.
    return Promise.resolve();
  }

  send(packet: Uint8Array): Promise<void> {
    // PR #241 incoming PlanetTransport exposes raw encoded Opus packets at
    // its public media boundary. Do not add LINE native framing here.
    return this.planet.send(packet, { timestampStep: AUDIO_FRAME_SAMPLES });
  }

  receive(): AsyncIterable<Uint8Array> {
    return this.planet.receive();
  }

  receiveMediaDetailed(): AsyncIterable<RtpMediaPacket> {
    const receive = (this.planet as PlanetTransport & {
      receiveMediaDetailed(): AsyncIterable<RtpMediaPacket>;
    }).receiveMediaDetailed;
    if (typeof receive !== "function") {
      throw new Error("LINEJS PLANET detailed RTP receive API is unavailable");
    }
    return receive.call(this.planet);
  }

  receiveVideoMediaDetailed(): AsyncIterable<RtpMediaPacket> {
    const receive = (this.planet as PlanetTransport & {
      receiveVideoMediaDetailed(): AsyncIterable<RtpMediaPacket>;
    }).receiveVideoMediaDetailed;
    if (typeof receive !== "function") {
      throw new Error("LINEJS PLANET video RTP receive API is unavailable");
    }
    return receive.call(this.planet);
  }

  videoReady(): boolean {
    const ready = (this.planet as PlanetTransport & { videoReady?: () => boolean }).videoReady;
    return typeof ready === "function" && ready.call(this.planet);
  }

  onVideoReady(handler: () => void): void {
    const subscribe = (this.planet as PlanetTransport & { onVideoReady?: (handler: () => void) => void }).onVideoReady;
    if (typeof subscribe === "function") subscribe.call(this.planet, handler);
  }

  sendVideo(payload: Uint8Array, opts: { endOfFrame?: boolean; timestampStep?: number } = {}): Promise<void> {
    const send = (this.planet as PlanetTransport & {
      sendVideo?: (payload: Uint8Array, opts?: { endOfFrame?: boolean; timestampStep?: number }) => Promise<void>;
    }).sendVideo;
    if (typeof send !== "function") throw new Error("LINEJS PLANET video send API is unavailable");
    return send.call(this.planet, payload, opts);
  }

  close(): Promise<void> {
    return this.planet.close();
  }
}

export class CallManager {
  private readonly emitEvent: (event: CallEvent) => void;
  private client: CallClientLike | null = null;
  private session: CallSession | null = null;
  private activeTransport: CallTransport | null = null;
  private input: NativeAudioSource | null = null;
  private output: NativeAudioSink | null = null;
  private audioAbort: AbortController | null = null;
  private videoProcess: ChildProcessWithoutNullStreams | null = null;
  private remoteVideoProcess: ChildProcessWithoutNullStreams | null = null;
  private videoEnabled = false;
  private videoMode: "camera" | "screen" | null = null;
  private incoming: {
    callId: string;
    from: string;
    kind: string;
    routeMetadata?: Record<string, unknown>;
    event: unknown;
  } | null = null;
  private incomingAnswerAbort: AbortController | null = null;
  private muted = false;
  private inputTarget: string | undefined;
  private outputTarget: string | undefined;
  private codecReady: Promise<CodecFactory> | null = null;
  private stopInFlight: Promise<void> | null = null;
  private lifecycleEpoch = 0;
  private lifecycleCallId: string | null = null;

  constructor(emitEvent: (event: CallEvent) => void) {
    this.emitEvent = emitEvent;
  }

  get enabled(): boolean {
    return this.status.enabled;
  }

  get screenShareTargets(): {
    backend: ScreenShareBackendName;
    managedBySystem: boolean;
    targets: ScreenShareTarget[];
  } {
    const selection = selectScreenShareBackend(true);
    return {
      backend: selection.backend,
      managedBySystem: selection.backend === "portal-pipewire",
      targets: screenTargetsFromSelection(selection),
    };
  }

  get status(): {
    enabled: boolean;
    audio: boolean;
    transport: "planet" | "unavailable";
    incomingAnswer: boolean;
    incomingTransport: "andromeda" | "unavailable";
    incomingExperimental: boolean;
    liveValidated: boolean;
    hardware: {
      camera: { available: boolean; device?: string; backend: "v4l2-native" | "unavailable" };
      microphone: { available: boolean; backend: "native-system" | "unavailable" };
      speaker: { available: boolean; backend: "native-system" | "unavailable" };
      screenShare: { available: boolean; backend: ScreenShareBackendName };
    };
    reason?: string;
  } {
    const devices = listNativeAudioDevices();
    const nativeAudio = nativeAudioBackendAvailable();
    const cameraDevice = discoverCameraDevice();
    const hardware = {
      camera: cameraDevice
        ? { available: true, device: cameraDevice, backend: "v4l2-native" as const }
        : { available: false, backend: "unavailable" as const },
      microphone: devices.inputs.length
        ? { available: true, backend: "native-system" as const }
        : { available: false, backend: "unavailable" as const },
      speaker: devices.outputs.length
        ? { available: true, backend: "native-system" as const }
        : { available: false, backend: "unavailable" as const },
      screenShare: (() => {
        const selected = selectScreenShareBackend();
        return selected.available
          ? { available: true, backend: selected.backend }
          : { available: false, backend: "unavailable" as const };
      })(),
    };

    if (process.env.LINEY_DISABLE_CALLS === "1" || process.env.LINEY_ENABLE_CALLS === "0") {
      return {
        enabled: false,
        audio: false,
        transport: "unavailable",
        incomingAnswer: false,
        incomingTransport: "unavailable",
        incomingExperimental: false,
        liveValidated: false,
        hardware,
        reason: "calls are disabled by configuration",
      };
    }
    return {
      enabled: true,
      audio: nativeAudio,
      transport: "planet",
      // LINEJS 3.4.2 exposes AndromedaTransport.answer(), which registers the
      // callee transport and completes INVITE -> 100/180/200 -> ACK + SRTP.
      incomingAnswer: true,
      incomingTransport: "andromeda",
      incomingExperimental: process.env.LINEY_CALL_INCOMING_VALIDATED !== "1",
      liveValidated: process.env.LINEY_CALL_LIVE_VALIDATED === "1",
      hardware,
    };
  }

  get devices(): { inputs: AudioDevice[]; outputs: AudioDevice[] } {
    return listNativeAudioDevices();
  }

  attach(client: LineClient): void {
    this.client = client as CallClientLike;
  }

  rememberIncoming(event: {
    callMid?: string;
    from?: string;
    kind?: string;
    raw?: unknown;
    audio?: { callId?: string; callerMid?: string };
  }): void {
    const audio = event.audio;
    const callId = String(audio?.callId ?? event.callMid ?? "");
    const from = String(audio?.callerMid ?? event.from ?? "");
    if (!callId || !from) return;
    const normalized = audio ? { kind: "AUDIO" as const } : normalizeIncomingCallKind(event.kind);

    // LINE may repeat NOTIFIED_RECEIVED_CALL while the same call is already
    // being answered or is in progress. Never let a duplicate notification
    // replace the active lifecycle or reopen the incoming-call UI.
    if (this.lifecycleCallId === callId) {
      if (this.session || this.activeTransport || this.incomingAnswerAbort) {
        writeCallDiagnostic({
          type: "incoming_call_ignored",
          result: "duplicate-active",
        });
        return;
      }
      if (this.incoming?.callId === callId) {
        writeCallDiagnostic({
          type: "incoming_call_ignored",
          result: "duplicate-pending",
        });
        return;
      }
    }

    // A different caller arriving while a call is active must not stomp the
    // current call state either. LINE can handle the remote busy/timeout side;
    // Liney keeps the active call stable.
    if (this.session || this.activeTransport || this.incomingAnswerAbort) {
      writeCallDiagnostic({
        type: "incoming_call_ignored",
        result: "busy-active",
      });
      return;
    }

    this.lifecycleEpoch += 1;
    this.lifecycleCallId = callId;
    this.incoming = {
      callId,
      from,
      kind: normalized.kind,
      routeMetadata: "routeMetadata" in normalized ? normalized.routeMetadata : undefined,
      event,
    };
    writeCallDiagnostic({
      type: "incoming_call",
      result: audio ? "planet-audio" : (this.incoming.routeMetadata ? "route-metadata" : "legacy-kind"),
    });
    this.emitEvent({ type: "call.incoming", callId, peer: from, state: "incoming", source: "talk" });
  }

  async start(
    peer: string,
    kind: "AUDIO" | "VIDEO" = "AUDIO",
  ): Promise<{ callId: string; state: CallSessionState; videoCapable: boolean }> {
    if (!this.enabled) throw new Error(this.status.reason ?? "call audio is unavailable");
    if (!this.client) throw new Error("not authenticated");
    await this.stopInFlight?.catch(() => undefined);
    if (this.session || this.activeTransport) throw new Error("another call is already active");
    const callId = crypto.randomUUID();
    const epoch = ++this.lifecycleEpoch;
    this.lifecycleCallId = callId;
    this.muted = false;
    const profile = await LineJsAdapter.getMyProfile(this.client);
    const localMid = String((profile as { mid?: string }).mid ?? "").trim();
    if (!localMid) throw new Error("LINE profile has no user mid for call setup");
    const codecs = await this.loadCodec();
    let transport: PlanetAudioTransport | null = null;
    let session: CallSession | null = null;
    try {
      transport = new PlanetAudioTransport(
        localMid,
        () => {
          writeCallDiagnostic({ type: "remote_end" });
          void this.stop("remote-ended");
        },
        writeCallDiagnostic,
        kind === "VIDEO",
      );
      this.activeTransport = transport;
      session = LineJsAdapter.startCallSession(this.client, {
        to: peer,
        kind,
        fromEnvInfo: { devname: process.env.LINEY_CALL_DEVNAME?.trim() || "Android" },
        codecs,
        transport,
      });
      this.bindSession(session, peer, callId, epoch);
      this.session = session;
      await withTimeout(session.start(), CALL_SETUP_TIMEOUT_MS, "outgoing call setup timed out");
      if (!transport.answer?.mediaReady) {
        throw new Error("peer answered, but LINE audio media negotiation was not ready");
      }
      await this.startAudioPipelines(session);
      const videoCapable = kind === "VIDEO" && transport.videoReady();
      if (videoCapable) {
        this.startRemoteVideoReceiver(transport, callId, epoch, this.audioAbort?.signal);
      }
      this.emitEvent({
        type: "call.ready",
        callId,
        peer,
        state: "in-call",
        videoCapable,
      });
      if (!videoCapable) this.watchRemoteVideoUpgrade(transport, callId, peer, epoch);
      return { callId, state: session.state, videoCapable };
    } catch (error) {
      await this.stop("outgoing-start-failed").catch(() => undefined);
      throw error;
    }
  }

  async accept(
    mode: "AUDIO" | "VIDEO" = "AUDIO",
  ): Promise<{ callId: string; state: CallSessionState; videoCapable: boolean }> {
    if (!this.enabled) throw new Error(this.status.reason ?? "call audio is unavailable");
    if (!this.client) throw new Error("not authenticated");
    await this.stopInFlight?.catch(() => undefined);
    if (this.session || this.activeTransport) throw new Error("another call is already active");
    const incoming = this.incoming;
    if (!incoming) throw new Error("there is no incoming call to answer");
    if (this.lifecycleCallId !== incoming.callId) {
      this.lifecycleEpoch += 1;
      this.lifecycleCallId = incoming.callId;
    }
    const epoch = this.lifecycleEpoch;
    const acceptedKind = normalizeIncomingCallKind(incoming.kind);
    const incomingAudio = acceptedKind.kind === "AUDIO" || acceptedKind.kind === "0";
    const incomingVideo = acceptedKind.kind === "VIDEO" || acceptedKind.kind === "1";
    if (!incomingAudio && !incomingVideo) {
      throw new Error(`incoming ${acceptedKind.kind} calls are not supported yet`);
    }

    this.muted = false;
    const codecs = await this.loadCodec();
    const answerAbort = new AbortController();
    this.incomingAnswerAbort = answerAbort;
    writeCallDiagnostic({ type: "incoming_answer_start", mode });
    let acceptedTransport: ConnectedPlanetAudioTransport | null = null;
    try {
      const planet = await LineJsAdapter.answerIncomingCall(
        this.client,
        incoming.event,
        {
          deviceId: loadOrCreateCallDeviceId(),
          signal: answerAbort.signal,
          timeoutMs: 15_000,
          debug: writeCallDiagnostic,
          preferVideo: mode === "VIDEO" || incomingVideo,
        },
      ) as PlanetTransport;
      if (answerAbort.signal.aborted) {
        await planet.close().catch(() => undefined);
        throw new Error("incoming call answer was cancelled");
      }
      const transport = new ConnectedPlanetAudioTransport(planet);
      acceptedTransport = transport;
      this.activeTransport = transport;
      this.incoming = null;
      this.incomingAnswerAbort = null;
      await this.startIncomingPlanetAudioPipelines(transport, codecs);
      const videoCapable = transport.videoReady();
      if (videoCapable) {
        this.startRemoteVideoReceiver(transport, incoming.callId, epoch, this.audioAbort?.signal);
      }
      writeCallDiagnostic({ type: "incoming_answer_ready", videoCapable });
      this.emitEvent({
        type: "call.ready",
        callId: incoming.callId,
        peer: incoming.from,
        state: "in-call",
        videoCapable,
      });
      if (!videoCapable) this.watchRemoteVideoUpgrade(transport, incoming.callId, incoming.from, epoch);
      void (planet as any).ended?.then?.(() => {
        if (
          this.lifecycleEpoch === epoch &&
          this.lifecycleCallId === incoming.callId &&
          this.activeTransport === transport
        ) void this.stop("remote-ended").catch(() => undefined);
      }).catch?.(() => undefined);
      return { callId: incoming.callId, state: "in-call", videoCapable };
    } catch (error) {
      if (this.incomingAnswerAbort === answerAbort) this.incomingAnswerAbort = null;
      if (acceptedTransport && this.activeTransport === acceptedTransport) {
        await this.stop("incoming-answer-failed").catch(() => undefined);
      }
      writeCallDiagnostic({
        type: "incoming_answer_error",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async reject(): Promise<{ rejected: boolean; remoteNotified: boolean }> {
    this.incoming = null;
    // The notification stream does not expose a reject RPC. Clearing the local
    // prompt is honest; the remote LINE client will receive its own timeout or
    // cancel event rather than a fabricated answer.
    return { rejected: true, remoteNotified: false };
  }

  async setVideoEnabled(enabled: boolean): Promise<{
    enabled: boolean;
    videoCapable: boolean;
    cameraAvailable: boolean;
    device?: string;
    reason?: string;
    message?: string;
  }> {
    const transport = this.activeTransport as (CallTransport & {
      videoReady?: () => boolean;
      sendVideo?: (
        payload: Uint8Array,
        opts?: { endOfFrame?: boolean; timestampStep?: number },
      ) => Promise<void>;
    }) | null;
    const videoCapable = !!transport?.videoReady?.();
    if (!enabled) {
      await this.stopVideoCapture();
      const device = discoverCameraDevice();
      return { enabled: false, videoCapable, cameraAvailable: Boolean(device), device };
    }
    if (!transport || !videoCapable || typeof transport.sendVideo !== "function") {
      throw new Error("video was not negotiated for this call");
    }
    if (this.videoProcess && this.videoMode === "camera") {
      return {
        enabled: true,
        videoCapable: true,
        cameraAvailable: true,
        device: discoverCameraDevice(),
      };
    }
    if (this.videoProcess) {
      await this.stopVideoCapture();
    }
    const device = discoverCameraDevice();
    if (!device) {
      writeCallDiagnostic({ type: "video_capture_unavailable", result: "no-camera" });
      return {
        enabled: false,
        videoCapable: true,
        cameraAvailable: false,
        reason: "no-camera",
      };
    }
    const mediaBinary = resolveLineyMediaBinary();
    if (!mediaBinary) {
      writeCallDiagnostic({ type: "video_capture_unavailable", result: "native-backend-missing" });
      return {
        enabled: false,
        videoCapable: true,
        cameraAvailable: true,
        device,
        reason: "native-backend-missing",
      };
    }

    const fps = 15;
    const child = spawn(mediaBinary, [
      "--liney-media-camera",
      "--device", device,
      "--width", "640",
      "--height", "480",
      "--fps", String(fps),
      "--bitrate", "800000",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.videoProcess = child;
    this.videoEnabled = false;
    this.videoMode = "camera";
    writeCallDiagnostic({ type: "video_capture_start", device, result: "camera-h264-native" });

    let stderrTail = "";
    void (async () => {
      for await (const chunk of child.stderr as Readable) {
        stderrTail = (stderrTail + Buffer.from(chunk as Buffer).toString("utf8")).slice(-2048);
      }
    })();

    let readySettled = false;
    let captureErrorReported = false;
    let settleReady!: (state: "ready" | "ended") => void;
    const ready = new Promise<"ready" | "ended">((resolve) => {
      settleReady = (state) => {
        if (readySettled) return;
        readySettled = true;
        resolve(state);
      };
    });
    child.once("close", () => settleReady("ended"));
    child.once("error", (error) => {
      stderrTail = (stderrTail + `\n${error.message}`).slice(-2048);
      settleReady("ended");
    });

    void (async () => {
      const annexB = new AnnexBStream();
      const frames = new H264FrameAssembler();
      const sendFrame = async (nals: Uint8Array[]) => {
        settleReady("ready");
        for (const packet of packetizeH264Frame(nals)) {
          await transport.sendVideo!(packet.payload, {
            endOfFrame: packet.marker,
            timestampStep: Math.round(90_000 / fps),
          });
        }
      };
      try {
        for await (const chunk of child.stdout as Readable) {
          if (this.videoProcess !== child) break;
          for (const nal of annexB.push(new Uint8Array(chunk as Buffer))) {
            for (const frame of frames.push(nal)) await sendFrame(frame);
          }
        }
        for (const nal of annexB.finish()) {
          for (const frame of frames.push(nal)) await sendFrame(frame);
        }
        for (const frame of frames.finish()) await sendFrame(frame);
      } catch (error) {
        if (this.videoProcess === child) {
          const reason = error instanceof Error ? error.message : String(error);
          writeCallDiagnostic({
            type: "video_capture_error",
            reason,
          });
          captureErrorReported = true;
          this.emitEvent({
            type: "call.error",
            error: `media-capture: ${reason}`,
          });
        }
      } finally {
        settleReady("ended");
        if (this.videoProcess === child) {
          this.videoProcess = null;
          this.videoEnabled = false;
          this.videoMode = null;
          if (!captureErrorReported) {
            this.emitEvent({
              type: "call.error",
              error: `media-capture: ${stderrTail.trim().slice(-240) || "camera stream stopped"}`,
            });
          }
          writeCallDiagnostic({
            type: "video_capture_stop",
            reason: stderrTail.trim().slice(-160) || "encoder-ended",
          });
        }
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    let readyState: "ready" | "ended" | "timeout";
    try {
      readyState = await Promise.race([
        ready,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (readyState !== "ready" || this.videoProcess !== child) {
      const message = stderrTail.trim().slice(-240)
        || (readyState === "timeout" ? "กล้องไม่ส่งภาพภายใน 5 วินาที" : "ตัวจับภาพกล้องปิดก่อนเริ่มส่งภาพ");
      writeCallDiagnostic({ type: "video_capture_unavailable", result: "camera-startup-failed", reason: message });
      if (this.videoProcess === child) await this.stopVideoCapture();
      else await waitForExit(child);
      return {
        enabled: false,
        videoCapable: true,
        cameraAvailable: true,
        device,
        reason: "camera-capture-failed",
        message,
      };
    }

    this.videoEnabled = true;
    return { enabled: true, videoCapable: true, cameraAvailable: true, device };
  }

  async setScreenShareEnabled(enabled: boolean, requestedTarget?: unknown): Promise<{
    enabled: boolean;
    videoCapable: boolean;
    screenShareAvailable: boolean;
    mode?: string;
    target?: string;
    reason?: string;
  }> {
    const transport = this.activeTransport as (CallTransport & {
      videoReady?: () => boolean;
      sendVideo?: (
        payload: Uint8Array,
        opts?: { endOfFrame?: boolean; timestampStep?: number },
      ) => Promise<void>;
    }) | null;
    const videoCapable = !!transport?.videoReady?.();

    if (!enabled) {
      if (this.videoMode === "screen") await this.stopVideoCapture();
      return {
        enabled: false,
        videoCapable,
        screenShareAvailable: screenShareBackendAvailable(),
      };
    }

    if (!transport || !videoCapable || typeof transport.sendVideo !== "function") {
      throw new Error("video was not negotiated for this call");
    }

    const screenBackend = selectScreenShareBackend(true);
    if (!screenBackend.available || !screenBackend.binary) {
      writeCallDiagnostic({ type: "video_capture_unavailable", result: "screen-share-backend" });
      return {
        enabled: false,
        videoCapable: true,
        screenShareAvailable: false,
        reason: "screen-share-backend",
      };
    }

    let selectedScreenTarget: string | undefined;
    let captureArgs = [...screenBackend.captureArgs];
    if (screenBackend.backend === "x11-native") {
      const targets = screenTargetsFromSelection(screenBackend);
      const requested = typeof requestedTarget === "string" ? requestedTarget.trim() : "";
      selectedScreenTarget = requested || "desktop";
      const selected = targets.find((target) => target.id === selectedScreenTarget);
      if (!selected || !selected.available) {
        return {
          enabled: false,
          videoCapable: true,
          screenShareAvailable: true,
          reason: "screen-share-target",
        };
      }
      captureArgs = [...captureArgs, "--target", selectedScreenTarget];
    }

    if (this.videoMode === "screen" && this.videoProcess) {
      return {
        enabled: true,
        videoCapable: true,
        screenShareAvailable: true,
        mode: "screen",
        ...(selectedScreenTarget ? { target: selectedScreenTarget } : {}),
      };
    }

    await this.stopVideoCapture();
    const mediaBinary = screenBackend.binary;
    const fps = 15;

    type ScreenHelperRun = {
      helper: ChildProcessWithoutNullStreams;
      ready: Promise<"ready" | "ended">;
      stderrTail: () => string;
    };

    const launchScreenHelper = (
      captureArgs: string[],
      backend: ScreenShareBackendName,
    ): ScreenHelperRun => {
      const helper = spawn(mediaBinary, captureArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.videoProcess = helper;
      this.videoEnabled = false;
      this.videoMode = "screen";
      writeCallDiagnostic({
        type: "video_capture_start",
        result: "screen-h264-native",
        backend,
      });

      let stderrTail = "";
      void (async () => {
        for await (const chunk of helper.stderr as Readable) {
          stderrTail = (stderrTail + Buffer.from(chunk as Buffer).toString("utf8")).slice(-2048);
        }
      })();

      let readySettled = false;
      let captureStarted = false;
      let captureErrorReported = false;
      let settleReady!: (value: "ready" | "ended") => void;
      const ready = new Promise<"ready" | "ended">((resolve) => {
        settleReady = (value) => {
          if (readySettled) return;
          readySettled = true;
          resolve(value);
        };
      });
      helper.once("close", () => settleReady("ended"));
      helper.once("error", () => settleReady("ended"));

      void (async () => {
        const annexB = new AnnexBStream();
        const frames = new H264FrameAssembler();
        const sendFrame = async (nals: Uint8Array[]) => {
          for (const packet of packetizeH264Frame(nals)) {
            await transport.sendVideo!(packet.payload, {
              endOfFrame: packet.marker,
              timestampStep: Math.round(90_000 / fps),
            });
          }
        };
        try {
          for await (const chunk of helper.stdout as Readable) {
            if (this.videoProcess !== helper || this.videoMode !== "screen") break;
            captureStarted = true;
            settleReady("ready");
            for (const nal of annexB.push(new Uint8Array(chunk as Buffer))) {
              for (const frame of frames.push(nal)) await sendFrame(frame);
            }
          }
          for (const nal of annexB.finish()) {
            for (const frame of frames.push(nal)) await sendFrame(frame);
          }
          for (const frame of frames.finish()) await sendFrame(frame);
        } catch (error) {
          if (this.videoProcess === helper) {
            const reason = error instanceof Error ? error.message : String(error);
            writeCallDiagnostic({
              type: "video_capture_error",
              backend,
              reason,
            });
            captureErrorReported = true;
            this.emitEvent({ type: "call.error", error: `media-capture: ${reason}` });
          }
        } finally {
          settleReady("ended");
          if (this.videoProcess === helper) {
            this.videoProcess = null;
            this.videoEnabled = false;
            this.videoMode = null;
            if (captureStarted && !captureErrorReported) {
              this.emitEvent({
                type: "call.error",
                error: `media-capture: ${stderrTail.trim().slice(-240) || "screen stream stopped"}`,
              });
            }
            writeCallDiagnostic({
              type: "video_capture_stop",
              backend,
              reason: stderrTail.trim().slice(-160) || "screen-helper-ended",
            });
          }
        }
      })();

      return { helper, ready, stderrTail: () => stderrTail };
    };

    const awaitScreenReady = async (run: ScreenHelperRun): Promise<"ready" | "ended" | "timeout"> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          run.ready,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), 5_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const retireFailedHelper = async (run: ScreenHelperRun): Promise<void> => {
      if (this.videoProcess === run.helper) this.videoProcess = null;
      if (run.helper.exitCode === null) {
        try { run.helper.kill("SIGTERM"); } catch {}
      }
      await waitForExit(run.helper);
    };

    let activeBackend = screenBackend.backend;
    let run = launchScreenHelper(captureArgs, activeBackend);
    let readyState = await awaitScreenReady(run);

    if (readyState !== "ready") {
      const firstStderr = run.stderrTail();
      const cancelled = /cancel|closed|dismiss/i.test(firstStderr);
      await retireFailedHelper(run);

      if (
        !cancelled
        && activeBackend === "wayland-ext-image-copy"
        && screenBackend.fallbackCaptureArgs?.length
      ) {
        activeBackend = "wayland-wlr-screencopy";
        writeCallDiagnostic({
          type: "video_capture_fallback",
          result: readyState === "timeout" ? "startup-timeout" : "primary-ended",
          backend: activeBackend,
        });
        run = launchScreenHelper(screenBackend.fallbackCaptureArgs, activeBackend);
        readyState = await awaitScreenReady(run);
      }
    }

    if (readyState !== "ready" || this.videoProcess !== run.helper) {
      const stderrTail = run.stderrTail();
      const cancelled = /cancel|closed|dismiss/i.test(stderrTail);
      await retireFailedHelper(run);
      this.videoEnabled = false;
      this.videoMode = null;
      return {
        enabled: false,
        videoCapable: true,
        screenShareAvailable: true,
        reason: cancelled ? "screen-share-cancelled" : "screen-share-failed",
      };
    }

    this.videoEnabled = true;
    return {
      enabled: true,
      videoCapable: true,
      screenShareAvailable: true,
      mode: "screen",
      ...(selectedScreenTarget ? { target: selectedScreenTarget } : {}),
    };
  }

  private watchRemoteVideoUpgrade(
    transport: CallTransport & {
      videoReady(): boolean;
      receiveVideoMediaDetailed(): AsyncIterable<RtpMediaPacket>;
      onVideoReady?(handler: () => void): void;
    },
    callId: string,
    peer: string,
    epoch: number,
  ): void {
    if (typeof transport.onVideoReady !== "function") return;
    transport.onVideoReady(() => {
      if (
        this.activeTransport !== transport ||
        this.lifecycleEpoch !== epoch ||
        this.lifecycleCallId !== callId ||
        !transport.videoReady()
      ) return;
      writeCallDiagnostic({ type: "remote_video_upgrade_ready", videoCapable: true });
      this.startRemoteVideoReceiver(transport, callId, epoch, this.audioAbort?.signal);
      this.emitEvent({ type: "call.ready", callId, peer, state: "in-call", videoCapable: true });
    });
  }

  private startRemoteVideoReceiver(
    transport: {
      videoReady(): boolean;
      receiveVideoMediaDetailed(): AsyncIterable<RtpMediaPacket>;
    },
    callId: string,
    epoch: number,
    signal?: AbortSignal,
  ): void {
    if (!transport.videoReady() || signal?.aborted || this.remoteVideoProcess) return;
    const mediaBinary = resolveLineyMediaBinary();
    if (!mediaBinary) {
      this.emitEvent({ type: "call.error", callId, error: "remote-video: native H.264 decoder is unavailable" });
      return;
    }

    let packets: AsyncIterable<RtpMediaPacket>;
    try {
      packets = transport.receiveVideoMediaDetailed();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.emitEvent({ type: "call.error", callId, error: "remote-video: " + reason });
      return;
    }

    const child = spawn(mediaBinary, ["--liney-media-h264-decode"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.remoteVideoProcess = child;
    const depacketizer = new H264RtpDepacketizer();
    const isCurrent = () =>
      !signal?.aborted
      && this.remoteVideoProcess === child
      && this.lifecycleEpoch === epoch
      && this.lifecycleCallId === callId;
    let outputBuffer = Buffer.alloc(0);
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (!isCurrent()) return;
      outputBuffer = outputBuffer.length
        ? Buffer.concat([outputBuffer, chunk])
        : Buffer.from(chunk);
      while (outputBuffer.length >= 4) {
        const frameLength = outputBuffer.readUInt32LE(0);
        if (frameLength === 0 || frameLength > 8 * 1024 * 1024) {
          this.emitEvent({ type: "call.error", callId, error: "remote-video: decoder returned an invalid frame" });
          try { child.kill("SIGTERM"); } catch { /* already closed */ }
          return;
        }
        if (outputBuffer.length < frameLength + 4) return;
        const png = outputBuffer.subarray(4, frameLength + 4);
        outputBuffer = outputBuffer.subarray(frameLength + 4);
        this.emitEvent({
          type: "call.videoFrame",
          callId,
          frame: "data:image/png;base64," + png.toString("base64"),
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_048) stderr += chunk.toString("utf8").slice(0, 2_048 - stderr.length);
    });
    child.once("error", (error) => {
      if (isCurrent()) {
        this.emitEvent({ type: "call.error", callId, error: "remote-video: " + error.message });
      }
    });
    child.once("close", (code, closeSignal) => {
      // Capture the lifecycle state BEFORE releasing ownership; isCurrent()
      // checks remoteVideoProcess === child, so checking it afterward silently
      // suppressed every unexpected decoder-crash diagnostic.
      const wasCurrent = isCurrent();
      if (this.remoteVideoProcess === child) this.remoteVideoProcess = null;
      if (!wasCurrent || code === 0) return;
      writeCallDiagnostic({
        type: "remote_video_decoder_exit",
        code,
        signal: closeSignal,
        reason: stderr.trim().slice(0, 500),
      });
      this.emitEvent({
        type: "call.error",
        callId,
        error: "remote-video: H.264 decoder stopped",
      });
    });

    writeCallDiagnostic({ type: "remote_video_receive_start", callId });
    void (async () => {
      const writeFrame = async (frame: Uint8Array) => {
        if (!isCurrent() || child.stdin.destroyed) return;
        const record = Buffer.allocUnsafe(frame.length + 4);
        record.writeUInt32LE(frame.length, 0);
        Buffer.from(frame).copy(record, 4);
        if (child.stdin.write(record)) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            child.stdin.removeListener("drain", done);
            child.stdin.removeListener("error", done);
            child.removeListener("close", done);
            resolve();
          };
          child.stdin.once("drain", done);
          child.stdin.once("error", done);
          child.once("close", done);
        });
      };

      try {
        for await (const packet of packets) {
          if (!isCurrent()) return;
          const frame = depacketizer.push(packet);
          if (frame) await writeFrame(frame);
        }
      } catch (error) {
        if (!isCurrent()) return;
        const reason = error instanceof Error ? error.message : String(error);
        this.emitEvent({ type: "call.error", callId, error: "remote-video: " + reason });
      }
    })();
  }

  private async stopVideoCapture(): Promise<void> {
    const process = this.videoProcess;
    this.videoProcess = null;
    this.videoEnabled = false;
    this.videoMode = null;
    if (process && process.exitCode === null) {
      try { process.kill("SIGTERM"); } catch { /* already exited */ }
    }
    if (process) {
      await waitForExit(process);
      writeCallDiagnostic({ type: "video_capture_stop", reason: "disabled" });
    }
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
    const epoch = this.lifecycleEpoch;
    const callId = this.lifecycleCallId ?? undefined;
    const session = this.session;
    const transport = this.activeTransport;
    const input = this.input;
    const output = this.output;
    const audioAbort = this.audioAbort;
    const answerAbort = this.incomingAnswerAbort;
    const remoteVideoProcess = this.remoteVideoProcess;
    this.remoteVideoProcess = null;

    // Release ownership synchronously before the first await. A new incoming
    // call can now be admitted without seeing stale resources from this call.
    this.session = null;
    this.activeTransport = null;
    this.input = null;
    this.output = null;
    this.audioAbort = null;
    this.incomingAnswerAbort = null;
    this.incoming = null;
    this.lifecycleCallId = null;
    this.muted = false;

    answerAbort?.abort();
    audioAbort?.abort();
    if (remoteVideoProcess) {
      try { remoteVideoProcess.stdin.end(); } catch { /* decoder may already be closed */ }
      if (remoteVideoProcess.exitCode === null) {
        try { remoteVideoProcess.kill("SIGTERM"); } catch { /* already closed */ }
      }
    }

    writeCallDiagnostic({ type: "call_cleanup_start", reason });

    // Do not use manager fields below this point: a later call may already own
    // them. Only close the snapshots captured above.
    await this.stopVideoCapture().catch(() => undefined);
    await input?.close().catch(() => undefined);
    await output?.end().catch(() => undefined);
    await session?.end(reason).catch(() => undefined);
    if (!session) await transport?.close().catch(() => undefined);
    await (remoteVideoProcess ? waitForExit(remoteVideoProcess) : Promise.resolve());

    writeCallDiagnostic({ type: "call_cleanup_done", reason });

    // A newer incoming/outgoing lifecycle supersedes this terminal event.
    if (this.lifecycleEpoch === epoch && this.lifecycleCallId === null) {
      this.emitEvent({ type: "call.ended", callId, reason, state: "ended" });
    }
  }

  async setOutputTarget(value: unknown): Promise<{ target?: string }> {
    const target = safeAudioTarget(value);
    if (target) {
      const { outputs } = this.devices;
      if (!outputs.length) throw new Error("no speaker output devices are available");
      if (!outputs.some((device) => device.id === target || device.name === target)) {
        throw new Error("selected speaker output was not found");
      }
    }
    this.outputTarget = target;
    await this.output?.setTarget(target);
    return target ? { target } : {};
  }

  private async loadCodec(): Promise<CodecFactory> {
    this.codecReady ??= opusCodecFactory().then((base) => resilientCallCodecFactory(base, (event) => {
      writeCallDiagnostic({
        type: "audio_decode_drop",
        reason: event.reason,
        bytes: event.bytes,
        consecutive: event.consecutive,
      });
    }));
    const codec = await this.codecReady;
    if (this.client) LineJsAdapter.setCallCodecFactory(this.client, codec);
    return codec;
  }

  private bindSession(
    session: CallSession,
    peer: string,
    callId: string,
    epoch: number,
  ): void {
    const isCurrent = () =>
      this.lifecycleEpoch === epoch && this.lifecycleCallId === callId;
    session.on("state", (state) => {
      writeCallDiagnostic({ type: "session_state", state });
      if (!isCurrent()) return;
      this.emitEvent({ type: "call.state", callId, peer, state });
    });
    session.on("error", (error) => {
      writeCallDiagnostic({ type: "session_error", reason: error.message });
      if (!isCurrent()) return;
      this.emitEvent({ type: "call.error", callId, peer, error: error.message });
    });
    session.on("ended", (reason) => {
      writeCallDiagnostic({ type: "session_ended", reason });
      if (isCurrent() && this.session === session) {
        void this.stop(reason).catch(() => undefined);
      }
    });
  }

  private async startAudioPipelines(session: CallSession): Promise<void> {
    const input = new NativeAudioSource(this.inputTarget);
    const output = new NativeAudioSink(this.outputTarget);
    const audioAbort = new AbortController();
    this.audioAbort = audioAbort;
    this.input = input;
    this.output = output;

    const fail = (error: unknown) => {
      if (audioAbort.signal.aborted) return;
      const reason = error instanceof Error ? error.message : String(error);
      writeCallDiagnostic({ type: "audio_pipeline_error", reason });
      this.emitEvent({ type: "call.error", error: reason });
      void this.stop("audio-failed");
    };

    // Keep device integration in Liney, but let LINEJS own Opus packetization,
    // transport.send/receive and codec lifetime. This removes a duplicate media
    // stack that could drift from upstream PLANET/SRTP behavior.
    const isMuted = () => this.muted;
    const source = {
      async *frames(opts: { signal?: AbortSignal } = {}) {
        for await (const frame of input.frames(opts)) {
          if (opts.signal?.aborted) return;
          if (isMuted()) continue;
          yield frame;
        }
      },
    };

    writeCallDiagnostic({ type: "audio_pipeline_start" });
    void session.sendStream(source, { signal: audioAbort.signal }).catch(fail);
    void session.receiveInto(output).catch(fail);
  }

  private async startIncomingPlanetAudioPipelines(
    transport: ConnectedPlanetAudioTransport,
    codecs: CodecFactory,
  ): Promise<void> {
    const input = new NativeAudioSource(this.inputTarget);
    const output = new NativeAudioSink(this.outputTarget);
    const audioAbort = new AbortController();
    this.audioAbort = audioAbort;
    this.input = input;
    this.output = output;

    const encoder = codecs.newEncoder({
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
      frameDurationMs: AUDIO_FRAME_MS,
      signal: "voice",
      vbr: true,
    });
    const decoder = codecs.newDecoder({
      sampleRate: AUDIO_SAMPLE_RATE,
      channels: AUDIO_CHANNELS,
    });
    const jitter = new RtpJitterBuffer({
      clockRate: AUDIO_SAMPLE_RATE,
      onStats: (stats) => writeCallDiagnostic({
        type: "rtp_jitter_stats",
        jitterMs: Math.round(stats.jitterMs * 10) / 10,
        targetMs: Math.round(stats.targetMs),
        bufferedPackets: stats.bufferedPackets,
        reordered: stats.reordered,
        lateDrops: stats.lateDrops,
        lostPackets: stats.lostPackets,
      }),
    });

    const fail = (error: unknown) => {
      if (audioAbort.signal.aborted) return;
      const reason = error instanceof Error ? error.message : String(error);
      writeCallDiagnostic({ type: "audio_pipeline_error", reason });
      this.emitEvent({ type: "call.error", error: reason });
      void this.stop("audio-failed");
    };

    writeCallDiagnostic({ type: "audio_pipeline_start", result: "incoming-planet-rtp-clock" });

    void (async () => {
      try {
        for await (const frame of input.frames({ signal: audioAbort.signal })) {
          if (audioAbort.signal.aborted) return;
          if (this.muted) continue;
          const packet = encoder.encode(frame);
          if (packet) await transport.send(packet);
        }
      } finally {
        encoder.close?.();
      }
    })().catch(fail);

    void (async () => {
      try {
        for await (const packet of transport.receiveMediaDetailed()) {
          if (audioAbort.signal.aborted) return;
          jitter.push(packet);
        }
      } finally {
        jitter.close();
      }
    })().catch(fail);

    void (async () => {
      try {
        for await (const item of jitter.playout(audioAbort.signal)) {
          if (audioAbort.signal.aborted) return;
          if (item.kind === "packet") {
            const frame = decoder.decode(item.packet.payload);
            if (frame) await output.writeClocked(frame);
            continue;
          }
          const silenceSamples = Math.max(
            1,
            Math.round(item.durationSamples * AUDIO_CHANNELS),
          );
          await output.writeClocked({
            samples: new Int16Array(silenceSamples),
            sampleRate: AUDIO_SAMPLE_RATE,
            channels: AUDIO_CHANNELS,
          });
        }
      } finally {
        decoder.close?.();
      }
    })().catch(fail);
  }}
