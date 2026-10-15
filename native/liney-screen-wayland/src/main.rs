use libwayshot::WayshotConnection;
use openh264::encoder::{Encoder, EncoderConfig, RateControlMode};
use openh264::formats::YUVSource;
use openh264::OpenH264API;
use std::io::{self, Write};
use std::time::{Duration, Instant};

struct I420Frame {
    width: i32,
    height: i32,
    y: Vec<u8>,
    u: Vec<u8>,
    v: Vec<u8>,
}

impl I420Frame {
    fn new(width: usize, height: usize) -> Result<Self, String> {
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0 {
            return Err("screen dimensions must be positive even numbers".into());
        }
        Ok(Self {
            width: width as i32,
            height: height as i32,
            y: vec![0; width * height],
            u: vec![0; width * height / 4],
            v: vec![0; width * height / 4],
        })
    }
}

impl YUVSource for I420Frame {
    fn width(&self) -> i32 { self.width }
    fn height(&self) -> i32 { self.height }
    fn y(&self) -> &[u8] { &self.y }
    fn u(&self) -> &[u8] { &self.u }
    fn v(&self) -> &[u8] { &self.v }
    fn y_stride(&self) -> i32 { self.width }
    fn u_stride(&self) -> i32 { self.width / 2 }
    fn v_stride(&self) -> i32 { self.width / 2 }
}

fn clamp_u8(value: f32) -> u8 {
    value.round().clamp(0.0, 255.0) as u8
}

fn rgb_to_yuv(r: u8, g: u8, b: u8) -> (u8, u8, u8) {
    let r = r as f32;
    let g = g as f32;
    let b = b as f32;
    (
        clamp_u8(0.257 * r + 0.504 * g + 0.098 * b + 16.0),
        clamp_u8(-0.148 * r - 0.291 * g + 0.439 * b + 128.0),
        clamp_u8(0.439 * r - 0.368 * g - 0.071 * b + 128.0),
    )
}

fn output_size(width: usize, height: usize) -> (usize, usize) {
    let scale = (1280.0_f64 / width.max(1) as f64)
        .min(720.0_f64 / height.max(1) as f64)
        .min(1.0);
    let mut out_w = ((width as f64 * scale).round() as usize).max(2);
    let mut out_h = ((height as f64 * scale).round() as usize).max(2);
    out_w -= out_w % 2;
    out_h -= out_h % 2;
    (out_w.max(2), out_h.max(2))
}

fn rgba_to_i420(data: &[u8], width: usize, height: usize) -> Result<I420Frame, String> {
    if data.len() < width.saturating_mul(height).saturating_mul(4) {
        return Err("Wayland screenshot buffer is shorter than expected".into());
    }
    let (out_w, out_h) = output_size(width, height);
    let mut out = I420Frame::new(out_w, out_h)?;

    for dy in 0..out_h {
        let sy = dy * height / out_h;
        for dx in 0..out_w {
            let sx = dx * width / out_w;
            let base = (sy * width + sx) * 4;
            let (y, _, _) = rgb_to_yuv(data[base], data[base + 1], data[base + 2]);
            out.y[dy * out_w + dx] = y;
        }
    }

    for dy in (0..out_h).step_by(2) {
        for dx in (0..out_w).step_by(2) {
            let mut u_sum = 0_u32;
            let mut v_sum = 0_u32;
            for oy in 0..2 {
                for ox in 0..2 {
                    let sx = (dx + ox).min(out_w - 1) * width / out_w;
                    let sy = (dy + oy).min(out_h - 1) * height / out_h;
                    let base = (sy * width + sx) * 4;
                    let (_, u, v) = rgb_to_yuv(data[base], data[base + 1], data[base + 2]);
                    u_sum += u as u32;
                    v_sum += v as u32;
                }
            }
            let target = (dy / 2) * (out_w / 2) + (dx / 2);
            out.u[target] = (u_sum / 4) as u8;
            out.v[target] = (v_sum / 4) as u8;
        }
    }
    Ok(out)
}

fn probe() -> serde_json::Value {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return serde_json::json!({
            "available": false,
            "backend": "wayland-direct",
            "reason": "no-wayland-display"
        });
    }

    match WayshotConnection::new() {
        Ok(connection) => {
            let (ext, wlr) = connection.globals.contents().with_list(|globals| {
                let ext = globals.iter().any(|global| global.interface == "ext_image_copy_capture_manager_v1")
                    && globals.iter().any(|global| global.interface == "ext_output_image_capture_source_manager_v1");
                let wlr = globals.iter().any(|global| global.interface == "zwlr_screencopy_manager_v1");
                (ext, wlr)
            });
            let outputs = connection.get_all_outputs().len();
            let backend = if ext {
                "wayland-ext-image-copy"
            } else if wlr {
                "wayland-wlr-screencopy"
            } else {
                "wayland-direct"
            };
            serde_json::json!({
                "available": outputs > 0 && (ext || wlr),
                "backend": backend,
                "outputs": outputs,
                "protocols": {
                    "extImageCopyCapture": ext,
                    "wlrScreencopy": wlr
                }
            })
        }
        Err(error) => serde_json::json!({
            "available": false,
            "backend": "wayland-direct",
            "reason": error.to_string()
        }),
    }
}

