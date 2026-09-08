use crate::composer_media;
use crate::models::{Chat, Message};
use crate::state::{Pending, State};
use crate::ui::helpers::{
    avatar_widget, flex_spacing, is_arranged_sticker_url, is_safe_external_uri, message_time,
    open_safe_uri, picture_from_data_url, pixbuf_from_data_url, reaction_icon, set_image_async,
    set_picture_async, small_button, sticker_candidate_urls,
};
use gtk4 as gtk;
use gtk::glib;
use gtk::prelude::*;
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc, time::Duration};

pub(crate) fn render_messages(state: &Rc<RefCell<State>>) {
    let (messages, active, store, empty_label, scroll, follow_bottom, old_value) = {
        let mut app = state.borrow_mut();
        let adjustment = app.messages_scroll.vadjustment();
        let old_value = adjustment.value();
        app.scroll_programmatic = true;
        (app.messages.get(&app.active_chat_id).cloned().unwrap_or_default(), app.active_chat(), app.message_store.clone(), app.message_empty.clone(), app.messages_scroll.clone(), app.follow_bottom, old_value)
    };
    let Some(_chat) = active else {
        store.remove_all();
        empty_label.set_text("เลือกแชตทางซ้ายเพื่อเริ่มใช้งาน");
        empty_label.set_visible(true);
        return;
    };
    if messages.is_empty() {
        store.remove_all();
        empty_label.set_text("ยังไม่มีข้อความในห้องนี้");
        empty_label.set_visible(true);
    } else {
        empty_label.set_visible(false);
        let objects: Vec<glib::Object> = messages.iter().map(|m| gtk::StringObject::new(&serde_json::to_string(m).unwrap()).upcast::<glib::Object>()).collect();
        let n = store.n_items();
        store.splice(0, n, &objects);
    }
    let weak = Rc::downgrade(state);
    gtk::glib::idle_add_local_once(move || {
        let adjustment = scroll.vadjustment();
        if follow_bottom { adjustment.set_value((adjustment.upper() - adjustment.page_size()).max(adjustment.lower())); }
        else { adjustment.set_value(old_value.min((adjustment.upper() - adjustment.page_size()).max(adjustment.lower()))); }
        if let Some(state) = weak.upgrade() {
            let mut app = state.borrow_mut(); app.scroll_programmatic = false;
            let distance = adjustment.upper() - adjustment.page_size() - adjustment.value();
            app.follow_bottom = distance < 72.0; app.scroll_bottom_button.set_visible(!app.follow_bottom && distance > 140.0);
        }
    });
}

pub(crate) fn maybe_jump_to_message(state: &Rc<RefCell<State>>, chat_id: &str) {
    let jump = state.borrow().pending_jump.clone();
    let Some((target_chat, message_id)) = jump else { return; };
    if target_chat != chat_id { return; }
    let index = state.borrow().messages.get(chat_id).and_then(|items| items.iter().position(|message| message.id == message_id));
    let Some(_index) = index else { return; };
    state.borrow_mut().pending_jump = None;
    // For ListView, jump is handled via store position; keep pending cleared and rely on normal render
}

pub(crate) fn scroll_messages_to_bottom(state: &Rc<RefCell<State>>) {
    let scroll = state.borrow().messages_scroll.clone();
    { let mut app = state.borrow_mut(); app.follow_bottom = true; app.scroll_programmatic = true; app.scroll_bottom_button.set_visible(false); }
    let weak = Rc::downgrade(state);
    gtk::glib::idle_add_local_once(move || {
        let adjustment = scroll.vadjustment(); adjustment.set_value((adjustment.upper() - adjustment.page_size()).max(adjustment.lower()));
        if let Some(state) = weak.upgrade() { state.borrow_mut().scroll_programmatic = false; }
    });
}

