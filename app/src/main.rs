mod composer_media;
mod engine;
mod models;
mod settings;
mod state;
mod theme;
mod ui;

use state::{Capabilities, ListFilter, Pending, Section, State, TrayCommand, LineyTray};
use ui::chat_list::{chat_row, maybe_select_first_chat, open_chat, render_sidebar, update_chat_preview};
use ui::message_list::{
    flex_bubble_widget, flex_message_widget, flex_node_widget, hydrate_message_assets,
    maybe_jump_to_message, message_row, perform_flex_action, post_notification_widget,
    render_messages, rich_message_widget, scroll_messages_to_bottom, wrap_flex_action,
};
use ui::dialogs::{confirm_action, notify, show_account, show_qr, show_settings};
use ui::shell::build_ui;
use ui::helpers::{
    avatar_widget, composer_text, flex_spacing, icon_button, is_arranged_sticker_url,
    is_safe_external_uri, logo_widget, media_type, message_time, new_local_id, now_ms, numeric_leq,
    open_safe_uri, picture_from_data_url, pixbuf_from_data_url, reaction_icon, set_image_async,
    set_picture_async, small_button, sticker_candidate_urls, SEND_SEQUENCE,
};

use engine::EngineBridge;
use gtk4 as gtk;
use gtk::gio;
use gtk::glib;
use gtk::prelude::*;
use gtk::glib::variant::ToVariant;
use models::{AudioDevice, Chat, LineEmoji, Message, Profile, Reaction, ReplyTarget, Sticker};
use qrcode::QrCode;
use serde_json::{json, Value};
use settings::AppSettings;
use std::{
    cell::RefCell,
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{atomic::Ordering, mpsc},
    time::{Duration, Instant},
};

const APP_ID: &str = "dev.liney.desktop";

fn main() {
    let app = gtk::Application::builder().application_id(APP_ID).build();
    app.connect_activate(|app| {
        if let Some(window) = app.active_window() {
            window.present();
            return;
        }
        build_ui(app);
    });
    app.run();
}

fn handle_engine_message(state: &Rc<RefCell<State>>, event: Value) {
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default().to_owned();
    if !event_type.is_empty() {
        handle_engine_event(state, &event_type, &event);
        return;
    }
    let id = event.get("id").and_then(Value::as_u64).or_else(|| event.get("id").and_then(Value::as_str).and_then(|s| s.parse().ok()));
    let Some(id) = id else { return };
    let request = state.borrow_mut().pending.remove(&id);
    let Some(request) = request else { return };
    if event.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = event.pointer("/error/message").and_then(Value::as_str).unwrap_or("คำสั่ง LINE ไม่สำเร็จ").to_owned();
        handle_request_error(state, request.action, &message);
        return;
    }
    let result = event.get("result").cloned().unwrap_or(Value::Null);
    handle_request_success(state, request.action, result);
}

