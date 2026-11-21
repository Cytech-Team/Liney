import { describe, expect, test } from "bun:test";
import { isPrivateAddress } from "./net-guard";

describe("private address guard", () => {
  test("rejects private and reserved IPv4 ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.5.4",
      "192.168.1.1",
      "198.18.0.1",
      "203.0.113.9",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  test("allows public IPv4 addresses", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "203.0.114.1"]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  test("rejects IPv6 loopback, ULA, link-local and multicast", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "100::1"]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  test("rejects IPv4 embedded in every common IPv6 form", () => {
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b::a00:1",
      "2002:7f00:0001::1",
      "2002:c0a8:0101::1",
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  test("allows public IPv6 addresses including mapped public IPv4", () => {
    for (const address of [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "64:ff9b::808:808",
      "2002:0808:0808::1",
    ]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  test("fails closed for an unparseable address", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});
