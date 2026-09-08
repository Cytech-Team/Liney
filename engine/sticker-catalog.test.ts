import { describe, expect, test } from "bun:test";
import { ownedStickersFromPurchases } from "./sticker-catalog";

describe("ownedStickersFromPurchases", () => {
  test("only returns stickers attached to purchased account products", () => {
    expect(ownedStickersFromPurchases({ purchaseRecords: [{ productDetail: {
      id: "11537", version: "2", productProperty: { stickerProperty: { stickerIds: ["52002734", "52002735", "52002734"], stickerOptions: "a" } },
    } }] })).toEqual([
      { packageId: "11537", stickerId: "52002734", version: "2", option: "A", owned: true },
      { packageId: "11537", stickerId: "52002735", version: "2", option: "A", owned: true },
    ]);
  });

  test("ignores malformed and arranging placeholders", () => {
    expect(ownedStickersFromPurchases({ purchaseRecords: [
      { productDetail: { id: "30563", productProperty: { stickerProperty: { stickerIds: ["651698630"] } } } },
      { productDetail: { id: "bad", productProperty: { stickerProperty: { stickerIds: ["1"] } } } },
    ] })).toEqual([]);
  });

  test("accepts the getOwnedProducts productList response", () => {
    expect(ownedStickersFromPurchases({ productList: [{
      id: "5", latestVersion: "100", productProperty: { stickerProperty: { stickerIds: ["13"] } },
    }] })).toEqual([{ packageId: "5", stickerId: "13", version: "100", owned: true }]);
  });
});
