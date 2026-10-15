use openh264::encoder::{Encoder, EncoderConfig, RateControlMode};
use openh264::formats::YUVSource;
use openh264::OpenH264API;
use std::io::{self, Write};
use std::sync::mpsc::{sync_channel, SyncSender};
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

#[derive(Clone, Copy, Debug)]
enum ScreenPixelFormat {
    I420,
    Nv12,
    Yuy2,
    Rgb,
    Bgr,
    Rgbx,
    Bgrx,
    Xrgb,
    Xbgr,
    Rgba,
    Bgra,
    Argb,
    Abgr,
}

#[derive(Debug)]
struct ScreenPlane {
    bytes: Vec<u8>,
    stride: usize,
}

#[derive(Debug)]
struct CapturedScreenFrame {
    format: ScreenPixelFormat,
    width: usize,
    height: usize,
    planes: Vec<ScreenPlane>,
}

fn screen_format_from_spa(format: pipewire::spa::param::video::VideoFormat) -> Option<ScreenPixelFormat> {
    use pipewire::spa::param::video::VideoFormat as F;
    if format == F::I420 {
        Some(ScreenPixelFormat::I420)
    } else if format == F::NV12 {
        Some(ScreenPixelFormat::Nv12)
    } else if format == F::YUY2 {
        Some(ScreenPixelFormat::Yuy2)
    } else if format == F::RGB {
        Some(ScreenPixelFormat::Rgb)
    } else if format == F::BGR {
        Some(ScreenPixelFormat::Bgr)
    } else if format == F::RGBx {
        Some(ScreenPixelFormat::Rgbx)
    } else if format == F::BGRx {
        Some(ScreenPixelFormat::Bgrx)
    } else if format == F::xRGB {
        Some(ScreenPixelFormat::Xrgb)
    } else if format == F::xBGR {
        Some(ScreenPixelFormat::Xbgr)
    } else if format == F::RGBA {
        Some(ScreenPixelFormat::Rgba)
    } else if format == F::BGRA {
        Some(ScreenPixelFormat::Bgra)
    } else if format == F::ARGB {
        Some(ScreenPixelFormat::Argb)
    } else if format == F::ABGR {
        Some(ScreenPixelFormat::Abgr)
    } else {
        None
    }
}

