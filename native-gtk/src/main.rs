mod composer_media;
mod engine;
mod models;
mod settings;
mod theme;

use base64::Engine as _;
use engine::EngineBridge;
use gdk_pixbuf::{InterpType, PixbufLoader};
use gtk4 as gtk;
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
    sync::{atomic::{AtomicU64, Ordering}, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const APP_ID: &str = "dev.liney.desktop";
static LOCAL_ID: AtomicU64 = AtomicU64::new(1);
static SEND_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Section { Messages, Friends, OpenChat, Calls }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListFilter { All, Unread, Pinned, Favorites }

impl Section {
    fn title(self) -> &'static str {
        match self {
            Self::Messages => "แชต",
            Self::Friends => "เพื่อน",
            Self::OpenChat => "OpenChat",
            Self::Calls => "โทร",
        }
    }
}

#[derive(Clone)]
enum Pending {
    Capabilities,
    Profile,
    Chats,
    Friends,
    OpenChats,
    Messages { chat_id: String },
    MarkRead,
    Send { chat_id: String, local_id: String },
    MediaSend { chat_id: String, local_id: String },
    MediaCancel { chat_id: String, local_id: String },
    MediaPreview { chat_id: String, message_id: String, attempt: u8 },
    AssetMessage { chat_id: String, message_id: String, candidates: Vec<String>, index: usize },
    AssetButton { button: gtk::Button },
    AssetImage { image: gtk::Image, url: String, size: i32, guard_chat_id: String },
    AssetPicture { picture: gtk::Picture, url: String, max_width: i32, max_height: i32 },
    Stickers { grid: gtk::FlowBox, tabs: gtk::Box },
    Emojis { grid: gtk::FlowBox, tabs: gtk::Box },
    SendSticker { chat_id: String, local_id: String },
    SendEmoji { chat_id: String, local_id: String },
    Retry { chat_id: String, local_id: String },
    React { chat_id: String },
    Delete { chat_id: String, message_id: String },
    Unsend { chat_id: String, message_id: String },
    Login,
    Logout,
    SyncStart,
    HistoryClear,
    StickerCacheClear,
    CallStart,
    CallDevices,
    CallAccept,
    CallReject,
    CallEnd,
    CallMute,
    CallOutput,
}

struct PendingRequest {
    action: Pending,
    deadline: Instant,
}

#[derive(Clone, Debug, Default)]
struct Capabilities {
    authenticated: bool,
    linejs_version: String,
    storage_mode: String,
    call_enabled: bool,
    incoming_call: bool,
    call_reason: String,
}

struct State {
    app: gtk::Application,
    window: gtk::ApplicationWindow,
    engine: EngineBridge,
    pending: HashMap<u64, PendingRequest>,
    capabilities: Capabilities,
    profile: Option<Profile>,
    settings: AppSettings,
    css_provider: gtk::CssProvider,
    section: Section,
    list_filter: ListFilter,
    query: String,
    chats: Vec<Chat>,
    friends: Vec<Chat>,
    open_chats: Vec<Chat>,
    sidebar_ids: Vec<String>,
    active_chat_id: String,
    messages: HashMap<String, Vec<Message>>,
    reply_target: Option<ReplyTarget>,
    asset_cache: HashMap<String, String>,
    notification_dedup: HashMap<String, Instant>,
    pending_jump: Option<(String, String)>,
    stack: gtk::Stack,
    overlay: gtk::Overlay,
    qr_backdrop: Option<gtk::Box>,
    status: gtk::Label,
    login_status: gtk::Label,
    sync_label: gtk::Label,
    sync_bar: gtk::ProgressBar,
    sync_gate: gtk::Box,
    sync_gate_title: gtk::Label,
    sync_gate_detail: gtk::Label,
    sync_gate_bar: gtk::ProgressBar,
    sync_gate_percent: gtk::Label,
    section_title: gtk::Label,
    chat_list: gtk::ListBox,
    message_list: gtk::ListBox,
    messages_scroll: gtk::ScrolledWindow,
    scroll_bottom_button: gtk::Button,
    follow_bottom: bool,
    scroll_programmatic: bool,
    header_avatar: gtk::Image,
    chat_title: gtk::Label,
    chat_subtitle: gtk::Label,
    composer: gtk::TextView,
    reply_bar: gtk::Box,
    reply_label: gtk::Label,
    attach_button: gtk::Button,
    paste_button: gtk::Button,
    sticker_button: gtk::Button,
    call_button: gtk::Button,
    send_button: gtk::Button,
    nav_buttons: HashMap<Section, gtk::Button>,
    call_window: Option<gtk::Window>,
    incoming_call_window: Option<gtk::Window>,
    call_status_label: Option<gtk::Label>,
    call_mute_button: Option<gtk::Button>,
    call_muted: bool,
    call_devices: Vec<AudioDevice>,
    call_output_box: Option<gtk::Box>,
    tray_sender: mpsc::Sender<TrayCommand>,
    tray_handle: Option<ksni::blocking::Handle<LineyTray>>,
}

impl State {
    fn request(&mut self, method: &str, params: Value, action: Pending) {
        self.request_timeout(method, params, action, Duration::from_secs(60));
    }

    fn request_timeout(&mut self, method: &str, params: Value, action: Pending, timeout: Duration) {
        match self.engine.request(method, params) {
            Ok(id) => {
                self.pending.insert(id, PendingRequest { action, deadline: Instant::now() + timeout });
            }
            Err(error) => self.set_status(&error),
        }
    }

