import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  Code2,
  Database,
  LockKeyhole,
  MessageCircle,
  Monitor,
  QrCode,
  ShieldCheck,
  Sparkles,
  Users,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";
import "./MarketingSite.css";

export type MarketingView = "home" | "login";

type MarketingSiteProps = {
  view: MarketingView;
  onNavigate: (path: string) => void;
};

type Feature = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const features: Feature[] = [
  {
    icon: Monitor,
    title: "Linux-first desktop",
    body: "หน้าตาและ interaction ออกแบบให้เข้ากับ desktop Linux ไม่ใช่เว็บที่ถูกย่อมาใส่กรอบ",
  },
  {
    icon: Database,
    title: "Cache-first",
    body: "เปิดแอปแล้วเห็นข้อมูลที่เก็บไว้ก่อน จากนั้นค่อย refresh เบื้องหลังเมื่อ network พร้อม",
  },
  {
    icon: LockKeyhole,
    title: "ข้อมูลอยู่กับคุณ",
    body: "ประวัติและ session เก็บในเครื่องของผู้ใช้ พร้อม permission และการจัดเก็บ credential ที่รัดกุม",
  },
  {
    icon: Zap,
    title: "ส่งแบบ offline-first",
    body: "ข้อความมีสถานะในเครื่องและ outbox ช่วยรับมือกับ network ที่หลุดหรือช้า",
  },
  {
    icon: Sparkles,
    title: "Media และ sticker",
    body: "รองรับข้อความ รูปภาพ ไฟล์ rich message และ sticker ผ่าน engine ที่แยกจาก UI",
  },
  {
    icon: ShieldCheck,
    title: "โปร่งใสและเป็นอิสระ",
    body: "เป็นซอฟต์แวร์อิสระ ไม่ใช่แอปทางการ และจะแสดงความสามารถตามที่ engine รองรับจริง",
  },
];

export function MarketingSite({ view, onNavigate }: MarketingSiteProps) {
  return (
    <div className="marketing-page">
      <MarketingHeader view={view} onNavigate={onNavigate} />
      {view === "login" ? <DemoLogin onNavigate={onNavigate} /> : <Landing onNavigate={onNavigate} />}
      <MarketingFooter onNavigate={onNavigate} />
    </div>
  );
}

function MarketingHeader({ view, onNavigate }: { view: MarketingView; onNavigate: (path: string) => void }) {
  return (
    <header className="marketing-header">
      <div className="marketing-container marketing-header-inner">
        <button className="marketing-brand" type="button" onClick={() => onNavigate("/")} aria-label="กลับหน้าแรก Liney">
          <img src="/liney-mark.svg" alt="" />
          <span>
            <strong>Liney</strong>
            <small>Chat closer on Linux</small>
          </span>
        </button>
        <nav className="marketing-nav" aria-label="เมนูหลัก">
          <a href={view === "home" ? "#what-is-liney" : "/#what-is-liney"}>Liney คืออะไร</a>
          <a href={view === "home" ? "#features" : "/#features"}>ความสามารถ</a>
          <a href={view === "home" ? "#architecture" : "/#architecture"}>การทำงาน</a>
          <button className="marketing-nav-cta" type="button" onClick={() => onNavigate("/chat")}>ดูตัวอย่างแอป <ArrowRight size={15} /></button>
        </nav>
      </div>
    </header>
  );
}

