import { describe, expect, test } from "bun:test";
import { createAuthFinalizationBarrier } from "./auth-finalization";

describe("auth finalization barrier", () => {
  test("waits for an active finalization to settle", async () => {
    const barrier = createAuthFinalizationBarrier();
    let settle!: () => void;
    const operation = barrier.track(() => new Promise<void>((resolve) => {
      settle = resolve;
    }));
    let waited = false;
    const waiting = barrier.wait().then(() => { waited = true; });

    await Promise.resolve();
    expect(waited).toBe(false);
    settle();
    await Promise.all([operation, waiting]);
    expect(waited).toBe(true);
  });

  test("does not let a rejected finalization block logout cleanup", async () => {
    const barrier = createAuthFinalizationBarrier();
    const operation = barrier.track(async () => {
      throw new Error("finalization failed");
    });
    await expect(operation).rejects.toThrow("finalization failed");
    await expect(barrier.wait()).resolves.toBeUndefined();
  });

  test("does not wait after the finalization has settled", async () => {
    const barrier = createAuthFinalizationBarrier();
    await barrier.track(async () => undefined);
    await expect(barrier.wait()).resolves.toBeUndefined();
  });

  test("waits for every concurrently tracked finalization", async () => {
    const barrier = createAuthFinalizationBarrier();
    let settleFirst!: () => void;
    let settleSecond!: () => void;
    const first = barrier.track(() => new Promise<void>((resolve) => {
      settleFirst = resolve;
    }));
    const second = barrier.track(() => new Promise<void>((resolve) => {
      settleSecond = resolve;
    }));
    let waited = false;
    const waiting = barrier.wait().then(() => { waited = true; });

    await Promise.resolve();
    settleFirst();
    await first;
    await Promise.resolve();
    expect(waited).toBe(false);

    settleSecond();
    await Promise.all([second, waiting]);
    expect(waited).toBe(true);
  });

  test("waits for a finalization registered while waiting", async () => {
    const barrier = createAuthFinalizationBarrier();
    let settleFirst!: () => void;
    let settleSecond!: () => void;
    const first = barrier.track(() => new Promise<void>((resolve) => {
      settleFirst = resolve;
    }));
    let waited = false;
    const waiting = barrier.wait().then(() => { waited = true; });

    await Promise.resolve();
    const second = barrier.track(() => new Promise<void>((resolve) => {
      settleSecond = resolve;
    }));
    await Promise.resolve();
    settleFirst();
    await first;
    await Promise.resolve();
    expect(waited).toBe(false);

    settleSecond();
    await Promise.all([second, waiting]);
    expect(waited).toBe(true);
  });

  test("logout clears auth-storage writes that finish after logout starts", async () => {
    const barrier = createAuthFinalizationBarrier();
    const durable = new Map<string, string>();
    let generation = 0;
    let finishWrite!: () => void;

    const finalization = barrier.track(async () => {
      if (generation !== 0) return;
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      // The write was already inside the barrier when Logout invalidated it.
      durable.set("refreshToken", "late-token");
    });

    // Ensure the finalizer has entered its protected write before Logout.
    while (!finishWrite) await Promise.resolve();
    generation += 1;
    let logoutFinished = false;
    const logout = barrier.wait().then(() => {
      durable.clear();
      logoutFinished = true;
    });

    expect(logoutFinished).toBe(false);
    finishWrite();
    await Promise.all([finalization, logout]);

    expect(logoutFinished).toBe(true);
    expect(durable.size).toBe(0);
  });

  test("does not commit auth storage when logout invalidates before finalization", async () => {
    const barrier = createAuthFinalizationBarrier();
    const durable = new Map<string, string>();
    let generation = 1;

    const result = await barrier.track(async () => {
      if (generation !== 1) return false;
      durable.set("refreshToken", "stale-token");
      return true;
    });

    expect(result).toBe(true);
    generation += 1;
    await barrier.wait();
    durable.clear();
    expect(durable.size).toBe(0);
  });
});
