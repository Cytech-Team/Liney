export type ReleaseLoginAttempt = () => void;

/**
 * Serializes authentication flows that share LINEJS credential storage.
 * The owner releases the lock only after its underlying LINEJS operation settles.
 */
export function createLoginAttemptGuard() {
  let locked = false;

  return {
    isLocked(): boolean {
      return locked;
    },

    tryAcquire(): ReleaseLoginAttempt | null {
      if (locked) return null;
      locked = true;
      let released = false;

      return () => {
        if (released) return;
        released = true;
        locked = false;
      };
    },
  };
}
