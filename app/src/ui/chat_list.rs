use crate::models::Chat;
use crate::state::{ListFilter, Pending, Section, State};
use crate::ui::helpers::{message_time, now_ms, set_image_async};
use gtk4 as gtk;
use gtk::glib;
use gtk::prelude::*;
use serde_json::json;
use std::{cell::RefCell, rc::Rc, time::Duration};

pub(crate) fn render_sidebar(state: &Rc<RefCell<State>>) {
    let (items, needle, section, store) = {
        let app = state.borrow();
        let mut items: Vec<Chat> = match app.section {
            Section::Messages => app.chats.iter().chain(app.open_chats.iter()).cloned().collect(),
            Section::Friends => app.friends.clone(),
            Section::OpenChat => if app.settings.openchat { app.open_chats.clone() } else { Vec::new() },
            Section::Calls => Vec::new(),
        };
        for chat in &mut items {
            if let Some(ts) = app.settings.local_pins.get(&chat.id) { chat.pinned = true; chat.favorite_timestamp = chat.favorite_timestamp.max(*ts); }
            if chat.kind == "dm" { if let Some(friend) = app.friends.iter().find(|friend| friend.id == chat.id && friend.is_favorite) { chat.is_favorite = true; chat.favorite_time = friend.favorite_time; } }
        }
        let needle = app.query.trim().to_lowercase();
        if !needle.is_empty() {
            if app.section == Section::Messages {
                let seen: std::collections::HashSet<_> = items.iter().map(|c| c.id.clone()).collect();
                items.extend(app.friends.iter().filter(|f| !seen.contains(&f.id)).cloned());
            }
            items.retain(|chat| format!("{} {}", chat.name, chat.subtitle()).to_lowercase().contains(&needle));
        }
        match app.list_filter {
            ListFilter::All => {},
            ListFilter::Unread => items.retain(|chat| chat.unread > 0),
            ListFilter::Pinned => items.retain(|chat| chat.pinned || chat.favorite_timestamp > 0),
            ListFilter::Favorites => items.retain(|chat| chat.is_favorite || chat.favorite_time > 0),
        }
        items.sort_by(|a,b| b.pinned.cmp(&a.pinned).then_with(|| b.favorite_timestamp.cmp(&a.favorite_timestamp)).then_with(|| b.last_message_time.cmp(&a.last_message_time)).then_with(|| a.name.cmp(&b.name)));
        (items, needle, app.section, app.chat_store.clone())
    };
    let empty_label = state.borrow().chat_empty.clone();
    if section == Section::Calls {
        store.remove_all();
        empty_label.set_text("เลือกแชตส่วนตัวแล้วกดปุ่มโทรด้านบน");
        empty_label.set_visible(true);
        state.borrow_mut().sidebar_ids = Vec::new();
        return;
    }
    if items.is_empty() {
        store.remove_all();
        let text = if !needle.is_empty() { "ไม่พบผลการค้นหา" } else if section == Section::OpenChat { "ไม่พบ OpenChat" } else { "ยังไม่มีรายการ" };
        empty_label.set_text(text);
        empty_label.set_visible(true);
        state.borrow_mut().sidebar_ids = Vec::new();
        return;
    }
    empty_label.set_visible(false);
    let ids: Vec<String> = items.iter().map(|c| c.id.clone()).collect();
    let n = store.n_items() as usize;
    let objects: Vec<glib::Object> = items.iter().map(|c| gtk::StringObject::new(&serde_json::to_string(c).unwrap()).upcast::<glib::Object>()).collect();
    store.splice(0, n as u32, &objects);
    state.borrow_mut().sidebar_ids = ids;
}

pub(crate) fn maybe_select_first_chat(state: &Rc<RefCell<State>>) {
    let first = {
        let app = state.borrow();
        if !app.active_chat_id.is_empty() { return; }
        app.chats.first().or_else(|| app.open_chats.first()).map(|c| c.id.clone())
    };
    if let Some(id) = first { open_chat(state, &id); }
}

pub(crate) fn open_chat(state: &Rc<RefCell<State>>, id: &str) {
    let chat = state.borrow().chat_by_id(id);
    let Some(chat) = chat else { return };
    {
        let mut app = state.borrow_mut();
        app.active_chat_id = chat.id.clone(); app.follow_bottom = true; app.scroll_bottom_button.set_visible(false);
        app.chat_title.set_text(&chat.name); app.chat_subtitle.set_text(&chat.subtitle());
        app.header_avatar.set_icon_name(Some("avatar-default-symbolic")); app.header_avatar.set_pixel_size(38);
        if !chat.avatar_url.is_empty() {
            if let Some(data) = app.asset_cache.get(&chat.avatar_url).cloned() { let image = app.header_avatar.clone(); set_image_async(&image, &data, 38, 38); }
            else { let image = app.header_avatar.clone(); app.request_timeout("asset.preview", json!({ "url": chat.avatar_url }), Pending::AssetImage { image, url: chat.avatar_url.clone(), size: 38, guard_chat_id: chat.id.clone() }, Duration::from_secs(30)); }
        }
        app.reply_target = None; crate::set_composer_enabled(&app, true, chat.kind == "dm" && app.capabilities.call_enabled); app.mark_read(&chat);
        app.set_status("กำลังโหลดข้อความ…");
        app.request_timeout("message.list", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "limit": if chat.kind == "openchat" { 40 } else { 50 } }), Pending::Messages { chat_id: chat.id.clone() }, Duration::from_secs(60));
    }
    crate::update_reply_bar(state); render_sidebar(state); crate::render_messages(state);
}

