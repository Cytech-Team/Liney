import { describe, expect, test } from "bun:test";
import { buildMentionMetadata, mentionQueryAt, parseMessageMentions } from "../src/lib/mentions";

describe("parseMessageMentions", () => {
  test("parses user mentions from a JSON string", () => {
    const raw = {
      contentMetadata: {
        MENTION: JSON.stringify({
          MENTIONEES: [{ S: "0", E: "11", M: "ub46aa22432a3b1193799b77c8e3bcd38" }],
        }),
      },
    };
    expect(parseMessageMentions("@YCS (Hong) hello", raw)).toEqual([
      { start: 0, end: 11, mid: "ub46aa22432a3b1193799b77c8e3bcd38" },
    ]);
  });

  test("keeps @All without a mid and drops invalid ranges", () => {
    const raw = {
      contentMetadata: {
        MENTION: {
          MENTIONEES: [
            { S: "0", E: "4", A: "1" },
            { S: "10", E: "2", M: "u294b828c79c5fa249e323313c97acd92" },
            { S: "0", E: "999" },
          ],
        },
      },
    };
    expect(parseMessageMentions("@All hi", raw)).toEqual([{ start: 0, end: 4 }]);
  });

  test("accepts a raw payload stored as a JSON string", () => {
    const raw = JSON.stringify({
      contentMetadata: { MENTION: JSON.stringify({ MENTIONEES: [{ S: "0", E: "2", M: "p154af4ad93902543508309f37c194637" }] }) },
    });
    expect(parseMessageMentions("@x hi", raw)).toEqual([
      { start: 0, end: 2, mid: "p154af4ad93902543508309f37c194637" },
    ]);
  });

  test("ignores missing or malformed metadata", () => {
    expect(parseMessageMentions("hi", null)).toEqual([]);
    expect(parseMessageMentions("hi", { contentMetadata: { MENTION: "{oops" } })).toEqual([]);
    expect(parseMessageMentions("hi", { contentMetadata: { MENTION: { MENTIONEES: "nope" } } })).toEqual([]);
  });
});

describe("buildMentionMetadata", () => {
  const alice = "ub46aa22432a3b1193799b77c8e3bcd38";
  const anna = "u294b828c79c5fa249e323313c97acd92";

  test("resolves @Name tokens in an outgoing message to member mids", () => {
    const metadata = buildMentionMetadata("hey @Alice how are you", [{ mid: alice, name: "Alice" }]);
    expect(metadata).toBeDefined();
    const raw = { contentMetadata: metadata };
    expect(parseMessageMentions("hey @Alice how are you", raw)).toEqual([
      { start: 4, end: 10, mid: alice },
    ]);
  });

  test("prefers the longest name and ignores partial matches", () => {
    const metadata = buildMentionMetadata("@Anna and @Ann", [
      { mid: alice, name: "Ann" },
      { mid: anna, name: "Anna" },
    ]);
    expect(parseMessageMentions("@Anna and @Ann", { contentMetadata: metadata })).toEqual([
      { start: 0, end: 5, mid: anna },
      { start: 10, end: 14, mid: alice },
    ]);
  });

  test("tags every occurrence and supports UTF-16 offsets", () => {
    const metadata = buildMentionMetadata("👍 @นัท @นัท", [{ mid: alice, name: "นัท" }]);
    expect(parseMessageMentions("👍 @นัท @นัท", { contentMetadata: metadata })).toEqual([
      { start: 3, end: 7, mid: alice },
      { start: 8, end: 12, mid: alice },
    ]);
  });

  test("tags Thai text typed without a space before @", () => {
    const text = "สวัสดี@นัท";
    const metadata = buildMentionMetadata(text, [{ mid: alice, name: "นัท" }]);
    expect(parseMessageMentions(text, { contentMetadata: metadata })).toEqual([
      { start: 6, end: 10, mid: alice },
    ]);
  });

  test("ignores names that are missing, glued to other words, or not members", () => {
    expect(buildMentionMetadata("hello", [{ mid: alice, name: "Alice" }])).toBeUndefined();
    expect(buildMentionMetadata("email@Alice", [{ mid: alice, name: "Alice" }])).toBeUndefined();
    expect(buildMentionMetadata("@Alice2", [{ mid: alice, name: "Alice" }])).toBeUndefined();
    expect(buildMentionMetadata("@Alice", [{ mid: "invalid", name: "Alice" }])).toBeUndefined();
    expect(buildMentionMetadata("@Alice", [])).toBeUndefined();
  });
});

describe("mentionQueryAt", () => {
  test("opens on @ and keeps the query while typing", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("hi @Som", 7)).toEqual({ start: 3, query: "Som" });
    expect(mentionQueryAt("hi @Som there", 7)).toEqual({ start: 3, query: "Som" });
    expect(mentionQueryAt("(@Som", 5)).toEqual({ start: 1, query: "Som" });
    expect(mentionQueryAt("สวัสดี @นัท", 11)).toEqual({ start: 7, query: "นัท" });
    expect(mentionQueryAt("สวัสดี@นัท", 10)).toEqual({ start: 6, query: "นัท" });
  });

  test("stops at spaces, double @ and behind the caret", () => {
    expect(mentionQueryAt("a@b", 3)).toEqual({ start: 1, query: "b" });
    expect(mentionQueryAt("hi @Som chai", 12)).toBeNull();
    expect(mentionQueryAt("hi @Som", 3)).toBeNull();
    expect(mentionQueryAt("hello", 5)).toBeNull();
    expect(mentionQueryAt("@@", 2)).toBeNull();
  });
});
