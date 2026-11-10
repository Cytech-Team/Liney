/**
 * Tracks the asynchronous session-finalization phase so logout can invalidate
 * the attempt immediately, then wait for any in-flight finalizer before
 * clearing shared account and credential state.
 */
export function createAuthFinalizationBarrier() {
  let pending: Promise<void> | null = null;

  return {
    track<T>(operation: () => Promise<T>): Promise<T> {
      const task = Promise.resolve().then(operation);
      const settled = task.then(() => undefined, () => undefined);
      pending = settled;
      void settled.then(() => {
        if (pending === settled) pending = null;
      });
      return task;
    },

    async wait(): Promise<void> {
      const active = pending;
      if (active) await active;
    },
  };
}
