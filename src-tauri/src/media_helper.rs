use openh264::decoder::Decoder;
use openh264::encoder::{Encoder, EncoderConfig, RateControlMode};
use openh264::formats::YUVSource;
use openh264::OpenH264API;
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};
use v4l::buffer::Type;
use v4l::io::traits::CaptureStream;
use v4l::prelude::*;
use v4l::video::capture::Parameters;
use v4l::video::Capture;
use v4l::{Format, FourCC};

#[derive(Debug)]
struct CameraOptions {
    device: String,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    frames: Option<u64>,
}

impl Default for CameraOptions {
    fn default() -> Self {
        Self {
            device: "/dev/video0".to_string(),
            width: 640,
            height: 480,
            fps: 15,
            bitrate: 800_000,
            frames: None,
        }
    }
}

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
            return Err("camera dimensions must be positive even numbers".into());
        }
        Ok(Self {
            width: width as i32,
            height: height as i32,
            y: vec![0; width * height],
            u: vec![0; width * height / 4],
            v: vec![0; width * height / 4],
        })
    }

    fn update_from_yuyv(&mut self, src: &[u8]) -> Result<(), String> {
        let width = self.width as usize;
        let height = self.height as usize;
        let expected = width * height * 2;
        if src.len() < expected {
            return Err(format!(
                "camera frame too short: got {} bytes, expected at least {}",
                src.len(),
                expected
            ));
        }

        for row in 0..height {
            let row_src = row * width * 2;
            let row_y = row * width;
            for pair in 0..(width / 2) {
                let source = row_src + pair * 4;
                let target = row_y + pair * 2;
                self.y[target] = src[source];
                self.y[target + 1] = src[source + 2];
            }
        }

        for row in (0..height).step_by(2) {
            let row0 = row * width * 2;
            let row1 = (row + 1) * width * 2;
            let chroma_row = (row / 2) * (width / 2);
            for pair in 0..(width / 2) {
                let source0 = row0 + pair * 4;
                let source1 = row1 + pair * 4;
                let target = chroma_row + pair;
                self.u[target] =
                    ((src[source0 + 1] as u16 + src[source1 + 1] as u16 + 1) / 2) as u8;
                self.v[target] =
                    ((src[source0 + 3] as u16 + src[source1 + 3] as u16 + 1) / 2) as u8;
            }
        }

        Ok(())
    }
}

impl YUVSource for I420Frame {
    fn width(&self) -> i32 {
        self.width
    }

    fn height(&self) -> i32 {
        self.height
    }

    fn y(&self) -> &[u8] {
        &self.y
    }

    fn u(&self) -> &[u8] {
        &self.u
    }

    fn v(&self) -> &[u8] {
        &self.v
    }

    fn y_stride(&self) -> i32 {
        self.width
    }

    fn u_stride(&self) -> i32 {
        self.width / 2
    }

    fn v_stride(&self) -> i32 {
        self.width / 2
    }
}

fn parse_u32(name: &str, value: Option<String>) -> Result<u32, String> {
    value
        .ok_or_else(|| format!("{name} requires a value"))?
        .parse::<u32>()
        .map_err(|_| format!("invalid {name} value"))
}

fn parse_u64(name: &str, value: Option<String>) -> Result<u64, String> {
    value
        .ok_or_else(|| format!("{name} requires a value"))?
        .parse::<u64>()
        .map_err(|_| format!("invalid {name} value"))
}

fn parse_camera_options(args: impl Iterator<Item = String>) -> Result<CameraOptions, String> {
    let mut options = CameraOptions::default();
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--device" => {
                options.device = args
                    .next()
                    .ok_or_else(|| "--device requires a path".to_string())?;
            }
            "--width" => options.width = parse_u32("--width", args.next())?,
            "--height" => options.height = parse_u32("--height", args.next())?,
            "--fps" => options.fps = parse_u32("--fps", args.next())?,
            "--bitrate" => options.bitrate = parse_u32("--bitrate", args.next())?,
            "--frames" => options.frames = Some(parse_u64("--frames", args.next())?),
            other => return Err(format!("unknown media helper option: {other}")),
        }
    }

    if options.fps == 0 || options.fps > 120 {
        return Err("--fps must be between 1 and 120".into());
    }
    if options.bitrate < 64_000 || options.bitrate > 20_000_000 {
        return Err("--bitrate is out of range".into());
    }
    if options.width % 2 != 0 || options.height % 2 != 0 {
        return Err("camera width and height must be even".into());
    }

    Ok(options)
}

