import { useEffect, useRef, useState } from "react";
import { Camera, Check, CircleAlert, LoaderCircle, RotateCcw, Save, ShieldCheck, UserRound } from "lucide-react";
import { lineyEngine } from "../lib/engine";
import { RemoteImage } from "./RemoteImage";
import "./LineWorkspacePolish.css";

export type EditableLineProfile = {
  mid?: string;
  displayName?: string;
  statusMessage?: string;
  pictureUrl?: string;
  avatarUrl?: string;
  pictureStatus?: string;
  picturePath?: string;
};

function imageSource(profile: EditableLineProfile | null): string | undefined {
  if (!profile) return undefined;
  const direct = [profile.pictureUrl, profile.avatarUrl, profile.picturePath]
    .find((raw) => typeof raw === "string" && /^https:\/\//i.test(raw));
  if (direct) return direct;
  const path = profile.picturePath?.trim();
  if (path && !/^https?:\/\//i.test(path)) return `https://profile.line-scdn.net/home/namkrub/Projects/Apps/Liney/src/components/LineProfileSettings.tsx`;
  // Backward compatibility for older LINEJS responses without pictureUrl.
  const mid = String(profile.mid ?? "").trim();
  if (/^u[0-9a-f]{32}$/i.test(mid)) {
    const status = String(profile.pictureStatus ?? "").trim();
    const query = status && status !== "0" ? "?v=" + encodeURIComponent(status.slice(0, 120)) : "";
    return "https://obs.line-scdn.net/r/talk/p/" + mid + query;
  }
  return undefined;
}

export function LineProfileSettings({ onUpdated }: { onUpdated: (profile: EditableLineProfile) => void }) {
  const [original, setOriginal] = useState<EditableLineProfile | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const pickerRef = useRef<HTMLInputElement>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    void lineyEngine.request<EditableLineProfile>("profile.get", {}, 20_000).then((profile) => {
      if (!mounted) return;
      setOriginal(profile);
      setDisplayName(profile.displayName ?? "");
      setStatusMessage(profile.statusMessage ?? "");
      setError("");
    }).catch((cause: unknown) => {
      if (mounted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [attempt]);

  useEffect(() => {
    if (!pendingFile) return;
    const uri = URL.createObjectURL(pendingFile);
    const task = Promise.resolve().then(() => setPreview(uri));
    void task;
    return () => { URL.revokeObjectURL(uri); };
  }, [pendingFile]);

  const nameChanged = displayName.trim() !== (original?.displayName ?? "");
  const statusChanged = statusMessage !== (original?.statusMessage ?? "");
  const dirty = nameChanged || statusChanged;
  const pending = loading || saving || uploading;
  const image = preview || imageSource(original);

  function reset() {
    if (!original || pending) return;
    setDisplayName(original.displayName ?? "");
    setStatusMessage(original.statusMessage ?? "");
    setError("");
    setSuccess("");
  }

  function selectAvatar(file?: File) {
    if (!file) return;
    setError("");
    setSuccess("");
    if (!["image/png", "image/jpeg"].includes(file.type) || !file.size || file.size > 8 * 1024 * 1024) {
      setError("รองรับเฉพาะ PNG หรือ JPEG ขนาดไม่เกิน 8 MB");
      return;
    }
    setPreview("");
    setPendingFile(file);
  }

  async function uploadAvatar() {
    if (!pendingFile || pending) return;
    setUploading(true);
    setError("");
    setSuccess("");
    try {
      const imageData = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("อ่านรูปไม่สำเร็จ"));
        reader.onerror = () => reject(reader.error ?? new Error("อ่านรูปไม่สำเร็จ"));
        reader.readAsDataURL(pendingFile);
      });
      const response = await lineyEngine.request<{ profile: EditableLineProfile }>("profile.avatar.upload", { imageData }, 60_000);
      setOriginal(response.profile);
      onUpdated(response.profile);
      setPendingFile(null);
      setPreview("");
      setSuccess("อัปโหลดรูปโปรไฟล์บน LINE สำเร็จ");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!original || pending || !displayName.trim() || !dirty) return;
    const values: Record<string, string> = {};
    if (nameChanged) values.displayName = displayName.trim();
    if (statusChanged) values.statusMessage = statusMessage;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const response = await lineyEngine.request<{ profile: EditableLineProfile }>("profile.update", { values }, 30_000);
      setOriginal(response.profile);
      setDisplayName(response.profile.displayName ?? "");
      setStatusMessage(response.profile.statusMessage ?? "");
      onUpdated(response.profile);
      setSuccess("บันทึกข้อมูลโปรไฟล์บน LINE สำเร็จ");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return <div className="settings-scroll liney-profile-page">
    <div className="liney-profile-heading">
      <div>
        <span className="liney-kicker">ACCOUNT / LINE PROFILE</span>
        <h3>โปรไฟล์ของคุณ</h3>
        <p>จัดการข้อมูลที่แสดงให้ผู้ใช้ LINE คนอื่นเห็น</p>
      </div>
      <span className="liney-live-pill"><span/> เชื่อมผ่าน LINEJS</span>
    </div>

    <section className="liney-profile-hero">
      <div className="liney-profile-avatar" aria-label="รูปโปรไฟล์">
        {image ? <RemoteImage src={image} alt="รูปโปรไฟล์ LINE" loading="eager" fallback={<UserRound size={35} />} /> : <UserRound size={35} />}
      </div>
      <div className="liney-profile-hero-info">
        <strong>{original?.displayName || (loading ? "กำลังโหลดบัญชี…" : "บัญชี LINE")}</strong>
        <p>{original?.statusMessage || "รูปโปรไฟล์และข้อมูลบัญชี LINE"}</p>
        <div className="liney-profile-pic-actions">
          <input ref={pickerRef} className="liney-visually-hidden" type="file" accept="image/png,image/jpeg" aria-label="เลือกรูปโปรไฟล์" disabled={pending || !original} onChange={event => {
            selectAvatar(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}/>
          <button type="button" className="liney-button liney-button-secondary" disabled={pending || !original} onClick={() => pickerRef.current?.click()}><Camera size={16}/> เปลี่ยนรูป</button>
          {pendingFile && <button type="button" className="liney-button liney-button-primary" disabled={pending} onClick={() => void uploadAvatar()}>{uploading ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>} อัปโหลดรูป</button>}
          {pendingFile && <button type="button" className="liney-button liney-button-quiet" disabled={pending} onClick={() => { setPendingFile(null); setPreview(""); }}>ยกเลิก</button>}
        </div>
        <small>รูป PNG / JPEG · ไม่เกิน 8 MB {pendingFile ? "· รูปยังไม่ได้อัปโหลด" : ""}</small>
      </div>
    </section>

    <section className="liney-editor-card">
      <div className="liney-editor-card-heading">
        <div><h4>ข้อมูลที่แสดงบน LINE</h4><p>แก้ไขชื่อและข้อความสถานะของบัญชี</p></div>
        {dirty && <span className="liney-unsaved-badge">ยังไม่ได้บันทึก</span>}
      </div>
      <div className="liney-editor-fields">
        <label className="liney-field" htmlFor="liney-profile-name">
          <span>ชื่อที่แสดง <small>{displayName.length}/50</small></span>
          <input id="liney-profile-name" type="text" maxLength={50} value={displayName} disabled={pending || !original} onChange={event => setDisplayName(event.target.value)} placeholder="ชื่อบัญชี LINE" />
        </label>
        <label className="liney-field" htmlFor="liney-profile-status">
          <span>ข้อความสถานะ <small>{statusMessage.length}/500</small></span>
          <textarea id="liney-profile-status" rows={4} maxLength={500} value={statusMessage} disabled={pending || !original} onChange={event => setStatusMessage(event.target.value)} placeholder="เพิ่มข้อความสถานะของคุณ…" />
        </label>
      </div>
      {loading && <div className="liney-inline-message"><LoaderCircle size={16} className="spin"/> กำลังดึงข้อมูลโปรไฟล์…</div>}
      {error && <div className="liney-inline-message liney-inline-error" role="alert"><CircleAlert size={17}/> <span>{error}</span>{!original && <button type="button" onClick={() => { setLoading(true); setAttempt(x => x + 1); }}>ลองใหม่</button>}</div>}
      {success && <div className="liney-inline-message liney-inline-success" role="status"><Check size={17}/> {success}</div>}
      <div className="liney-editor-footer">
        <span><ShieldCheck size={15}/> บันทึกผ่าน LINEJS โดยตรง</span>
        <div>
          <button type="button" className="liney-button liney-button-secondary" disabled={!dirty || pending} onClick={reset}><RotateCcw size={15}/> คืนค่าเดิม</button>
          <button type="button" className="liney-button liney-button-primary" disabled={pending || !original || !dirty || !displayName.trim()} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={16}/> : <Save size={16}/>} {saving ? "กำลังบันทึก…" : "บันทึกการเปลี่ยนแปลง"}</button>
        </div>
      </div>
    </section>
  </div>;
}
