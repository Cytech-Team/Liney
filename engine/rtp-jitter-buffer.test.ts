import { describe, expect, test } from "bun:test";
import { RtpJitterBuffer, extendRtpSequence, extendRtpTimestamp, type RtpMediaPacket } from "./rtp-jitter-buffer";

function pkt(seq: number, timestamp: number): RtpMediaPacket {
  return { payloadType: 96, seq, timestamp, ssrc: 7, marker: false, payload: new Uint8Array([seq & 0xff]) };
}

describe("RTP jitter buffer", () => {
  test("extends sequence and timestamp across wraparound", () => {
    expect(extendRtpSequence(0, 65_535)).toBe(65_536);
    expect(extendRtpTimestamp(32, 0xfffffff0)).toBe(0x1_0000_0020);
  });

  test("reorders packets by RTP sequence before playout", async () => {
    let now = 0;
    const jitter = new RtpJitterBuffer({
      minStartPackets: 3,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    jitter.push(pkt(2, 1_920), 0);
    jitter.push(pkt(1, 0), 2);
    jitter.push(pkt(3, 3_840), 4);
    const it = jitter.playout()[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ kind: "packet", seq: 1 });
    expect((await it.next()).value).toMatchObject({ kind: "packet", seq: 2 });
    expect((await it.next()).value).toMatchObject({ kind: "packet", seq: 3 });
  });

  test("emits a loss slot when a sequence misses its RTP deadline", async () => {
    let now = 0;
    const jitter = new RtpJitterBuffer({
      minStartPackets: 3,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    jitter.push(pkt(10, 0), 0);
    jitter.push(pkt(12, 3_840), 2);
    jitter.push(pkt(13, 5_760), 4);
    const it = jitter.playout()[Symbol.asyncIterator]();
    expect((await it.next()).value).toMatchObject({ kind: "packet", seq: 10 });
    expect((await it.next()).value).toMatchObject({ kind: "loss", seq: 11, durationSamples: 1_920 });
    expect((await it.next()).value).toMatchObject({ kind: "packet", seq: 12 });
  });
});
