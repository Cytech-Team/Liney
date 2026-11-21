import { describe, expect, test } from "bun:test";
import { parseMessageMentions } from "../src/lib/mentions";

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

  test("ignores missing or malformed metadata", () => {
    expect(parseMessageMentions("hi", null)).toEqual([]);
    expect(parseMessageMentions("hi", { contentMetadata: { MENTION: "{oops" } })).toEqual([]);
    expect(parseMessageMentions("hi", { contentMetadata: { MENTION: { MENTIONEES: "nope" } } })).toEqual([]);
  });
});
