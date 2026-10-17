(() => {
  "use strict";

  const ENDPOINT = "http://127.0.0.1:39211/liney-runner/health";
  const $ = (id) => document.getElementById(id);
  const results = new Map();
  const required = new Set(["secure", "storage", "crypto", "workers", "local"]);
  const labels = { pass: "ผ่าน", warn: "ต้องตรวจเพิ่มเติม", fail: "ไม่ผ่าน" };
  const icons = { pass: "✓", warn: "?", fail: "×" };
  const ua = navigator.userAgent || "";
  const isChromeOS = /\bCrOS\b/i.test(ua);
  const isChromium = /\b(?:Chrome|Chromium|Edg)\/\d+/i.test(ua);
  let running = false;

  function entry(id, label, status, detail) {
    results.set(id, { id, label, status, detail });
    render();
  }

  function render() {
    const out = $("check-results");
    const safe = (str) => {
      const el = document.createElement("span");
      el.textContent = String(str);
      return el.innerHTML;
    };
    out.innerHTML = Array.from(results.values()).map((r) =>
      '<article class="compat-result '+r.status+'" role="listitem">'+
      '<span class="result-icon" aria-hidden="true">'+icons[r.status]+'</span>'+
      '<div class="result-body"><h3>'+safe(r.label)+'</h3><p>'+safe(r.detail)+'</p></div>'+
      '<strong class="result-status">'+labels[r.status]+'</strong></article>'
    ).join("");
    const counts = { pass: 0, warn: 0, fail: 0 };
    for (const result of results.values()) counts[result.status]++;
    $("check-pass").textContent = counts.pass + " ผ่าน";
    $("check-warn").textContent = counts.warn + " ต้องตรวจเพิ่ม";
    $("check-fail").textContent = counts.fail + " ไม่ผ่าน";
    const done = results.size;
    $("check-progress").style.width = Math.round(done / 12 * 100) + "%";
    // The entire LINE login is never certified by a browser capability probe.
    const blockers = [...required].filter((name) => results.get(name)?.status === "fail");
    if (blockers.length) {
      $("check-headline").textContent = "พบข้อจำกัดที่ต้องแก้";
      $("check-subtitle").textContent = "มีความสามารถจำเป็นบางอย่างที่ทดสอบไม่ผ่าน โปรดดูรายละเอียดก่อนเปิด LINE Web";
    } else if (results.get("local")?.status === "pass") {
      $("check-headline").textContent = "พร้อมเชื่อม Local Engine";
      $("check-subtitle").textContent = "พบ Engine ที่เครื่องนี้แล้ว แต่ยังต้องล็อกอินและทดสอบส่ง/รับกับ LINE จริง";
    } else {
      $("check-headline").textContent = "ตรวจพื้นฐานแล้ว";
      $("check-subtitle").textContent = "กดทดสอบ Local Engine เพื่อตรวจสิทธิ์การเชื่อมต่อและการทำงานจริง";
    }
  }

  async function testIndexedDB() {
    if (!window.indexedDB) throw Error("IndexedDB ไม่พร้อมใช้งาน");
    const name = "liney-compat-check-" + Math.random().toString(36).slice(2);
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("probe");
      request.onerror = () => reject(request.error || Error("สร้างฐานข้อมูลไม่ได้"));
      request.onsuccess = () => {
        const db = request.result;
        try {
          const tx = db.transaction("probe", "readwrite");
          const store = tx.objectStore("probe");
          store.put("works", "probe");
          tx.onerror = () => reject(tx.error || Error("เขียนข้อมูลไม่ได้"));
          tx.oncomplete = () => {
            const verify = db.transaction("probe", "readonly").objectStore("probe").get("probe");
            verify.onerror = () => reject(verify.error || Error("อ่านข้อมูลไม่ได้"));
            verify.onsuccess = () => {
              db.close();
              const remove = indexedDB.deleteDatabase(name);
              remove.onsuccess = () => verify.result === "works" ? resolve() : reject(Error("อ่านค่าไม่ตรง"));
              remove.onerror = () => reject(Error("ลบข้อมูลทดสอบไม่ได้"));
            };
          };
        } catch (e) { db.close(); reject(e); }
      };
    });
  }

  async function testOPFS() {
    if (!navigator.storage?.getDirectory) throw Error("ไม่มี OPFS");
    const root = await navigator.storage.getDirectory();
    const name = "liney-probe-" + Math.random().toString(36).slice(2);
    try {
      const file = await root.getFileHandle(name, { create: true });
      const writable = await file.createWritable();
      await writable.write("Liney");
      await writable.close();
      const read = await (await file.getFile()).text();
      if (read !== "Liney") throw Error("อ่านค่าที่บันทึกไม่ได้");
    } finally {
      await root.removeEntry(name).catch(() => {});
    }
  }

  async function queryPermission(name) {
    if (!navigator.permissions?.query) return "unknown";
    try {
      const permission = await navigator.permissions.query({ name });
      return permission.state || "unknown";
    } catch { return "unknown"; }
  }

  async function runBasicChecks() {
    if (running) return;
    running = true;
    $("check-basic").disabled = true;
    try {
      results.clear();
      entry("secure", "HTTPS / Secure Context",
        window.isSecureContext ? "pass" : "fail",
        window.isSecureContext ? "หน้าเว็บปลอดภัยพอสำหรับ API ที่ต้องใช้สิทธิ์" : "ต้องเข้าเว็บไซต์ผ่าน HTTPS");
      entry("device", "เบราว์เซอร์และ ChromeOS", "warn",
        isChromeOS ? "พบลักษณะของ ChromeOS แต่ยืนยันนโยบาย Workspace Admin จากเว็บไม่ได้" :
        isChromium ? "ตรวจพบเบราว์เซอร์ Chromium; ไม่สามารถอ่านสิทธิ์ Admin ทั้งหมดได้" :
        "ไม่พบ Chromium/ChromeOS จากข้อมูลที่เบราว์เซอร์เปิดเผย โปรดตรวจความเข้ากันได้ด้วยตนเอง");
      entry("pwa", "ติดตั้งและเปิดแบบ PWA", ("serviceWorker" in navigator && "caches" in window) ? "pass" : "warn",
        ("serviceWorker" in navigator && "caches" in window) ?
          "รองรับ Service Worker และ Cache API (ยังไม่ยืนยันว่า Admin อนุญาตติดตั้ง)" :
          "เบราว์เซอร์ไม่เปิด API ที่ PWA ต้องการครบ");
      entry("crypto", "Web Crypto / SHA-256", "warn", "กำลังทดสอบการเข้ารหัสในเครื่อง");
      entry("workers", "Web Workers / WASM", "warn", "กำลังตรวจความพร้อม");
      entry("storage", "IndexedDB อ่านและเขียนจริง", "warn", "กำลังทดลองบันทึกและลบข้อมูลทดสอบในเครื่อง");
      entry("opfs", "OPFS พื้นที่เก็บไฟล์", "warn", "กำลังตรวจความพร้อม");
      entry("quota", "พื้นที่และการคงข้อมูล", "warn", "กำลังอ่านโควตา");
      entry("policy", "Workspace / Enterprise Admin", "warn", "เว็บไซต์ทั่วไปไม่สามารถอ่านนโยบาย Admin ทั้งหมดได้ ต้องทดสอบตามสิทธิ์จริง");
      entry("media", "ไมโครโฟนและกล้อง (สำหรับการโทร)", "warn", "กำลังอ่านความสามารถและสิทธิ์");
      entry("notify", "สิทธิ์แจ้งเตือน", "warn", "กำลังอ่านการตั้งค่า");
      if (!results.has("local")) entry("local", "Local Engine / Local Network", "warn", "ยังไม่ทดสอบ กดปุ่มทดสอบด้านบนเพื่อขอสิทธิ์ถ้าจำเป็น");

      try {
        if (!crypto?.subtle?.digest) throw Error("SubtleCrypto ไม่มี");
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode("Liney"));
        entry("crypto", "Web Crypto / SHA-256", "pass", "สามารถประมวลผลการเข้ารหัสผ่าน Web Crypto ในเบราว์เซอร์");
      } catch { entry("crypto", "Web Crypto / SHA-256", "fail", "Web Crypto ใช้งานจริงไม่ได้"); }
      entry("workers", "Web Workers / WASM", typeof Worker === "function" && typeof WebAssembly === "object" ? "pass" : "warn",
        typeof Worker === "function" && typeof WebAssembly === "object" ?
          "พบทั้ง Web Worker และ WebAssembly (ไม่ใช่การยืนยันว่า LINEJS รันในเบราว์เซอร์ได้)" :
          "ขาด Web Worker หรือ WebAssembly บางส่วน");
      try {
        await testIndexedDB();
        entry("storage", "IndexedDB อ่านและเขียนจริง", "pass", "สร้าง เขียน อ่าน และลบข้อมูลทดลองได้สำเร็จ");
      } catch {
        entry("storage", "IndexedDB อ่านและเขียนจริง", "fail", "ทดสอบเขียนหรืออ่านไม่ได้ อาจถูกตั้งค่าเบราว์เซอร์หรือ Admin จำกัด");
      }
      try {
        await testOPFS();
        entry("opfs", "OPFS พื้นที่เก็บไฟล์", "pass", "ทดสอบสร้าง อ่าน เขียนและลบไฟล์ได้");
      } catch {
        entry("opfs", "OPFS พื้นที่เก็บไฟล์", "warn", "OPFS ยังใช้ไม่ได้ หรือสิทธิ์/เบราว์เซอร์ไม่อนุญาต");
      }
      try {
        const storage = navigator.storage;
        if (!storage?.estimate) throw Error("Storage API ไม่พร้อม");
        const { usage, quota } = await storage.estimate();
        const persistent = storage.persisted ? await storage.persisted().catch(() => false) : false;
        const approx = typeof quota === "number" ? "~" + Math.round(quota / 1024 / 1024) + " MiB quota" : "ไม่พบขนาด quota";
        entry("quota", "พื้นที่และการคงข้อมูล", "pass",
          approx + "; ใช้อยู่ " + (typeof usage === "number" ? "~" + Math.round(usage / 1024 / 1024) + " MiB" : "ไม่ทราบ") +
          "; Persistent: " + (persistent ? "ใช่" : "ยังไม่เปิด/ไม่ได้อนุญาต") + " — ค่าเหล่านี้เป็นการประเมิน ไม่ใช่พื้นที่ที่รับประกัน");
      } catch {
        entry("quota", "พื้นที่และการคงข้อมูล", "warn", "อ่านโควตาไม่ได้ ต้องตรวจพื้นที่ด้วยเบราว์เซอร์เอง");
      }
      const mic = await queryPermission("microphone");
      const camera = await queryPermission("camera");
      const hasMedia = Boolean(navigator.mediaDevices?.getUserMedia);
      entry("media", "ไมโครโฟนและกล้อง (สำหรับการโทร)",
        !hasMedia ? "fail" : mic === "granted" && camera === "granted" ? "pass" : "warn",
        !hasMedia ? "เบราว์เซอร์ไม่มี MediaDevices สำหรับเรียกไมค์/กล้อง" :
        "สิทธิ์ไมค์: " + (mic === "unknown" ? "ตรวจไม่ได้" : mic) +
        "; กล้อง: " + (camera === "unknown" ? "ตรวจไม่ได้" : camera) +
        " — ยังไม่ได้เปิดใช้อุปกรณ์จริง และไม่จำเป็นสำหรับการแชตข้อความ");
      const notifications = window.Notification?.permission;
      entry("notify", "สิทธิ์แจ้งเตือน",
        notifications === "granted" ? "pass" : "warn",
        notifications === "granted" ? "เบราว์เซอร์อนุญาตแล้ว (ไม่รับประกันแจ้งเตือนตอนปิด PWA)" :
        notifications === "denied" ? "สิทธิ์แจ้งเตือนถูกปฏิเสธ" :
        notifications === "default" ? "ยังไม่ได้ขอสิทธิ์แจ้งเตือนจากผู้ใช้" :
        "ไม่พบ Notification API หรือไม่อนุญาตให้เว็บไซต์อ่านสถานะ");
      const perm = await queryPermission("loopback-network");
      entry("policy", "Workspace / Enterprise Admin", "warn",
        (perm === "denied" ? "สิทธิ์ Loopback ถูกปฏิเสธ อาจเป็นค่าที่ตั้งไว้หรือ Admin จำกัด; " :
          perm === "granted" ? "เบราว์เซอร์รายงานว่าอนุญาต Loopback Network; " :
          perm === "prompt" ? "Loopback Network ยังรอการอนุญาต; " : "") +
        "ไม่สามารถตรวจนโยบาย Workspace ทั้งหมดจากเว็บไซต์ได้");
    } finally {
      running = false;
      $("check-basic").disabled = false;
    }
  }

  async function checkLocalEngine() {
    if ($("check-connection").disabled) return;
    $("check-connection").disabled = true;
    entry("local", "Local Engine / Local Network", "warn", "กำลังขอการเชื่อมต่อไปยัง 127.0.0.1 บนเครื่องนี้…");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(ENDPOINT, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        targetAddressSpace: "loopback",
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || data.mode !== "local-device" || data.transport !== "loopback") {
        entry("local", "Local Engine / Local Network", "fail", "มีบริการตอบกลับ แต่ไม่ใช่ Liney Local Engine ที่กำหนด กรุณาตรวจโปรแกรมในเครื่อง");
      } else {
        entry("local", "Local Engine / Local Network", "pass", "พบ Liney Local Engine บนเครื่องนี้แล้ว (ยังไม่ได้ทดสอบ QR Login/ส่งข้อความจริง)");
      }
    } catch {
      entry("local", "Local Engine / Local Network", "warn",
        "ยังเชื่อมไม่ได้: Engine อาจไม่ได้เปิดอยู่, Chrome ยังไม่ได้รับสิทธิ์ Loopback หรือ Workspace Admin จำกัดเครือข่าย ลองเปิด Engine และตรวจ Site Settings");
    } finally {
      clearTimeout(timer);
      $("check-connection").disabled = false;
    }
  }

  async function copyReport() {
    // No account, token, hardware identifier, full UA or network address is included.
    const lines = [
      "Liney Device Compatibility Check",
      "Generated locally — no LINE account information",
      ...Array.from(results.values(), ({label,status,detail}) => label + ": " + labels[status] + " — " + detail),
      "Note: Workspace Admin policies are not fully readable from ordinary webpages.",
      "Note: This does not certify actual LINE login, chat or calling.",
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      $("copy-status").textContent = "คัดลอกรายงานแล้ว";
    } catch {
      $("copy-status").textContent = "คัดลอกอัตโนมัติไม่ได้ กรุณาอนุญาต Clipboard ในเบราว์เซอร์";
    }
  }

  $("check-basic").addEventListener("click", () => void runBasicChecks());
  $("check-connection").addEventListener("click", () => void checkLocalEngine());
  $("copy-report").addEventListener("click", () => void copyReport());
  void runBasicChecks();
})();
