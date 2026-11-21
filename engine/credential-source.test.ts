import { describe, expect, test } from "bun:test";
import { selectCredential } from "./credential-source";

const wallet = { accessToken: "wallet-access" };
const fallback = { accessToken: "fallback-access" };
const migrated = { accessToken: "migrated-access" };
const legacy = { accessToken: "legacy-access" };

describe("credential selection", () => {
  test("prefers the Wallet over every other source", () => {
    expect(selectCredential({ wallet, fallback, migratedWallet: migrated, legacy })).toEqual({
      credential: wallet,
      source: "wallet",
    });
  });

  test("uses the encrypted fallback when the Wallet is unavailable", () => {
    expect(selectCredential({ wallet: null, fallback, migratedWallet: migrated, legacy })).toEqual({
      credential: fallback,
      source: "fallback",
    });
  });

  test("uses a migrated Wallet credential when live stores are empty", () => {
    expect(selectCredential({ wallet: null, fallback: null, migratedWallet: migrated, legacy })).toEqual({
      credential: migrated,
      source: "migrated-wallet",
    });
  });

  test("uses legacy credentials as the last resort", () => {
    expect(selectCredential({ wallet: null, fallback: null, migratedWallet: null, legacy })).toEqual({
      credential: legacy,
      source: "legacy",
    });
  });

  test("reports none when no credential exists", () => {
    expect(selectCredential({ wallet: null, fallback: null, migratedWallet: null, legacy: null })).toEqual({
      credential: null,
      source: "none",
    });
  });
});
