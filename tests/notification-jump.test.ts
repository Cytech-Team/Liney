import { describe, expect, test } from "bun:test";
import { pendingNotificationJump } from "../src/lib/notification-jump";

describe("pendingNotificationJump", () => {
  test("applies a jump once and ignores it on later renders", () => {
    const jump = { messageId: "m1", nonce: 111 };
    expect(pendingNotificationJump(jump, 0)).toEqual(jump);
    // Re-entering the chat, refreshing messages or switching rooms re-runs the
    // effect with the same nonce; it must not scroll back to the message.
    expect(pendingNotificationJump(jump, 111)).toBeNull();
  });

  test("a new notification for the same message opens it again", () => {
    expect(pendingNotificationJump({ messageId: "m1", nonce: 222 }, 111)).toEqual({
      messageId: "m1",
      nonce: 222,
    });
  });

  test("ignores empty or unnumbered requests", () => {
    expect(pendingNotificationJump(null, 0)).toBeNull();
    expect(pendingNotificationJump(undefined, 0)).toBeNull();
    expect(pendingNotificationJump({ messageId: "", nonce: 5 }, 0)).toBeNull();
    expect(pendingNotificationJump({ messageId: "m1", nonce: 0 }, 0)).toBeNull();
  });
});
