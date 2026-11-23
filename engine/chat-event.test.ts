import { describe, expect, test } from "bun:test";
import { formatChatEvent, parseChatEvent } from "./chat-event";

const INVITER = "ubeee2770a00093f96c32e41d2c4055c3";
const INVITEE = "ud59ef20aa473f364ad9c8d495bc4a2f7";
const names: Record<string, string> = {
  [INVITER]: "Poon 3",
  [INVITEE]: "นัท",
};

function raw(key: string, args: string) {
  return { contentMetadata: { LOC_KEY: key, LOC_ARGS: args } };
}

const resolve = (mid: string) => names[mid] ?? "";

describe("LINE chat events", () => {
  test("parses the metadata separator", () => {
    expect(parseChatEvent(raw("C_MI", `${INVITER}\u001e${INVITEE}`))).toEqual({
      key: "C_MI",
      args: [INVITER, INVITEE],
    });
  });

  test("formats invite, join, leave, remove, picture and name activity", () => {
    expect(formatChatEvent(parseChatEvent(raw("C_MI", `${INVITER}\u001e${INVITEE}`)), resolve)).toBe(
      "Poon 3 เพิ่ม นัท เข้ากลุ่ม",
    );
    expect(formatChatEvent(parseChatEvent(raw("C_MJ", INVITEE)), resolve)).toBe("นัท เข้าร่วมกลุ่ม");
    expect(formatChatEvent(parseChatEvent(raw("C_ML", INVITEE)), resolve)).toBe("นัท ออกจากกลุ่ม");
    expect(formatChatEvent(parseChatEvent(raw("C_MR", `${INVITER}\u001e${INVITEE}`)), resolve)).toBe(
      "Poon 3 ลบ นัท ออกจากกลุ่ม",
    );
    expect(formatChatEvent(parseChatEvent(raw("C_PI", INVITER)), resolve)).toBe("Poon 3 เปลี่ยนรูปกลุ่ม");
    expect(formatChatEvent(parseChatEvent(raw("C_PN", `${INVITER}\u001e1/1 (ปี69)`)), resolve)).toBe(
      "Poon 3 เปลี่ยนชื่อกลุ่มเป็น “1/1 (ปี69)”",
    );
  });

  test("preserves free-form BO activity text", () => {
    expect(formatChatEvent(parseChatEvent(raw("BO", "ใบงานประวัติวอลเลย์บอล")), resolve)).toBe(
      "ใบงานประวัติวอลเลย์บอล",
    );
  });

  test("never collapses an unknown event back to the generic label", () => {
    expect(formatChatEvent(parseChatEvent(raw("C_XX", `${INVITER}\u001e${INVITEE}`)), resolve)).toBe(
      "กิจกรรมในแชต: Poon 3 · นัท",
    );
    expect(formatChatEvent(parseChatEvent(raw("C_XX", "ข้อความใหม่")), resolve)).toBe(
      "กิจกรรมในแชต: ข้อความใหม่",
    );
  });

  test("uses the event sender as a fallback actor and handles missing args", () => {
    expect(formatChatEvent(parseChatEvent(raw("C_MI", "")), resolve, {
      senderMid: INVITER,
      senderName: "Poon 3",
    })).toBe("Poon 3 เพิ่ม สมาชิก เข้ากลุ่ม");
    expect(formatChatEvent(undefined, resolve)).toBe("กิจกรรมในแชต");
  });
});
