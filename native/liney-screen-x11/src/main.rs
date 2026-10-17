use libc::{shmat, shmctl, shmdt, shmget, IPC_CREAT, IPC_PRIVATE, IPC_RMID};
use openh264::encoder::{Encoder, EncoderConfig, RateControlMode};
use openh264::formats::YUVSource;
use openh264::OpenH264API;
use serde::Serialize;
use std::collections::HashSet;
use std::io::{self, Write};
use std::ptr::null_mut;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::composite::{self, ConnectionExt as CompositeExt, Redirect};
use x11rb::protocol::damage::{self, ConnectionExt as DamageExt, ReportLevel};
use x11rb::protocol::randr::{self, ConnectionExt as RandrExt};
use x11rb::protocol::shm::{self, ConnectionExt as ShmExt};
use x11rb::protocol::xfixes::{self, ConnectionExt as XFixesExt};
use x11rb::protocol::xinerama::{self, ConnectionExt as XineramaExt};
use x11rb::protocol::xproto::{
    AtomEnum, ConnectionExt as XprotoExt, CreateGCAux, EventMask, Gcontext, GrabMode,
    GrabStatus, ImageFormat, ImageOrder, MapState, Rectangle, Screen, SubwindowMode,
    VisualClass, Visualid, Visualtype, Window, GX,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::{CURRENT_TIME, NONE};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
struct CaptureRect {
    x: i16,
    y: i16,
    width: u16,
    height: u16,
}

impl CaptureRect {
    fn normalized(x0: i16, y0: i16, x1: i16, y1: i16) -> Option<Self> {
        let left = i32::from(x0.min(x1));
        let top = i32::from(y0.min(y1));
        let right = i32::from(x0.max(x1));
        let bottom = i32::from(y0.max(y1));
        let width = (right - left).unsigned_abs().max(1).min(u16::MAX as u32) as u16;
        let height = (bottom - top).unsigned_abs().max(1).min(u16::MAX as u32) as u16;
        Some(Self {
            x: left.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            y: top.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            width,
            height,
        })
    }

    fn clamp_to(self, bounds: Self) -> Option<Self> {
        let left = i32::from(self.x).max(i32::from(bounds.x));
        let top = i32::from(self.y).max(i32::from(bounds.y));
        let right = (i32::from(self.x) + i32::from(self.width))
            .min(i32::from(bounds.x) + i32::from(bounds.width));
        let bottom = (i32::from(self.y) + i32::from(self.height))
            .min(i32::from(bounds.y) + i32::from(bounds.height));
        if right <= left || bottom <= top {
            return None;
        }
        Some(Self {
            x: left as i16,
            y: top as i16,
            width: (right - left) as u16,
            height: (bottom - top) as u16,
        })
    }

    fn intersection(self, other: Self) -> Option<Self> {
        let left = i32::from(self.x).max(i32::from(other.x));
        let top = i32::from(self.y).max(i32::from(other.y));
        let right = (i32::from(self.x) + i32::from(self.width))
            .min(i32::from(other.x) + i32::from(other.width));
        let bottom = (i32::from(self.y) + i32::from(self.height))
            .min(i32::from(other.y) + i32::from(other.height));
        if right <= left || bottom <= top {
            return None;
        }
        Some(Self {
            x: left as i16,
            y: top as i16,
            width: (right - left) as u16,
            height: (bottom - top) as u16,
        })
    }

    fn union(self, other: Self) -> Self {
        let left = i32::from(self.x).min(i32::from(other.x));
        let top = i32::from(self.y).min(i32::from(other.y));
        let right = (i32::from(self.x) + i32::from(self.width))
            .max(i32::from(other.x) + i32::from(other.width));
        let bottom = (i32::from(self.y) + i32::from(self.height))
            .max(i32::from(other.y) + i32::from(other.height));
        Self {
            x: left.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            y: top.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            width: (right - left).max(1).min(u16::MAX as i32) as u16,
            height: (bottom - top).max(1).min(u16::MAX as i32) as u16,
        }
    }

}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TargetRequest {
    Desktop,
    Monitor(usize),
    Window(Window),
    Region(CaptureRect),
    PickRegion,
}

fn parse_target(value: &str) -> Result<TargetRequest, String> {
    let value = value.trim();
    if value.is_empty() || value == "desktop" {
        return Ok(TargetRequest::Desktop);
    }
    if value == "region:pick" {
        return Ok(TargetRequest::PickRegion);
    }
    if let Some(raw) = value.strip_prefix("monitor:") {
        let index = raw.parse::<usize>().map_err(|_| "invalid monitor target".to_string())?;
        return Ok(TargetRequest::Monitor(index));
    }
    if let Some(raw) = value.strip_prefix("window:") {
        let raw = raw.trim();
        let id = if let Some(hex) = raw.strip_prefix("0x") {
            u32::from_str_radix(hex, 16)
        } else {
            raw.parse::<u32>()
        }
        .map_err(|_| "invalid window target".to_string())?;
        return Ok(TargetRequest::Window(id));
    }
    if let Some(raw) = value.strip_prefix("region:") {
        let parts = raw.split(',').collect::<Vec<_>>();
        if parts.len() != 4 {
            return Err("region target must be region:x,y,width,height".into());
        }
        let x = parts[0].parse::<i16>().map_err(|_| "invalid region x".to_string())?;
        let y = parts[1].parse::<i16>().map_err(|_| "invalid region y".to_string())?;
        let width = parts[2].parse::<u16>().map_err(|_| "invalid region width".to_string())?;
        let height = parts[3].parse::<u16>().map_err(|_| "invalid region height".to_string())?;
        if width == 0 || height == 0 {
            return Err("region width and height must be positive".into());
        }
        return Ok(TargetRequest::Region(CaptureRect { x, y, width, height }));
    }
    Err(format!("unknown X11 target: {value}"))
}

#[derive(Debug, Clone, Serialize)]
struct TargetInfo {
    id: String,
    kind: &'static str,
    name: String,
    x: i16,
    y: i16,
    width: u16,
    height: u16,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    primary: Option<bool>,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
struct ExtensionCaps {
    shm: bool,
    randr: bool,
    xinerama: bool,
    composite: bool,
    damage: bool,
    xfixes: bool,
}

impl ExtensionCaps {
    fn baseline_works(self) -> bool {
        true
    }
}

#[derive(Debug, Clone)]
struct PixelLayout {
    bits_per_pixel: usize,
    scanline_pad: usize,
    byte_order: ImageOrder,
    red_mask: u32,
    green_mask: u32,
    blue_mask: u32,
    true_color: bool,
}

fn packed_stride(width: usize, bits_per_pixel: usize, scanline_pad: usize) -> Option<usize> {
    let raw_bits = width.checked_mul(bits_per_pixel)?;
    let pad = scanline_pad.max(8);
    Some(raw_bits.div_ceil(pad).checked_mul(pad)?.div_ceil(8))
}

fn packed_len(width: usize, height: usize, layout: &PixelLayout) -> Option<usize> {
    packed_stride(width, layout.bits_per_pixel, layout.scanline_pad)?.checked_mul(height)
}

fn channel_from_mask(pixel: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let bits = (mask >> shift).count_ones();
    let raw = (pixel & mask) >> shift;
    if bits == 0 {
        0
    } else if bits >= 8 {
        (raw >> (bits - 8)) as u8
    } else {
        ((raw * 255) / ((1_u32 << bits) - 1)) as u8
    }
}

fn pixel_value(data: &[u8], offset: usize, bits_per_pixel: usize, order: ImageOrder) -> Option<u32> {
    let bytes = bits_per_pixel.div_ceil(8);
    if bytes == 0 || bytes > 4 || offset.checked_add(bytes)? > data.len() {
        return None;
    }
    let mut value = 0_u32;
    match order {
        ImageOrder::LSB_FIRST => {
            for index in 0..bytes {
                value |= (data[offset + index] as u32) << (8 * index);
            }
        }
        ImageOrder::MSB_FIRST => {
            for index in 0..bytes {
                value = (value << 8) | data[offset + index] as u32;
            }
        }
        _ => return None,
    }
    Some(value)
}

fn unpack_rgb(data: &[u8], x: usize, y: usize, width: usize, layout: &PixelLayout) -> Result<(u8, u8, u8), String> {
    if !layout.true_color {
        return Err("X11 visual is not TrueColor".into());
    }
    // Depth-30 TrueColor is normally transported in a 32-bpp pixmap. Actual
    // packed 30-bpp rows are not byte-addressable per pixel and are rejected.
    if !matches!(layout.bits_per_pixel, 16 | 24 | 32) {
        return Err(format!("unsupported X11 bits-per-pixel {}", layout.bits_per_pixel));
    }
    let stride = packed_stride(width, layout.bits_per_pixel, layout.scanline_pad)
        .ok_or_else(|| "X11 row-size overflow".to_string())?;
    let bytes = layout.bits_per_pixel.div_ceil(8);
    let offset = y
        .checked_mul(stride)
        .and_then(|row| row.checked_add(x.checked_mul(bytes)?))
        .ok_or_else(|| "X11 pixel-offset overflow".to_string())?;
    let pixel = pixel_value(data, offset, layout.bits_per_pixel, layout.byte_order)
        .ok_or_else(|| "X11 pixel is outside capture buffer".to_string())?;
    Ok((
        channel_from_mask(pixel, layout.red_mask),
        channel_from_mask(pixel, layout.green_mask),
        channel_from_mask(pixel, layout.blue_mask),
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CursorSnapshot {
    x: i32,
    y: i32,
    width: usize,
    height: usize,
    xhot: i32,
    yhot: i32,
    serial: u32,
    argb: Vec<u32>,
}

impl CursorSnapshot {
    fn key(&self) -> (i32, i32, u32) {
        (self.x, self.y, self.serial)
    }

    fn blend_at(&self, root_x: i32, root_y: i32, base: (u8, u8, u8)) -> (u8, u8, u8) {
        let left = self.x - self.xhot;
        let top = self.y - self.yhot;
        let cx = root_x - left;
        let cy = root_y - top;
        if cx < 0 || cy < 0 || cx >= self.width as i32 || cy >= self.height as i32 {
            return base;
        }
        let Some(pixel) = self.argb.get(cy as usize * self.width + cx as usize).copied() else {
            return base;
        };
        let a = ((pixel >> 24) & 0xff) as u32;
        if a == 0 {
            return base;
        }
        // XFixes cursor channels are premultiplied ARGB.
        let cr = ((pixel >> 16) & 0xff) as u32;
        let cg = ((pixel >> 8) & 0xff) as u32;
        let cb = (pixel & 0xff) as u32;
        let inv = 255 - a;
        (
            (cr + (u32::from(base.0) * inv + 127) / 255).min(255) as u8,
            (cg + (u32::from(base.1) * inv + 127) / 255).min(255) as u8,
            (cb + (u32::from(base.2) * inv + 127) / 255).min(255) as u8,
        )
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

fn capture_to_i420(
    data: &[u8],
    width: usize,
    height: usize,
    layout: &PixelLayout,
    origin_root: (i32, i32),
    cursor: Option<&CursorSnapshot>,
) -> Result<I420Frame, String> {
    let expected = packed_len(width, height, layout).ok_or_else(|| "X11 capture-size overflow".to_string())?;
    if data.len() < expected {
        return Err(format!("X11 capture buffer is shorter than expected: {} < {}", data.len(), expected));
    }
    let (out_w, out_h) = output_size(width, height);
    let mut out = I420Frame::new(out_w, out_h)?;

    let sample = |dx: usize, dy: usize| -> Result<(u8, u8, u8), String> {
        let sx = dx.min(out_w - 1) * width / out_w;
        let sy = dy.min(out_h - 1) * height / out_h;
        let base = unpack_rgb(data, sx, sy, width, layout)?;
        Ok(match cursor {
            Some(cursor) => cursor.blend_at(origin_root.0 + sx as i32, origin_root.1 + sy as i32, base),
            None => base,
        })
    };

    for dy in 0..out_h {
        for dx in 0..out_w {
            let (r, g, b) = sample(dx, dy)?;
            out.y[dy * out_w + dx] = rgb_to_yuv(r, g, b).0;
        }
    }

    for dy in (0..out_h).step_by(2) {
        for dx in (0..out_w).step_by(2) {
            let mut u_sum = 0_u32;
            let mut v_sum = 0_u32;
            for oy in 0..2 {
                for ox in 0..2 {
                    let (r, g, b) = sample((dx + ox).min(out_w - 1), (dy + oy).min(out_h - 1))?;
                    let (_, u, v) = rgb_to_yuv(r, g, b);
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

fn extension_disabled(env_suffix: &str) -> bool {
    std::env::var_os(format!("LINEY_X11_DISABLE_{env_suffix}"))
        .map(|value| value != "0")
        .unwrap_or(false)
}

fn extension_available<C: Connection>(conn: &C, name: &'static str, env_suffix: &str) -> bool {
    if extension_disabled(env_suffix) {
        return false;
    }
    conn.extension_information(name)
        .ok()
        .flatten()
        .is_some()
}

fn detect_extensions(conn: &RustConnection) -> ExtensionCaps {
    let shm_available = extension_available(conn, shm::X11_EXTENSION_NAME, "SHM")
        && conn.shm_query_version().ok().and_then(|c| c.reply().ok()).is_some();
    let randr_available = extension_available(conn, randr::X11_EXTENSION_NAME, "RANDR")
        && conn.randr_query_version(1, 5).ok().and_then(|c| c.reply().ok()).is_some();
    let xinerama_available = extension_available(conn, xinerama::X11_EXTENSION_NAME, "XINERAMA")
        && conn.xinerama_query_version(1, 1).ok().and_then(|c| c.reply().ok()).is_some();
    let composite_available = extension_available(conn, composite::X11_EXTENSION_NAME, "COMPOSITE")
        && conn.composite_query_version(0, 4).ok().and_then(|c| c.reply().ok()).is_some();
    let damage_available = extension_available(conn, damage::X11_EXTENSION_NAME, "DAMAGE")
        && conn.damage_query_version(1, 1).ok().and_then(|c| c.reply().ok()).is_some();
    let xfixes_available = extension_available(conn, xfixes::X11_EXTENSION_NAME, "XFIXES")
        && conn.xfixes_query_version(5, 0).ok().and_then(|c| c.reply().ok()).is_some();
    ExtensionCaps {
        shm: shm_available,
        randr: randr_available,
        xinerama: xinerama_available,
        composite: composite_available,
        damage: damage_available,
        xfixes: xfixes_available,
    }
}

fn atom(conn: &RustConnection, name: &str) -> Option<u32> {
    conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok().map(|r| r.atom)
}

fn atom_name(conn: &RustConnection, atom: u32) -> String {
    conn.get_atom_name(atom)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| String::from_utf8(r.name).ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("Monitor {atom}"))
}

fn root_bounds(screen: &Screen) -> CaptureRect {
    CaptureRect { x: 0, y: 0, width: screen.width_in_pixels, height: screen.height_in_pixels }
}

fn discover_monitors(conn: &RustConnection, screen: &Screen, caps: ExtensionCaps) -> Vec<TargetInfo> {
    let mut targets = Vec::new();
    if caps.randr {
        if let Ok(cookie) = conn.randr_get_monitors(screen.root, true) {
            if let Ok(reply) = cookie.reply() {
                for (index, monitor) in reply.monitors.into_iter().enumerate() {
                    if monitor.width == 0 || monitor.height == 0 {
                        continue;
                    }
                    targets.push(TargetInfo {
                        id: format!("monitor:{index}"),
                        kind: "monitor",
                        name: atom_name(conn, monitor.name),
                        x: monitor.x,
                        y: monitor.y,
                        width: monitor.width,
                        height: monitor.height,
                        available: true,
                        primary: Some(monitor.primary),
                    });
                }
                if !targets.is_empty() {
                    return targets;
                }
            }
        }

        // RandR < 1.5 fallback: active CRTCs.
        if let Ok(cookie) = conn.randr_get_screen_resources_current(screen.root) {
            if let Ok(resources) = cookie.reply() {
                let mut seen = HashSet::new();
                for output in resources.outputs {
                    let Ok(info_cookie) = conn.randr_get_output_info(output, resources.config_timestamp) else { continue };
                    let Ok(info) = info_cookie.reply() else { continue };
                    if info.crtc == 0 || !seen.insert(info.crtc) {
                        continue;
                    }
                    let Ok(crtc_cookie) = conn.randr_get_crtc_info(info.crtc, resources.config_timestamp) else { continue };
                    let Ok(crtc) = crtc_cookie.reply() else { continue };
                    if crtc.width == 0 || crtc.height == 0 {
                        continue;
                    }
                    let index = targets.len();
                    targets.push(TargetInfo {
                        id: format!("monitor:{index}"),
                        kind: "monitor",
                        name: String::from_utf8_lossy(&info.name).into_owned(),
                        x: crtc.x,
                        y: crtc.y,
                        width: crtc.width,
                        height: crtc.height,
                        available: true,
                        primary: None,
                    });
                }
                if !targets.is_empty() {
                    return targets;
                }
            }
        }
    }

    if caps.xinerama {
        if let Ok(cookie) = conn.xinerama_query_screens() {
            if let Ok(reply) = cookie.reply() {
                for (index, info) in reply.screen_info.into_iter().enumerate() {
                    if info.width == 0 || info.height == 0 {
                        continue;
                    }
                    targets.push(TargetInfo {
                        id: format!("monitor:{index}"),
                        kind: "monitor",
                        name: format!("Xinerama {}", index + 1),
                        x: info.x_org,
                        y: info.y_org,
                        width: info.width,
                        height: info.height,
                        available: true,
                        primary: None,
                    });
                }
            }
        }
    }
    targets
}

fn window_name(conn: &RustConnection, window: Window) -> String {
    let utf8 = atom(conn, "UTF8_STRING");
    let net_name = atom(conn, "_NET_WM_NAME");
    if let (Some(utf8), Some(net_name)) = (utf8, net_name) {
        if let Ok(cookie) = conn.get_property(false, window, net_name, utf8, 0, 1024) {
            if let Ok(reply) = cookie.reply() {
                if let Ok(name) = String::from_utf8(reply.value) {
                    if !name.trim().is_empty() {
                        return name;
                    }
                }
            }
        }
    }
    if let Ok(cookie) = conn.get_property(false, window, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 1024) {
        if let Ok(reply) = cookie.reply() {
            let name = String::from_utf8_lossy(&reply.value).into_owned();
            if !name.trim().is_empty() {
                return name;
            }
        }
    }
    format!("Window 0x{window:08x}")
}

fn client_windows(conn: &RustConnection, root: Window) -> Vec<Window> {
    for property in ["_NET_CLIENT_LIST_STACKING", "_NET_CLIENT_LIST"] {
        let Some(property) = atom(conn, property) else { continue };
        if let Ok(cookie) = conn.get_property(false, root, property, AtomEnum::WINDOW, 0, u32::MAX) {
            if let Ok(reply) = cookie.reply() {
                if let Some(iter) = reply.value32() {
                    let windows = iter.collect::<Vec<_>>();
                    if !windows.is_empty() {
                        return windows;
                    }
                }
            }
        }
    }
    conn.query_tree(root)
        .ok()
        .and_then(|c| c.reply().ok())
        .map(|r| r.children)
        .unwrap_or_default()
}

fn discover_windows(conn: &RustConnection, screen: &Screen) -> Vec<TargetInfo> {
    let mut out = Vec::new();
    for window in client_windows(conn, screen.root).into_iter().rev().take(128) {
        let Ok(geometry_cookie) = conn.get_geometry(window) else { continue };
        let Ok(geometry) = geometry_cookie.reply() else { continue };
        if geometry.width < 2 || geometry.height < 2 {
            continue;
        }
        let attrs = conn.get_window_attributes(window).ok().and_then(|c| c.reply().ok());
        let available = attrs.as_ref().map(|a| a.map_state == MapState::VIEWABLE).unwrap_or(false);
        let translated = conn.translate_coordinates(window, screen.root, 0, 0).ok().and_then(|c| c.reply().ok());
        let (x, y) = translated.map(|r| (r.dst_x, r.dst_y)).unwrap_or((geometry.x, geometry.y));
        out.push(TargetInfo {
            id: format!("window:0x{window:08x}"),
            kind: "window",
            name: window_name(conn, window),
            x,
            y,
            width: geometry.width,
            height: geometry.height,
            available,
            primary: None,
        });
    }
    out
}

fn discover_targets(conn: &RustConnection, screen: &Screen, caps: ExtensionCaps) -> Vec<TargetInfo> {
    let mut targets = vec![TargetInfo {
        id: "desktop".into(),
        kind: "desktop",
        name: "ทั้งเดสก์ท็อป".into(),
        x: 0,
        y: 0,
        width: screen.width_in_pixels,
        height: screen.height_in_pixels,
        available: true,
        primary: None,
    }];
    targets.extend(discover_monitors(conn, screen, caps));
    targets.push(TargetInfo {
        id: "region:pick".into(),
        kind: "region",
        name: "เลือกพื้นที่ด้วยเมาส์".into(),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        available: true,
        primary: None,
    });
    targets.extend(discover_windows(conn, screen));
    targets
}

fn visual_for_id<'a>(setup: &'a x11rb::protocol::xproto::Setup, visual_id: Visualid) -> Option<&'a Visualtype> {
    setup.roots
        .iter()
        .flat_map(|screen| screen.allowed_depths.iter())
        .flat_map(|depth| depth.visuals.iter())
        .find(|visual| visual.visual_id == visual_id)
}

fn layout_for(
    setup: &x11rb::protocol::xproto::Setup,
    depth: u8,
    visual_id: Visualid,
) -> Result<PixelLayout, String> {
    let visual = visual_for_id(setup, visual_id)
        .ok_or_else(|| format!("X11 visual 0x{visual_id:x} is unavailable"))?;
    let format = setup.pixmap_formats
        .iter()
        .find(|format| format.depth == depth)
        .ok_or_else(|| format!("X11 pixmap format for depth {depth} is unavailable"))?;
    Ok(PixelLayout {
        bits_per_pixel: format.bits_per_pixel as usize,
        scanline_pad: format.scanline_pad as usize,
        byte_order: setup.image_byte_order,
        red_mask: visual.red_mask,
        green_mask: visual.green_mask,
        blue_mask: visual.blue_mask,
        true_color: visual.class == VisualClass::TRUE_COLOR,
    })
}

#[derive(Debug)]
struct CaptureSource {
    drawable: u32,
    damage_drawable: u32,
    rect: CaptureRect,
    origin_root: (i32, i32),
    depth: u8,
    visual: Visualid,
    composite_pixmap: Option<u32>,
    redirected_window: Option<Window>,
}

impl CaptureSource {
    fn cleanup(&mut self, conn: &RustConnection) {
        if let Some(pixmap) = self.composite_pixmap.take() {
            let _ = conn.free_pixmap(pixmap);
        }
        if let Some(window) = self.redirected_window.take() {
            let _ = conn.composite_unredirect_window(window, Redirect::AUTOMATIC);
        }
        let _ = conn.flush();
    }
}

fn prepare_window_source(
    conn: &RustConnection,
    screen: &Screen,
    window: Window,
    caps: ExtensionCaps,
) -> Result<CaptureSource, String> {
    let geometry = conn.get_geometry(window)
        .map_err(|e| format!("cannot query X11 window geometry: {e}"))?
        .reply()
        .map_err(|e| format!("cannot read X11 window geometry: {e}"))?;
    if geometry.width == 0 || geometry.height == 0 {
        return Err("selected X11 window has zero size".into());
    }
    let attrs = conn.get_window_attributes(window)
        .map_err(|e| format!("cannot query X11 window attributes: {e}"))?
        .reply()
        .map_err(|e| format!("cannot read X11 window attributes: {e}"))?;
    if attrs.map_state != MapState::VIEWABLE {
        return Err("selected X11 window is not viewable; X11 does not guarantee backing pixels for minimized/unmapped windows".into());
    }
    let translated = conn.translate_coordinates(window, screen.root, 0, 0)
        .ok()
        .and_then(|c| c.reply().ok());
    let origin = translated.map(|r| (i32::from(r.dst_x), i32::from(r.dst_y))).unwrap_or((geometry.x.into(), geometry.y.into()));

    let mut drawable = window;
    let mut pixmap = None;
    let mut redirected = None;
    if caps.composite {
        let redirected_ok = conn
            .composite_redirect_window(window, Redirect::AUTOMATIC)
            .ok()
            .and_then(|cookie| cookie.check().ok())
            .is_some();
        let candidate = conn.generate_id().map_err(|e| format!("cannot allocate X11 composite pixmap id: {e}"))?;
        if conn.composite_name_window_pixmap(window, candidate)
            .ok()
            .and_then(|cookie| cookie.check().ok())
            .is_some()
        {
            drawable = candidate;
            pixmap = Some(candidate);
            if redirected_ok {
                redirected = Some(window);
            }
        } else if redirected_ok {
            let _ = conn.composite_unredirect_window(window, Redirect::AUTOMATIC);
        }
    }

    Ok(CaptureSource {
        drawable,
        damage_drawable: window,
        rect: CaptureRect { x: 0, y: 0, width: geometry.width, height: geometry.height },
        origin_root: origin,
        depth: geometry.depth,
        visual: attrs.visual,
        composite_pixmap: pixmap,
        redirected_window: redirected,
    })
}

fn prepare_source(
    conn: &RustConnection,
    screen: &Screen,
    caps: ExtensionCaps,
    request: TargetRequest,
) -> Result<CaptureSource, String> {
    match request {
        TargetRequest::Window(window) => prepare_window_source(conn, screen, window, caps),
        TargetRequest::Desktop => Ok(CaptureSource {
            drawable: screen.root,
            damage_drawable: screen.root,
            rect: root_bounds(screen),
            origin_root: (0, 0),
            depth: screen.root_depth,
            visual: screen.root_visual,
            composite_pixmap: None,
            redirected_window: None,
        }),
        TargetRequest::Monitor(index) => {
            let monitors = discover_monitors(conn, screen, caps);
            let target = monitors.get(index).ok_or_else(|| format!("X11 monitor {index} is unavailable"))?;
            let rect = CaptureRect {
                x: target.x,
                y: target.y,
                width: target.width,
                height: target.height,
            }
            .clamp_to(root_bounds(screen))
            .ok_or_else(|| "selected monitor is outside the X11 root".to_string())?;
            Ok(CaptureSource {
                drawable: screen.root,
                damage_drawable: screen.root,
                rect,
                origin_root: (i32::from(rect.x), i32::from(rect.y)),
                depth: screen.root_depth,
                visual: screen.root_visual,
                composite_pixmap: None,
                redirected_window: None,
            })
        }
        TargetRequest::Region(rect) => {
            let rect = rect
                .clamp_to(root_bounds(screen))
                .ok_or_else(|| "selected region is outside the X11 root".to_string())?;
            Ok(CaptureSource {
                drawable: screen.root,
                damage_drawable: screen.root,
                rect,
                origin_root: (i32::from(rect.x), i32::from(rect.y)),
                depth: screen.root_depth,
                visual: screen.root_visual,
                composite_pixmap: None,
                redirected_window: None,
            })
        }
        TargetRequest::PickRegion => Err("interactive region must be resolved before capture".into()),
    }
}

fn capture_backend_name(caps: ExtensionCaps, shm_runtime_ready: bool) -> &'static str {
    if caps.shm && shm_runtime_ready { "x11-xshm" } else { "x11-get-image" }
}

fn window_capture_mode(caps: ExtensionCaps) -> &'static str {
    if caps.composite { "xcomposite-preferred" } else { "window-get-image" }
}

struct ShmCapture {
    seg: u32,
    ptr: *mut libc::c_void,
    len: usize,
}

impl ShmCapture {
    fn new(conn: &RustConnection, len: usize) -> Result<Self, String> {
        let len = len.max(4096);
        let shmid = unsafe { shmget(IPC_PRIVATE, len, IPC_CREAT | 0o600) };
        if shmid < 0 {
            return Err(format!("shmget failed: {}", io::Error::last_os_error()));
        }
        let ptr = unsafe { shmat(shmid, null_mut(), 0) };
        if ptr == (-1_isize) as *mut libc::c_void {
            unsafe { shmctl(shmid, IPC_RMID, null_mut()) };
            return Err(format!("shmat failed: {}", io::Error::last_os_error()));
        }
        let seg = conn.generate_id().map_err(|e| format!("cannot allocate XShm id: {e}"))?;
        let attach = match conn.shm_attach(seg, shmid as u32, false) {
            Ok(cookie) => cookie.check().map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        unsafe { shmctl(shmid, IPC_RMID, null_mut()) };
        if let Err(error) = attach {
            unsafe { shmdt(ptr) };
            return Err(format!("XShm attach failed: {error}"));
        }
        conn.flush().map_err(|e| format!("XShm flush failed: {e}"))?;
        Ok(Self { seg, ptr, len })
    }

    fn capture_rect<'a>(
        &'a mut self,
        conn: &RustConnection,
        drawable: u32,
        rect: CaptureRect,
    ) -> Result<&'a [u8], String> {
        let reply = conn.shm_get_image(
            drawable,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            u32::MAX,
            u8::from(ImageFormat::Z_PIXMAP),
            self.seg,
            0,
        )
        .map_err(|e| format!("XShm get-image request failed: {e}"))?
        .reply()
        .map_err(|e| format!("XShm get-image failed: {e}"))?;
        let used = (reply.size as usize).min(self.len);
        if used == 0 {
            return Err("XShm returned an empty frame".into());
        }
        Ok(unsafe { std::slice::from_raw_parts(self.ptr as *const u8, used) })
    }
}

impl Drop for ShmCapture {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { shmdt(self.ptr) };
        }
    }
}

struct DamageTracker {
    id: u32,
}

impl DamageTracker {
    fn new(conn: &RustConnection, drawable: u32, caps: ExtensionCaps) -> Option<Self> {
        if !caps.damage {
            return None;
        }
        let id = conn.generate_id().ok()?;
        conn.damage_create(id, drawable, ReportLevel::NON_EMPTY).ok()?.check().ok()?;
        conn.flush().ok()?;
        Some(Self { id })
    }

    fn take_dirty(&self, conn: &RustConnection) -> Option<CaptureRect> {
        let mut dirty: Option<CaptureRect> = None;
        loop {
            match conn.poll_for_event() {
                Ok(Some(Event::DamageNotify(event))) if event.damage == self.id => {
                    if event.area.width > 0 && event.area.height > 0 {
                        let rect = CaptureRect {
                            x: event.area.x,
                            y: event.area.y,
                            width: event.area.width,
                            height: event.area.height,
                        };
                        dirty = Some(match dirty {
                            Some(current) => current.union(rect),
                            None => rect,
                        });
                    }
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        if dirty.is_some() {
            let _ = conn.damage_subtract(self.id, NONE, NONE);
            let _ = conn.flush();
        }
        dirty
    }
}

fn cursor_snapshot(conn: &RustConnection, caps: ExtensionCaps) -> Option<CursorSnapshot> {
    if !caps.xfixes {
        return None;
    }
    let reply = conn.xfixes_get_cursor_image().ok()?.reply().ok()?;
    Some(CursorSnapshot {
        x: i32::from(reply.x),
        y: i32::from(reply.y),
        width: reply.width as usize,
        height: reply.height as usize,
        xhot: reply.xhot as i32,
        yhot: reply.yhot as i32,
        serial: reply.cursor_serial,
        argb: reply.cursor_image,
    })
}

fn draw_selection_rect(conn: &RustConnection, root: Window, gc: Gcontext, rect: CaptureRect) {
    let rectangle = Rectangle { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    let _ = conn.poly_rectangle(root, gc, &[rectangle]);
    let _ = conn.flush();
}

fn pick_region(conn: &RustConnection, screen: &Screen) -> Result<CaptureRect, String> {
    let reply = conn.grab_pointer(
        false,
        screen.root,
        EventMask::BUTTON_PRESS | EventMask::BUTTON_RELEASE | EventMask::POINTER_MOTION,
        GrabMode::ASYNC,
        GrabMode::ASYNC,
        NONE,
        NONE,
        CURRENT_TIME,
    )
    .map_err(|e| format!("cannot grab X11 pointer: {e}"))?
    .reply()
    .map_err(|e| format!("cannot read X11 pointer-grab reply: {e}"))?;
    if reply.status != GrabStatus::SUCCESS {
        return Err(format!("X11 pointer grab failed: {:?}", reply.status));
    }

    let gc = conn.generate_id().map_err(|e| format!("cannot allocate X11 selection GC: {e}"))?;
    let gc_aux = CreateGCAux::new()
        .function(GX::XOR)
        .foreground(u32::MAX)
        .subwindow_mode(SubwindowMode::INCLUDE_INFERIORS)
        .line_width(2);
    let gc_ready = conn.create_gc(gc, screen.root, &gc_aux)
        .ok()
        .and_then(|cookie| cookie.check().ok())
        .is_some();

    let mut start = None;
    let mut previous = None;
    let result = loop {
        let event = conn.wait_for_event().map_err(|e| format!("X11 region picker failed: {e}"))?;
        match event {
            Event::ButtonPress(event) => {
                start = Some((event.root_x, event.root_y));
            }
            Event::MotionNotify(event) => {
                let Some((sx, sy)) = start else { continue };
                if gc_ready {
                    if let Some(old) = previous.take() {
                        draw_selection_rect(conn, screen.root, gc, old);
                    }
                    if let Some(rect) = CaptureRect::normalized(sx, sy, event.root_x, event.root_y) {
                        draw_selection_rect(conn, screen.root, gc, rect);
                        previous = Some(rect);
                    }
                }
            }
            Event::ButtonRelease(event) => {
                let Some((sx, sy)) = start else { continue };
                let rect = CaptureRect::normalized(sx, sy, event.root_x, event.root_y)
                    .and_then(|r| r.clamp_to(root_bounds(screen)))
                    .ok_or_else(|| "selected X11 region is empty".to_string())?;
                break Ok(rect);
            }
            _ => {}
        }
    };

    if gc_ready {
        if let Some(old) = previous {
            draw_selection_rect(conn, screen.root, gc, old);
        }
        let _ = conn.free_gc(gc);
    }
    let _ = conn.ungrab_pointer(CURRENT_TIME);
    let _ = conn.flush();
    result
}

fn fallback_get_image_rect(
    conn: &RustConnection,
    drawable: u32,
    rect: CaptureRect,
) -> Result<Vec<u8>, String> {
    conn.get_image(
        ImageFormat::Z_PIXMAP,
        drawable,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        u32::MAX,
    )
    .map_err(|e| format!("X11 get-image request failed: {e}"))?
    .reply()
    .map(|r| r.data)
    .map_err(|e| format!("X11 get-image failed: {e}"))
}

fn patch_raw_frame(
    frame: &mut [u8],
    frame_width: usize,
    frame_height: usize,
    frame_rect: CaptureRect,
    dirty_rect: CaptureRect,
    data: &[u8],
    layout: &PixelLayout,
) -> Result<(), String> {
    let dirty = dirty_rect
        .intersection(frame_rect)
        .ok_or_else(|| "X11 dirty rectangle does not intersect the capture target".to_string())?;
    let local_x = (i32::from(dirty.x) - i32::from(frame_rect.x)) as usize;
    let local_y = (i32::from(dirty.y) - i32::from(frame_rect.y)) as usize;
    let bytes_per_pixel = layout.bits_per_pixel.div_ceil(8);
    let frame_stride = packed_stride(frame_width, layout.bits_per_pixel, layout.scanline_pad)
        .ok_or_else(|| "X11 frame stride overflow".to_string())?;
    let dirty_stride = packed_stride(dirty.width as usize, layout.bits_per_pixel, layout.scanline_pad)
        .ok_or_else(|| "X11 dirty stride overflow".to_string())?;
    let copy_bytes = (dirty.width as usize)
        .checked_mul(bytes_per_pixel)
        .ok_or_else(|| "X11 dirty row-size overflow".to_string())?;
    let expected_frame = frame_stride
        .checked_mul(frame_height)
        .ok_or_else(|| "X11 frame-size overflow".to_string())?;
    let expected_dirty = dirty_stride
        .checked_mul(dirty.height as usize)
        .ok_or_else(|| "X11 dirty-size overflow".to_string())?;
    if frame.len() < expected_frame || data.len() < expected_dirty {
        return Err("X11 dirty-frame buffers are shorter than expected".into());
    }

    for row in 0..dirty.height as usize {
        let src_start = row * dirty_stride;
        let dst_start = (local_y + row) * frame_stride + local_x * bytes_per_pixel;
        frame[dst_start..dst_start + copy_bytes]
            .copy_from_slice(&data[src_start..src_start + copy_bytes]);
    }
    Ok(())
}

fn update_raw_frame(
    conn: &RustConnection,
    source: &CaptureSource,
    layout: &PixelLayout,
    shm_capture: &mut Option<ShmCapture>,
    frame: &mut [u8],
    dirty: CaptureRect,
) -> Result<(), String> {
    let Some(dirty) = dirty.intersection(source.rect) else {
        return Ok(());
    };

    if let Some(shm) = shm_capture.as_mut() {
        let seg = shm.seg;
        match shm.capture_rect(conn, source.drawable, dirty) {
            Ok(data) => {
                return patch_raw_frame(
                    frame,
                    source.rect.width as usize,
                    source.rect.height as usize,
                    source.rect,
                    dirty,
                    data,
                    layout,
                );
            }
            Err(error) => {
                eprintln!("Liney screen: XShm capture failed ({error}); fallback=x11-get-image");
                let _ = conn.shm_detach(seg);
                *shm_capture = None;
            }
        }
    }

    let data = fallback_get_image_rect(conn, source.drawable, dirty)?;
    patch_raw_frame(
        frame,
        source.rect.width as usize,
        source.rect.height as usize,
        source.rect,
        dirty,
        &data,
        layout,
    )
}

fn encode_frame(
    encoder: &mut Option<(usize, usize, Encoder)>,
    stdout: &mut impl Write,
    frame: &I420Frame,
    fps: u32,
    bitrate: u32,
) -> Result<(), String> {
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
        *encoder = Some((
            width,
            height,
            Encoder::with_config(OpenH264API::from_source(), config)
                .map_err(|e| format!("OpenH264 X11 init failed: {e}"))?,
        ));
        eprintln!("Liney screen: x11={}x{} target={}fps {}bps", width, height, fps, bitrate);
    }
    let Some((_, _, active)) = encoder.as_mut() else {
        return Err("OpenH264 X11 encoder unavailable".into());
    };
    let bitstream = active.encode(frame).map_err(|e| format!("OpenH264 X11 encode failed: {e}"))?;
    let mut encoded = Vec::new();
    bitstream.write_vec(&mut encoded);
    stdout.write_all(&encoded).map_err(|e| format!("cannot write X11 H.264 stream: {e}"))?;
    stdout.flush().map_err(|e| format!("cannot flush X11 H.264 stream: {e}"))
}

fn run_capture(target: TargetRequest, include_cursor: bool, fps: u32, bitrate: u32) -> Result<(), String> {
    let (conn, screen_index) = x11rb::connect(None).map_err(|e| format!("cannot connect to X11 display: {e}"))?;
    let screen = conn.setup().roots.get(screen_index)
        .ok_or_else(|| "X11 default screen is unavailable".to_string())?
        .clone();
    let caps = detect_extensions(&conn);
    let target = match target {
        TargetRequest::PickRegion => TargetRequest::Region(pick_region(&conn, &screen)?),
        other => other,
    };
    let mut source = prepare_source(&conn, &screen, caps, target)?;
    let layout = layout_for(conn.setup(), source.depth, source.visual)?;
    if !layout.true_color {
        source.cleanup(&conn);
        return Err("selected X11 target does not use a TrueColor visual".into());
    }

    let needed = packed_len(source.rect.width as usize, source.rect.height as usize, &layout)
        .ok_or_else(|| "X11 frame buffer size overflow".to_string())?;
    let mut shm_capture = if caps.shm {
        match ShmCapture::new(&conn, needed) {
            Ok(shm) => Some(shm),
            Err(error) => {
                eprintln!("Liney screen: XShm unavailable at runtime ({error}); fallback=x11-get-image");
                None
            }
        }
    } else {
        None
    };
    let damage = DamageTracker::new(&conn, source.damage_drawable, caps);
    let backend = capture_backend_name(caps, shm_capture.is_some());
    eprintln!(
        "Liney screen: backend={backend} composite={} damage={} cursor={} target={}x{}",
        source.composite_pixmap.is_some(),
        damage.is_some(),
        include_cursor && caps.xfixes,
        source.rect.width,
        source.rect.height,
    );

    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    let mut encoder: Option<(usize, usize, Encoder)> = None;
    let interval = Duration::from_secs_f64(1.0 / fps.max(1) as f64);
    let mut last_capture = Instant::now() - Duration::from_secs(2);
    let mut previous_cursor_key = None;
    let mut raw_frame = vec![0_u8; needed];
    let mut frame_initialized = false;

    loop {
        let started = Instant::now();
        let cursor = if include_cursor { cursor_snapshot(&conn, caps) } else { None };
        let cursor_key = cursor.as_ref().map(CursorSnapshot::key);
        let cursor_changed = cursor_key != previous_cursor_key;
        let dirty = damage.as_ref().and_then(|tracker| tracker.take_dirty(&conn));
        let keepalive_due = last_capture.elapsed() >= Duration::from_secs(1);

        let mut pixels_changed = false;
        if !frame_initialized {
            update_raw_frame(&conn, &source, &layout, &mut shm_capture, &mut raw_frame, source.rect)?;
            frame_initialized = true;
            pixels_changed = true;
        } else if damage.is_none() {
            update_raw_frame(&conn, &source, &layout, &mut shm_capture, &mut raw_frame, source.rect)?;
            pixels_changed = true;
        } else if let Some(dirty) = dirty.and_then(|rect| rect.intersection(source.rect)) {
            update_raw_frame(&conn, &source, &layout, &mut shm_capture, &mut raw_frame, dirty)?;
            pixels_changed = true;
        }

        if !pixels_changed && !cursor_changed && !keepalive_due {
            if let Some(remaining) = interval.checked_sub(started.elapsed()) {
                std::thread::sleep(remaining);
            }
            continue;
        }
        previous_cursor_key = cursor_key;

        let frame = capture_to_i420(
            &raw_frame,
            source.rect.width as usize,
            source.rect.height as usize,
            &layout,
            source.origin_root,
            cursor.as_ref(),
        )?;

        encode_frame(&mut encoder, &mut stdout, &frame, fps, bitrate)?;
        last_capture = Instant::now();
        if let Some(remaining) = interval.checked_sub(started.elapsed()) {
            std::thread::sleep(remaining);
        }
    }
}

fn probe() -> serde_json::Value {
    if std::env::var_os("DISPLAY").is_none() {
        return serde_json::json!({
            "available": false,
            "backend": "x11-native",
            "reason": "no-x11-display",
            "targets": []
        });
    }
    match x11rb::connect(None) {
        Ok((conn, screen_index)) => {
            let setup = conn.setup();
            let Some(screen) = setup.roots.get(screen_index) else {
                return serde_json::json!({"available": false, "backend": "x11-native", "targets": []});
            };
            let caps = detect_extensions(&conn);
            let baseline = visual_for_id(setup, screen.root_visual).is_some()
                && setup.pixmap_formats.iter().any(|f| f.depth == screen.root_depth)
                && caps.baseline_works()
                && screen.width_in_pixels > 0
                && screen.height_in_pixels > 0;
            let targets = discover_targets(&conn, screen, caps);
            serde_json::json!({
                "available": baseline,
                "backend": if caps.shm { "x11-xshm" } else { "x11-get-image" },
                "width": screen.width_in_pixels,
                "height": screen.height_in_pixels,
                "extensions": caps,
                "acceleration": {
                    "capture": if caps.shm { "xshm" } else { "get-image" },
                    "damageTracking": caps.damage,
                    "windowComposite": caps.composite,
                    "windowCaptureMode": window_capture_mode(caps),
                    "cursor": caps.xfixes,
                    "encoder": "openh264-software",
                    "hardwareEncoder": false
                },
                "targets": targets
            })
        }
        Err(error) => serde_json::json!({
            "available": false,
            "backend": "x11-native",
            "reason": error.to_string(),
            "targets": []
        }),
    }
}

fn self_test() -> Result<(), String> {
    let value = probe();
    if !value.get("available").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Err("X11 probe is unavailable".into());
    }
    if !value.get("targets").and_then(|v| v.as_array()).map(|v| !v.is_empty()).unwrap_or(false) {
        return Err("X11 target discovery returned no targets".into());
    }
    println!("X11_SELF_TEST_OK");
    Ok(())
}

fn real_main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().ok_or_else(|| "missing mode".to_string())?;
    match mode.as_str() {
        "--probe" | "--list-targets" => {
            println!("{}", probe());
            Ok(())
        }
        "--self-test" => self_test(),
        "--capture" => {
            let mut target = TargetRequest::Desktop;
            let mut include_cursor = true;
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--target" => {
                        let value = args.next().ok_or_else(|| "--target requires a value".to_string())?;
                        target = parse_target(&value)?;
                    }
                    "--no-cursor" => include_cursor = false,
                    other => return Err(format!("unknown X11 capture argument: {other}")),
                }
            }
            run_capture(target, include_cursor, 15, 800_000)
        }
        _ => Err(format!("unknown Liney X11 screen mode: {mode}")),
    }
}

fn main() {
    if let Err(error) = real_main() {
        eprintln!("Liney X11 screen helper error: {error}");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout_32() -> PixelLayout {
        PixelLayout {
            bits_per_pixel: 32,
            scanline_pad: 32,
            byte_order: ImageOrder::LSB_FIRST,
            red_mask: 0x00ff0000,
            green_mask: 0x0000ff00,
            blue_mask: 0x000000ff,
            true_color: true,
        }
    }

    #[test]
    fn target_parse_covers_desktop_monitor_window_region_and_picker() {
        assert_eq!(parse_target("desktop").unwrap(), TargetRequest::Desktop);
        assert_eq!(parse_target("monitor:2").unwrap(), TargetRequest::Monitor(2));
        assert_eq!(parse_target("window:0x2a").unwrap(), TargetRequest::Window(42));
        assert_eq!(
            parse_target("region:-10,20,300,200").unwrap(),
            TargetRequest::Region(CaptureRect { x: -10, y: 20, width: 300, height: 200 })
        );
        assert_eq!(parse_target("region:pick").unwrap(), TargetRequest::PickRegion);
        assert!(parse_target("region:0,0,0,20").is_err());
    }

    #[test]
    fn target_region_normalizes_and_clips() {
        let picked = CaptureRect::normalized(300, 200, 100, 50).unwrap();
        assert_eq!(picked, CaptureRect { x: 100, y: 50, width: 200, height: 150 });
        let clipped = CaptureRect { x: -10, y: 10, width: 30, height: 40 }
            .clamp_to(CaptureRect { x: 0, y: 0, width: 100, height: 100 })
            .unwrap();
        assert_eq!(clipped, CaptureRect { x: 0, y: 10, width: 20, height: 40 });
    }

    #[test]
    fn capture_stride_respects_scanline_padding() {
        assert_eq!(packed_stride(3, 24, 32), Some(12));
        assert_eq!(packed_stride(4, 16, 16), Some(8));
        assert_eq!(packed_len(3, 2, &PixelLayout { bits_per_pixel: 24, scanline_pad: 32, ..layout_32() }), Some(24));
    }

    #[test]
    fn capture_output_size_stays_even_and_bounded() {
        assert_eq!(output_size(1920, 1080), (1280, 720));
        let (w, h) = output_size(4480, 1440);
        assert!(w <= 1280 && h <= 720 && w % 2 == 0 && h % 2 == 0);
    }

    #[test]
    fn extension_optional_policy_never_requires_acceleration() {
        let none = ExtensionCaps::default();
        assert!(none.baseline_works());
        assert!(!none.shm && !none.damage && !none.composite && !none.xfixes);
    }

    #[test]
    fn extension_composite_is_independent_from_damage_and_cursor() {
        let caps = ExtensionCaps { composite: true, ..ExtensionCaps::default() };
        assert!(caps.baseline_works());
        assert!(caps.composite);
        assert!(!caps.damage);
        assert!(!caps.xfixes);
    }

    #[test]
    fn cursor_blend_clips_outside_target() {
        let cursor = CursorSnapshot {
            x: 10,
            y: 10,
            width: 2,
            height: 2,
            xhot: 0,
            yhot: 0,
            serial: 1,
            argb: vec![0xffff0000; 4],
        };
        assert_eq!(cursor.blend_at(9, 9, (10, 20, 30)), (10, 20, 30));
        assert_eq!(cursor.blend_at(10, 10, (10, 20, 30)), (255, 0, 0));
    }

    #[test]
    fn cursor_blend_uses_premultiplied_alpha() {
        let cursor = CursorSnapshot {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            xhot: 0,
            yhot: 0,
            serial: 1,
            argb: vec![0x80800000],
        };
        let blended = cursor.blend_at(0, 0, (0, 0, 255));
        assert!(blended.0 >= 127);
        assert!(blended.2 >= 126 && blended.2 <= 128);
    }

    #[test]
    fn pixel_decodes_rgb565() {
        let layout = PixelLayout {
            bits_per_pixel: 16,
            scanline_pad: 16,
            byte_order: ImageOrder::LSB_FIRST,
            red_mask: 0xf800,
            green_mask: 0x07e0,
            blue_mask: 0x001f,
            true_color: true,
        };
        assert_eq!(unpack_rgb(&[0x00, 0xf8], 0, 0, 1, &layout).unwrap(), (255, 0, 0));
    }

    #[test]
    fn pixel_decodes_24bit_with_padding() {
        let layout = PixelLayout {
            bits_per_pixel: 24,
            scanline_pad: 32,
            byte_order: ImageOrder::LSB_FIRST,
            red_mask: 0x00ff0000,
            green_mask: 0x0000ff00,
            blue_mask: 0x000000ff,
            true_color: true,
        };
        let data = [0x33, 0x22, 0x11, 0x00];
        assert_eq!(unpack_rgb(&data, 0, 0, 1, &layout).unwrap(), (0x11, 0x22, 0x33));
    }

    #[test]
    fn pixel_decodes_30bit_truecolor() {
        let layout = PixelLayout {
            bits_per_pixel: 32,
            scanline_pad: 32,
            byte_order: ImageOrder::LSB_FIRST,
            red_mask: 0x3ff00000,
            green_mask: 0x000ffc00,
            blue_mask: 0x000003ff,
            true_color: true,
        };
        let pixel = 0x3ff00000_u32.to_le_bytes();
        let (r, g, b) = unpack_rgb(&pixel, 0, 0, 1, &layout).unwrap();
        assert_eq!(r, 255);
        assert_eq!((g, b), (0, 0));
    }

    #[test]
    fn pixel_decodes_32bit_big_endian_and_rejects_non_truecolor() {
        let mut layout = layout_32();
        layout.byte_order = ImageOrder::MSB_FIRST;
        assert_eq!(unpack_rgb(&[0x00, 0x11, 0x22, 0x33], 0, 0, 1, &layout).unwrap(), (0x11, 0x22, 0x33));
        layout.true_color = false;
        assert!(unpack_rgb(&[0; 4], 0, 0, 1, &layout).is_err());
    }

    #[test]
    fn pixel_rejects_unsupported_layouts_and_short_buffers() {
        let mut layout = layout_32();
        layout.bits_per_pixel = 12;
        assert!(unpack_rgb(&[0; 4], 0, 0, 1, &layout).is_err());

        layout.bits_per_pixel = 32;
        assert!(unpack_rgb(&[0; 3], 0, 0, 1, &layout).is_err());
    }

    #[test]
    fn capture_policy_prefers_xshm_but_keeps_get_image_fallback() {
        let caps = ExtensionCaps { shm: true, ..ExtensionCaps::default() };
        assert_eq!(capture_backend_name(caps, true), "x11-xshm");
        assert_eq!(capture_backend_name(caps, false), "x11-get-image");
        assert_eq!(capture_backend_name(ExtensionCaps::default(), false), "x11-get-image");
    }

    #[test]
    fn extension_composite_policy_falls_back_to_plain_window_capture() {
        assert_eq!(window_capture_mode(ExtensionCaps::default()), "window-get-image");
        assert_eq!(
            window_capture_mode(ExtensionCaps { composite: true, ..ExtensionCaps::default() }),
            "xcomposite-preferred"
        );
    }

    #[test]
    fn extension_damage_rect_union_and_intersection_are_exact() {
        let a = CaptureRect { x: 10, y: 10, width: 20, height: 20 };
        let b = CaptureRect { x: 25, y: 5, width: 20, height: 20 };
        assert_eq!(a.union(b), CaptureRect { x: 10, y: 5, width: 35, height: 25 });
        assert_eq!(
            a.intersection(b),
            Some(CaptureRect { x: 25, y: 10, width: 5, height: 15 })
        );
    }

    #[test]
    fn extension_damage_patch_updates_only_dirty_bytes() {
        let layout = PixelLayout {
            bits_per_pixel: 32,
            scanline_pad: 32,
            byte_order: ImageOrder::LSB_FIRST,
            red_mask: 0x00ff0000,
            green_mask: 0x0000ff00,
            blue_mask: 0x000000ff,
            true_color: true,
        };
        let frame_rect = CaptureRect { x: 10, y: 20, width: 4, height: 2 };
        let dirty = CaptureRect { x: 11, y: 21, width: 2, height: 1 };
        let mut frame = vec![0_u8; packed_len(4, 2, &layout).unwrap()];
        let data = vec![0xaa_u8; packed_len(2, 1, &layout).unwrap()];
        patch_raw_frame(&mut frame, 4, 2, frame_rect, dirty, &data, &layout).unwrap();
        assert_eq!(&frame[20..28], &[0xaa; 8]);
        assert!(frame[..20].iter().all(|byte| *byte == 0));
    }

}
