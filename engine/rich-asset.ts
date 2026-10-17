/** LINE OA RICH artwork is sometimes private even if metadata contains an HTTPS URL.
 * Never attach an account token to arbitrary URLs received in chat messages.
 */
export function richAssetAuthHeaders(rawUrl: string, accessToken?: string, systemType?: string): Record<string, string> | undefined {
  if (!accessToken || !systemType) return undefined;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return undefined;
  if (url.hostname.toLowerCase() !== "oaplus-media-manager.line-scdn.net") return undefined;
  return {
    accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5",
    "x-line-access": accessToken,
    "x-line-application": systemType,
  };
}
