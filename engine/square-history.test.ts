import { describe, expect, test } from "bun:test";
import {
  olderSquareHistory,
  squareEventEnvelope,
  squareEventToken,
  withSquareEventToken,
} from "./square-history";

const event = (overrides: Record<string, unknown> = {}) => ({
  type: "RECEIVE_MESSAGE",
  createdTime: 1_700_000_000_000,
  syncToken: "tok-1",
  payload: {
    receiveMessage: {
      senderDisplayName: "Somchai",
      squareMessage: { message: { id: "101", text: "hello", createdTime: 1_700_000_000_000 } },
    },
  },
  ...overrides,
});

describe("square history events", () => {
  test("extracts the message envelope and its sync token", () => {
    const envelope = squareEventEnvelope(event());
    expect(envelope?.message.id).toBe("101");
    expect(envelope?.senderName).toBe("Somchai");
    expect(envelope?.isMine).toBe(false);
    expect(envelope?.eventToken).toBe("tok-1");
  });

  test("marks SEND_MESSAGE events as own messages", () => {
    const envelope = squareEventEnvelope({
      type: "SEND_MESSAGE",
      syncToken: "tok-2",
      payload: { sendMessage: { squareMessage: { message: { id: "102" } } } },
    });
    expect(envelope?.isMine).toBe(true);
  });

  test("ignores events without a message payload", () => {
    expect(squareEventEnvelope({ type: "NOTIFIED_JOIN_SQUARE_CHAT", payload: {} })).toBeNull();
    expect(squareEventEnvelope(null)).toBeNull();
  });

  test("round-trips the event token through the stored raw payload", () => {
    const raw = withSquareEventToken({ id: "1" }, "tok-abc");
    expect(squareEventToken(raw)).toBe("tok-abc");
    expect(squareEventToken({ id: "1" })).toBeUndefined();
    expect(squareEventToken(null)).toBeUndefined();
  });

  test("keeps only messages older than the pivot and sorts them ascending", () => {
    const pivot = { id: "300", createdTime: 1_700_000_300_000 };
    const page = olderSquareHistory([
      { id: "299", createdTime: 1_700_000_299_000 },
      { id: "301", createdTime: 1_700_000_301_000 },
      { id: "280", createdTime: 1_700_000_280_000 },
      { id: "299", createdTime: 1_700_000_299_000 },
      { id: "300", createdTime: 1_700_000_300_000 },
    ], pivot);
    expect(page.map((item) => item.id)).toEqual(["280", "299"]);
  });

  test("orders equal timestamps by id so paging never loops", () => {
    const pivot = { id: "b", createdTime: 5_000 };
    const page = olderSquareHistory([
      { id: "c", createdTime: 5_000 },
      { id: "a", createdTime: 5_000 },
      { id: "b", createdTime: 5_000 },
    ], pivot);
    expect(page.map((item) => item.id)).toEqual(["a"]);
  });
});
