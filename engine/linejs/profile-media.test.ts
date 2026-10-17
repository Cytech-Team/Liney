import { describe, expect, test } from "bun:test";
import { decodeProfileImage, uploadProfileAvatar } from "./profile-media";

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const jpeg = Buffer.from([255,216,255,224,0,0]);
describe("LINE profile avatar validation", () => {
  test("accepts PNG and JPEG with matching signatures", () => {
    expect(decodeProfileImage(`data:image/png;base64,${png.toString("base64")}`).mime).toBe("image/png");
    expect(decodeProfileImage(`data:image/jpeg;base64,${jpeg.toString("base64")}`).mime).toBe("image/jpeg");
  });
  test("rejects wrong signature and oversized files without any upload", async () => {
    expect(() => decodeProfileImage(`data:image/png;base64,${jpeg.toString("base64")}`)).toThrow();
    expect(() => decodeProfileImage(`data:image/png;base64,${"A".repeat(12_000_000)}`)).toThrow();
    let called = false;
    await expect(uploadProfileAvatar({ uploadMyProfileImage: async () => { called = true; return { objId: "x", objHash: "y" }; } } as any, "data:image/svg+xml;base64,YQ==")).rejects.toThrow();
    expect(called).toBe(false);
  });
  test("uploads selected image only once through LINEJS", async () => {
    let received: Blob | undefined;
    const result = await uploadProfileAvatar({ uploadMyProfileImage: async (blob: Blob) => {
      received = blob;
      return { objId: "image", objHash: "sha" };
    } } as any, `data:image/png;base64,${png.toString("base64")}`);
    expect(result).toEqual({ uploaded: true });
    expect(received?.type).toBe("image/png");
    expect(received?.size).toBe(png.length);
  });
});
