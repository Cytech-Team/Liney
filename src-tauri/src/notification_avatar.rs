use base64::Engine;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};
use tauri::Manager;

const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;
const MAX_AVATAR_DATA_URL_LENGTH: usize = 3 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 350;

fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn extension_from_data_url(data_url: &str) -> Result<(&'static str, Vec<u8>), String> {
    if data_url.len() > MAX_AVATAR_DATA_URL_LENGTH {
        return Err("รูปโปรไฟล์สำหรับ notification ใหญ่เกินไป".into());
    }
    let (header, encoded) = data_url.split_once(',').ok_or("รูปภาพไม่ถูกต้อง")?;
    let extension = match header {
        "data:image/png;base64" => "png",
        "data:image/jpeg;base64" => "jpg",
        "data:image/webp;base64" => "webp",
        _ => return Err("รองรับรูป notification เฉพาะ PNG/JPEG/WebP".into()),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "ข้อมูลรูปไม่ใช่ Base64 ที่ถูกต้อง")?;
    if bytes.is_empty() || bytes.len() > MAX_AVATAR_BYTES {
        return Err("รูป notification ใหญ่เกิน 2 MB".into());
    }
    let valid = match extension {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if !valid {
        return Err("เนื้อหาไฟล์ไม่ตรงกับประเภทภาพ".into());
    }
    Ok((extension, bytes))
}

fn avatar_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("notification-avatars"))
}

fn cached_avatar_in(dir: &Path, key: &str) -> Option<PathBuf> {
    if !valid_key(key) {
        return None;
    }
    for ext in ["png", "jpg", "webp"] {
        let path = dir.join(format!("{key}.{ext}"));
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

pub(crate) fn cached_avatar_path(app: &tauri::AppHandle, key: &str) -> Option<PathBuf> {
    cached_avatar_in(&avatar_dir(app).ok()?, key)
}

#[tauri::command]
pub(crate) fn notification_avatar_cached(app: tauri::AppHandle, key: String) -> bool {
    cached_avatar_path(&app, &key).is_some()
}

fn prune_cache(dir: &Path) {
    let Ok(list) = fs::read_dir(dir) else {
        return;
    };
    let mut files = Vec::new();
    for entry in list.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|v| v.to_str()) else {
            continue;
        };
        if !valid_key(stem) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let time = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if time
            .elapsed()
            .is_ok_and(|elapsed| elapsed > Duration::from_secs(30 * 86_400))
        {
            let _ = fs::remove_file(path);
            continue;
        }
        files.push((time, path));
    }
    if files.len() > MAX_CACHE_FILES {
        files.sort_unstable_by_key(|(time, _)| *time);
        let excess = files.len() - MAX_CACHE_FILES;
        for (_, file) in files.into_iter().take(excess) {
            let _ = fs::remove_file(file);
        }
    }
}

#[tauri::command]
pub(crate) fn store_notification_avatar(
    app: tauri::AppHandle,
    key: String,
    data_url: String,
) -> Result<bool, String> {
    if !valid_key(&key) {
        return Err("รหัสแคชรูปไม่ถูกต้อง".into());
    }
    let (ext, bytes) = extension_from_data_url(&data_url)?;
    let dir = avatar_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let dst = dir.join(format!("{key}.{ext}"));
    // Atomic replacement avoids reading a partially downloaded avatar
    // while the native notification daemon consumes its path.
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = dir.join(format!("{key}.{}.{nonce}.tmp", std::process::id()));
    fs::write(&temp, &bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::rename(&temp, &dst) {
        let _ = fs::remove_file(&temp);
        return Err(e.to_string());
    }
    for previous in ["png", "jpg", "webp"] {
        if previous != ext {
            let _ = fs::remove_file(dir.join(format!("{key}.{previous}")));
        }
    }
    prune_cache(&dir);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn key_is_hex_only() {
        assert!(valid_key(&"a".repeat(64)));
        assert!(!valid_key("../somewhere"));
        assert!(!valid_key(&"A".repeat(64)));
    }
    #[test]
    fn image_magic_is_checked() {
        let good = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest")
        );
        assert!(extension_from_data_url(&good).is_ok());
        let bad = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b"<script>")
        );
        assert!(extension_from_data_url(&bad).is_err());
    }
}