pub(crate) fn message_row(state: &Rc<RefCell<State>>, chat: &Chat, message: &Message) -> gtk::ListBoxRow {
    let row = gtk::ListBoxRow::new(); row.set_selectable(false);
    let outer = gtk::Box::builder().orientation(gtk::Orientation::Vertical).halign(if message.is_mine { gtk::Align::End } else { gtk::Align::Start }).css_classes(["message-wrap"]).build();
    if !message.is_mine && chat.kind != "dm" && !message.sender_name.is_empty() { outer.append(&gtk::Label::builder().label(&message.sender_name).xalign(0.0).css_classes(["sender"]).build()); }
    let bubble = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).css_classes(if message.is_mine { vec!["message", "mine"] } else { vec!["message"] }).build();
    if let Some(reply) = &message.reply_to {
        let text = if reply.text.is_empty() { "ข้อความที่ตอบกลับ" } else { &reply.text };
        bubble.append(&gtk::Label::builder().label(text).xalign(0.0).ellipsize(gtk::pango::EllipsizeMode::End).css_classes(["reply-preview"]).build());
    }
    if is_arranged_sticker_url(&message.sticker_url) {
        bubble.append(&gtk::Label::builder().label("สติกเกอร์แบบจัดวางจาก LINE · รูปแบบนี้ไม่มีไฟล์ภาพเดี่ยวให้แสดง").wrap(true).xalign(0.0).css_classes(["structured-card"]).build());
    } else if !message.image_data_url.is_empty() {
        let picture = gtk::Picture::new();
        picture.set_can_shrink(true);
        picture.add_css_class("message-image");
        set_picture_async(&picture, &message.image_data_url, 460, 340);
        let viewer = gtk::Button::builder().child(&picture).css_classes(["image-button"]).build();
        let state2 = state.clone(); let parent = state.borrow().window.clone(); let data_url = message.image_data_url.clone();
        viewer.connect_clicked(move |_| {
            let state = state2.clone();
            composer_media::show_image_viewer(&parent, &data_url, move |message| state.borrow().set_status(message));
        });
        bubble.append(&viewer);
    } else if !message.asset_data_url.is_empty() {
        let picture = gtk::Picture::new();
        picture.set_can_shrink(true);
        picture.add_css_class("message-sticker");
        set_picture_async(&picture, &message.asset_data_url, 240, 200);
        bubble.append(&picture);
    } else if !message.rich.is_null() {
        bubble.append(&rich_message_widget(state, &message.rich));
    } else if !message.flex.is_null() {
        bubble.append(&flex_message_widget(state, &message.flex));
    } else if !message.post_notification.is_null() {
        bubble.append(&post_notification_widget(state, &message.post_notification));
    } else {
        let summary = message.summary();
        bubble.append(&gtk::Label::builder().label(summary).wrap(true).selectable(true).xalign(0.0).max_width_chars(44).build());
    }
    if !message.reactions.is_empty() {
        let reactions = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(5).build();
        for reaction in &message.reactions {
            if reaction.count == 0 { continue; }
            reactions.append(&gtk::Label::builder().label(format!("{} {}", reaction_icon(reaction.reaction_type), reaction.count)).css_classes(if reaction.mine { vec!["reaction", "mine-reaction"] } else { vec!["reaction"] }).build());
        }
        bubble.append(&reactions);
    }
    outer.append(&bubble);
    let meta = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(8).halign(if message.is_mine { gtk::Align::End } else { gtk::Align::Start }).build();
    meta.append(&gtk::Label::builder().label(message_time(message.created_time)).css_classes(["message-meta"]).build());
    if message.is_mine {
        let status = match message.status.as_str() { "sending" => "กำลังส่ง", "error" => "ส่งไม่สำเร็จ", "unknown" => "ไม่แน่ใจว่าส่งถึงหรือไม่", _ if message.read_by_peer => "อ่านแล้ว", _ => "" };
        if !status.is_empty() { meta.append(&gtk::Label::builder().label(status).css_classes(["message-meta"]).build()); }
    }
    outer.append(&meta);
    let actions = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(4).halign(if message.is_mine { gtk::Align::End } else { gtk::Align::Start }).css_classes(["message-actions"]).build();
    let reply = small_button("ตอบกลับ");
    { let state = state.clone(); let message = message.clone(); reply.connect_clicked(move |_| { crate::begin_reply(&state, &message); }); }
    actions.append(&reply);
    let react = small_button("♡");
    { let state = state.clone(); let chat = chat.clone(); let message = message.clone(); react.connect_clicked(move |button| crate::show_reaction_picker(&state, &chat, &message, button)); }
    actions.append(&react);
    let delete = small_button("ลบของฉัน");
    { let state = state.clone(); let chat = chat.clone(); let message = message.clone(); delete.connect_clicked(move |_| crate::delete_for_me(&state, &chat, &message)); }
    actions.append(&delete);
    if message.is_mine && !message.unsent && message.status == "sent" {
        let unsend = small_button("ยกเลิกส่ง");
        { let state = state.clone(); let chat = chat.clone(); let message = message.clone(); unsend.connect_clicked(move |_| crate::unsend_message(&state, &chat, &message)); }
        actions.append(&unsend);
    }
    if message.status == "sending" && message.content_type > 0 {
        let cancel = small_button("ยกเลิกไฟล์");
        { let state = state.clone(); let chat_id = chat.id.clone(); let local_id = message.id.clone(); cancel.connect_clicked(move |_| crate::cancel_media(&state, &chat_id, &local_id)); }
        actions.append(&cancel);
    }
    if matches!(message.status.as_str(), "error" | "unknown") {
        let retry = small_button("ลองใหม่");
        { let state = state.clone(); let chat_id = chat.id.clone(); let local_id = message.id.clone(); retry.connect_clicked(move |_| crate::retry_message(&state, &chat_id, &local_id)); }
        actions.append(&retry);
    }
    outer.append(&actions);
    let line = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(8).hexpand(true).build();
    if message.is_mine { line.append(&gtk::Box::builder().hexpand(true).build()); } else {
        let name = if !message.sender_name.is_empty() { message.sender_name.clone() } else { chat.name.clone() };
        let url = if !message.sender_avatar_url.is_empty() { message.sender_avatar_url.clone() } else if chat.kind == "dm" { chat.avatar_url.clone() } else { String::new() };
        let avatar = avatar_widget(state, &name, &url, 34);
        avatar.set_valign(gtk::Align::Start);
        avatar.set_margin_top(4);
        line.append(&avatar);
    }
    line.append(&outer); row.set_child(Some(&line)); row
}

