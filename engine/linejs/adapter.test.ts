import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LineJsAdapter, createPollingSession, fetchMessageAsset, getChatMetadataBatch, getTalkMessageReadRanges, getTargetProfiles, LINEJS_VERSION, updateOwnProfile, markTalkMessageRead, normalizeTalkMessageReadRanges, parseE2EEKeyData, replyTargetMessageId, sendTalkMessage, sendTalkMediaE2EE, talkMessageEditState } from "./adapter";

describe("LineJsAdapter sender metadata", () => {
  test("deduplicates sender MIDs and requests target profiles through LINEJS", async () => {
    let request: unknown;
    const client = {
      base: {
        relation: {
          getTargetProfiles: async (value: unknown) => {
            request = value;
            return { responses: [{ targetUserMid: "u-bot", userType: "BOT" }] };
          },
        },
      },
    } as any;

    const profiles = await getTargetProfiles(client, ["u-bot", "", "u-bot"]);

    expect(request).toEqual({
      request: {
        targetUsers: [{ targetUserMid: "u-bot" }],
        syncReason: "INTERNAL",
      },
    });
    expect(profiles).toEqual([{ targetUserMid: "u-bot", userType: "BOT" }]);
  });

  test("does not call LINEJS for an empty sender list", async () => {
    let called = false;
    const client = {
      base: {
        relation: {
          getTargetProfiles: async () => {
            called = true;
            return { responses: [] };
          },
        },
      },
    } as any;

    await expect(getTargetProfiles(client, ["", "  "])).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  test("keeps message asset fetching behind the adapter boundary", async () => {
    let requestedUrl = "";
    const client = {
      base: {
        fetch: async (url: string) => {
          requestedUrl = url;
          return new Response(new Blob(["image"]), { status: 200, headers: { "content-type": "image/png" } });
        },
      },
    } as any;

    const asset = await fetchMessageAsset(client, "https://cdn.example.test/card.png");

    expect(requestedUrl).toBe("https://cdn.example.test/card.png");
    expect(asset).toBeInstanceOf(Blob);
    await expect(fetchMessageAsset({ base: { fetch: async () => new Response("no", { status: 403 }) } } as any, "https://cdn.example.test/card.png")).rejects.toThrow("403");
  });
});

describe("LineJsAdapter E2EE key storage", () => {
  test("reads JSON-string key records and rejects malformed records", () => {
    const key = { keyId: 7, privKey: "private", pubKey: "public" };

    expect(parseE2EEKeyData(JSON.stringify(key))).toEqual(key);
    expect(parseE2EEKeyData(key)).toEqual(key);
    expect(parseE2EEKeyData("not-json")).toBeNull();
    expect(parseE2EEKeyData("[]")).toBeNull();
  });
});


describe("LineJsAdapter fallback polling", () => {
  test("creates one stateful LINEJS Polling instance for talk and square fallback cycles", () => {
    let created = 0;
    const calls: string[] = [];
    const polling = {
      _listenTalkEvents: (options: unknown) => { calls.push(`talk:${String(Boolean(options))}`); return {} as AsyncIterable<unknown>; },
      _listenSquareEvents: (options: unknown) => { calls.push(`square:${String(Boolean(options))}`); return {} as AsyncIterable<unknown>; },
    };
    const client = {
      base: {
        square: { fetchMyEvents: async () => ({ events: [], syncToken: "sync" }) },
        createPolling: () => { created += 1; return polling; },
      },
    } as any;

    const session = createPollingSession(client);
    session.talk({ pollingInterval: 1000 });
    session.square({ pollingInterval: 1000 });
    session.talk({ pollingInterval: 250 });

    expect(created).toBe(1);
    expect(calls).toEqual(["talk:true", "talk:true"]);
  });

  test("drains Square continuation pages before releasing the shared PUSH cursor", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    let releasePush!: () => void;
    const pushStarted = new Promise<void>((resolve) => { releasePush = resolve; });
    let pushFinished = false;
    const pollingState = { sync: { square: "initial-sync", talk: {} }, _listenTalkEvents: () => ({}) };
    const client = {
      base: {
        square: {
          fetchMyEvents: async (request: Record<string, unknown>) => {
            requests.push(request);
            if (request.subscriptionId) {
              pushFinished = true;
              return { events: [], syncToken: "push-sync" };
            }
            if (!request.continuationToken) {
              releasePush();
              return { events: [{ id: "page-1" }], syncToken: "page-sync", continuationToken: "next-page" };
            }
            return { events: [{ id: "page-2" }], syncToken: "final-sync" };
          },
        },
        createPolling: () => pollingState,
      },
    } as any;

    const session = createPollingSession(client);
    const controller = new AbortController();
    const iterator = session.square({ signal: controller.signal, pollingInterval: 60_000 })[Symbol.asyncIterator]();
    const first = await iterator.next();
    events.push(first.value.id);

    const pushRequest = client.base.square.fetchMyEvents({ subscriptionId: 7, syncToken: "ignored" });
    await pushStarted;
    const second = await iterator.next();
    events.push(second.value.id);
    controller.abort();
    const finished = await iterator.next();
    expect(finished.done).toBe(true);
    await pushRequest;

    expect(events).toEqual(["page-1", "page-2"]);
    expect(requests.slice(0, 2)).toEqual([
      { syncToken: "initial-sync", continuationToken: undefined, limit: 100 },
      { syncToken: "page-sync", continuationToken: "next-page", limit: 100 },
    ]);
    expect(pushFinished).toBe(true);
    expect(pollingState.sync.square).toBe("final-sync");
  });

  test("serializes the complete PUSH response so it snapshots the committed REST cursor", async () => {
    const pollingState = { sync: { square: "initial-sync", talk: {} }, _listenTalkEvents: () => ({}) };
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      base: {
        push: {
          onPushResponse: async () => {
            const syncToken = pollingState.sync.square;
            await client.base.square.fetchMyEvents({ subscriptionId: 7, syncToken });
            pollingState.sync.square = "push-committed";
          },
        },
        square: {
          fetchMyEvents: async (request: Record<string, unknown>) => {
            requests.push(request);
            if (request.subscriptionId) return { events: [], syncToken: "push-response-sync" };
            if (!request.continuationToken) {
              return { events: [{ id: "page-1" }], syncToken: "page-sync", continuationToken: "next-page" };
            }
            return { events: [{ id: "page-2" }], syncToken: "final-sync" };
          },
        },
        createPolling: () => pollingState,
      },
    } as any;

    const session = createPollingSession(client);
    const controller = new AbortController();
    const iterator = session.square({ signal: controller.signal, pollingInterval: 60_000 })[Symbol.asyncIterator]();
    expect((await iterator.next()).value.id).toBe("page-1");

    const pushResponse = client.base.push.onPushResponse({});
    await Promise.resolve();
    expect(requests.some((request) => request.subscriptionId === 7)).toBe(false);

    expect((await iterator.next()).value.id).toBe("page-2");
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    await pushResponse;

    expect(requests.find((request) => request.subscriptionId === 7)).toEqual({
      subscriptionId: 7,
      syncToken: "final-sync",
    });
    expect(pollingState.sync.square).toBe("push-committed");
  });

  test("keeps REST out until PUSH has committed its cursor after fetch", async () => {
    const pollingState = { sync: { square: "before-push", talk: {} }, _listenTalkEvents: () => ({}) };
    const requests: Array<Record<string, unknown>> = [];
    let finishFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { finishFetch = resolve; });
    let pushFetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { pushFetchStarted = resolve; });
    const client = {
      base: {
        push: {
          onPushResponse: async () => {
            const cursor = pollingState.sync.square;
            await client.base.square.fetchMyEvents({ subscriptionId: 9, syncToken: cursor });
            pollingState.sync.square = "after-push-commit";
          },
        },
        square: {
          fetchMyEvents: async (request: Record<string, unknown>) => {
            requests.push(request);
            if (request.subscriptionId) {
              pushFetchStarted();
              await fetchGate;
              return { events: [], syncToken: "push-result" };
            }
            return { events: [{ id: "rest-event" }], syncToken: "rest-result" };
          },
        },
        createPolling: () => pollingState,
      },
    } as any;

    const session = createPollingSession(client);
    const pushResponse = client.base.push.onPushResponse({});
    await started;
    const controller = new AbortController();
    const iterator = session.square({ signal: controller.signal, pollingInterval: 60_000 })[Symbol.asyncIterator]();
    await Promise.resolve();
    expect(requests.filter((request) => !request.subscriptionId)).toHaveLength(0);

    finishFetch();
    await pushResponse;
    expect(pollingState.sync.square).toBe("after-push-commit");
    expect((await iterator.next()).value.id).toBe("rest-event");
    expect(requests.find((request) => !request.subscriptionId)?.syncToken).toBe("after-push-commit");
    controller.abort();
    await iterator.next();
  });

  test("serializes PUSH sign-on cursor updates behind an active Square pagination chain", async () => {
    const pollingState = { sync: { square: "initial-sync", talk: {} }, _listenTalkEvents: () => ({}) };
    const requests: Array<Record<string, unknown>> = [];
    let signOnFinished = false;
    const client = {
      base: {
        push: {
          onSignOnResponse: async () => {
            pollingState.sync.square = "push-sign-on-sync";
            signOnFinished = true;
          },
        },
        square: {
          fetchMyEvents: async (request: Record<string, unknown>) => {
            requests.push(request);
            if (!request.continuationToken) {
              return { events: [{ id: "page-1" }], syncToken: "page-sync", continuationToken: "next-page" };
            }
            return { events: [{ id: "page-2" }], syncToken: "final-sync" };
          },
        },
        createPolling: () => pollingState,
      },
    } as any;

    const session = createPollingSession(client);
    const controller = new AbortController();
    const iterator = session.square({ signal: controller.signal, pollingInterval: 60_000 })[Symbol.asyncIterator]();
    expect((await iterator.next()).value.id).toBe("page-1");

    const signOn = client.base.push.onSignOnResponse();
    await Promise.resolve();
    expect(signOnFinished).toBe(false);

    expect((await iterator.next()).value.id).toBe("page-2");
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    await signOn;

    expect(signOnFinished).toBe(true);
    expect(pollingState.sync.square).toBe("push-sign-on-sync");
    expect(requests).toHaveLength(2);
  });
});


