const VERSION = "0.1.0";
const PROTOCOL_VERSION = 1;

const ALLOWED_APP_ORIGINS = new Set([
  "https://liney.namnarak.in.th",
  "https://liney.pages.dev"
]);

const LINE_HOST_ALLOWLIST = new Set([
  "legy.line-apps.com",
  "ga2.line.naver.jp",
  "ga2.line-apps.com",
  "gw.line.naver.jp",
  "obs.line-scdn.net",
  "dl.profile.line-cdn.net",
  "profile.line-scdn.net"
]);

const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
  "x-line-application",
  "x-line-access",
  "x-lal",
  "x-lhm",
  "x-lpqs",
  "x-lpv",
  "x-lst"
]);

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (!value) return undefined;
  const binary = atob(String(value));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function senderOrigin(sender) {
  try {
    return new URL(sender?.url || sender?.origin || "").origin;
  } catch {
    return "";
  }
}

function assertAllowedSender(sender) {
  const origin = senderOrigin(sender);
  if (!ALLOWED_APP_ORIGINS.has(origin)) throw new Error("Liney Connector blocked an unknown page origin");
}

function safeRelayUrl(value) {
  let target;
  try {
    target = new URL(String(value || ""));
  } catch {
    throw new Error("relay target is not a valid URL");
  }
  if (target.protocol !== "https:") throw new Error("relay target must use https");
  if (!LINE_HOST_ALLOWLIST.has(target.hostname)) throw new Error("relay target host is not allowed");
  return target;
}

function relayHeaders(input) {
  const output = new Headers();
  const source = input && typeof input === "object" ? input : {};
  for (const [name, value] of Object.entries(source)) {
    const lower = String(name).toLowerCase();
    if (!SAFE_REQUEST_HEADERS.has(lower)) continue;
    if (/cookie|authorization/i.test(lower)) continue;
    output.set(lower, String(value));
  }
  output.set("x-liney-connector", VERSION);
  return output;
}

function runtimeStatus() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    linejsVersion: `connector-${VERSION}`,
    device: "WEBEXT",
    clientIdentity: {
      displayName: "Liney-Website",
      modelName: "Liney-Website",
      systemName: "Liney-ChromeExtension",
      platform: "ChromeExtension",
      channel: "Website",
      device: "WEBEXT"
    },
    features: [
      "web-extension-bridge",
      "extension-relay-fetch",
      "no-central-worker-relay",
      "browser-static-ui"
    ],
    authenticated: false,
    storage: {
      mode: "browser-extension",
      walletAvailable: false
    },
    call: {
      enabled: false,
      incomingAnswer: false,
      reason: "Call runtime is desktop-only for now"
    }
  };
}

async function relayFetch(params) {
  const target = safeRelayUrl(params?.url);
  const method = String(params?.method || "POST").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new Error("relay method not allowed");
  const response = await fetch(target, {
    method,
    headers: relayHeaders(params?.headers),
    body: method === "POST" ? base64ToBytes(params?.bodyBase64) : undefined,
    redirect: "manual",
    cache: "no-store"
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers = {};
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase();
    if (["content-type", "x-line-next", "x-line-request-id", "x-lcr"].includes(lower)) headers[name] = value;
  }
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    bodyBase64: bytesToBase64(bytes)
  };
}

async function handleRequest(message, sender) {
  assertAllowedSender(sender);
  const method = String(message?.method || "");
  const params = message?.params || {};

  if (method === "ping") return { pong: true, protocolVersion: PROTOCOL_VERSION, connectorVersion: VERSION };
  if (method === "capabilities" || method === "runtime.status") return runtimeStatus();
  if (method === "connector.relayFetch" || method === "relay.fetch" || method === "line.fetch") return relayFetch(params);

  // Keep the desktop UI alive while the real LINEJS web runtime is being split
  // into browser-safe protocol code. These are intentionally empty, not mocked
  // conversations from a server.
  if (["chats.list", "chat.list", "friends.list", "openchat.list", "call.history", "message.list", "messages.list"].includes(method)) return [];
  if (method === "sync.status") return { state: null, stats: { chats: 0, messages: 0, pending: 0 } };

  if (method.startsWith("auth.")) {
    const error = new Error("Liney Connector is installed. QR login still needs the browser-safe LINEJS login runtime; no Worker/server relay is being used.");
    error.code = "LINEJS_WEB_RUNTIME_PENDING";
    error.retryable = false;
    throw error;
  }

  const error = new Error(`Liney Connector does not implement ${method} yet`);
  error.code = "NOT_IMPLEMENTED";
  error.retryable = false;
  throw error;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "liney.connector.request") return false;
  handleRequest(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({
      ok: false,
      error: {
        message: error?.message || String(error),
        code: error?.code || "CONNECTOR_ERROR",
        retryable: Boolean(error?.retryable)
      }
    }));
  return true;
});
