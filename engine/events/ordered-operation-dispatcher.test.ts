import { describe, expect, test } from "bun:test";
import {
  OrderedOperationDispatcher, squareOperationIdentity, talkOperationIdentity,
} from "./ordered-operation-dispatcher";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("ordered operation dispatcher", () => {
  test("preserves processing order between concurrent PUSH and polling deliveries", async () => {
    const firstGate = deferred();
    const visited: number[] = [];
    const dispatcher = new OrderedOperationDispatcher(
      () => true,
      (item: { id: number }) => String(item.id),
      async ({ id }) => {
        if (id === 1) await firstGate.promise;
        visited.push(id);
      },
    );
    const first = dispatcher.dispatch({ id: 1 });
    const second = dispatcher.dispatch({ id: 2 });
    await Promise.resolve();
    expect(visited).toEqual([]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(visited).toEqual([1, 2]);
  });

  test("deduplicates already handled operations, including cross-transport replays", async () => {
    const visited: number[] = [];
    const dispatcher = new OrderedOperationDispatcher(
      () => true, (item: { id: number }) => String(item.id),
      async ({ id }) => { visited.push(id); },
    );
    await Promise.all([dispatcher.dispatch({ id: 3 }), dispatcher.dispatch({ id: 3 })]);
    expect(visited).toEqual([3]);
  });

  test("failed events are retryable and never poison the queue", async () => {
    let attempts = 0;
    const dispatcher = new OrderedOperationDispatcher(
      () => true, () => "same",
      async () => { if (++attempts === 1) throw new Error("decode failed"); },
    );
    await expect(dispatcher.dispatch(1)).rejects.toThrow("decode failed");
    await dispatcher.dispatch(1);
    await dispatcher.dispatch(1);
    expect(attempts).toBe(2);
  });

  test("drops pending work after session shutdown without calling the handler", async () => {
    const gate = deferred();
    let active = true;
    const visited: number[] = [];
    const dispatcher = new OrderedOperationDispatcher(
      () => active, (n: number) => String(n),
      async (n) => { if (n === 1) await gate.promise; visited.push(n); },
    );
    const first = dispatcher.dispatch(1);
    const pending = dispatcher.dispatch(2);
    await Promise.resolve();
    active = false;
    gate.resolve();
    await Promise.all([first, pending]);
    expect(visited).toEqual([1]);
  });

  test("bounded replay cache evicts oldest identities", async () => {
    const visited: number[] = [];
    const dispatcher = new OrderedOperationDispatcher(
      () => true, (n: number) => String(n),
      async (n) => { visited.push(n); }, 2,
    );
    for (const n of [1, 2, 3, 2, 1]) await dispatcher.dispatch(n);
    expect(visited).toEqual([1, 2, 3, 1]);
  });

  test("uses revisions for mutable operations and stable ids only for first message delivery", () => {
    expect(talkOperationIdentity({ revision: "177" }, "NOTIFIED_SEND_REACTION")).toBe("talk:NOTIFIED_SEND_REACTION:revision:177");
    expect(talkOperationIdentity({ message: { id: "999" } }, "RECEIVE_MESSAGE")).toBe("talk:RECEIVE_MESSAGE:message:999");
    expect(talkOperationIdentity({ message: { id: "999" } }, "EDIT_MESSAGE")).toBeNull();
    expect(squareOperationIdentity({
      payload: { receiveMessage: { squareMessage: { squareChatMid: "chat", message: { id: "999" } } } },
    }, "RECEIVE_MESSAGE")).toBe("square:RECEIVE_MESSAGE:message:chat:999");
    expect(squareOperationIdentity({ revision: "22" }, "NOTIFICATION_MESSAGE_REACTION"))
      .toBe("square:NOTIFICATION_MESSAGE_REACTION:revision:22");
  });
});
