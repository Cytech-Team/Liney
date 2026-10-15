export type NormalizedIncomingCall = {
  kind: string;
  routeMetadata?: Record<string, unknown>;
};

export function normalizeIncomingCallKind(rawKind: string | undefined): NormalizedIncomingCall {
  const raw = String(rawKind ?? "").trim();
  if (!raw) return { kind: "AUDIO" };

  const upper = raw.toUpperCase();
  if (upper === "AUDIO" || upper === "VIDEO" || upper === "0" || upper === "1") {
    return { kind: upper };
  }

  if (raw.startsWith("{") && raw.endsWith("}")) {
    const routeKeys = ["STNPK", "H", "P", "VP", "VC", "VFZ", "VTZ", "STV"];
    const routeKeyCount = routeKeys.filter((key) => raw.includes(key)).length;
    const looksLikeCallRoute = routeKeyCount >= 3;

    if (looksLikeCallRoute) {
      try {
        const parsed = JSON.parse(normalizeLineJsonLiterals(raw));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { kind: "AUDIO", routeMetadata: parsed as Record<string, unknown> };
        }
      } catch {
        // Some live NOTIFIED_RECEIVED_CALL payloads are JSON-like rather than
        // strict JSON (for example TRUE/FALSE literals). The route signature is
        // enough to classify the call; metadata is optional because accept()
        // reacquires the authoritative route before media setup.
      }
      return { kind: "AUDIO", routeMetadata: {} };
    }
  }

  return { kind: upper };
}

function normalizeLineJsonLiterals(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (raw.startsWith("TRUE", i)) { out += "true"; i += 4; continue; }
    if (raw.startsWith("FALSE", i)) { out += "false"; i += 5; continue; }
    if (raw.startsWith("NULL", i)) { out += "null"; i += 4; continue; }
    out += ch;
    i += 1;
  }
  return out;
}