function Landing({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <main>
      <section className="marketing-hero marketing-container">
        <div className="marketing-hero-copy">
          <div className="marketing-kicker"><span className="marketing-kicker-dot" />UNOFFICIAL · LINUX-FIRST</div>
          <h1>LINE บน Linux<br /><em>ในแบบที่เป็นของเรา</em></h1>
          <p className="marketing-hero-lede">
            Liney คือ unofficial LINE desktop client ที่สร้างขึ้นเพื่อให้ผู้ใช้ Linux
            คุยกับคนและชุมชนเดิมได้ โดยไม่ต้องพึ่ง Windows, Wine หรือ VM
          </p>
          <div className="marketing-actions">
            <button className="marketing-primary-button" type="button" onClick={() => onNavigate("/chat")}>ดูหน้าแชตตัวอย่าง <ArrowRight size={17} /></button>
            <button className="marketing-secondary-button" type="button" onClick={() => onNavigate("/login")}><QrCode size={16} /> ดูหน้า Login</button>
          </div>
          <div className="marketing-hero-note"><ShieldCheck size={15} /> หน้าเว็บนี้เป็น product preview ไม่ได้เชื่อมบัญชี LINE จริง</div>
        </div>
        <ProductPreview onNavigate={onNavigate} />
      </section>

      <section className="marketing-proof-row marketing-container" aria-label="จุดเด่นของ Liney">
        <ProofItem icon={Code2} label="React + Tauri WebView" />
        <ProofItem icon={Zap} label="Bun + TypeScript engine" />
        <ProofItem icon={Database} label="SQLite local history" />
        <ProofItem icon={ShieldCheck} label="No central relay" />
      </section>

      <section className="marketing-section marketing-container" id="what-is-liney">
        <SectionHeading eyebrow="WHAT IS LINEY?" title="ชั้นกลางที่ทำให้ LINE รู้สึกเป็น Linux มากขึ้น" body="Liney แยกหน้าตาแอปออกจาก protocol engine อย่างชัดเจน จึงดูแล UI, cache, sync และการเชื่อมต่อได้เป็นส่วน ๆ" />
        <div className="marketing-explain-grid">
          <ExplainCard number="01" icon={Monitor} title="UI ที่ใช้งานง่าย" body="หน้าแชตที่เน้นการอ่าน การตอบ และการเห็นสถานะจริงของข้อความ โดยไม่ซ่อนข้อจำกัดไว้หลัง mock interaction" />
          <ExplainCard number="02" icon={Database} title="ข้อมูลท้องถิ่นเป็นหลัก" body="SQLite เป็น source of truth สำหรับ cache, history และ outbox ทำให้เปิดดูข้อมูลเดิมได้แม้ network ไม่พร้อม" />
          <ExplainCard number="03" icon={Wifi} title="Engine ที่เปลี่ยนได้" body="LINEJS อยู่หลัง adapter และ versioned RPC boundary เพื่อไม่ให้ UI ผูกกับรายละเอียด protocol โดยตรง" />
        </div>
      </section>

      <section className="marketing-section marketing-section-soft" id="features">
        <div className="marketing-container">
          <SectionHeading eyebrow="BUILT FOR EVERYDAY USE" title="สิ่งที่ Liney ตั้งใจแก้" body="ไม่ใช่แค่เอา chat bubble มาวางบน Linux แต่พยายามแก้ปัญหาที่เกิดขึ้นจริงตอนใช้ desktop client" />
          <div className="marketing-feature-grid">
            {features.map((feature) => <FeatureCard key={feature.title} {...feature} />)}
          </div>
        </div>
      </section>

      <section className="marketing-section marketing-container" id="architecture">
        <div className="marketing-architecture-card">
          <div className="marketing-architecture-copy">
            <div className="marketing-kicker">UNDER THE HOOD</div>
            <h2>สามชั้นที่แยกหน้าที่กัน</h2>
            <p>เว็บนี้มีไว้ให้เห็นภาพของระบบ ส่วนแอป desktop จริงจะรัน engine ภายในเครื่องของผู้ใช้และเก็บข้อมูลไว้ local</p>
            <div className="marketing-stack-list">
              <StackRow color="green" title="Liney UI" body="React + Tauri WebView" />
              <StackRow color="blue" title="Liney engine" body="Bun + TypeScript + SQLite" />
              <StackRow color="dark" title="LINE protocol" body="LINEJS adapter" />
            </div>
          </div>
          <div className="marketing-architecture-diagram" aria-label="แผนภาพสถาปัตยกรรม Liney">
            <DiagramNode icon={Monitor} title="UI" detail="Desktop experience" />
            <div className="diagram-arrow"><span /> JSONL RPC <span /></div>
            <DiagramNode icon={Database} title="Engine" detail="Cache · Sync · Media" />
            <div className="diagram-arrow"><span /> Adapter <span /></div>
            <DiagramNode icon={MessageCircle} title="LINE" detail="Protocol services" dark />
          </div>
        </div>
      </section>

      <section className="marketing-cta marketing-container">
        <div>
          <div className="marketing-kicker">TAKE A LOOK AROUND</div>
          <h2>อยากเห็นหน้าตาแอปจริงไหม?</h2>
          <p>เปิดตัวอย่างหน้าแชตได้ทันที ข้อมูลทั้งหมดเป็น mock data เพื่อการนำเสนอเท่านั้น</p>
        </div>
        <button className="marketing-primary-button" type="button" onClick={() => onNavigate("/chat")}>เปิดตัวอย่าง Liney <ArrowRight size={17} /></button>
      </section>

      <section className="marketing-disclaimer marketing-container">
        <ShieldCheck size={22} />
        <div><strong>หมายเหตุสำคัญ</strong><span>Liney เป็นซอฟต์แวร์อิสระ ไม่ได้ affiliated กับ LY Corporation หรือแอป LINE ทางการ การเชื่อมต่อบัญชีจริงจะอยู่ใน desktop application ไม่ใช่หน้า promo นี้</span></div>
      </section>
    </main>
  );
}

