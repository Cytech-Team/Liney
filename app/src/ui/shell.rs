use crate::engine::EngineBridge;
use crate::models::{Chat, Message};
use crate::settings;
use crate::state::{Capabilities, ListFilter, Pending, Section, State, TrayCommand};
use crate::theme;
use crate::ui::chat_list::{chat_row, open_chat, render_sidebar};
use crate::ui::helpers::{icon_button, logo_widget};
use crate::ui::message_list::{message_row, render_messages, scroll_messages_to_bottom};
use crate::{
    handle_engine_message, handle_request_timeout, paste_clipboard_image, pick_media_file,
    render_calls_landing, send_text_message, set_composer_enabled, set_tray_enabled, show_account,
    show_settings, show_sticker_picker, start_call, update_reply_bar,
};
use gtk4 as gtk;
use gtk::gio;
use gtk::prelude::*;
use serde_json::{json, Value};
use std::{cell::RefCell, collections::HashMap, env, path::{Path, PathBuf}, rc::Rc, sync::mpsc, time::{Duration, Instant}};

pub(crate) fn build_ui(app: &gtk::Application) {
    let app_settings = settings::load();
    let provider = gtk::CssProvider::new();
    theme::load_css(&provider, &app_settings);
    if let Some(display) = gtk::gdk::Display::default() {
        gtk::style_context_add_provider_for_display(&display, &provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    let window = gtk::ApplicationWindow::builder()
        .application(app)
        .title("Liney")
        .default_width(1280)
        .default_height(820)
        .width_request(960)
        .height_request(640)
        .build();

    let stack = gtk::Stack::builder().hexpand(true).vexpand(true).build();
    let overlay = gtk::Overlay::new();
    overlay.set_child(Some(&stack));
    let sync_gate = build_sync_gate();
    overlay.add_overlay(&sync_gate.root);
    window.set_child(Some(&overlay));

    let status = gtk::Label::builder().xalign(0.0).css_classes(["status"]).build();
    let login_status = gtk::Label::builder().xalign(0.0).wrap(true).css_classes(["login-status"]).build();
    let (login, qr_button, email, password, password_button) = build_login(&login_status);
    let main = build_main(&status);
    stack.add_named(&login, Some("login"));
    stack.add_named(&main.root, Some("main"));
    stack.set_visible_child_name("login");

    let engine = match EngineBridge::spawn() {
        Ok(engine) => engine,
        Err(error) => {
            login_status.set_text(&error);
            window.present();
            return;
        }
    };

    let (tray_sender, tray_receiver) = mpsc::channel();
    let state = Rc::new(RefCell::new(State {
        app: app.clone(), window: window.clone(), engine, pending: HashMap::new(), capabilities: Capabilities::default(),
        profile: None, settings: app_settings.clone(), css_provider: provider, section: Section::Messages, list_filter: ListFilter::All, query: String::new(),
        chats: Vec::new(), friends: Vec::new(), open_chats: Vec::new(), sidebar_ids: Vec::new(), active_chat_id: String::new(),
        messages: HashMap::new(), reply_target: None, asset_cache: HashMap::new(), notification_dedup: HashMap::new(), pending_jump: None, stack, overlay, qr_backdrop: None,
        status, login_status, sync_label: main.sync_label, sync_bar: main.sync_bar,
        sync_gate: sync_gate.root, sync_gate_title: sync_gate.title, sync_gate_detail: sync_gate.detail, sync_gate_bar: sync_gate.bar, sync_gate_percent: sync_gate.percent,
        section_title: main.section_title,
        offline_banner: main.offline_banner.clone(), offline_label: main.offline_label.clone(), chat_empty: main.chat_empty.clone(), message_empty: main.message_empty.clone(),
        chat_list: main.chat_list.clone(), chat_store: main.chat_store.clone(), chat_selection: main.chat_selection.clone(), message_list: main.message_list.clone(), message_store: main.message_store.clone(), message_selection: main.message_selection.clone(), messages_scroll: main.messages_scroll.clone(), scroll_bottom_button: main.scroll_bottom_button.clone(), follow_bottom: true, scroll_programmatic: false,
        header_avatar: main.header_avatar.clone(), chat_title: main.chat_title, chat_subtitle: main.chat_subtitle, composer: main.composer.clone(), reply_bar: main.reply_bar,
        reply_label: main.reply_label, attach_button: main.attach_button.clone(), paste_button: main.paste_button.clone(), sticker_button: main.sticker_button.clone(),
        call_button: main.call_button.clone(), send_button: main.send_button.clone(), nav_buttons: main.nav_buttons,
        call_window: None, incoming_call_window: None, call_status_label: None, call_mute_button: None, call_muted: false, call_devices: Vec::new(), call_output_box: None,
        tray_sender: tray_sender.clone(), tray_handle: None,
    }));

    let _ = settings::apply_autostart(app_settings.startup);
    theme::apply_window_density(&state.borrow().window, &app_settings);
    set_tray_enabled(&state, app_settings.tray);
    if let Some(button) = state.borrow().nav_buttons.get(&Section::OpenChat) { button.set_visible(app_settings.openchat); }
    if let Some(gtk_settings) = gtk::Settings::default() {
        let weak = Rc::downgrade(&state);
        gtk_settings.connect_gtk_application_prefer_dark_theme_notify(move |_| {
            if let Some(state) = weak.upgrade() {
                let app = state.borrow();
                if app.settings.theme == "system" { theme::load_css(&app.css_provider, &app.settings); }
            }
        });
    }

    {
        let qr_state = state.clone();
        let password = password.clone();
        qr_button.connect_clicked(move |_| {
            let mut app = qr_state.borrow_mut();
            app.set_status("กำลังสร้าง QR Code…");
            app.request_timeout("auth.qr.start", json!({}), Pending::Login, Duration::from_secs(180));
        });
        let state2 = state.clone();
        password_button.connect_clicked(move |_| {
            let email_value = email.text().trim().to_owned();
            let password_value = password.text().to_string();
            if email_value.is_empty() || password_value.is_empty() {
                state2.borrow().set_status("กรุณากรอก Email และ Password ให้ครบ");
                return;
            }
            password.set_text("");
            let mut app = state2.borrow_mut();
            app.set_status("กำลังเข้าสู่ระบบ…");
            app.request_timeout("auth.password.start", json!({ "email": email_value, "password": password_value }), Pending::Login, Duration::from_secs(180));
        });
    }

    {
        let state_clone = state.clone();
        let chat_list = state.borrow().chat_list.clone();
        let chat_selection = state.borrow().chat_selection.clone();
        // Setup chat ListView factory (virtualized)
        let chat_factory = gtk::SignalListItemFactory::new();
        chat_factory.connect_setup(|_, item| {
            let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
            item.downcast_ref::<gtk::ListItem>().unwrap().set_child(Some(&container));
        });
        {
            let state = state_clone.clone();
            chat_factory.connect_bind(move |_, item| {
                let list_item = item.downcast_ref::<gtk::ListItem>().unwrap();
                if let Some(obj) = list_item.item().and_downcast::<gtk::StringObject>() {
                    if let Ok(chat) = serde_json::from_str::<Chat>(&obj.string()) {
                        let row_widget = chat_row(&state, &chat);
                        list_item.set_child(Some(&row_widget));
                    }
                }
            });
        }
        chat_list.set_factory(Some(&chat_factory));
        chat_list.connect_activate(move |_, position| {
            if let Some(obj) = chat_selection.item(position).and_downcast::<gtk::StringObject>() {
                if let Ok(chat) = serde_json::from_str::<Chat>(&obj.string()) {
                    open_chat(&state_clone, &chat.id);
                }
            }
        });
    }

    {
        let state_clone = state.clone();
        let message_list = state.borrow().message_list.clone();
        let message_factory = gtk::SignalListItemFactory::new();
        message_factory.connect_setup(|_, item| {
            let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
            item.downcast_ref::<gtk::ListItem>().unwrap().set_child(Some(&container));
        });
        {
            let state = state_clone.clone();
            message_factory.connect_bind(move |_, item| {
                let list_item = item.downcast_ref::<gtk::ListItem>().unwrap();
                if let Some(obj) = list_item.item().and_downcast::<gtk::StringObject>() {
                    if let Ok(message) = serde_json::from_str::<Message>(&obj.string()) {
                        let chat = {
                            let app = state.borrow();
                            app.chat_by_id(&message.chat_id).unwrap_or(Chat { id: message.chat_id.clone(), kind: "group".into(), ..Default::default() })
                        };
                        let row_widget = message_row(&state, &chat, &message);
                        list_item.set_child(Some(&row_widget));
                        // Viewport-driven media: request preview only when row becomes visible
                        if message.content_type == 1 && message.image_data_url.is_empty() {
                            let needs = {
                                let app = state.borrow();
                                app.settings.auto_media || chat.kind != "openchat"
                            };
                            if needs {
                                let chat_id = message.chat_id.clone();
                                let message_id = message.id.clone();
                                let kind = chat.engine_kind().to_owned();
                                let state2 = state.clone();
                                gtk::glib::idle_add_local_once(move || {
                                    let mut app = state2.borrow_mut();
                                    let pending = app.pending.values().any(|req| matches!(&req.action, Pending::MediaPreview { chat_id: cid, message_id: mid, .. } if cid == &chat_id && mid == &message_id));
                                    if !pending {
                                        app.request_timeout("media.preview", json!({ "messageId": message_id, "chatId": chat_id, "kind": kind }), Pending::MediaPreview { chat_id: chat_id.clone(), message_id: message_id.clone(), attempt: 0 }, Duration::from_secs(60));
                                    }
                                });
                            }
                        }
                    }
                }
            });
        }
        message_list.set_factory(Some(&message_factory));
    }

    {
        let state = state.clone();
        main.messages_scroll.vadjustment().connect_value_changed(move |adjustment| {
            let mut app = state.borrow_mut();
            if app.scroll_programmatic { return; }
            let distance = adjustment.upper() - adjustment.page_size() - adjustment.value();
            app.follow_bottom = distance < 72.0;
            app.scroll_bottom_button.set_visible(!app.follow_bottom && distance > 140.0);
        });
    }
    {
        let state = state.clone();
        main.scroll_bottom_button.connect_clicked(move |_| { scroll_messages_to_bottom(&state); });
    }

    {
        let state = state.clone();
        main.search.connect_search_changed(move |entry| {
            state.borrow_mut().query = entry.text().to_string();
            render_sidebar(&state);
        });
    }
    {
        let state = state.clone();
        main.filter.connect_selected_notify(move |drop| {
            state.borrow_mut().list_filter = match drop.selected() { 1 => ListFilter::Unread, 2 => ListFilter::Pinned, 3 => ListFilter::Favorites, _ => ListFilter::All };
            render_sidebar(&state);
        });
    }

    let filter_control = main.filter.clone();
    for (section, button) in state.borrow().nav_buttons.clone() {
        let state = state.clone();
        let filter_control = filter_control.clone();
        button.connect_clicked(move |_| {
            filter_control.set_selected(0);
            {
                let mut app = state.borrow_mut();
                app.list_filter = ListFilter::All;
                app.section = section;
                app.section_title.set_text(section.title());
                for (item, nav) in &app.nav_buttons {
                    if *item == section { nav.add_css_class("active"); } else { nav.remove_css_class("active"); }
                }
            }
            render_sidebar(&state);
            if section == Section::Calls { render_calls_landing(&state); }
        });
    }

    {
        let state = state.clone();
        main.settings_button.connect_clicked(move |_| show_settings(&state));
    }
    {
        let state = state.clone();
        main.brand_button.connect_clicked(move |_| show_account(&state));
    }
    {
        let state = state.clone();
        main.refresh_button.connect_clicked(move |_| {
            let mut app = state.borrow_mut();
            app.set_status("กำลังรีเฟรชข้อมูล…");
            app.request_timeout("sync.start", json!({}), Pending::SyncStart, Duration::from_secs(180));
            app.load_account_lists();
        });
    }
    {
        let send_state = state.clone();
        main.send_button.connect_clicked(move |_| send_text_message(&send_state));
    }
    {
        let state = state.clone();
        let keys = gtk::EventControllerKey::new();
        keys.connect_key_pressed(move |_, key, _, modifiers| {
            if (key == gtk::gdk::Key::Return || key == gtk::gdk::Key::KP_Enter) && !modifiers.contains(gtk::gdk::ModifierType::SHIFT_MASK) {
                send_text_message(&state); return gtk::glib::Propagation::Stop;
            }
            if modifiers.contains(gtk::gdk::ModifierType::CONTROL_MASK) && (key == gtk::gdk::Key::v || key == gtk::gdk::Key::V) {
                if let Some(display) = gtk::gdk::Display::default() {
                    let formats = display.clipboard().formats();
                    if formats.mime_types().iter().any(|mime| mime.starts_with("image/")) { paste_clipboard_image(&state); return gtk::glib::Propagation::Stop; }
                }
            }
            gtk::glib::Propagation::Proceed
        });
        main.composer.add_controller(keys);
    }
    {
        let state = state.clone();
        main.composer.buffer().connect_changed(move |buffer| {
            let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false);
            let app = state.borrow();
            app.send_button.set_sensitive(app.composer.is_sensitive() && !text.trim().is_empty());
        });
    }
    {
        let state = state.clone();
        main.attach_button.connect_clicked(move |_| pick_media_file(&state));
    }
    {
        let state = state.clone();
        main.paste_button.connect_clicked(move |_| paste_clipboard_image(&state));
    }
    {
        let state = state.clone();
        main.sticker_button.connect_clicked(move |_| show_sticker_picker(&state));
    }
    {
        let state = state.clone();
        main.call_button.connect_clicked(move |_| start_call(&state));
    }
    {
        let state = state.clone();
        main.reply_cancel.connect_clicked(move |_| {
            state.borrow_mut().reply_target = None;
            update_reply_bar(&state);
        });
    }

    {
        let search = main.search.clone();
        let keys = gtk::EventControllerKey::new();
        keys.connect_key_pressed(move |_, key, _, modifiers| {
            if modifiers.contains(gtk::gdk::ModifierType::CONTROL_MASK) && (key == gtk::gdk::Key::k || key == gtk::gdk::Key::K) { search.grab_focus(); return gtk::glib::Propagation::Stop; }
            gtk::glib::Propagation::Proceed
        });
        window.add_controller(keys);
    }

    {
        let state = state.clone();
        window.connect_is_active_notify(move |window| {
            if !window.is_active() { return; }
            let chat = state.borrow().active_chat();
            if let Some(chat) = chat.filter(|chat| chat.unread > 0) { state.borrow_mut().mark_read(&chat); render_sidebar(&state); }
        });
    }

    {
        let state = state.clone();
        window.connect_close_request(move |window| {
            if state.borrow().settings.tray {
                window.hide();
                gtk::glib::Propagation::Stop
            } else {
                gtk::glib::Propagation::Proceed
            }
        });
    }


    {
        let weak = Rc::downgrade(&state);
        gtk::glib::timeout_add_local(Duration::from_millis(120), move || {
            let Some(state) = weak.upgrade() else { return gtk::glib::ControlFlow::Break };
            let events = { state.borrow().engine.drain(64) };
            for event in events { handle_engine_message(&state, event); }
            let timed_out: Vec<u64> = {
                let app = state.borrow();
                let now = Instant::now();
                app.pending.iter().filter_map(|(id, request)| (request.deadline <= now).then_some(*id)).collect()
            };
            if !timed_out.is_empty() {
                let actions: Vec<Pending> = {
                    let mut app = state.borrow_mut();
                    timed_out.into_iter().filter_map(|id| app.pending.remove(&id).map(|request| request.action)).collect()
                };
                for action in actions { handle_request_timeout(&state, action); }
                state.borrow().set_status("LINE ตอบกลับช้าเกินกำหนด กรุณาตรวจสอบสถานะก่อนลองใหม่");
            }
            while let Ok(command) = tray_receiver.try_recv() {
                match command {
                    TrayCommand::Show => state.borrow().window.present(),
                    TrayCommand::Quit => state.borrow().app.quit(),
                }
            }
            gtk::glib::ControlFlow::Continue
        });
    }

    let open_chat_action = gtk::gio::SimpleAction::new("open-chat", Some(gtk::glib::VariantTy::STRING));
    {
        let state = state.clone();
        open_chat_action.connect_activate(move |_, parameter| {
            if let Some(target) = parameter.and_then(|value| value.str()) {
                let mut parts = target.splitn(2, '\n');
                let chat_id = parts.next().unwrap_or(""); let message_id = parts.next().unwrap_or("");
                if chat_id.is_empty() { return; }
                state.borrow().window.present();
                if !message_id.is_empty() { state.borrow_mut().pending_jump = Some((chat_id.to_owned(), message_id.to_owned())); }
                open_chat(&state, chat_id);
            }
        });
    }
    app.add_action(&open_chat_action);

    window.present();
}

pub(crate) struct SyncGateWidgets {
    pub(crate) root: gtk::Box,
    pub(crate) title: gtk::Label,
    pub(crate) detail: gtk::Label,
    pub(crate) bar: gtk::ProgressBar,
    pub(crate) percent: gtk::Label,
}

pub(crate) fn build_sync_gate() -> SyncGateWidgets {
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).halign(gtk::Align::Fill).valign(gtk::Align::Fill).css_classes(["sync-gate"]).build();
    root.set_visible(false);
    let card = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(12).halign(gtk::Align::Center).valign(gtk::Align::Center).css_classes(["sync-gate-card"]).build();
    card.append(&logo_widget(68));
    card.append(&gtk::Label::builder().label("LINEY · FULL SYNC").css_classes(["eyebrow"]).build());
    let title = gtk::Label::builder().label("กำลังเตรียม Full Sync").css_classes(["sync-gate-title"]).build();
    let detail = gtk::Label::builder().label("กำลังเชื่อมข้อมูลบัญชี LINE").wrap(true).justify(gtk::Justification::Center).css_classes(["sync-gate-detail"]).build();
    let bar = gtk::ProgressBar::new(); bar.set_size_request(420, 10);
    let percent = gtk::Label::builder().label("0%").css_classes(["sync-gate-percent"]).build();
    card.append(&title); card.append(&detail); card.append(&bar); card.append(&percent);
    card.append(&gtk::Label::builder().label("กำลังเตรียม friends, Talk, OpenChat และประวัติล่าสุดก่อนเปิดใช้งานเต็มรูปแบบ").wrap(true).justify(gtk::Justification::Center).max_width_chars(64).css_classes(["sync-gate-footnote"]).build());
    // Equal expanding space above and below keeps this blocking gate centered
    // even as the parent window is resized.
    root.append(&gtk::Box::builder().vexpand(true).build());
    root.append(&card);
    root.append(&gtk::Box::builder().vexpand(true).build());
    SyncGateWidgets { root, title, detail, bar, percent }
}

