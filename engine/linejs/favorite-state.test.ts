import { describe, expect, test } from "bun:test";
import { resolveFavoriteTime } from "./favorite-state";

describe("favorite state reconciliation", () => {
  test("preserves cached favorite when remote profile omits favoriteTime", () => {
    expect(resolveFavoriteTime(undefined, 1712345678)).toBe(1712345678);
    expect(resolveFavoriteTime(null, 1712345678)).toBe(1712345678);
  });
  test("accepts explicit remote unfavorite", () => {
    expect(resolveFavoriteTime(0, 1712345678)).toBe(0);
    expect(resolveFavoriteTime("0", 1712345678)).toBe(0);
  });
  test("uses remote favorite timestamp when present", () => {
    expect(resolveFavoriteTime(1719999999, 1712345678)).toBe(1719999999);
  });
  test("normalizes invalid values safely", () => {
    expect(resolveFavoriteTime("invalid", 1712345678)).toBe(0);
    expect(resolveFavoriteTime(undefined, undefined)).toBe(0);
  });
});
