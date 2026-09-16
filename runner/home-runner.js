#!/usr/bin/env node
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PORT = Number(process.env.LINEY_RUNNER_PORT || 39211);
const HOST = process.env.LINEY_RUNNER_HOST || "127.0.0.1";
const PREFIX = normalizePrefix(process.env.LINEY_RUNNER_PREFIX || "/liney-runner");
const ENGINE_PATH = process.env.LINEY_ENGINE_PATH || resolve(ROOT, "build/liney-engine-x86_64-unknown-linux-gnu");
const TOKEN = String(process.env.LINEY_RUNNER_TOKEN || "").trim();
const STARTED_AT = Date.now();
const MAX_BODY_BYTES = Number(process.env.LINEY_RUNNER_MAX_BODY_BYTES || 24 * 1024 * 1024);
const ENGINE_REQUEST_TIMEOUT = Number(process.env.LINEY_ENGINE_REQUEST_TIMEOUT_MS || 180_000);

if (!TOKEN || TOKEN.length < 24) {
  console.error("LINEY_RUNNER_TOKEN is required and must be at least 24 characters");
  process.exit(1);
}

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
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-liney-runner-token",
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

class EngineBridge {
  child = null;
  lineBuffer = "";
  pending = new Map();
  events = [];
  eventSeq = 0;
  startPromise = null;
  restartCount = 0;

  status() {
    return {
      running: Boolean(this.child && !this.child.killed),
      pid: this.child?.pid || null,
      pending: this.pending.size,
      restartCount: this.restartCount,
      enginePath: ENGINE_PATH,
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
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
    const env = {
      ...process.env,
      LINEY_CLIENT_LABEL: process.env.LINEY_CLIENT_LABEL || "HomeServer",
      LINEY_CLIENT_CHANNEL: process.env.LINEY_CLIENT_CHANNEL || "HomeServer",
      LINEY_CLIENT_SUFFIX: process.env.LINEY_CLIENT_SUFFIX || "HomeServer",
    };
    const child = spawn(ENGINE_PATH, [], {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.restartCount += 1;
    console.log(`[liney-runner] engine spawned pid=${child.pid}`);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => this.consume(data));
    child.stderr.on("data", (data) => {
      const message = String(data).trim();
      if (message) console.error(`[liney-engine] ${message}`);
    });
    child.on("exit", (code, signal) => {
      console.error(`[liney-runner] engine exited code=${code} signal=${signal || ""}`);
      if (this.child === child) this.child = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        const error = Object.assign(new Error("Liney engine exited"), { code: "ENGINE_EXITED", retryable: true });
        pending.reject(error);
      }
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 250);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("spawn", () => {
        // Give bun-compiled engine a short moment to set up stdin/stdout.
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
    console.log(`[liney-runner] rpc ${method}`);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = Object.assign(new Error(`${method} timed out`), { code: "TIMEOUT", retryable: true });
        reject(error);
      }, Math.max(1_000, Number(timeout) || ENGINE_REQUEST_TIMEOUT));
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(payload, "utf8");
    return promise;
  }
}

const bridge = new EngineBridge();

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
        status: bridge.status(),
      });
    }
    if ((req.method === "GET" || req.method === "POST") && path === "/events") {
      assertAuth(req);
      let after = url.searchParams.get("after") || "0";
      if (req.method === "POST") {
        const body = await readBody(req);
        if (body) after = JSON.parse(body).after || after;
      }
      return sendJson(res, 200, { ok: true, result: bridge.readEvents(Number(after)) });
    }
    if (req.method === "POST" && path === "/rpc") {
      assertAuth(req);
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const result = await bridge.request(String(parsed.method || ""), parsed.params || {}, parsed.timeout || undefined);
      return sendJson(res, 200, { ok: true, result });
    }
    if (req.method === "POST" && path === "/control/restart") {
      assertAuth(req);
      await bridge.stop();
      await bridge.ensureStarted();
      return sendJson(res, 200, { ok: true, status: bridge.status() });
    }
    return sendJson(res, 404, { ok: false, error: { message: "not found", code: "NOT_FOUND" } });
  } catch (error) {
    const status = error?.code === "UNAUTHORIZED" ? 401 : error?.code === "BODY_TOO_LARGE" ? 413 : 200;
    return sendJson(res, status, { ok: false, error: publicError(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[liney-runner] listening http://${HOST}:${PORT}${PREFIX || ""}`);
});

process.on("SIGTERM", async () => {
  server.close();
  await bridge.stop();
  process.exit(0);
});
