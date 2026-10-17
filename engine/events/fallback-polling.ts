export type FallbackPollingOptions<T> = {
  signal: AbortSignal;
  shouldPoll: () => boolean;
  createStream: (cycleSignal: AbortSignal) => AsyncIterable<T>;
  onEvent: (event: T) => void | Promise<void>;
  onError?: (error: unknown) => void;
  idleCheckMs?: number;
  activeCheckMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  circuitBreakerFailures?: number;
  circuitBreakerDelayMs?: number;
};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function stopWhenPrimaryRecovers(
  parentSignal: AbortSignal,
  cycle: AbortController,
  shouldPoll: () => boolean,
  checkMs: number,
): Promise<void> {
  while (!parentSignal.aborted && !cycle.signal.aborted) {
    if (!shouldPoll()) {
      cycle.abort();
      return;
    }
    await wait(checkMs, cycle.signal);
  }
}

/**
 * Runs a fallback-only polling stream.
 *
 * The caller owns the underlying poller/session and should keep it stable for
 * the lifetime of the authenticated client. This helper only supervises when
 * that stream is allowed to run. An active polling cycle is aborted as soon as
 * the primary transport becomes healthy, even if the fallback stream has not
 * yielded an event yet.
 */
export async function runFallbackPolling<T>({
  signal,
  shouldPoll,
  createStream,
  onEvent,
  onError,
  idleCheckMs = 1_000,
  activeCheckMs = 250,
  retryDelayMs = 1_000,
  maxRetryDelayMs = 30_000,
  circuitBreakerFailures = 3,
  circuitBreakerDelayMs = 30_000,
}: FallbackPollingOptions<T>): Promise<void> {
  let consecutiveFailures = 0;
  let retryDelay = retryDelayMs;

  while (!signal.aborted) {
    if (!shouldPoll()) {
      await wait(idleCheckMs, signal);
      continue;
    }

    const cycle = new AbortController();
    const abortCycle = () => cycle.abort();
    signal.addEventListener("abort", abortCycle, { once: true });
    const recoveryMonitor = stopWhenPrimaryRecovers(signal, cycle, shouldPoll, activeCheckMs);

    let failed = false;
    try {
      for await (const event of createStream(cycle.signal)) {
        if (signal.aborted) return;
        if (!shouldPoll()) {
          cycle.abort();
          break;
        }
        // A delivered event proves the fallback path is making forward
        // progress. Clear failure history so an old outage cannot keep the
        // circuit open after the network has recovered.
        consecutiveFailures = 0;
        retryDelay = retryDelayMs;
        await onEvent(event);
      }
    } catch (error) {
      if (!signal.aborted && !cycle.signal.aborted) {
        failed = true;
        consecutiveFailures += 1;
        onError?.(error);
      }
    } finally {
      cycle.abort();
      signal.removeEventListener("abort", abortCycle);
      await recoveryMonitor;
    }

    if (!signal.aborted && shouldPoll()) {
      if (failed && consecutiveFailures >= circuitBreakerFailures) {
        // Repeated connect failures can leave the kernel with many SYN-SENT
        // sockets even after fetch has rejected. Stop creating new attempts
        // long enough for those sockets to age out instead of amplifying the
        // outage into a local file-descriptor/connection storm.
        await wait(circuitBreakerDelayMs, signal);
        consecutiveFailures = 0;
        retryDelay = retryDelayMs;
      } else {
        await wait(failed ? retryDelay : retryDelayMs, signal);
        if (failed) retryDelay = Math.min(Math.max(retryDelayMs, retryDelay * 2), maxRetryDelayMs);
        else retryDelay = retryDelayMs;
      }
    }
  }
}
