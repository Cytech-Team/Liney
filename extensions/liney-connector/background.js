const VERSION = chrome.runtime.getManifest().version;
const PROTOCOL_VERSION = 1;
const DEFAULT_RUNNER_URL = "https://cdn.cytechteam.site/liney-runner";

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

function isExtensionSender(sender) {
  return senderOrigin(sender) === `chrome-extension://${chrome.runtime.id}`;
}

function assertAllowedSender(sender) {
  const origin = senderOrigin(sender);
  if (ALLOWED_APP_ORIGINS.has(origin) || isExtensionSender(sender)) return;
  throw new Error("Liney Connector blocked an unknown page origin");
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

async function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

async function storageSet(value) {
  return chrome.storage.local.set(value);
}

async function runnerConfig() {
  const saved = await storageGet(["runnerUrl", "runnerToken", "runnerEnabled"]);
  return {
    enabled: saved.runnerEnabled !== false,
    url: String(saved.runnerUrl || DEFAULT_RUNNER_URL).replace(/\/$/, ""),
    token: String(saved.runnerToken || "").trim(),
  };
}

async function saveRunnerConfig(params) {
  const url = String(params?.url || DEFAULT_RUNNER_URL).trim().replace(/\/$/, "");
  const token = String(params?.token || "").trim();
  const enabled = params?.enabled !== false;
  if (!url.startsWith("https://") && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
    const error = new Error("Runner URL must be HTTPS or localhost");
    error.code = "BAD_RUNNER_URL";
    throw error;
  }
  await storageSet({ runnerUrl: url, runnerToken: token, runnerEnabled: enabled });
  return { enabled, url, tokenConfigured: Boolean(token) };
}

async function runnerRpc(method, params, timeout) {
  const config = await runnerConfig();
  if (!config.enabled) {
    const error = new Error("Liney Home Runner is disabled in the connector");
    error.code = "RUNNER_DISABLED";
    throw error;
  }
  if (!config.token) {
    const error = new Error("ตั้งค่า Liney Home Runner token ใน extension ก่อน");
    error.code = "RUNNER_NOT_CONFIGURED";
    error.retryable = false;
    throw error;
  }
  const response = await fetch(`${config.url}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${config.token}`,
      "x-liney-connector": VERSION,
    },
    body: JSON.stringify({ method, params: params || {}, timeout }),
    cache: "no-store",
  });
  let data;
  try {
    data = await response.json();
  } catch {
    const error = new Error(`Liney Home Runner returned HTTP ${response.status}`);
    error.code = "RUNNER_HTTP_ERROR";
    error.retryable = true;
    throw error;
  }
  if (!response.ok || data?.ok === false) {
    const raw = data?.error || {};
    const error = new Error(String(raw.message || `Liney Home Runner failed with HTTP ${response.status}`));
    error.code = String(raw.code || "RUNNER_ERROR");
    error.retryable = Boolean(raw.retryable || response.status >= 500);
    throw error;
  }
  return data?.result;
}

async function runnerHealth() {
  const config = await runnerConfig();
  if (!config.enabled || !config.token) return { configured: Boolean(config.token), enabled: config.enabled, url: config.url, online: false };
  try {
    const response = await fetch(`${config.url}/health`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    return { configured: true, enabled: true, url: config.url, online: response.ok && Boolean(data?.ok), status: data?.status || null };
  } catch (error) {
    return { configured: true, enabled: true, url: config.url, online: false, error: error?.message || String(error) };
  }
}

async function runtimeStatus() {
  const health = await runnerHealth();
  if (health.configured && health.online) {
    try {
      return await runnerRpc("capabilities", {}, 120_000);
    } catch {
      // Fall through to connector-local status so the UI can show the error later.
    }
  }
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
      "home-runner-connector",
      "no-central-worker-relay",
      "browser-static-ui"
    ],
    authenticated: false,
    storage: {
      mode: "browser-extension",
      walletAvailable: false
    },
    runner: health,
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

  if (method === "connector.config.get") return { ...(await runnerConfig()), tokenConfigured: Boolean((await runnerConfig()).token) };
  if (method === "connector.config.set") return saveRunnerConfig(params);
  if (method === "connector.health") return runnerHealth();
  if (method === "ping") return { pong: true, protocolVersion: PROTOCOL_VERSION, connectorVersion: VERSION, runner: await runnerHealth() };
  if (method === "capabilities" || method === "runtime.status") return runtimeStatus();
  if (method === "connector.relayFetch" || method === "relay.fetch" || method === "line.fetch") return relayFetch(params);

  return runnerRpc(method, params, message?.timeout);
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