fn handle_engine_event(state: &Rc<RefCell<State>>, kind: &str, event: &Value) {
    let payload = event.get("payload").filter(|v| v.is_object()).unwrap_or(event);
    match kind {
        "engine.ready" => {
            let mut app = state.borrow_mut();
            app.set_status("LINE engine พร้อมใช้งาน…");
            app.request_timeout("capabilities", json!({}), Pending::Capabilities, Duration::from_secs(120));
        }
        "engine.closed" | "engine.error" => {
            state.borrow().set_status("LINE engine หลุด กำลังเชื่อมใหม่…");
            let weak = Rc::downgrade(state);
            gtk::glib::timeout_add_local_once(Duration::from_millis(1500), move || {
                if let Some(state) = weak.upgrade() {
                    if let Err(error) = state.borrow_mut().restart_engine() { state.borrow().set_status(&error); }
                }
            });
        }
        "auth.restoring" => state.borrow().set_status("กำลังกู้ session ที่บันทึกไว้อย่างปลอดภัย…"),
        "auth.persistence" => state.borrow().set_status("Wallet ใช้ไม่ได้: session นี้จะไม่บันทึก token ลงไฟล์ plaintext"),
        "auth.qr" => {
            let url = payload.get("url").and_then(Value::as_str).or_else(|| event.get("url").and_then(Value::as_str)).unwrap_or_default().to_owned();
            if !url.is_empty() { show_qr(state, &url); }
        }
        "auth.pin" => {
            let pin = payload.get("pin").and_then(Value::as_str).or_else(|| event.get("pin").and_then(Value::as_str)).unwrap_or_default();
            state.borrow().set_status(&format!("ยืนยัน PIN นี้บน LINE: {pin}"));
        }
        "auth.ready" => {
            {
                let mut app = state.borrow_mut();
                app.stack.set_visible_child_name("main");
                if let Some(backdrop) = app.qr_backdrop.take() { app.overlay.remove_overlay(&backdrop); }
                if let Some(profile) = payload.get("profile").and_then(|v| serde_json::from_value::<Profile>(v.clone()).ok()) { app.profile = Some(profile); }
                app.capabilities.authenticated = true;
                app.load_account_lists();
                app.set_status("เข้าสู่ระบบแล้ว กำลังโหลดข้อมูล…");
            }
        }
        "auth.restore_failed" => {
            let mut app = state.borrow_mut();
            app.stack.set_visible_child_name("login");
            app.capabilities.authenticated = false;
            app.set_status("Session เดิมใช้ต่อไม่ได้ กรุณาเข้าสู่ระบบใหม่");
        }
        "auth.logged_out" => {
            let mut app = state.borrow_mut();
            app.capabilities.authenticated = false;
            app.profile = None; app.chats.clear(); app.open_chats.clear(); app.friends.clear(); app.messages.clear(); app.active_chat_id.clear();
            app.stack.set_visible_child_name("login");
            set_composer_enabled(&app, false, false);
            app.set_status("ออกจากระบบแล้ว");
            drop(app);
            render_sidebar(state); render_messages(state);
        }
        "sync.start" => {
            let app = state.borrow();
            app.sync_label.set_text("กำลังซิงก์ข้อมูล LINE…"); app.sync_label.set_visible(true); app.sync_bar.set_visible(true); app.sync_bar.pulse();
            app.sync_gate.set_visible(true); app.sync_gate_title.set_text("กำลังเตรียม Full Sync"); app.sync_gate_detail.set_text("กำลังเชื่อมข้อมูลบัญชี LINE"); app.sync_gate_bar.set_fraction(0.0); app.sync_gate_percent.set_text("0%");
        }
        "sync.progress" => {
            let phase = payload.get("phase").and_then(Value::as_str).unwrap_or("metadata");
            let done = payload.get("done").and_then(Value::as_f64).unwrap_or(0.0);
            let total = payload.get("total").and_then(Value::as_f64).unwrap_or(0.0);
            let failed = payload.get("failed").and_then(Value::as_u64).unwrap_or(0);
            let app = state.borrow();
            app.sync_label.set_visible(true); app.sync_bar.set_visible(true); app.sync_gate.set_visible(true);
            let (title, detail) = match phase {
                "friends" => ("กำลังซิงก์เพื่อน", format!("{} คน", done as i64)),
                "chats" => ("กำลังซิงก์รายการแชต", format!("{} ห้อง", done as i64)),
                "history" => ("กำลังซิงก์ประวัติข้อความ", format!("ห้อง {} จาก {}{}", done as i64, total as i64, if failed > 0 { format!(" · ข้ามแล้ว {failed}") } else { String::new() })),
                _ => ("กำลังเตรียม Full Sync", "กำลังเชื่อมข้อมูลบัญชี LINE".into()),
            };
            app.sync_gate_title.set_text(title); app.sync_gate_detail.set_text(&detail);
            app.sync_label.set_text(&format!("ซิงก์ {phase} {}/{}", done as i64, total as i64));
            let fraction = if total > 0.0 { (done / total).clamp(0.0, 1.0) } else { 0.0 };
            if total > 0.0 { app.sync_bar.set_fraction(fraction); app.sync_gate_bar.set_fraction(fraction); } else { app.sync_bar.pulse(); app.sync_gate_bar.pulse(); }
            app.sync_gate_percent.set_text(&format!("{}%", (fraction * 100.0).round() as i32));
        }
        "sync.ready" => {
            {
                let app = state.borrow();
                app.sync_label.set_text("ซิงก์เสร็จแล้ว"); app.sync_bar.set_fraction(1.0);
                app.sync_gate_title.set_text("Full Sync เสร็จแล้ว");
                let friends = payload.pointer("/summary/friends").and_then(Value::as_u64).or_else(|| payload.get("friends").and_then(Value::as_u64)).unwrap_or(0);
                let talk = payload.pointer("/summary/talkChats").and_then(Value::as_u64).unwrap_or(0);
                let open = payload.pointer("/summary/openChats").and_then(Value::as_u64).unwrap_or(0);
                let failed = payload.pointer("/summary/failedHistories").and_then(Value::as_u64).unwrap_or(0);
                app.sync_gate_detail.set_text(&format!("{friends} เพื่อน · {} ห้อง{}", talk + open, if failed > 0 { format!(" · {failed} ห้องมีปัญหา") } else { String::new() }));
                app.sync_gate_bar.set_fraction(1.0); app.sync_gate_percent.set_text("100%");
            }
            state.borrow_mut().load_account_lists();
            let weak = Rc::downgrade(state);
            gtk::glib::timeout_add_local_once(Duration::from_millis(900), move || {
                if let Some(state) = weak.upgrade() { let app = state.borrow(); app.sync_label.set_visible(false); app.sync_bar.set_visible(false); app.sync_gate.set_visible(false); }
            });
        }
        "sync.error" => {
            let app = state.borrow(); app.sync_label.set_visible(true); app.sync_label.set_text("ซิงก์บางส่วนไม่สำเร็จ"); app.sync_bar.set_visible(false); app.sync_gate.set_visible(false);
        }
        "sync.room_error" => state.borrow().set_status("ซิงก์บางห้องไม่สำเร็จ กำลังดำเนินการต่อ…"),
        "event.chats.updated" => handle_chats_updated(state, payload),
        "event.transport" => {
            let app = state.borrow();
            let transport_state = payload.get("state").and_then(Value::as_str).or_else(|| payload.get("payload").and_then(|p| p.get("state")).and_then(Value::as_str)).unwrap_or("");
            if transport_state == "connected" {
                app.offline_banner.set_visible(false);
                app.set_status("เชื่อมต่อ LINE แล้ว");
            } else if transport_state == "reconnecting" {
                app.offline_banner.set_visible(true);
                app.offline_label.set_text("ออฟไลน์ — กำลังเชื่อมต่อใหม่ ใช้ข้อมูลแคช");
                app.set_status("การเชื่อมต่อ LINE ขัดข้อง กำลังลองใหม่…");
            } else {
                app.set_status("สถานะการเชื่อมต่อ LINE เปลี่ยนแปลง");
            }
        },
        "event.transport.error" => {
            let app = state.borrow();
            app.offline_banner.set_visible(true);
            app.offline_label.set_text("ออฟไลน์ — ใช้ข้อมูลแคช");
            app.set_status("การเชื่อมต่อ LINE ขัดข้อง กำลังลองใหม่…");
        },
        "event.message.decode_error" => state.borrow().set_status("อ่านข้อความบางรายการไม่ได้"),
        "event.message.error" => state.borrow().set_status("ประมวลผลข้อความบางรายการไม่สำเร็จ"),
        "event.message.persistence_error" => state.borrow().set_status("บันทึกข้อความบางรายการในเครื่องไม่สำเร็จ"),
        "event.message" => handle_live_message(state, payload, event),
        "message.sending" | "message.sent" | "message.failed" => update_outbox_message(state, kind, payload),
        "event.message.reaction" => update_reactions(state, payload),
        "event.message.read" => update_read_receipt(state, payload),
        "event.message.removed" => remove_message_event(state, payload),
        "event.message.unsent" => unsent_message_event(state, payload),
        "media.progress" => {
            let phase = payload.get("phase").and_then(Value::as_str).unwrap_or("working");
            let done = payload.get("done").and_then(Value::as_u64).unwrap_or(0);
            let total = payload.get("total").and_then(Value::as_u64).unwrap_or(0);
            state.borrow().set_status(&format!("ไฟล์: {phase} {done}/{total}"));
        }
        "media.error" => state.borrow().set_status("ส่งไฟล์ไม่สำเร็จ"),
        "call.incoming" => show_incoming_call(state, payload),
        "event.call.cancel" => {
            close_call_window(state);
            state.borrow().set_status("สายถูกยกเลิกแล้ว");
        }
        "event.call.state" | "event.call.ready" | "event.call.ended" | "event.call.error" => update_call_event(state, kind, payload),
        _ => {}
    }
}

fn handle_chats_updated(state: &Rc<RefCell<State>>, payload: &Value) {
    let kind = payload.get("kind").and_then(Value::as_str).unwrap_or("");
    let chats = payload.get("chats").and_then(|v| serde_json::from_value::<Vec<Chat>>(v.clone()).ok()).unwrap_or_default();
    if chats.is_empty() { return; }
    {
        let mut app = state.borrow_mut();
        match kind {
            "talk" => app.chats = chats,
            "friends" => app.friends = chats,
            "openchat" => app.open_chats = chats,
            _ => return,
        }
    }
    render_sidebar(state);
}

