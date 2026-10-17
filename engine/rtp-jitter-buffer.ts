export type RtpMediaPacket = {
  payloadType: number;
  seq: number;
  timestamp: number;
  ssrc: number;
  marker: boolean;
  payload: Uint8Array;
};

export type RtpPlayoutEvent =
  | { kind: "packet"; packet: RtpMediaPacket; seq: number; timestamp: number; durationSamples: number }
  | { kind: "loss"; seq: number; timestamp: number; durationSamples: number };

export type RtpJitterStats = {
  jitterMs: number;
  targetMs: number;
  bufferedPackets: number;
  reordered: number;
  lateDrops: number;
  lostPackets: number;
};

type StoredPacket = {
  packet: RtpMediaPacket;
  extSeq: number;
  extTimestamp: number;
  arrivalMs: number;
};

type RtpJitterOptions = {
  clockRate?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onStats?: (stats: RtpJitterStats) => void;
  minStartPackets?: number;
};

export class RtpJitterBuffer {
  private readonly clockRate: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStats?: (stats: RtpJitterStats) => void;
  private readonly minStartPackets: number;
  private readonly packets = new Map<number, StoredPacket>();
  private readonly stepSamples: number[] = [];
  private highestSeq: number | undefined;
  private highestTimestamp: number | undefined;
  private lastArrivalSeq: number | undefined;
  private lastArrivalTimestamp: number | undefined;
  private lastTransit: number | undefined;
  private jitterSamples = 0;
  private nominalStep = 960;
  private started = false;
  private closed = false;
  private nextSeq: number | undefined;
  private baseTimestamp = 0;
  private lastTimestamp = 0;
  private basePlayoutMs = 0;
  private initialDelayMs = 0;
  private currentDelayMs = 0;
  private playedThroughSeq: number | undefined;
  private currentSsrc: number | undefined;
  private reordered = 0;
  private lateDrops = 0;
  private lostPackets = 0;
  private lastStatsAt = 0;