    fn set_status(&self, text: &str) {
        self.status.set_text(text);
        self.login_status.set_text(text);
    }

    fn chat_by_id(&self, id: &str) -> Option<Chat> {
        self.chats.iter().chain(self.open_chats.iter()).chain(self.friends.iter()).find(|chat| chat.id == id).cloned()
    }

    fn active_chat(&self) -> Option<Chat> {
        self.chat_by_id(&self.active_chat_id)
    }

    fn load_account_lists(&mut self) {
        self.set_status("กำลังโหลดข้อมูล LINE…");
        self.request("profile.get", json!({}), Pending::Profile);
        self.request_timeout("chat.list", json!({}), Pending::Chats, Duration::from_secs(90));
        self.request_timeout("friends.list", json!({}), Pending::Friends, Duration::from_secs(90));
        if self.settings.openchat {
            self.request_timeout("openchat.list", json!({}), Pending::OpenChats, Duration::from_secs(90));
        }
    }

    fn mark_read(&mut self, chat: &Chat) {
        let message_id = self.messages.get(&chat.id).and_then(|m| m.last()).map(|m| m.id.clone()).unwrap_or_default();
        self.request("chat.mark_read", json!({
            "chatId": chat.id,
            "kind": chat.engine_kind(),
            "messageId": message_id,
        }), Pending::MarkRead);
        for item in self.chats.iter_mut().chain(self.open_chats.iter_mut()) {
            if item.id == chat.id { item.unread = 0; }
        }
    }

    fn restart_engine(&mut self) -> Result<(), String> {
        let engine = EngineBridge::spawn()?;
        self.engine.terminate();
        self.engine = engine;
        self.pending.clear();
        self.set_status("เชื่อม LINE engine ใหม่แล้ว…");
        Ok(())
    }
}

#[derive(Clone)]
enum TrayCommand { Show, Quit }

#[derive(Clone, Debug)]
struct LineyTray { sender: mpsc::Sender<TrayCommand> }

impl ksni::Tray for LineyTray {
    fn id(&self) -> String { "liney".into() }
    fn title(&self) -> String { "Liney".into() }
    fn icon_name(&self) -> String { "liney".into() }
    fn activate(&mut self, _x: i32, _y: i32) { let _ = self.sender.send(TrayCommand::Show); }
    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::{MenuItem, StandardItem};
        vec![
            StandardItem {
                label: "เปิด Liney".into(),
                icon_name: "liney".into(),
                activate: Box::new(|tray: &mut LineyTray| { let _ = tray.sender.send(TrayCommand::Show); }),
                ..Default::default()
            }.into(),
            MenuItem::Separator,
            StandardItem {
                label: "ออก".into(),
                icon_name: "application-exit".into(),
                activate: Box::new(|tray: &mut LineyTray| { let _ = tray.sender.send(TrayCommand::Quit); }),
                ..Default::default()
            }.into(),
        ]
    }
}

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