describe("LineJsAdapter fallback polling", () => {
  test("creates one stateful LINEJS Polling instance for talk and square fallback cycles", () => {
    let created = 0;
    const calls: string[] = [];
    const polling = {
      _listenTalkEvents: (options: unknown) => { calls.push(`talk:${String(Boolean(options))}`); return {} as AsyncIterable<unknown>; },
      _listenSquareEvents: (options: unknown) => { calls.push(`square:${String(Boolean(options))}`); return {} as AsyncIterable<unknown>; },
    };
    const client = {
      base: {
        square: { fetchMyEvents: async () => ({ events: [], syncToken: "sync" }) },
        createPolling: () => { created += 1; return polling; },
      },
    } as any;

    const session = createPollingSession(client);
    session.talk({ pollingInterval: 1000 });
    session.square({ pollingInterval: 1000 });
    session.talk({ pollingInterval: 250 });

    expect(created).toBe(1);
    expect(calls).toEqual(["talk:true", "talk:true"]);
  });
});


describe("LineJsAdapter E2EE Talk media", () => {
  test("keeps media replies encrypted and attaches the relation to the final Talk message", async () => {
    const uploads: Array<Record<string, unknown>> = [];
    let sent: Record<string, unknown> | undefined;
    const client = {
      base: {
        e2ee: {
          encryptByKeyMaterial: async () => ({ keyMaterial: Buffer.alloc(32, 1).toString("base64"), encryptedData: Buffer.from("encrypted") }),
          encryptE2EEMessage: async () => ["chunk-a", "chunk-b"],
        },
        obs: {
          uploadObjectForService: async (value: Record<string, unknown>) => {
            uploads.push(value);
            return { objId: "obj-e2ee" };
          },
        },
        talk: {
          sendMessage: async (value: Record<string, unknown>) => { sent = value; return { id: "631457091218833700" }; },
        },
      },
    } as any;

    const result = await sendTalkMediaE2EE(client, {
      to: "u-peer",
      oType: "video",
      data: new Blob(["video"], { type: "video/mp4" }),
      filename: "clip.mp4",
      durationMs: 1234.6,
      relatedMessageId: "631457091218833634",
    });

    expect(result).toEqual({ id: "631457091218833700" });
    expect(uploads).toHaveLength(2);
    expect(String(uploads[0]?.obsPath)).toContain("talk/emv/reqid-");
    expect(uploads[1]?.obsPath).toBe("talk/emv/obj-e2ee__ud-preview");
    expect(sent).toMatchObject({
      to: "u-peer",
      contentType: 2,
      relatedMessageId: "631457091218833634",
      chunks: ["chunk-a", "chunk-b"],
      contentMetadata: {
        SID: "emv",
        OID: "obj-e2ee",
        e2eeVersion: "2",
        DURATION: "1235",
      },
    });
  });
});

