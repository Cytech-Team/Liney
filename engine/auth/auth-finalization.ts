/**
 * Tracks asynchronous session-finalization phases so logout can invalidate
 * attempts immediately, then wait for every in-flight finalizer before
 * clearing shared account and credential state.
 */
export function createAuthFinalizationBarrier() {
  const pending = new Set<Promise<void>>();

  return {
    track<T>(operation: () => Promise<T>): Promise<T> {
      const task = Promise.resolve().then(operation);
      // Track a non-rejecting promise so a failed finalizer cannot leave the
      // barrier permanently blocked or create an unhandled rejection.
      const settled = task.then(() => undefined, () => undefined);
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
      return task;
    },

    async wait(): Promise<void> {
      // Loop because another finalizer may be registered while we are waiting
      // for the current batch to settle.
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  };
}
