import { describe, expect, test } from "bun:test";
import { H264RtpDepacketizer, type H264RtpPacket } from "./call-h264-receive";

function packet(seq: number, timestamp: number, marker: boolean, ...bytes: number[]): H264RtpPacket {
  return { seq, timestamp, marker, payload: Uint8Array.from(bytes) };
}

const annexB = (...nals: number[][]): number[] => nals.flatMap((nal) => [0, 0, 0, 1, ...nal]);

describe("remote H.264 receive depacketization", () => {
  test("delivers complete single-NAL access units", () => {
    const decoder = new H264RtpDepacketizer();
    expect([...decoder.push(packet(10, 4, true, 0x65, 0x22, 0x33))!])
      .toEqual(annexB([0x65, 0x22, 0x33]));
  });

  test("reassembles FU-A across RTP sequence rollover", () => {
    const decoder = new H264RtpDepacketizer();
    expect(decoder.push(packet(65535, 100, false, 0x7c, 0x85, 0x11))).toBeUndefined();
    expect([...decoder.push(packet(0, 100, true, 0x7c, 0x45, 0x22))!])
      .toEqual(annexB([0x65, 0x11, 0x22]));
  });

  test("splits STAP-A without losing SPS and PPS", () => {
    const decoder = new H264RtpDepacketizer();
    expect([...decoder.push(packet(1, 200, true, 0x78, 0, 2, 0x67, 0x11, 0, 2, 0x68, 0x22))!])
      .toEqual(annexB([0x67, 0x11], [0x68, 0x22]));
  });

  test("discards a damaged frame but recovers cleanly at the next timestamp", () => {
    const decoder = new H264RtpDepacketizer();
    expect(decoder.push(packet(5, 300, false, 0x67, 0x11))).toBeUndefined();
    expect(decoder.push(packet(7, 300, true, 0x65, 0x22))).toBeUndefined();
    expect([...decoder.push(packet(8, 301, true, 0x65, 0x99))!])
      .toEqual(annexB([0x65, 0x99]));
  });

  test("rejects malformed aggregation payloads without passing corrupt frames", () => {
    const decoder = new H264RtpDepacketizer();
    expect(decoder.push(packet(10, 400, true, 0x78, 0, 10, 0x67))).toBeUndefined();
    expect([...decoder.push(packet(11, 401, true, 0x65, 0x44))!])
      .toEqual(annexB([0x65, 0x44]));
  });
});