fn handle_request_success(state: &Rc<RefCell<State>>, action: Pending, result: Value) {
    match action {
        Pending::Capabilities => {
            let authenticated = result.get("authenticated").and_then(Value::as_bool).unwrap_or(false);
            let mut app = state.borrow_mut();
            app.capabilities = Capabilities {
                authenticated,
                linejs_version: result.get("linejsVersion").and_then(Value::as_str).unwrap_or_default().to_owned(),
                storage_mode: result.pointer("/storage/mode").and_then(Value::as_str).unwrap_or("session-only").to_owned(),
                call_enabled: result.pointer("/call/enabled").and_then(Value::as_bool).unwrap_or(false),
                incoming_call: result.pointer("/call/incomingAnswer").and_then(Value::as_bool).unwrap_or(false),
                call_reason: result.pointer("/call/reason").and_then(Value::as_str).unwrap_or_default().to_owned(),
            };
            if authenticated {
                app.stack.set_visible_child_name("main");
                app.set_status("Session พร้อมใช้งาน กดรีเฟรชเพื่อ Full Sync");
                let call_ready = app.active_chat().map(|chat| chat.kind == "dm").unwrap_or(false) && app.capabilities.call_enabled;
                app.call_button.set_sensitive(call_ready);
            } else {
                app.stack.set_visible_child_name("login"); app.set_status("เข้าสู่ระบบด้วย QR Code หรือ Email / Password");
            }
        }
        Pending::Profile => {
            if let Ok(profile) = serde_json::from_value::<Profile>(result) { state.borrow_mut().profile = Some(profile); }
        }
        Pending::Chats => {
            if let Ok(mut chats) = serde_json::from_value::<Vec<Chat>>(result) {
                let (pins, previous) = { let app = state.borrow(); (app.settings.local_pins.clone(), app.chats.clone()) };
                if chats.len() < previous.len() { let ids: std::collections::HashSet<_> = chats.iter().map(|chat| chat.id.clone()).collect(); chats.extend(previous.into_iter().filter(|chat| !ids.contains(&chat.id))); }
                for chat in &mut chats { if let Some(ts) = pins.get(&chat.id) { chat.pinned = true; chat.favorite_timestamp = chat.favorite_timestamp.max(*ts); } }
                chats.sort_by(|a,b| b.pinned.cmp(&a.pinned).then_with(|| b.favorite_timestamp.cmp(&a.favorite_timestamp)).then_with(|| b.last_message_time.cmp(&a.last_message_time)));
                state.borrow_mut().chats = chats;
                render_sidebar(state); maybe_select_first_chat(state);
            }
        }
        Pending::Friends => {
            if let Ok(mut friends) = serde_json::from_value::<Vec<Chat>>(result) {
                let previous = state.borrow().friends.clone();
                if friends.len() < previous.len() { let ids: std::collections::HashSet<_> = friends.iter().map(|chat| chat.id.clone()).collect(); friends.extend(previous.into_iter().filter(|chat| !ids.contains(&chat.id))); }
                friends.sort_by(|a,b| b.is_favorite.cmp(&a.is_favorite).then_with(|| b.favorite_time.cmp(&a.favorite_time)).then_with(|| a.name.cmp(&b.name)));
                state.borrow_mut().friends = friends; render_sidebar(state);
            }
        }
        Pending::OpenChats => {
            if let Ok(mut chats) = serde_json::from_value::<Vec<Chat>>(result) {
                let previous = state.borrow().open_chats.clone();
                if chats.len() < previous.len() { let ids: std::collections::HashSet<_> = chats.iter().map(|chat| chat.id.clone()).collect(); chats.extend(previous.into_iter().filter(|chat| !ids.contains(&chat.id))); }
                chats.sort_by(|a,b| b.last_message_time.cmp(&a.last_message_time));
                state.borrow_mut().open_chats = chats; render_sidebar(state); maybe_select_first_chat(state);
            }
        }
        Pending::Messages { chat_id } => {
            if let Ok(mut messages) = serde_json::from_value::<Vec<Message>>(result) {
                let existing = state.borrow().messages.get(&chat_id).cloned().unwrap_or_default();
                for message in &mut messages {
                    if let Some(previous) = existing.iter().find(|old| old.id == message.id) {
                        if message.image_data_url.is_empty() { message.image_data_url = previous.image_data_url.clone(); }
                        if message.asset_data_url.is_empty() { message.asset_data_url = previous.asset_data_url.clone(); }
                        message.read_by_peer |= previous.read_by_peer;
                    }
                }
                for pending in existing.into_iter().filter(|old| old.status != "sent") {
                    if !messages.iter().any(|item| item.id == pending.id || (!pending.local_id.is_empty() && item.local_id == pending.local_id)) { messages.push(pending); }
                }
                messages.sort_by_key(|m| m.created_time);
                state.borrow_mut().messages.insert(chat_id.clone(), messages);
                if state.borrow().active_chat_id == chat_id { render_messages(state); maybe_jump_to_message(state, &chat_id); }
                hydrate_message_assets(state, &chat_id);
            }
        }
        Pending::MediaPreview { chat_id, message_id, attempt: _ } => {
            let data = result.get("dataUrl").and_then(Value::as_str).unwrap_or_default().to_owned();
            if !data.is_empty() {
                if let Some(message) = state.borrow_mut().messages.get_mut(&chat_id).and_then(|list| list.iter_mut().find(|m| m.id == message_id)) { message.image_data_url = data; }
                if state.borrow().active_chat_id == chat_id { render_messages(state); }
            }
        }
        Pending::AssetMessage { chat_id, message_id, candidates: _, index: _ } => {
            let data = result.get("dataUrl").and_then(Value::as_str).unwrap_or_default().to_owned();
            if !data.is_empty() {
                if let Some(message) = state.borrow_mut().messages.get_mut(&chat_id).and_then(|list| list.iter_mut().find(|m| m.id == message_id)) { message.asset_data_url = data; }
                if state.borrow().active_chat_id == chat_id { render_messages(state); }
            }
        }
        Pending::AssetButton { button } => {
            if let Some(data) = result.get("dataUrl").and_then(Value::as_str) {
                let picture = gtk::Picture::new();
                picture.set_can_shrink(true);
                set_picture_async(&picture, data, 72, 72);
                button.set_child(Some(&picture));
            }
        }
        Pending::AssetImage { image, url, size, guard_chat_id } => {
            if let Some(data) = result.get("dataUrl").and_then(Value::as_str) {
                let allowed = guard_chat_id.is_empty() || state.borrow().active_chat_id == guard_chat_id;
                state.borrow_mut().asset_cache.insert(url, data.to_owned());
                if allowed { set_image_async(&image, data, size, size); }
            }
        }
        Pending::AssetPicture { picture, url, max_width, max_height } => {
            if let Some(data) = result.get("dataUrl").and_then(Value::as_str) {
                state.borrow_mut().asset_cache.insert(url, data.to_owned());
                set_picture_async(&picture, data, max_width, max_height);
            }
        }
        Pending::Stickers { grid, tabs } => {
            if let Ok(stickers) = serde_json::from_value::<Vec<Sticker>>(result) { populate_sticker_packs(state, &grid, &tabs, stickers); }
        }
        Pending::Emojis { grid, tabs } => {
            if let Ok(items) = serde_json::from_value::<Vec<LineEmoji>>(result) { populate_emoji_packs(state, &grid, &tabs, items); }
        }
        Pending::Send { chat_id, local_id } | Pending::MediaSend { chat_id, local_id } | Pending::SendSticker { chat_id, local_id } | Pending::SendEmoji { chat_id, local_id } => {
            set_message_status(state, &chat_id, &local_id, "sent"); state.borrow().set_status("ส่งแล้ว");
        }
        Pending::Retry { chat_id, local_id } => set_message_status(state, &chat_id, &local_id, "sent"),
        Pending::MediaCancel { chat_id, local_id } => { set_message_status(state, &chat_id, &local_id, "error"); state.borrow().set_status("ยกเลิกการส่งไฟล์แล้ว"); },
        Pending::React { chat_id } => {
            if let Some(chat) = state.borrow().chat_by_id(&chat_id) {
                state.borrow_mut().request_timeout("message.list", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "limit": if chat.kind == "openchat" { 40 } else { 50 } }), Pending::Messages { chat_id }, Duration::from_secs(60));
            }
        }
        Pending::Delete { chat_id, message_id } => {
            if let Some(list) = state.borrow_mut().messages.get_mut(&chat_id) { list.retain(|message| message.id != message_id); }
            if state.borrow().active_chat_id == chat_id { render_messages(state); }
        }
        Pending::Unsend { chat_id, message_id } => {
            if let Some(message) = state.borrow_mut().messages.get_mut(&chat_id).and_then(|list| list.iter_mut().find(|message| message.id == message_id)) { message.unsent = true; message.text = "ยกเลิกข้อความแล้ว".into(); message.sticker_url.clear(); message.asset_data_url.clear(); message.image_data_url.clear(); }
            if state.borrow().active_chat_id == chat_id { render_messages(state); }
        }
        Pending::MarkRead => {}
        Pending::Login => state.borrow().set_status("กำลังยืนยันตัวตน…"),
        Pending::Logout => {}
        Pending::SyncStart => state.borrow().set_status("เริ่มซิงก์แล้ว"),
        Pending::HistoryClear => { state.borrow_mut().messages.clear(); render_messages(state); state.borrow().set_status("ล้างประวัติในเครื่องแล้ว"); }
        Pending::StickerCacheClear => state.borrow().set_status("ล้างแคชสติกเกอร์แล้ว"),
        Pending::CallStart => { show_call_window(state, "กำลังเชื่อมต่อสาย…"); }
        Pending::CallDevices => {
            let devices = result.get("outputs").cloned().and_then(|value| serde_json::from_value::<Vec<AudioDevice>>(value).ok()).unwrap_or_default();
            state.borrow_mut().call_devices = devices;
            render_call_outputs(state);
        }
        Pending::CallAccept => update_call_status(state, "กำลังเชื่อมต่อสาย…"),
        Pending::CallReject | Pending::CallEnd => close_call_window(state),
        Pending::CallMute => {}
        Pending::CallOutput => state.borrow().set_status("เปลี่ยนอุปกรณ์เสียงแล้ว"),
    }
}