pub(crate) fn hydrate_message_assets(state: &Rc<RefCell<State>>, chat_id: &str) {
    let (chat, messages) = {
        let app = state.borrow();
        (app.chat_by_id(chat_id), app.messages.get(chat_id).cloned().unwrap_or_default())
    };
    let Some(chat) = chat else { return };
    let mut app = state.borrow_mut();
    for message in messages {
        if message.content_type == 1 && message.image_data_url.is_empty() && (chat.kind != "openchat" || app.settings.auto_media) {
            app.request_timeout("media.preview", json!({ "messageId": message.id, "chatId": chat.id, "kind": chat.engine_kind() }), Pending::MediaPreview { chat_id: chat.id.clone(), message_id: message.id.clone(), attempt: 0 }, Duration::from_secs(60));
        }
        let url = if !message.sticker_url.is_empty() { message.sticker_url.clone() } else if !message.emoji_url.is_empty() { message.emoji_url.clone() } else { String::new() };
        if !url.is_empty() && message.asset_data_url.is_empty() && !is_arranged_sticker_url(&url) {
            let candidates = if !message.sticker_url.is_empty() { sticker_candidate_urls(&url) } else { vec![url.clone()] };
            if let Some(first) = candidates.first().cloned() { app.request_timeout("asset.preview", json!({ "url": first }), Pending::AssetMessage { chat_id: chat.id.clone(), message_id: message.id.clone(), candidates, index: 0 }, Duration::from_secs(30)); }
        }
    }
}

pub(crate) fn rich_message_widget(state: &Rc<RefCell<State>>, value: &Value) -> gtk::Box {
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).css_classes(["rich-native"]).build();
    let url = value.get("imageUrl").and_then(Value::as_str).unwrap_or("").to_owned();
    let alt = value.get("altText").and_then(Value::as_str).unwrap_or("Rich message");
    let source_width = value.get("width").and_then(Value::as_f64).unwrap_or(1000.0).max(1.0);
    let source_height = value.get("height").and_then(Value::as_f64).unwrap_or(1000.0).max(1.0);
    let display_width = 420.0f64;
    let display_height = (display_width * source_height / source_width).clamp(120.0, 520.0);
    let overlay = gtk::Overlay::new(); overlay.set_size_request(display_width as i32, display_height as i32);
    let picture = gtk::Picture::new(); picture.set_size_request(display_width as i32, display_height as i32); picture.set_can_shrink(true); overlay.set_child(Some(&picture));
    let fallback = gtk::Label::builder().label(alt).wrap(true).justify(gtk::Justification::Center).halign(gtk::Align::Center).valign(gtk::Align::Center).css_classes(["rich-fallback"]).build(); overlay.add_overlay(&fallback);
    if !url.is_empty() {
        let cached = { state.borrow().asset_cache.get(&url).cloned() };
        if let Some(data) = cached {
            let picture2 = picture.clone();
            let fallback2 = fallback.clone();
            crate::ui::helpers::load_pixbuf_async(data, display_width as i32, display_height as i32, move |pixbuf| {
                if let Some(pixbuf) = pixbuf {
                    picture2.set_pixbuf(Some(&pixbuf));
                    fallback2.set_visible(false);
                }
            });
        }
        else { state.borrow_mut().request_timeout("asset.preview", json!({ "url": url }), Pending::AssetPicture { picture: picture.clone(), url: url.clone(), max_width: display_width as i32, max_height: display_height as i32 }, Duration::from_secs(30)); }
    }
    let fixed = gtk::Fixed::new(); fixed.set_size_request(display_width as i32, display_height as i32);
    if let Some(actions) = value.get("actions").and_then(Value::as_array) {
        for action in actions {
            let Some(link) = action.get("link").and_then(Value::as_str).filter(|link| is_safe_external_uri(link)) else { continue };
            let x = action.get("x").and_then(Value::as_f64).unwrap_or(0.0) / source_width * display_width;
            let y = action.get("y").and_then(Value::as_f64).unwrap_or(0.0) / source_height * display_height;
            let w = action.get("width").and_then(Value::as_f64).unwrap_or(0.0) / source_width * display_width;
            let h = action.get("height").and_then(Value::as_f64).unwrap_or(0.0) / source_height * display_height;
            if w < 2.0 || h < 2.0 { continue; }
            let button = gtk::Button::builder().tooltip_text("เปิดเนื้อหา").css_classes(["rich-hotspot"]).width_request(w.round() as i32).height_request(h.round() as i32).build();
            let state2 = state.clone(); let link = link.to_owned(); button.connect_clicked(move |_| open_safe_uri(&state2, &link)); fixed.put(&button, x, y);
        }
    }
    overlay.add_overlay(&fixed); root.append(&overlay); root
}

