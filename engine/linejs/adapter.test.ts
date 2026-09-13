import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fetchMessageAsset, getTalkMessageReadRanges, getTargetProfiles, LINEJS_VERSION, markTalkMessageRead, normalizeTalkMessageReadRanges, replyTargetMessageId, sendTalkMediaE2EE, talkMessageEditState } from "./adapter";

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
});
