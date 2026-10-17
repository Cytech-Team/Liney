const $ = (id) => document.getElementById(id);
const DEFAULT_URL = "http://127.0.0.1:39211/liney-runner";

function request(method, params = {}) {
  return chrome.runtime.sendMessage({ type: "liney.connector.request", method, params }).then((response) => {
    if (response?.ok) return response.result;
    const error = new Error(response?.error?.message || "Connector request failed");
    error.code = response?.error?.code;
    throw error;
  });
}

async function load() {
  try {
    const config = await request("connector.config.get");
    $("runner-url").value = config.url || DEFAULT_URL;
    $("runner-enabled").checked = config.enabled !== false;
    $("status").textContent = config.tokenConfigured ? "ตั้งค่า Local token แล้ว" : "ยังไม่ได้ตั้ง Local token";
  } catch (error) {
    $("runner-url").value = DEFAULT_URL;
    $("status").textContent = error.message || String(error);
  }
}

async function save() {
  const result = await request("connector.config.set", {
    url: $("runner-url").value.trim() || DEFAULT_URL,
    token: $("runner-token").value.trim(),
    enabled: $("runner-enabled").checked,
  });
  $("runner-token").value = "";
  $("status").textContent = result.tokenConfigured ? "บันทึกแล้ว" : "บันทึกแล้ว แต่ยังไม่มี token";
}

async function check() {
  const health = await request("connector.health");
  $("status").textContent = health.online ? `Local Engine online · pid ${health.status?.pid || "-"}` : `Local Engine offline · ${health.error || "not configured"}`;
}

$("save").addEventListener("click", () => save().catch((error) => { $("status").textContent = error.message || String(error); }));
$("check").addEventListener("click", () => check().catch((error) => { $("status").textContent = error.message || String(error); }));
$("open-app").addEventListener("click", () => chrome.tabs.create({ url: "https://liney.namnarak.in.th/app" }));
load();
