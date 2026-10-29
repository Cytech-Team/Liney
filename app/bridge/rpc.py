"""Liney Engine v1 JSONL bridge. No GTK/WebKit/Tauri/LINEJS dependencies.

The engine is the sole owner of LINE credentials, local SQLite state and
network access. Only sanitized transport errors belong in this layer.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import threading
import uuid

from gi.repository import GLib

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 8 * 1024 * 1024


def find_engine() -> Path:
    explicit = os.environ.get("LINEY_ENGINE_BIN", "").strip()
    if explicit:
        candidate = Path(explicit).expanduser()
        if not candidate.is_file():
            raise FileNotFoundError("LINEY_ENGINE_BIN points to a missing file")
        return candidate
    root = Path(__file__).resolve().parents[2]
    candidates = [
        root / "bin" / "liney-engine",
        root.parent / "build" / "liney-engine-x86_64-unknown-linux-gnu",
        root.parent / "build" / "liney-engine-aarch64-unknown-linux-gnu",
        root.parent / "liney-engine",
    ]
    return next((p for p in candidates if p.is_file()), candidates[0])


class EngineBridge:
    def __init__(self, on_event, on_closed):
        self.on_event = on_event
        self.on_closed = on_closed
        self._pending = {}
        self._lock = threading.Lock()
        self.proc = None
        self._stopping = False

    def start(self, engine=None):
        if self.proc is not None:
            return
        executable = str(engine or find_engine())
        env = os.environ.copy()
        env["BUN_CONFIG_MAX_HTTP_REQUESTS"] = "8"
        # Never permit user-specific environment variables to be logged.
        self.proc = subprocess.Popen(
            [executable],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
            start_new_session=False,
        )
        threading.Thread(target=self._read_loop, name="liney-rpc-reader", daemon=True).start()

    def request(self, method, params=None, callback=None, timeout=30):
        if self.proc is None or self.proc.poll() is not None:
            if callback:
                GLib.idle_add(callback, None, "Engine is not running")
            return None
        request_id = str(uuid.uuid4())
        timeout = max(1, min(int(timeout), 240))
        timer = GLib.timeout_add_seconds(timeout, self._timed_out, request_id)
        self._pending[request_id] = (callback, timer)
        payload = json.dumps({
            "id": request_id,
            "version": PROTOCOL_VERSION,
            "method": method,
            "params": params or {},
        }, ensure_ascii=False, separators=(",", ":")) + "\n"
        try:
            with self._lock:
                self.proc.stdin.write(payload)
                self.proc.stdin.flush()
        except (OSError, ValueError):
            pending = self._pending.pop(request_id, None)
            if pending:
                GLib.source_remove(pending[1])
            if callback:
                GLib.idle_add(callback, None, "Cannot reach the Liney engine")
        return request_id

    def _timed_out(self, request_id):
        pending = self._pending.pop(request_id, None)
        if pending and pending[0]:
            pending[0](None, "Engine request timed out")
        return GLib.SOURCE_REMOVE

    def _read_loop(self):
        try:
            while not self._stopping:
                line = self.proc.stdout.readline(MAX_LINE_BYTES + 1)
                if not line:
                    break
                if len(line) > MAX_LINE_BYTES or not line.endswith("\n"):
                    # Do not log oversized or malformed private payloads.
                    continue
                try:
                    data = json.loads(line)
                    if isinstance(data, dict):
                        GLib.idle_add(self._deliver, data)
                except (ValueError, TypeError):
                    pass
        finally:
            GLib.idle_add(self._exited)

    def _deliver(self, message):
        request_id = message.get("id")
        if isinstance(request_id, str) and request_id in self._pending:
            callback, timer = self._pending.pop(request_id)
            GLib.source_remove(timer)
            if callback:
                error = message.get("error") if message.get("ok") is False else None
                if isinstance(error, dict):
                    error = str(error.get("message", "Engine request failed"))
                callback(message.get("result"), str(error) if error else None)
        elif isinstance(message.get("type"), str):
            self.on_event(message)
        return GLib.SOURCE_REMOVE

    def _exited(self):
        if not self._stopping:
            for callback, timer in self._pending.values():
                GLib.source_remove(timer)
                if callback:
                    callback(None, "Liney engine closed")
            self._pending.clear()
            self.on_closed()
        return GLib.SOURCE_REMOVE

    def close(self):
        self._stopping = True
        for _, timer in self._pending.values():
            GLib.source_remove(timer)
        self._pending.clear()
        proc = self.proc
        if proc:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=0.6)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=1)
            for stream in (proc.stdin, proc.stdout):
                if stream:
                    try:
                        stream.close()
                    except OSError:
                        pass
        self.proc = None