pub(crate) fn post_notification_widget(state: &Rc<RefCell<State>>, value: &Value) -> gtk::Box {
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("post");
    let title = value.get("title").and_then(Value::as_str).unwrap_or("มีโพสต์ใหม่");
    let body = value.get("body").and_then(Value::as_str).unwrap_or("");
    let link = value.get("link").and_then(Value::as_str).unwrap_or("");
    let card = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).css_classes(["post-card"]).build();
    let icon = match kind { "album" => "▣", "note" => "▤", _ => "●" };
    card.append(&gtk::Label::builder().label(format!("{icon}  {title}")).xalign(0.0).css_classes(["structured-title"]).build());
    if !body.is_empty() { card.append(&gtk::Label::builder().label(body).wrap(true).xalign(0.0).build()); }
    if is_safe_external_uri(link) { let button = gtk::Button::builder().label("เปิดใน LINE / Browser").css_classes(["secondary"]).build(); let state = state.clone(); let link = link.to_owned(); button.connect_clicked(move |_| open_safe_uri(&state, &link)); card.append(&button); }
    card
}

pub(crate) fn flex_message_widget(state: &Rc<RefCell<State>>, value: &Value) -> gtk::Box {
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).css_classes(["flex-native"]).build();
    if let Some(alt) = value.get("altText").and_then(Value::as_str).filter(|text| !text.trim().is_empty()) { root.set_tooltip_text(Some(alt)); }
    let contents = value.get("contents").unwrap_or(value);
    let kind = contents.get("type").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    if kind == "carousel" {
        let row = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(10).build();
        if let Some(items) = contents.get("contents").and_then(Value::as_array) { for item in items.iter().take(12) { row.append(&flex_bubble_widget(state, item)); } }
        root.append(&gtk::ScrolledWindow::builder().child(&row).hscrollbar_policy(gtk::PolicyType::Automatic).vscrollbar_policy(gtk::PolicyType::Never).min_content_width(420).build());
    } else { root.append(&flex_bubble_widget(state, contents)); }
    root
}

pub(crate) fn flex_bubble_widget(state: &Rc<RefCell<State>>, node: &Value) -> gtk::Box {
    let bubble = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(0).width_request(320).css_classes(["flex-bubble-native"]).build();
    for section in ["header", "hero", "body", "footer"] { if let Some(value) = node.get(section).filter(|v| v.is_object()) { bubble.append(&flex_node_widget(state, value)); } }
    bubble
}