pub(crate) struct MainWidgets {
    pub(crate) root: gtk::Box,
    pub(crate) nav_buttons: HashMap<Section, gtk::Button>,
    pub(crate) brand_button: gtk::Button,
    pub(crate) settings_button: gtk::Button,
    pub(crate) section_title: gtk::Label,
    pub(crate) search: gtk::SearchEntry,
    pub(crate) filter: gtk::DropDown,
    pub(crate) offline_banner: gtk::Box,
    pub(crate) offline_label: gtk::Label,
    pub(crate) chat_empty: gtk::Label,
    pub(crate) chat_list: gtk::ListView,
    pub(crate) chat_store: gio::ListStore,
    pub(crate) chat_selection: gtk::SingleSelection,
    pub(crate) message_empty: gtk::Label,
    pub(crate) message_list: gtk::ListView,
    pub(crate) message_store: gio::ListStore,
    pub(crate) message_selection: gtk::NoSelection,
    pub(crate) messages_scroll: gtk::ScrolledWindow,
    pub(crate) scroll_bottom_button: gtk::Button,
    pub(crate) header_avatar: gtk::Image,
    pub(crate) chat_title: gtk::Label,
    pub(crate) chat_subtitle: gtk::Label,
    pub(crate) refresh_button: gtk::Button,
    pub(crate) call_button: gtk::Button,
    pub(crate) composer: gtk::TextView,
    pub(crate) attach_button: gtk::Button,
    pub(crate) paste_button: gtk::Button,
    pub(crate) sticker_button: gtk::Button,
    pub(crate) send_button: gtk::Button,
    pub(crate) reply_bar: gtk::Box,
    pub(crate) reply_label: gtk::Label,
    pub(crate) reply_cancel: gtk::Button,
    pub(crate) sync_label: gtk::Label,
    pub(crate) sync_bar: gtk::ProgressBar,
}