fn handle_request_timeout(state: &Rc<RefCell<State>>, action: Pending) {
    match action {
        Pending::Send { chat_id, local_id } | Pending::Retry { chat_id, local_id } => set_message_status(state, &chat_id, &local_id, "unknown"),
        Pending::MediaSend { chat_id, local_id } | Pending::SendSticker { chat_id, local_id } | Pending::SendEmoji { chat_id, local_id } => set_message_status(state, &chat_id, &local_id, "error"),
        Pending::MediaPreview { chat_id, message_id, attempt } => {
            if attempt == 0 {
                if let Some(chat) = state.borrow().chat_by_id(&chat_id) {
                    state.borrow_mut().request_timeout("media.preview", json!({ "messageId": message_id, "chatId": chat_id, "kind": chat.engine_kind(), "refresh": true }), Pending::MediaPreview { chat_id: chat.id.clone(), message_id, attempt: 1 }, Duration::from_secs(60));
                }
            }
        }
        Pending::CallStart | Pending::CallAccept | Pending::CallOutput => update_call_status(state, "LINE ตอบกลับช้าเกินกำหนด"),
        _ => {}
    }
}

fn handle_request_error(state: &Rc<RefCell<State>>, action: Pending, message: &str) {
    match action {
        Pending::MediaPreview { chat_id, message_id, attempt } => {
            if attempt == 0 {
                if let Some(chat) = state.borrow().chat_by_id(&chat_id) {
                    state.borrow_mut().request_timeout("media.preview", json!({ "messageId": message_id, "chatId": chat_id, "kind": chat.engine_kind(), "refresh": true }), Pending::MediaPreview { chat_id: chat.id.clone(), message_id, attempt: 1 }, Duration::from_secs(60));
                    return;
                }
            }
        }
        Pending::AssetMessage { chat_id, message_id, candidates, index } => {
            let next = index + 1;
            if let Some(url) = candidates.get(next).cloned() {
                state.borrow_mut().request_timeout("asset.preview", json!({ "url": url }), Pending::AssetMessage { chat_id, message_id, candidates, index: next }, Duration::from_secs(30));
                return;
            }
        }
        Pending::Send { chat_id, local_id } | Pending::MediaSend { chat_id, local_id } | Pending::SendSticker { chat_id, local_id } | Pending::SendEmoji { chat_id, local_id } | Pending::Retry { chat_id, local_id } => set_message_status(state, &chat_id, &local_id, "error"),
        Pending::CallStart | Pending::CallAccept | Pending::CallOutput => { show_call_window(state, message); update_call_status(state, message); }
        Pending::CallReject | Pending::CallEnd => close_call_window(state),
        _ => {}
    }
    state.borrow().set_status(message);
}

fn send_text_message(state: &Rc<RefCell<State>>) {
    let text = composer_text(&state.borrow().composer);
    send_text_value(state, &text, true);
}

fn send_text_value(state: &Rc<RefCell<State>>, text: &str, clear_composer: bool) {
    let text = text.trim().to_owned();
    let (chat, reply) = { let app = state.borrow(); (app.active_chat(), app.reply_target.clone()) };
    let Some(chat) = chat else { state.borrow().set_status("เลือกแชตก่อนส่งข้อความ"); return };
    if text.is_empty() { return; }
    let local_id = new_local_id("msg"); let now = now_ms(); let sequence = SEND_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    {
        let mut app = state.borrow_mut();
        if clear_composer { app.composer.buffer().set_text(""); }
        app.reply_target = None;
        app.messages.entry(chat.id.clone()).or_default().push(Message {
            id: local_id.clone(), local_id: local_id.clone(), chat_id: chat.id.clone(), text: text.clone(), is_mine: true, created_time: now, status: "sending".into(), reply_to: reply.clone(), reply_to_id: reply.as_ref().map(|r| r.id.clone()).unwrap_or_default(), ..Default::default()
        });
        app.request_timeout("message.send", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "text": text, "localId": local_id, "createdAt": now, "sequence": sequence, "relatedMessageId": reply.as_ref().map(|r| r.id.clone()).unwrap_or_default() }), Pending::Send { chat_id: chat.id.clone(), local_id: local_id.clone() }, Duration::from_secs(60));
    }
    update_chat_preview(state, &chat.id, &text, now);
    update_reply_bar(state); render_messages(state);
}

fn pick_media_file(state: &Rc<RefCell<State>>) {
    let chat = state.borrow().active_chat();
    if chat.is_none() { state.borrow().set_status("เลือกแชตก่อนแนบไฟล์"); return; }
    let parent = state.borrow().window.clone();
    let state = state.clone();
    composer_media::choose_media_file(&parent, move |path| send_media_path(&state, &path));
}

fn send_media_path(state: &Rc<RefCell<State>>, path: &Path) {
    let Some(chat) = state.borrow().active_chat() else { return };
    let Ok(meta) = std::fs::metadata(path) else { state.borrow().set_status("อ่านไฟล์ไม่ได้"); return };
    if meta.len() == 0 || meta.len() > 25 * 1024 * 1024 { state.borrow().set_status("ไฟล์ต้องมีขนาดไม่เกิน 25 MB"); return; }
    let filename = path.file_name().and_then(|v| v.to_str()).unwrap_or("file").to_owned();
    let (mime, content_type) = media_type(&filename);
    let local_id = new_local_id("media"); let now = now_ms();
    {
        let mut app = state.borrow_mut();
        app.messages.entry(chat.id.clone()).or_default().push(Message { id: local_id.clone(), chat_id: chat.id.clone(), text: if content_type == 1 { "กำลังส่งรูป…".into() } else { filename.clone() }, filename: filename.clone(), is_mine: true, created_time: now, content_type, status: "sending".into(), ..Default::default() });
        app.request_timeout("media.send", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "jobId": local_id, "localId": local_id, "createdAt": now, "filename": filename, "mime": mime, "contentType": content_type, "filePath": path.to_string_lossy() }), Pending::MediaSend { chat_id: chat.id.clone(), local_id: local_id.clone() }, Duration::from_secs(120));
    }
    update_chat_preview(state, &chat.id, if content_type == 1 { "รูปภาพ" } else { &filename }, now);
    render_messages(state);
}

