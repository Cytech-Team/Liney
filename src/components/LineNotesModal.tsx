import { useCallback, useEffect, useState } from "react";
import { Heart, LoaderCircle, MessageCircle, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { lineyEngine } from "../lib/engine";
import { useAppTranslation } from "../lib/i18n";
import "./LineAlbumsModal.css";
import "./LineNotesModal.css";

type Note = {
  postId: string;
  homeId: string;
  text: string;
  author: string;
  canEdit: boolean;
  hasMedia?: boolean;
  likeCount?: number;
  commentCount?: number;
};
type NotesPage = { posts: Note[]; nextPostId?: string };

export function LineNotesModal({ homeId, title, onClose }: { homeId: string; title: string; onClose: () => void }) {
  const { t } = useAppTranslation();
  const [posts, setPosts] = useState<Note[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string>();
  const [commenting, setCommenting] = useState<string>();
  const [comment, setComment] = useState("");
  const [imageData, setImageData] = useState<string | null>(null);

  const load = useCallback(async (beforePostId?: string) => {
    setLoading(true);
    setError("");
    try {
      const page = await lineyEngine.request<NotesPage>("note.list", { homeId, ...(beforePostId ? { beforePostId } : {}) }, 30_000);
      setPosts((current) => beforePostId
        ? [...current, ...page.posts.filter((post) => !current.some((existing) => existing.postId === post.postId))]
        : page.posts);
      setCursor(page.nextPostId && page.nextPostId !== beforePostId ? page.nextPostId : undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [homeId]);

  useEffect(() => { void load(); }, [load]);

  async function mutate(method: string, params: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await lineyEngine.request(method, { homeId, ...params }, 30_000);
      setEditing(undefined);
      setCommenting(undefined);
      setComment("");
      setDraft("");
      setImageData(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function selectImage(file: File) {
    if (file.type !== "image/jpeg" || !file.size || file.size > 8 * 1024 * 1024) {
      setError(t("LINE Note รองรับภาพ JPEG ขนาดไม่เกิน 8 MB"));
      return;
    }
    try {
      const value = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(t("อ่านภาพไม่สำเร็จ")));
        reader.onerror = () => reject(reader.error ?? new Error(t("อ่านภาพไม่สำเร็จ")));
        reader.readAsDataURL(file);
      });
      setImageData(value);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return <div className="modal-backdrop liney-albums-backdrop" role="presentation" onMouseDown={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}>
    <section className="liney-albums-panel liney-notes-panel" role="dialog" aria-modal="true" aria-label={t("LINE Note of {{title}}", { title })}>
      <header className="liney-albums-head">
        <div><strong>LINE Note · {title}</strong><small>{t("โน้ตประจำห้อง · LINEJS")}</small></div>
        <button type="button" className="icon-button" aria-label={t("โหลดใหม่")} title={t("โหลดใหม่")} disabled={busy || loading} onClick={() => void load()}><RefreshCw size={18} /></button>
        <button type="button" className="icon-button" aria-label={t("ปิด")} onClick={onClose}><X size={18} /></button>
      </header>

      <div className="liney-notes-scroll">
        <form className="liney-notes-compose" onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim() && !busy) void mutate(editing ? "note.update" : "note.create", editing ? { postId: editing, text: draft } : { text: draft, ...(imageData ? { imageData } : {}) });
        }}>
          <label htmlFor="liney-note-draft">{editing ? t("แก้ไขโน้ต") : t("เขียนโน้ตใหม่")}</label>
          <textarea id="liney-note-draft" maxLength={10000} rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("เขียนข้อความลง Note ของกลุ่ม…")} disabled={busy} />
          {!editing && <label>{t("แนบรูป JPEG (ไม่เกิน 8 MB)")}
            <input type="file" accept="image/jpeg" disabled={busy} onChange={(event) => {
              const file = event.target.files?.[0];
              event.currentTarget.value = "";
              if (file) void selectImage(file);
            }}/>
          </label>}
          {imageData && !editing && <div>
            <img src={imageData} alt={t("รูปที่จะแนบใน Note")} style={{ maxWidth: 220, maxHeight: 150, objectFit: "contain" }}/>
            <button type="button" disabled={busy} onClick={() => setImageData(null)}>{t("ลบรูปแนบ")}</button>
          </div>}
          <div className="liney-notes-actions">
            {editing && <button type="button" disabled={busy} onClick={() => { setEditing(undefined); setDraft(""); setImageData(null); }}>{t("ยกเลิก")}</button>}
            <button type="submit" disabled={!draft.trim() || busy}><Plus size={15}/>{editing ? t("บันทึกการแก้ไข") : t("โพสต์โน้ต")}</button>
          </div>
        </form>

        {error && <p className="liney-albums-error" role="alert">{error}</p>}
        {loading && <p className="liney-albums-empty"><LoaderCircle size={16} /> {t("กำลังโหลดโน้ต…")}</p>}
        {!loading && !error && posts.length === 0 && <p className="liney-albums-empty">{t("ยังไม่มีโน้ตในกลุ่มนี้")}</p>}
        {posts.map((post) => <article key={post.postId} className="liney-note-card">
          <div className="liney-note-author"><strong>{post.author}</strong>{post.canEdit && <span>{t("โน้ตของคุณ")}</span>}</div>
          <p>{post.text || t("โน้ตที่ไม่มีข้อความ")}</p>
          <div className="liney-note-tools">
            <button type="button" disabled={busy} onClick={() => void mutate("note.like", { postId: post.postId })}><Heart size={15}/> {t("ถูกใจ")}{post.likeCount !== undefined ? ` · ${post.likeCount}` : ""}</button>
            <button type="button" disabled={busy} onClick={() => { setCommenting(commenting === post.postId ? undefined : post.postId); setComment(""); }}><MessageCircle size={15}/> {t("คอมเมนต์")}{post.commentCount !== undefined ? ` · ${post.commentCount}` : ""}</button>
            {post.canEdit && <>
              {!post.hasMedia && <button type="button" disabled={busy} onClick={() => { setEditing(post.postId); setDraft(post.text); setImageData(null); }}><Pencil size={15}/> {t("แก้ไข")}</button>}
              <button type="button" disabled={busy} onClick={() => { if (window.confirm(t("ลบโน้ตนี้จาก LINE สำหรับสมาชิกทุกคน?"))) void mutate("note.delete", { postId: post.postId }); }}><Trash2 size={15}/> {t("ลบ")}</button>
            </>}
          </div>
          {commenting === post.postId && <form className="liney-note-comment" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) void mutate("note.comment", { postId: post.postId, text: comment }); }}>
            <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={10000} placeholder={t("เขียนความคิดเห็น…")} disabled={busy}/>
            <button type="submit" disabled={!comment.trim() || busy}>{t("ส่ง")}</button>
          </form>}
        </article>)}
        {cursor && <button type="button" className="liney-albums-more" disabled={busy || loading} onClick={() => void load(cursor)}>{t("โหลดโน้ตเก่าเพิ่มเติม")}</button>}
      </div>
    </section>
  </div>;
}
