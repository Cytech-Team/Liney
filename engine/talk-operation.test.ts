import { describe, expect, test } from "bun:test";
import { canonicalTalkOperationType, isLineServiceChatOperation } from "./talk-operation";

describe("Talk operation compatibility", () => {
  test("uses the LINE Android 26.11 wire mapping for service-chat operations", () => {
    expect(canonicalTalkOperationType(160, "3.4.2")).toBe("UPDATE_SERVICE_CHAT");
    expect(canonicalTalkOperationType(161, "3.4.2")).toBe("MARK_SERVICE_CHAT_AS_READ");
    expect(canonicalTalkOperationType(162, "3.4.2")).toBe("UPDATE_SERVICE_CHAT_NOTIFICATION_TEXT");
    expect(canonicalTalkOperationType(169, "3.4.2")).toBe("LINE_AUTH_NOTIFICATION");
  });

  test("repairs the shifted symbolic names emitted by LINEJS 3.4.2 only", () => {
    expect(canonicalTalkOperationType("ADD_SCHEDULED_MESSAGE", "3.4.2")).toBe("UPDATE_SERVICE_CHAT");
    expect(canonicalTalkOperationType("UPDATE_SERVICE_CHAT", "3.4.2")).toBe("E2EE_REENCRYPT_SCHEDULED_MESSAGE");
    expect(canonicalTalkOperationType("ADD_SCHEDULED_MESSAGE", "3.5.0")).toBe("ADD_SCHEDULED_MESSAGE");
  });

  test("identifies only service/auth operations as system-chat signals", () => {
    expect(isLineServiceChatOperation("UPDATE_SERVICE_CHAT")).toBe(true);
    expect(isLineServiceChatOperation("LINE_AUTH_NOTIFICATION")).toBe(true);
    expect(isLineServiceChatOperation("ADD_SCHEDULED_MESSAGE")).toBe(false);
  });
});
