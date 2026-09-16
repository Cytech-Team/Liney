const API_RUNTIME = {
  name: "Liney Web Runtime",
  mode: "Browser vault active · stateless relay enabled · server inbox disabled",
  clientLabel: "Liney-Website",
  storage: "browser-indexeddb-encrypted",
  serverInbox: false,
  lineRelay: "ready",
  relayStorage: "none"
};

const LINE_HOST_ALLOWLIST = [
  "legy.line-apps.com",
  "ga2.line.naver.jp",
  "ga2.line-apps.com",
  "gw.line.naver.jp",
  "obs.line-scdn.net",
  "dl.profile.line-cdn.net",
  "profile.line-scdn.net"
];

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type, x-liney-relay");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function safeRelayUrl(value) {
  let target;
  try {
    target = new URL(String(value || ""));
  } catch {
    throw new Error("relay target is not a valid URL");
  }
  if (target.protocol !== "https:") throw new Error("relay target must use https");
  if (!LINE_HOST_ALLOWLIST.includes(target.hostname)) throw new Error("relay target host is not allowed");
  return target;
}

function decodeBase64(value) {
  if (!value) return undefined;
  const binary = atob(String(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function relayHeaders(input) {
  const allowed = new Set([
    "accept",
    "content-type",
    "user-agent",
    "x-line-application",
    "x-line-access",
    "x-lal",
    "x-lhm",
    "x-lpqs",
    "x-lpv",
    "x-lst",
    "x-lhm",
    "x-lal"
  ]);
  const output = new Headers();
  const source = input && typeof input === "object" ? input : {};
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (!allowed.has(lower)) continue;
    if (/cookie|authorization/i.test(lower)) continue;
    output.set(lower, String(value));
  }
  output.set("x-liney-relay", "stateless");
  return output;
}

async function handleRelay(request) {
  if (request.method === "OPTIONS") return json({ ok: true });
  if (request.method !== "POST") return json({ ok: false, error: "POST required" }, { status: 405 });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  let target;
  try {
    target = safeRelayUrl(body.url);
  } catch (error) {
    return json({ ok: false, error: error.message }, { status: 400 });
  }
  const method = String(body.method || "POST").toUpperCase();
  if (!["GET", "POST"].includes(method)) return json({ ok: false, error: "relay method not allowed" }, { status: 400 });
  const upstream = await fetch(target, {
    method,
    headers: relayHeaders(body.headers),
    body: method === "POST" ? decodeBase64(body.bodyBase64) : undefined,
    redirect: "manual"
  });
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const headers = {};
  for (const [name, value] of upstream.headers) {
    if (["content-type", "x-line-next", "x-line-request-id"].includes(name.toLowerCase())) headers[name] = value;
  }
  return json({
    ok: true,
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
    bodyBase64: encodeBase64(bytes)
  });
}

async function handleLinePing() {
  return json({
    ok: true,
    relay: "ready",
    storage: "none",
    inbox: false,
    message: "Liney Web relay is enabled. Browser vault keeps user data client-side."
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/runtime") return json(API_RUNTIME);
    if (url.pathname === "/api/line/ping") return handleLinePing();
    if (url.pathname === "/api/relay") return handleRelay(request);
    if (url.pathname === "/app") {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/app.html";
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "not found" }, { status: 404 });
    return env.ASSETS.fetch(request);
  }
};