fn run_camera(options: CameraOptions) -> Result<(), String> {
    let device = Device::with_path(&options.device)
        .map_err(|error| format!("cannot open camera {}: {error}", options.device))?;

    let requested = Format::new(options.width, options.height, FourCC::new(b"YUYV"));
    let format = device
        .set_format(&requested)
        .map_err(|error| format!("cannot configure camera as YUYV: {error}"))?;
    if format.fourcc != FourCC::new(b"YUYV") {
        return Err(format!(
            "camera does not provide native YUYV (negotiated {})",
            format.fourcc
        ));
    }
    if format.width % 2 != 0 || format.height % 2 != 0 {
        return Err("camera returned unsupported odd-sized YUYV frames".into());
    }

    let capture_fps = options.fps.max(30).min(60);
    let _ = device.set_params(&Parameters::with_fps(capture_fps));

    eprintln!(
        "Liney media: camera={} format={}x{} YUYV target={}fps {}bps",
        options.device, format.width, format.height, options.fps, options.bitrate
    );

    let api = OpenH264API::from_source();
    let config = EncoderConfig::new(format.width, format.height)
        .set_bitrate_bps(options.bitrate)
        .max_frame_rate(options.fps as f32)
        .rate_control_mode(RateControlMode::Bitrate)
        .enable_skip_frame(true);
    let mut encoder =
        Encoder::with_config(api, config).map_err(|error| format!("OpenH264 init failed: {error}"))?;
    let mut i420 = I420Frame::new(format.width as usize, format.height as usize)?;

    let mut stream = MmapStream::with_buffers(&device, Type::VideoCapture, 4)
        .map_err(|error| format!("cannot start V4L2 camera stream: {error}"))?;

    let frame_interval = Duration::from_secs_f64(1.0 / options.fps as f64);
    let mut next_encode = Instant::now();
    let mut encoded_frames = 0_u64;
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    loop {
        let (frame, _) = stream
            .next()
            .map_err(|error| format!("camera capture failed: {error}"))?;
        let now = Instant::now();
        if now < next_encode {
            continue;
        }
        next_encode = now + frame_interval;

        i420.update_from_yuyv(frame)?;
        let bitstream = encoder
            .encode(&i420)
            .map_err(|error| format!("OpenH264 encode failed: {error}"))?;
        bitstream
            .write(&mut stdout)
            .map_err(|error| format!("cannot write H.264 stream: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("cannot flush H.264 stream: {error}"))?;

        encoded_frames += 1;
        if options
            .frames
            .map(|limit| encoded_frames >= limit)
            .unwrap_or(false)
        {
            break;
        }
    }

    Ok(())
}





fn liney_keyring_entry(kind: &str) -> Result<keyring::Entry, String> {
    if kind.is_empty()
        || kind.len() > 80
        || !kind
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err("invalid keyring item kind".into());
    }
    keyring::Entry::new("liney", &format!("default:{kind}"))
        .map_err(|error| format!("cannot create Secret Service entry: {error}"))
}

fn keyring_probe() -> bool {
    let Ok(entry) = liney_keyring_entry("__probe__") else {
        return false;
    };
    match entry.get_password() {
        Ok(_) | Err(keyring::Error::NoEntry) => true,
        Err(_) => false,
    }
}

fn parse_keyring_kind(mut args: impl Iterator<Item = String>) -> Result<String, String> {
    let mut kind: Option<String> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--kind" => {
                kind = Some(
                    args.next()
                        .ok_or_else(|| "--kind requires a value".to_string())?,
                );
            }
            other => return Err(format!("unknown keyring option: {other}")),
        }
    }
    let kind = kind.ok_or_else(|| "--kind is required".to_string())?;
    let _ = liney_keyring_entry(&kind)?;
    Ok(kind)
}

