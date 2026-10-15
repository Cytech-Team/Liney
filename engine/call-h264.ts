export type H264Packet = { payload: Uint8Array; marker: boolean };

/** Stateful Annex-B splitter for an encoder byte stream. */
export class AnnexBStream {
  private tail = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    if (!chunk.length) return [];
    const data = new Uint8Array(this.tail.length + chunk.length);
    data.set(this.tail);
    data.set(chunk, this.tail.length);
    const starts = startCodes(data);
    if (starts.length < 2) {
      this.tail = data;
      return [];
    }
    const out: Uint8Array[] = [];
    for (let i = 0; i + 1 < starts.length; i++) {
      const current = starts[i]!;
      const next = starts[i + 1]!;
      const nal = data.subarray(current.offset + current.size, next.offset);
      if (nal.length) out.push(nal.slice());
    }
    this.tail = data.subarray(starts.at(-1)!.offset).slice();
    return out;
  }

  finish(): Uint8Array[] {
    const starts = startCodes(this.tail);
    if (!starts.length) {
      this.tail = new Uint8Array(0);
      return [];
    }
    const last = starts.at(-1)!;
    const nal = this.tail.subarray(last.offset + last.size);
    this.tail = new Uint8Array(0);
    return nal.length ? [nal.slice()] : [];
  }
}

/** Groups encoder NAL units into frame-sized access units. */
export class H264FrameAssembler {
  private current: Uint8Array[] = [];
  private hasPicture = false;

  push(nal: Uint8Array): Uint8Array[][] {
    if (!nal.length) return [];
    const type = nal[0]! & 0x1f;
    const picture = type === 1 || type === 5;
    const boundary = type === 9 || (this.hasPicture && (picture || type === 6 || type === 7 || type === 8));
    const completed: Uint8Array[][] = [];
    if (boundary && this.current.length) completed.push(this.take());
    this.current.push(nal);
    if (picture) this.hasPicture = true;
    return completed;
  }

  finish(): Uint8Array[][] {
    return this.current.length ? [this.take()] : [];
  }

  private take(): Uint8Array[] {
    const result = this.current;
    this.current = [];
    this.hasPicture = false;
    return result;
  }
}

/** RFC 6184 packetization mode 1: single NAL or FU-A fragmentation. */
export function packetizeH264Frame(nals: readonly Uint8Array[], mtuPayload = 1100): H264Packet[] {
  if (mtuPayload < 3) throw new Error("H.264 RTP payload limit is too small");
  const payloads: Uint8Array[] = [];
  for (const nal of nals) payloads.push(...packetizeNal(nal, mtuPayload));
  return payloads.map((payload, index) => ({ payload, marker: index === payloads.length - 1 }));
}

export function packetizeNal(nal: Uint8Array, mtuPayload = 1100): Uint8Array[] {
  if (!nal.length) return [];
  if (nal.length <= mtuPayload) return [nal.slice()];
  if (mtuPayload < 3) throw new Error("H.264 RTP payload limit is too small");
  const original = nal[0]!;
  const nriAndForbidden = original & 0xe0;
  const nalType = original & 0x1f;
  const chunk = mtuPayload - 2;
  const out: Uint8Array[] = [];
  for (let at = 1; at < nal.length; at += chunk) {
    const end = Math.min(nal.length, at + chunk);
    const packet = new Uint8Array(2 + end - at);
    packet[0] = nriAndForbidden | 28;
    packet[1] = nalType | (at === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0);
    packet.set(nal.subarray(at, end), 2);
    out.push(packet);
  }
  return out;
}

function startCodes(data: Uint8Array): Array<{ offset: number; size: 3 | 4 }> {
  const result: Array<{ offset: number; size: 3 | 4 }> = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    if (data[i + 2] === 1) {
      result.push({ offset: i, size: 3 });
      i += 2;
    } else if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) {
      result.push({ offset: i, size: 4 });
      i += 3;
    }
  }
  return result;
}
