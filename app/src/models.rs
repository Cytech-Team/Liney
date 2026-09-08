use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub avatar_url: String,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub status_message: String,
    #[serde(default)]
    pub unread: u32,
    #[serde(default)]
    pub last_message_time: i64,
    #[serde(default)]
    pub member_count: u32,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub favorite_timestamp: i64,
    #[serde(default)]
    pub is_favorite: bool,
    #[serde(default)]
    pub favorite_time: i64,
}

impl Chat {
    pub fn subtitle(&self) -> String {
        if !self.preview.trim().is_empty() {
            self.preview.trim().to_owned()
        } else if !self.status_message.trim().is_empty() {
            self.status_message.trim().to_owned()
        } else if self.kind == "openchat" {
            if self.member_count > 0 { format!("OpenChat · {} คน", self.member_count) } else { "OpenChat".into() }
        } else if self.kind == "group" {
            "กลุ่ม · LINE".into()
        } else {
            "เพื่อน · LINE".into()
        }
    }

    pub fn engine_kind(&self) -> &'static str {
        if self.kind == "openchat" { "openchat" } else { "talk" }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyTarget {
    pub id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub sender_name: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    #[serde(rename = "type", default)]
    pub reaction_type: u32,
    #[serde(default)]
    pub count: u32,
    #[serde(default)]
    pub mine: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    #[serde(default)]
    pub local_id: String,
    #[serde(default)]
    pub chat_id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub is_mine: bool,
    #[serde(default)]
    pub created_time: i64,
    #[serde(default)]
    pub content_type: u32,
    #[serde(default)]
    pub sender_id: String,
    #[serde(default)]
    pub sender_name: String,
    #[serde(default)]
    pub sender_avatar_url: String,
    #[serde(default)]
    pub sticker_url: String,
    #[serde(default)]
    pub emoji_url: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub post_notification: Value,
    #[serde(default)]
    pub flex: Value,
    #[serde(default)]
    pub rich: Value,
    #[serde(default)]
    pub reactions: Vec<Reaction>,
    #[serde(default)]
    pub reply_to: Option<ReplyTarget>,
    #[serde(default)]
    pub reply_to_id: String,
    #[serde(default)]
    pub unsent: bool,
    #[serde(default)]
    pub read_by_peer: bool,
    #[serde(default = "default_message_status")]
    pub status: String,
    #[serde(skip)]
    pub image_data_url: String,
    #[serde(skip)]
    pub asset_data_url: String,
}

fn default_message_status() -> String { "sent".into() }

impl Message {
    pub fn summary(&self) -> String {
        if self.unsent { return "ยกเลิกข้อความแล้ว".into(); }
        if !self.text.trim().is_empty() && !is_internal_token(&self.text) {
            return self.text.trim().to_owned();
        }
        if !self.rich.is_null() { return rich_alt_text(&self.rich).unwrap_or_else(|| "Rich message".into()); }
        if !self.flex.is_null() { return "Flex message".into(); }
        match self.content_type {
            1 => "รูปภาพ".into(),
            2 => "วิดีโอ".into(),
            3 => "เสียง".into(),
            7 => "สติกเกอร์".into(),
            14 => if self.filename.is_empty() { "ไฟล์".into() } else { self.filename.clone() },
            16 => post_notification_text(&self.post_notification).unwrap_or_else(|| "มีโพสต์ใหม่".into()),
            17 => rich_alt_text(&self.rich).unwrap_or_else(|| "Rich message".into()),
            22 => "Flex message".into(),
            _ => if self.text.trim().is_empty() { "ข้อความ".into() } else { self.text.trim().to_owned() },
        }
    }
}

fn is_internal_token(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_uppercase().as_str(),
        "IMAGE" | "VIDEO" | "AUDIO" | "CALL" | "STICKER" | "FILE" | "LOCATION" | "POSTNOTIFICATION" | "CHATEVENT" | "FLEX"
    )
}

pub fn rich_alt_text(value: &Value) -> Option<String> {
    value.get("altText").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

pub fn post_notification_text(value: &Value) -> Option<String> {
    for key in ["text", "title", "description", "body"] {
        if let Some(s) = value.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
            return Some(s.to_owned());
        }
    }
    None
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub mid: String,
    #[serde(default)]
    pub picture_status: String,
    #[serde(default)]
    pub status_message: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sticker {
    pub package_id: String,
    pub sticker_id: String,
    #[serde(default = "default_sticker_version")]
    pub version: String,
    #[serde(default)]
    pub option: String,
    #[serde(default)]
    pub owned: bool,
}
fn default_sticker_version() -> String { "1".into() }

impl Sticker {
    pub fn url(&self) -> String {
        format!(
            "https://stickershop.line-scdn.net/stickershop/v1/sticker/{}/android/{}",
            self.sticker_id,
            if self.option.eq_ignore_ascii_case("A") { "sticker_animation.png" } else { "sticker.png" }
        )
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEmoji {
    pub product_id: String,
    pub sticon_id: String,
    #[serde(default = "default_emoji_version")]
    pub version: String,
    #[serde(default = "default_resource_type")]
    pub resource_type: String,
    #[serde(default)]
    pub owned: bool,
}
fn default_emoji_version() -> String { "1".into() }
fn default_resource_type() -> String { "STATIC".into() }

impl LineEmoji {
    pub fn url(&self) -> String {
        format!("https://stickershop.line-scdn.net/sticonshop/v1/sticon/{}/android/{}.png", self.product_id, self.sticon_id)
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub kind: String,
}
