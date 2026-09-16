#!/usr/bin/env node
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.LINEY_RUNNER_PORT || 39211);
const HOST = process.env.LINEY_RUNNER_HOST || "127.0.0.1";
const PREFIX = normalizePrefix(process.env.LINEY_RUNNER_PREFIX || "/liney-runner");
const ENGINE_PATH = process.env.LINEY_ENGINE_PATH || resolve(ROOT, "build/liney-engine-x86_64-unknown-linux-gnu");
const TOKEN = String(process.env.LINEY_RUNNER_TOKEN || "").trim();
const MAX_BODY_BYTES = Number(process.env.LINEY_RUNNER_MAX_BODY_BYTES || 24 * 1024 * 1024);
const ENGINE_REQUEST_TIMEOUT = Number(process.env.LINEY_ENGINE_REQUEST_TIMEOUT_MS || 180_000);
const PUBLIC_ENABLED = process.env.LINEY_PUBLIC_ENABLED !== "0";
const PUBLIC_MAX_SESSIONS = Number(process.env.LINEY_PUBLIC_MAX_SESSIONS || 6);
const PUBLIC_SESSION_TTL_MS = Number(process.env.LINEY_PUBLIC_SESSION_TTL_MS || 2 * 60 * 60 * 1000);
const PUBLIC_CREATE_WINDOW_MS = Number(process.env.LINEY_PUBLIC_CREATE_WINDOW_MS || 60 * 1000);
const PUBLIC_CREATE_LIMIT = Number(process.env.LINEY_PUBLIC_CREATE_LIMIT || 8);
const PUBLIC_DELETE_ON_CLOSE = process.env.LINEY_PUBLIC_DELETE_ON_CLOSE !== "0";
const PUBLIC_DATA_ROOT = resolve(process.env.LINEY_PUBLIC_DATA_ROOT || `${process.env.HOME || ROOT}/.local/share/liney/public-sessions`);

if (!TOKEN || TOKEN.length < 24) {
  console.error("LINEY_RUNNER_TOKEN is required and must be at least 24 characters");
  process.exit(1);
}
if (PUBLIC_ENABLED) mkdirSync(PUBLIC_DATA_ROOT, { recursive: true, mode: 0o700 });

function normalizePrefix(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed.replace(/\/$/, "") : `/${trimmed.replace(/\/$/, "")}`;
}

function stripPrefix(pathname) {
  if (!PREFIX) return pathname;
  if (pathname === PREFIX) return "/";
  if (pathname.startsWith(`${PREFIX}/`)) return pathname.slice(PREFIX.length) || "/";
  return pathname;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = status === 204 ? "" : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-liney-runner-token, x-liney-session-id, x-liney-session-token",
    "cross-origin-resource-policy": "cross-origin",
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

function parseJsonBody(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("invalid json body");
    error.code = "BAD_REQUEST";
    throw error;
  }
}

function bearer(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(req.headers["x-liney-runner-token"] || "").trim();
}

function assertAuth(req) {
  if (bearer(req) !== TOKEN) {
    const error = new Error("invalid Liney runner token");
    error.code = "UNAUTHORIZED";
    throw error;
  }
}

