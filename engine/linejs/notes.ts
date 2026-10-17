import type { Client } from "@evex/linejs";
import { decodeProfileImage } from "./profile-media";

export type NotePost = {
  postId: string;
  homeId: string;
  text: string;
  author: string;
  createdTime?: number;
  likeCount?: number;
  commentCount?: number;
  canEdit: boolean;
  hasMedia: boolean;
};

type NoteResponse = { code?: number; message?: string; result?: unknown };
type TimelineApi = Pick<Client["base"]["timeline"], "listPost" | "getPost" | "createPost" | "updatePost" | "deletePost" | "likePost" | "createComment" | "uploadNoteMedia">;
type NoteClient = { base: { timeline: TimelineApi; profile?: { mid?: string } } };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function noteRoomId(homeId: unknown): string {
  if (typeof homeId !== "string" || !/^[cs][a-f0-9]{30,}$/i.test(homeId)) {
    throw new TypeError("Notes require a LINE group/OpenChat room ID");
  }
  return homeId;
}

export function notePostId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new TypeError("Invalid Note post ID");
  }
  return value;
}

function noteText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 10000) {
    throw new TypeError("Note text must contain 1–10000 characters");
  }
  return value.trim();
}

function checkedResponse(response: NoteResponse): Record<string, unknown> {
  if (response.code !== undefined && ![0, 200].includes(response.code)) {
    throw new Error(response.message || `LINE Note failed (code ${response.code})`);
  }
  return object(response.result);
}

function projectPost(value: unknown, homeId: string, selfMid?: string): NotePost | null {
  const record = object(value);
  const info = object(record.postInfo);
  const content = object(record.contents);
  const writer = object(info.writer);
  const postId = String(info.postId ?? record.postId ?? "");
  if (!postId) return null;
  const created = Number(info.createdTime ?? record.createdTime);
  const likes = Number(info.likeCount ?? record.likeCount);
  const comments = Number(info.commentCount ?? record.commentCount);
  const writerMid = String(info.writerMid ?? info.authorMid ?? writer.mid ?? record.writerMid ?? "");
  return {
    postId,
    homeId,
    text: String(content.text ?? record.text ?? ""),
    author: String(info.writerName ?? writer.displayName ?? record.writerName ?? writerMid ?? "สมาชิก"),
    ...(Number.isFinite(created) ? { createdTime: created } : {}),
    ...(Number.isFinite(likes) ? { likeCount: likes } : {}),
    ...(Number.isFinite(comments) ? { commentCount: comments } : {}),
    canEdit: Boolean(selfMid && writerMid && selfMid === writerMid),
    hasMedia: Array.isArray(content.media) && content.media.length > 0,
  };
}

export function projectNoteList(result: unknown, homeId: string, selfMid?: string): { posts: NotePost[]; nextPostId?: string; updatedTime?: number } {
  const data = object(result);
  const candidate = [data.posts, data.postList, data.homePosts, object(data.homePostList).posts, object(data.timeline).posts].find(Array.isArray);
  if (!candidate) {
    throw new Error("Unsupported LINE Note response format");
  }
  const posts = (candidate as unknown[]).map((item) => projectPost(item, homeId, selfMid)).filter((item): item is NotePost => item !== null);
  const next = String(data.nextPostId ?? data.nextCursor ?? "");
  const updatedTime = Number(data.updatedTime);
  return {
    posts,
    ...(next ? { nextPostId: next } : {}),
    ...(Number.isFinite(updatedTime) && updatedTime > 0 ? { updatedTime } : {}),
  };
}

export async function listNotes(client: NoteClient, homeId: string, postId?: string) {
  const room = noteRoomId(homeId);
  const result = checkedResponse(await client.base.timeline.listPost({
    homeId: room,
    ...(postId ? { postId: notePostId(postId) } : {}),
    sourceType: "TALKROOM",
  }));
  return projectNoteList(result, room, client.base.profile?.mid);
}

export async function getNote(client: NoteClient, homeId: string, postId: string) {
  const room = noteRoomId(homeId);
  const result = checkedResponse(await client.base.timeline.getPost({ homeId: room, postId: notePostId(postId) }));
  const post = projectPost(result.post ?? result, room, client.base.profile?.mid);
  if (!post) throw new Error("LINE did not return a Note post");
  return post;
}

export async function createNote(client: NoteClient, homeId: string, text: string, imageData?: unknown) {
  const room = noteRoomId(homeId);
  const validatedText = noteText(text);
  let media: { mediaObjectIds: string[]; mediaObjectTypes: string[] } | undefined;
  if (imageData !== undefined && imageData !== null) {
    const { bytes, mime } = decodeProfileImage(imageData);
    if (mime !== "image/jpeg") throw new TypeError("LINE Note image upload requires JPEG");
    const upload = await client.base.timeline.uploadNoteMedia("image", new Blob([new Uint8Array(bytes)], { type: mime }));
    if (!upload.objId) throw new Error("LINE did not return the Note media object ID");
    media = { mediaObjectIds: [upload.objId], mediaObjectTypes: ["PHOTO"] };
  }
  const response = await client.base.timeline.createPost({
    homeId: room, text: validatedText, sourceType: "TALKROOM",
    readPermissionType: "GROUP", readPermissionGids: [room], ...media,
  });
  return checkedResponse(response);
}

export async function updateNote(client: NoteClient, homeId: string, postId: string, text: string) {
  return checkedResponse(await client.base.timeline.updatePost({
    homeId: noteRoomId(homeId), postId: notePostId(postId), text: noteText(text),
  }));
}

export async function deleteNote(client: NoteClient, homeId: string, postId: string) {
  return checkedResponse(await client.base.timeline.deletePost({
    homeId: noteRoomId(homeId), postId: notePostId(postId),
  }));
}

export async function likeNote(client: NoteClient, homeId: string, postId: string) {
  return checkedResponse(await client.base.timeline.likePost({
    homeId: noteRoomId(homeId), contentId: notePostId(postId), sourceType: "TALKROOM",
  }));
}

export async function commentNote(client: NoteClient, homeId: string, postId: string, text: string) {
  return checkedResponse(await client.base.timeline.createComment({
    homeId: noteRoomId(homeId), contentId: notePostId(postId), commentText: noteText(text), sourceType: "TALKROOM",
  }));
}
