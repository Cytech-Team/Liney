import { describe, expect, test } from "bun:test";
import { createLoginAttemptGuard } from "./login-guard";

describe("login attempt guard", () => {
  test("rejects overlapping authentication attempts", () => {
    const guard = createLoginAttemptGuard();
    const release = guard.tryAcquire();

    expect(release).toBeTypeOf("function");
    expect(guard.isLocked()).toBe(true);
    expect(guard.tryAcquire()).toBeNull();

    release?.();
    expect(guard.isLocked()).toBe(false);
    expect(guard.tryAcquire()).toBeTypeOf("function");
  });

  test("keeps a stale attempt locked until its owner settles", () => {
    const guard = createLoginAttemptGuard();
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const release = guard.tryAcquire();

    expect(guard.tryAcquire()).toBeNull();
    settle();
    expect(guard.isLocked()).toBe(true);

    return pending.then(() => {
      release?.();
      expect(guard.isLocked()).toBe(false);
    });
  });

  test("release is idempotent", () => {
    const guard = createLoginAttemptGuard();
    const release = guard.tryAcquire();

    release?.();
    release?.();

    expect(guard.isLocked()).toBe(false);
    expect(guard.tryAcquire()).toBeTypeOf("function");
  });
});