function DemoLogin({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [mode, setMode] = useState<"qr" | "password">("qr");
  return (
    <main className="marketing-demo marketing-container">
      <section className="marketing-demo-intro">
        <div className="marketing-kicker"><span className="marketing-kicker-dot" />INTERACTIVE PREVIEW</div>
        <h1>เข้าสู่ระบบแบบ<br /><em>เป็นส่วนตัวและชัดเจน</em></h1>
        <p>หน้า login นี้เป็นภาพจำลองเพื่ออธิบาย flow ของ desktop app เท่านั้น ไม่มีการส่ง QR, password หรือ credential ใด ๆ ออกจากเว็บสาธิต</p>
        <div className="marketing-check-list">
          <Check size={16} /> QR login ผ่าน engine ในเครื่อง
          <Check size={16} /> Email / password พร้อม device PIN เมื่อจำเป็น
          <Check size={16} /> session เก็บ local ตามโหมดที่ระบบรองรับ
        </div>
        <button className="marketing-text-button" type="button" onClick={() => onNavigate("/")}>← กลับไปดูภาพรวม</button>
      </section>
      <section className="marketing-login-card" aria-label="ตัวอย่างหน้าเข้าสู่ระบบ Liney">
        <div className="marketing-login-brand"><img src="/liney-mark.svg" alt="" /><div><strong>Liney</strong><span>Linux desktop client</span></div></div>
        <h2>เข้าสู่ระบบ Liney</h2>
        <p className="marketing-login-caption">นี่คือหน้าตัวอย่าง · ยังไม่ได้เชื่อมต่อ LINE จริง</p>
        <div className="marketing-login-tabs">
          <button className={mode === "qr" ? "active" : ""} type="button" onClick={() => setMode("qr")}><QrCode size={15} /> QR Code</button>
          <button className={mode === "password" ? "active" : ""} type="button" onClick={() => setMode("password")}><LockKeyhole size={15} /> Email / Password</button>
        </div>
        {mode === "qr" ? <FakeQrLogin /> : <FakePasswordLogin />}
        <button className="marketing-primary-button marketing-login-button" type="button" onClick={() => onNavigate("/chat")}>ดูหน้าแชตตัวอย่าง <ArrowRight size={16} /></button>
        <span className="marketing-login-safe"><ShieldCheck size={14} /> Demo mode · ไม่มีการ login จริง</span>
      </section>
    </main>
  );
}

function FakeQrLogin() {
  return (
    <div className="marketing-fake-qr-wrap">
      <div className="marketing-fake-qr" aria-label="QR code จำลอง">
        <span className="qr-corner qr-corner-a" /><span className="qr-corner qr-corner-b" /><span className="qr-corner qr-corner-c" />
        <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
      </div>
      <strong>สแกน QR ด้วย LINE บนมือถือ</strong>
      <span>ในแอปจริง QR จะมาจาก local Liney engine</span>
    </div>
  );
}

function FakePasswordLogin() {
  return (
    <div className="marketing-fake-password">
      <label>Email<input type="text" placeholder="you@example.com" disabled /></label>
      <label>Password<input type="password" placeholder="••••••••" disabled /></label>
      <div className="marketing-form-hint"><ShieldCheck size={14} /> password ใช้ชั่วคราวและไม่ถูกเก็บลง localStorage</div>
    </div>
  );
}

function ProductPreview({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <div className="marketing-product-wrap">
      <div className="marketing-product-glow" />
      <div className="marketing-product-window">
        <div className="marketing-window-bar"><span className="window-dots"><i /><i /><i /></span><span>Liney · Messages</span><span className="window-live">● local preview</span></div>
        <div className="marketing-window-body">
          <aside className="preview-rail"><img src="/liney-mark.svg" alt="" /><span className="preview-rail-active"><MessageCircle size={15} /></span><span><Users size={15} /></span><span><Sparkles size={15} /></span><span className="preview-rail-bottom"><Monitor size={15} /></span></aside>
          <aside className="preview-list">
            <div className="preview-list-title"><small>MESSAGES</small><strong>แชต</strong><span>＋</span></div>
            <div className="preview-search">⌕&nbsp; ค้นหาในแชต</div>
            <PreviewChat initials="NR" name="Nagi Rin" body="ส่งรูปมาให้ดูด้วยนะ" time="11:24" active unread="2" />
            <PreviewChat initials="CT" name="Cytech Team" body="ประชุมวันศุกร์ 10 โมง" time="10:46" />
            <PreviewChat initials="LT" name="Linux Thailand" body="OpenChat · 1.2K members" time="08:52" />
          </aside>
          <div className="preview-conversation">
            <div className="preview-conversation-head"><span className="preview-avatar pink">NR</span><div><strong>Nagi Rin</strong><small>เพื่อน · LINE</small></div><span className="preview-head-actions">···</span></div>
            <div className="preview-messages"><span className="preview-date">วันนี้</span><PreviewBubble side="left">วันนี้ไปคาเฟ่มา ร้านสวยมาก</PreviewBubble><div className="preview-photo"><span>รูปภาพ</span><i /><i /></div><PreviewBubble side="right">เมนูน่ากินจัด เดี๋ยวไว้ไปลอง</PreviewBubble><PreviewBubble side="left">ไปดิ เดี๋ยวส่งโลเคชั่นให้</PreviewBubble></div>
            <div className="preview-composer"><span>＋</span><span className="preview-placeholder">เขียนข้อความ...</span><b>➤</b></div>
          </div>
        </div>
      </div>
      <button className="marketing-preview-label" type="button" onClick={() => onNavigate("/chat")}><span><span className="marketing-kicker-dot" />LIVE UI PREVIEW</span><strong>เปิดหน้าแชตแบบเต็ม <ArrowRight size={14} /></strong></button>
    </div>
  );
}

function PreviewChat({ initials, name, body, time, active, unread }: { initials: string; name: string; body: string; time: string; active?: boolean; unread?: string }) {
  return <div className={`preview-chat ${active ? "active" : ""}`}><span className="preview-avatar">{initials}</span><div><strong>{name}</strong><small>{body}</small></div><time>{time}</time>{unread ? <b>{unread}</b> : null}</div>;
}

function PreviewBubble({ side, children }: { side: "left" | "right"; children: ReactNode }) {
  return <div className={`preview-bubble ${side}`}>{children}<small>{side === "right" ? "11:05" : "11:03"}</small></div>;
}

function ProofItem({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return <div className="marketing-proof-item"><Icon size={16} /><span>{label}</span></div>;
}

function SectionHeading({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return <div className="marketing-section-heading"><div className="marketing-kicker">{eyebrow}</div><h2>{title}</h2><p>{body}</p></div>;
}

function ExplainCard({ number, icon: Icon, title, body }: { number: string; icon: LucideIcon; title: string; body: string }) {
  return <article className="marketing-explain-card"><div className="marketing-card-topline"><span>{number}</span><Icon size={20} /></div><h3>{title}</h3><p>{body}</p></article>;
}

function FeatureCard({ icon: Icon, title, body }: Feature) {
  return <article className="marketing-feature-card"><span className="marketing-feature-icon"><Icon size={19} /></span><h3>{title}</h3><p>{body}</p></article>;
}

function StackRow({ color, title, body }: { color: "green" | "blue" | "dark"; title: string; body: string }) {
  return <div className="marketing-stack-row"><span className={`stack-dot ${color}`} /><div><strong>{title}</strong><small>{body}</small></div><Check size={15} /></div>;
}

function DiagramNode({ icon: Icon, title, detail, dark }: { icon: LucideIcon; title: string; detail: string; dark?: boolean }) {
  return <div className={`marketing-diagram-node ${dark ? "dark" : ""}`}><Icon size={19} /><strong>{title}</strong><small>{detail}</small></div>;
}

function MarketingFooter({ onNavigate }: { onNavigate: (path: string) => void }) {
  return <footer className="marketing-footer"><div className="marketing-container marketing-footer-inner"><button className="marketing-footer-brand" type="button" onClick={() => onNavigate("/")}><img src="/liney-mark.svg" alt="" /><span><strong>Liney</strong><small>Unofficial LINE client for Linux</small></span></button><span>Built independently for Linux users · 2026</span><span className="marketing-footer-note">Not affiliated with LINE / LY Corporation</span></div></footer>;
}
