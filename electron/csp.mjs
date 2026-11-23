/**
 * Content Security Policy for the packaged renderer (`lineyapp://app/`).
 * Scripts must stay external bundles: no eval, no inline script. Images and
 * media may come from LINE CDNs, blobs and data URLs because the chat UI
 * renders them directly.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https: liney-media:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "child-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");