describe("LineJsAdapter E2EE text sender-key recovery", () => {
  test("persists, selects, and verifies the refreshed key before retrying encrypted text", async () => {
    let activeKey: Record<string, unknown> = { keyId: 4, privKey: "old-private", pubKey: "old-public" };
    let registerCalls = 0;
    let verifyCalls = 0;
    const calls: Array<Record<string, unknown>> = [];
    const registered = {
      keyId: 5,
      privKey: Buffer.alloc(32, 5),
      pubKey: Buffer.alloc(32, 6),
      e2eeVersion: 1,
    };
    const client = {
      base: {
        profile: { mid: "u-self" },
        e2ee: {
          registerE2EEKeyPair: async () => { registerCalls += 1; return registered; },
          saveE2EESelfKeyData: async (value: Record<string, unknown>) => { activeKey = value; },
          getE2EESelfKeyData: async () => activeKey,
          verifyStoredKeyAgainstServer: async () => { verifyCalls += 1; return true; },
        },
        talk: {
          sendMessage: async (value: Record<string, unknown>) => {
            calls.push(value);
            if (calls.length === 1) {
              throw Object.assign(new Error("send rejected"), { data: { code: "E2EE_UPDATE_SENDER_KEY" } });
            }
            return { id: "server-message-1" };
          },
        },
      },
    } as any;

    await expect(sendTalkMessage(client, { to: "u-peer", text: "hello" })).resolves.toEqual({ id: "server-message-1" });

    expect(registerCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(activeKey).toMatchObject({
      keyId: 5,
      privKey: registered.privKey.toString("base64"),
      pubKey: registered.pubKey.toString("base64"),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ to: "u-peer", text: "hello", e2ee: true });
  });

  test("does not retry when LINE reports the registered sender key does not match", async () => {
    let sendCalls = 0;
    const registered = {
      keyId: 5,
      privKey: Buffer.alloc(32, 5),
      pubKey: Buffer.alloc(32, 6),
      e2eeVersion: 1,
    };
    let activeKey: Record<string, unknown> = {};
    const client = {
      base: {
        profile: { mid: "u-self" },
        e2ee: {
          registerE2EEKeyPair: async () => registered,
          saveE2EESelfKeyData: async (value: Record<string, unknown>) => { activeKey = value; },
          getE2EESelfKeyData: async () => activeKey,
          verifyStoredKeyAgainstServer: async () => false,
        },
        talk: {
          sendMessage: async () => {
            sendCalls += 1;
            throw Object.assign(new Error("send rejected"), { data: { code: "E2EE_UPDATE_SENDER_KEY" } });
          },
        },
      },
    } as any;

    await expect(sendTalkMessage(client, { to: "u-peer", text: "hello" }))
      .rejects.toThrow("does not match the server's public key");

    expect(sendCalls).toBe(1);
  });
});


describe("LineJsAdapter reply relations", () => {
  test("only treats REPLY relations as quoted replies", () => {
    expect(replyTargetMessageId({ relatedMessageId: "631457091218833634", messageRelationType: 3 })).toBe("631457091218833634");
    expect(replyTargetMessageId({ message: { relatedMessageId: "square-1", messageRelationType: "REPLY" } })).toBe("square-1");
    expect(replyTargetMessageId({ relatedMessageId: "forwarded", messageRelationType: 0 })).toBeUndefined();
    expect(replyTargetMessageId({ relatedMessageId: "automatic", messageRelationType: "AUTO_REPLY" })).toBeUndefined();
    expect(replyTargetMessageId({ relatedMessageId: "legacy-without-type" })).toBeUndefined();
  });
});

describe("LineJsAdapter message edit state", () => {
  test("recognizes edit markers from live operations and fetched history", () => {
    expect(talkMessageEditState({ raw: { contentMetadata: { EDITED: "true", UPDATED_TIME: "1789230000123" } } })).toEqual({
      edited: true,
      updatedTime: 1789230000123,
    });
    expect(talkMessageEditState({ contentMetadata: { UPDATED_TIME: "1789230000456" } })).toEqual({
      edited: true,
      updatedTime: 1789230000456,
    });
    expect(talkMessageEditState({ contentMetadata: {} })).toEqual({ edited: false });
  });
});

describe("LineJsAdapter Talk read receipt", () => {
  test("uses a real reqSeq and preserves the full decimal message id", async () => {
    let request: unknown;
    const client = {
      base: {
        getReqseq: async () => 47,
        talk: {
          sendChatChecked: async (value: unknown) => { request = value; },
        },
      },
    } as any;

    await markTalkMessageRead(client, "c-room", "631457091218833634");
    expect(request).toEqual({
      chatMid: "c-room",
      lastMessageId: "631457091218833634",
      seq: 47,
    });
  });

  test("rejects optimistic ids before they reach Talk", async () => {
    const client = { base: { getReqseq: async () => 1, talk: { sendChatChecked: async () => undefined } } } as any;
    await expect(markTalkMessageRead(client, "u-peer", "local:123")).rejects.toThrow("not available yet");
  });
});

describe("LineJsAdapter read ranges", () => {
  test("normalizes LINEJS 3.4.2 raw `th` range entries without rounding message ids", () => {
    const normalized = normalizeTalkMessageReadRanges([{
      chatId: "c-room",
      ranges: {
        "u-a": {
          0: { 1: 631457091218833634n, 2: 631457091218833700n, 3: 1789209060138n, 4: 1789209069999n },
        },
        "u-b": [{ startMessageId: 631457091218833620n, endMessageId: 631457091218833650n, startTime: 10n, endTime: 20n }],
      },
    }]);

    expect(normalized).toEqual([{
      chatId: "c-room",
      ranges: {
        "u-a": [{
          startMessageId: "631457091218833634",
          endMessageId: "631457091218833700",
          startTime: 1789209060138,
          endTime: 1789209069999,
        }],
        "u-b": [{
          startMessageId: "631457091218833620",
          endMessageId: "631457091218833650",
          startTime: 10,
          endTime: 20,
        }],
      },
    }]);
  });

  test("deduplicates chats and calls getMessageReadRange with INTERNAL sync reason", async () => {
    let request: unknown;
    const client = {
      base: {
        talk: {
          getMessageReadRange: async (value: unknown) => {
            request = value;
            return [{ chatId: "u-peer", ranges: {} }];
          },
        },
      },
    } as any;

    await expect(getTalkMessageReadRanges(client, ["u-peer", "", "u-peer"])).resolves.toEqual([{ chatId: "u-peer", ranges: {} }]);
    expect(request).toEqual({ chatIds: ["u-peer"], syncReason: "INTERNAL" });
  });
});


describe("LINEJS compatibility floor", () => {
  test("tracks package.json and keeps the required upstream fixes", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const spec = String(packageJson.dependencies?.["@evex/linejs"] ?? "");
    const pinned = spec.match(/@jsr\/evex__linejs@(?:\^|~)?(\d+\.\d+\.\d+)/)?.[1];
    expect(pinned).toBe(LINEJS_VERSION);

    const [major, minor, patch] = LINEJS_VERSION.split(".").map(Number);
    expect(major > 3 || (major === 3 && (minor > 1 || (minor === 1 && patch >= 7)))).toBe(true);
  });

  test("keeps PLANET reply transaction correlation for T103 compatibility", () => {
    // The 3.4.2 local patch was absorbed upstream: 3.5.0 ships the same
    // PLANET reply correlation, so no patchedDependencies entry is needed.
    // This test pins the fix markers in the installed dependency instead.
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(packageJson.patchedDependencies?.["@jsr/evex__linejs@3.4.2"]).toBeUndefined();
    const transport = readFileSync(
      new URL("../../node_modules/@evex/linejs/client/features/call/planet/transport.js", import.meta.url),
      "utf8",
    );
    expect(transport).toContain("replyTo: request.message.hdr");
    expect(transport).toContain("#planetReplyHdr(msgId, request)");
    expect(transport).toContain("tranSeq: request.tranSeq");
    expect(transport).toContain("sessId: request.sessId?.length ? request.sessId : this.#sessId");

    const callModule = readFileSync(
      new URL("../../node_modules/@evex/linejs/client/features/call/mod.js", import.meta.url),
      "utf8",
    );
    expect(callModule).toContain("async answerIncoming(event, opts)");
    expect(callModule).toContain("verifyIncomingDetailed");
    expect(callModule).toContain("acceptIncomingDetailed");
  });
});

