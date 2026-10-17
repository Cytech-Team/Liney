//! A Linux fallback for Tauri's D-Bus single-instance plugin.
//! The plugin already handles the common case and forwards secondary launches.
//! If a user D-Bus service cannot be registered, an independent OS flock
//! prevents a second LINEJS engine from using the same account concurrently.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, ErrorKind},
    os::{
        fd::AsRawFd,
        unix::{fs::OpenOptionsExt, net::UnixDatagram},
    },
    path::{Path, PathBuf},
    time::Duration,
};

use tauri::{AppHandle, Manager};

pub struct InstanceGuard {
    _lock: File,
    socket_path: PathBuf,
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        // Only the lock owner can reach this branch.
        let _ = fs::remove_file(&self.socket_path);
    }
}

enum LockResult {
    Acquired(File),
    Taken,
}

fn lock_at(path: &Path) -> io::Result<LockResult> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .open(path)?;
    let result = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(LockResult::Acquired(lock))
    } else {
        let error = io::Error::last_os_error();
        if error.kind() == ErrorKind::WouldBlock {
            Ok(LockResult::Taken)
        } else {
            Err(error)
        }
    }
}

fn socket_dir() -> io::Result<PathBuf> {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join(".local").join("state"))
        })
        .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "No per-user runtime directory"))?;
    let directory = runtime_dir.join("liney");
    fs::create_dir_all(&directory)?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    Ok(directory)
}

pub fn acquire(app: &AppHandle) -> io::Result<InstanceGuard> {
    let directory = socket_dir()?;
    let socket_path = directory.join("single-instance.sock");

    let lock = match lock_at(&directory.join("single-instance.lock"))? {
        LockResult::Acquired(file) => file,
        LockResult::Taken => {
            // D-Bus may be unavailable; wake the existing UI through a private
            // Unix datagram socket rather than launching a second engine.
            if let Ok(sender) = UnixDatagram::unbound() {
                let _ = sender.send_to(b"focus", &socket_path);
            }
            std::process::exit(0);
        }
    };

    // A process killed with SIGKILL cannot remove the socket. Since the lock
    // belongs to this process now, no other live Liney instance owns it.
    if socket_path.exists() {
        fs::remove_file(&socket_path)?;
    }
    let listener = UnixDatagram::bind(&socket_path)?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))?;
    listener.set_read_timeout(Some(Duration::from_secs(1)))?;

    let handle = app.clone();
    std::thread::Builder::new()
        .name("liney-instance-focus".into())
        .spawn(move || {
            let mut buf = [0_u8; 32];
            loop {
                match listener.recv(&mut buf) {
                    Ok(size) if &buf[..size] == b"focus" => {
                        let foreground = handle.clone();
                        let _ = handle.run_on_main_thread(move || {
                            if let Some(window) = foreground.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        });
                    }
                    Ok(_) => {}
                    Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                    Err(_) => break,
                }
            }
        })?;

    Ok(InstanceGuard { _lock: lock, socket_path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_lock_fails_until_first_owner_exits() {
        let path = std::env::temp_dir().join(format!("liney-instance-{}-{}.lock", std::process::id(), std::thread::current().name().unwrap_or("test")));
        let first = match lock_at(&path).expect("first attempt") {
            LockResult::Acquired(lock) => lock,
            LockResult::Taken => panic!("unexpected existing lock"),
        };
        assert!(matches!(lock_at(&path).expect("second attempt"), LockResult::Taken));
        drop(first);
        assert!(matches!(lock_at(&path).expect("after release"), LockResult::Acquired(_)));
        let _ = fs::remove_file(path);
    }
}
