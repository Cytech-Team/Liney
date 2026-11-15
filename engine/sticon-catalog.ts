export type OwnedEmoji = {
  productId: string;
  sticonId: string;
  version: string;
  resourceType: "STATIC" | "ANIMATION";
  owned: true;
};

export type OwnedEmojiPack = {
  productId: string;
  version: string;
  resourceType: "STATIC" | "ANIMATION";
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

/**
 * LINE emoji product ids are normally numeric, but newer seasonal packs use
 * 24-character hexadecimal ids, so keep the same asset-id shape LINE itself
 * accepts instead of a digits-only check.
 */
function assetId(value: unknown): string | undefined {
  const id = String(value ?? "").trim();
  return /^[0-9A-Za-z]{1,32}$/.test(id) ? id : undefined;
}

function numericVersion(value: unknown): string | undefined {
  const version = String(value ?? "").trim();
  return /^\d{1,30}$/.test(version) ? version : undefined;
}

function resourceTypeOf(value: unknown): "STATIC" | "ANIMATION" {
  // Shop sticonResourceType 2 is the animated variant, 1 is static.
  const raw = Number(value ?? 1);
  return raw === 2 ? "ANIMATION" : "STATIC";
}

/**
 * Reads the emoji packs the account owns from a `sticonshop`
 * getOwnedProductSummaries response. Chat traffic is never consulted.
 */
export function ownedEmojiPacksFromSummaries(value: unknown): OwnedEmojiPack[] {
  const root = record(value);
  const products = Array.isArray(root?.productList)
    ? root.productList
    : Array.isArray(root?.["1"]) ? root["1"] as unknown[] : [];
  const seen = new Set<string>();
  const result: OwnedEmojiPack[] = [];
  for (const entry of products) {
    const product = record(entry);
    if (!product) continue;
    // The product summary nests the resource type under productTypeSummary.
    const summary = record(product.productTypeSummary) ?? record(product["9"]);
    const sticon = record(summary?.sticonSummary) ?? record(summary?.sticon) ?? record(product.sticonSummary);
    // An explicit non-emoji summary means this is another shop product, not emoji.
    if (summary && !sticon) continue;
    const productId = assetId(product.id ?? product["1"]);
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);
    const version = numericVersion(product.latestVersion ?? product["21"]) ?? "1";
    const resourceType = resourceTypeOf(sticon?.sticonResourceType ?? sticon?.resourceType);
    result.push({ productId, version, resourceType });
  }
  return result;
}

/** `sticonshop/v1/product/<id>/android/meta.json` lists the pack contents. */
export function sticonIdsFromMeta(value: unknown): string[] {
  const root = record(value);
  const orders = Array.isArray(root?.orders) ? root.orders : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of orders) {
    const sticonId = assetId(candidate);
    if (!sticonId || seen.has(sticonId)) continue;
    seen.add(sticonId);
    result.push(sticonId);
  }
  return result;
}

export function emojiFromPack(pack: OwnedEmojiPack, sticonIds: string[]): OwnedEmoji[] {
  return sticonIds.map((sticonId) => ({
    productId: pack.productId,
    sticonId,
    version: pack.version,
    resourceType: pack.resourceType,
    owned: true as const,
  }));
}