pub(crate) fn build_main(status: &gtk::Label) -> MainWidgets {
    let root = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    let rail = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(8).css_classes(["nav-rail"]).build();
    let brand_button = gtk::Button::builder().child(&logo_widget(34)).css_classes(["brand-button"]).build();
    brand_button.set_tooltip_text(Some("บัญชี LINE"));
    rail.append(&brand_button);
    let mut nav_buttons = HashMap::new();
    for (section, icon, tip) in [
        (Section::Messages, "mail-unread-symbolic", "แชต"),
        (Section::Friends, "system-users-symbolic", "เพื่อน"),
        (Section::OpenChat, "emblem-favorite-symbolic", "OpenChat"),
        (Section::Calls, "call-start-symbolic", "โทร"),
    ] {
        let button = icon_button(icon, tip);
        button.add_css_class("rail-button");
        if section == Section::Messages { button.add_css_class("active"); }
        rail.append(&button);
        nav_buttons.insert(section, button);
    }
    rail.append(&gtk::Box::builder().vexpand(true).build());
    let settings_button = icon_button("emblem-system-symbolic", "ตั้งค่า");
    settings_button.add_css_class("rail-button");
    rail.append(&settings_button);
    root.append(&rail);

    let sidebar = gtk::Box::builder().orientation(gtk::Orientation::Vertical).width_request(306).css_classes(["sidebar"]).build();
    let sidebar_top = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).margin_top(12).margin_start(14).margin_end(8).margin_bottom(7).build();
    let heading_box = gtk::Box::builder().orientation(gtk::Orientation::Vertical).hexpand(true).build();
    let section_title = gtk::Label::builder().label("แชต").xalign(0.0).css_classes(["sidebar-heading"]).build();
    heading_box.append(&section_title);
    sidebar_top.append(&heading_box);
    let refresh_button = icon_button("view-refresh-symbolic", "รีเฟรช / ซิงก์");
    sidebar_top.append(&refresh_button);
    sidebar.append(&sidebar_top);
    let search = gtk::SearchEntry::builder().placeholder_text("ค้นหาแชตหรือเพื่อน").css_classes(["search"]).build();
    sidebar.append(&search);
    let filter = gtk::DropDown::from_strings(&["ทั้งหมด", "ยังไม่ได้อ่าน", "ปักหมุด", "รายการโปรด"]);
    filter.add_css_class("filter"); filter.set_selected(0); sidebar.append(&filter);
    let chat_store = gio::ListStore::new::<gtk::StringObject>();
    let chat_selection = gtk::SingleSelection::new(Some(chat_store.clone()));
    chat_selection.set_autoselect(false);
    chat_selection.set_can_unselect(true);
    let chat_list = gtk::ListView::builder().model(&chat_selection).css_classes(["chat-list"]).build();
    let chats_scroll = gtk::ScrolledWindow::builder().child(&chat_list).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).build();
    sidebar.append(&chats_scroll);
    let chat_empty = gtk::Label::builder().label("ยังไม่มีรายการ").css_classes(["empty-note"]).margin_top(18).halign(gtk::Align::Center).build();
    chat_empty.set_visible(false);
    sidebar.append(&chat_empty);
    root.append(&sidebar);

    let content = gtk::Box::builder().orientation(gtk::Orientation::Vertical).hexpand(true).css_classes(["conversation"]).build();
    let conversation_header = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).css_classes(["conversation-header"]).build();
    let header_avatar = gtk::Image::from_icon_name("avatar-default-symbolic"); header_avatar.set_pixel_size(38); header_avatar.add_css_class("header-avatar");
    conversation_header.append(&header_avatar);
    let person = gtk::Box::builder().orientation(gtk::Orientation::Vertical).valign(gtk::Align::Center).hexpand(true).margin_start(10).build();
    let chat_title = gtk::Label::builder().label("เลือกแชต").xalign(0.0).ellipsize(gtk::pango::EllipsizeMode::End).css_classes(["chat-title"]).build();
    let chat_subtitle = gtk::Label::builder().label("LINE for Linux").xalign(0.0).ellipsize(gtk::pango::EllipsizeMode::End).css_classes(["chat-subtitle"]).build();
    person.append(&chat_title); person.append(&chat_subtitle); conversation_header.append(&person);
    let call_button = icon_button("call-start-symbolic", "โทรเสียง 1:1");
    conversation_header.append(&call_button);
    content.append(&conversation_header);

    let offline_banner = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(8).css_classes(["offline-banner"]).margin_start(12).margin_end(12).margin_top(6).margin_bottom(6).build();
    let offline_icon = gtk::Image::from_icon_name("network-offline-symbolic"); offline_icon.set_pixel_size(14);
    let offline_label = gtk::Label::builder().label("ออฟไลน์ — กำลังใช้ข้อมูลแคช").xalign(0.0).css_classes(["offline-label"]).hexpand(true).build();
    offline_banner.append(&offline_icon); offline_banner.append(&offline_label);
    offline_banner.set_visible(false);
    content.append(&offline_banner);
    let sync_box = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).margin_start(24).margin_end(24).margin_top(8).build();
    let sync_label = gtk::Label::builder().xalign(0.0).css_classes(["sync-label"]).build();
    let sync_bar = gtk::ProgressBar::new();
    sync_bar.set_visible(false); sync_label.set_visible(false);
    sync_box.append(&sync_label); sync_box.append(&sync_bar); content.append(&sync_box);

    let message_store = gio::ListStore::new::<gtk::StringObject>();
    let message_selection = gtk::NoSelection::new(Some(message_store.clone()));
    let message_list = gtk::ListView::builder().model(&message_selection).css_classes(["message-list"]).build();
    let messages_scroll = gtk::ScrolledWindow::builder().child(&message_list).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).css_classes(["message-stage"]).build();
    let message_empty = gtk::Label::builder().label("เลือกแชตทางซ้ายเพื่อเริ่มใช้งาน").css_classes(["conversation-empty"]).margin_top(36).halign(gtk::Align::Center).build();
    message_empty.set_visible(true);
    let message_stage_overlay = gtk::Overlay::new(); message_stage_overlay.set_vexpand(true); message_stage_overlay.set_child(Some(&messages_scroll));
    message_stage_overlay.add_overlay(&message_empty);
    let scroll_bottom_button = gtk::Button::builder().icon_name("go-bottom-symbolic").tooltip_text("ไปข้อความล่าสุด").halign(gtk::Align::End).valign(gtk::Align::End).margin_end(22).margin_bottom(16).css_classes(["scroll-bottom"]).build();
    scroll_bottom_button.set_visible(false); message_stage_overlay.add_overlay(&scroll_bottom_button); content.append(&message_stage_overlay);

    let reply_bar = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(8).margin_start(24).margin_end(24).margin_top(6).css_classes(["reply-bar"]).build();
    let reply_label = gtk::Label::builder().xalign(0.0).hexpand(true).ellipsize(gtk::pango::EllipsizeMode::End).build();
    let reply_cancel = icon_button("window-close-symbolic", "ยกเลิกตอบกลับ");
    reply_bar.append(&reply_label); reply_bar.append(&reply_cancel); reply_bar.set_visible(false); content.append(&reply_bar);

    let compose_outer = gtk::Box::builder().orientation(gtk::Orientation::Vertical).css_classes(["composer-wrap"]).build();
    let compose = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(7).css_classes(["composer"]).build();
    let attach_button = icon_button("mail-attachment-symbolic", "แนบรูป / วิดีโอ / เสียง / ไฟล์");
    let paste_button = icon_button("edit-paste-symbolic", "ส่งรูปจาก Clipboard");
    let sticker_button = icon_button("face-smile-symbolic", "สติกเกอร์ / LINE Emoji");
    let composer = gtk::TextView::builder().hexpand(true).wrap_mode(gtk::WrapMode::WordChar).top_margin(7).bottom_margin(7).left_margin(4).right_margin(4).build();
    composer.set_accepts_tab(false); composer.set_height_request(38);
    let composer_overlay = gtk::Overlay::new(); composer_overlay.set_hexpand(true);
    let composer_scroll = gtk::ScrolledWindow::builder().child(&composer).hexpand(true).hscrollbar_policy(gtk::PolicyType::Never).vscrollbar_policy(gtk::PolicyType::Automatic).max_content_height(104).propagate_natural_height(true).build();
    composer_overlay.set_child(Some(&composer_scroll));
    let composer_placeholder = gtk::Label::builder().label("พิมพ์ข้อความ").halign(gtk::Align::Start).valign(gtk::Align::Start).margin_top(9).margin_start(10).css_classes(["composer-placeholder"]).can_target(false).build();
    composer_overlay.add_overlay(&composer_placeholder);
    let send_button = icon_button("mail-send-symbolic", "ส่งข้อความ");
    send_button.add_css_class("send");
    attach_button.set_sensitive(false); paste_button.set_sensitive(false); sticker_button.set_sensitive(false); call_button.set_sensitive(false); send_button.set_sensitive(false); composer.set_sensitive(false);
    { let placeholder = composer_placeholder.clone(); composer.buffer().connect_changed(move |buffer| { let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false); placeholder.set_visible(text.is_empty()); }); }
    compose.append(&attach_button); compose.append(&paste_button); compose.append(&sticker_button); compose.append(&composer_overlay); compose.append(&send_button);
    compose_outer.append(&compose); content.append(&compose_outer); content.append(status);
    root.append(&content);

    MainWidgets { root, nav_buttons, brand_button, settings_button, section_title, search, filter, offline_banner, offline_label, chat_empty, chat_list, chat_store, chat_selection, message_empty, message_list, message_store, message_selection, messages_scroll, scroll_bottom_button, header_avatar, chat_title, chat_subtitle,
        refresh_button, call_button, composer, attach_button, paste_button, sticker_button, send_button, reply_bar, reply_label, reply_cancel, sync_label, sync_bar }
}