function publicError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || "RUNNER_ERROR",
    retryable: Boolean(error?.retryable),
  };
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function clientIp(req) {
  const forwarded = String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

class EngineBridge {
  child = null;
  lineBuffer = "";
  pending = new Map();
  events = [];
  eventSeq = 0;
  startPromise = null;
  restartCount = 0;
  createdAt = Date.now();

  constructor(options = {}) {
    this.name = options.name || "private";
    this.dataDir = options.dataDir || process.env.LINEY_DATA_DIR || "";
    this.clientLabel = options.clientLabel || process.env.LINEY_CLIENT_LABEL || "HomeServer";
    this.clientChannel = options.clientChannel || process.env.LINEY_CLIENT_CHANNEL || "HomeServer";
    this.clientSuffix = options.clientSuffix || process.env.LINEY_CLIENT_SUFFIX || this.clientLabel;
  }

  status() {
    return {
      running: Boolean(this.child && !this.child.killed),
      pid: this.child?.pid || null,
      pending: this.pending.size,
      restartCount: this.restartCount,
      enginePath: ENGINE_PATH,
      uptimeSeconds: Math.round((Date.now() - this.createdAt) / 1000),
      name: this.name,
    };
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async start() {
    this.lineBuffer = "";
    if (this.dataDir) mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const env = {
      ...process.env,
      LINEY_CLIENT_LABEL: this.clientLabel,
      LINEY_CLIENT_CHANNEL: this.clientChannel,
      LINEY_CLIENT_SUFFIX: this.clientSuffix,
      ...(this.dataDir ? { LINEY_DATA_DIR: this.dataDir } : {}),
    };
    const child = spawn(ENGINE_PATH, [], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.restartCount += 1;
    console.log(`[liney-runner] engine ${this.name} spawned pid=${child.pid}`);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => this.consume(data));
    child.stderr.on("data", (data) => {
      const message = String(data).trim();
      if (message) console.error(`[liney-engine:${this.name}] ${message}`);
    });
    child.on("exit", (code, signal) => {
      console.error(`[liney-runner] engine ${this.name} exited code=${code} signal=${signal || ""}`);
      if (this.child === child) this.child = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        const error = Object.assign(new Error("Liney engine exited"), { code: "ENGINE_EXITED", retryable: true });
        pending.reject(error);
      }
      this.pending.clear();
    });
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(resolvePromise, 250);
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill("SIGTERM");
  }

  consume(raw) {
    this.lineBuffer += raw;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.pushEvent({ type: "engine.raw", message: trimmed });
        continue;
      }
      const id = typeof message.id === "string" ? message.id : "";
      if (id && this.pending.has(id)) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.ok === false) {
          const rawError = message.error || {};
          const error = Object.assign(new Error(String(rawError.message || rawError || "engine request failed")), {
            code: String(rawError.code || "ENGINE_ERROR"),
            retryable: Boolean(rawError.retryable),
          });
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      this.pushEvent(message);
    }
  }

  pushEvent(event) {
    this.eventSeq += 1;
    const payload = event && typeof event === "object" ? event.payload : null;
    const normalized = event?.type && payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...event, ...payload }
      : event;
    this.events.push({ ...normalized, seq: this.eventSeq, at: Date.now() });
    this.events = this.events.slice(-500);
  }

  readEvents(after = 0) {
    const cursor = Number(after) || 0;
    const events = this.events.filter((event) => Number(event.seq || 0) > cursor);
    return { cursor: this.eventSeq, events };
  }

  async request(method, params = {}, timeout = ENGINE_REQUEST_TIMEOUT) {
    if (!method || typeof method !== "string") {
      const error = new Error("method is required");
      error.code = "BAD_REQUEST";
      throw error;
    }
    await this.ensureStarted();
    if (!this.child?.stdin?.writable) {
      const error = new Error("Liney engine stdin is not writable");
      error.code = "ENGINE_NOT_WRITABLE";
      error.retryable = true;
      throw error;
    }
    const id = randomUUID();
    const payload = `${JSON.stringify({ id, version: 1, method, params })}\n`;
    console.log(`[liney-runner] rpc ${this.name} ${method}`);
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = Object.assign(new Error(`${method} timed out`), { code: "TIMEOUT", retryable: true });
        rejectPromise(error);
      }, Math.max(1_000, Number(timeout) || ENGINE_REQUEST_TIMEOUT));
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
    this.child.stdin.write(payload, "utf8");
    return promise;
  }
}

const privateBridge = new EngineBridge({ name: "private" });
const publicSessions = new Map();
const createRate = new Map();

