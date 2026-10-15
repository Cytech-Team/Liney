/**
 * LINE PLANET 1:1 audio carries one native framing byte before every Opus
 * packet. The native prefix is not part of the Opus TOC and is not guaranteed
 * to stay at 0x00 for the whole stream (LINE's native/group framing also uses
 * 0x10). Strip exactly one byte on receive and add exactly one byte on send.
 */
export function framePlanetOneToOneOpus(packet: Uint8Array): Uint8Array {
  const framed = new Uint8Array(packet.length + 1);
  framed[0] = 0x00;
  framed.set(packet, 1);
  return framed;
}

export function unframePlanetOneToOneOpus(packet: Uint8Array): Uint8Array {
  return packet.length > 1 ? packet.subarray(1) : packet;
}