pub(crate) fn build_login(status: &gtk::Label) -> (gtk::Box, gtk::Button, gtk::Entry, gtk::PasswordEntry, gtk::Button) {
    let page = gtk::Box::builder().orientation(gtk::Orientation::Vertical).halign(gtk::Align::Center).valign(gtk::Align::Center).css_classes(["login-page"]).build();
    let content = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(26).css_classes(["login-content"]).build();
    let brand = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(12).build();
    brand.append(&logo_widget(44));
    let brand_text = gtk::Box::builder().orientation(gtk::Orientation::Vertical).valign(gtk::Align::Center).build();
    brand_text.append(&gtk::Label::builder().label("Liney").xalign(0.0).css_classes(["login-brand"]).build());
    brand_text.append(&gtk::Label::builder().label("Native LINE desktop client for Linux").xalign(0.0).css_classes(["login-help"]).build());
    brand.append(&brand_text); content.append(&brand);
    let columns = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(28).build();
    let qr_card = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).hexpand(true).css_classes(["login-card"]).build();
    qr_card.append(&gtk::Label::builder().label("Log in with QR code").xalign(0.0).css_classes(["login-heading"]).build());
    qr_card.append(&gtk::Label::builder().label("เปิด LINE บนมือถือแล้วสแกน QR Code").xalign(0.0).css_classes(["login-help"]).build());
    let qr_preview = gtk::Box::builder().halign(gtk::Align::Center).valign(gtk::Align::Center).margin_top(14).margin_bottom(14).css_classes(["qr-preview"]).build();
    let qr_idle = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(10).halign(gtk::Align::Center).valign(gtk::Align::Center).build();
    let qr_idle_icon = gtk::Image::from_icon_name("camera-web-symbolic"); qr_idle_icon.set_pixel_size(28);
    qr_idle.append(&qr_idle_icon); qr_idle.append(&gtk::Label::builder().label("QR Code\nพร้อมสร้างเพื่อเข้าสู่ระบบ").justify(gtk::Justification::Center).css_classes(["login-help"]).build());
    qr_preview.append(&qr_idle); qr_card.append(&qr_preview);
    let qr = gtk::Button::builder().label("สร้าง QR Code").css_classes(["primary"]).sensitive(false).build(); qr_card.append(&qr); columns.append(&qr_card);
    let email_card = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(12).css_classes(["login-card", "secondary-card"]).build();
    email_card.append(&gtk::Label::builder().label("Log in with email").xalign(0.0).css_classes(["login-secondary-title"]).build());
    email_card.append(&gtk::Label::builder().label("ใช้ Email / Password ของบัญชี LINE").xalign(0.0).margin_bottom(10).css_classes(["login-help"]).build());
    let email = gtk::Entry::builder().placeholder_text("อีเมล LINE").build();
    let password = gtk::PasswordEntry::builder().placeholder_text("รหัสผ่าน").build();
    let password_button = gtk::Button::builder().label("เข้าสู่ระบบ").css_classes(["primary"]).margin_top(6).sensitive(false).build();
    email_card.append(&email); email_card.append(&password); email_card.append(&password_button);
    email_card.append(&gtk::Label::builder().label("รหัสผ่านส่งผ่าน pipe ในเครื่องและไม่ถูกบันทึก").xalign(0.0).margin_top(4).css_classes(["login-help"]).build());
    columns.append(&email_card); content.append(&columns);
    let warning = gtk::Label::builder()
        .label("Liney เป็นไคลเอนต์ LINE ที่ไม่เป็นทางการ ไม่ได้เกี่ยวข้องหรือได้รับการรับรองจาก LY Corporation และการใช้งานอาจไม่เป็นไปตามข้อกำหนดการให้บริการของ LINE")
        .xalign(0.0).wrap(true).max_width_chars(100).css_classes(["login-warning"]).build();
    content.append(&warning);
    let consent = gtk::CheckButton::with_label("ฉันอ่านคำเตือนแล้วและยอมรับความเสี่ยงในการใช้งานไคลเอนต์ที่ไม่เป็นทางการ");
    consent.add_css_class("login-consent");
    {
        let qr = qr.clone(); let password_button = password_button.clone();
        consent.connect_toggled(move |check| { let enabled = check.is_active(); qr.set_sensitive(enabled); password_button.set_sensitive(enabled); });
    }
    content.append(&consent); content.append(status); page.append(&content);
    (page, qr, email, password, password_button)
}

