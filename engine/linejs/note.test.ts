import { describe, expect, test } from "bun:test";
import {
  noteRoomId, notePostId, projectNoteList, listNotes, createNote, updateNote, deleteNote, likeNote, commentNote,
} from "./notes";

const room = `c${"a".repeat(32)}`;
function fakeClient() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const timeline = Object.fromEntries(["listPost", "getPost", "createPost", "updatePost", "deletePost", "likePost", "createComment", "uploadNoteMedia"].map((method) => [
    method, async (params: unknown) => {
      calls.push({ method, params });
      return { code: 200, result: method === "listPost" ? { posts: [{ postInfo: { postId: "post-1", writerMid: "u-self", likeCount: 4 }, contents: { text: "hello" } }] } : {} };
    },
  ]));
  return { client: { base: { timeline, profile: { mid: "u-self" } } } as any, calls };
}

describe("LINE Note operations", () => {
  test("accepts group and square MIDs, rejects direct messages and invalid IDs", () => {
    expect(noteRoomId(room)).toBe(room);
    expect(noteRoomId(`s${"a".repeat(32)}`)).toStartWith("s");
    expect(() => noteRoomId(`u${"a".repeat(32)}`)).toThrow();
    expect(() => noteRoomId("../bad")).toThrow();
    expect(() => notePostId("../../hello")).toThrow();
  });

  test("lists sanitized Note posts in the selected room", async () => {
    const { client, calls } = fakeClient();
    const result = await listNotes(client, room);
    expect(result.posts).toEqual([{ postId: "post-1", homeId: room, text: "hello", author: "u-self", likeCount: 4, canEdit: true, hasMedia: false }]);
    expect(calls[0]).toEqual({ method: "listPost", params: { homeId: room, sourceType: "TALKROOM" } });
  });

  test("creates Note with group-only read permissions", async () => {
    const { client, calls } = fakeClient();
    await createNote(client, room, " hello ");
    expect(calls[0]).toEqual({ method: "createPost", params: {
      homeId: room, text: "hello", sourceType: "TALKROOM", readPermissionType: "GROUP", readPermissionGids: [room],
    } });
    await expect(createNote(client, room, "")).rejects.toThrow();
    await expect(createNote(client, room, "x".repeat(10001))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("uploads Note JPEG through LINEJS OBS before creating post", async () => {
    const { client, calls } = fakeClient();
    client.base.timeline.uploadNoteMedia = async (type: string, data: Blob) => {
      calls.push({ method: "uploadNoteMedia", params: { type, size: data.size } });
      return { objId: "test-photo", objHash: "hash" };
    };
    const jpeg = Buffer.from([255,216,255,224,0,0]);
    await createNote(client, room, "image note", `data:image/jpeg;base64,${jpeg.toString("base64")}` as never);
    expect(calls[0]).toEqual({ method: "uploadNoteMedia", params: { type: "image", size: jpeg.length } });
    expect(calls[1].params).toMatchObject({ mediaObjectIds: ["test-photo"], mediaObjectTypes: ["PHOTO"] });
    const png = Buffer.from([137,80,78,71,13,10,26,10]);
    await expect(createNote(client, room, "image note", `data:image/png;base64,${png.toString("base64")}`)).rejects.toThrow("requires JPEG");
  });

  test("routes edit, delete, like, comment to same room", async () => {
    const { client, calls } = fakeClient();
    await updateNote(client, room, "post-1", "updated");
    await deleteNote(client, room, "post-1");
    await likeNote(client, room, "post-1");
    await commentNote(client, room, "post-1", "comment");
    expect(calls.map((call) => call.method)).toEqual(["updatePost", "deletePost", "likePost", "createComment"]);
    expect(calls[2].params).toMatchObject({ homeId: room, contentId: "post-1", sourceType: "TALKROOM" });
    expect(calls[3].params).toMatchObject({ homeId: room, contentId: "post-1", commentText: "comment" });
  });

  test("never treats incompatible response formats as successful empty feed", () => {
    expect(() => projectNoteList({ other: [] }, room)).toThrow("Unsupported LINE Note response");
  });
});
