function partsOf(url) {
  try {
    const parsed = new URL(url);
    return { protocol: parsed.protocol, host: parsed.host };
  } catch {
    return null;
  }
}

/**
 * Compare protocol and host, not string prefixes or `origin`.
 * `lineyapp://app.evil.example/` starts with `lineyapp://app` but is a
 * different host, and non-special schemes all report the origin "null".
 */
export function isPermittedNavigation(url, devUrl) {
  const permitted = partsOf(devUrl || "lineyapp://app/");
  const target = partsOf(url);
  if (!permitted || !target) return false;
  return permitted.protocol === target.protocol && permitted.host === target.host;
}
