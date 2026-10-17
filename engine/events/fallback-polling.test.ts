import { describe, expect, test } from "bun:test";
import { runFallbackPolling } from "./fallback-polling";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("fallback polling supervisor", () => {
  test("stops an active fallback cycle when primary transport recovers without waiting for an event", async () => {
    const parent = new AbortController();
    let fallbackNeeded = true;
    let cycles = 0;
    let cycleAbortSeen = false;

    const task = runFallbackPolling({
      signal: parent.signal,
      shouldPoll: () => fallbackNeeded,
      activeCheckMs: 5,
      idleCheckMs: 5,
      retryDelayMs: 5,
      createStream: async function* (signal) {
        cycles += 1;
        while (!signal.aborted) await sleep(2);
        cycleAbortSeen = true;
        yield* [];
      },
      onEvent: () => undefined,
    });

    await sleep(20);
    fallbackNeeded = false;
    await sleep(25);

    expect(cycles).toBe(1);
    expect(cycleAbortSeen).toBe(true);

    parent.abort();
    await task;
  });

  test("does not start fallback polling while the primary transport is healthy", async () => {
    const parent = new AbortController();
    let fallbackNeeded = false;
    let cycles = 0;

    const task = runFallbackPolling({
      signal: parent.signal,
      shouldPoll: () => fallbackNeeded,
      activeCheckMs: 5,
      idleCheckMs: 5,
      retryDelayMs: 5,
      createStream: async function* (signal) {
        cycles += 1;
        while (!signal.aborted) await sleep(2);
        yield* [];
      },
      onEvent: () => undefined,
    });

    await sleep(20);
    expect(cycles).toBe(0);

    fallbackNeeded = true;
    await sleep(20);
    expect(cycles).toBe(1);

    parent.abort();
    await task;
  });

  test("backs off and opens a circuit after repeated polling failures", async () => {
    const parent = new AbortController();
    const starts: number[] = [];
    let errors = 0;

    await runFallbackPolling({
      signal: parent.signal,
      shouldPoll: () => true,
      activeCheckMs: 2,
      idleCheckMs: 2,
      retryDelayMs: 2,
      maxRetryDelayMs: 4,
      circuitBreakerFailures: 3,
      circuitBreakerDelayMs: 20,
      createStream: async function* () {
        starts.push(Date.now());
        if (starts.length >= 4) {
          parent.abort();
          yield* [];
          return;
        }
        throw new Error("offline");
      },
      onEvent: () => undefined,
      onError: () => { errors += 1; },
    });

    expect(errors).toBe(3);
    expect(starts).toHaveLength(4);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(3);
    expect(starts[3] - starts[2]).toBeGreaterThanOrEqual(15);
  });
});
