import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  FlaskConical,
  Heart,
  Layers3,
  Code2,
  Database,
  LockKeyhole,
  MessageCircle,
  Menu,
  Moon,
  Sun,
  X,
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

type MarketingTheme = "light" | "dark";
const THEME_STORAGE_KEY = "liney.marketing.theme";

function getSavedTheme(): MarketingTheme | null {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    return null;
  }
}

export function MarketingSite({ view, onNavigate }: MarketingSiteProps) {
  const [choice, setChoice] = useState<MarketingTheme | null>(getSavedTheme);
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const theme: MarketingTheme = choice ?? (systemDark ? "dark" : "light");

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setChoice(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Still apply the choice for this session when storage is unavailable.
    }
  }

  return (
    <div className={`marketing-page marketing-theme-${theme}`} data-theme={theme}>
      <MarketingHeader view={view} onNavigate={onNavigate} theme={theme} onToggleTheme={toggleTheme} />
      {view === "login" ? <DemoLogin onNavigate={onNavigate} /> : <Landing onNavigate={onNavigate} />}
      <MarketingFooter onNavigate={onNavigate} />
    </div>
  );
}

function MarketingHeader({ view, onNavigate, theme, onToggleTheme }: { view: MarketingView; onNavigate: (path: string) => void; theme: MarketingTheme; onToggleTheme: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchors = [
    { href: "#what-is-liney", text: "Liney คืออะไร" },
    { href: "#features", text: "ความสามารถ" },
    { href: "#architecture", text: "เบื้องหลัง" },
    { href: "#roadmap", text: "สถานะ" },
    { href: "#get-liney", text: "วิธีทดลอง" },
  ];
  return (
    <header className="marketing-header">
      <div className="marketing-container marketing-header-inner">
        <button className="marketing-brand" type="button" onClick={() => { setMenuOpen(false); onNavigate("/"); }} aria-label="กลับหน้าแรก Liney">
          <img src="/liney-mark.svg" alt="" />
          <span><strong>Liney</strong><small>LINE, made for Linux.</small></span>
        </button>
        <nav className="marketing-nav" aria-label="เมนูหลัก">
          <button className="marketing-mobile-menu-button" type="button" aria-expanded={menuOpen} aria-controls="marketing-nav-sections" aria-label={menuOpen ? "ปิดเมนู" : "เปิดเมนู"} onClick={() => setMenuOpen((current) => !current)}>
            {menuOpen ? <X size={20}/> : <Menu size={20}/>}
          </button>
          <div id="marketing-nav-sections" className={menuOpen ? "marketing-nav-links open" : "marketing-nav-links"}>
            {anchors.map((entry) => <a key={entry.href} href={view === "home" ? entry.href : "/" + entry.href} onClick={() => setMenuOpen(false)}>{entry.text}</a>)}
          </div>
          <button className="marketing-theme-toggle" type="button" onClick={onToggleTheme} aria-label={theme === "dark" ? "เปลี่ยนเป็น Light Mode" : "เปลี่ยนเป็น Dark Mode"} aria-pressed={theme === "dark"} title={theme === "dark" ? "Light Mode" : "Dark Mode"}>{theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}</button>
          <button className="marketing-nav-cta" type="button" onClick={() => { setMenuOpen(false); onNavigate("/chat"); }}>ลองดู UI <ArrowRight size={15} /></button>
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
          <div className="marketing-kicker marketing-hero-kicker"><span className="marketing-kicker-dot" /> INDEPENDENT PROJECT <span className="marketing-kicker-separator">/</span> LINUX DESKTOP</div>
          <h1>แชตที่คุ้นเคย<br /><em>บน Linux ที่คุณรัก.</em></h1>
          <p className="marketing-hero-lede">
            พบกับ <strong>Liney</strong> — LINE Desktop Client ที่ชุมชน Linux กำลังสร้างขึ้นใหม่
            เปิดแชตจากเครื่องของคุณเอง ด้วยประสบการณ์ Desktop ที่ออกแบบอย่างตั้งใจ
            ไม่ต้องเปิด Wine หรือ Windows เพื่อคุยกับคนเดิม
          </p>
          <div className="marketing-actions">
            <button className="marketing-primary-button" type="button" onClick={() => onNavigate("/chat")}>สำรวจหน้าตา Liney <ArrowRight size={18} /></button>
            <a className="marketing-secondary-button marketing-link-button" href="#roadmap"><Layers3 size={17} /> ดูแผนพัฒนา <ArrowRight size={15} /></a>
          </div>
          <div className="marketing-hero-proof"><span><CheckCircle2 size={15} /> Independent</span><span><Monitor size={15} /> Linux-first</span><span><ShieldCheck size={15} /> Local-first</span></div>
          <div className="marketing-hero-note"><FlaskConical size={15} /> กำลังพัฒนา · หน้าเว็บเป็นเพียงตัวอย่าง ไม่ได้เชื่อมบัญชี LINE จริง</div>
        </div>
        <ProductPreview onNavigate={onNavigate} />
      </section>

      <section className="marketing-proof-row marketing-container" aria-label="จุดเด่นของ Liney">
        <ProofItem icon={Code2} label="React + Tauri WebView" />
        <ProofItem icon={Zap} label="Bun + TypeScript engine" />
        <ProofItem icon={Database} label="SQLite local history" />
        <ProofItem icon={ShieldCheck} label="Independent project" />
      </section>

      <section className="marketing-section marketing-container" id="what-is-liney">
        <SectionHeading eyebrow="WHY LINEY?" title="LINE บน Linux ควรใช้งานได้อย่างเป็นธรรมชาติ" body="ไม่ใช่แค่เปิดหน้าต่างแชต แต่เป็น Client อิสระที่ออกแบบความลื่นไหล ข้อมูลในเครื่อง และการเชื่อมต่อให้เป็นส่วนหนึ่งของ Linux Desktop" />
        <div className="marketing-explain-grid">
          <ExplainCard number="01" icon={Monitor} title="UI ที่ใช้งานง่าย" body="หน้าแชตที่เน้นการอ่าน การตอบ และการเห็นสถานะจริงของข้อความ โดยไม่ซ่อนข้อจำกัดไว้หลัง mock interaction" />
          <ExplainCard number="02" icon={Database} title="ข้อมูลท้องถิ่นเป็นหลัก" body="SQLite เป็น source of truth สำหรับ cache, history และ outbox ทำให้เปิดดูข้อมูลเดิมได้แม้ network ไม่พร้อม" />
          <ExplainCard number="03" icon={Wifi} title="Engine ที่เปลี่ยนได้" body="LINEJS อยู่หลัง adapter และ versioned RPC boundary เพื่อไม่ให้ UI ผูกกับรายละเอียด protocol โดยตรง" />
        </div>
      </section>

      <section className="marketing-section marketing-section-soft" id="features">
        <div className="marketing-container">
          <SectionHeading eyebrow="DESIGNED FOR YOUR DESKTOP" title="รายละเอียดเล็กน้อยที่สำคัญในทุกวัน" body="ตั้งแต่การเปิดประวัติแชตจนถึงการส่งข้อความ Liney พยายามทำให้แต่ละขั้นตอนเข้ากับวิธีใช้ Linux จริง ๆ" />
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

      <section className="marketing-section marketing-container" id="roadmap">
        <div className="marketing-roadmap-intro">
          <SectionHeading eyebrow="DEVELOPMENT STATUS" title="กำลังสร้าง ไม่ได้แกล้งบอกว่าเสร็จแล้ว" body="Liney ยังอยู่ระหว่างพัฒนา ฟีเจอร์ในโค้ดกับฟีเจอร์ที่ทดสอบกับ LINE จริงอาจไม่เท่ากัน เราแยกสถานะไว้ให้เห็นชัด ๆ" />
          <a className="marketing-inline-link" href="#get-liney">ดูแผนการเผยแพร่ <ArrowRight size={16} /></a>
        </div>
        <div className="marketing-roadmap-grid">
          <article className="marketing-roadmap-card">
            <span className="marketing-roadmap-label"><CheckCircle2 size={16} /> มีในโค้ดแล้ว</span>
            <h3>ระบบแชตหลัก</h3>
            <p>หน้าต่างแชต, ประวัติใน SQLite, Media, Outbox, การจัดการ Session และการอ่านจาก Cache</p>
            <small>บางความสามารถยังต้องตรวจสอบกับ LINE Server จริง</small>
          </article>
          <article className="marketing-roadmap-card">
            <span className="marketing-roadmap-label experimental"><FlaskConical size={16} /> กำลังทดสอบ</span>
            <h3>เสียงและวิดีโอ</h3>
            <p>ระบบรับสาย/โทรออก, Native Audio, Video และ Screen Sharing สำหรับ Linux Desktop</p>
            <small>มี Implementation แต่ยังไม่ยืนยันว่าเสถียรสำหรับใช้งานประจำวัน</small>
          </article>
          <article className="marketing-roadmap-card">
            <span className="marketing-roadmap-label upcoming"><Clock3 size={16} /> ขั้นต่อไป</span>
            <h3>ความสมบูรณ์ของ Client</h3>
            <p>จัดการกลุ่ม, Notes และเติม UI ให้ความสามารถที่ Protocol รองรับ</p>
            <small>พร้อมตรวจสอบการเปลี่ยนแปลงของ LINEJS เป็นระยะ</small>
          </article>
        </div>
      </section>

      <section className="marketing-section marketing-section-download" id="get-liney">
        <div className="marketing-container marketing-download-layout">
          <div>
            <div className="marketing-kicker">GET INVOLVED</div>
            <h2>อยากลอง Liney บนเครื่องตัวเอง?</h2>
            <p>ตอนนี้ Liney ยังอยู่ในช่วง Developer Preview โดย Repository ยังเป็นส่วนตัว และยังไม่มี Public Release เรากำลังเตรียมแพ็กเกจและทดสอบฟีเจอร์ให้พร้อมก่อนเปิดให้ทดลอง</p>
            <div className="marketing-actions">
              <button className="marketing-primary-button" type="button" onClick={() => onNavigate("/chat")}>ลองหน้าแชตตัวอย่าง <ArrowRight size={17}/></button>
              <a className="marketing-secondary-button marketing-link-button" href="#roadmap"><Layers3 size={16}/> ดูสถานะโปรเจกต์</a>
            </div>
          </div>
          <div className="marketing-terminal" aria-label="ขั้นตอนเตรียมเผยแพร่ Liney">
            <div className="marketing-terminal-top"><span className="window-dots"><i/><i/><i/></span><span><Layers3 size={14}/> release checklist</span></div>
            <div className="marketing-terminal-body marketing-terminal-steps">
              <span><b>01</b> Desktop Client &amp; Local Engine</span>
              <span><b>02</b> QA · Security · Compatibility</span>
              <span><b>03</b> Linux Packages &amp; Release</span>
            </div>
            <div className="marketing-terminal-bottom"><FlaskConical size={14}/> กำลังพัฒนา · ไม่มีปุ่มดาวน์โหลดหรือหน้า Source สาธารณะในขณะนี้</div>

          </div>
        </div>
      </section>

      <section className="marketing-section marketing-container" id="faq">
        <SectionHeading eyebrow="GOOD TO KNOW" title="คำถามที่ควรรู้ก่อนลองใช้" body="ข้อมูลตรงไปตรงมาเกี่ยวกับการติดตั้ง ความเป็นอิสระ และข้อจำกัดที่ยังมีอยู่" />
        <div className="marketing-faq">
          <details><summary>Liney เป็น LINE ทางการหรือเปล่า? <ChevronDown size={18}/></summary><p>ไม่ใช่ Liney เป็นโครงการอิสระ ไม่ได้พัฒนาหรือรับรองโดย LY Corporation และใช้ Protocol ที่ไม่ได้รับรองอย่างเป็นทางการ</p></details>
          <details><summary>เว็บไซต์นี้ล็อกอิน LINE ได้จริงไหม? <ChevronDown size={18}/></summary><p>ไม่ได้ หน้าตัวอย่างแชตและล็อกอินเป็น Demo เท่านั้น การเชื่อมต่อบัญชีจริงเกิดใน Desktop Client ไม่ใช่เว็บไซต์นำเสนอนี้</p></details>
          <details><summary>ติดตั้งบน Linux ได้เลยหรือยัง? <ChevronDown size={18}/></summary><p>ยังไม่มี Public Release หรือ Repository สาธารณะสำหรับดาวน์โหลดในตอนนี้ หน้าเว็บให้ทดลองเฉพาะ UI Demo ไปก่อน</p></details>
          <details><summary>ใช้ Client อิสระมีความเสี่ยงอะไร? <ChevronDown size={18}/></summary><p>LINE อาจเปลี่ยน Private Protocol หรือข้อจำกัดการเข้าสู่ระบบ ทำให้ฟีเจอร์หยุดทำงานหรือบัญชีถูกจำกัดการใช้งานได้ ควรทดลองอย่างระมัดระวัง</p></details>
        </div>
      </section>

      <section className="marketing-cta marketing-container">
        <div>
          <div className="marketing-kicker">TAKE A LOOK AROUND</div>
          <h2>มาดูหน้าตา Liney กันก่อน</h2>
          <p>ทดลอง UI แบบโต้ตอบได้ในเบราว์เซอร์ โดยไม่มีการเชื่อมบัญชี LINE จริง</p>
        </div>
        <button className="marketing-primary-button" type="button" onClick={() => onNavigate("/chat")}>เข้าสู่ Demo <ArrowRight size={17} /></button>
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
  return (
    <footer className="marketing-footer">
      <div className="marketing-container marketing-footer-inner">
        <button className="marketing-footer-brand" type="button" onClick={() => onNavigate("/")}>
          <img src="/liney-mark.svg" alt="" />
          <span><strong>Liney</strong><small>An independent Linux desktop project</small></span>
        </button>
        <div className="marketing-footer-links">
          <a href="/#features">Features</a>
          <a href="/#roadmap">Roadmap</a>
          <a href="/#faq">FAQ</a>
        </div>
        <span className="marketing-footer-note">Made for the Linux community <Heart size={13}/><br/>Not affiliated with LY Corporation</span>
      </div>
    </footer>
  );
}
