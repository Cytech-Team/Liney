export type TalkMessageBoxLike = {
  id?: unknown;
  lastMessages?: unknown[];
};

export function talkMessageBoxId(box?: TalkMessageBoxLike): string {
  return typeof box?.id === "string" ? box.id : String(box?.id ?? "");
}

export function talkMessageBoxHasHistory(box: TalkMessageBoxLike): boolean {
  return Array.isArray(box.lastMessages) && box.lastMessages.length > 0;
}

export function additionalTalkHistoryBoxIds(
  joinedChatIds: readonly string[],
  boxes: readonly TalkMessageBoxLike[],
): string[] {
  const joined = new Set(joinedChatIds);
  return [...new Set(
    boxes
      .filter(talkMessageBoxHasHistory)
      .map(talkMessageBoxId)
      .filter((id) => Boolean(id) && !joined.has(id)),
  )];
}