  constructor(opts: RtpJitterOptions = {}) {
    this.clockRate = opts.clockRate ?? 48_000;
    this.now = opts.now ?? (() => performance.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms)))));
    this.onStats = opts.onStats;
    this.minStartPackets = Math.max(2, opts.minStartPackets ?? 3);
  }

  push(packet: RtpMediaPacket, arrivalMs = this.now()): void {
    if (this.closed) return;
    if (this.currentSsrc !== undefined && packet.ssrc !== this.currentSsrc) this.resetStream(packet.ssrc);
    this.currentSsrc ??= packet.ssrc;

    const extSeq = extendRtpSequence(packet.seq, this.highestSeq);
    const extTimestamp = extendRtpTimestamp(packet.timestamp, this.highestTimestamp);
    if (this.playedThroughSeq !== undefined && extSeq <= this.playedThroughSeq) {
      this.lateDrops += 1;
      return;
    }
    if (this.packets.has(extSeq)) return;
    if (this.highestSeq !== undefined && extSeq < this.highestSeq) this.reordered += 1;

    this.packets.set(extSeq, { packet, extSeq, extTimestamp, arrivalMs });
    if (this.highestSeq === undefined || extSeq > this.highestSeq) {
      this.highestSeq = extSeq;
      this.highestTimestamp = extTimestamp;
    }

    if (this.lastArrivalSeq !== undefined && extSeq > this.lastArrivalSeq && this.lastArrivalTimestamp !== undefined) {
      const seqGap = extSeq - this.lastArrivalSeq;
      const tsGap = extTimestamp - this.lastArrivalTimestamp;
      if (seqGap > 0 && tsGap > 0 && tsGap < this.clockRate * 2) {
        const perPacket = Math.round(tsGap / seqGap);
        if (perPacket >= this.clockRate / 400 && perPacket <= this.clockRate * 0.12) {
          this.stepSamples.push(perPacket);
          if (this.stepSamples.length > 16) this.stepSamples.shift();
          this.nominalStep = median(this.stepSamples) || this.nominalStep;
        }
      }

      const transit = arrivalMs * this.clockRate / 1_000 - extTimestamp;
      if (this.lastTransit !== undefined) {
        const delta = Math.abs(transit - this.lastTransit);
        this.jitterSamples += (delta - this.jitterSamples) / 16;
      }
      this.lastTransit = transit;
      this.lastArrivalSeq = extSeq;
      this.lastArrivalTimestamp = extTimestamp;
    } else if (this.lastArrivalSeq === undefined || extSeq > this.lastArrivalSeq) {
      this.lastArrivalSeq = extSeq;
      this.lastArrivalTimestamp = extTimestamp;
      this.lastTransit = arrivalMs * this.clockRate / 1_000 - extTimestamp;
    }

    this.emitStatsMaybe();
  }

  close(): void {
    this.closed = true;
  }

  async *playout(signal?: AbortSignal): AsyncIterable<RtpPlayoutEvent> {
    while (!signal?.aborted) {
      if (!this.started) {
        if (!this.canStart()) {
          if (this.closed && this.packets.size === 0) return;
          await this.sleep(4);
          continue;
        }
        this.startPlayout();
      }

      if (this.nextSeq === undefined) return;
      let stored = this.packets.get(this.nextSeq);
      const expectedTimestamp = stored?.extTimestamp ?? (this.lastTimestamp + this.nominalStep);
      const targetNow = this.targetDelayMs();
      this.currentDelayMs += clamp(targetNow - this.currentDelayMs, -2, 2);
      const deadline = this.basePlayoutMs
        + ((expectedTimestamp - this.baseTimestamp) / this.clockRate) * 1_000
        + (this.currentDelayMs - this.initialDelayMs);
      const waitMs = deadline - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      if (signal?.aborted) return;

      stored = this.packets.get(this.nextSeq);
      if (stored) {
        this.packets.delete(this.nextSeq);
        this.lastTimestamp = stored.extTimestamp;
        const event: RtpPlayoutEvent = {
          kind: "packet",
          packet: stored.packet,
          seq: this.nextSeq,
          timestamp: stored.extTimestamp,
          durationSamples: this.nominalStep,
        };
        this.playedThroughSeq = this.nextSeq;
        this.nextSeq += 1;
        this.emitStatsMaybe(true);
        yield event;
        continue;
      }

      if (this.closed && this.highestSeq !== undefined && this.nextSeq > this.highestSeq) return;
      const loss: RtpPlayoutEvent = {
        kind: "loss",
        seq: this.nextSeq,
        timestamp: expectedTimestamp,
        durationSamples: this.nominalStep,
      };
      this.lostPackets += 1;
      this.lastTimestamp = expectedTimestamp;
      this.playedThroughSeq = this.nextSeq;
      this.nextSeq += 1;
      this.emitStatsMaybe(true);
      yield loss;
    }
  }

  stats(): RtpJitterStats {
    return {
      jitterMs: this.jitterSamples / this.clockRate * 1_000,
      targetMs: this.targetDelayMs(),
      bufferedPackets: this.packets.size,
      reordered: this.reordered,
      lateDrops: this.lateDrops,
      lostPackets: this.lostPackets,
    };
  }

  private canStart(): boolean {
    if (this.packets.size < this.minStartPackets) return false;
    const seqs = [...this.packets.keys()].sort((a, b) => a - b);
    const first = this.packets.get(seqs[0]!);
    const last = this.packets.get(seqs[seqs.length - 1]!);
    if (!first || !last) return false;
    const bufferedMs = (last.extTimestamp - first.extTimestamp + this.nominalStep) / this.clockRate * 1_000;
    return bufferedMs >= Math.min(this.targetDelayMs(), this.nominalStep / this.clockRate * 1_000 * this.minStartPackets);
  }

  private startPlayout(): void {
    const seqs = [...this.packets.keys()].sort((a, b) => a - b);
    const firstSeq = seqs[0];
    if (firstSeq === undefined) return;
    const first = this.packets.get(firstSeq);
    if (!first) return;
    this.nextSeq = firstSeq;
    this.baseTimestamp = first.extTimestamp;
    this.lastTimestamp = first.extTimestamp - this.nominalStep;
    this.initialDelayMs = this.targetDelayMs();
    this.currentDelayMs = this.initialDelayMs;
    this.basePlayoutMs = Math.max(this.now(), first.arrivalMs + this.initialDelayMs);
    this.started = true;
  }

  private targetDelayMs(): number {
    const frameMs = this.nominalStep / this.clockRate * 1_000;
    const jitterMs = this.jitterSamples / this.clockRate * 1_000;
    return clamp(Math.max(frameMs * 2, frameMs + jitterMs * 4), Math.max(20, frameMs * 2), 260);
  }

  private emitStatsMaybe(force = false): void {
    if (!this.onStats) return;
    const now = this.now();
    if (!force && now - this.lastStatsAt < 1_000) return;
    this.lastStatsAt = now;
    this.onStats(this.stats());
  }

  private resetStream(ssrc: number): void {
    this.packets.clear();
    this.stepSamples.length = 0;
    this.highestSeq = undefined;
    this.highestTimestamp = undefined;
    this.lastArrivalSeq = undefined;
    this.lastArrivalTimestamp = undefined;
    this.lastTransit = undefined;
    this.jitterSamples = 0;
    this.nominalStep = 960;
    this.started = false;
    this.nextSeq = undefined;
    this.baseTimestamp = 0;
    this.lastTimestamp = 0;
    this.playedThroughSeq = undefined;
    this.currentSsrc = ssrc;
  }
}

export function extendRtpSequence(value: number, reference?: number): number {
  return extendUnsigned(value & 0xffff, 0x1_0000, reference);
}

export function extendRtpTimestamp(value: number, reference?: number): number {
  return extendUnsigned(value >>> 0, 0x1_0000_0000, reference);
}

function extendUnsigned(value: number, modulo: number, reference?: number): number {
  if (reference === undefined) return value;
  const base = Math.floor(reference / modulo) * modulo;
  let candidate = base + value;
  const half = modulo / 2;
  if (candidate - reference > half) candidate -= modulo;
  else if (reference - candidate > half) candidate += modulo;
  return candidate;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
