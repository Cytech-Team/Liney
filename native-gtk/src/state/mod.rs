use std::collections::HashMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use gtk4 as gtk;
use gtk::gio;
use gtk::prelude::*;
use crate::engine::EngineBridge;
use crate::models::{AudioDevice, Chat, Message, Profile};
use crate::settings::AppSettings;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Section { Messages, Friends, OpenChat, Calls }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListFilter { All, Unread, Pinned, Favorites }

impl Section {
    pub fn title(self) -> &'static str {
        match self {
            Self::Messages => "แชต",
            Self::Friends => "เพื่อน",
            Self::OpenChat => "OpenChat",
            Self::Calls => "โทร",
        }
    }
}

#[derive(Clone)]
pub enum Pending {
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

pub struct PendingRequest {
    pub action: Pending,
    pub deadline: Instant,
}

#[derive(Clone, Debug, Default)]
pub struct Capabilities {
    pub authenticated: bool,
    pub linejs_version: String,
    pub storage_mode: String,
    pub call_enabled: bool,
    pub incoming_call: bool,
    pub call_reason: String,
}

pub struct State {
    pub app: gtk::Application,
    pub window: gtk::ApplicationWindow,
    pub engine: EngineBridge,
    pub pending: HashMap<u64, PendingRequest>,
    pub capabilities: Capabilities,
    pub profile: Option<Profile>,
    pub settings: AppSettings,
    pub css_provider: gtk::CssProvider,
    pub section: Section,
    pub list_filter: ListFilter,
    pub query: String,
    pub chats: Vec<Chat>,
    pub friends: Vec<Chat>,
    pub open_chats: Vec<Chat>,
    pub sidebar_ids: Vec<String>,
    pub active_chat_id: String,
    pub messages: HashMap<String, Vec<crate::models::Message>>,
    pub reply_target: Option<crate::models::ReplyTarget>,
    pub asset_cache: HashMap<String, String>,
    pub notification_dedup: HashMap<String, Instant>,
    pub pending_jump: Option<(String, String)>,
    pub stack: gtk::Stack,
    pub overlay: gtk::Overlay,
    pub qr_backdrop: Option<gtk::Box>,
    pub status: gtk::Label,
    pub login_status: gtk::Label,
    pub sync_label: gtk::Label,
    pub sync_bar: gtk::ProgressBar,
    pub sync_gate: gtk::Box,
    pub sync_gate_title: gtk::Label,
    pub sync_gate_detail: gtk::Label,
    pub sync_gate_bar: gtk::ProgressBar,
    pub sync_gate_percent: gtk::Label,
    pub section_title: gtk::Label,
    pub offline_banner: gtk::Box,
    pub offline_label: gtk::Label,
    pub chat_empty: gtk::Label,
    pub message_empty: gtk::Label,
    pub chat_list: gtk::ListView,
    pub chat_store: gio::ListStore,
    pub chat_selection: gtk::SingleSelection,
    pub message_list: gtk::ListView,
    pub message_store: gio::ListStore,
    pub message_selection: gtk::NoSelection,
    pub messages_scroll: gtk::ScrolledWindow,
    pub scroll_bottom_button: gtk::Button,
    pub follow_bottom: bool,
    pub scroll_programmatic: bool,
    pub header_avatar: gtk::Image,
    pub chat_title: gtk::Label,
    pub chat_subtitle: gtk::Label,
    pub composer: gtk::TextView,
    pub reply_bar: gtk::Box,
    pub reply_label: gtk::Label,
    pub attach_button: gtk::Button,
    pub paste_button: gtk::Button,
    pub sticker_button: gtk::Button,
    pub call_button: gtk::Button,
    pub send_button: gtk::Button,
    pub nav_buttons: HashMap<Section, gtk::Button>,
    pub call_window: Option<gtk::Window>,
    pub incoming_call_window: Option<gtk::Window>,
    pub call_status_label: Option<gtk::Label>,
    pub call_mute_button: Option<gtk::Button>,
    pub call_muted: bool,
    pub call_devices: Vec<AudioDevice>,
    pub call_output_box: Option<gtk::Box>,
    pub tray_sender: mpsc::Sender<super::TrayCommand>,
    pub tray_handle: Option<ksni::blocking::Handle<super::LineyTray>>,
}

impl State {
    pub fn request(&mut self, method: &str, params: serde_json::Value, action: Pending) {
        self.request_timeout(method, params, action, Duration::from_secs(60));
    }
    pub fn request_timeout(&mut self, method: &str, params: serde_json::Value, action: Pending, timeout: Duration) {
        match self.engine.request(method, params) {
            Ok(id) => {
                self.pending.insert(id, PendingRequest { action, deadline: Instant::now() + timeout });
            }
            Err(error) => self.set_status(&error),
        }
    }
    pub fn set_status(&self, text: &str) {
        self.status.set_text(text);
        self.login_status.set_text(text);
    }
    pub fn chat_by_id(&self, id: &str) -> Option<Chat> {
        self.chats.iter().chain(self.open_chats.iter()).chain(self.friends.iter()).find(|chat| chat.id == id).cloned()
    }
    pub fn active_chat(&self) -> Option<Chat> {
        self.chat_by_id(&self.active_chat_id)
    }
    pub fn load_account_lists(&mut self) {
        self.set_status("กำลังโหลดข้อมูล LINE…");
        self.request("profile.get", serde_json::json!({}), Pending::Profile);
        self.request_timeout("chat.list", serde_json::json!({}), Pending::Chats, Duration::from_secs(90));
        self.request_timeout("friends.list", serde_json::json!({}), Pending::Friends, Duration::from_secs(90));
        if self.settings.openchat {
            self.request_timeout("openchat.list", serde_json::json!({}), Pending::OpenChats, Duration::from_secs(90));
        }
    }
    pub fn mark_read(&mut self, chat: &Chat) {
        let message_id = self.messages.get(&chat.id).and_then(|m| m.last()).map(|m| m.id.clone()).unwrap_or_default();
        self.request("chat.mark_read", serde_json::json!({
            "chatId": chat.id,
            "kind": chat.engine_kind(),
            "messageId": message_id,
        }), Pending::MarkRead);
        for item in self.chats.iter_mut().chain(self.open_chats.iter_mut()) {
            if item.id == chat.id { item.unread = 0; }
        }
    }
    pub fn restart_engine(&mut self) -> Result<(), String> {
        let engine = EngineBridge::spawn()?;
        self.engine.terminate();
        self.engine = engine;
        self.pending.clear();
        self.set_status("เชื่อม LINE engine ใหม่แล้ว…");
        Ok(())
    }
}

#[derive(Clone)]
pub enum TrayCommand { Show, Quit }

#[derive(Clone, Debug)]
pub struct LineyTray { pub sender: mpsc::Sender<TrayCommand> }

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
