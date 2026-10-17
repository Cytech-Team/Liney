#[cfg(target_os = "linux")]
mod instance_guard;
mod notification_avatar;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::{collections::HashMap, fs, path::PathBuf};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct ViewerImages(Mutex<HashMap<String, PathBuf>>);

#[derive(Default)]
struct CallToneState(Mutex<Option<std::process::Child>>);

#[derive(serde::Serialize)]
struct ViewerImagePath {
    path: String,
}

#[derive(serde::Serialize)]
struct ClipboardImage {
    base64: String,
    mime: String,
    filename: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationTarget {
    chat_id: String,
    message_id: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CallNotificationTarget {
    peer: String,
    call_id: String,
}

const MAX_CLIPBOARD_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_VIEWER_IMAGE_BYTES: usize = 25 * 1024 * 1024;

fn valid_viewer_image_id(value: &str) -> bool {
    (1..=80).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

#[tauri::command]
fn stage_image_viewer(
    app: tauri::AppHandle,
    images: tauri::State<'_, ViewerImages>,
    image_id: String,
    data_url: String,
) -> Result<(), String> {
    use base64::Engine;
    use std::io::Write;

    if !valid_viewer_image_id(&image_id) {
        return Err("รหัสหน้าต่างดูรูปไม่ถูกต้อง".into());
    }
    let (header, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "รูปภาพไม่อยู่ในรูปแบบที่รองรับ".to_string())?;
    let extension = match header {
        "data:image/jpeg;base64" => "jpg",
        "data:image/png;base64" => "png",
        "data:image/webp;base64" => "webp",
        "data:image/gif;base64" => "gif",
        _ => return Err("รองรับเฉพาะ JPEG, PNG, WebP และ GIF".into()),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "ข้อมูลรูปภาพไม่ถูกต้อง".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_VIEWER_IMAGE_BYTES {
        return Err("รูปภาพต้องมีขนาดไม่เกิน 25 MB".into());
    }
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("image-viewer");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let path = directory.join(format!("{image_id}.{extension}"));
    let mut file = fs::File::create(&path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    images
        .0
        .lock()
        .map_err(|_| "คลังรูปภาพถูกล็อก".to_string())?
        .insert(image_id, path);
    Ok(())
}

#[tauri::command]
fn viewer_image_path(
    images: tauri::State<'_, ViewerImages>,
    image_id: String,
) -> Result<ViewerImagePath, String> {
    let images = images.0.lock().map_err(|_| "คลังรูปภาพถูกล็อก".to_string())?;
    let path = images
        .get(&image_id)
        .ok_or_else(|| "ไม่พบรูปภาพนี้แล้ว".to_string())?;
    Ok(ViewerImagePath {
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn release_viewer_image(
    images: tauri::State<'_, ViewerImages>,
    image_id: String,
) -> Result<(), String> {
    let path = images
        .0
        .lock()
        .map_err(|_| "คลังรูปภาพถูกล็อก".to_string())?
        .remove(&image_id);
    if let Some(path) = path {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn notify_message(
    app: tauri::AppHandle,
    title: String,
    body: String,
    chat_id: String,
    message_id: String,
    sound: bool,
    avatar_key: Option<String>,
) -> Result<(), String> {
    if title.is_empty()
        || title.len() > 512
        || body.len() > 4_096
        || chat_id.is_empty()
        || message_id.is_empty()
    {
        return Err("ข้อมูล notification ไม่ถูกต้อง".into());
    }

    #[cfg(target_os = "linux")]
    {
        let target = NotificationTarget {
            chat_id,
            message_id,
        };
        std::thread::Builder::new()
            .name("liney-notification-action".to_string())
            .spawn(move || {
                let mut notification = notify_rust::Notification::new();
                notification
                    .summary(&title)
                    .body(&body)
                    .appname("Liney")
                    // Auto-dismiss so toasts don't stack forever; a short enough
                    // window to read but long enough to be clickable. Once the
                    // toast closes, __closed ends the wait and frees the thread.
                    .timeout(notify_rust::Timeout::Milliseconds(8_000))
                    .action("default", "เปิดใน Liney");
                // Use a dedicated round app icon on the LEFT, separate from
                // the sender/group artwork shown as the content image on the RIGHT.
                // Resolve through Tauri resources so AppImage, deb/rpm and native
                // builds can all use the same image without an icon-theme install.
                let round_icon = app
                    .path()
                    .resolve("branding/liney-notification.png", tauri::path::BaseDirectory::Resource)
                    .ok()
                    .filter(|path| path.is_file());
                if let Some(icon) = round_icon {
                    notification.icon(icon.to_string_lossy().as_ref());
                } else {
                    notification.icon("liney");
                }
                if let Some(ref key) = avatar_key {
                    if let Some(path) = notification_avatar::cached_avatar_path(&app, key) {
                        notification.image_path(path.to_string_lossy().as_ref());
                    }
                }
                if sound {
                    notification.sound_name("message-new-instant");
                }
                // The thread sleeps inside wait_for_action until the toast is
                // clicked or expires; app_for_thread keeps the D-Bus connection
                // alive so a click can still reach the window on the KDE daemon.
                let app_for_thread = app.clone();
                let Ok(handle) = notification.show() else {
                    return;
                };
                handle.wait_for_action(move |action| {
                    if action == "__closed" {
                        return;
                    }
                    // Deliver the chat target application-wide first. The main
                    // window can have a different label in future builds, but
                    // a notification action must never be discarded for that.
                    let _ = app_for_thread.emit("liney://notification-open", target.clone());
                    eprintln!("Liney notification action={action} chat={}", target.chat_id);
                    if let Some(window) = app_for_thread.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            })
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, title, body, chat_id, message_id, sound, avatar_key);
        Err("notification action ยังไม่รองรับบนระบบนี้".into())
    }
}

#[tauri::command]
fn notify_call(
    app: tauri::AppHandle,
    title: String,
    body: String,
    peer: String,
    call_id: String,
) -> Result<(), String> {
    if title.is_empty()
        || title.len() > 512
        || body.len() > 4_096
        || peer.is_empty()
        || call_id.is_empty()
    {
        return Err("ข้อมูล notification สายโทรไม่ถูกต้อง".into());
    }

    #[cfg(target_os = "linux")]
    {
        let target = CallNotificationTarget { peer, call_id };
        std::thread::Builder::new()
            .name("liney-call-notification-action".to_string())
            .spawn(move || {
                let mut notification = notify_rust::Notification::new();
                notification
                    .summary(&title)
                    .body(&body)
                    .appname("Liney")
                    .timeout(notify_rust::Timeout::Milliseconds(30_000))
                    .action("default", "เปิด Liney");
                let app_for_thread = app.clone();
                let Ok(handle) = notification.show() else {
                    return;
                };
                handle.wait_for_action(move |action| {
                    if action == "__closed" {
                        return;
                    }
                    let _ = app_for_thread.emit(
                        "liney://call-notification-open",
                        target.clone(),
                    );
                    if let Some(window) = app_for_thread.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                });
            })
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, title, body, peer, call_id);
        Err("call notification ยังไม่รองรับบนระบบนี้".into())
    }
}

#[tauri::command]
async fn read_clipboard_image(app: tauri::AppHandle) -> Result<Option<ClipboardImage>, String> {
    #[cfg(target_os = "linux")]
    {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            let _ = sender.send(read_linux_clipboard_image());
        })
        .map_err(|error| format!("ไม่สามารถอ่าน clipboard ของระบบได้: {error}"))?;

        return tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv_timeout(std::time::Duration::from_secs(2))
                .map_err(|error| format!("อ่าน clipboard ไม่เสร็จภายในเวลาที่กำหนด: {error}"))?
        })
        .await
        .map_err(|error| format!("งานอ่าน clipboard ล้มเหลว: {error}"))?;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(None)
    }
}

#[cfg(target_os = "linux")]
fn read_linux_clipboard_image() -> Result<Option<ClipboardImage>, String> {
    use base64::Engine;
    use gtk::{gdk, Clipboard};

    if !gtk::is_initialized() {
        gtk::init().map_err(|error| format!("เริ่ม GTK clipboard ไม่สำเร็จ: {error}"))?;
    }

    let clipboard = Clipboard::get(&gdk::SELECTION_CLIPBOARD);
    let Some(pixbuf) = clipboard.wait_for_image() else {
        return Ok(None);
    };
    let bytes = pixbuf
        .save_to_bufferv("png", &[])
        .map_err(|error| format!("แปลงรูปจาก clipboard ไม่สำเร็จ: {error}"))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("รูปจาก clipboard ใหญ่เกิน 25 MB".to_string());
    }

    Ok(Some(ClipboardImage {
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime: "image/png".to_string(),
        filename: "pasted-image.png".to_string(),
    }))
}

#[derive(Clone)]
struct WindowPolicy(Arc<AtomicBool>);

#[cfg(target_os = "linux")]
fn resolve_liney_audio_sidecar() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("LINEY_AUDIO_BINARY") {
        candidates.push(PathBuf::from(explicit));
    }
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            candidates.push(dir.join("liney-audio"));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/lib/liney/liney-audio"));
    }
    if let Some(triple) = option_env!("TAURI_ENV_TARGET_TRIPLE") {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!("liney-audio-{triple}")),
        );
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/release/liney-audio"),
    );

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
}


#[tauri::command]
fn start_call_tone(
    mode: String,
    state: tauri::State<'_, CallToneState>,
) -> Result<(), String> {
    if mode != "incoming" && mode != "outgoing" {
        return Err("call tone mode must be incoming or outgoing".into());
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::{Command, Stdio};

        let binary = resolve_liney_audio_sidecar()
            .ok_or_else(|| "Liney audio sidecar is unavailable".to_string())?;
        let mut slot = state.0.lock().map_err(|_| "call tone state is locked".to_string())?;
        if let Some(mut previous) = slot.take() {
            let _ = previous.kill();
            let _ = previous.wait();
        }
        let child = Command::new(binary)
            .args(["--liney-media-call-tone", "--mode", &mode])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("cannot start Liney call tone: {error}"))?;
        *slot = Some(child);
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (mode, state);
        Err("native call tones are not supported on this platform".into())
    }
}

