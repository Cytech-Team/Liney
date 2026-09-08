use base64::Engine as _;
use gdk_pixbuf::PixbufLoader;
use gtk4 as gtk;
use gtk::gdk::prelude::GdkCairoContextExt;
use gtk::prelude::*;
use std::{cell::RefCell, path::PathBuf, rc::Rc, time::{SystemTime, UNIX_EPOCH}};

pub fn choose_media_file<W, F>(parent: &W, on_selected: F)
where
    W: IsA<gtk::Window>,
    F: Fn(PathBuf) + 'static,
{
    let chooser = gtk::FileChooserNative::builder().title("เลือกไฟล์ที่จะส่ง").action(gtk::FileChooserAction::Open).transient_for(parent).modal(true).build();
    for (name, mime_types, patterns) in [
        ("รูปภาพ", &["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"][..], &["*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif", "*.avif", "*.bmp"][..]),
        ("วิดีโอ", &["video/mp4", "video/x-m4v", "video/webm", "video/quicktime"][..], &["*.mp4", "*.m4v", "*.webm", "*.mov"][..]),
        ("เสียง", &["audio/mpeg", "audio/ogg", "audio/wav", "audio/mp4", "audio/flac"][..], &["*.mp3", "*.ogg", "*.wav", "*.m4a", "*.flac"][..]),
        ("ไฟล์ทั้งหมด", &[][..], &["*"][..]),
    ] {
        let filter = gtk::FileFilter::new();
        filter.set_name(Some(name));
        for mime_type in mime_types { filter.add_mime_type(mime_type); }
        for pattern in patterns { filter.add_pattern(pattern); }
        chooser.add_filter(&filter);
    }
    chooser.connect_response(move |dialog, response| {
        if response == gtk::ResponseType::Accept {
            if let Some(path) = dialog.file().and_then(|file| file.path()) { on_selected(path); }
        }
        dialog.destroy();
    });
    chooser.show();
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageEditorTool { View, Draw, Blur, Text }

fn image_editor_button(icon: &str, label: &str, tooltip: &str, class: &str) -> gtk::Button {
    let content = gtk::Box::builder().orientation(gtk::Orientation::Horizontal).spacing(4).build();
    let image = gtk::Image::from_icon_name(icon);
    image.set_pixel_size(16);
    content.append(&image);
    content.append(&gtk::Label::new(Some(label)));
    gtk::Button::builder().child(&content).tooltip_text(tooltip).css_classes([class]).build()
}

struct ImageEditorState {
    original: gtk::cairo::ImageSurface,
    current: gtk::cairo::ImageSurface,
    undo: Vec<gtk::cairo::ImageSurface>,
    tool: ImageEditorTool,
    zoom: f64,
    last_point: Option<(f64, f64)>,
}

impl ImageEditorState {
    fn snapshot(&mut self) {
        if let Some(copy) = deep_copy_surface(&self.current) {
            self.undo.push(copy);
            if self.undo.len() > 20 { self.undo.remove(0); }
        }
    }

    fn undo(&mut self) -> bool {
        if let Some(previous) = self.undo.pop() { self.current = previous; true } else { false }
    }

    fn clear(&mut self) {
        self.undo.clear();
        if let Some(copy) = deep_copy_surface(&self.original) { self.current = copy; }
        self.last_point = None;
    }
}

pub fn show_image_viewer<W, F>(parent: &W, data_url: &str, on_error: F)
where
    W: IsA<gtk::Window>,
    F: Fn(&'static str) + 'static,
{
    let Some((_bytes, pixbuf)) = image_bytes_and_pixbuf(data_url) else { on_error("เปิดรูปภาพไม่ได้"); return; };
    let Some(original) = surface_from_pixbuf(&pixbuf) else { on_error("สร้าง canvas สำหรับรูปภาพไม่ได้"); return; };
    let Some(current) = deep_copy_surface(&original) else { on_error("สร้าง canvas สำหรับรูปภาพไม่ได้"); return; };
    let editor = Rc::new(RefCell::new(ImageEditorState { original, current, undo: Vec::new(), tool: ImageEditorTool::View, zoom: 1.0, last_point: None }));

    let window = gtk::Window::builder().transient_for(parent).title("ดูและแก้ไขรูปภาพ · Liney").default_width(1120).default_height(760).width_request(720).height_request(520).build();
    window.add_css_class("image-editor");
    let root = gtk::Box::builder().orientation(gtk::Orientation::Vertical).build();
    let header = gtk::HeaderBar::builder().show_title_buttons(true).css_classes(["image-editor-header"]).build();
    let title_box = gtk::Box::builder().orientation(gtk::Orientation::Vertical).spacing(1).build();
    title_box.append(&gtk::Label::builder().label("ดูและแก้ไขรูปภาพ").xalign(0.0).css_classes(["image-editor-title"]).build());
    title_box.append(&gtk::Label::builder().label("วาด เบลอ หรือเพิ่มข้อความ แล้วบันทึกเป็น PNG").xalign(0.0).css_classes(["image-editor-subtitle"]).build());
    header.set_title_widget(Some(&title_box));

    let view = image_editor_button("view-reveal-symbolic", "ดู", "ดูภาพ", "editor-tool");
    let draw = image_editor_button("draw-freehand-symbolic", "วาด", "วาดบนรูปภาพ", "editor-tool");
    let blur = image_editor_button("selection-opaque-symbolic", "เบลอ", "เบลอส่วนของรูปภาพ", "editor-tool");
    let text = image_editor_button("insert-text-symbolic", "ข้อความ", "เพิ่มข้อความบนรูปภาพ", "editor-tool");
    view.add_css_class("active");
    let undo = image_editor_button("edit-undo-symbolic", "ย้อนกลับ", "ย้อนกลับ (Ctrl+Z)", "editor-action"); undo.set_sensitive(false);
    let clear = image_editor_button("edit-clear-symbolic", "ล้าง", "ล้างการแก้ไขทั้งหมด", "editor-action");
    let save = image_editor_button("document-save-symbolic", "บันทึก", "บันทึกเป็น PNG", "editor-action"); save.add_css_class("save");
    let minus = image_editor_button("zoom-out-symbolic", "", "ย่อภาพ", "editor-zoom");
    let reset = gtk::Button::with_label("100%"); reset.add_css_class("editor-zoom"); reset.set_tooltip_text(Some("ซูม 100%"));
    let plus = image_editor_button("zoom-in-symbolic", "", "ขยายภาพ", "editor-zoom");
    let close = image_editor_button("window-close-symbolic", "ปิด", "ปิดหน้าต่าง (Esc)", "editor-action"); close.add_css_class("close");
    for button in [&view, &draw, &blur, &text] { header.pack_start(button); }
    for button in [&minus, &reset, &plus, &undo, &clear, &save, &close] { header.pack_end(button); }
    window.set_titlebar(Some(&header));

    let canvas = gtk::DrawingArea::new();
    canvas.add_css_class("image-editor-canvas");
    canvas.set_focusable(true);
    canvas.set_halign(gtk::Align::Start);
    canvas.set_valign(gtk::Align::Start);
    let (source_width, source_height) = (pixbuf.width(), pixbuf.height());
    canvas.set_content_width(source_width);
    canvas.set_content_height(source_height);
    {
        let editor = editor.clone();
        canvas.set_draw_func(move |_, context, _, _| {
            let editor = editor.borrow();
            let _ = context.save();
            context.scale(editor.zoom, editor.zoom);
            if context.set_source_surface(&editor.current, 0.0, 0.0).is_ok() { let _ = context.paint(); }
            let _ = context.restore();
        });
    }
    let scroll = gtk::ScrolledWindow::builder().child(&canvas).hexpand(true).vexpand(true).hscrollbar_policy(gtk::PolicyType::Automatic).vscrollbar_policy(gtk::PolicyType::Automatic).css_classes(["image-viewer"]).build();
    root.append(&scroll); window.set_child(Some(&root));

    let tool_buttons = Rc::new(vec![
        (ImageEditorTool::View, view.clone()),
        (ImageEditorTool::Draw, draw.clone()),
        (ImageEditorTool::Blur, blur.clone()),
        (ImageEditorTool::Text, text.clone()),
    ]);
    for (tool, button) in tool_buttons.iter().cloned() {
        let editor = editor.clone(); let buttons = tool_buttons.clone();
        button.connect_clicked(move |_| {
            editor.borrow_mut().tool = tool;
            for (candidate, button) in buttons.iter() { if *candidate == tool { button.add_css_class("active"); } else { button.remove_css_class("active"); } }
        });
    }

    let apply_zoom: Rc<dyn Fn(f64)> = {
        let editor = editor.clone(); let canvas = canvas.clone(); let reset = reset.clone();
        Rc::new(move |value: f64| {
            let value = value.clamp(0.4, 3.0);
            editor.borrow_mut().zoom = value;
            canvas.set_content_width(((source_width as f64) * value).round() as i32);
            canvas.set_content_height(((source_height as f64) * value).round() as i32);
            reset.set_label(&format!("{}%", (value * 100.0).round() as i32));
            canvas.queue_draw();
        })
    };
    apply_zoom(1.0);
    { let editor = editor.clone(); let apply = apply_zoom.clone(); minus.connect_clicked(move |_| apply(editor.borrow().zoom - 0.2)); }
    { let apply = apply_zoom.clone(); reset.connect_clicked(move |_| apply(1.0)); }
    { let editor = editor.clone(); let apply = apply_zoom.clone(); plus.connect_clicked(move |_| apply(editor.borrow().zoom + 0.2)); }

    let update_undo: Rc<dyn Fn()> = { let editor = editor.clone(); let undo = undo.clone(); Rc::new(move || undo.set_sensitive(!editor.borrow().undo.is_empty())) };
    {
        let editor = editor.clone(); let canvas = canvas.clone(); let update_undo = update_undo.clone();
        undo.connect_clicked(move |_| { if editor.borrow_mut().undo() { canvas.queue_draw(); } update_undo(); });
    }
    {
        let editor = editor.clone(); let canvas = canvas.clone(); let update_undo = update_undo.clone();
        clear.connect_clicked(move |_| { editor.borrow_mut().clear(); canvas.queue_draw(); update_undo(); });
    }
    {
        let editor = editor.clone(); let window2 = window.clone();
        save.connect_clicked(move |_| save_edited_surface(&window2, &editor.borrow().current));
    }
    { let window2 = window.clone(); close.connect_clicked(move |_| window2.close()); }

    let drag = gtk::GestureDrag::new();
    {
        let editor = editor.clone(); let canvas = canvas.clone(); let update_undo = update_undo.clone();
        drag.connect_drag_begin(move |_, x, y| {
            let mut editor = editor.borrow_mut();
            if !matches!(editor.tool, ImageEditorTool::Draw | ImageEditorTool::Blur) { return; }
            let zoom = editor.zoom;
            let point = (x / zoom, y / zoom);
            editor.snapshot();
            editor.last_point = Some(point);
            apply_editor_stroke(&mut editor, point, point);
            drop(editor);
            canvas.queue_draw(); update_undo();
        });
    }
    {
        let editor = editor.clone(); let canvas = canvas.clone();
        drag.connect_drag_update(move |gesture, dx, dy| {
            let Some((start_x, start_y)) = gesture.start_point() else { return; };
            let mut editor = editor.borrow_mut();
            if !matches!(editor.tool, ImageEditorTool::Draw | ImageEditorTool::Blur) { return; }
            let zoom = editor.zoom;
            let point = ((start_x + dx) / zoom, (start_y + dy) / zoom);
            let from = editor.last_point.unwrap_or(point);
            apply_editor_stroke(&mut editor, from, point);
            editor.last_point = Some(point);
            drop(editor); canvas.queue_draw();
        });
    }
    {
        let editor = editor.clone();
        drag.connect_drag_end(move |_, _, _| editor.borrow_mut().last_point = None);
    }
    canvas.add_controller(drag);

    let click = gtk::GestureClick::new();
    {
        let editor = editor.clone(); let canvas = canvas.clone(); let window2 = window.clone(); let update_undo = update_undo.clone();
        click.connect_pressed(move |_, _, x, y| {
            let (tool, zoom) = { let editor = editor.borrow(); (editor.tool, editor.zoom) };
            if tool != ImageEditorTool::Text { return; }
            let editor2 = editor.clone(); let canvas2 = canvas.clone(); let update_undo2 = update_undo.clone();
            prompt_image_text(&window2, move |value| {
                let value = value.trim().to_owned(); if value.is_empty() { return; }
                let mut editor = editor2.borrow_mut(); editor.snapshot(); draw_editor_text(&mut editor.current, &value, x / zoom, y / zoom); drop(editor);
                canvas2.queue_draw(); update_undo2();
            });
        });
    }
    canvas.add_controller(click);

    let keys = gtk::EventControllerKey::new();
    {
        let window2 = window.clone(); let editor = editor.clone(); let apply = apply_zoom.clone(); let canvas = canvas.clone(); let update_undo = update_undo.clone();
        keys.connect_key_pressed(move |_, key, _, modifiers| {
            if key == gtk::gdk::Key::Escape { window2.close(); return gtk::glib::Propagation::Stop; }
            if key == gtk::gdk::Key::plus || key == gtk::gdk::Key::equal { apply(editor.borrow().zoom + 0.2); return gtk::glib::Propagation::Stop; }
            if key == gtk::gdk::Key::minus { apply(editor.borrow().zoom - 0.2); return gtk::glib::Propagation::Stop; }
            if modifiers.contains(gtk::gdk::ModifierType::CONTROL_MASK) && (key == gtk::gdk::Key::z || key == gtk::gdk::Key::Z) {
                if editor.borrow_mut().undo() { canvas.queue_draw(); } update_undo(); return gtk::glib::Propagation::Stop;
            }
            gtk::glib::Propagation::Proceed
        });
    }
    window.add_controller(keys); window.present();
}

fn surface_from_pixbuf(pixbuf: &gdk_pixbuf::Pixbuf) -> Option<gtk::cairo::ImageSurface> {
    let surface = gtk::cairo::ImageSurface::create(gtk::cairo::Format::ARgb32, pixbuf.width(), pixbuf.height()).ok()?;
    let context = gtk::cairo::Context::new(&surface).ok()?;
    context.set_source_pixbuf(pixbuf, 0.0, 0.0);
    context.paint().ok()?;
    surface.flush();
    Some(surface)
}

fn deep_copy_surface(source: &gtk::cairo::ImageSurface) -> Option<gtk::cairo::ImageSurface> {
    let copy = gtk::cairo::ImageSurface::create(gtk::cairo::Format::ARgb32, source.width(), source.height()).ok()?;
    let context = gtk::cairo::Context::new(&copy).ok()?;
    context.set_source_surface(source, 0.0, 0.0).ok()?;
    context.paint().ok()?;
    copy.flush();
    Some(copy)
}

fn apply_editor_stroke(editor: &mut ImageEditorState, from: (f64, f64), to: (f64, f64)) {
    let size = (editor.current.width() as f64 / 180.0).round().max(5.0);
    match editor.tool {
        ImageEditorTool::Draw => {
            if let Ok(context) = gtk::cairo::Context::new(&editor.current) {
                context.set_source_rgb(0.133, 0.773, 0.369);
                context.set_line_width(size);
                context.set_line_cap(gtk::cairo::LineCap::Round);
                context.set_line_join(gtk::cairo::LineJoin::Round);
                context.move_to(from.0, from.1); context.line_to(to.0, to.1); let _ = context.stroke();
                editor.current.flush();
            }
        }
        ImageEditorTool::Blur => blur_surface_circle(&mut editor.current, to.0.round() as i32, to.1.round() as i32, (size * 3.0).round() as i32),
        _ => {}
    }
}

fn blur_surface_circle(surface: &mut gtk::cairo::ImageSurface, cx: i32, cy: i32, radius: i32) {
    let width = surface.width().max(0) as usize; let height = surface.height().max(0) as usize; let stride = surface.stride().max(0) as usize;
    if width == 0 || height == 0 || stride == 0 { return; }
    surface.flush();
    let Ok(mut data) = surface.data() else { return; };
    let source = data.to_vec();
    let x0 = (cx - radius).max(0) as usize; let y0 = (cy - radius).max(0) as usize;
    let x1 = (cx + radius).min(width as i32 - 1).max(0) as usize; let y1 = (cy + radius).min(height as i32 - 1).max(0) as usize;
    let kernel = ((radius / 5).clamp(2, 6)) as i32;
    let r2 = (radius as i64) * (radius as i64);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = x as i64 - cx as i64; let dy = y as i64 - cy as i64;
            if dx * dx + dy * dy > r2 { continue; }
            let mut sum = [0u64; 4]; let mut count = 0u64;
            let sy0 = (y as i32 - kernel).max(0) as usize; let sy1 = (y as i32 + kernel).min(height as i32 - 1) as usize;
            let sx0 = (x as i32 - kernel).max(0) as usize; let sx1 = (x as i32 + kernel).min(width as i32 - 1) as usize;
            for sy in sy0..=sy1 { for sx in sx0..=sx1 { let base = sy * stride + sx * 4; for channel in 0..4 { sum[channel] += source[base + channel] as u64; } count += 1; } }
            let base = y * stride + x * 4; if count > 0 { for channel in 0..4 { data[base + channel] = (sum[channel] / count) as u8; } }
        }
    }
    drop(data); surface.mark_dirty();
}

