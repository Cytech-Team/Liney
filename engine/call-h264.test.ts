import { describe, expect, test } from "bun:test";
import { AnnexBStream, H264FrameAssembler, packetizeH264Frame, packetizeNal } from "./call-h264";

describe("H.264 RTP helpers", () => {
  test("splits Annex-B across arbitrary chunks", () => {
    const stream = new AnnexBStream();
    expect(stream.push(new Uint8Array([0,0,0,1,0x67,1,2,0,0]))).toEqual([]);
    const out = stream.push(new Uint8Array([1,0x68,3,0,0,0,1,0x65,4]));
    expect([...out[0]!]).toEqual([0x67,1,2]);
    expect([...out[1]!]).toEqual([0x68,3]);
    expect([...stream.finish()[0]!]).toEqual([0x65,4]);
  });

  test("uses a single RTP payload for a small NAL", () => {
    const nal = new Uint8Array([0x65,1,2,3]);
    expect(packetizeNal(nal, 8)).toEqual([nal]);
  });

  test("fragments a large NAL as FU-A and marks the final frame packet", () => {
    const nal = new Uint8Array([0x65,1,2,3,4,5,6,7,8]);
    const frame = packetizeH264Frame([nal], 5);
    expect(frame.length).toBe(3);
    expect(frame[0]!.payload[0]! & 0x1f).toBe(28);
    expect(frame[0]!.payload[1]! & 0x80).toBe(0x80);
    expect(frame.at(-1)!.payload[1]! & 0x40).toBe(0x40);
    expect(frame.map((x) => x.marker)).toEqual([false,false,true]);
  });

  test("groups access units at AUD/picture boundaries", () => {
    const a = new H264FrameAssembler();
    expect(a.push(new Uint8Array([0x09]))).toEqual([]);
    expect(a.push(new Uint8Array([0x67]))).toEqual([]);
    expect(a.push(new Uint8Array([0x65,1]))).toEqual([]);
    const completed = a.push(new Uint8Array([0x09]));
    expect(completed).toHaveLength(1);
    expect(completed[0]!.map((x) => x[0]! & 0x1f)).toEqual([9,7,5]);
  });
});
