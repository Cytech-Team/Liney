use crate::settings;
use crate::state::{Pending, Section, State};
use crate::theme;
use crate::ui::chat_list::render_sidebar;
use crate::ui::helpers::{avatar_widget, new_local_id, set_image_async};
use crate::ui::message_list::hydrate_message_assets;
use crate::set_tray_enabled;
use gtk4 as gtk;
use gtk::glib::variant::ToVariant;
use gtk::prelude::*;
use qrcode::QrCode;
use serde_json::json;
use std::{cell::RefCell, rc::Rc, time::Duration};

pub(crate) fn show_account(state: &Rc<RefCell<State>>) {
    let app = state.borrow();
    if !app.capabilities.authenticated { app.stack.set_visible_child_name("login"); return; }
    let profile = app.profile.clone().unwrap_or_default();
    let storage = app.capabilities.storage_mode.clone();
    let parent = app.window.clone();
    drop(app);
    let window = gtk::Window::builder().transient_for(&parent).title("บัญชี LINE · Liney").default_width(440).default_height(360).modal(false).build();
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(12).margin_top(24).margin_bottom(24).margin_start(24).margin_end(24).build();
    let profile_url = if profile.picture_status.starts_with("http://") || profile.picture_status.starts_with("https://") { profile.picture_status.clone() } else if !profile.picture_status.is_empty() { format!("https://profile.line-scdn.net/{}", profile.picture_status.trim_start_matches('/')) } else { String::new() };
    let avatar = avatar_widget(state, &profile.display_name, &profile_url, 72);
    avatar.set_halign(gtk::Align::Center); root.append(&avatar);
    root.append(&gtk::Label::builder().label(if profile.display_name.is_empty() { "LINE Account" } else { &profile.display_name }).css_classes(["settings-title"]).build());
    if !profile.status_message.is_empty() { root.append(&gtk::Label::builder().label(&profile.status_message).wrap(true).justify(gtk::Justification::Center).css_classes(["settings-subtitle"]).build()); }
    root.append(&gtk::Label::builder().label(format!("Credential: {}", if storage == "wallet" { "Wallet / Secret Service" } else { "session-only · ไม่เขียน token ลงไฟล์" })).wrap(true).justify(gtk::Justification::Center).css_classes(["settings-subtitle"]).build());
    root.append(&gtk::Label::builder().label("Liney ไม่มี server กลางสำหรับอ่านข้อความ · ข้อมูล local อยู่ใน ~/.local/share/liney").wrap(true).justify(gtk::Justification::Center).css_classes(["settings-subtitle"]).build());
    let logout = gtk::Button::with_label("ออกจากระบบบนเครื่องนี้"); logout.add_css_class("danger");
    { let state = state.clone(); let window = window.clone(); logout.connect_clicked(move |_| { state.borrow_mut().request("auth.logout", json!({}), Pending::Logout); window.close(); }); }
    root.append(&logout); window.set_child(Some(&root)); window.present();
}

