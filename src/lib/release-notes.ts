/**
 * GitHub release notes arrive as HTML from electron-updater. The settings UI
 * renders text, so strip the markup (and any scripts/styles) instead of showing
 * raw tags. Links keep their destination in parentheses.
 */
export function releaseNotesText(value: string): string {
  if (!value) return "";
  let text = value
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|table|tr)\s*>/gi, "\n\n")
    .replace(/<\s*\/\s*li\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ");

  text = text.replace(
    /<\s*a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi,
    (_match, href: string, label: string) => {
      const clean = label.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      return clean && clean !== href ? `${clean} (${href})` : href;
    },
  );

  const decodeCodePoint = (raw: string): string => {
    try {
      return String.fromCodePoint(Number(raw));
    } catch {
      return "";
    }
  };

  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => decodeCodePoint(String(parseInt(hex, 16))))
    .replace(/&#(\d+);/g, (_match, dec: string) => decodeCodePoint(dec))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 6000);
}
