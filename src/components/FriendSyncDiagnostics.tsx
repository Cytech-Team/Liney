import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, CircleHelp, Clock3, LoaderCircle, RefreshCw, RotateCw, ShieldCheck } from "lucide-react";
import { lineyEngine } from "../lib/engine";
import { useAppTranslation } from "../lib/i18n";
import "./FriendSyncDiagnostics.css";

export type FriendSyncDiagnosticsState = {
  phase: "idle" | "running" | "complete" | "partial" | "error";
  startedAt: number;
  finishedAt: number;
  discovered: number;
  resolved: number;
  unresolved: number;
  viaV3: number;
  viaV2: number;
  viaSingle: number;
  batches: number;
  splitBatches: number;
  errors: Array<{ category: string; source?: string; count: number }>;
  unavailableEndpoints?: string[];
  retryAfter: number;
  retryRunning: boolean;
  mode: "scan" | "retry";
};

const issueNames: Record<string, string> = {
  BATCH_TOO_LARGE: "ชุดข้อมูลใหญ่เกินข้อจำกัด API",
  RATE_LIMIT: "LINE จำกัดจำนวนคำขอ",
  NETWORK: "เครือข่ายหรือ Timeout",
  PERMISSION: "สิทธิ์เข้าถึงหรือเซสชัน",
  OTHER: "ข้อผิดพลาดอื่น",
};