fn show_sticker_picker(state: &Rc<RefCell<State>>) {
    if state.borrow().active_chat().is_none() { state.borrow().set_status("เลือกแชตก่อนส่งสติกเกอร์"); return; }
    let window = gtk::Window::builder().transient_for(&state.borrow().window).modal(false).title("สติกเกอร์และ LINE Emoji").default_width(660).default_height(560).build();
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).margin_top(14).margin_bottom(14).margin_start(14).margin_end(14).build();
    root.append(&gtk::Label::builder().label("สติกเกอร์ของคุณ").xalign(0.0).css_classes(["settings-title"]).build());
    let switcher = gtk::StackSwitcher::new();
    let stack = gtk::Stack::builder().transition_type(gtk::StackTransitionType::Crossfade).vexpand(true).build(); switcher.set_stack(Some(&stack)); root.append(&switcher);

    let sticker_page = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).build();
    let sticker_grid = gtk::FlowBox::builder().selection_mode(gtk::SelectionMode::None).max_children_per_line(6).min_children_per_line(4).row_spacing(8).column_spacing(8).build();
    let sticker_scroll = gtk::ScrolledWindow::builder().child(&sticker_grid).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).build();
    let sticker_tabs = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(6).build();
    let sticker_tabs_scroll = gtk::ScrolledWindow::builder().child(&sticker_tabs).hscrollbar_policy(gtk::PolicyType::Automatic).vscrollbar_policy(gtk::PolicyType::Never).min_content_height(72).build();
    sticker_page.append(&sticker_scroll); sticker_page.append(&sticker_tabs_scroll);

    let emoji_page = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).build();
    let emoji_grid = gtk::FlowBox::builder().selection_mode(gtk::SelectionMode::None).max_children_per_line(8).min_children_per_line(5).row_spacing(8).column_spacing(8).build();
    let emoji_scroll = gtk::ScrolledWindow::builder().child(&emoji_grid).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).build();
    let emoji_tabs = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(6).build();
    let emoji_tabs_scroll = gtk::ScrolledWindow::builder().child(&emoji_tabs).hscrollbar_policy(gtk::PolicyType::Automatic).vscrollbar_policy(gtk::PolicyType::Never).min_content_height(72).build();
    emoji_page.append(&emoji_scroll); emoji_page.append(&emoji_tabs_scroll);

    stack.add_titled(&sticker_page, Some("stickers"), "สติกเกอร์");
    stack.add_titled(&emoji_page, Some("emoji"), "LINE Emoji");
    root.append(&stack); window.set_child(Some(&root));
    {
        let mut app = state.borrow_mut();
        app.request_timeout("sticker.recent", json!({ "limit": 120 }), Pending::Stickers { grid: sticker_grid, tabs: sticker_tabs }, Duration::from_secs(60));
        app.request_timeout("emoji.recent", json!({ "limit": 120 }), Pending::Emojis { grid: emoji_grid, tabs: emoji_tabs }, Duration::from_secs(60));
    }
    window.present();
}

fn populate_sticker_packs(state: &Rc<RefCell<State>>, grid: &gtk::FlowBox, tabs: &gtk::Box, stickers: Vec<Sticker>) {
    while let Some(child) = tabs.first_child() { tabs.remove(&child); }
    let mut packs: Vec<(String, Vec<Sticker>)> = Vec::new();
    for sticker in stickers {
        if let Some((_, items)) = packs.iter_mut().find(|(id, _)| *id == sticker.package_id) { items.push(sticker); }
        else { packs.push((sticker.package_id.clone(), vec![sticker])); }
    }
    if packs.is_empty() { clear_flowbox(grid); grid.insert(&gtk::Label::builder().label("ไม่พบสติกเกอร์ที่บัญชีนี้เป็นเจ้าของ").css_classes(["empty-note"]).build(), -1); return; }
    render_sticker_pack(state, grid, &packs[0].0, &packs[0].1);
    for (index, (package_id, items)) in packs.into_iter().enumerate() {
        let button = gtk::Button::builder().label(format!("#{}", package_id)).tooltip_text(format!("แพ็ก #{}", package_id)).css_classes(["pack-tab"]).build();
        if index == 0 { button.add_css_class("active"); }
        if let Some(first) = items.first() {
            let image = gtk::Image::new(); image.set_pixel_size(52); button.set_child(Some(&image));
            let url = first.url();
            let cached = { state.borrow().asset_cache.get(&url).cloned() };
            if let Some(data) = cached { let image2 = image.clone(); set_image_async(&image2, &data, 52, 52); }
            else { state.borrow_mut().request_timeout("asset.preview", json!({ "url": url }), Pending::AssetImage { image, url, size: 52, guard_chat_id: String::new() }, Duration::from_secs(30)); }
        }
        let state2 = state.clone(); let grid2 = grid.clone(); let package2 = package_id.clone(); let items2 = items.clone(); let tabs2 = tabs.clone(); let button2 = button.clone();
        button.connect_clicked(move |_| {
            for child in widget_children(&tabs2) { child.remove_css_class("active"); }
            button2.add_css_class("active"); render_sticker_pack(&state2, &grid2, &package2, &items2);
        });
        tabs.append(&button);
    }
}

fn render_sticker_pack(state: &Rc<RefCell<State>>, grid: &gtk::FlowBox, package_id: &str, stickers: &[Sticker]) {
    clear_flowbox(grid);
    grid.insert(&gtk::Label::builder().label(format!("แพ็ก #{package_id}")).xalign(0.0).css_classes(["pack-label"]).build(), -1);
    for sticker in stickers.iter().cloned() {
        let button = gtk::Button::builder().label(format!("#{}", sticker.sticker_id)).width_request(84).height_request(84).css_classes(["asset-button"]).build();
        button.set_tooltip_text(Some(if sticker.owned { "ส่งสติกเกอร์ของคุณ" } else { "ส่งสติกเกอร์ที่พบในแชต" }));
        { let state = state.clone(); let sticker2 = sticker.clone(); button.connect_clicked(move |_| send_sticker(&state, &sticker2)); }
        grid.insert(&button, -1);
        state.borrow_mut().request_timeout("asset.preview", json!({ "url": sticker.url() }), Pending::AssetButton { button }, Duration::from_secs(30));
    }
}

fn populate_emoji_packs(state: &Rc<RefCell<State>>, grid: &gtk::FlowBox, tabs: &gtk::Box, items: Vec<LineEmoji>) {
    while let Some(child) = tabs.first_child() { tabs.remove(&child); }
    let mut packs: Vec<(String, Vec<LineEmoji>)> = Vec::new();
    for item in items {
        if let Some((_, list)) = packs.iter_mut().find(|(id, _)| *id == item.product_id) { list.push(item); }
        else { packs.push((item.product_id.clone(), vec![item])); }
    }
    if packs.is_empty() { clear_flowbox(grid); grid.insert(&gtk::Label::builder().label("ยังไม่มี LINE Emoji ในประวัติแชต").css_classes(["empty-note"]).build(), -1); return; }
    render_emoji_pack(state, grid, &packs[0].0, &packs[0].1);
    for (index, (product_id, items)) in packs.into_iter().enumerate() {
        let button = gtk::Button::builder().label(format!("#{}", product_id)).tooltip_text(format!("LINE Emoji #{}", product_id)).css_classes(["pack-tab"]).build();
        if index == 0 { button.add_css_class("active"); }
        if let Some(first) = items.first() {
            let image = gtk::Image::new(); image.set_pixel_size(48); button.set_child(Some(&image));
            let url = first.url();
            let cached = { state.borrow().asset_cache.get(&url).cloned() };
            if let Some(data) = cached { let image2 = image.clone(); set_image_async(&image2, &data, 48, 48); }
            else { state.borrow_mut().request_timeout("asset.preview", json!({ "url": url }), Pending::AssetImage { image, url, size: 48, guard_chat_id: String::new() }, Duration::from_secs(30)); }
        }
        let state2 = state.clone(); let grid2 = grid.clone(); let product2 = product_id.clone(); let items2 = items.clone(); let tabs2 = tabs.clone(); let button2 = button.clone();
        button.connect_clicked(move |_| { for child in widget_children(&tabs2) { child.remove_css_class("active"); } button2.add_css_class("active"); render_emoji_pack(&state2, &grid2, &product2, &items2); });
        tabs.append(&button);
    }
}

fn render_emoji_pack(state: &Rc<RefCell<State>>, grid: &gtk::FlowBox, product_id: &str, items: &[LineEmoji]) {
    clear_flowbox(grid);
    grid.insert(&gtk::Label::builder().label(format!("LINE Emoji #{product_id}")).xalign(0.0).css_classes(["pack-label"]).build(), -1);
    for item in items.iter().cloned() {
        let button = gtk::Button::builder().label(format!("#{}", item.sticon_id)).width_request(64).height_request(64).css_classes(["asset-button"]).build();
        button.set_tooltip_text(Some(if item.owned { "ส่ง LINE Emoji ของคุณ" } else { "ส่ง LINE Emoji ที่พบในแชต" }));
        { let state = state.clone(); let item2 = item.clone(); button.connect_clicked(move |_| send_emoji(&state, &item2)); }
        grid.insert(&button, -1);
        state.borrow_mut().request_timeout("asset.preview", json!({ "url": item.url() }), Pending::AssetButton { button }, Duration::from_secs(30));
    }
}