pub(crate) fn show_settings(state: &Rc<RefCell<State>>) {
    let window = gtk::Window::builder().transient_for(&state.borrow().window).title("ตั้งค่า Liney").default_width(560).default_height(650).modal(false).build();
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(12).margin_top(18).margin_bottom(18).margin_start(20).margin_end(20).build();
    let profile = state.borrow().profile.clone().unwrap_or_default();
    let profile_header = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(12).build();
    if !profile.picture_status.is_empty() {
        let image = gtk::Image::new(); image.set_pixel_size(54);
        let url = if profile.picture_status.starts_with("http://") || profile.picture_status.starts_with("https://") { profile.picture_status.clone() } else { format!("https://profile.line-scdn.net/{}", profile.picture_status.trim_start_matches('/')) };
        let cached = { state.borrow().asset_cache.get(&url).cloned() };
        if let Some(data) = cached { set_image_async(&image, &data, 54, 54); }
        else { state.borrow_mut().request_timeout("asset.preview", json!({ "url": url }), Pending::AssetImage { image: image.clone(), url, size: 54, guard_chat_id: String::new() }, Duration::from_secs(30)); }
        profile_header.append(&image);
    }
    let profile_text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(3).hexpand(true).build();
    profile_text.append(&gtk::Label::builder().label(if profile.display_name.is_empty() { "Liney" } else { &profile.display_name }).xalign(0.0).css_classes(["settings-title"]).build());
    if !profile.mid.is_empty() { profile_text.append(&gtk::Label::builder().label(format!("MID {}", profile.mid)).xalign(0.0).ellipsize(gtk::pango::EllipsizeMode::Middle).css_classes(["settings-subtitle"]).build()); }
    profile_header.append(&profile_text); root.append(&profile_header);
    if !profile.status_message.is_empty() { root.append(&gtk::Label::builder().label(profile.status_message).xalign(0.0).wrap(true).css_classes(["settings-subtitle"]).build()); }
    let caps = state.borrow().capabilities.clone();
    root.append(&gtk::Label::builder().label(format!("LINEJS {} · storage: {} · GTK4 native", caps.linejs_version, caps.storage_mode)).xalign(0.0).css_classes(["settings-subtitle"]).build());

    for (label, key, active) in [
        ("เปิดพร้อมระบบ", "startup", state.borrow().settings.startup),
        ("ซ่อนลง System Tray เมื่อปิดหน้าต่าง", "tray", state.borrow().settings.tray),
        ("Desktop notifications", "desktop_notifications", state.borrow().settings.desktop_notifications),
        ("แสดงข้อความใน notification", "notification_preview", state.borrow().settings.notification_preview),
        ("เสียง notification", "notification_sound", state.borrow().settings.notification_sound),
        ("เปิดใช้งาน OpenChat", "openchat", state.borrow().settings.openchat),
        ("โหลดรูป OpenChat อัตโนมัติ", "auto_media", state.borrow().settings.auto_media),
    ] {
        let row = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(10).css_classes(["settings-row"]).build();
        row.append(&gtk::Label::builder().label(label).xalign(0.0).hexpand(true).build());
        let switch = gtk::Switch::builder().active(active).valign(gtk::Align::Center).build();
        let state2 = state.clone(); let key = key.to_owned();
        switch.connect_active_notify(move |sw| {
            let mut app = state2.borrow_mut();
            match key.as_str() {
                "startup" => { app.settings.startup = sw.is_active(); let _ = settings::apply_autostart(sw.is_active()); },
                "tray" => app.settings.tray = sw.is_active(),
                "desktop_notifications" => app.settings.desktop_notifications = sw.is_active(),
                "notification_preview" => app.settings.notification_preview = sw.is_active(),
                "notification_sound" => app.settings.notification_sound = sw.is_active(),
                "openchat" => { app.settings.openchat = sw.is_active(); if let Some(button) = app.nav_buttons.get(&Section::OpenChat) { button.set_visible(sw.is_active()); } if sw.is_active() { app.request_timeout("openchat.list", json!({}), Pending::OpenChats, Duration::from_secs(90)); } },
                "auto_media" => app.settings.auto_media = sw.is_active(),
                _ => {}
            }
            let _ = settings::save(&app.settings);
            let tray_value = app.settings.tray;
            drop(app);
            if key == "tray" { set_tray_enabled(&state2, tray_value); }
            render_sidebar(&state2);
            if key == "auto_media" { let id = state2.borrow().active_chat_id.clone(); if !id.is_empty() { hydrate_message_assets(&state2, &id); } }
        });
        row.append(&switch); root.append(&row);
    }

    let theme_row = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(10).css_classes(["settings-row"]).build();
    theme_row.append(&gtk::Label::builder().label("ธีม").xalign(0.0).hexpand(true).build());
    let theme = gtk::DropDown::from_strings(&["System", "Dark", "Light"]); theme.set_selected(match state.borrow().settings.theme.as_str() { "dark" => 1, "light" => 2, _ => 0 });
    { let state = state.clone(); theme.connect_selected_notify(move |drop| { let mut app = state.borrow_mut(); app.settings.theme = match drop.selected() { 1 => "dark", 2 => "light", _ => "system" }.into(); theme::load_css(&app.css_provider, &app.settings); let _ = settings::save(&app.settings); }); }
    theme_row.append(&theme); root.append(&theme_row);

    let density_row = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(10).css_classes(["settings-row"]).build();
    density_row.append(&gtk::Label::builder().label("ความหนาแน่น UI").xalign(0.0).hexpand(true).build());
    let density = gtk::DropDown::from_strings(&["Compact", "Comfortable", "Spacious"]);
    density.set_selected(match state.borrow().settings.density.as_str() { "compact" => 0, "spacious" => 2, _ => 1 });
    { let state = state.clone(); density.connect_selected_notify(move |drop| { let mut app = state.borrow_mut(); app.settings.density = match drop.selected() { 0 => "compact", 2 => "spacious", _ => "comfortable" }.into(); theme::apply_window_density(&app.window, &app.settings); let _ = settings::save(&app.settings); }); }
    density_row.append(&density); root.append(&density_row);

    let radius_row = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(10).css_classes(["settings-row"]).build();
    radius_row.append(&gtk::Label::builder().label("ความโค้งมุม").xalign(0.0).hexpand(true).build());
    let radius = gtk::DropDown::from_strings(&["Round", "Soft"]); radius.set_selected(if state.borrow().settings.radius == "soft" { 1 } else { 0 });
    { let state = state.clone(); radius.connect_selected_notify(move |drop| { let mut app = state.borrow_mut(); app.settings.radius = if drop.selected() == 1 { "soft".into() } else { "round".into() }; theme::load_css(&app.css_provider, &app.settings); let _ = settings::save(&app.settings); }); }
    radius_row.append(&radius); root.append(&radius_row);

    let buttons = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).margin_top(10).build();
    let clear_history = gtk::Button::with_label("ล้างประวัติข้อความและ media cache ในเครื่อง");
    { let state = state.clone(); clear_history.connect_clicked(move |_| confirm_action(&state, "ล้างข้อมูลในเครื่อง?", "ลบประวัติข้อความและ media cache เฉพาะเครื่องนี้ ไม่ลบข้อความบน LINE", |state| state.borrow_mut().request("history.clear", json!({}), Pending::HistoryClear))); }
    let clear_stickers = gtk::Button::with_label("ล้างแคชสติกเกอร์");
    { let state = state.clone(); clear_stickers.connect_clicked(move |_| confirm_action(&state, "ล้างแคชสติกเกอร์?", "ครั้งถัดไป Liney จะดึงรายการสติกเกอร์จาก LINE ใหม่", |state| state.borrow_mut().request("sticker.cache.clear", json!({}), Pending::StickerCacheClear))); }
    let full_sync = gtk::Button::with_label("Full Sync — ซิงก์ทุกห้องใหม่ (manual)");
    { let state = state.clone(); full_sync.connect_clicked(move |_| { state.borrow_mut().request_timeout("sync.start", json!({}), Pending::SyncStart, Duration::from_secs(180)); state.borrow().set_status("เริ่ม Full Sync…"); }); }
    let safe_mode = gtk::Button::with_label("Safe Mode — รีสตาร์ท engine แบบปลอดภัย");
    { let state = state.clone(); let window = window.clone(); safe_mode.connect_clicked(move |_| { match state.borrow_mut().restart_engine() { Ok(()) => { state.borrow().set_status("รีสตาร์ท engine แล้ว"); window.close(); }, Err(e) => state.borrow().set_status(&e) } }); }
    let logout = gtk::Button::with_label("ออกจากระบบ LINE"); logout.add_css_class("danger");
    { let state = state.clone(); let window = window.clone(); logout.connect_clicked(move |_| { state.borrow_mut().request("auth.logout", json!({}), Pending::Logout); window.close(); }); }
    buttons.append(&clear_history); buttons.append(&clear_stickers); buttons.append(&full_sync); buttons.append(&safe_mode); buttons.append(&logout); root.append(&buttons);
    let scroll = gtk::ScrolledWindow::builder().child(&root).vexpand(true).build(); window.set_child(Some(&scroll)); window.present();
}

