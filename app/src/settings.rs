use serde::{Deserialize, Serialize};
use std::{env, fs, io::Write, os::unix::fs::PermissionsExt, path::PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct AppSettings {
    pub startup: bool,
    pub tray: bool,
    pub desktop_notifications: bool,
    pub notification_preview: bool,
    pub notification_sound: bool,
    pub openchat: bool,
    pub auto_media: bool,
    pub theme: String,
    pub density: String,
    pub radius: String,
    pub local_pins: std::collections::HashMap<String, i64>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            startup: false,
            tray: false,
            desktop_notifications: true,
            notification_preview: true,
            notification_sound: true,
            openchat: true,
            auto_media: true,
            theme: "dark".into(),
            density: "comfortable".into(),
            radius: "round".into(),
            local_pins: std::collections::HashMap::new(),
        }
    }
}

fn config_dir() -> PathBuf {
    if let Some(path) = env::var_os("XDG_CONFIG_HOME") { return PathBuf::from(path).join("liney"); }
    env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")).join(".config/liney")
}

pub fn load() -> AppSettings {
    let path = config_dir().join("settings.json");
    fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

pub fn save(settings: &AppSettings) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    let path = dir.join("settings.json");
    let tmp = dir.join("settings.json.tmp");
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    fs::rename(tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn apply_autostart(enabled: bool) -> Result<(), String> {
    let home = env::var_os("HOME").map(PathBuf::from).ok_or("ไม่พบ HOME")?;
    let dir = home.join(".config/autostart");
    let path = dir.join("liney.desktop");
    if !enabled {
        if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
        return Ok(());
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    let content = format!("[Desktop Entry]\nType=Application\nName=Liney\nExec={}\nIcon=liney\nTerminal=false\nX-GNOME-Autostart-enabled=true\n", exe.display());
    fs::write(path, content).map_err(|e| e.to_string())
}
