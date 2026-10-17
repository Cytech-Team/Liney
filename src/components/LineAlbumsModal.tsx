import { useEffect, useState } from "react";
import { AlbumThumbnail } from "./AlbumThumbnail";
import { AlbumThumbnailLoader } from "../lib/album-thumbnail-loader";
import { Image as ImageIcon, LoaderCircle, X, ArrowLeft } from "lucide-react";
import { lineyEngine } from "../lib/engine";
import "./LineAlbumsModal.css";

type Album = {
  albumId: string;
  chatId: string;
  title: string;
  photoCount: number;
};
type AlbumPage = { albums: Album[]; nextCursor?: string; hasMore: boolean };
type AlbumPhoto = { id: string; oid: string; resourceType: string; sid: string };
type PhotoPage = { photos: AlbumPhoto[]; nextCursor?: string };
type PhotoPreview = { dataUrl: string; bytes: number };

export function LineAlbumsModal({ onClose }: { onClose: () => void }) {
  const [albums, setAlbums] = useState<Album[]>([]);
  const [albumCursor, setAlbumCursor] = useState<string>();
  const [selected, setSelected] = useState<Album>();
  const [photos, setPhotos] = useState<AlbumPhoto[]>([]);
  const [photoCursor, setPhotoCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ photo: AlbumPhoto; dataUrl: string }>();
  const [previewLoading, setPreviewLoading] = useState<string>();
  const [thumbnailLoader] = useState(() => new AlbumThumbnailLoader());

  useEffect(() => {
    let valid = true;
    void lineyEngine.request<AlbumPage>("album.list", {}, 30_000).then((page) => {
      if (!valid) return;
      setAlbums(Array.isArray(page.albums) ? page.albums : []);
      setAlbumCursor(page.nextCursor);
    }).catch((e: unknown) => {
      if (valid) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (valid) setLoading(false); });
    return () => { valid = false; };
  }, []);

  useEffect(() => {
    if (!selected) return;
    let valid = true;
    void lineyEngine.request<PhotoPage>("album.photos", {
      chatId: selected.chatId, albumId: selected.albumId,
    }, 30_000).then((page) => {
      if (!valid) return;
      setPhotos(Array.isArray(page.photos) ? page.photos : []);
      setPhotoCursor(page.nextCursor);
    }).catch((e: unknown) => {
      if (valid) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (valid) setLoading(false); });
    return () => { valid = false; };
  }, [selected]);

  async function loadMore() {
    if (loading || moreLoading) return;
    setMoreLoading(true);
    setError("");
    try {
      if (selected && photoCursor) {
        const page = await lineyEngine.request<PhotoPage>("album.photos", {
          chatId: selected.chatId, albumId: selected.albumId, cursor: photoCursor,
        }, 30_000);
        setPhotos((current) => [...current, ...(page.photos ?? [])]);
        setPhotoCursor(page.nextCursor === photoCursor ? undefined : page.nextCursor);
      } else if (!selected && albumCursor) {
        const page = await lineyEngine.request<AlbumPage>("album.list", { cursor: albumCursor }, 30_000);
        setAlbums((current) => [...current, ...(page.albums ?? [])]);
        setAlbumCursor(page.nextCursor === albumCursor ? undefined : page.nextCursor);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoreLoading(false);
    }
  }

  async function openPhoto(photo: AlbumPhoto) {
    if (!selected || photo.sid === "v" || /video/i.test(photo.resourceType)) return;
    setPreviewLoading(photo.id);
    setError("");
    try {
      const result = await lineyEngine.request<PhotoPreview>("album.photo.preview", {
        chatId: selected.chatId, albumId: selected.albumId, oid: photo.oid,
      }, 40_000);
      setPreview({ photo, dataUrl: result.dataUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewLoading(undefined);
    }
  }

  return (
    <div className="modal-backdrop liney-albums-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="liney-albums-panel" role="dialog" aria-modal="true" aria-label="อัลบั้ม LINE">
        <header className="liney-albums-head">
          {selected ? (
            <button type="button" className="icon-button" onClick={() => {
              setSelected(undefined); setPhotos([]); setError(""); setPreview(undefined); setLoading(false);
            }} aria-label="กลับไปยังรายการอัลบั้ม"><ArrowLeft size={18}/></button>
          ) : <ImageIcon size={20} />}
          <div>
            <strong>{selected?.title ?? "อัลบั้ม LINE"}</strong>
            <small>{selected ? `รูปในอัลบั้ม · ${photos.length} รายการ` : "อัลบั้มทั้งหมดของบัญชี · อ่านอย่างเดียว"}</small>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="ปิดอัลบั้ม"><X size={19}/></button>
        </header>
        {error ? <p role="alert" className="liney-albums-error">{error}</p> : null}
        {loading ? <div className="liney-albums-empty"><LoaderCircle className="spin" size={22}/> กำลังโหลด…</div> : null}
        {!loading && !selected && albums.length === 0 && !error ? <p className="liney-albums-empty">ไม่มีอัลบั้มหรือบัญชีนี้ไม่รองรับบริการ Album</p> : null}
        {!loading && !selected ? (
          <div className="liney-albums-list">
            {albums.map((album) => (
              <button className="liney-albums-item" type="button" key={`${album.chatId}:${album.albumId}`} onClick={() => { setSelected(album); setLoading(true); setError(""); setPhotos([]); setPhotoCursor(undefined); setPreview(undefined); }}>
                {album.photoCount > 0
                  ? <AlbumThumbnail
                      loader={thumbnailLoader}
                      cacheKey={`cover:${album.chatId}:${album.albumId}`}
                      request={{ method: "album.cover.preview", params: { chatId: album.chatId, albumId: album.albumId } }}
                      className="liney-albums-cover" alt={`ภาพปก ${album.title}`}
                    />
                  : <span className="liney-albums-cover"><ImageIcon aria-hidden="true" size={21}/></span>}
                <span><strong>{album.title}</strong><small>รูป {album.photoCount} · ห้อง {album.chatId.slice(0, 10)}…</small></span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          </div>
        ) : null}
        {!loading && selected ? (
          <div className="liney-albums-photo-list">
            {photos.length === 0 && !error ? <p className="liney-albums-empty">ไม่พบรูปภาพในอัลบั้มนี้</p> : null}
            {photos.map((photo) => {
              const video = photo.sid === "v" || /video/i.test(photo.resourceType);
              return (
                <button key={photo.id} type="button" className="liney-albums-photo" disabled={video || Boolean(previewLoading)} onClick={() => void openPhoto(photo)}>
                  {video
                    ? <span className="liney-albums-photo-thumb"><ImageIcon aria-hidden="true" size={22}/></span>
                    : <AlbumThumbnail
                        loader={thumbnailLoader}
                        cacheKey={`photo:${selected.chatId}:${selected.albumId}:${photo.oid}`}
                        request={{ method: "album.photo.preview", params: { chatId: selected.chatId, albumId: selected.albumId, oid: photo.oid } }}
                        className="liney-albums-photo-thumb" alt={`ภาพย่อรูป ${photo.id}`}
                      />}
                  <small>{video ? "วิดีโอ (ยังไม่มีพรีวิว)" : previewLoading === photo.id ? "กำลังโหลด…" : `รูป ${photo.id}`}</small>
                </button>
              );
            })}
          </div>
        ) : null}
        {!loading && (selected ? photoCursor : albumCursor) ? (
          <button className="liney-albums-more" disabled={moreLoading} type="button" onClick={() => void loadMore()}>
            {moreLoading ? "กำลังโหลด…" : "โหลดเพิ่มเติม"}
          </button>
        ) : null}
        {preview ? (
          <div className="liney-albums-preview" role="dialog" aria-modal="true" aria-label="ดูรูปภาพ" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(undefined);
          }}>
            <button type="button" className="icon-button" onClick={() => setPreview(undefined)} aria-label="ปิดรูป"><X size={20}/></button>
            <img src={preview.dataUrl} alt={`รูปภาพ ${preview.photo.id}`} />
          </div>
        ) : null}
      </section>
    </div>
  );
}