fn build_ui(app: &gtk::Application) {
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
        chat_list: main.chat_list.clone(), message_list: main.message_list.clone(), messages_scroll: main.messages_scroll.clone(), scroll_bottom_button: main.scroll_bottom_button.clone(), follow_bottom: true, scroll_programmatic: false,
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
        let state = state.clone();
        main.chat_list.connect_row_activated(move |_, row| {
            let index = row.index() as usize;
            let id = state.borrow().sidebar_ids.get(index).cloned();
            if let Some(id) = id { open_chat(&state, &id); }
        });
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

struct SyncGateWidgets {
    root: gtk::Box,
    title: gtk::Label,
    detail: gtk::Label,
    bar: gtk::ProgressBar,
    percent: gtk::Label,
}

fn build_sync_gate() -> SyncGateWidgets {
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

struct MainWidgets {
    root: gtk::Box,
    nav_buttons: HashMap<Section, gtk::Button>,
    brand_button: gtk::Button,
    settings_button: gtk::Button,
    section_title: gtk::Label,
    search: gtk::SearchEntry,
    filter: gtk::DropDown,
    chat_list: gtk::ListBox,
    message_list: gtk::ListBox,
    messages_scroll: gtk::ScrolledWindow,
    scroll_bottom_button: gtk::Button,
    header_avatar: gtk::Image,
    chat_title: gtk::Label,
    chat_subtitle: gtk::Label,
    refresh_button: gtk::Button,
    call_button: gtk::Button,
    composer: gtk::TextView,
    attach_button: gtk::Button,
    paste_button: gtk::Button,
    sticker_button: gtk::Button,
    send_button: gtk::Button,
    reply_bar: gtk::Box,
    reply_label: gtk::Label,
    reply_cancel: gtk::Button,
    sync_label: gtk::Label,
    sync_bar: gtk::ProgressBar,
}

fn build_main(status: &gtk::Label) -> MainWidgets {
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
    let chat_list = gtk::ListBox::builder().selection_mode(gtk::SelectionMode::Single).css_classes(["chat-list"]).build();
    let chats_scroll = gtk::ScrolledWindow::builder().child(&chat_list).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).build();
    sidebar.append(&chats_scroll);
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

    let sync_box = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(4).margin_start(24).margin_end(24).margin_top(8).build();
    let sync_label = gtk::Label::builder().xalign(0.0).css_classes(["sync-label"]).build();
    let sync_bar = gtk::ProgressBar::new();
    sync_bar.set_visible(false); sync_label.set_visible(false);
    sync_box.append(&sync_label); sync_box.append(&sync_bar); content.append(&sync_box);

    let message_list = gtk::ListBox::builder().selection_mode(gtk::SelectionMode::None).css_classes(["message-list"]).build();
    let messages_scroll = gtk::ScrolledWindow::builder().child(&message_list).vexpand(true).hscrollbar_policy(gtk::PolicyType::Never).css_classes(["message-stage"]).build();
    let message_stage_overlay = gtk::Overlay::new(); message_stage_overlay.set_vexpand(true); message_stage_overlay.set_child(Some(&messages_scroll));
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

    MainWidgets { root, nav_buttons, brand_button, settings_button, section_title, search, filter, chat_list, message_list, messages_scroll, scroll_bottom_button, header_avatar, chat_title, chat_subtitle,
        refresh_button, call_button, composer, attach_button, paste_button, sticker_button, send_button, reply_bar, reply_label, reply_cancel, sync_label, sync_bar }
}

fn build_login(status: &gtk::Label) -> (gtk::Box, gtk::Button, gtk::Entry, gtk::PasswordEntry, gtk::Button) {
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
        "event.transport" => state.borrow().set_status("สถานะการเชื่อมต่อ LINE เปลี่ยนแปลง"),
        "event.transport.error" => state.borrow().set_status("การเชื่อมต่อ LINE ขัดข้อง กำลังลองใหม่…"),
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
                if let Some(picture) = picture_from_data_url(data, 72, 72) { button.set_child(Some(&picture)); }
            }
        }
        Pending::AssetImage { image, url, size, guard_chat_id } => {
            if let Some(data) = result.get("dataUrl").and_then(Value::as_str) {
                let allowed = guard_chat_id.is_empty() || state.borrow().active_chat_id == guard_chat_id;
                state.borrow_mut().asset_cache.insert(url, data.to_owned());
                if allowed { if let Some(pixbuf) = pixbuf_from_data_url(data, size, size) { image.set_from_pixbuf(Some(&pixbuf)); } }
            }
        }
        Pending::AssetPicture { picture, url, max_width, max_height } => {
            if let Some(data) = result.get("dataUrl").and_then(Value::as_str) {
                state.borrow_mut().asset_cache.insert(url, data.to_owned());
                if let Some(pixbuf) = pixbuf_from_data_url(data, max_width, max_height) { picture.set_pixbuf(Some(&pixbuf)); }
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

fn render_sidebar(state: &Rc<RefCell<State>>) {
    let (items, query, section, list) = {
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
        (items, needle, app.section, app.chat_list.clone())
    };
    clear_list(&list);
    let mut ids = Vec::new();
    if section == Section::Calls {
        let row = gtk::ListBoxRow::new(); row.set_selectable(false);
        row.set_child(Some(&gtk::Label::builder().label("เลือกแชตส่วนตัวแล้วกดปุ่มโทรด้านบน\nLiney รองรับสายเสียง 1:1 เมื่อ LINEJS และ PipeWire พร้อม").wrap(true).xalign(0.0).margin_top(24).margin_start(18).margin_end(18).css_classes(["empty-note"]).build()));
        list.append(&row);
    } else if items.is_empty() {
        let text = if !query.is_empty() { "ไม่พบผลการค้นหา" } else if section == Section::OpenChat { "ไม่พบ OpenChat" } else { "ยังไม่มีรายการ" };
        let row = gtk::ListBoxRow::new(); row.set_selectable(false); row.set_child(Some(&gtk::Label::builder().label(text).margin_top(24).css_classes(["empty-note"]).build())); list.append(&row);
    } else {
        for chat in &items {
            let row = gtk::ListBoxRow::new(); row.set_child(Some(&chat_row(state, chat))); list.append(&row); ids.push(chat.id.clone());
        }
    }
    state.borrow_mut().sidebar_ids = ids;
}

fn maybe_select_first_chat(state: &Rc<RefCell<State>>) {
    let first = {
        let app = state.borrow();
        if !app.active_chat_id.is_empty() { return; }
        app.chats.first().or_else(|| app.open_chats.first()).map(|c| c.id.clone())
    };
    if let Some(id) = first { open_chat(state, &id); }
}

fn open_chat(state: &Rc<RefCell<State>>, id: &str) {
    let chat = state.borrow().chat_by_id(id);
    let Some(chat) = chat else { return };
    {
        let mut app = state.borrow_mut();
        app.active_chat_id = chat.id.clone(); app.follow_bottom = true; app.scroll_bottom_button.set_visible(false);
        app.chat_title.set_text(&chat.name); app.chat_subtitle.set_text(&chat.subtitle());
        app.header_avatar.set_icon_name(Some("avatar-default-symbolic")); app.header_avatar.set_pixel_size(38);
        if !chat.avatar_url.is_empty() {
            if let Some(data) = app.asset_cache.get(&chat.avatar_url).cloned() { if let Some(pixbuf) = pixbuf_from_data_url(&data, 38, 38) { app.header_avatar.set_from_pixbuf(Some(&pixbuf)); } }
            else { let image = app.header_avatar.clone(); app.request_timeout("asset.preview", json!({ "url": chat.avatar_url }), Pending::AssetImage { image, url: chat.avatar_url.clone(), size: 38, guard_chat_id: chat.id.clone() }, Duration::from_secs(30)); }
        }
        app.reply_target = None; set_composer_enabled(&app, true, chat.kind == "dm" && app.capabilities.call_enabled); app.mark_read(&chat);
        app.set_status("กำลังโหลดข้อความ…");
        app.request_timeout("message.list", json!({ "chatId": chat.id, "kind": chat.engine_kind(), "limit": if chat.kind == "openchat" { 40 } else { 50 } }), Pending::Messages { chat_id: chat.id.clone() }, Duration::from_secs(60));
    }
    update_reply_bar(state); render_sidebar(state); render_messages(state);
}

fn render_messages(state: &Rc<RefCell<State>>) {
    let (messages, active, list, scroll, follow_bottom, old_value) = {
        let mut app = state.borrow_mut();
        let adjustment = app.messages_scroll.vadjustment();
        let old_value = adjustment.value();
        app.scroll_programmatic = true;
        (app.messages.get(&app.active_chat_id).cloned().unwrap_or_default(), app.active_chat(), app.message_list.clone(), app.messages_scroll.clone(), app.follow_bottom, old_value)
    };
    clear_list(&list);
    let Some(chat) = active else {
        let row = gtk::ListBoxRow::new(); row.set_selectable(false); row.set_child(Some(&gtk::Label::builder().label("เลือกแชตทางซ้ายเพื่อเริ่มใช้งาน").css_classes(["conversation-empty"]).margin_top(120).build())); list.append(&row); return;
    };
    if messages.is_empty() {
        let row = gtk::ListBoxRow::new(); row.set_selectable(false); row.set_child(Some(&gtk::Label::builder().label("ยังไม่มีข้อความในห้องนี้").css_classes(["conversation-empty"]).margin_top(120).build())); list.append(&row);
    }
    for message in messages {
        list.append(&message_row(state, &chat, &message));
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

fn maybe_jump_to_message(state: &Rc<RefCell<State>>, chat_id: &str) {
    let jump = state.borrow().pending_jump.clone();
    let Some((target_chat, message_id)) = jump else { return; };
    if target_chat != chat_id { return; }
    let index = state.borrow().messages.get(chat_id).and_then(|items| items.iter().position(|message| message.id == message_id));
    let Some(index) = index else { return; };
    state.borrow_mut().pending_jump = None;
    let list = state.borrow().message_list.clone();
    gtk::glib::idle_add_local_once(move || {
        if let Some(row) = list.row_at_index(index as i32) {
            row.add_css_class("jump-highlight"); row.grab_focus();
            let weak = row.downgrade();
            gtk::glib::timeout_add_local_once(Duration::from_millis(2600), move || { if let Some(row) = weak.upgrade() { row.remove_css_class("jump-highlight"); } });
        }
    });
}

fn scroll_messages_to_bottom(state: &Rc<RefCell<State>>) {
    let scroll = state.borrow().messages_scroll.clone();
    { let mut app = state.borrow_mut(); app.follow_bottom = true; app.scroll_programmatic = true; app.scroll_bottom_button.set_visible(false); }
    let weak = Rc::downgrade(state);
    gtk::glib::idle_add_local_once(move || {
        let adjustment = scroll.vadjustment(); adjustment.set_value((adjustment.upper() - adjustment.page_size()).max(adjustment.lower()));
        if let Some(state) = weak.upgrade() { state.borrow_mut().scroll_programmatic = false; }
    });
}

fn message_row(state: &Rc<RefCell<State>>, chat: &Chat, message: &Message) -> gtk::ListBoxRow {
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
        if let Some(picture) = picture_from_data_url(&message.image_data_url, 460, 340) {
            picture.add_css_class("message-image");
            let viewer = gtk::Button::builder().child(&picture).css_classes(["image-button"]).build();
            let state2 = state.clone(); let parent = state.borrow().window.clone(); let data_url = message.image_data_url.clone();
            viewer.connect_clicked(move |_| {
                let state = state2.clone();
                composer_media::show_image_viewer(&parent, &data_url, move |message| state.borrow().set_status(message));
            });
            bubble.append(&viewer);
        }
    } else if !message.asset_data_url.is_empty() {
        if let Some(picture) = picture_from_data_url(&message.asset_data_url, 240, 200) { picture.add_css_class("message-sticker"); bubble.append(&picture); }
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
    { let state = state.clone(); let message = message.clone(); reply.connect_clicked(move |_| { begin_reply(&state, &message); }); }
    actions.append(&reply);
    let react = small_button("♡");
    { let state = state.clone(); let chat = chat.clone(); let message = message.clone(); react.connect_clicked(move |button| show_reaction_picker(&state, &chat, &message, button)); }
    actions.append(&react);
    let delete = small_button("ลบของฉัน");
    { let state = state.clone(); let chat = chat.clone(); let message = message.clone(); delete.connect_clicked(move |_| delete_for_me(&state, &chat, &message)); }
    actions.append(&delete);
    if message.is_mine && !message.unsent && message.status == "sent" {
        let unsend = small_button("ยกเลิกส่ง");
        { let state = state.clone(); let chat = chat.clone(); let message = message.clone(); unsend.connect_clicked(move |_| unsend_message(&state, &chat, &message)); }
        actions.append(&unsend);
    }
    if message.status == "sending" && message.content_type > 0 {
        let cancel = small_button("ยกเลิกไฟล์");
        { let state = state.clone(); let chat_id = chat.id.clone(); let local_id = message.id.clone(); cancel.connect_clicked(move |_| cancel_media(&state, &chat_id, &local_id)); }
        actions.append(&cancel);
    }
    if matches!(message.status.as_str(), "error" | "unknown") {
        let retry = small_button("ลองใหม่");
        { let state = state.clone(); let chat_id = chat.id.clone(); let local_id = message.id.clone(); retry.connect_clicked(move |_| retry_message(&state, &chat_id, &local_id)); }
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

fn is_arranged_sticker_url(url: &str) -> bool { url.contains("/sticker/651698630/") }

fn sticker_candidate_urls(url: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |value: String| { if !value.is_empty() && !out.contains(&value) { out.push(value); } };
    push(url.to_owned());
    let platforms = ["/android/", "/ANDROID/", "/iPhone/"];
    let mut base = None;
    for platform in platforms { if let Some(index) = url.find(platform) { base = Some(url[..index].to_owned()); break; } }
    if let Some(base) = base {
        let animated = url.contains("sticker_animation") || url.contains("@2x.png");
        if animated {
            push(format!("{base}/android/sticker_animation.png")); push(format!("{base}/ANDROID/sticker_animation.png")); push(format!("{base}/iPhone/sticker@2x.png")); push(format!("{base}/android/sticker.png"));
        } else {
            push(format!("{base}/android/sticker.png")); push(format!("{base}/ANDROID/sticker.png")); push(format!("{base}/iPhone/sticker@2x.png")); push(format!("{base}/android/sticker_animation.png"));
        }
    }
    out
}

fn hydrate_message_assets(state: &Rc<RefCell<State>>, chat_id: &str) {
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
            if let Some(data) = cached { if let Some(pixbuf) = pixbuf_from_data_url(&data, 52, 52) { image.set_from_pixbuf(Some(&pixbuf)); } }
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
            if let Some(data) = cached { if let Some(pixbuf) = pixbuf_from_data_url(&data, 48, 48) { image.set_from_pixbuf(Some(&pixbuf)); } }
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
    render_sidebar(state);
    if state.borrow().active_chat_id == chat_id { render_messages(state); hydrate_message_assets(state, &chat_id); }
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
    if state.borrow().active_chat_id == chat_id { render_messages(state); }
}

fn update_reactions(state: &Rc<RefCell<State>>, payload: &Value) {
    let chat_id = payload.get("chatId").and_then(Value::as_str).unwrap_or_default(); let message_id = payload.get("messageId").and_then(Value::as_str).unwrap_or_default();
    let reactions = payload.get("reactions").cloned().and_then(|v| serde_json::from_value::<Vec<Reaction>>(v).ok()).unwrap_or_default();
    if let Some(message) = state.borrow_mut().messages.get_mut(chat_id).and_then(|list| list.iter_mut().find(|m| m.id == message_id)) { message.reactions = reactions; }
    if state.borrow().active_chat_id == chat_id { render_messages(state); }
}

fn update_read_receipt(state: &Rc<RefCell<State>>, payload: &Value) {
    let chat_id = payload.get("chatId").and_then(Value::as_str).unwrap_or_default(); let message_id = payload.get("messageId").and_then(Value::as_str).unwrap_or_default();
    if let Some(list) = state.borrow_mut().messages.get_mut(chat_id) {
        for message in list.iter_mut().filter(|m| m.is_mine) { if message.id == message_id || numeric_leq(&message.id, message_id) { message.read_by_peer = true; } }
    }
    if state.borrow().active_chat_id == chat_id { render_messages(state); }
}

fn remove_message_event(state: &Rc<RefCell<State>>, payload: &Value) {
    let chat_id = payload.get("chatId").and_then(Value::as_str).unwrap_or_default(); let message_id = payload.get("messageId").and_then(Value::as_str).unwrap_or_default();
    if let Some(list) = state.borrow_mut().messages.get_mut(chat_id) { list.retain(|m| m.id != message_id); }
    if state.borrow().active_chat_id == chat_id { render_messages(state); }
}

fn unsent_message_event(state: &Rc<RefCell<State>>, payload: &Value) {
    let chat_id = payload.get("chatId").and_then(Value::as_str).unwrap_or_default(); let message_id = payload.get("messageId").and_then(Value::as_str).unwrap_or_default();
    if let Some(message) = state.borrow_mut().messages.get_mut(chat_id).and_then(|list| list.iter_mut().find(|m| m.id == message_id)) { message.unsent = true; message.text = "ยกเลิกข้อความแล้ว".into(); message.sticker_url.clear(); message.image_data_url.clear(); message.asset_data_url.clear(); message.reactions.clear(); }
    if state.borrow().active_chat_id == chat_id { render_messages(state); }
}

fn set_message_status(state: &Rc<RefCell<State>>, chat_id: &str, id: &str, status: &str) {
    if let Some(message) = state.borrow_mut().messages.get_mut(chat_id).and_then(|list| list.iter_mut().find(|m| m.id == id || m.local_id == id)) { message.status = status.into(); }
    if state.borrow().active_chat_id == chat_id { render_messages(state); }
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
fn render_calls_landing(state: &Rc<RefCell<State>>) { let mut app = state.borrow_mut(); app.active_chat_id.clear(); app.header_avatar.set_icon_name(Some("call-start-symbolic")); app.chat_title.set_text("โทร"); app.chat_subtitle.set_text(if app.capabilities.call_enabled { "สายเสียง 1:1 พร้อมใช้งาน" } else { "สายเสียงยังไม่พร้อม" }); set_composer_enabled(&app, false, false); clear_list(&app.message_list); }

fn show_account(state: &Rc<RefCell<State>>) {
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

fn show_settings(state: &Rc<RefCell<State>>) {
    let window = gtk::Window::builder().transient_for(&state.borrow().window).title("ตั้งค่า Liney").default_width(560).default_height(650).modal(false).build();
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(12).margin_top(18).margin_bottom(18).margin_start(20).margin_end(20).build();
    let profile = state.borrow().profile.clone().unwrap_or_default();
    let profile_header = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(12).build();
    if !profile.picture_status.is_empty() {
        let image = gtk::Image::new(); image.set_pixel_size(54);
        let url = if profile.picture_status.starts_with("http://") || profile.picture_status.starts_with("https://") { profile.picture_status.clone() } else { format!("https://profile.line-scdn.net/{}", profile.picture_status.trim_start_matches('/')) };
        let cached = { state.borrow().asset_cache.get(&url).cloned() };
        if let Some(data) = cached { if let Some(pixbuf) = pixbuf_from_data_url(&data, 54, 54) { image.set_from_pixbuf(Some(&pixbuf)); } }
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
    let logout = gtk::Button::with_label("ออกจากระบบ LINE"); logout.add_css_class("danger");
    { let state = state.clone(); let window = window.clone(); logout.connect_clicked(move |_| { state.borrow_mut().request("auth.logout", json!({}), Pending::Logout); window.close(); }); }
    buttons.append(&clear_history); buttons.append(&clear_stickers); buttons.append(&logout); root.append(&buttons);
    let scroll = gtk::ScrolledWindow::builder().child(&root).vexpand(true).build(); window.set_child(Some(&scroll)); window.present();
}

fn show_qr(state: &Rc<RefCell<State>>, url: &str) {
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

fn notify(app: &State, chat_id: &str, title: &str, body: &str, id: &str) {
    let notification = gtk::gio::Notification::new(title);
    notification.set_body(Some(body));
    notification.set_icon(&gtk::gio::ThemedIcon::new("liney"));
    let target = format!("{chat_id}\n{id}").to_variant();
    notification.set_default_action_and_target_value("app.open-chat", Some(&target));
    app.app.send_notification(Some(&format!("message-{id}")), &notification);
    if app.settings.notification_sound { if let Some(display) = gtk::gdk::Display::default() { display.beep(); } }
}




fn confirm_action<F>(state: &Rc<RefCell<State>>, title: &str, detail: &str, action: F)
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

fn set_composer_enabled(app: &State, enabled: bool, call_enabled: bool) {
    app.composer.set_sensitive(enabled);
    app.attach_button.set_sensitive(enabled);
    app.paste_button.set_sensitive(enabled);
    app.sticker_button.set_sensitive(enabled);
    app.send_button.set_sensitive(enabled && !composer_text(&app.composer).trim().is_empty());
    app.call_button.set_sensitive(enabled && call_enabled);
}

fn composer_text(view: &gtk::TextView) -> String {
    let buffer = view.buffer();
    buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string()
}

fn toggle_local_pin(state: &Rc<RefCell<State>>, chat_id: &str) {
    let mut app = state.borrow_mut();
    if app.settings.local_pins.remove(chat_id).is_none() { app.settings.local_pins.insert(chat_id.to_owned(), now_ms()); }
    let pin_ts = app.settings.local_pins.get(chat_id).copied();
    for chat in app.chats.iter_mut() { if chat.id == chat_id { if let Some(ts) = pin_ts { chat.pinned = true; chat.favorite_timestamp = chat.favorite_timestamp.max(ts); } else { chat.pinned = false; chat.favorite_timestamp = 0; } } }
    for chat in app.open_chats.iter_mut() { if chat.id == chat_id { if let Some(ts) = pin_ts { chat.pinned = true; chat.favorite_timestamp = chat.favorite_timestamp.max(ts); } else { chat.pinned = false; chat.favorite_timestamp = 0; } } }
    for chat in app.friends.iter_mut() { if chat.id == chat_id { if let Some(ts) = pin_ts { chat.pinned = true; chat.favorite_timestamp = chat.favorite_timestamp.max(ts); } else { chat.pinned = false; chat.favorite_timestamp = 0; } } }
    let _ = settings::save(&app.settings);
    if pin_ts.is_none() { app.request_timeout("chat.list", json!({}), Pending::Chats, Duration::from_secs(60)); }
    drop(app);
    render_sidebar(state);
}

fn update_chat_preview(state: &Rc<RefCell<State>>, chat_id: &str, preview: &str, created_time: i64) {
    let mut app = state.borrow_mut();
    for chat in app.chats.iter_mut() { if chat.id == chat_id { chat.preview = preview.to_owned(); chat.last_message_time = created_time; } }
    for chat in app.open_chats.iter_mut() { if chat.id == chat_id { chat.preview = preview.to_owned(); chat.last_message_time = created_time; } }
    drop(app);
    render_sidebar(state);
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

fn logo_widget(size: i32) -> gtk::Image {
    let executable_icon = env::current_exe().ok().and_then(|path| path.parent().map(|parent| parent.join("liney.png")));
    let data_icon = env::var_os("XDG_DATA_HOME").map(PathBuf::from).map(|path| path.join("icons/hicolor/512x512/apps/liney.png"));
    let candidates = [
        executable_icon,
        data_icon,
        Some(PathBuf::from("/usr/local/share/icons/hicolor/512x512/apps/liney.png")),
        Some(PathBuf::from("/usr/share/icons/hicolor/512x512/apps/liney.png")),
        Some(PathBuf::from("/usr/share/pixmaps/liney.png")),
        Some(PathBuf::from("packaging/liney.png")),
    ];
    if let Some(path) = candidates.into_iter().flatten().find(|path| path.is_file() && std::fs::File::open(path).is_ok()) {
        let image = gtk::Image::from_file(path);
        image.set_pixel_size(size);
        return image;
    }
    let icon_name = gtk::gdk::Display::default()
        .filter(|display| gtk::IconTheme::for_display(display).has_icon("liney"))
        .map(|_| "liney")
        .unwrap_or("image-x-generic-symbolic");
    let image = gtk::Image::from_icon_name(icon_name);
    image.set_pixel_size(size);
    image
}

fn avatar_widget(state: &Rc<RefCell<State>>, name: &str, url: &str, size: i32) -> gtk::Overlay {
    let overlay = gtk::Overlay::new(); overlay.set_size_request(size, size); overlay.add_css_class("avatar");
    let fallback = gtk::Label::builder().label(name.chars().take(2).collect::<String>().to_uppercase()).halign(gtk::Align::Center).valign(gtk::Align::Center).build(); overlay.set_child(Some(&fallback));
    if !url.is_empty() {
        let image = gtk::Image::new(); image.set_pixel_size(size); overlay.add_overlay(&image);
        let cached = { state.borrow().asset_cache.get(url).cloned() };
        if let Some(data) = cached { if let Some(pixbuf) = pixbuf_from_data_url(&data, size, size) { image.set_from_pixbuf(Some(&pixbuf)); } }
        else { state.borrow_mut().request_timeout("asset.preview", json!({ "url": url }), Pending::AssetImage { image, url: url.to_owned(), size, guard_chat_id: String::new() }, Duration::from_secs(30)); }
    }
    overlay
}

fn chat_row(state: &Rc<RefCell<State>>, chat: &Chat) -> gtk::Box {
    let root = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(9).css_classes(["chat-row"]).build();
    let initial = chat.name.chars().next().unwrap_or('L').to_string();
    let avatar_box = gtk::Overlay::new(); avatar_box.add_css_class("avatar"); avatar_box.set_size_request(44, 44);
    let fallback = gtk::Label::builder().label(initial).halign(gtk::Align::Center).valign(gtk::Align::Center).build(); avatar_box.set_child(Some(&fallback));
    if !chat.avatar_url.is_empty() {
        let image = gtk::Image::new(); image.set_pixel_size(44); avatar_box.add_overlay(&image);
        let cached = state.borrow().asset_cache.get(&chat.avatar_url).cloned();
        if let Some(data) = cached { if let Some(pixbuf) = pixbuf_from_data_url(&data, 44, 44) { image.set_from_pixbuf(Some(&pixbuf)); } }
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


fn rich_message_widget(state: &Rc<RefCell<State>>, value: &Value) -> gtk::Box {
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
        if let Some(data) = cached { if let Some(pixbuf) = pixbuf_from_data_url(&data, display_width as i32, display_height as i32) { picture.set_pixbuf(Some(&pixbuf)); fallback.set_visible(false); } }
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

fn post_notification_widget(state: &Rc<RefCell<State>>, value: &Value) -> gtk::Box {
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

fn flex_message_widget(state: &Rc<RefCell<State>>, value: &Value) -> gtk::Box {
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

fn flex_bubble_widget(state: &Rc<RefCell<State>>, node: &Value) -> gtk::Box {
    let bubble = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(0).width_request(320).css_classes(["flex-bubble-native"]).build();
    for section in ["header", "hero", "body", "footer"] { if let Some(value) = node.get(section).filter(|v| v.is_object()) { bubble.append(&flex_node_widget(state, value)); } }
    bubble
}

fn flex_node_widget(state: &Rc<RefCell<State>>, node: &Value) -> gtk::Widget {
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
                if let Some(data) = cached { if let Some(pixbuf) = pixbuf_from_data_url(&data, size, 240) { picture.set_pixbuf(Some(&pixbuf)); } }
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

fn wrap_flex_action(state: &Rc<RefCell<State>>, action: Option<&Value>, child: gtk::Widget) -> gtk::Widget {
    let Some(action) = action.filter(|value| value.is_object()).cloned() else { return child };
    let button = gtk::Button::builder().child(&child).css_classes(["flex-action-native"]).build(); let state = state.clone(); button.connect_clicked(move |_| perform_flex_action(&state, &action)); button.upcast()
}

fn perform_flex_action(state: &Rc<RefCell<State>>, action: &Value) {
    match action.get("type").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase().as_str() {
        "message" => if let Some(text) = action.get("text").and_then(Value::as_str) { send_text_value(state, text, false); },
        "uri" => { let desktop = action.pointer("/altUri/desktop").and_then(Value::as_str).unwrap_or(""); let primary = action.get("uri").and_then(Value::as_str).unwrap_or(""); let uri = if desktop.starts_with("http://") || desktop.starts_with("https://") { desktop } else if !primary.is_empty() { primary } else { desktop }; open_safe_uri(state, uri); },
        "clipboard" => if let Some(text) = action.get("clipboardText").and_then(Value::as_str) { if let Some(display) = gtk::gdk::Display::default() { display.clipboard().set_text(text); state.borrow().set_status("คัดลอกไป Clipboard แล้ว"); } },
        _ => state.borrow().set_status("Flex action นี้ไม่มีการทำงานที่ LINEJS ฝั่งไคลเอนต์รองรับ"),
    }
}

fn flex_spacing(value: Option<&str>) -> i32 { match value.unwrap_or("").to_ascii_lowercase().as_str() { "none" => 0, "xs" => 4, "sm" => 6, "md" => 8, "lg" => 12, "xl" => 16, "xxl" => 20, _ => 8 } }

fn is_safe_external_uri(uri: &str) -> bool {
    ["https://", "http://", "line:", "mailto:", "tel:"].iter().any(|prefix| uri.to_ascii_lowercase().starts_with(prefix))
}

fn open_safe_uri(state: &Rc<RefCell<State>>, uri: &str) {
    if !is_safe_external_uri(uri) { state.borrow().set_status("ลิงก์ใน Flex/Rich Message ไม่ปลอดภัยหรือไม่รองรับ"); return; }
    if let Err(error) = gtk::gio::AppInfo::launch_default_for_uri(uri, gtk::gio::AppLaunchContext::NONE) { state.borrow().set_status(&format!("เปิดลิงก์ไม่ได้: {error}")); }
}

fn pixbuf_from_data_url(data_url: &str, max_width: i32, max_height: i32) -> Option<gdk_pixbuf::Pixbuf> {
    let (_, encoded) = data_url.split_once(',')?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()).ok()?;
    let loader = PixbufLoader::new(); loader.write(&bytes).ok()?; loader.close().ok()?;
    let pixbuf = loader.pixbuf()?;
    let (width, height) = (pixbuf.width(), pixbuf.height());
    let scale = (max_width as f64 / width.max(1) as f64).min(max_height as f64 / height.max(1) as f64).min(1.0);
    if scale < 1.0 { pixbuf.scale_simple((width as f64 * scale) as i32, (height as f64 * scale) as i32, InterpType::Bilinear) } else { Some(pixbuf) }
}

fn picture_from_data_url(data_url: &str, max_width: i32, max_height: i32) -> Option<gtk::Picture> {
    let pixbuf = pixbuf_from_data_url(data_url, max_width, max_height)?;
    let picture = gtk::Picture::for_pixbuf(&pixbuf); picture.set_can_shrink(true); Some(picture)
}

fn icon_button(icon: &str, tooltip: &str) -> gtk::Button {
    let image = gtk::Image::from_icon_name(icon); image.set_pixel_size(17);
    let button = gtk::Button::builder().child(&image).css_classes(["icon-button"]).build(); button.set_tooltip_text(Some(tooltip)); button
}
fn small_button(label: &str) -> gtk::Button { gtk::Button::builder().label(label).css_classes(["small-action"]).build() }
fn clear_list(list: &gtk::ListBox) { while let Some(child) = list.first_child() { list.remove(&child); } }
fn reaction_icon(value: u32) -> &'static str { match value { 2 => "♥", 3 => "♥", 4 => "☺", 5 => "★", 6 => "☹", 7 => "!", _ => "♡" } }
fn new_local_id(prefix: &str) -> String { format!("{prefix}-{}-{}", now_ms(), LOCAL_ID.fetch_add(1, Ordering::Relaxed)) }
fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
fn message_time(timestamp: i64) -> String {
    if timestamp <= 0 { return String::new(); }
    let secs = timestamp / 1000;
    let dt = gtk::glib::DateTime::from_unix_local(secs).ok();
    dt.and_then(|d| d.format("%H:%M").ok()).map(|s| s.to_string()).unwrap_or_default()
}
fn numeric_leq(a: &str, b: &str) -> bool { match (a.parse::<u128>(), b.parse::<u128>()) { (Ok(a), Ok(b)) => a <= b, _ => a == b } }
fn media_type(filename: &str) -> (&'static str, u32) {
    let ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => ("image/png", 1), "webp" => ("image/webp", 1), "gif" => ("image/gif", 1), "jpg" | "jpeg" => ("image/jpeg", 1), "avif" => ("image/avif", 1), "bmp" => ("image/bmp", 1),
        "mp4" => ("video/mp4", 2), "m4v" => ("video/x-m4v", 2), "webm" => ("video/webm", 2), "mov" => ("video/quicktime", 2),
        "mp3" => ("audio/mpeg", 3), "ogg" => ("audio/ogg", 3), "wav" => ("audio/wav", 3), "m4a" => ("audio/mp4", 3), "flac" => ("audio/flac", 3),
        "pdf" => ("application/pdf", 14), "zip" => ("application/zip", 14), "txt" => ("text/plain", 14), "doc" => ("application/msword", 14), "docx" => ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", 14), "xls" => ("application/vnd.ms-excel", 14), "xlsx" => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 14), _ => ("application/octet-stream", 14),
    }
}