function publicSummary() {
  cleanupPublicSessions();
  return {
    enabled: PUBLIC_ENABLED,
    active: publicSessions.size,
    maxSessions: PUBLIC_MAX_SESSIONS,
    ttlSeconds: Math.round(PUBLIC_SESSION_TTL_MS / 1000),
  };
}

function assertPublicEnabled() {
  if (!PUBLIC_ENABLED) {
    const error = new Error("public Liney sessions are disabled");
    error.code = "PUBLIC_DISABLED";
    error.retryable = false;
    throw error;
  }
}

function assertCreateRate(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const list = (createRate.get(ip) || []).filter((ts) => now - ts < PUBLIC_CREATE_WINDOW_MS);
  if (list.length >= PUBLIC_CREATE_LIMIT) {
    const error = new Error("too many public session requests from this client");
    error.code = "RATE_LIMITED";
    error.retryable = true;
    throw error;
  }
  list.push(now);
  createRate.set(ip, list);
}

function publicDataDir(id) {
  if (!/^s_[A-Za-z0-9_-]{10,80}$/.test(id)) {
    const error = new Error("invalid public session id");
    error.code = "BAD_SESSION";
    throw error;
  }
  const dir = resolve(PUBLIC_DATA_ROOT, id);
  if (!dir.startsWith(`${PUBLIC_DATA_ROOT}/`)) {
    const error = new Error("invalid public session path");
    error.code = "BAD_SESSION";
    throw error;
  }
  return dir;
}

async function closePublicSession(session, removeData = PUBLIC_DELETE_ON_CLOSE) {
  publicSessions.delete(session.id);
  await session.bridge.stop().catch(() => undefined);
  if (removeData) rmSync(session.dataDir, { recursive: true, force: true });
}

function cleanupPublicSessions() {
  const now = Date.now();
  for (const session of [...publicSessions.values()]) {
    if (now > session.expiresAt) void closePublicSession(session);
  }
}

function createPublicSession(req) {
  assertPublicEnabled();
  cleanupPublicSessions();
  assertCreateRate(req);
  if (publicSessions.size >= PUBLIC_MAX_SESSIONS) {
    const error = new Error("Liney public session capacity is full");
    error.code = "PUBLIC_CAPACITY_FULL";
    error.retryable = true;
    throw error;
  }
  const id = `s_${randomToken(18)}`;
  const token = randomToken(32);
  const dataDir = publicDataDir(id);
  const createdAt = Date.now();
  const suffix = `Web-${id.slice(2, 8)}`;
  const bridge = new EngineBridge({
    name: id,
    dataDir,
    clientLabel: suffix,
    clientChannel: "Website",
    clientSuffix: suffix,
  });
  const session = {
    id,
    token,
    dataDir,
    bridge,
    createdAt,
    lastSeen: createdAt,
    expiresAt: createdAt + PUBLIC_SESSION_TTL_MS,
    ip: clientIp(req),
  };
  publicSessions.set(id, session);
  return session;
}

function sessionCredentials(req, url, body = {}) {
  return {
    id: String(req.headers["x-liney-session-id"] || url.searchParams.get("session") || body.sessionId || "").trim(),
    token: String(req.headers["x-liney-session-token"] || url.searchParams.get("sessionToken") || body.sessionToken || "").trim(),
  };
}