fn clear_flowbox(grid: &gtk::FlowBox) { while let Some(child) = grid.first_child() { grid.remove(&child); } }
fn widget_children(container: &gtk::Box) -> Vec<gtk::Widget> { let mut out = Vec::new(); let mut child = container.first_child(); while let Some(item) = child { child = item.next_sibling(); out.push(item); } out }

fn send_sticker(state: &Rc<RefCell<State>>, sticker: &Sticker) {
    let Some(chat) = state.borrow().active_chat() else { return };
    let local_id = new_local_id("sticker"); let now = now_ms();
    {
        let mut app = state.borrow_mut();
        app.messages.entry(chat.id.clone()).or_default().push(Message { id: local_id.clone(), chat_id: chat.id.clone(), is_mine: true, created_time: now, content_type: 7, sticker_url: sticker.url(), status: "sending".into(), ..Default::default() });
        app.request_timeout("message.sendSticker", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "packageId": sticker.package_id, "stickerId": sticker.sticker_id, "version": sticker.version, "option": sticker.option, "localId": local_id, "createdAt": now }), Pending::SendSticker { chat_id: chat.id.clone(), local_id: local_id.clone() }, Duration::from_secs(60));
    }
    update_chat_preview(state, &chat.id, "สติกเกอร์", now);
    render_messages(state); hydrate_message_assets(state, &chat.id);
}

fn send_emoji(state: &Rc<RefCell<State>>, emoji: &LineEmoji) {
    let Some(chat) = state.borrow().active_chat() else { return };
    let local_id = new_local_id("emoji"); let now = now_ms();
    {
        let mut app = state.borrow_mut();
        app.messages.entry(chat.id.clone()).or_default().push(Message { id: local_id.clone(), chat_id: chat.id.clone(), is_mine: true, created_time: now, emoji_url: emoji.url(), status: "sending".into(), ..Default::default() });
        app.request_timeout("message.sendEmoji", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "productId": emoji.product_id, "sticonId": emoji.sticon_id, "version": emoji.version, "resourceType": emoji.resource_type, "localId": local_id, "createdAt": now }), Pending::SendEmoji { chat_id: chat.id.clone(), local_id: local_id.clone() }, Duration::from_secs(60));
    }
    update_chat_preview(state, &chat.id, "LINE Emoji", now);
    render_messages(state); hydrate_message_assets(state, &chat.id);
}

fn begin_reply(state: &Rc<RefCell<State>>, message: &Message) {
    if message.unsent { return; }
    state.borrow_mut().reply_target = Some(ReplyTarget { id: message.id.clone(), text: message.summary(), author: if message.is_mine { "me".into() } else { "them".into() }, sender_name: message.sender_name.clone() });
    update_reply_bar(state); state.borrow().composer.grab_focus();
}

fn update_reply_bar(state: &Rc<RefCell<State>>) {
    let app = state.borrow();
    if let Some(reply) = &app.reply_target {
        app.reply_label.set_text(&format!("ตอบกลับ: {}", reply.text)); app.reply_bar.set_visible(true);
    } else { app.reply_bar.set_visible(false); }
}


fn show_reaction_picker(state: &Rc<RefCell<State>>, chat: &Chat, message: &Message, anchor: &gtk::Button) {
    let popover = gtk::Popover::new(); popover.set_parent(anchor); popover.set_has_arrow(true);
    let row = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(4).margin_top(6).margin_bottom(6).margin_start(6).margin_end(6).build();
    for reaction in [2u32, 3, 4, 5, 6, 7] {
        let button = gtk::Button::builder().label(reaction_icon(reaction)).css_classes(["reaction-choice"]).build();
        if message.reactions.iter().any(|item| item.mine && item.reaction_type == reaction) { button.add_css_class("active"); }
        let state2 = state.clone(); let chat2 = chat.clone(); let message2 = message.clone(); let popover2 = popover.clone();
        button.connect_clicked(move |_| { react_message(&state2, &chat2, &message2, reaction); popover2.popdown(); });
        row.append(&button);
    }
    popover.set_child(Some(&row)); popover.popup();
}

fn react_message(state: &Rc<RefCell<State>>, chat: &Chat, message: &Message, reaction: u32) {
    let selected = message.reactions.iter().find(|item| item.mine).map(|item| item.reaction_type);
    let effective = if selected == Some(reaction) && reaction != 1 { 1 } else { reaction };
    state.borrow_mut().request("message.react", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "messageId": message.id, "reaction": effective }), Pending::React { chat_id: chat.id.clone() });
}

fn delete_for_me(state: &Rc<RefCell<State>>, chat: &Chat, message: &Message) {
    let chat = chat.clone(); let message = message.clone();
    confirm_action(state, "ลบข้อความเฉพาะคุณ?", "ข้อความนี้จะยังอยู่ใน LINE ของคนอื่น", move |state| {
        state.borrow_mut().request("message.delete_for_me", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "messageId": message.id }), Pending::Delete { chat_id: chat.id.clone(), message_id: message.id.clone() });
    });
}

fn unsend_message(state: &Rc<RefCell<State>>, chat: &Chat, message: &Message) {
    let chat = chat.clone(); let message = message.clone();
    confirm_action(state, "ยกเลิกข้อความสำหรับทุกคน?", "LINE จะพยายามยกเลิกข้อความนี้ในห้องสนทนา", move |state| {
        state.borrow_mut().request("message.unsend", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "messageId": message.id }), Pending::Unsend { chat_id: chat.id.clone(), message_id: message.id.clone() });
    });
}

fn retry_message(state: &Rc<RefCell<State>>, chat_id: &str, local_id: &str) {
    set_message_status(state, chat_id, local_id, "sending");
    state.borrow_mut().request_timeout("message.retry", json!({ "localId": local_id }), Pending::Retry { chat_id: chat_id.to_owned(), local_id: local_id.to_owned() }, Duration::from_secs(90));
}

fn handle_live_message(state: &Rc<RefCell<State>>, payload: &Value, envelope: &Value) {
    let message_value = payload.get("message").cloned().unwrap_or_else(|| payload.clone());
    let Ok(mut message) = serde_json::from_value::<Message>(message_value) else { return };
    let chat_id = if !message.chat_id.is_empty() { message.chat_id.clone() } else { payload.get("chatId").and_then(Value::as_str).unwrap_or_default().to_owned() };
    if chat_id.is_empty() { return; }
    message.chat_id = chat_id.clone();
    let is_open = envelope.get("source").and_then(Value::as_str).map(|s| s.starts_with("openchat")).unwrap_or(false);
    {
        let mut app = state.borrow_mut();
        let list = app.messages.entry(chat_id.clone()).or_default();
        if let Some(index) = list.iter().position(|m| m.id == message.id || (!message.local_id.is_empty() && m.id == message.local_id)) { list[index] = message.clone(); } else { list.push(message.clone()); list.sort_by_key(|m| m.created_time); }
        let preview = message.summary();
        let now = message.created_time.max(now_ms());
        let mut found = false;
        let increment_unread = !message.is_mine && app.active_chat_id != chat_id;
        for chat in app.chats.iter_mut() {
            if chat.id == chat_id {
                chat.preview = preview.clone(); chat.last_message_time = now; found = true;
                if increment_unread { chat.unread = chat.unread.saturating_add(1); }
            }
        }
        for chat in app.open_chats.iter_mut() {
            if chat.id == chat_id {
                chat.preview = preview.clone(); chat.last_message_time = now; found = true;
                if increment_unread { chat.unread = chat.unread.saturating_add(1); }
            }
        }
        if !found {
            app.request_timeout(if is_open { "openchat.list" } else { "chat.list" }, json!({}), if is_open { Pending::OpenChats } else { Pending::Chats }, Duration::from_secs(60));
        }
        if !message.is_mine && app.active_chat_id != chat_id && app.settings.desktop_notifications {
            let now = Instant::now();
            app.notification_dedup.retain(|_, at| now.duration_since(*at) < Duration::from_secs(60));
            let key = format!("{}:{}:{}", chat_id, message.id, message.created_time);
            if !app.notification_dedup.contains_key(&key) {
                app.notification_dedup.insert(key, now);
                let title = app.chat_by_id(&chat_id).map(|c| c.name).unwrap_or_else(|| message.sender_name.clone());
                notify(&app, &chat_id, &title, if app.settings.notification_preview { &preview } else { "มีข้อความใหม่" }, &message.id);
            }
        }
        if !message.is_mine && app.active_chat_id == chat_id && app.window.is_active() && app.window.is_visible() {
            if let Some(chat) = app.chat_by_id(&chat_id) { app.mark_read(&chat); }
        }
    }
    state.borrow_mut().mark_render();
    if state.borrow().active_chat_id == chat_id { hydrate_message_assets(state, &chat_id); }
}

