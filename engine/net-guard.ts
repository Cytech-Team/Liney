import { isIP } from "node:net";

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function parseIpv6(address: string): number[] | null {
  const value = address.split("%")[0].toLowerCase();
  const parseParts = (part: string): number[] | null => {
    if (!part) return [];
    const result: number[] = [];
    for (const piece of part.split(":")) {
      if (!piece) return null;
      if (piece.includes(".")) {
        const v4 = piece.split(".").map(Number);
        if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        result.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
        result.push(parseInt(piece, 16));
      }
    }
    return result;
  };

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = parseParts(halves[0]);
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = parseParts(halves[1]);
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

/**
 * Fail-closed check for SSRF guards. Every IPv4 form embedded in IPv6
 * (mapped, compatible, NAT64 and 6to4) must be judged by the IPv4 rules,
 * otherwise `https://[::ffff:7f00:1]/` bypasses a dotted-quad-only guard.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;

  const hextets = parseIpv6(address);
  if (!hextets) return true;
  if (hextets.every((value) => value === 0)) return true;
  if (hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1) return true;
  if ((hextets[0] & 0xfe00) === 0xfc00) return true;
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;
  if ((hextets[0] & 0xffc0) === 0xfec0) return true;
  if ((hextets[0] & 0xff00) === 0xff00) return true;
  if (hextets[0] === 0x2001 && hextets[1] === 0x0db8) return true;
  if (hextets[0] === 0x0100 && hextets.slice(1, 4).every((value) => value === 0)) return true;

  const embedded = (high: number, low: number): string =>
    `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

  // ::ffff:0:0/96 (IPv4-mapped) and ::/96 (IPv4-compatible).
  if (hextets.slice(0, 5).every((value) => value === 0) && (hextets[5] === 0xffff || hextets[5] === 0)) {
    if (isPrivateIpv4(embedded(hextets[6], hextets[7]))) return true;
  }
  // 64:ff9b::/96 (NAT64).
  if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((value) => value === 0)) {
    if (isPrivateIpv4(embedded(hextets[6], hextets[7]))) return true;
  }
  // 2002::/16 (6to4) embeds IPv4 in the second and third hextets.
  if (hextets[0] === 0x2002 && isPrivateIpv4(embedded(hextets[1], hextets[2]))) return true;

  return false;
}
