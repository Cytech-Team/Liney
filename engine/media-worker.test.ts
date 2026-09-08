import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMediaBase64, MediaWorker } from "./media-worker";

describe("media worker", () => {
  test("decodes bounded base64 and reports file read progress", async () => {
    expect(Array.from(decodeMediaBase64("aGVsbG8="))).toEqual([104, 101, 108, 108, 111]);

    const root = mkdtempSync(join(tmpdir(), "liney-media-worker-test-"));
    const filePath = join(root, "image.bin");
    writeFileSync(filePath, Buffer.from("hello"), { mode: 0o600 });
    const events: Array<{ phase?: string; done?: number; total?: number }> = [];
    const worker = new MediaWorker((event) => {
      if (event.type === "media.progress") {
        events.push({ phase: event.phase, done: event.done, total: event.total });
      }
    }, undefined, [root]);

    const bytes = await worker.read({ filePath }, "job-read", new AbortController().signal);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(events).toEqual([
      { phase: "reading", done: 0, total: 5 },
      { phase: "reading", done: 5, total: 5 },
    ]);
  });

  test("rejects paths outside the configured roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "liney-media-worker-root-"));
    const worker = new MediaWorker(() => undefined, undefined, [root]);
    await expect(worker.read({ filePath: "/etc/hosts" }, "job-path", new AbortController().signal))
      .rejects.toThrow("outside the allowed user/temp directories");
    expect(() => decodeMediaBase64("not base64!" as string)).toThrow("not valid base64");
  });

  test("cancels an active job and emits a cancellation error", async () => {
    const events: Array<{ type: string; phase?: string; cancelled?: boolean }> = [];
    const worker = new MediaWorker((event) => events.push(event));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const running = worker.run("job-cancel", async (signal) => {
      await blocked;
      if (signal.aborted) throw new Error("media upload cancelled");
      return "sent";
    });

    expect(worker.cancel("job-cancel")).toBe(true);
    release();
    await expect(running).rejects.toThrow("media upload cancelled");
    expect(events).toContainEqual({ type: "media.progress", jobId: "job-cancel", phase: "cancelled", done: 0, total: 0 });
    expect(events.some((event) => event.type === "media.error" && event.cancelled)).toBe(true);
    expect(worker.cancel("job-cancel")).toBe(false);
  });
});
