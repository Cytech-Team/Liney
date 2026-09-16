(function () {
  "use strict";

  var DB_NAME = "liney-web-vault";
  var DB_VERSION = 1;
  var STORE = "kv";
  var state = {
    unlocked: false,
    key: null,
    profileId: "",
    profiles: [],
    chats: [],
    messages: {},
    activeChatId: "",
    view: "chats"
  };

  function $(id) { return document.getElementById(id); }
  function now() { return Date.now(); }
  function text(value) { return String(value == null ? "" : value); }
  function initials(name) { return (text(name).trim().match(/[\p{L}\p{N}]/u) || ["L"])[0].toUpperCase(); }
  function timeLabel(ts) { return new Intl.DateTimeFormat("th-TH", { hour: "2-digit", minute: "2-digit" }).format(new Date(ts || now())); }
  function bytesToBase64(bytes) { var s = ""; bytes.forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s); }
  function base64ToBytes(value) { return Uint8Array.from(atob(value), function (c) { return c.charCodeAt(0); }); }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function dbGet(key) {
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readonly");
      var req = tx.objectStore(STORE).get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function dbSet(key, value) {
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }
  async function dbDel(key) {
    var db = await openDb();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function deriveKey(pass, salt) {
    var material = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 210000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function encryptJson(key, value) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var raw = new TextEncoder().encode(JSON.stringify(value));
    var cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, raw));
    return { iv: bytesToBase64(iv), data: bytesToBase64(cipher) };
  }
  async function decryptJson(key, record) {
    var iv = base64ToBytes(record.iv);
    var data = base64ToBytes(record.data);
    var plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, data);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function defaultVault(profileName) {
    var chatId = "liney-system";
    return {
      version: 1,
      profile: { id: crypto.randomUUID(), name: profileName || "Liney Web", label: "Liney-Website", createdAt: now() },
      chats: [
        { id: chatId, name: "Liney System", subtitle: "Web App พร้อมใช้งานใน browser นี้", updatedAt: now() }
      ],
      messages: {
        "liney-system": [
          { id: crypto.randomUUID(), author: "them", text: "Vault ถูกสร้างใน browser นี้แล้ว ข้อมูลหน้านี้ไม่ถูกส่งไปเก็บเป็น inbox กลางของ Liney", createdAt: now() },
          { id: crypto.randomUUID(), author: "them", text: "ขั้นต่อไปคือเชื่อม LINE session ผ่าน Worker relay โดยยังไม่เก็บ password/message database บน server", createdAt: now() }
        ]
      }
    };
  }

  async function saveVault() {
    if (!state.key || !state.profileId) return;
    var vault = {
      version: 1,
      profile: state.profiles.find(function (p) { return p.id === state.profileId; }) || state.profiles[0],
      chats: state.chats,
      messages: state.messages
    };
    await dbSet("vault:" + state.profileId, await encryptJson(state.key, vault));
    await dbSet("profiles", state.profiles.map(function (p) { return { id: p.id, name: p.name, label: p.label, createdAt: p.createdAt, updatedAt: now() }; }));
  }

  async function loadProfiles() {
    state.profiles = await dbGet("profiles") || [];
  }

  async function unlock(profileName, pass) {
    if (!pass || pass.length < 4) throw new Error("รหัส vault ต้องอย่างน้อย 4 ตัว");
    await loadProfiles();
    var target = state.profiles.find(function (p) { return p.name.toLowerCase() === profileName.toLowerCase(); }) || state.profiles[0];
    var created = false;
    if (!target) {
      target = { id: crypto.randomUUID(), name: profileName || "Liney Web", label: "Liney-Website", createdAt: now() };
      state.profiles.push(target);
      created = true;
    }
    var saltKey = "salt:" + target.id;
    var salt = await dbGet(saltKey);
    if (!salt) {
      salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
      await dbSet(saltKey, salt);
    }
    var key = await deriveKey(pass, base64ToBytes(salt));
    var record = await dbGet("vault:" + target.id);
    var vault;
    if (record) vault = await decryptJson(key, record);
    else vault = defaultVault(target.name);
    if (created && vault.profile) {
      vault.profile.id = target.id;
      vault.profile.name = target.name;
    }
    state.key = key;
    state.unlocked = true;
    state.profileId = vault.profile.id;
    target.id = vault.profile.id;
    target.name = vault.profile.name || target.name;
    target.label = vault.profile.label || target.label || "Liney-Website";
    state.chats = Array.isArray(vault.chats) ? vault.chats : [];
    state.messages = vault.messages || {};
    state.activeChatId = state.chats[0] ? state.chats[0].id : "";
    await saveVault();
  }

  function setRuntime(ok, title, copy) {
    $("runtime-dot").className = "status-dot " + (ok ? "ok" : "bad");
    $("runtime-title").textContent = title;
    $("runtime-copy").textContent = copy;
  }

  async function checkRuntime() {
    var browserOk = Boolean(window.crypto && crypto.subtle && window.indexedDB);
    if (!browserOk) {
      setRuntime(false, "Browser นี้ไม่รองรับ vault", "ต้องใช้ browser ที่มี IndexedDB และ WebCrypto");
      return;
    }
    try {
      var response = await fetch("/api/runtime", { cache: "no-store" });
      if (response.ok) {
        var data = await response.json();
        setRuntime(true, data.name || "Liney Web Runtime", data.mode || "Browser vault พร้อมใช้งาน");
      } else setRuntime(true, "Browser vault พร้อม", "Relay ยังไม่เปิด แต่ Web App ใช้ local vault ได้");
    } catch {
      setRuntime(true, "Browser vault พร้อม", "Relay ยังไม่เปิด แต่ Web App ใช้ local vault ได้");
    }
  }

  function renderProfiles() {
    var root = $("profile-list");
    root.hidden = !state.unlocked;
    root.innerHTML = "";
    state.profiles.forEach(function (profile) {
      var card = document.createElement("article");
      card.className = "profile-card" + (profile.id === state.profileId ? " active" : "");
      card.innerHTML = "<strong></strong><span></span><button class='web-primary' type='button'></button>";
      card.querySelector("strong").textContent = profile.name;
      card.querySelector("span").textContent = profile.label || "Liney-Website";
      var button = card.querySelector("button");
      button.textContent = profile.id === state.profileId ? "กำลังใช้งาน" : "สลับบัญชี";
      button.disabled = profile.id === state.profileId;
      button.addEventListener("click", function () { toast("ล็อกก่อนแล้วเปิด vault ของบัญชีนี้ด้วยรหัสของมัน"); });
      root.appendChild(card);
    });
  }

  function renderChats() {
    var list = $("chat-list");
    var q = $("chat-search").value.trim().toLowerCase();
    list.innerHTML = "";
    var chats = state.chats.filter(function (chat) { return !q || (chat.name + " " + chat.subtitle).toLowerCase().includes(q); });
    if (!chats.length) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = state.unlocked ? "ยังไม่มีแชต" : "เปิด vault ก่อน";
      list.appendChild(empty);
      return;
    }
    chats.forEach(function (chat) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "web-chat-item" + (chat.id === state.activeChatId ? " active" : "");
      button.innerHTML = "<span class='web-chat-avatar'></span><span class='web-chat-copy'><strong></strong><span></span></span><span class='web-chat-time'></span>";
      button.querySelector(".web-chat-avatar").textContent = initials(chat.name);
      button.querySelector("strong").textContent = chat.name;
      button.querySelector(".web-chat-copy span").textContent = chat.subtitle || "";
      button.querySelector(".web-chat-time").textContent = chat.updatedAt ? timeLabel(chat.updatedAt) : "";
      button.addEventListener("click", function () { state.activeChatId = chat.id; render(); });
      list.appendChild(button);
    });
  }

  function renderConversation() {
    var chat = state.chats.find(function (item) { return item.id === state.activeChatId; });
    var stage = $("message-stage");
    stage.innerHTML = "";
    $("composer-input").disabled = !state.unlocked || !chat;
    $("send-button").disabled = !state.unlocked || !chat;
    if (!chat) {
      $("conversation-title").textContent = state.unlocked ? "สร้างหรือเลือกแชต" : "เปิด vault ก่อน";
      $("conversation-subtitle").textContent = state.unlocked ? "กด + เพื่อสร้างห้อง local" : "ข้อมูลจะอยู่ใน browser นี้";
      $("conversation-avatar").textContent = "L";
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = state.unlocked ? "ยังไม่มีห้อง" : "เข้าใช้งานเพื่อเปิด Web App";
      stage.appendChild(empty);
      return;
    }
    $("conversation-title").textContent = chat.name;
    $("conversation-subtitle").textContent = chat.subtitle || "Liney Web";
    $("conversation-avatar").textContent = initials(chat.name);
    (state.messages[chat.id] || []).forEach(function (message) {
      var bubble = document.createElement("div");
      bubble.className = "message " + (message.author === "me" ? "me" : "them");
      bubble.textContent = message.text;
      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = timeLabel(message.createdAt);
      bubble.appendChild(meta);
      stage.appendChild(bubble);
    });
    stage.scrollTop = stage.scrollHeight;
  }

  function renderDrawer(view) {
    var drawer = $("web-drawer");
    var content = $("drawer-content");
    if (view === "accounts") {
      content.innerHTML = "<h2>บัญชีใน browser นี้</h2><p>Web App รองรับการแยก vault ต่อผู้ใช้ในเครื่องนี้ ตอนสลับผู้ใช้ให้กดล็อกแล้วเปิด vault อีกชื่อ</p><div class='profile-list' id='drawer-profiles'></div>";
      var target = content.querySelector("#drawer-profiles");
      state.profiles.forEach(function (profile) {
        var card = document.createElement("article");
        card.className = "profile-card" + (profile.id === state.profileId ? " active" : "");
        card.innerHTML = "<strong></strong><span></span>";
        card.querySelector("strong").textContent = profile.name;
        card.querySelector("span").textContent = profile.label || "Liney-Website";
        target.appendChild(card);
      });
    } else if (view === "security") {
      content.innerHTML = "<h2>ความปลอดภัย</h2><article class='security-card'><strong>ข้อมูลที่เก็บใน browser</strong><ul><li>profiles: " + state.profiles.length + "</li><li>chats: " + state.chats.length + "</li><li>vault: AES-GCM + PBKDF2</li><li>server inbox: none</li></ul></article><button class='web-primary' data-action='clear-vault' type='button'>ล้าง vault ของบัญชีนี้</button>";
    }
    drawer.hidden = false;
  }

  function render() {
    document.querySelector(".liney-web-shell").dataset.state = state.unlocked ? "ready" : "locked";
    $("unlock-card").hidden = state.unlocked;
    var active = state.profiles.find(function (p) { return p.id === state.profileId; });
    $("client-label").textContent = active && active.label ? active.label : "Liney-Website";
    renderProfiles();
    renderChats();
    renderConversation();
  }

  async function addChat() {
    if (!state.unlocked) return toast("เปิด vault ก่อน");
    var name = prompt("ชื่อแชต");
    if (!name) return;
    var chat = { id: crypto.randomUUID(), name: name.trim(), subtitle: "local web chat", updatedAt: now() };
    state.chats.unshift(chat);
    state.messages[chat.id] = [{ id: crypto.randomUUID(), author: "them", text: "ห้องนี้อยู่ใน Web vault ของ browser นี้", createdAt: now() }];
    state.activeChatId = chat.id;
    await saveVault();
    render();
  }

  async function sendMessage(value) {
    var chat = state.chats.find(function (item) { return item.id === state.activeChatId; });
    if (!chat || !value.trim()) return;
    var list = state.messages[chat.id] || [];
    list.push({ id: crypto.randomUUID(), author: "me", text: value.trim(), createdAt: now(), client: "Liney-Website" });
    state.messages[chat.id] = list;
    chat.subtitle = value.trim();
    chat.updatedAt = now();
    state.chats = [chat].concat(state.chats.filter(function (item) { return item.id !== chat.id; }));
    await saveVault();
    $("composer-input").value = "";
    render();
  }

  async function clearVault() {
    if (!state.profileId || !confirm("ล้าง vault ของบัญชีนี้ใน browser นี้?")) return;
    await dbDel("vault:" + state.profileId);
    state.profiles = state.profiles.filter(function (p) { return p.id !== state.profileId; });
    await dbSet("profiles", state.profiles);
    lock();
    toast("ล้างแล้ว");
  }

  function lock() {
    state.unlocked = false;
    state.key = null;
    state.profileId = "";
    state.chats = [];
    state.messages = {};
    state.activeChatId = "";
    $("web-drawer").hidden = true;
    render();
  }

  function toast(message) {
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2400);
  }

  function bind() {
    $("unlock-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      try {
        await unlock($("profile-name").value.trim(), $("vault-pass").value);
        $("vault-pass").value = "";
        render();
      } catch (error) { toast(error.message || String(error)); }
    });
    $("composer-form").addEventListener("submit", function (event) {
      event.preventDefault();
      void sendMessage($("composer-input").value);
    });
    $("chat-search").addEventListener("input", renderChats);
    document.addEventListener("click", function (event) {
      var action = event.target.closest("[data-action]") && event.target.closest("[data-action]").getAttribute("data-action");
      var view = event.target.closest("[data-view]") && event.target.closest("[data-view]").getAttribute("data-view");
      if (view === "accounts" || view === "security") renderDrawer(view);
      if (view === "chats") { $("web-drawer").hidden = true; }
      if (action === "lock") lock();
      if (action === "new-chat") void addChat();
      if (action === "drawer-close") $("web-drawer").hidden = true;
      if (action === "clear-vault") void clearVault();
    });
  }

  document.addEventListener("DOMContentLoaded", async function () {
    bind();
    await loadProfiles();
    await checkRuntime();
    render();
  });
})();
