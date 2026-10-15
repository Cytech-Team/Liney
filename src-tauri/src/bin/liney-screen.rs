#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(target_os = "linux", feature = "screen-sidecar"))]
#[path = "../screen_helper.rs"]
mod screen_helper;

fn main() {
    #[cfg(all(target_os = "linux", feature = "screen-sidecar"))]
    {
        match screen_helper::maybe_run_from_args() {
            Ok(true) => return,
            Ok(false) => {
                eprintln!("Liney screen helper: missing or unknown mode");
                std::process::exit(2);
            }
            Err(error) => {
                eprintln!("Liney screen helper error: {error}");
                std::process::exit(2);
            }
        }
    }

    #[cfg(not(all(target_os = "linux", feature = "screen-sidecar")))]
    {
        eprintln!("Liney screen helper is unavailable on this platform");
        std::process::exit(2);
    }
}
