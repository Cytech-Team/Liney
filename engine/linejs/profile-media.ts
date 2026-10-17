import type { Client } from "@evex/linejs";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function decodeProfileImage(value: unknown): { bytes: Uint8Array; mime: "image/jpeg" | "image/png" } {
  if (typeof value !== "string" || value.length > MAX_IMAGE_BYTES * 1.38 + 80) {
    throw new TypeError("Profile image must be a PNG/JPEG under 8 MB");
  }
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new TypeError("Unsupported image MIME type");
  const bytes = Uint8Array.from(Buffer.from(match[2], "base64"));
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Invalid profile image size");
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte);
  if ((match[1] === "jpeg" && !jpeg) || (match[1] === "png" && !png)) {
    throw new Error("Image signature does not match file type");
  }
  return { bytes, mime: match[1] === "jpeg" ? "image/jpeg" : "image/png" };
}

export async function uploadProfileAvatar(client: Client, data: unknown) {
  const { bytes, mime } = decodeProfileImage(data);
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const response = await client.uploadMyProfileImage(blob);
  return { uploaded: Boolean(response.objId && response.objHash) };
}