#[tauri::command]
fn stop_call_tone(state: tauri::State<'_, CallToneState>) {
    if let Ok(mut slot) = state.0.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    use std::fs;
    use std::path::PathBuf;

    let config_root = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .ok_or_else(|| "cannot determine the user config directory".to_string())?;
    let autostart_dir = config_root.join("autostart");
    let desktop_file = autostart_dir.join("liney.desktop");

    if enabled {
        fs::create_dir_all(&autostart_dir).map_err(|error| error.to_string())?;
        // When launched through an AppImage, current_exe() resolves to the
        // temporary /tmp/.mount_* binary. APPIMAGE names the durable launcher.
        let executable = std::env::var_os("APPIMAGE")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .map(Ok)
            .unwrap_or_else(std::env::current_exe)
            .map_err(|error| error.to_string())?;
        let escaped = executable.to_string_lossy().replace('"', "\\\"");
        let content = format!(
            "[Desktop Entry]\nType=Application\nName=Liney\nExec=\"{escaped}\"\nX-GNOME-Autostart-enabled=true\nTerminal=false\n"
        );
        fs::write(&desktop_file, content).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&desktop_file, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
    } else if desktop_file.exists() {
        fs::remove_file(&desktop_file).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_close_to_tray(enabled: bool, policy: tauri::State<'_, WindowPolicy>) {
    policy.0.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let value = url.trim();
    let allowed = ["https://", "http://", "line://", "mailto:", "tel:"];
    if value.is_empty()
        || value.len() > 2_000
        || value.chars().any(char::is_whitespace)
        || !allowed.iter().any(|prefix| value.starts_with(prefix))
    {
        return Err("URL scheme is not allowed".into());
    }
    #[cfg(target_os = "linux")]
    {
        // Ask GIO for the user's configured default handler directly. This
        // preserves desktop defaults without requiring the xdg-open CLI.
        return gtk::gio::AppInfo::launch_default_for_uri(
            value,
            None::<&gtk::gio::AppLaunchContext>,
        )
        .map_err(|error| format!("Could not open URL: {error}"));
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = value;
        Err("Opening external URLs is unsupported on this platform".into())
    }
}

#[cfg(target_os = "linux")]
fn prefer_x11_for_webkit_on_wayland() {
    // WebKitGTK can create a visible but empty Tauri window with the Wayland
    // backend on some supported desktop/library combinations. AppImage's
    // GTK hook uses the same fallback; keep direct binary and .deb launches
    // consistent when XWayland is available.
    let backend = std::env::var("GDK_BACKEND").unwrap_or_default();
    let wayland_requested = backend
        .split(',')
        .any(|candidate| candidate.trim().eq_ignore_ascii_case("wayland"))
        || (backend.is_empty() && std::env::var_os("WAYLAND_DISPLAY").is_some());
    if wayland_requested && std::env::var_os("DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    prefer_x11_for_webkit_on_wayland();

    tauri::Builder::default()
        // Keep this plugin first: two Liney instances would create two LINEJS
        // sidecars for the same account and can split push/revision delivery.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(WindowPolicy(Arc::new(AtomicBool::new(true))))
        .manage(ViewerImages::default())
        .manage(CallToneState::default())
        .invoke_handler(tauri::generate_handler![
            set_autostart,
            set_close_to_tray,
            read_clipboard_image,
            open_external_url,
            notify_message,
            notification_avatar::notification_avatar_cached,
            notification_avatar::store_notification_avatar,
            notify_call,
            start_call_tone,
            stop_call_tone,
            stage_image_viewer,
            viewer_image_path,
            release_viewer_image
        ])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            app.manage(instance_guard::acquire(app.handle())?);

            #[cfg(desktop)]
            {
                use tauri::menu::{MenuBuilder, MenuItemBuilder};
                use tauri::tray::TrayIconBuilder;
                use tauri::{Manager, WindowEvent};

                let show = MenuItemBuilder::with_id("show", "เปิด Liney").build(app)?;
                let quit = MenuItemBuilder::with_id("quit", "ออกจาก Liney").build(app)?;
                let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
                let icon = app.default_window_icon().cloned();
                let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("Liney");
                if let Some(icon) = icon {
                    tray = tray.icon(icon);
                }
                tray.on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

                if let Some(window) = app.get_webview_window("main") {
                    let window_for_close = window.clone();
                    let policy = app.state::<WindowPolicy>().inner().clone();
                    window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            if policy.0.load(Ordering::Relaxed) {
                                api.prevent_close();
                                let _ = window_for_close.hide();
                            }
                        }
                    });
                }
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
