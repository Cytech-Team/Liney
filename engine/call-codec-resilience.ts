import type { CodecFactory } from "./linejs/adapter";

export type DecodeDropEvent = {
  reason: string;
  bytes: number;
  consecutive: number;
};

export function resilientCallCodecFactory(
  base: CodecFactory,
  onDecodeDrop?: (event: DecodeDropEvent) => void,
  maxConsecutiveDecodeFailures = 25,
): CodecFactory {
  return {
    newEncoder(opts) {
      return base.newEncoder(opts);
    },
    newDecoder(opts) {
      const decoder = base.newDecoder(opts);
      let consecutiveFailures = 0;
      return {
        decode(packet) {
          try {
            const frame = decoder.decode(packet);
            consecutiveFailures = 0;
            return frame;
          } catch (error) {
            consecutiveFailures += 1;
            const reason = error instanceof Error ? error.message : String(error);
            onDecodeDrop?.({ reason, bytes: packet.length, consecutive: consecutiveFailures });
            if (consecutiveFailures >= maxConsecutiveDecodeFailures) {
              throw new Error(
                `Opus decode failed ${consecutiveFailures} consecutive packets: ${reason}`,
              );
            }
            // A single authenticated RTP payload can still be malformed. Drop it
            // like packet loss instead of tearing the whole call down.
            return null;
          }
        },
        close() {
          decoder.close?.();
        },
      };
    },
  };
}
