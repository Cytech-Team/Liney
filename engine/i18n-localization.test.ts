import { describe, expect, test } from "bun:test";
import { translateText } from "../src/lib/i18n";

describe("UI translations", () => {
  test("keeps Thai text in Thai mode", () => {
    expect(translateText("th", "เริ่มแชตใหม่")).toBe("เริ่มแชตใหม่");
  });

  test("translates common chat navigation labels", () => {
    expect(translateText("en", "เพื่อน")).toBe("Friends");
    expect(translateText("en", "รายการโปรด")).toBe("Favorites");
  });

  test("interpolates values after translation", () => {
    expect(translateText("en", "แสดงกลุ่มเก่า ({{count}})", { count: 12 })).toBe("Show archived groups (12)");
  });

  test("preserves user-provided text without a translation entry", () => {
    const userText = "ชื่อเพื่อนที่ผู้ใช้ตั้งเอง";
    expect(translateText("en", userText)).toBe(userText);
  });
});
