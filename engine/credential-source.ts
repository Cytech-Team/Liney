import type { AuthCredential } from "./secure-storage";

export type CredentialSource = "wallet" | "fallback" | "migrated-wallet" | "legacy" | "none";

export function selectCredential(input: {
  wallet: AuthCredential | null;
  fallback: AuthCredential | null;
  migratedWallet: AuthCredential | null;
  legacy: AuthCredential | null;
}): { credential: AuthCredential | null; source: CredentialSource } {
  if (input.wallet) return { credential: input.wallet, source: "wallet" };
  if (input.fallback) return { credential: input.fallback, source: "fallback" };
  if (input.migratedWallet) return { credential: input.migratedWallet, source: "migrated-wallet" };
  if (input.legacy) return { credential: input.legacy, source: "legacy" };
  return { credential: null, source: "none" };
}