describe("LineJsAdapter own profile update validation", () => {
  test("forwards only supported fields and preserves boolean types", async () => {
    let received: unknown;
    const client = { updateMyProfile: async (update: unknown) => { received = update; } } as any;
    await updateOwnProfile(client, { displayName: "Liney", allowSearchByUserid: false, notSupported: "secret" });
    expect(received).toEqual({ displayName: "Liney", allowSearchByUserid: false });
  });
  test("rejects mismatched types and missing changes", async () => {
    const client = { updateMyProfile: async () => { throw new Error("should not be called"); } } as any;
    expect(() => updateOwnProfile(client, { allowSearchByEmail: "false" })).toThrow("Invalid profile field");
    expect(() => updateOwnProfile(client, {})).toThrow("No supported profile fields");
  });
});

describe("LineJsAdapter group metadata recovery", () => {
  test("uses one bounded getChats request without member enumeration", async () => {
    const requests: unknown[] = [];
    const client = {
      base: {
        talk: {
          getChats: async (options: unknown) => {
            requests.push(options);
            return { chats: [
              { chatMid: "c111", chatName: "กลุ่มทดสอบ", picturePath: "picture-hash" },
              { chatMid: "c222", chatName: "", picturePath: "" },
            ] };
          },
        },
      },
    } as never;
    const results = await getChatMetadataBatch(client, ["c111", "c222"]);
    expect(requests).toEqual([{ chatMids: ["c111", "c222"], withInvitees: false, withMembers: false }]);
    expect(results[0]).toEqual({
      mid: "c111", name: "กลุ่มทดสอบ", raw: { chatMid: "c111", chatName: "กลุ่มทดสอบ", picturePath: "picture-hash" },
    });
    expect(results[1].name).toBe("");
  });

  test("does not call LINE for empty group list", async () => {
    const result = await getChatMetadataBatch({} as never, []);
    expect(result).toEqual([]);
  });
});

// Regression: engine imports the LineJsAdapter facade, not named exports.
// All public methods used by engine/main.ts must be reachable via that facade.
describe("LineJsAdapter public facade contract", () => {
  test("exposes friend diagnostics, retry and group metadata batch at runtime", () => {
    expect(typeof LineJsAdapter.getFriendSyncDiagnostics).toBe("function");
    expect(typeof LineJsAdapter.retryMissingFriendProfiles).toBe("function");
    expect(typeof LineJsAdapter.getChatMetadataBatch).toBe("function");
  });
});
