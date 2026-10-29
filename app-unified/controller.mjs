/**
 * Native presentation controller. No web API, DOM, Tauri or HTTP server.
 * Keeps UI-state derived from engine-owned cache/event data, never owns
 * LINE session, credentials or database files.
 */
import { randomUUID } from "node:crypto";
import { qrToNativeImage } from "./qr.mjs";

const COLORS = ["#d88ba8","#758dce","#d7a670","#59b8aa","#9b89c8","#75bd82"];
const MAX_VISIBLE_MESSAGES = 200;

function relativeTime(value) {
  const ms = Number(value ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms < 1e12 ? ms * 1000 : ms);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
}
function displayBody(item) {
  if (item.unsent) return "Message unsent";
  if (typeof item.text === "string" && item.text.length) return item.text;
  if (item.contentType === 1) return "📷 Photo";
  if (item.contentType === 2) return "🎬 Video";
  if (item.contentType === 7) return "Sticker";
  if (item.filename) return "📎 " + String(item.filename);
  return "Message";
}
function abbreviate(name) {
  return Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "L";
}
export function normalizeChat(chat, i = 0) {
  const name = String(chat.name || chat.displayName || "Unnamed conversation");
  return {
    id: String(chat.id || chat.chatId || ""),
    kind: String(chat.kind || "dm"),
    title: name,
    preview: String(chat.preview || chat.subtitle || "Tap to open conversation"),
    time: relativeTime(chat.lastMessageTime),
    avatar: abbreviate(name),
    unread: Math.max(0, Number(chat.unread || 0) | 0),
    pinned: Boolean(chat.pinned),
    selected: false,
    avatar_color: COLORS[i % COLORS.length],
  };
}
export function normalizeMessage(message) {
  return {
    id: String(message.id || message.localId || randomUUID()),
    body: displayBody(message),
    time: relativeTime(message.createdTime || Date.now()),
    sender: String(message.senderName || ""),
    mine: Boolean(message.isMine ?? (message.author === "me")),
    pending: String(message.status) === "sending",
    status: String(message.status || "sent"),
  };
}

