export type H264RtpPacket = {
  payload: Uint8Array;
  marker: boolean;
  seq: number;
  timestamp: number;
};

/** Reassembles RFC 6184 single-NAL, STAP-A, and FU-A RTP packets into Annex-B frames. */
export class H264RtpDepacketizer {
  private readonly startCode = Uint8Array.of(0, 0, 0, 1);
  private accessUnit: Uint8Array[] = [];
  private accessUnitBytes = 0;
  private fragment: { header: number; chunks: Uint8Array[]; bytes: number } | null = null;
  private expectedSequence: number | undefined;
  private currentTimestamp: number | undefined;
  private dropCurrentFrame = false;

  push(packet: H264RtpPacket): Uint8Array | undefined {
    const sequence = packet.seq & 0xffff;
    const timestamp = packet.timestamp >>> 0;
    const newFrame = this.currentTimestamp !== undefined && timestamp !== this.currentTimestamp;

    if (newFrame) {
      this.clearFrame();
      this.dropCurrentFrame = false;
      // A missing packet at the end of the preceding frame must not discard
      // the next complete frame.
      this.expectedSequence = sequence;
    } else if (this.expectedSequence !== undefined && sequence !== this.expectedSequence) {
      this.clearFrame();
      this.dropCurrentFrame = true;
    }

    this.currentTimestamp = timestamp;
    this.expectedSequence = (sequence + 1) & 0xffff;

    const payload = packet.payload;
    if (this.dropCurrentFrame) {
      if (packet.marker) this.finishFrame();
      return undefined;
    }
    if (payload.length < 1 || (payload[0]! & 0x80) !== 0) {
      this.dropCurrentFrame = true;
      if (packet.marker) this.finishFrame();
      return undefined;
    }

    const type = payload[0]! & 0x1f;
    if (type >= 1 && type <= 23) {
      if (this.fragment) {
        this.dropCurrentFrame = true;
      } else {
        this.appendNal(payload);
      }
    } else if (type === 24) {
      if (this.fragment || !this.appendStapA(payload)) this.dropCurrentFrame = true;
    } else if (type === 28) {
      this.appendFuA(payload);
    } else {
      this.dropCurrentFrame = true;
    }

    if (!packet.marker) return undefined;
    if (this.fragment) this.dropCurrentFrame = true;
    if (this.dropCurrentFrame || this.accessUnitBytes === 0) {
      this.finishFrame();
      return undefined;
    }

    const frame = new Uint8Array(this.accessUnitBytes);
    let offset = 0;
    for (const nal of this.accessUnit) {
      frame.set(nal, offset);
      offset += nal.length;
    }
    this.finishFrame();
    return frame;
  }

  reset(): void {
    this.clearFrame();
    this.expectedSequence = undefined;
    this.currentTimestamp = undefined;
    this.dropCurrentFrame = false;
  }

  private appendStapA(payload: Uint8Array): boolean {
    let offset = 1;
    let count = 0;
    while (offset < payload.length) {
      if (offset + 2 > payload.length) return false;
      const length = (payload[offset]! << 8) | payload[offset + 1]!;
      offset += 2;
      if (length < 1 || offset + length > payload.length) return false;
      this.appendNal(payload.subarray(offset, offset + length));
      if (this.dropCurrentFrame) return false;
      offset += length;
      count += 1;
    }
    return count > 0;
  }

  private appendFuA(payload: Uint8Array): void {
    if (payload.length < 3) {
      this.dropCurrentFrame = true;
      return;
    }

    const indicator = payload[0]!;
    const header = payload[1]!;
    const start = (header & 0x80) !== 0;
    const end = (header & 0x40) !== 0;
    const nalType = header & 0x1f;
    if (start && end) {
      this.dropCurrentFrame = true;
      return;
    }

    if (start) {
      if (this.fragment) this.dropCurrentFrame = true;
      if (this.dropCurrentFrame) return;
      this.fragment = {
        header: (indicator & 0xe0) | nalType,
        chunks: [payload.subarray(2).slice()],
        bytes: payload.length - 2,
      };
      return;
    }

    const fragment = this.fragment;
    if (!fragment || (fragment.header & 0x1f) !== nalType) {
      this.dropCurrentFrame = true;
      this.fragment = null;
      return;
    }
    fragment.chunks.push(payload.subarray(2).slice());
    fragment.bytes += payload.length - 2;
    if (fragment.bytes + 5 > 4 * 1024 * 1024) {
      this.dropCurrentFrame = true;
      this.fragment = null;
      return;
    }
    if (!end) return;

    const nal = new Uint8Array(fragment.bytes + 1);
    nal[0] = fragment.header;
    let offset = 1;
    for (const chunk of fragment.chunks) {
      nal.set(chunk, offset);
      offset += chunk.length;
    }
    this.fragment = null;
    this.appendNal(nal);
  }

  private appendNal(nal: Uint8Array): void {
    if (!nal.length) {
      this.dropCurrentFrame = true;
      return;
    }
    const bytes = nal.length + this.startCode.length;
    if (this.accessUnitBytes + bytes > 4 * 1024 * 1024) {
      this.dropCurrentFrame = true;
      this.clearAccessUnit();
      return;
    }
    const annexB = new Uint8Array(bytes);
    annexB.set(this.startCode);
    annexB.set(nal, this.startCode.length);
    this.accessUnit.push(annexB);
    this.accessUnitBytes += annexB.length;
  }

  private finishFrame(): void {
    this.clearFrame();
    this.dropCurrentFrame = false;
  }

  private clearFrame(): void {
    this.clearAccessUnit();
    this.fragment = null;
  }

  private clearAccessUnit(): void {
    this.accessUnit = [];
    this.accessUnitBytes = 0;
  }
}