fn update_outbox_message(state: &Rc<RefCell<State>>, event_type: &str, payload: &Value) {
    let chat_id = payload.get("chatId").and_then(Value::as_str).unwrap_or_default();
    let local_id = payload.get("localId").and_then(Value::as_str).unwrap_or_default();
    if chat_id.is_empty() || local_id.is_empty() { return; }
    let status = match event_type { "message.sending" => "sending", "message.failed" => if payload.get("status").and_then(Value::as_str) == Some("unknown") { "unknown" } else { "error" }, _ => "sent" };
    set_message_status(state, chat_id, local_id, status);
    if event_type == "message.sent" {
        if let Some(server_id) = payload.get("serverId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            if let Some(message) = state.borrow_mut().messages.get_mut(chat_id).and_then(|list| list.iter_mut().find(|m| m.id == local_id)) { message.id = server_id.to_owned(); }
        }
    }
    state.borrow_mut().mark_render();
}

fn update_reactions(state: &Rc<RefCell<State>>, payload: &Value) {
    let chat_id = payload.get("chatId").and_then(Value::as_str).unwrap_or_default(); let message_id = payload.get("messageId").and_then(Value::as_str).unwrap_or_default();
    let reactions = payload.get("reactions").cloned().and_then(|v| serde_json::from_value::<Vec<Reaction>>(v).ok()).unwrap_or_default();
    if let Some(message) = state.borrow_mut().messages.get_mut(chat_id).and_then(|list| list.iter_mut().find(|m| m.id == message_id)) { message.reactions = reactions; }
    state.borrow_mut().mark_render();
}

fn update_read_receipt(state: &Rc<RefCell<State>>, payload: &Value) {
    let chat_id = payload.get("chatId").and_then(Value::as_str).unwrap_or_default(); let message_id = payload.get("messageId").and_then(Value::as_str).unwrap_or_default();
    if let Some(list) = state.borrow_mut().messages.get_mut(chat_id) {
        for message in list.iter_mut().filter(|m| m.is_mine) { if message.id == message_id || numeric_leq(&message.id, message_id) { message.read_by_peer = true; } }
    }
    state.borrow_mut().mark_render();
}

fn remove_message_event(state: &Rc<RefCell<State>>, payload: &Value) {
    let chat_id = payload.get("chatId").and_then(Value::as_str).unwrap_or_default(); let message_id = payload.get("messageId").and_then(Value::as_str).unwrap_or_default();
    if let Some(list) = state.borrow_mut().messages.get_mut(chat_id) { list.retain(|m| m.id != message_id); }
    state.borrow_mut().mark_render();
}

fn unsent_message_event(state: &Rc<RefCell<State>>, payload: &Value) {
    let chat_id = payload.get("chatId").and_then(Value::as_str).unwrap_or_default(); let message_id = payload.get("messageId").and_then(Value::as_str).unwrap_or_default();
    if let Some(message) = state.borrow_mut().messages.get_mut(chat_id).and_then(|list| list.iter_mut().find(|m| m.id == message_id)) { message.unsent = true; message.text = "ยกเลิกข้อความแล้ว".into(); message.sticker_url.clear(); message.image_data_url.clear(); message.asset_data_url.clear(); message.reactions.clear(); }
    state.borrow_mut().mark_render();
}

fn set_message_status(state: &Rc<RefCell<State>>, chat_id: &str, id: &str, status: &str) {
    if let Some(message) = state.borrow_mut().messages.get_mut(chat_id).and_then(|list| list.iter_mut().find(|m| m.id == id || m.local_id == id)) { message.status = status.into(); }
    state.borrow_mut().mark_render();
}

fn start_call(state: &Rc<RefCell<State>>) {
    let (chat, enabled, reason) = { let app = state.borrow(); (app.active_chat(), app.capabilities.call_enabled, app.capabilities.call_reason.clone()) };
    let Some(chat) = chat else { state.borrow().set_status("เลือกแชตส่วนตัวก่อนโทร"); return };
    if chat.kind != "dm" { state.borrow().set_status("สายเสียงรองรับเฉพาะแชตส่วนตัว 1:1"); return; }
    if !enabled { show_call_window(state, if reason.is_empty() { "ระบบสายเสียงยังไม่พร้อมบนเครื่องนี้" } else { &reason }); return; }
    show_call_window(state, "กำลังเริ่มสาย…");
    let mut app = state.borrow_mut();
    app.request_timeout("call.start", json!({ "peer": chat.id }), Pending::CallStart, Duration::from_secs(90));
    app.request("call.devices", json!({}), Pending::CallDevices);
}

fn show_call_window(state: &Rc<RefCell<State>>, initial: &str) {
    if let Some(window) = state.borrow().call_window.clone() { update_call_status(state, initial); window.present(); return; }
    let peer = state.borrow().active_chat().map(|c| c.name).unwrap_or_else(|| "LINE".into());
    let window = gtk::Window::builder().transient_for(&state.borrow().window).title(format!("โทร · {peer}")).default_width(380).default_height(250).modal(false).build();
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(14).margin_top(26).margin_bottom(20).margin_start(26).margin_end(26).halign(gtk::Align::Fill).build();
    root.append(&gtk::Label::builder().label(peer).css_classes(["call-peer"]).build());
    let status = gtk::Label::builder().label(initial).wrap(true).css_classes(["call-status"]).build(); root.append(&status);
    let output_box = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).build();
    root.append(&output_box);
    let buttons = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(10).halign(gtk::Align::Center).build();
    let mute = gtk::Button::with_label("ปิดไมค์");
    { let state = state.clone(); mute.connect_clicked(move |_| { let muted = !state.borrow().call_muted; state.borrow_mut().call_muted = muted; state.borrow_mut().request("call.setMuted", json!({ "muted": muted }), Pending::CallMute); if let Some(button) = &state.borrow().call_mute_button { button.set_label(if muted { "เปิดไมค์" } else { "ปิดไมค์" }); } }); }
    let end = gtk::Button::with_label("วางสาย"); end.add_css_class("danger");
    { let state = state.clone(); end.connect_clicked(move |_| state.borrow_mut().request("call.end", json!({}), Pending::CallEnd)); }
    buttons.append(&mute); buttons.append(&end); root.append(&buttons); window.set_child(Some(&root));
    { let mut app = state.borrow_mut(); app.call_window = Some(window.clone()); app.call_status_label = Some(status); app.call_mute_button = Some(mute); app.call_output_box = Some(output_box); }
    window.present();
}

