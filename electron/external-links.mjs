const ALLOWED_PROTOCOLS = new Set(["https:", "http:", "mailto:", "tel:", "line:"]);

/**
 * The renderer may only ask the shell to open protocols the chat UI actually
 * renders. Credentials in the URL are rejected so a message cannot disguise a
 * link as a different destination.
 */
export function normalizeExternalUrl(value) {
  const url = new URL(String(value ?? ""));
  if (!ALLOWED_PROTOCOLS.has(url.protocol) || url.username || url.password) {
    throw new Error("External URL not allowed");
  }
  return url.href;
}