fn draw_editor_text(surface: &mut gtk::cairo::ImageSurface, text: &str, x: f64, y: f64) {
    let surface_width = surface.width();
    let Ok(context) = gtk::cairo::Context::new(&*surface) else { return; };
    let font_size = (surface_width as f64 / 24.0).round().max(22.0);
    context.select_font_face("Sans", gtk::cairo::FontSlant::Normal, gtk::cairo::FontWeight::Bold);
    context.set_font_size(font_size); context.move_to(x, y + font_size);
    context.text_path(text);
    context.set_source_rgba(0.0, 0.0, 0.0, 0.75); context.set_line_width((surface_width as f64 / 380.0).max(3.0)); let _ = context.stroke_preserve();
    context.set_source_rgb(1.0, 1.0, 1.0); let _ = context.fill(); surface.flush();
}

fn prompt_image_text<F>(parent: &gtk::Window, on_submit: F)
where F: Fn(String) + 'static {
    let dialog = gtk::Dialog::builder().transient_for(parent).modal(true).title("ใส่ข้อความ").default_width(420).build();
    dialog.add_button("ยกเลิก", gtk::ResponseType::Cancel); dialog.add_button("วางข้อความ", gtk::ResponseType::Ok);
    let entry = gtk::Entry::builder().placeholder_text("ข้อความที่จะวางบนรูป").margin_top(14).margin_bottom(14).margin_start(14).margin_end(14).build();
    dialog.content_area().append(&entry);
    let entry2 = entry.clone(); dialog.connect_response(move |dialog, response| { if response == gtk::ResponseType::Ok { on_submit(entry2.text().to_string()); } dialog.close(); });
    entry.connect_activate({ let dialog = dialog.clone(); move |_| dialog.response(gtk::ResponseType::Ok) });
    dialog.present(); entry.grab_focus();
}

fn save_edited_surface(parent: &gtk::Window, surface: &gtk::cairo::ImageSurface) {
    let mut bytes = Vec::new();
    if surface.write_to_png(&mut bytes).is_err() { return; }
    let chooser = gtk::FileChooserNative::builder().title("บันทึกรูปที่แก้ไข").action(gtk::FileChooserAction::Save).transient_for(parent).modal(true).accept_label("บันทึก").cancel_label("ยกเลิก").build();
    chooser.set_current_name(&format!("liney-edited-{}.png", now_ms()));
    chooser.connect_response(move |dialog, response| { if response == gtk::ResponseType::Accept { if let Some(path) = dialog.file().and_then(|file| file.path()) { let _ = std::fs::write(path, &bytes); } } dialog.destroy(); });
    chooser.show();
}

fn image_bytes_and_pixbuf(data_url: &str) -> Option<(Vec<u8>, gdk_pixbuf::Pixbuf)> {
    let (_, encoded) = data_url.split_once(',')?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()).ok()?;
    let loader = PixbufLoader::new(); loader.write(&bytes).ok()?; loader.close().ok()?; let pixbuf = loader.pixbuf()?;
    Some((bytes, pixbuf))
}

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
