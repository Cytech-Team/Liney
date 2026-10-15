#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(target_os = "linux", feature = "media-sidecar"))]
#[path = "../media_helper.rs"]
mod media_helper;

fn main() {
    #[cfg(all(target_os = "linux", feature = "media-sidecar"))]
    {
        match media_helper::maybe_run_from_args() {
            Ok(true) => return,
            Ok(false) => {
                eprintln!("Liney media helper: missing or unknown mode");
                std::process::exit(2);
            }
            Err(error) => {
                eprintln!("Liney media helper error: {error}");
                std::process::exit(2);
            }
        }
    }

    #[cfg(not(all(target_os = "linux", feature = "media-sidecar")))]
    {
        eprintln!("Liney media helper is unavailable on this platform");
        std::process::exit(2);
    }
}