fn legacy_keyring_get(kind: &str) -> Result<Option<String>, String> {
    use dbus_secret_service::{EncryptionType, SecretService};

    let service = SecretService::connect(EncryptionType::Dh)
        .map_err(|error| format!("legacy Secret Service connection failed: {error}"))?;
    let result = service
        .search_items(HashMap::from([
            ("application", "liney"),
            ("account", "default"),
            ("kind", kind),
        ]))
        .map_err(|error| format!("legacy Secret Service search failed: {error}"))?;

    let item = if let Some(item) = result.unlocked.first() {
        item
    } else if let Some(item) = result.locked.first() {
        item.ensure_unlocked()
            .map_err(|error| format!("legacy Secret Service unlock failed: {error}"))?;
        item
    } else {
        return Ok(None);
    };

    let secret = item
        .get_secret()
        .map_err(|error| format!("legacy Secret Service read failed: {error}"))?;
    let value = String::from_utf8(secret)
        .map_err(|_| "legacy Secret Service value is not UTF-8".to_string())?;
    if value.is_empty() {
        return Ok(None);
    }
    Ok(Some(value))
}

fn keyring_get(kind: &str) -> Result<serde_json::Value, String> {
    let entry = liney_keyring_entry(kind)?;
    match entry.get_password() {
        Ok(value) => Ok(serde_json::json!({ "available": true, "value": value })),
        Err(keyring::Error::NoEntry) => {
            match legacy_keyring_get(kind) {
                Ok(Some(value)) => {
                    entry
                        .set_password(&value)
                        .map_err(|error| format!("Secret Service migration write failed: {error}"))?;
                    Ok(serde_json::json!({
                        "available": true,
                        "value": value,
                        "migrated": true
                    }))
                }
                Ok(None) => Ok(serde_json::json!({ "available": true, "value": null })),
                Err(_) => Ok(serde_json::json!({ "available": true, "value": null })),
            }
        }
        Err(error) => Err(format!("Secret Service read failed: {error}")),
    }
}

fn keyring_set(kind: &str) -> Result<(), String> {
    let mut value = String::new();
    io::stdin()
        .take(1024 * 1024)
        .read_to_string(&mut value)
        .map_err(|error| format!("cannot read keyring value: {error}"))?;
    if value.is_empty() {
        return Err("keyring value is empty".into());
    }
    let entry = liney_keyring_entry(kind)?;
    entry
        .set_password(&value)
        .map_err(|error| format!("Secret Service write failed: {error}"))
}


const MAX_H264_ACCESS_UNIT_BYTES: usize = 4 * 1024 * 1024;
const MAX_DECODED_DIMENSION: usize = 4096;
const MAX_DECODED_PIXELS: usize = 16_777_216;
const MAX_RENDER_DIMENSION: usize = 800;