fn show_incoming_call(state: &Rc<RefCell<State>>, payload: &Value) {
    let peer_id = payload.get("peer").and_then(Value::as_str).unwrap_or("LINE");
    let peer = state.borrow().chat_by_id(peer_id).map(|c| c.name).unwrap_or_else(|| "สายเรียกเข้า LINE".into());
    let window = gtk::Window::builder().transient_for(&state.borrow().window).title("สายเรียกเข้า").default_width(380).default_height(250).build();
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(16).margin_top(28).margin_bottom(24).margin_start(28).margin_end(28).build();
    root.append(&gtk::Label::builder().label(peer).css_classes(["call-peer"]).build()); root.append(&gtk::Label::builder().label("สายเสียง LINE เข้า").css_classes(["call-status"]).build());
    let buttons = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(10).halign(gtk::Align::Center).build();
    let accept = gtk::Button::with_label("รับสาย"); accept.add_css_class("primary");
    accept.set_sensitive(state.borrow().capabilities.incoming_call);
    if !state.borrow().capabilities.incoming_call { accept.set_tooltip_text(Some("LINEJS รุ่นนี้ยังไม่มี stable incoming answer flow")); }
    { let state = state.clone(); accept.connect_clicked(move |_| { if state.borrow().capabilities.incoming_call { state.borrow_mut().request_timeout("call.accept", json!({}), Pending::CallAccept, Duration::from_secs(90)); show_call_window(&state, "กำลังรับสาย…"); } else { state.borrow().set_status("LINEJS รุ่นนี้ยังรับสายเข้าไม่ได้"); } }); }
    let reject = gtk::Button::with_label("ปฏิเสธ"); reject.add_css_class("danger");
    { let state = state.clone(); let window = window.clone(); reject.connect_clicked(move |_| { state.borrow_mut().request("call.reject", json!({}), Pending::CallReject); window.close(); }); }
    buttons.append(&accept); buttons.append(&reject); root.append(&buttons); window.set_child(Some(&root));
    state.borrow_mut().incoming_call_window = Some(window.clone());
    window.present();
}

fn update_call_event(state: &Rc<RefCell<State>>, kind: &str, payload: &Value) {
    let text = if kind == "event.call.error" { payload.get("error").and_then(Value::as_str).unwrap_or("สายเกิดข้อผิดพลาด").to_owned() }
    else if kind == "event.call.ended" { "สายสิ้นสุดแล้ว".into() }
    else { payload.get("state").and_then(Value::as_str).unwrap_or("กำลังเชื่อมต่อ").to_owned() };
    update_call_status(state, &text); if kind == "event.call.ended" { close_call_window(state); }
}
fn update_call_status(state: &Rc<RefCell<State>>, text: &str) { if let Some(label) = &state.borrow().call_status_label { label.set_text(text); } }
fn close_call_window(state: &Rc<RefCell<State>>) {
    let (call_window, incoming_call_window) = {
        let mut app = state.borrow_mut();
        let call_window = app.call_window.take();
        let incoming_call_window = app.incoming_call_window.take();
        app.call_status_label = None;
        app.call_mute_button = None;
        app.call_output_box = None;
        app.call_muted = false;
        (call_window, incoming_call_window)
    };
    if let Some(window) = call_window { window.close(); }
    if let Some(window) = incoming_call_window { window.close(); }
}
fn render_calls_landing(state: &Rc<RefCell<State>>) { let mut app = state.borrow_mut(); app.active_chat_id.clear(); app.header_avatar.set_icon_name(Some("call-start-symbolic")); app.chat_title.set_text("โทร"); app.chat_subtitle.set_text(if app.capabilities.call_enabled { "สายเสียง 1:1 พร้อมใช้งาน" } else { "สายเสียงยังไม่พร้อม" }); set_composer_enabled(&app, false, false); app.message_store.remove_all(); }

fn set_composer_enabled(app: &State, enabled: bool, call_enabled: bool) {
    app.composer.set_sensitive(enabled);
    app.attach_button.set_sensitive(enabled);
    app.paste_button.set_sensitive(enabled);
    app.sticker_button.set_sensitive(enabled);
    app.send_button.set_sensitive(enabled && !composer_text(&app.composer).trim().is_empty());
    app.call_button.set_sensitive(enabled && call_enabled);
}

fn cancel_media(state: &Rc<RefCell<State>>, chat_id: &str, local_id: &str) {
    state.borrow_mut().request("media.cancel", json!({ "jobId": local_id }), Pending::MediaCancel { chat_id: chat_id.to_owned(), local_id: local_id.to_owned() });
}

fn paste_clipboard_image(state: &Rc<RefCell<State>>) {
    if state.borrow().active_chat().is_none() { state.borrow().set_status("เลือกแชตก่อนส่งรูป"); return; }
    let Some(display) = gtk::gdk::Display::default() else { state.borrow().set_status("Clipboard ไม่พร้อม"); return; };
    let clipboard = display.clipboard();
    let weak = Rc::downgrade(state);
    clipboard.read_texture_async(gtk::gio::Cancellable::NONE, move |result| {
        let Some(state) = weak.upgrade() else { return; };
        match result {
            Ok(Some(texture)) => {
                let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
                let dir = home.join(".local/share/liney/media-upload-tmp");
                if let Err(error) = std::fs::create_dir_all(&dir) { state.borrow().set_status(&format!("สร้างโฟลเดอร์รูปไม่ได้: {error}")); return; }
                #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)); }
                let path = dir.join(format!("clipboard-{}.png", new_local_id("image")));
                match texture.save_to_png(&path) {
                    Ok(()) => send_media_path(&state, &path),
                    Err(error) => state.borrow().set_status(&format!("อ่านรูปจาก Clipboard ไม่ได้: {error}")),
                }
            }
            Ok(None) => state.borrow().set_status("ไม่พบรูปภาพใน Clipboard"),
            Err(error) => state.borrow().set_status(&format!("อ่าน Clipboard ไม่ได้: {error}")),
        }
    });
}

fn render_call_outputs(state: &Rc<RefCell<State>>) {
    let (box_widget, devices) = {
        let app = state.borrow();
        (app.call_output_box.clone(), app.call_devices.clone())
    };
    let Some(box_widget) = box_widget else { return; };
    while let Some(child) = box_widget.first_child() { box_widget.remove(&child); }
    let outputs: Vec<_> = devices.into_iter().filter(|device| device.kind == "output").collect();
    if outputs.is_empty() { return; }
    box_widget.append(&gtk::Label::builder().label("อุปกรณ์เสียงออก").xalign(0.0).css_classes(["settings-subtitle"]).build());
    for device in outputs {
        let label = if !device.description.is_empty() { device.description.clone() } else if !device.name.is_empty() { device.name.clone() } else { device.id.clone() };
        let button = gtk::Button::builder().label(label).css_classes(["secondary"]).build();
        let state2 = state.clone(); let target = device.id.clone();
        button.connect_clicked(move |_| state2.borrow_mut().request("call.setOutput", json!({ "target": target }), Pending::CallOutput));
        box_widget.append(&button);
    }
}

fn set_tray_enabled(state: &Rc<RefCell<State>>, enabled: bool) {
    if enabled {
        if state.borrow().tray_handle.is_some() { return; }
        use ksni::blocking::TrayMethods;
        let sender = state.borrow().tray_sender.clone();
        match (LineyTray { sender }).spawn() {
            Ok(handle) => state.borrow_mut().tray_handle = Some(handle),
            Err(error) => state.borrow().set_status(&format!("System Tray ใช้ไม่ได้: {error}")),
        }
    } else if let Some(handle) = state.borrow_mut().tray_handle.take() {
        handle.shutdown().wait();
    }
}

