import { describe, expect, test } from "bun:test";
import { emojiFromPack, ownedEmojiPacksFromSummaries, sticonIdsFromMeta } from "./sticon-catalog";

describe("ownedEmojiPacksFromSummaries", () => {
  test("reads emoji packs from the sticonshop product list", () => {
    expect(ownedEmojiPacksFromSummaries({ productList: [
      {
        id: "14335489",
        latestVersion: "3",
        productTypeSummary: { sticonSummary: { sticonResourceType: 1 } },
      },
      {
        id: "670e0cce840a8236ddd4ee4c",
        latestVersion: "1",
        productTypeSummary: { sticonSummary: { sticonResourceType: 2 } },
      },
    ] })).toEqual([
      { productId: "14335489", version: "3", resourceType: "STATIC" },
      { productId: "670e0cce840a8236ddd4ee4c", version: "1", resourceType: "ANIMATION" },
    ]);
  });

  test("ignores products that are not emoji and duplicates", () => {
    expect(ownedEmojiPacksFromSummaries({ productList: [
      { id: "11392", latestVersion: "11", productTypeSummary: { stickerSummary: { stickerResourceType: 1 } } },
      { id: "14335489", latestVersion: "3", productTypeSummary: { sticonSummary: { sticonResourceType: 1 } } },
      { id: "14335489", latestVersion: "3", productTypeSummary: { sticonSummary: { sticonResourceType: 1 } } },
      { id: "bad id", latestVersion: "1", productTypeSummary: { sticonSummary: { sticonResourceType: 1 } } },
    ] })).toEqual([{ productId: "14335489", version: "3", resourceType: "STATIC" }]);
  });

  test("accepts unrenamed thrift field numbers", () => {
    expect(ownedEmojiPacksFromSummaries({ "1": [
      { "1": "14335489", "21": "4", "9": { sticonSummary: { sticonResourceType: 2 } } },
    ] })).toEqual([{ productId: "14335489", version: "4", resourceType: "ANIMATION" }]);
  });
});

describe("sticonIdsFromMeta", () => {
  test("keeps the manifest order and drops invalid ids", () => {
    expect(sticonIdsFromMeta({ orders: ["123", "124", "123", "", "bad id"] })).toEqual(["123", "124"]);
    expect(sticonIdsFromMeta({})).toEqual([]);
    expect(sticonIdsFromMeta(null)).toEqual([]);
  });
});

describe("emojiFromPack", () => {
  test("expands a pack into sendable emoji entries", () => {
    expect(emojiFromPack({ productId: "14335489", version: "3", resourceType: "STATIC" }, ["123", "124"])).toEqual([
      { productId: "14335489", sticonId: "123", version: "3", resourceType: "STATIC", owned: true },
      { productId: "14335489", sticonId: "124", version: "3", resourceType: "STATIC", owned: true },
    ]);
  });
});
