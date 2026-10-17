import { useMemo, useState } from "react";
import { AlertTriangle, Bell, BellOff, Check, ChevronRight, CircleAlert, Heart, LoaderCircle, PencilLine, Search, ShieldAlert, UserRoundPlus, Users, X } from "lucide-react";
import { lineyEngine } from "../lib/engine";
import { RemoteImage } from "./RemoteImage";
import "./LineAlbumsModal.css";
import "./LineWorkspacePolish.css";

type Friend = { id: string; name: string; avatarUrl?: string };

export function LineChatManageModal({
  room, friends, onClose,
}: {
  room: { id: string; name: string; kind: "dm" | "group" };
  friends: Friend[];
  onClose: () => void;
}) {
  const [name, setName] = useState(room.name);
  const [invitees, setInvitees] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [storedName, setStoredName] = useState(room.name);

  const isGroup = room.kind === "group";
  const validFriends = useMemo(() => friends.filter(friend => /^u[a-f0-9]{32}$/i.test(friend.id))
    .filter((friend, index, list) => list.findIndex(item => item.id === friend.id) === index), [friends]);
  const filtered = useMemo(() => validFriends.filter(friend => friend.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [validFriends, query]);
  const selected = useMemo(() => invitees.map(id => validFriends.find(friend => friend.id === id)).filter((friend): friend is Friend => Boolean(friend)), [invitees, validFriends]);

  async function request(method: string, params: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await lineyEngine.request(method, params, 35_000);
      if (method === "group.leave") { onClose(); return; }
      if (method === "group.invite") {
        const total = invitees.length;
        setInvitees([]);
        setNotice(`ส่งคำเชิญให้เพื่อน ${total} คนแล้ว`);
      } else if (method === "group.rename" || method === "friend.rename") {
        if (typeof params.name === "string") setStoredName(params.name.trim());
        setNotice(method === "group.rename" ? "บันทึกชื่อกลุ่มบน LINE แล้ว" : "อัปเดตชื่อเพื่อนบน LINE แล้ว");
      } else {
        setNotice("บันทึกการตั้งค่าบน LINE แล้ว");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function toggleFriend(mid: string) {
    if (busy) return;
    setInvitees(current => current.includes(mid) ? current.filter(id => id !== mid) : current.length < 20 ? [...current, mid] : current);
  }

  return <div className="modal-backdrop liney-albums-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="liney-albums-panel liney-manage-modal" role="dialog" aria-modal="true" aria-label={isGroup ? "จัดการกลุ่ม LINE" : "จัดการเพื่อน LINE"}>
      <header className="liney-manage-header">
        <div className="liney-manage-header-icon">{isGroup ? <Users size={22}/> : <PencilLine size={22}/>}</div>
        <div className="liney-manage-header-titles">
          <span className="liney-kicker">{isGroup ? "GROUP MANAGEMENT" : "CONTACT MANAGEMENT"}</span>
          <h2>{isGroup ? "จัดการกลุ่ม" : "จัดการเพื่อน"}</h2>
          <p title={room.name}>{room.name}</p>
        </div>
        <button className="icon-button" type="button" disabled={busy} aria-label="ปิด" onClick={onClose}><X size={20}/></button>
      </header>
      <div className="liney-manage-scroll">
        {error && <div className="liney-inline-message liney-inline-error" role="alert"><CircleAlert size={17}/><span>{error}</span></div>}
        {notice && <div className="liney-inline-message liney-inline-success" role="status"><Check size={17}/><span>{notice}</span></div>}

        <section className="liney-manage-section">
          <div className="liney-manage-section-heading">
            <div><h3>{isGroup ? "ชื่อกลุ่ม" : "ชื่อที่แสดงเฉพาะคุณ"}</h3><p>{isGroup ? "เปลี่ยนชื่อที่สมาชิกในกลุ่มจะเห็น" : "ตั้งชื่อเพื่อนสำหรับบัญชี LINE ของคุณ"}</p></div>
            <PencilLine size={18}/>
          </div>
          <form className="liney-manage-rename" onSubmit={event => {
            event.preventDefault();
            const value = name.trim();
            if (!value || value === storedName || busy) return;
            void request(isGroup ? "group.rename" : "friend.rename", isGroup ? { chatId: room.id, name: value } : { mid: room.id, name: value });
          }}>
            <input aria-label={isGroup ? "ชื่อกลุ่ม" : "ชื่อเพื่อน"} maxLength={100} value={name} disabled={busy} onChange={event => setName(event.target.value)} />
            <button className="liney-button liney-button-primary" type="submit" disabled={busy || !name.trim() || name.trim() === storedName}>{busy ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>} บันทึกชื่อ</button>
          </form>
          {!isGroup && <button type="button" className="liney-manage-small-link" disabled={busy} onClick={() => void request("friend.rename", { mid: room.id, name: null })}>ใช้ชื่อเดิมของเพื่อน</button>}
        </section>

        {isGroup ? <>
          <section className="liney-manage-section">
            <div className="liney-manage-section-heading">
              <div><h3>เชิญเพื่อนเข้ากลุ่ม</h3><p>ค้นหาและเลือกรายชื่อจากเพื่อนที่ซิงค์ไว้</p></div>
              <span className="liney-manage-count">{invitees.length}/20 คน</span>
            </div>
            <div className="liney-manage-search"><Search size={17}/><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="ค้นหาชื่อเพื่อน…" aria-label="ค้นหาเพื่อนที่จะเชิญ" /><span>{filtered.length} รายชื่อ</span></div>
            {selected.length > 0 && <div className="liney-manage-selected">
              {selected.map(friend => <button key={friend.id} type="button" disabled={busy} onClick={() => toggleFriend(friend.id)} title="เอาออกจากรายการเชิญ">{friend.name}<X size={13}/></button>)}
            </div>}
            <div className="liney-manage-friend-list" role="group" aria-label="รายชื่อเพื่อน">
              {filtered.length === 0 ? <div className="liney-manage-empty"><Search size={20}/>{validFriends.length === 0 ? "ยังไม่มีรายชื่อเพื่อนที่พร้อมเชิญ" : "ไม่พบเพื่อนที่ตรงกับคำค้นหา"}</div> : filtered.map(friend => {
                const checked = invitees.includes(friend.id);
                const unavailable = busy || (invitees.length >= 20 && !checked);
                return <label className={`liney-manage-friend ${checked ? "selected" : ""} ${unavailable ? "is-disabled" : ""}`} key={friend.id}>
                  <span className="liney-friend-avatar">{friend.avatarUrl ? <RemoteImage src={friend.avatarUrl} alt={friend.name} loading="lazy" fallback={friend.name.slice(0, 1) || "?"}/> : (friend.name.slice(0, 1) || "?")}</span>
                  <span className="liney-friend-name">{friend.name || "LINE User"}</span>
                  <input type="checkbox" checked={checked} disabled={unavailable} onChange={() => toggleFriend(friend.id)} aria-label={`เลือก ${friend.name}`}/>
                </label>;
              })}
            </div>
            <p className="liney-manage-caption">LINE อาจปฏิเสธคำเชิญหากผู้ใช้เป็นสมาชิกอยู่แล้วหรือบัญชีไม่อนุญาตให้เชิญ</p>
          </section>
          <section className="liney-manage-danger">
            <div><h3><ShieldAlert size={17}/> ออกจากกลุ่ม</h3><p>เมื่อออกแล้ว คุณอาจต้องให้สมาชิกเชิญกลับเข้ามาอีกครั้ง</p></div>
            <button className="liney-button liney-button-danger" type="button" disabled={busy} onClick={() => {
              if (window.confirm(`ออกจากกลุ่ม “${room.name}” บน LINE ใช่หรือไม่?\nการกระทำนี้จะส่งไปยังเซิร์ฟเวอร์ LINE ทันที`)) void request("group.leave", { chatId: room.id });
            }}>ออกจากกลุ่ม <ChevronRight size={16}/></button>
          </section>
        </> : <section className="liney-manage-section">
          <div className="liney-manage-section-heading"><div><h3>การตั้งค่าเพื่อน</h3><p>คำสั่งเหล่านี้จะอัปเดตการตั้งค่าบน LINE ทันที</p></div><Heart size={17}/></div>
          <div className="liney-manage-action-grid">
            <button type="button" disabled={busy} onClick={() => void request("friend.favorite", { mid: room.id, favorite: true })}><Heart size={19}/><span>เพิ่มในรายการโปรด</span><ChevronRight size={17}/></button>
            <button type="button" disabled={busy} onClick={() => void request("friend.favorite", { mid: room.id, favorite: false })}><X size={18}/><span>นำออกจากรายการโปรด</span><ChevronRight size={17}/></button>
            <button type="button" disabled={busy} onClick={() => void request("friend.mute", { mid: room.id, muted: true })}><BellOff size={19}/><span>ปิดเสียงแจ้งเตือน</span><ChevronRight size={17}/></button>
            <button type="button" disabled={busy} onClick={() => void request("friend.mute", { mid: room.id, muted: false })}><Bell size={19}/><span>เปิดเสียงแจ้งเตือน</span><ChevronRight size={17}/></button>
          </div>
        </section>}
      </div>
      <footer className="liney-manage-footer">
        <span>{isGroup ? <><UserRoundPlus size={16}/>{invitees.length > 0 ? `เลือก ${invitees.length} คนที่จะเชิญ` : "ยังไม่ได้เลือกเพื่อน"}</> : <><AlertTriangle size={16}/> การเปลี่ยนแปลงจะถูกบันทึกบน LINE</>}</span>
        {isGroup ? <button className="liney-button liney-button-primary" type="button" disabled={busy || invitees.length === 0} onClick={() => void request("group.invite", { chatId: room.id, memberMids: invitees })}>{busy ? <LoaderCircle className="spin" size={16}/> : <UserRoundPlus size={16}/>} เชิญ {invitees.length} คน</button> : <button className="liney-button liney-button-secondary" type="button" disabled={busy} onClick={onClose}>เสร็จสิ้น</button>}
      </footer>
    </section>
  </div>;
}