fn packed_screen_stride(format: ScreenPixelFormat, width: usize) -> usize {
    match format {
        ScreenPixelFormat::Rgb | ScreenPixelFormat::Bgr => width * 3,
        ScreenPixelFormat::Yuy2 => width * 2,
        ScreenPixelFormat::Rgbx
        | ScreenPixelFormat::Bgrx
        | ScreenPixelFormat::Xrgb
        | ScreenPixelFormat::Xbgr
        | ScreenPixelFormat::Rgba
        | ScreenPixelFormat::Bgra
        | ScreenPixelFormat::Argb
        | ScreenPixelFormat::Abgr => width * 4,
        ScreenPixelFormat::I420 | ScreenPixelFormat::Nv12 => width,
    }
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

fn plane_byte(plane: &ScreenPlane, row: usize, col: usize) -> Option<u8> {
    plane.bytes.get(row.checked_mul(plane.stride)?.checked_add(col)?).copied()
}

fn sample_screen_yuv(frame: &CapturedScreenFrame, x: usize, y: usize) -> Option<(u8, u8, u8)> {
    let x = x.min(frame.width.saturating_sub(1));
    let y = y.min(frame.height.saturating_sub(1));
    let p0 = frame.planes.get(0)?;

    match frame.format {
        ScreenPixelFormat::I420 => {
            let y_value = plane_byte(p0, y, x)?;
            if frame.planes.len() >= 3 {
                let u = plane_byte(frame.planes.get(1)?, y / 2, x / 2)?;
                let v = plane_byte(frame.planes.get(2)?, y / 2, x / 2)?;
                return Some((y_value, u, v));
            }
            let y_size = p0.stride.checked_mul(frame.height)?;
            let uv_stride = (p0.stride / 2).max(1);
            let uv_height = (frame.height + 1) / 2;
            let uv_size = uv_stride.checked_mul(uv_height)?;
            let u_index = y_size
                .checked_add((y / 2).checked_mul(uv_stride)?)?
                .checked_add(x / 2)?;
            let v_index = y_size
                .checked_add(uv_size)?
                .checked_add((y / 2).checked_mul(uv_stride)?)?
                .checked_add(x / 2)?;
            Some((
                y_value,
                *p0.bytes.get(u_index)?,
                *p0.bytes.get(v_index)?,
            ))
        }
        ScreenPixelFormat::Nv12 => {
            let y_value = plane_byte(p0, y, x)?;
            if frame.planes.len() >= 2 {
                let chroma = frame.planes.get(1)?;
                let base = (x / 2) * 2;
                return Some((
                    y_value,
                    plane_byte(chroma, y / 2, base)?,
                    plane_byte(chroma, y / 2, base + 1)?,
                ));
            }
            let y_size = p0.stride.checked_mul(frame.height)?;
            let uv_row = (y / 2).checked_mul(p0.stride)?;
            let uv_col = (x / 2) * 2;
            Some((
                y_value,
                *p0.bytes.get(y_size.checked_add(uv_row)?.checked_add(uv_col)?)?,
                *p0.bytes.get(y_size.checked_add(uv_row)?.checked_add(uv_col + 1)?)?,
            ))
        }
        ScreenPixelFormat::Yuy2 => {
            let pair = (x / 2) * 4;
            let y_col = pair + if x % 2 == 0 { 0 } else { 2 };
            Some((
                plane_byte(p0, y, y_col)?,
                plane_byte(p0, y, pair + 1)?,
                plane_byte(p0, y, pair + 3)?,
            ))
        }
        packed => {
            let (bytes_per_pixel, order): (usize, &[usize; 3]) = match packed {
                ScreenPixelFormat::Rgb => (3, &[0, 1, 2]),
                ScreenPixelFormat::Bgr => (3, &[2, 1, 0]),
                ScreenPixelFormat::Rgbx | ScreenPixelFormat::Rgba => (4, &[0, 1, 2]),
                ScreenPixelFormat::Bgrx | ScreenPixelFormat::Bgra => (4, &[2, 1, 0]),
                ScreenPixelFormat::Xrgb | ScreenPixelFormat::Argb => (4, &[1, 2, 3]),
                ScreenPixelFormat::Xbgr | ScreenPixelFormat::Abgr => (4, &[3, 2, 1]),
                _ => return None,
            };
            let base = x.checked_mul(bytes_per_pixel)?;
            let r = plane_byte(p0, y, base + order[0])?;
            let g = plane_byte(p0, y, base + order[1])?;
            let b = plane_byte(p0, y, base + order[2])?;
            Some(rgb_to_yuv(r, g, b))
        }
    }
}

fn screen_output_size(width: usize, height: usize) -> (usize, usize) {
    if width == 0 || height == 0 {
        return (0, 0);
    }
    let scale = (1280.0_f64 / width as f64)
        .min(720.0_f64 / height as f64)
        .min(1.0);
    let mut out_w = ((width as f64 * scale).round() as usize).max(2);
    let mut out_h = ((height as f64 * scale).round() as usize).max(2);
    out_w -= out_w % 2;
    out_h -= out_h % 2;
    (out_w.max(2), out_h.max(2))
}

fn screen_frame_to_i420(frame: &CapturedScreenFrame) -> Result<I420Frame, String> {
    let (out_w, out_h) = screen_output_size(frame.width, frame.height);
    if out_w == 0 || out_h == 0 {
        return Err("screen stream returned an empty frame".into());
    }
    let mut out = I420Frame::new(out_w, out_h)?;

    for dy in 0..out_h {
        let sy = dy * frame.height / out_h;
        for dx in 0..out_w {
            let sx = dx * frame.width / out_w;
            let (y, _, _) = sample_screen_yuv(frame, sx, sy)
                .ok_or_else(|| "screen frame is shorter than negotiated format".to_string())?;
            out.y[dy * out_w + dx] = y;
        }
    }

    for dy in (0..out_h).step_by(2) {
        for dx in (0..out_w).step_by(2) {
            let mut u_sum = 0_u32;
            let mut v_sum = 0_u32;
            let mut count = 0_u32;
            for oy in 0..2 {
                for ox in 0..2 {
                    let sx = (dx + ox).min(out_w - 1) * frame.width / out_w;
                    let sy = (dy + oy).min(out_h - 1) * frame.height / out_h;
                    if let Some((_, u, v)) = sample_screen_yuv(frame, sx, sy) {
                        u_sum += u as u32;
                        v_sum += v as u32;
                        count += 1;
                    }
                }
            }
            if count == 0 {
                return Err("screen chroma data is unavailable".into());
            }
            let target = (dy / 2) * (out_w / 2) + (dx / 2);
            out.u[target] = (u_sum / count) as u8;
            out.v[target] = (v_sum / count) as u8;
        }
    }
    Ok(out)
}

fn portal_screen_share_available() -> bool {
    async_std::task::block_on(async {
        use ashpd::desktop::screencast::Screencast;
        let Ok(proxy) = Screencast::new().await else {
            return false;
        };
        proxy
            .available_source_types()
            .await
            .map(|types| {
                use ashpd::desktop::screencast::SourceType;
                types.contains(SourceType::Monitor) || types.contains(SourceType::Window)
            })
            .unwrap_or(false)
    })
}

fn run_screen_encoder_worker(
    receiver: std::sync::mpsc::Receiver<CapturedScreenFrame>,
    fps: u32,
    bitrate: u32,
) -> Result<(), String> {
    let mut encoder: Option<(usize, usize, Encoder)> = None;
    let mut last_encode: Option<Instant> = None;
    let interval = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    while let Ok(frame) = receiver.recv() {
        if let Some(last) = last_encode {
            if last.elapsed() < interval {
                continue;
            }
        }
        let i420 = screen_frame_to_i420(&frame)?;
        let width = i420.width as usize;
        let height = i420.height as usize;

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
            let created = Encoder::with_config(OpenH264API::from_source(), config)
                .map_err(|error| format!("OpenH264 screen encoder init failed: {error}"))?;
            encoder = Some((width, height, created));
            eprintln!("Liney media: screen={}x{} target={}fps {}bps", width, height, fps, bitrate);
        }

        let Some((_, _, active_encoder)) = encoder.as_mut() else {
            continue;
        };
        let bitstream = active_encoder
            .encode(&i420)
            .map_err(|error| format!("OpenH264 screen encode failed: {error}"))?;
        bitstream
            .write(&mut stdout)
            .map_err(|error| format!("cannot write screen H.264 stream: {error}"))?;
        stdout
            .flush()
            .map_err(|error| format!("cannot flush screen H.264 stream: {error}"))?;
        last_encode = Some(Instant::now());
    }
    Ok(())
}