function assertPublicSession(req, url, body = {}) {
  assertPublicEnabled();
  cleanupPublicSessions();
  const { id, token } = sessionCredentials(req, url, body);
  const session = publicSessions.get(id);
  if (!session || session.token !== token) {
    const error = new Error("invalid or expired Liney public session");
    error.code = "SESSION_EXPIRED";
    error.retryable = false;
    throw error;
  }
  const now = Date.now();
  session.lastSeen = now;
  session.expiresAt = now + PUBLIC_SESSION_TTL_MS;
  return session;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});
  const url = new URL(req.url || "/", `http://${req.headers.host || "liney-runner"}`);
  const path = stripPrefix(url.pathname);
  try {
    if (req.method === "GET" && (path === "/" || path === "/health")) {
      return sendJson(res, 200, {
        ok: true,
        name: "Liney Home Runner",
        prefix: PREFIX || "/",
        status: privateBridge.status(),
        public: publicSummary(),
      });
    }

    if (req.method === "POST" && path === "/public/session") {
      const session = createPublicSession(req);
      return sendJson(res, 200, {
        ok: true,
        result: {
          sessionId: session.id,
          sessionToken: session.token,
          runnerUrl: PREFIX || "/",
          expiresAt: session.expiresAt,
          ttlSeconds: Math.round(PUBLIC_SESSION_TTL_MS / 1000),
          limits: publicSummary(),
        },
      });
    }

    if ((req.method === "GET" || req.method === "POST") && path === "/public/events") {
      let body = {};
      let after = url.searchParams.get("after") || "0";
      if (req.method === "POST") {
        body = parseJsonBody(await readBody(req));
        after = body.after || after;
      }
      const session = assertPublicSession(req, url, body);
      return sendJson(res, 200, { ok: true, result: session.bridge.readEvents(Number(after)) });
    }

    if (req.method === "POST" && path === "/public/rpc") {
      const body = parseJsonBody(await readBody(req));
      const session = assertPublicSession(req, url, body);
      const result = await session.bridge.request(String(body.method || ""), body.params || {}, body.timeout || undefined);
      return sendJson(res, 200, { ok: true, result });
    }

    if ((req.method === "POST" || req.method === "DELETE") && path === "/public/session") {
      const body = req.method === "POST" ? parseJsonBody(await readBody(req)) : {};
      const session = assertPublicSession(req, url, body);
      await closePublicSession(session);
      return sendJson(res, 200, { ok: true, result: { closed: true } });
    }

    if ((req.method === "GET" || req.method === "POST") && path === "/events") {
      assertAuth(req);
      let after = url.searchParams.get("after") || "0";
      if (req.method === "POST") {
        const body = parseJsonBody(await readBody(req));
        after = body.after || after;
      }
      return sendJson(res, 200, { ok: true, result: privateBridge.readEvents(Number(after)) });
    }

    if (req.method === "POST" && path === "/rpc") {
      assertAuth(req);
      const body = parseJsonBody(await readBody(req));
      const result = await privateBridge.request(String(body.method || ""), body.params || {}, body.timeout || undefined);
      return sendJson(res, 200, { ok: true, result });
    }

    if (req.method === "POST" && path === "/control/restart") {
      assertAuth(req);
      await privateBridge.stop();
      await privateBridge.ensureStarted();
      return sendJson(res, 200, { ok: true, status: privateBridge.status() });
    }

    return sendJson(res, 404, { ok: false, error: { message: "not found", code: "NOT_FOUND" } });
  } catch (error) {
    const status = error?.code === "UNAUTHORIZED" || error?.code === "SESSION_EXPIRED"
      ? 401
      : error?.code === "BODY_TOO_LARGE"
        ? 413
        : error?.code === "RATE_LIMITED" || error?.code === "PUBLIC_CAPACITY_FULL"
          ? 429
          : error?.code === "BAD_REQUEST" || error?.code === "BAD_SESSION"
            ? 400
            : 200;
    return sendJson(res, status, { ok: false, error: publicError(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[liney-runner] listening http://${HOST}:${PORT}${PREFIX || ""}`);
  if (PUBLIC_ENABLED) console.log(`[liney-runner] public sessions enabled max=${PUBLIC_MAX_SESSIONS} ttlMs=${PUBLIC_SESSION_TTL_MS}`);
});

process.on("SIGTERM", async () => {
  server.close();
  await privateBridge.stop();
  await Promise.all([...publicSessions.values()].map((session) => closePublicSession(session, false)));
  process.exit(0);
});
