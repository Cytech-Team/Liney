#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(target_os = "linux", feature = "audio-sidecar"))]
#[path = "../audio_helper.rs"]
mod audio_helper;

fn main() {
    #[cfg(all(target_os = "linux", feature = "audio-sidecar"))]
    {
        match audio_helper::maybe_run_from_args() {
            Ok(true) => return,
            Ok(false) => {
                eprintln!("Liney audio helper: missing or unknown mode");
                std::process::exit(2);
            }
            Err(error) => {
                eprintln!("Liney audio helper error: {error}");
                std::process::exit(2);
            }
        }
    }

    #[cfg(not(all(target_os = "linux", feature = "audio-sidecar")))]
    {
        eprintln!("Liney audio helper is unavailable on this platform");
        std::process::exit(2);
    }
}