pub(crate) fn show_qr(state: &Rc<RefCell<State>>, url: &str) {
    let mut app = state.borrow_mut();
    if let Some(old) = app.qr_backdrop.take() { app.overlay.remove_overlay(&old); }
    let backdrop = gtk::Box::builder().orientation(gtk::Orientation::Vertical).halign(gtk::Align::Fill).valign(gtk::Align::Fill).css_classes(["modal-backdrop"]).build();
    let card = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(12).halign(gtk::Align::Center).valign(gtk::Align::Center).css_classes(["qr-card"]).build();
    card.append(&gtk::Label::builder().label("Scan QR code").xalign(0.0).css_classes(["login-heading"]).build());
    card.append(&gtk::Label::builder().label("เปิด LINE บนโทรศัพท์แล้วสแกนโค้ดนี้").xalign(0.0).css_classes(["login-help"]).build());
    let code = QrCode::new(url.as_bytes()).ok();
    let pixels = code.as_ref().map(|code| { let width = code.width(); (width, code.to_colors().into_iter().map(|color| matches!(color, qrcode::Color::Dark)).collect::<Vec<_>>()) });
    let canvas = gtk::DrawingArea::builder().width_request(236).height_request(236).build();
    canvas.set_draw_func(move |_, context, width, height| {
        context.set_source_rgb(1.0, 1.0, 1.0); let _ = context.paint();
        if let Some((side, values)) = &pixels {
            let quiet = 4.0; let cell = (width.min(height) as f64 / (*side as f64 + quiet * 2.0)).floor(); let offset = quiet * cell;
            context.set_source_rgb(0.0, 0.0, 0.0);
            for y in 0..*side { for x in 0..*side { if values[y * side + x] { context.rectangle(offset + x as f64 * cell, offset + y as f64 * cell, cell, cell); } } }
            let _ = context.fill();
        }
    });
    let frame = gtk::Box::builder().halign(gtk::Align::Center).valign(gtk::Align::Center).css_classes(["qr-frame"]).build(); frame.append(&canvas); card.append(&frame);
    card.append(&gtk::Label::builder().label("รอการสแกนและยืนยันบนมือถือ").halign(gtk::Align::Center).css_classes(["qr-status"]).build());
    let refresh = gtk::Button::builder().label("สร้าง QR ใหม่").css_classes(["secondary"]).build();
    { let weak = Rc::downgrade(state); refresh.connect_clicked(move |_| { if let Some(state) = weak.upgrade() { state.borrow_mut().request_timeout("auth.qr.start", json!({}), Pending::Login, Duration::from_secs(180)); } }); }
    card.append(&refresh);
    let close = gtk::Button::builder().label("ยกเลิก").css_classes(["secondary"]).build();
    { let weak = Rc::downgrade(state); let backdrop2 = backdrop.clone(); close.connect_clicked(move |_| { if let Some(state) = weak.upgrade() { let mut app = state.borrow_mut(); app.overlay.remove_overlay(&backdrop2); app.qr_backdrop = None; } }); }
    card.append(&close); backdrop.append(&card); app.overlay.add_overlay(&backdrop); app.qr_backdrop = Some(backdrop);
}

pub(crate) fn notify(app: &State, chat_id: &str, title: &str, body: &str, id: &str) {
    let notification = gtk::gio::Notification::new(title);
    notification.set_body(Some(body));
    notification.set_icon(&gtk::gio::ThemedIcon::new("liney"));
    let target = format!("{chat_id}\n{id}").to_variant();
    notification.set_default_action_and_target_value("app.open-chat", Some(&target));
    app.app.send_notification(Some(&format!("message-{id}")), &notification);
    if app.settings.notification_sound { if let Some(display) = gtk::gdk::Display::default() { display.beep(); } }
}




pub(crate) fn confirm_action<F>(state: &Rc<RefCell<State>>, title: &str, detail: &str, action: F)
where
    F: Fn(&Rc<RefCell<State>>) + 'static,
{
    let dialog = gtk::MessageDialog::builder()
        .transient_for(&state.borrow().window)
        .modal(true)
        .message_type(gtk::MessageType::Question)
        .buttons(gtk::ButtonsType::OkCancel)
        .text(title)
        .secondary_text(detail)
        .build();
    let state = state.clone();
    dialog.connect_response(move |dialog, response| {
        if response == gtk::ResponseType::Ok { action(&state); }
        dialog.close();
    });
    dialog.present();
}

