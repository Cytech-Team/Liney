import { describe, expect, test } from "bun:test";
import { classifyVideoRtpPayload } from "./call-video-probe";

describe("video RTP probe", () => {
  test("recognizes common H.264 RTP packetization without storing payload bytes", () => {
    expect(classifyVideoRtpPayload(new Uint8Array([0x7c, 0x85, 1, 2]))).toBe("h264-fu-a");
    expect(classifyVideoRtpPayload(new Uint8Array([0x78, 1, 2]))).toBe("h264-stap-a");
    expect(classifyVideoRtpPayload(new Uint8Array([0x65, 1, 2]))).toBe("h264-nal-5");
    expect(classifyVideoRtpPayload(new Uint8Array())).toBe("empty");
  });
});
