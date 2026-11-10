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
});