fn run_capture(fps: u32, bitrate: u32, force_wlr: bool) -> Result<(), String> {
    let mut connection = WayshotConnection::new()
        .map_err(|error| format!("cannot connect direct Wayland capture: {error}"))?;
    let (ext, wlr) = connection.globals.contents().with_list(|globals| {
        (
            globals.iter().any(|global| global.interface == "ext_image_copy_capture_manager_v1")
                && globals.iter().any(|global| global.interface == "ext_output_image_capture_source_manager_v1"),
            globals.iter().any(|global| global.interface == "zwlr_screencopy_manager_v1"),
        )
    });
    if !ext && !wlr {
        return Err("compositor exposes neither ext-image-copy-capture nor wlr-screencopy".into());
    }
    if connection.get_all_outputs().is_empty() {
        return Err("Wayland compositor exposes no capturable outputs".into());
    }

    if force_wlr && !wlr {
        return Err("wlr-screencopy was requested but the compositor does not expose it".into());
    }
    if force_wlr && !connection.force_wlr_screencopy(true) {
        return Err("cannot force wlr-screencopy on this compositor".into());
    }

    let mut backend = if force_wlr || !ext {
        "wayland-wlr-screencopy"
    } else {
        "wayland-ext-image-copy"
    };
    let mut wlr_fallback_used = force_wlr;
    eprintln!("Liney screen: backend={backend}");

    let frame_interval = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
    let mut encoder: Option<(usize, usize, Encoder)> = None;
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    loop {
        let started = Instant::now();
        let image = match connection.screenshot_all(true) {
            Ok(image) => image,
            Err(error) if ext && wlr && !wlr_fallback_used => {
                if !connection.force_wlr_screencopy(true) {
                    return Err(format!("{backend} capture failed and wlr-screencopy fallback is unavailable: {error}"));
                }
                wlr_fallback_used = true;
                backend = "wayland-wlr-screencopy";
                eprintln!("Liney screen: ext-image-copy failed ({error}); fallback={backend}");
                continue;
            }
            Err(error) => return Err(format!("{backend} capture failed: {error}")),
        };
        let rgba = image.to_rgba8();
        let source_width = rgba.width() as usize;
        let source_height = rgba.height() as usize;
        let frame = rgba_to_i420(rgba.as_raw(), source_width, source_height)?;
        let width = frame.width as usize;
        let height = frame.height as usize;

        let recreate = encoder
            .as_ref()
            .map(|(w, h, _)| *w != width || *h != height)
            .unwrap_or(true);
        if recreate {
            let config = EncoderConfig::new(width as u32, height as u32)
                .set_bitrate_bps(bitrate)
                .max_frame_rate(fps as f32)
                .rate_control_mode(RateControlMode::Bitrate)
                .enable_skip_frame(true);
            encoder = Some((
                width,
                height,
                Encoder::with_config(OpenH264API::from_source(), config)
                    .map_err(|error| format!("OpenH264 direct Wayland init failed: {error}"))?,
            ));
            eprintln!("Liney screen: direct-wayland={}x{} target={}fps {}bps", width, height, fps, bitrate);
        }

        let Some((_, _, active_encoder)) = encoder.as_mut() else { continue };
        let bitstream = active_encoder
            .encode(&frame)
            .map_err(|error| format!("OpenH264 direct Wayland encode failed: {error}"))?;
        bitstream
            .write(&mut stdout)
            .map_err(|error| format!("cannot write direct Wayland H.264 stream: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("cannot flush direct Wayland H.264 stream: {error}"))?;

        if let Some(remaining) = frame_interval.checked_sub(started.elapsed()) {
            std::thread::sleep(remaining);
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(mode) = args.next() else {
        eprintln!("Liney Wayland screen helper: missing mode");
        std::process::exit(2);
    };

    let result = match mode.as_str() {
        "--probe" => {
            println!("{}", probe());
            Ok(())
        }
        "--capture" => run_capture(15, 800_000, false),
        "--capture-wlr" => run_capture(15, 800_000, true),
        _ => Err(format!("unknown Liney Wayland screen mode: {mode}")),
    };

    if let Err(error) = result {
        eprintln!("Liney Wayland screen helper error: {error}");
        std::process::exit(2);
    }
}
