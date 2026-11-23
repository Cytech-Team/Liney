export type ParsedChatEvent = {
  key: string;
  args: string[];
};

export type ChatEventNameResolver = (value: string) => string;

const MID = /^[ucr][0-9a-f]{32}$/i;

export function isChatEventMid(value: string): boolean {
  return MID.test(value);
}

export function parseChatEvent(raw: any): ParsedChatEvent | undefined {
  const metadata = raw?.contentMetadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const key = String(metadata.LOC_KEY ?? metadata.locKey ?? "").trim().toUpperCase();
  if (!key) return undefined;
  const rawArgs = metadata.LOC_ARGS ?? metadata.locArgs;
  const args = Array.isArray(rawArgs)
    ? rawArgs.map((value) => String(value).trim()).filter(Boolean)
    : String(rawArgs ?? "")
      .split("\u001e")
      .map((value) => value.trim())
      .filter(Boolean);
  return { key, args };
}

export function chatEventMids(event: ParsedChatEvent | undefined): string[] {
  return (event?.args ?? []).filter(isChatEventMid);
}

/**
 * LINE emits chat activity as CHATEVENT with a localization key. The keys
 * below are the activity keys Liney has observed; unknown keys still expose
 * their LOC_ARGS so a new server-side event does not collapse back to the
 * generic "กิจกรรมในแชต" label.
 */
export type ChatEventContext = {
  selfMid?: string;
  senderMid?: string;
  senderName?: string;
};

export function formatChatEvent(
  event: ParsedChatEvent | undefined,
  nameFor: ChatEventNameResolver,
  context: ChatEventContext = {},
): string {
  if (!event) return "กิจกรรมในแชต";
  const name = (value: string | undefined): string => {
    const text = String(value ?? "").trim();
    if (!text) return "สมาชิก";
    if (isChatEventMid(text)) {
      if (context.selfMid && text === context.selfMid) return "คุณ";
      if (context.senderMid && text === context.senderMid && context.senderName) {
        return context.senderName;
      }
      return nameFor(text) || "สมาชิก";
    }
    return text;
  };
  const actor = event.args[0] || context.senderMid;
  const [first, second, ...rest] = event.args;
  switch (event.key) {
    case "C_MI":
      return `${name(actor)} เพิ่ม ${name(second)} เข้ากลุ่ม`;
    case "C_MJ":
      return `${name(actor)} เข้าร่วมกลุ่ม`;
    case "C_ML":
      return `${name(actor)} ออกจากกลุ่ม`;
    case "C_MR":
      return `${name(actor)} ลบ ${name(second)} ออกจากกลุ่ม`;
    case "C_PI":
      return `${name(actor)} เปลี่ยนรูปกลุ่ม`;
    case "C_PN":
      return `${name(actor)} เปลี่ยนชื่อกลุ่มเป็น “${name(second)}”`;
    case "BO":
      // LINE uses BO for free-form activity text (for example a class
      // worksheet or announcement), so preserve the text instead of hiding it.
      return name(first) || "กิจกรรมในแชต";
    default: {
      const values = [first, second, ...rest].filter(Boolean).map(name);
      if (!values.length) return "กิจกรรมในแชต";
      return `กิจกรรมในแชต: ${values.join(" · ")}`;
    }
  }
}

export function chatEventText(
  raw: any,
  nameFor: ChatEventNameResolver,
  context: ChatEventContext = {},
): string {
  return formatChatEvent(parseChatEvent(raw), nameFor, context);
}