pub(crate) fn toggle_local_pin(state: &Rc<RefCell<State>>, chat_id: &str) {
    let mut app = state.borrow_mut();
    if app.settings.local_pins.remove(chat_id).is_none() { app.settings.local_pins.insert(chat_id.to_owned(), now_ms()); }
    let pin_ts = app.settings.local_pins.get(chat_id).copied();
    for chat in app.chats.iter_mut() { if chat.id == chat_id { if let Some(ts) = pin_ts { chat.pinned = true; chat.favorite_timestamp = chat.favorite_timestamp.max(ts); } else { chat.pinned = false; chat.favorite_timestamp = 0; } } }
    for chat in app.open_chats.iter_mut() { if chat.id == chat_id { if let Some(ts) = pin_ts { chat.pinned = true; chat.favorite_timestamp = chat.favorite_timestamp.max(ts); } else { chat.pinned = false; chat.favorite_timestamp = 0; } } }
    for chat in app.friends.iter_mut() { if chat.id == chat_id { if let Some(ts) = pin_ts { chat.pinned = true; chat.favorite_timestamp = chat.favorite_timestamp.max(ts); } else { chat.pinned = false; chat.favorite_timestamp = 0; } } }
    let _ = crate::settings::save(&app.settings);
    if pin_ts.is_none() { app.request_timeout("chat.list", json!({}), Pending::Chats, Duration::from_secs(60)); }
    drop(app);
    render_sidebar(state);
}

pub(crate) fn update_chat_preview(state: &Rc<RefCell<State>>, chat_id: &str, preview: &str, created_time: i64) {
    let mut app = state.borrow_mut();
    for chat in app.chats.iter_mut() { if chat.id == chat_id { chat.preview = preview.to_owned(); chat.last_message_time = created_time; } }
    for chat in app.open_chats.iter_mut() { if chat.id == chat_id { chat.preview = preview.to_owned(); chat.last_message_time = created_time; } }
    drop(app);
    render_sidebar(state);
}

pub(crate) fn chat_row(state: &Rc<RefCell<State>>, chat: &Chat) -> gtk::Box {
    let root = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(9).css_classes(["chat-row"]).build();
    let initial = chat.name.chars().next().unwrap_or('L').to_string();
    let avatar_box = gtk::Overlay::new(); avatar_box.add_css_class("avatar"); avatar_box.set_size_request(44, 44);
    let fallback = gtk::Label::builder().label(initial).halign(gtk::Align::Center).valign(gtk::Align::Center).build(); avatar_box.set_child(Some(&fallback));
    if !chat.avatar_url.is_empty() {
        let image = gtk::Image::new(); image.set_pixel_size(44); avatar_box.add_overlay(&image);
        let cached = state.borrow().asset_cache.get(&chat.avatar_url).cloned();
        if let Some(data) = cached { set_image_async(&image, &data, 44, 44); }
        else { state.borrow_mut().request_timeout("asset.preview", json!({ "url": chat.avatar_url }), Pending::AssetImage { image, url: chat.avatar_url.clone(), size: 44, guard_chat_id: String::new() }, Duration::from_secs(30)); }
    }
    root.append(&avatar_box);
    let text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(3).hexpand(true).valign(gtk::Align::Center).build();
    text.append(&gtk::Label::builder().label(&chat.name).xalign(0.0).ellipsize(gtk::pango::EllipsizeMode::End).css_classes(["chat-name"]).build());
    text.append(&gtk::Label::builder().label(chat.subtitle()).xalign(0.0).ellipsize(gtk::pango::EllipsizeMode::End).css_classes(["chat-preview"]).build()); root.append(&text);
    let right = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).halign(gtk::Align::End).valign(gtk::Align::Center).build();
    if chat.last_message_time > 0 { right.append(&gtk::Label::builder().label(message_time(chat.last_message_time)).css_classes(["chat-time"]).build()); }
    if chat.unread > 0 { right.append(&gtk::Label::builder().label(chat.unread.to_string()).halign(gtk::Align::Center).css_classes(["unread"]).build()); }
    let pin = gtk::Button::builder().icon_name(if chat.pinned { "starred-symbolic" } else { "non-starred-symbolic" }).tooltip_text(if chat.pinned { "เลิกปักหมุด" } else { "ปักหมุด" }).css_classes(["pin-button"]).build();
    { let state = state.clone(); let id = chat.id.clone(); pin.connect_clicked(move |_| toggle_local_pin(&state, &id)); }
    right.append(&pin);
    root.append(&right); root
}