fn run_portal_screen_share(fps: u32, bitrate: u32) -> Result<(), String> {
    use ashpd::{
        desktop::{
            screencast::{CursorMode, Screencast, SourceType},
            PersistMode,
        },
        WindowIdentifier,
    };
    use pipewire as pw;
    use pw::{properties::properties, spa};
    use spa::pod::Pod;
    use std::cell::Cell;
    use std::os::fd::OwnedFd;
    use std::rc::Rc;

    let (remote_fd, node_id): (OwnedFd, u32) = async_std::task::block_on(async {
        let proxy = Screencast::new()
            .await
            .map_err(|error| format!("screen cast portal is unavailable: {error}"))?;
        let session = proxy
            .create_session()
            .await
            .map_err(|error| format!("cannot create screen cast session: {error}"))?;

        proxy
            .select_sources(
                &session,
                CursorMode::Embedded,
                SourceType::Monitor | SourceType::Window,
                false,
                None,
                PersistMode::DoNot,
            )
            .await
            .map_err(|error| format!("cannot select screen cast sources: {error}"))?;

        let started = proxy
            .start(&session, &WindowIdentifier::default())
            .await
            .map_err(|error| format!("screen share selection failed: {error}"))?
            .response()
            .map_err(|error| format!("screen share selection cancelled: {error}"))?;
        let stream = started
            .streams()
            .first()
            .ok_or_else(|| "screen share selection returned no stream".to_string())?;
        let node_id = stream.pipe_wire_node_id();
        let remote_fd = proxy
            .open_pipe_wire_remote(&session)
            .await
            .map_err(|error| format!("cannot open screen PipeWire remote: {error}"))?;
        Ok::<_, String>((remote_fd, node_id))
    })?;

    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None)
        .map_err(|error| format!("cannot create PipeWire main loop: {error}"))?;
    let context = pw::context::ContextRc::new(&mainloop, None)
        .map_err(|error| format!("cannot create PipeWire context: {error}"))?;
    let core = context
        .connect_fd_rc(remote_fd, None)
        .map_err(|error| format!("cannot connect to portal PipeWire remote: {error}"))?;

    #[derive(Debug)]
    struct UserData {
        format: spa::param::video::VideoInfoRaw,
        pixel: Option<ScreenPixelFormat>,
        sender: SyncSender<CapturedScreenFrame>,
    }

    let (sender, receiver) = sync_channel::<CapturedScreenFrame>(2);
    let encoder_thread = std::thread::Builder::new()
        .name("liney-screen-encoder".to_string())
        .spawn(move || {
            if let Err(error) = run_screen_encoder_worker(receiver, fps, bitrate) {
                eprintln!("Liney screen encoder: {error}");
            }
        })
        .map_err(|error| error.to_string())?;

    let data = UserData {
        format: Default::default(),
        pixel: None,
        sender,
    };
    let stream = pw::stream::StreamBox::new(
        &core,
        "liney-screen-capture",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(|error| format!("cannot create PipeWire screen stream: {error}"))?;

    let streamed = Rc::new(Cell::new(false));
    let streamed_state = streamed.clone();
    let quit_loop = mainloop.clone();

    let _listener = stream
        .add_local_listener_with_user_data(data)
        .state_changed(move |_, _, _old, new| {
            if new == pw::stream::StreamState::Streaming {
                streamed_state.set(true);
                return;
            }
            if streamed_state.get()
                && matches!(new, pw::stream::StreamState::Error(_) | pw::stream::StreamState::Unconnected)
            {
                quit_loop.quit();
            }
        })
        .param_changed(|_, user_data, id, param| {
            let Some(param) = param else {
                return;
            };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(param) else {
                return;
            };
            if media_type != spa::param::format::MediaType::Video
                || media_subtype != spa::param::format::MediaSubtype::Raw
            {
                return;
            }
            if user_data.format.parse(param).is_err() {
                return;
            }
            user_data.pixel = screen_format_from_spa(user_data.format.format());
            let size = user_data.format.size();
            eprintln!(
                "Liney media: portal format={:?} {}x{}",
                user_data.pixel,
                size.width,
                size.height
            );
        })
        .process(|stream, user_data| {
            let Some(pixel) = user_data.pixel else {
                return;
            };
            let size = user_data.format.size();
            let width = size.width as usize;
            let height = size.height as usize;
            if width == 0 || height == 0 {
                return;
            }

            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }

            let mut planes = Vec::with_capacity(datas.len());
            for data in datas.iter_mut() {
                let offset = data.chunk().offset() as usize;
                let size = data.chunk().size() as usize;
                let stride = data.chunk().stride().unsigned_abs() as usize;
                let Some(mapped) = data.data() else {
                    return;
                };
                if offset >= mapped.len() {
                    return;
                }
                let end = offset.saturating_add(size).min(mapped.len());
                if end <= offset {
                    return;
                }
                planes.push(ScreenPlane {
                    bytes: mapped[offset..end].to_vec(),
                    stride: if stride > 0 {
                        stride
                    } else {
                        packed_screen_stride(pixel, width)
                    },
                });
            }

            let _ = user_data.sender.try_send(CapturedScreenFrame {
                format: pixel,
                width,
                height,
                planes,
            });
        })
        .register()
        .map_err(|error| format!("cannot register PipeWire screen listener: {error}"))?;

    let obj = spa::pod::object!(
        spa::utils::SpaTypes::ObjectParamFormat,
        spa::param::ParamType::EnumFormat,
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaType,
            Id,
            spa::param::format::MediaType::Video
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::MediaSubtype,
            Id,
            spa::param::format::MediaSubtype::Raw
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            spa::param::video::VideoFormat::BGRx,
            spa::param::video::VideoFormat::BGRx,
            spa::param::video::VideoFormat::RGBx,
            spa::param::video::VideoFormat::BGRA,
            spa::param::video::VideoFormat::RGBA,
            spa::param::video::VideoFormat::BGR,
            spa::param::video::VideoFormat::RGB,
            spa::param::video::VideoFormat::YUY2,
            spa::param::video::VideoFormat::NV12,
            spa::param::video::VideoFormat::I420
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            spa::utils::Rectangle { width: 1280, height: 720 },
            spa::utils::Rectangle { width: 1, height: 1 },
            spa::utils::Rectangle { width: 8192, height: 8192 }
        ),
        spa::pod::property!(
            spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            spa::utils::Fraction { num: fps, denom: 1 },
            spa::utils::Fraction { num: 0, denom: 1 },
            spa::utils::Fraction { num: 120, denom: 1 }
        ),
    );
    let values: Vec<u8> = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(obj),
    )
    .map_err(|error| format!("cannot serialize PipeWire screen format: {error}"))?
    .0
    .into_inner();
    let mut params = [Pod::from_bytes(&values)
        .ok_or_else(|| "cannot create PipeWire screen format pod".to_string())?];

    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .map_err(|error| format!("cannot connect PipeWire screen stream: {error}"))?;

    mainloop.run();
    drop(stream);
    drop(_listener);
    drop(core);
    drop(context);
    drop(mainloop);
    let _ = encoder_thread.join();
    Ok(())
}



pub fn maybe_run_from_args() -> Result<bool, String> {
    let mut args = std::env::args().skip(1);
    let Some(mode) = args.next() else {
        return Ok(false);
    };

    match mode.as_str() {
        "--liney-media-screen-share-probe" => {
            let available = portal_screen_share_available();
            println!("{}", serde_json::json!({ "available": available }));
            Ok(true)
        }
        "--liney-media-screen-share" => {
            run_portal_screen_share(15, 800_000)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}
