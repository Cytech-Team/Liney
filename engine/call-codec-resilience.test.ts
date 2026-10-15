import { describe, expect, test } from "bun:test";
import { resilientCallCodecFactory } from "./call-codec-resilience";
import type { CodecFactory } from "./linejs/adapter";

function fakeFactory(failPackets: Set<number>): CodecFactory {
  let decodeIndex = 0;
  return {
    newEncoder() {
      return { encode: () => new Uint8Array([1]) };
    },
    newDecoder(opts) {
      return {
        decode() {
          decodeIndex += 1;
          if (failPackets.has(decodeIndex)) throw new Error("Invalid packet");
          return { samples: new Int16Array([1, 2]), sampleRate: opts.sampleRate, channels: opts.channels };
        },
      };
    },
  };
}

describe("resilient call codec", () => {
  test("drops an isolated malformed Opus packet and recovers on the next packet", () => {
    const dropped: number[] = [];
    const codec = resilientCallCodecFactory(fakeFactory(new Set([2])), (event) => dropped.push(event.consecutive));
    const decoder = codec.newDecoder({ sampleRate: 48_000, channels: 1 });
    expect(decoder.decode(new Uint8Array([1]))).not.toBeNull();
    expect(decoder.decode(new Uint8Array([2]))).toBeNull();
    expect(decoder.decode(new Uint8Array([3]))).not.toBeNull();
    expect(dropped).toEqual([1]);
  });

  test("fails only after a sustained run of malformed packets", () => {
    const codec = resilientCallCodecFactory(fakeFactory(new Set([1, 2, 3])), undefined, 3);
    const decoder = codec.newDecoder({ sampleRate: 48_000, channels: 1 });
    expect(decoder.decode(new Uint8Array([1]))).toBeNull();
    expect(decoder.decode(new Uint8Array([2]))).toBeNull();
    expect(() => decoder.decode(new Uint8Array([3]))).toThrow("3 consecutive packets");
  });
});