export class ChatController {
  constructor({ window, slint, call, copyText = () => {} }) {
    this.ui = window;
    this.slint = slint;
    this.call = call;
    this.copyText = copyText;
    this.allChats = new Map();
    this.currentChat = null;
    this.currentMessageRequest = 0;
    this.query = "";
    this.filter = 0;
    this.chatModel = new slint.ArrayModel([]);
    this.messageModel = new slint.ArrayModel([]);
    window.chats = this.chatModel;
    window.messages = this.messageModel;
    window.select_chat = (id) => { void this.selectChat(id); };
    window.send_message = (body) => { void this.sendMessage(body); };
    window.refresh_chats = () => { void this.refreshChats(); };
    window.change_search = (q) => { this.query = String(q).toLowerCase(); this.renderChats(); };
    window.change_filter = (f) => { this.filter = Number(f); this.ui.active_filter = this.filter; this.renderChats(); };
    window.login_qr = () => { void this.loginWithQR(); };
    window.login_password = (email, password) => { void this.loginWithPassword(email, password); };
    window.change_auth_mode = (mode) => {
      this.ui.auth_mode = Number(mode);
      this.ui.auth_url = "";
      this.ui.auth_pin = "";
      this.ui.auth_error = "";
    };
    // The checkbox uses an in-out property so the value is already updated
    // before the callback fires: never toggle it a second time in JS.
    window.toggle_auth_risk = () => {};
    window.copy_auth_url = () => { if (this.ui.auth_url) this.copyText(this.ui.auth_url); };
    window.toggle_theme = () => { window.Theme.dark = !window.Theme.dark; };
  }
  setNotification(message) {
    this.ui.notification = String(message);
  }
  async start() {
    // Window is already running before this method is scheduled.
    const pong = await this.call("ping", {}, 12000);
    if (!pong?.pong || pong?.processId !== process.pid) throw Error("Native engine is not in the same process");
    this.ui.engine_status = "Engine ready";
    const capability = await this.call("capabilities", {}, 12000).catch(() => null);
    this.capabilitiesAvailable = typeof capability?.authenticated === "boolean";
    if (this.capabilitiesAvailable) this.ui.is_authenticated = capability.authenticated;
    await this.refreshChats();
    return pong;
  }
  renderChats() {
    const filtered = [...this.allChats.values()].filter(c =>
      (!this.query || c.title.toLowerCase().includes(this.query) || c.preview.toLowerCase().includes(this.query))
      && (this.filter !== 1 || c.unread > 0)
      && (this.filter !== 2 || c.kind === "group")
    );
    filtered.sort((a,b) => Number(b.pinned) - Number(a.pinned)); // preserve engine ordering
    const rendered = filtered.map(c => ({...c, selected: c.id === this.currentChat?.id}));
    const oldCount = this.chatModel.rowCount();
    if (oldCount === rendered.length) {
      for (let i=0;i<rendered.length;i++) {
        const old = this.chatModel.rowData(i);
        const next = rendered[i];
        if (JSON.stringify(old) !== JSON.stringify(next)) this.chatModel.setRowData(i,next);
      }
    } else {
      this.chatModel.splice(0, oldCount, ...rendered);
    }
    this.ui.cache_status = filtered.length ? "" : (this.allChats.size ? "No matching conversations" : "No conversations cached");
  }
  applyChats(chats) {
    if (!Array.isArray(chats)) return;
    const next = new Map();
    for (let i=0;i<chats.length;i++) {
      const base = normalizeChat(chats[i], i);
      if (!base.id) continue;
      const previous = this.allChats.get(base.id);
      if (previous) base.avatar_color = previous.avatar_color;
      next.set(base.id, base);
    }
    this.allChats = next;
    if (this.currentChat && this.allChats.has(this.currentChat.id)) {
      this.currentChat = this.allChats.get(this.currentChat.id);
      this.showActiveHeader();
    }
    this.renderChats();
  }
  async refreshChats() {
    try {
      const result = await this.call("chats.list", {}, 16000);
      this.applyChats(result);
      if (!this.capabilitiesAvailable)
        this.ui.is_authenticated = Array.isArray(result) && result.length > 0;
    } catch (error) {
      this.ui.engine_status = this.capabilitiesAvailable && !this.ui.is_authenticated
        ? "Engine ready" : "Disconnected";
      this.ui.cache_status = this.allChats.size ? "" : "Sign in with LINE to load your chats";
    }
  }
  showActiveHeader() {
    if (!this.currentChat) return;
    this.ui.has_active_chat = true;
    this.ui.active_chat_name = this.currentChat.title;
    this.ui.active_chat_avatar = this.currentChat.avatar;
    this.ui.active_chat_color = this.currentChat.avatar_color;
    this.ui.active_chat_subtitle = this.currentChat.kind === "group" ? "Group conversation" : this.currentChat.kind === "openchat" ? "OpenChat" : "Direct message";
  }
  async selectChat(id) {
    const c = this.allChats.get(String(id));
    if (!c) return;
    this.currentChat = c;
    this.showActiveHeader();
    this.renderChats();
    // Clear old chat immediately so it cannot leak into the next selection.
    this.messageModel.splice(0,this.messageModel.rowCount());
    const request = ++this.currentMessageRequest;
    try {
      const messages = await this.call("message.list", {chatId:c.id,kind:c.kind === "openchat" ? "openchat" : "talk",limit:100}, 18000);
      if (request !== this.currentMessageRequest) return;
      this.applyMessages(messages);
    } catch {
      if (request !== this.currentMessageRequest) return;
      this.setNotification("Couldn't load messages; check your connection");
    }
  }
  applyMessages(messages) {
    if (!Array.isArray(messages)) return;
    const normalized = messages.slice(-MAX_VISIBLE_MESSAGES).map(normalizeMessage);
    const previous = this.messageModel.rowCount();
    let overlap = 0;
    while (overlap < Math.min(previous,normalized.length)) {
      const row = this.messageModel.rowData(overlap);
      if (row?.id !== normalized[overlap].id) break;
      if (JSON.stringify(row) !== JSON.stringify(normalized[overlap]))
        this.messageModel.setRowData(overlap,normalized[overlap]);
      overlap++;
    }
    if (previous > overlap) this.messageModel.splice(overlap,previous-overlap);
    if (normalized.length > overlap) this.messageModel.splice(overlap,0,...normalized.slice(overlap));
  }
  async sendMessage(text) {
    const body = String(text || "").trim();
    if (!body || !this.currentChat) return;
    const chat = this.currentChat;
    const localId = randomUUID();
    this.ui.draft = "";
    this.messageModel.push(normalizeMessage({
      id: localId,text:body,isMine:true,createdTime:Date.now(),status:"sending"
    }));
    try {
      await this.call("message.send",{
        chatId:chat.id,kind:chat.kind === "openchat" ? "openchat" : "talk",
        text:body,localId,createdAt:Date.now()
      },35000);
      this.updatePending(localId,"sent");
    } catch {
      this.updatePending(localId,"error");
      this.setNotification("Message not delivered; retained in local outbox");
    }
  }
  updatePending(id,status) {
    for (let i=0;i<this.messageModel.rowCount();i++) {
      const item=this.messageModel.rowData(i);
      if (item?.id === id) this.messageModel.setRowData(i,{...item,pending:false,status});
    }
  }
  async loginWithQR() {
    if (!this.ui.auth_risk_acknowledged || this.ui.auth_busy) return;
    this.ui.auth_busy = true;
    this.ui.auth_error = "";
    this.ui.engine_status = "กำลังสร้าง QR Code";
    try {
      const result = await this.call("auth.qr.start",{},120000);
      if (result?.authenticated) {
        this.ui.is_authenticated = true;
        await this.refreshChats();
      }
    } catch {
      this.ui.auth_error = "สร้าง QR Code ไม่สำเร็จ กรุณาลองใหม่";
      this.ui.engine_status = "Engine ready";
    } finally {
      this.ui.auth_busy = false;
    }
  }
  async loginWithPassword(email, password) {
    if (!this.ui.auth_risk_acknowledged || this.ui.auth_busy) return;
    const address = String(email).trim();
    const secret = String(password);
    if (!address || !secret) return;
    this.ui.auth_busy = true;
    this.ui.auth_error = "";
    // Clear the UI password promptly; credentials must never be logged.
    const login = this.call("auth.password.start", {email: address, password: secret}, 120000);
    this.ui.auth_password = "";
    try {
      await login;
    } catch {
      this.ui.auth_error = "ไม่สามารถเข้าสู่ระบบได้ โปรดตรวจสอบบัญชีหรือการยืนยันบนมือถือ";
    } finally {
      this.ui.auth_busy = false;
    }
  }
  handleEvent(packet) {
    if (!packet || typeof packet.type !== "string") return;
    const { type, payload = {} }=packet;
    if (type === "auth.qr" && typeof payload.url === "string") {
      try {
        this.ui.auth_qr = qrToNativeImage(payload.url);
        this.ui.auth_url = payload.url;
      } catch {
        this.ui.engine_status = "QR generation failed";
      }
    }
    if (type === "auth.pin") this.ui.auth_pin = String(payload.pin || "");
    if (type === "auth.ready") {
      this.ui.is_authenticated = true;
      this.ui.auth_url = "";
      this.ui.auth_pin = "";
      this.ui.auth_password = "";
      this.ui.auth_busy = false;
      this.ui.auth_error = "";
      this.ui.engine_status = "Engine ready";
      void this.refreshChats();
    }
    if (type === "auth.logged_out") {
      this.ui.is_authenticated=false;
      this.allChats.clear();
      this.currentChat=null;
      this.ui.has_active_chat=false;
      this.messageModel.splice(0,this.messageModel.rowCount());
      this.renderChats();
    }
    if (type === "event.chats.updated" && Array.isArray(payload.chats)) this.applyChats(payload.chats);
    if ((type === "event.messages.updated" || type === "event.message.updated")
      && String(payload.chatId ?? "") === this.currentChat?.id && Array.isArray(payload.messages))
      this.applyMessages(payload.messages);
    if (type === "message.sent" && payload.localId) this.updatePending(payload.localId,"sent");
    if (type === "message.failed" && payload.localId) this.updatePending(payload.localId,"error");
  }
}