pub(crate) fn flex_node_widget(state: &Rc<RefCell<State>>, node: &Value) -> gtk::Widget {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    match kind.as_str() {
        "box" => {
            let horizontal = matches!(node.get("layout").and_then(Value::as_str).unwrap_or("vertical").to_ascii_lowercase().as_str(), "horizontal" | "baseline");
            let box_widget = gtk::Box::builder().orientation(if horizontal { gtk::Orientation::Horizontal } else { gtk::Orientation::Vertical }).spacing(flex_spacing(node.get("spacing").and_then(Value::as_str))).build();
            if let Some(children) = node.get("contents").and_then(Value::as_array) { for child in children.iter().take(64) { box_widget.append(&flex_node_widget(state, child)); } }
            wrap_flex_action(state, node.get("action"), box_widget.upcast())
        }
        "text" | "span" => {
            let text = node.get("text").and_then(Value::as_str).unwrap_or("");
            let label = gtk::Label::builder().label(text).wrap(node.get("wrap").and_then(Value::as_bool).unwrap_or(true)).xalign(match node.get("align").and_then(Value::as_str).unwrap_or("") { "center" => 0.5, "end" => 1.0, _ => 0.0 }).css_classes(if node.get("weight").and_then(Value::as_str).map(|v| v.eq_ignore_ascii_case("bold")).unwrap_or(false) { vec!["flex-text-native", "flex-bold"] } else { vec!["flex-text-native"] }).build();
            wrap_flex_action(state, node.get("action"), label.upcast())
        }
        "image" | "icon" => {
            let size = if kind == "icon" { 42 } else { 300 };
            let picture = gtk::Picture::new(); picture.set_can_shrink(true); picture.set_size_request(size, if kind == "icon" { 42 } else { 180 });
            if let Some(url) = node.get("url").and_then(Value::as_str).filter(|url| url.starts_with("https://")) {
                let url = url.to_owned(); let cached = { state.borrow().asset_cache.get(&url).cloned() };
                if let Some(data) = cached { set_picture_async(&picture, &data, size, 240); }
                else { state.borrow_mut().request_timeout("asset.preview", json!({ "url": url }), Pending::AssetPicture { picture: picture.clone(), url, max_width: size, max_height: 240 }, Duration::from_secs(30)); }
            }
            wrap_flex_action(state, node.get("action"), picture.upcast())
        }
        "button" => {
            let action = node.get("action"); let label = action.and_then(|a| a.get("label")).and_then(Value::as_str).or_else(|| action.and_then(|a| a.get("text")).and_then(Value::as_str)).unwrap_or("เปิด");
            let button = gtk::Button::builder().label(label).css_classes(["flex-button-native"]).build(); if let Some(action) = action.cloned() { let state = state.clone(); button.connect_clicked(move |_| perform_flex_action(&state, &action)); } button.upcast()
        }
        "separator" => gtk::Separator::new(gtk::Orientation::Horizontal).upcast(),
        "spacer" => { let spacer = gtk::Box::new(gtk::Orientation::Vertical, 0); spacer.set_size_request(1, flex_spacing(node.get("size").and_then(Value::as_str)).max(6)); spacer.upcast() },
        "video" => { let box_widget = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(6).build(); box_widget.append(&gtk::Label::builder().label("วิดีโอ Flex").xalign(0.0).build()); if let Some(url) = node.get("url").and_then(Value::as_str).filter(|url| is_safe_external_uri(url)) { let button = gtk::Button::with_label("เปิดวิดีโอ"); let state = state.clone(); let url = url.to_owned(); button.connect_clicked(move |_| open_safe_uri(&state, &url)); box_widget.append(&button); } box_widget.upcast() },
        _ => gtk::Label::builder().label(if kind.is_empty() { "".into() } else { format!("Flex: {kind}") }).xalign(0.0).css_classes(["empty-note"]).build().upcast(),
    }
}

pub(crate) fn wrap_flex_action(state: &Rc<RefCell<State>>, action: Option<&Value>, child: gtk::Widget) -> gtk::Widget {
    let Some(action) = action.filter(|value| value.is_object()).cloned() else { return child };
    let button = gtk::Button::builder().child(&child).css_classes(["flex-action-native"]).build(); let state = state.clone(); button.connect_clicked(move |_| perform_flex_action(&state, &action)); button.upcast()
}

pub(crate) fn perform_flex_action(state: &Rc<RefCell<State>>, action: &Value) {
    match action.get("type").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase().as_str() {
        "message" => if let Some(text) = action.get("text").and_then(Value::as_str) { crate::send_text_value(state, text, false); },
        "uri" => { let desktop = action.pointer("/altUri/desktop").and_then(Value::as_str).unwrap_or(""); let primary = action.get("uri").and_then(Value::as_str).unwrap_or(""); let uri = if desktop.starts_with("http://") || desktop.starts_with("https://") { desktop } else if !primary.is_empty() { primary } else { desktop }; open_safe_uri(state, uri); },
        "clipboard" => if let Some(text) = action.get("clipboardText").and_then(Value::as_str) { if let Some(display) = gtk::gdk::Display::default() { display.clipboard().set_text(text); state.borrow().set_status("คัดลอกไป Clipboard แล้ว"); } },
        _ => state.borrow().set_status("Flex action นี้ไม่มีการทำงานที่ LINEJS ฝั่งไคลเอนต์รองรับ"),
    }
}