fn run_h264_decoder() -> Result<(), String> {
    let mut decoder = Decoder::new(OpenH264API::from_source())
        .map_err(|error| format!("OpenH264 decoder init failed: {error}"))?;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();

    loop {
        let mut length = [0u8; 4];
        match input.read(&mut length[..1]) {
            Ok(0) => return Ok(()),
            Ok(_) => {}
            Err(error) => return Err(format!("cannot read H.264 frame length: {error}")),
        }
        input
            .read_exact(&mut length[1..])
            .map_err(|error| format!("incomplete H.264 frame length: {error}"))?;
        let frame_len = u32::from_le_bytes(length) as usize;
        if frame_len == 0 || frame_len > MAX_H264_ACCESS_UNIT_BYTES {
            return Err("H.264 access unit length is out of range".into());
        }

        let mut access_unit = vec![0u8; frame_len];
        input
            .read_exact(&mut access_unit)
            .map_err(|error| format!("incomplete H.264 access unit: {error}"))?;

        let png_frame = match decoder.decode(&access_unit) {
            Ok(Some(decoded)) => {
                let (width, height) = decoded.dimension_rgb();
                if width == 0
                    || height == 0
                    || width > MAX_DECODED_DIMENSION
                    || height > MAX_DECODED_DIMENSION
                    || width.saturating_mul(height) > MAX_DECODED_PIXELS
                {
                    continue;
                }

                let mut rgb = vec![0u8; width * height * 3];
                decoded.write_rgb8(&mut rgb);
                let scale = (MAX_RENDER_DIMENSION as f64 / width.max(height) as f64).min(1.0);
                let output_width = ((width as f64 * scale).round() as usize).max(1);
                let output_height = ((height as f64 * scale).round() as usize).max(1);
                let mut scaled = vec![0u8; output_width * output_height * 3];
                for y in 0..output_height {
                    let source_y = y * height / output_height;
                    for x in 0..output_width {
                        let source_x = x * width / output_width;
                        let source = (source_y * width + source_x) * 3;
                        let target = (y * output_width + x) * 3;
                        scaled[target..target + 3].copy_from_slice(&rgb[source..source + 3]);
                    }
                }

                let mut png_bytes = Vec::new();
                {
                    let mut encoder = png::Encoder::new(
                        &mut png_bytes,
                        output_width as u32,
                        output_height as u32,
                    );
                    encoder.set_color(png::ColorType::Rgb);
                    encoder.set_depth(png::BitDepth::Eight);
                    encoder.set_compression(png::Compression::Fast);
                    let mut writer = encoder
                        .write_header()
                        .map_err(|error| format!("PNG header encode failed: {error}"))?;
                    writer
                        .write_image_data(&scaled)
                        .map_err(|error| format!("PNG frame encode failed: {error}"))?;
                    writer
                        .finish()
                        .map_err(|error| format!("PNG frame finish failed: {error}"))?;
                }
                Some(png_bytes)
            }
            Ok(None) | Err(_) => None,
        };

        if let Some(png_bytes) = png_frame {
            output
                .write_all(&(png_bytes.len() as u32).to_le_bytes())
                .and_then(|_| output.write_all(&png_bytes))
                .and_then(|_| output.flush())
                .map_err(|error| format!("cannot write decoded video frame: {error}"))?;
        }
    }
}

fn keyring_clear(kind: &str) -> Result<(), String> {
    let entry = liney_keyring_entry(kind)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Secret Service clear failed: {error}")),
    }
}

pub fn maybe_run_from_args() -> Result<bool, String> {
    let mut args = std::env::args().skip(1);
    let Some(mode) = args.next() else {
        return Ok(false);
    };

    match mode.as_str() {
        "--liney-media-h264-decode" => {
            if args.next().is_some() {
                return Err("--liney-media-h264-decode takes no options".into());
            }
            run_h264_decoder()?;
            Ok(true)
        }
        "--liney-media-camera" => {
            let options = parse_camera_options(args)?;
            run_camera(options)?;
            Ok(true)
        }
        "--liney-keyring-probe" => {
            println!("{}", serde_json::json!({ "available": keyring_probe() }));
            Ok(true)
        }
        "--liney-keyring-get" => {
            let kind = parse_keyring_kind(args)?;
            println!("{}", keyring_get(&kind)?);
            Ok(true)
        }
        "--liney-keyring-set" => {
            let kind = parse_keyring_kind(args)?;
            keyring_set(&kind)?;
            println!("{}", serde_json::json!({ "stored": true }));
            Ok(true)
        }
        "--liney-keyring-clear" => {
            let kind = parse_keyring_kind(args)?;
            keyring_clear(&kind)?;
            println!("{}", serde_json::json!({ "cleared": true }));
            Ok(true)
        }
        _ => Ok(false),
    }
}