export function FriendSyncDiagnostics() {
  const { t, english } = useAppTranslation();
  const fmt = (n: number) => n.toLocaleString(english ? "en-US" : "th-TH");
  const localeDate = (ms: number) => ms ? new Date(ms).toLocaleString(english ? "en-US" : "th-TH") : "—";
  const [report, setReport] = useState<FriendSyncDiagnosticsState | null>(null);
  const [busy, setBusy] = useState<"" | "scan" | "retry">("");
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);

  useEffect(() => {
    let mounted = true;
    const read = async () => {
      try {
        const next = await lineyEngine.request<FriendSyncDiagnosticsState>("friends.sync_diagnostics", {}, 10_000);
        if (mounted) { setReport(next); setError(""); setNow(Date.now()); }
      } catch (reason) {
        if (mounted) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void read();
    const timer = window.setInterval(() => { setNow(Date.now()); if (!busy) void read(); }, 4000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [busy]);

  async function run(mode: "scan" | "retry") {
    if (busy) return;
    setBusy(mode);
    setError("");
    try {
      const result = await lineyEngine.request<FriendSyncDiagnosticsState>(
        mode === "scan" ? "friends.sync_scan" : "friends.sync_retry",
        {}, 4 * 60_000,
      );
      setReport(result);
    } catch (reason) {
      const raw = reason instanceof Error ? reason.message : String(reason);
      setError(raw.includes("FRIEND_SYNC_BUSY")
        ? t("มีการซิงค์เพื่อนหรือ Full Sync กำลังทำงาน กรุณารอให้จบก่อน")
        : raw.includes("FRIEND_SYNC_COOLDOWN")
        ? t("เพิ่ง Retry ไป กรุณารอให้ครบเวลาพักก่อน")
        : raw.includes("FRIEND_SYNC_SCAN_REQUIRED")
        ? t("กรุณากดตรวจรายชื่อก่อน Retry")
        : raw);
    } finally {
      setBusy("");
    }
  }

  const countKnown = Boolean(report?.discovered || report?.finishedAt);
  const total = report?.discovered ?? 0;
  const done = report?.resolved ?? 0;
  const progress = total ? Math.min(100, Math.round(done / total * 100)) : 0;
  const pending = Boolean(busy) || report?.phase === "running";
  const cooldown = Math.max(0, Math.ceil(((report?.retryAfter ?? 0) - now) / 1000));
  const retryDisabled = pending || !report?.unresolved || cooldown > 0;
  const statusTitle = !report || report.phase === "idle" ? t("ยังไม่มีผลตรวจจาก LINE")
    : report.phase === "running" ? t("กำลังซิงค์รายชื่อ…")
    : report.phase === "complete" ? t("ดึงโปรไฟล์ครบทุก MID แล้ว")
    : report.phase === "error" ? t("ตรวจสอบไม่สำเร็จ")
    : t("มีโปรไฟล์ที่ยังดึงไม่สำเร็จ");

  return <div className="liney-friend-diagnostics">
    <div className="liney-friend-diag-head">
      <div>
        <span className="liney-friend-diag-eyebrow">LINEJS / CONTACT SYNC</span>
        <h3>Sync Diagnostics</h3>
        <p>{t("แยกจำนวน MID ที่ LINE ส่งกลับมาจากโปรไฟล์ที่อ่านได้จริง")}</p>
      </div>
      <span className={`liney-friend-diag-state ${report?.phase === "complete" ? "success" : ""}`}>
        {report?.phase === "complete" ? <CheckCircle2 size={15}/> : pending ? <LoaderCircle size={15} className="spin"/> : <CircleHelp size={15}/>}
        {statusTitle}
      </span>
    </div>

    <div className="liney-friend-diag-stats">
      <div><span>{t("MID ที่ LINE ส่งมา")}</span><strong>{countKnown ? fmt(total) : "—"}</strong><small>{t("ไม่ใช่จำนวนแชตใน SQLite")}</small></div>
      <div><span>{t("โปรไฟล์ที่ดึงสำเร็จ")}</span><strong>{countKnown ? fmt(done) : "—"}</strong><small>{t("ชื่อที่ใช้แสดงผลได้จริง")}</small></div>
      <div><span>{t("ยังไม่สมบูรณ์")}</span><strong>{countKnown ? fmt(report?.unresolved ?? 0) : "—"}</strong><small>{t("สามารถ Retry เฉพาะส่วนนี้")}</small></div>
    </div>

    <div className="liney-friend-diag-progress">
      <div><span>{t("ความสมบูรณ์ของโปรไฟล์")}</span><strong>{countKnown ? `${progress}%` : t("ยังไม่ได้ตรวจ")}</strong></div>
      <div className="liney-friend-diag-track" role="progressbar" aria-label={t("ความสมบูรณ์ของโปรไฟล์")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <small><Clock3 size={13}/> {t("ตรวจล่าสุด")}: {localeDate(report?.finishedAt ?? 0)}</small>
    </div>

    <div className="liney-friend-diag-breakdown">
      <div><strong>{fmt(report?.viaV3 ?? 0)}</strong><span>Contacts V3</span></div>
      <div><strong>{fmt(report?.viaV2 ?? 0)}</strong><span>Contacts V2</span></div>
      <div><strong>{fmt(report?.viaSingle ?? 0)}</strong><span>getUser Fallback</span></div>
      <div><strong>{fmt(report?.batches ?? 0)}</strong><span>API Batches</span></div>
      <div><strong>{fmt(report?.splitBatches ?? 0)}</strong><span>{t("Batch ถูกแบ่งย่อย")}</span></div>
    </div>

    {Boolean(report?.unavailableEndpoints?.length) && <div className="liney-friend-diag-fallback" role="status">
      <h4><CheckCircle2 size={16}/> {t("ใช้ช่องทางสำรองอัตโนมัติ")}</h4>
      <p>{report?.unavailableEndpoints?.join(" / ")} {t("ไม่พร้อมใช้งานกับเซสชันนี้ จึงเปลี่ยนไปใช้ API สำรองโดยไม่ต้อง Retry หรือเข้าสู่ระบบใหม่")}</p>
    </div>}
    {Boolean(report?.errors?.length) && <div className="liney-friend-diag-errors">
      <h4><AlertCircle size={16}/>{report?.unresolved === 0 && report?.phase === "complete" ? t("คำขอที่ผิดพลาดแต่กู้ข้อมูลสำเร็จแล้ว") : t("ข้อผิดพลาดจากรอบล่าสุด")}</h4>
      {report?.errors.map((issue) => <div key={`${issue.category}-${issue.source || ""}`}>
        <span>{issue.source ? `${issue.source} · ` : ""}{issueNames[issue.category] ? t(issueNames[issue.category]) : issue.category}</span><strong>{t("{{count}} ครั้ง", { count: fmt(issue.count) })}</strong>
      </div>)}
      <small>{t("ตัวเลขนี้นับจำนวนคำขอที่ผิดพลาด ไม่ใช่จำนวนเพื่อนที่ตกหล่น")} {report?.unresolved === 0 ? t("โปรไฟล์เพื่อนครบแล้ว") : ""}</small>
    </div>}

    {error && <div className="liney-friend-diag-error" role="alert"><AlertCircle size={16}/>{error}</div>}

    <div className="liney-friend-diag-actions">
      <button type="button" className="liney-friend-diag-button secondary" disabled={pending} onClick={() => void run("scan")}>
        {busy === "scan" ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>}
        {t("ตรวจรายชื่อใหม่")}
      </button>
      <button type="button" className="liney-friend-diag-button primary" disabled={retryDisabled} onClick={() => void run("retry")}>
        {busy === "retry" ? <LoaderCircle className="spin" size={16}/> : <RotateCw size={16}/>}
        {cooldown ? t("Retry ได้ใน {{count}} วินาที", { count: cooldown }) : t("Retry ที่ตกหล่น {{count}} คน", { count: fmt(report?.unresolved ?? 0) })}
      </button>
    </div>
    <p className="liney-friend-diag-footnote">
      <ShieldCheck size={15}/>
      {t("ตรวจผ่าน LINEJS บนเครื่องของคุณ · Batch เริ่มต้น 50 คน · Retry สูงสุด 100 คนต่อครั้งและพัก 60 วินาที · ไม่แสดง MID หรือ Token")}
    </p>
  </div>;
}
