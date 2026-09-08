use super::super::state::State;
use gdk_pixbuf::{InterpType, PixbufLoader};
use gtk4 as gtk;
use gtk::prelude::*;
use std::{
    cell::RefCell,
    env,
    path::PathBuf,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use base64::Engine as _;

pub static LOCAL_ID: AtomicU64 = AtomicU64::new(1);
pub static SEND_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(crate) fn new_local_id(prefix: &str) -> String {
    format!("{prefix}-{}-{}", now_ms(), LOCAL_ID.fetch_add(1, Ordering::Relaxed))
}
pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}
pub(crate) fn message_time(timestamp: i64) -> String {
    if timestamp <= 0 {
        return String::new();
    }
    let secs = timestamp / 1000;
    let dt = gtk::glib::DateTime::from_unix_local(secs).ok();
    dt.and_then(|d| d.format("%H:%M").ok()).map(|s| s.to_string()).unwrap_or_default()
}
pub(crate) fn numeric_leq(a: &str, b: &str) -> bool {
    match (a.parse::<u128>(), b.parse::<u128>()) {
        (Ok(a), Ok(b)) => a <= b,
        _ => a == b,
    }
}
pub(crate) fn media_type(filename: &str) -> (&'static str, u32) {
    let ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => ("image/png", 1),
        "webp" => ("image/webp", 1),
        "gif" => ("image/gif", 1),
        "jpg" | "jpeg" => ("image/jpeg", 1),
        "avif" => ("image/avif", 1),
        "bmp" => ("image/bmp", 1),
        "mp4" => ("video/mp4", 2),
        "m4v" => ("video/x-m4v", 2),
        "webm" => ("video/webm", 2),
        "mov" => ("video/quicktime", 2),
        "mp3" => ("audio/mpeg", 3),
        "ogg" => ("audio/ogg", 3),
        "wav" => ("audio/wav", 3),
        "m4a" => ("audio/mp4", 3),
        "flac" => ("audio/flac", 3),
        "pdf" => ("application/pdf", 14),
        "zip" => ("application/zip", 14),
        "txt" => ("text/plain", 14),
        "doc" => ("application/msword", 14),
        "docx" => ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", 14),
        "xls" => ("application/vnd.ms-excel", 14),
        "xlsx" => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 14),
        _ => ("application/octet-stream", 14),
    }
}
pub(crate) fn is_safe_external_uri(uri: &str) -> bool {
    ["https://", "http://", "line:", "mailto:", "tel:"]
        .iter()
        .any(|prefix| uri.to_ascii_lowercase().starts_with(prefix))
}
pub(crate) fn open_safe_uri(state: &Rc<RefCell<State>>, uri: &str) {
    if !is_safe_external_uri(uri) {
        state.borrow().set_status("ลิงก์ใน Flex/Rich Message ไม่ปลอดภัยหรือไม่รองรับ");
        return;
    }
    if let Err(error) = gtk::gio::AppInfo::launch_default_for_uri(uri, gtk::gio::AppLaunchContext::NONE) {
        state.borrow().set_status(&format!("เปิดลิงก์ไม่ได้: {error}"));
    }
}
pub(crate) fn is_arranged_sticker_url(url: &str) -> bool {
    url.contains("/sticker/651698630/")
}
pub(crate) fn sticker_candidate_urls(url: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |value: String| {
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    };
    push(url.to_owned());
    let platforms = ["/android/", "/ANDROID/", "/iPhone/"];
    let mut base = None;
    for platform in platforms {
        if let Some(index) = url.find(platform) {
            base = Some(url[..index].to_owned());
            break;
        }
    }
    if let Some(base) = base {
        let animated = url.contains("sticker_animation") || url.contains("@2x.png");
        if animated {
            push(format!("{base}/android/sticker_animation.png"));
            push(format!("{base}/ANDROID/sticker_animation.png"));
            push(format!("{base}/iPhone/sticker@2x.png"));
            push(format!("{base}/android/sticker.png"));
        } else {
            push(format!("{base}/android/sticker.png"));
            push(format!("{base}/ANDROID/sticker.png"));
            push(format!("{base}/iPhone/sticker@2x.png"));
            push(format!("{base}/android/sticker_animation.png"));
        }
    }
    out
}
pub(crate) fn pixbuf_from_data_url(data_url: &str, max_width: i32, max_height: i32) -> Option<gdk_pixbuf::Pixbuf> {
    let (_, encoded) = data_url.split_once(',')?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()).ok()?;
    let loader = PixbufLoader::new();
    loader.write(&bytes).ok()?;
    loader.close().ok()?;
    let pixbuf = loader.pixbuf()?;
    let (width, height) = (pixbuf.width(), pixbuf.height());
    let scale = (max_width as f64 / width.max(1) as f64).min(max_height as f64 / height.max(1) as f64).min(1.0);
    if scale < 1.0 {
        pixbuf.scale_simple((width as f64 * scale) as i32, (height as f64 * scale) as i32, InterpType::Bilinear)
    } else {
        Some(pixbuf)
    }
}
pub(crate) fn picture_from_data_url(data_url: &str, max_width: i32, max_height: i32) -> Option<gtk::Picture> {
    let pixbuf = pixbuf_from_data_url(data_url, max_width, max_height)?;
    let picture = gtk::Picture::for_pixbuf(&pixbuf);
    picture.set_can_shrink(true);
    Some(picture)
}
pub(crate) fn icon_button(icon: &str, tooltip: &str) -> gtk::Button {
    let image = gtk::Image::from_icon_name(icon);
    image.set_pixel_size(17);
    let button = gtk::Button::builder().child(&image).css_classes(["icon-button"]).build();
    button.set_tooltip_text(Some(tooltip));
    button
}
pub(crate) fn small_button(label: &str) -> gtk::Button {
    gtk::Button::builder().label(label).css_classes(["small-action"]).build()
}
pub(crate) fn clear_list(list: &gtk::ListBox) {
    while let Some(child) = list.first_child() {
        list.remove(&child);
    }
}
pub(crate) fn reaction_icon(value: u32) -> &'static str {
    match value {
        2 => "♥",
        3 => "♥",
        4 => "☺",
        5 => "★",
        6 => "☹",
        7 => "!",
        _ => "♡",
    }
}
pub(crate) fn logo_widget(size: i32) -> gtk::Image {
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
pub(crate) fn avatar_widget(state: &Rc<RefCell<State>>, name: &str, url: &str, size: i32) -> gtk::Overlay {
    use crate::state::Pending;
    use serde_json::json;
    use std::time::Duration;
    let overlay = gtk::Overlay::new();
    overlay.set_size_request(size, size);
    overlay.add_css_class("avatar");
    let fallback = gtk::Label::builder()
        .label(name.chars().take(2).collect::<String>().to_uppercase())
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .build();
    overlay.set_child(Some(&fallback));
    if !url.is_empty() {
        let image = gtk::Image::new();
        image.set_pixel_size(size);
        overlay.add_overlay(&image);
        let cached = { state.borrow().asset_cache.get(url).cloned() };
        if let Some(data) = cached {
            if let Some(pixbuf) = pixbuf_from_data_url(&data, size, size) {
                image.set_from_pixbuf(Some(&pixbuf));
            }
        } else {
            state.borrow_mut().request_timeout(
                "asset.preview",
                json!({ "url": url }),
                Pending::AssetImage { image, url: url.to_owned(), size, guard_chat_id: String::new() },
                Duration::from_secs(30),
            );
        }
    }
    overlay
}
pub(crate) fn composer_text(view: &gtk::TextView) -> String {
    let buffer = view.buffer();
    buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string()
}
pub(crate) fn flex_spacing(value: Option<&str>) -> i32 {
    match value.unwrap_or("").to_ascii_lowercase().as_str() {
        "none" => 0,
        "xs" => 4,
        "sm" => 6,
        "md" => 8,
        "lg" => 12,
        "xl" => 16,
        "xxl" => 20,
        _ => 8,
    }
}
