import { describe, expect, test } from "bun:test";
import { isLikelyBotChat } from "../src/lib/chat-bot";

describe("bot chat heuristic", () => {
  test("trusts the engine Official Account flag", () => {
    expect(isLikelyBotChat({ kind: "dm", name: "Anything", isOfficialAccount: true })).toBe(true);
  });

  test("recognises LINE-branded and common Thai Official Accounts", () => {
    expect(isLikelyBotChat({ kind: "dm", name: "LINE TODAY" })).toBe(true);
    expect(isLikelyBotChat({ kind: "dm", name: "LINE TODAY WEALTH" })).toBe(true);
    expect(isLikelyBotChat({ kind: "dm", name: "Thailand Post" })).toBe(true);
    expect(isLikelyBotChat({ kind: "dm", name: "Krungthai Connect" })).toBe(true);
    expect(isLikelyBotChat({ kind: "dm", name: "บิงช์ TODAY" })).toBe(true);
    expect(isLikelyBotChat({ kind: "dm", name: "บันเทิง TODAY" })).toBe(true);
    expect(isLikelyBotChat({ kind: "dm", name: "KBank Live" })).toBe(true);
  });

  test("does not classify normal friends or groups", () => {
    expect(isLikelyBotChat({ kind: "dm", name: "Mimie Picha" })).toBe(false);
    expect(isLikelyBotChat({ kind: "group", name: "LINE TODAY" })).toBe(false);
  });
});
