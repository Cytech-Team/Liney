import { describe, expect, test } from "bun:test";
import type { Client } from "@evex/linejs";
import { listLineAlbums, listLineAlbumPhotos, previewLineAlbumPhoto } from "./albums";

function mockClient(moa: Record<string, unknown>): Client {
  return { base: { moa } } as unknown as Client;
}

describe("LINEJS Album/Moa read-only facade", () => {
  test("lists normalised albums and does not leak upstream metadata", async () => {
    let supplied: unknown;
    const client = mockClient({
      getAlbums: async (options: unknown) => {
        supplied = options;
        return { result: { albums: [{ albumId: "a1", chatId: "c1", title: "My Album", photoCount: 3, secret: "do-not-forward" }], nextCursor: "page2" } };
      },
      getPhotos: async () => ({ result: { photos: [] } }),
      downloadPhoto: async () => new Uint8Array(),
    });
    expect(await listLineAlbums(client)).toEqual({
      albums: [{ albumId: "a1", chatId: "c1", title: "My Album", photoCount: 3 }],
      nextCursor: "page2", hasMore: true,
    });
    expect(supplied).toEqual({ cursor: undefined });
  });

  test("passes chat/album context and bounds photo page size", async () => {
    let supplied: unknown;
    const client = mockClient({
      getAlbums: async () => ({ result: { albums: [] } }),
      getPhotos: async (options: unknown) => {
        supplied = options;
        return { result: { photos: [{ photoId: "x", obsResourceId: { oid: "media-1", sid: "a" } }] } };
      },
      downloadPhoto: async () => new Uint8Array(),
    });
    expect(await listLineAlbumPhotos(client, { chatId: "c1", albumId: "a1" })).toEqual({
      photos: [{ id: "x", oid: "media-1", resourceType: "image", sid: "a" }],
    });
    expect(supplied).toMatchObject({ chatId: "c1", albumId: "a1", pageSize: 40 });
    await expect(listLineAlbumPhotos(client, { chatId: "", albumId: "a1" })).rejects.toThrow("invalid chat id");
  });

  test("checks image bytes before returning a preview", async () => {
    const photo = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const client = mockClient({
      getAlbums: async () => ({ result: { albums: [] } }),
      getPhotos: async () => ({ result: { photos: [] } }),
      downloadPhoto: async () => photo,
    });
    expect((await previewLineAlbumPhoto(client, { chatId: "c1", albumId: "a1", oid: "p1" })).dataUrl)
      .toStartWith("data:image/png;base64,");
    const bad = mockClient({
      getAlbums: async () => ({}), getPhotos: async () => ({}),
      downloadPhoto: async () => new Uint8Array([1, 2, 3]),
    });
    await expect(previewLineAlbumPhoto(bad, { chatId: "c1", albumId: "a1", oid: "p1" }))
      .rejects.toThrow("not a supported image");
  });
});
