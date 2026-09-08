export type OwnedSticker = {
  packageId: string;
  stickerId: string;
  version: string;
  option?: string;
  owned: true;
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function numericId(value: unknown): string | undefined {
  const id = String(value ?? "").trim();
  return /^\d{1,30}$/.test(id) ? id : undefined;
}

/** Reads only the account's purchased Shop products, never chat history. */
export function ownedStickersFromPurchases(value: unknown): OwnedSticker[] {
  const root = record(value);
  // getOwnedProducts returns productList while older Shop endpoints return
  // purchaseRecords containing productDetail.  Both are account inventory.
  const records = Array.isArray(root?.productList)
    ? root.productList.map((productDetail) => ({ productDetail }))
    : Array.isArray(root?.purchaseRecords) ? root.purchaseRecords : [];
  const seen = new Set<string>();
  const result: OwnedSticker[] = [];
  for (const entry of records) {
    const purchase = record(entry);
    const detail = record(purchase?.productDetail);
    const packageId = numericId(detail?.id);
    if (!packageId) continue;
    const productProperty = record(detail?.productProperty);
    const stickerProperty = record(productProperty?.stickerProperty);
    const stickerIds = Array.isArray(stickerProperty?.stickerIds) ? stickerProperty.stickerIds : [];
    const version = numericId(detail?.version ?? detail?.latestVersion) ?? "1";
    const option = typeof stickerProperty?.stickerOptions === "string" ? stickerProperty.stickerOptions.trim().toUpperCase() : "";
    for (const candidate of stickerIds) {
      const stickerId = numericId(candidate);
      if (!stickerId || (packageId === "30563" && stickerId === "651698630")) continue;
      const key = `${packageId}:${stickerId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ packageId, stickerId, version, ...(option ? { option } : {}), owned: true });
    }
  }
  return result;
}
