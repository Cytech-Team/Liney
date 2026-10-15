export function classifyVideoRtpPayload(payload: Uint8Array): string {
  if (payload.length === 0) return "empty";
  const b0 = payload[0]!;
  const forbiddenZero = (b0 & 0x80) === 0;
  const nalType = b0 & 0x1f;
  if (forbiddenZero) {
    if (nalType === 28 && payload.length >= 2) return "h264-fu-a";
    if (nalType === 24) return "h264-stap-a";
    if (nalType === 25) return "h264-stap-b";
    if (nalType === 26) return "h264-mtap16";
    if (nalType === 27) return "h264-mtap24";
    if ([1, 5, 6, 7, 8, 9].includes(nalType)) return `h264-nal-${nalType}`;
  }
  return "unknown";
}
