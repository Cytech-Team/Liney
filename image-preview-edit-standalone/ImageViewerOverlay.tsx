import { motion } from "motion/react";
import { ArrowUpRight, Circle, Copy, Highlighter, Minus, Moon, MousePointer2, Pencil, Plus, Redo2, Save, ScanText, Sparkles, Square, Sun, Trash, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import "./ImageViewerOverlay.css";

type ImageEditorTool = "view" | "draw" | "line" | "arrow" | "rect" | "ellipse" | "bubble" | "highlight" | "marker" | "pixelate" | "blur" | "text";
type ThemeMode = "system" | "light" | "dark";

export function ImageViewerOverlay({ src, onClose }: { src: string; onClose: () => void }) {
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<ImageEditorTool>("view");
  const [ready, setReady] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [color, setColor] = useState("#22c55e");
  const [strokeScale, setStrokeScale] = useState(1);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => (localStorage.getItem("liney-image-editor-theme") as ThemeMode | null) ?? "system");
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const dark = themeMode === "dark" || (themeMode === "system" && systemDark);
  const sourceRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const undoRef = useRef<ImageData[]>([]);
  const redoRef = useRef<ImageData[]>([]);
  const shapeBaseRef = useRef<ImageData | null>(null);
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);

  function context() {
    const canvas = canvasRef.current;
    return canvas ? canvas.getContext("2d") : null;
  }

  function snapshot() {
    const canvas = canvasRef.current;
    const ctx = context();
    if (!canvas || !ctx) return;
    undoRef.current = [...undoRef.current, ctx.getImageData(0, 0, canvas.width, canvas.height)].slice(-20);
    setUndoCount(undoRef.current.length);
    redoRef.current = [];
    setRedoCount(0);
  }

  function pointFor(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
      y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
    };
  }

  function initialiseCanvas() {
    const image = sourceRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas || !image.naturalWidth || !image.naturalHeight) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    undoRef.current = [];
    redoRef.current = [];
    setUndoCount(0);
    setRedoCount(0);
    setReady(true);
  }

  function draw(from: { x: number; y: number }, to: { x: number; y: number }) {
    const canvas = canvasRef.current;
    const ctx = context();
    if (!canvas || !ctx) return;
    const size = Math.max(3, Math.round((canvas.width / 180) * strokeScale));
    if (tool === "draw") {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (["line", "arrow", "rect", "ellipse", "bubble"].includes(tool)) {
      if (shapeBaseRef.current) ctx.putImageData(shapeBaseRef.current, 0, 0);
      const start = shapeStartRef.current ?? from;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (tool === "line" || tool === "arrow") {
        ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(to.x, to.y); ctx.stroke();
        if (tool === "arrow") {
          const angle = Math.atan2(to.y - start.y, to.x - start.x);
          const head = Math.max(size * 4, canvas.width / 45);
          ctx.beginPath(); ctx.moveTo(to.x, to.y);
          ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
          ctx.closePath(); ctx.fill();
        }
      } else if (tool === "rect") {
        ctx.strokeRect(start.x, start.y, to.x - start.x, to.y - start.y);
      } else if (tool === "ellipse") {
        const cx = (start.x + to.x) / 2, cy = (start.y + to.y) / 2;
        ctx.beginPath(); ctx.ellipse(cx, cy, Math.abs(to.x - start.x) / 2, Math.abs(to.y - start.y) / 2, 0, 0, Math.PI * 2); ctx.stroke();
      } else {
        const x = Math.min(start.x, to.x), y = Math.min(start.y, to.y);
        const w = Math.abs(to.x - start.x), h = Math.abs(to.y - start.y);
        const r = Math.min(w, h) * .22;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h * .82, r);
        const tailX = x + w * .25, tailY = y + h * .82;
        ctx.moveTo(tailX, tailY); ctx.lineTo(tailX + w * .04, y + h); ctx.lineTo(tailX + w * .18, tailY);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    if (tool === "highlight") {
      ctx.save(); ctx.strokeStyle = color; ctx.globalAlpha = .32; ctx.lineWidth = size * 5; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.restore(); return;
    }
    if (tool === "pixelate") {
      const radius = size * 4, block = Math.max(6, size * 2);
      ctx.save();
      for (let y = to.y - radius; y < to.y + radius; y += block) for (let x = to.x - radius; x < to.x + radius; x += block) {
        const px = Math.max(0, Math.min(canvas.width - 1, Math.round(x + block / 2)));
        const py = Math.max(0, Math.min(canvas.height - 1, Math.round(y + block / 2)));
        const d = ctx.getImageData(px, py, 1, 1).data; ctx.fillStyle = `rgb(${d[0]},${d[1]},${d[2]})`; ctx.fillRect(x, y, block + 1, block + 1);
      }
      ctx.restore(); return;
    }
    if (tool === "blur") {
      const radius = size * 3;
      ctx.save();
      ctx.beginPath();
      ctx.arc(to.x, to.y, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.filter = "blur(12px)";
      ctx.drawImage(canvas, to.x - radius, to.y - radius, radius * 2, radius * 2, to.x - radius, to.y - radius, radius * 2, radius * 2);
      ctx.restore();
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!ready || tool === "view") return;
    const point = pointFor(event);
    if (tool === "marker") {
      const canvas = canvasRef.current, ctx = context(); if (!canvas || !ctx) return; snapshot();
      const n = undoRef.current.length; const r = Math.max(16, canvas.width / 45);
      ctx.save(); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(point.x, point.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "white"; ctx.font = `700 ${Math.round(r * 1.25)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(n), point.x, point.y); ctx.restore(); return;
    }
    if (tool === "text") {
      const text = window.prompt("ใส่ข้อความ");
      if (!text?.trim()) return;
      const canvas = canvasRef.current;
      const ctx = context();
      if (!canvas || !ctx) return;
      snapshot();
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,.75)";
      ctx.lineWidth = Math.max(3, canvas.width / 380);
      ctx.font = `700 ${Math.max(22, Math.round(canvas.width / 24))}px sans-serif`;
      ctx.textBaseline = "top";
      ctx.strokeText(text.trim(), point.x, point.y);
      ctx.fillText(text.trim(), point.x, point.y);
      ctx.restore();
      return;
    }
    snapshot();
    drawingRef.current = true;
    lastPointRef.current = point;
    if (["line", "arrow", "rect", "ellipse", "bubble"].includes(tool)) {
      const canvas = canvasRef.current;
      const ctx = context();
      if (canvas && ctx) shapeBaseRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      shapeStartRef.current = point;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    draw(point, point);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current || !lastPointRef.current) return;
    const point = pointFor(event);
    draw(lastPointRef.current, point);
    lastPointRef.current = point;
  }

  function stopDrawing() {
    drawingRef.current = false;
    lastPointRef.current = null;
    shapeBaseRef.current = null;
    shapeStartRef.current = null;
  }

  function undo() {
    const canvas = canvasRef.current;
    const ctx = context();
    const previous = undoRef.current.pop();
    if (!canvas || !ctx || !previous) return;
    redoRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    ctx.putImageData(previous, 0, 0);
    setUndoCount(undoRef.current.length);
    setRedoCount(redoRef.current.length);
  }

  function redo() {
    const canvas = canvasRef.current;
    const ctx = context();
    const next = redoRef.current.pop();
    if (!canvas || !ctx || !next) return;
    undoRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    ctx.putImageData(next, 0, 0);
    setUndoCount(undoRef.current.length);
    setRedoCount(redoRef.current.length);
  }

  function clearEdits() {
    initialiseCanvas();
  }

  async function copyImage() {
    const canvas = canvasRef.current;
    if (!canvas || !navigator.clipboard || typeof ClipboardItem === "undefined") return;
    canvas.toBlob(async (blob) => { if (blob) await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); }, "image/png");
  }

  function saveImage() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `liney-edited-${Date.now()}.png`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }, "image/png");
  }

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  function setTheme(mode: ThemeMode) { setThemeMode(mode); localStorage.setItem("liney-image-editor-theme", mode); }
  function toggleTheme() { setTheme(dark ? "light" : "dark"); }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === "Escape") onClose();
      else if (mod && key === "z" && event.shiftKey) { event.preventDefault(); redo(); }
      else if (mod && key === "z") { event.preventDefault(); undo(); }
      else if (mod && key === "y") { event.preventDefault(); redo(); }
      else if (mod && event.shiftKey && key === "l") { event.preventDefault(); toggleTheme(); }
      else if (mod && key === "s") { event.preventDefault(); saveImage(); }
      else if (mod && key === "c") { event.preventDefault(); void copyImage(); }
      else if (key === "v" || key === "1") setTool("view");
      else if (key === "d" || key === "2") setTool("draw");
      else if (key === "l" || key === "3") setTool("line");
      else if (key === "a" || key === "4") setTool("arrow");
      else if (key === "r" || key === "5") setTool("rect");
      else if (key === "e" || key === "6") setTool("ellipse");
      else if (key === "q" || key === "7") setTool("bubble");
      else if (key === "h") setTool("highlight");
      else if (key === "m") setTool("marker");
      else if (key === "x") setTool("pixelate");
      else if (key === "b" || key === "8") setTool("blur");
      else if (key === "t" || key === "9") setTool("text");
      else if (key === "0") setZoom(1);
      else if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(3, Number((value + 0.2).toFixed(1))));
      else if (event.key === "-") setZoom((value) => Math.max(0.4, Number((value - 0.2).toFixed(1))));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <motion.div className={`image-viewer-overlay ${dark ? "theme-dark" : "theme-light"}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button className="image-viewer-backdrop" type="button" aria-label="ปิดหน้าดูรูปภาพ" onClick={onClose} />
      <main className="image-viewer-window" role="dialog" aria-modal="true" aria-label="ดูรูปภาพ">
      <header className="image-viewer-toolbar">
        <strong>Image Editor</strong>
        <div>
          <button className={tool === "view" ? "active" : ""} type="button" title="Pointer / View (V / 1)" onClick={() => setTool("view")}><MousePointer2 size={17}/><span>Pointer</span></button>
          <button className={tool === "draw" ? "active" : ""} type="button" title="Draw (D / 2)" onClick={() => setTool("draw")}><Pencil size={17}/><span>Draw</span></button>
          <button className={tool === "line" ? "active" : ""} type="button" title="Line (L / 3)" onClick={() => setTool("line")}><Minus size={17}/><span>Line</span></button>
          <button className={tool === "arrow" ? "active" : ""} type="button" title="Arrow (A / 4)" onClick={() => setTool("arrow")}><ArrowUpRight size={17}/><span>Arrow</span></button>
          <button className={tool === "rect" ? "active" : ""} type="button" title="Rectangle (R / 5)" onClick={() => setTool("rect")}><Square size={17}/><span>Rectangle</span></button>
          <button className={tool === "ellipse" ? "active" : ""} type="button" title="Ellipse (E / 6)" onClick={() => setTool("ellipse")}><Circle size={17}/><span>Ellipse</span></button>
          <button className={tool === "bubble" ? "active" : ""} type="button" title="Speech Bubble (Q / 7)" onClick={() => setTool("bubble")}><span className="bubble-tool-icon">▢</span><span>Bubble</span></button>
          <button className={tool === "highlight" ? "active" : ""} type="button" title="Highlight (H)" onClick={() => setTool("highlight")}><Highlighter size={17}/><span>Highlight</span></button>
          <button className={tool === "marker" ? "active" : ""} type="button" title="Number Marker (M)" onClick={() => setTool("marker")}><span>①</span></button>
          <button className={tool === "pixelate" ? "active" : ""} type="button" title="Pixelate (X)" onClick={() => setTool("pixelate")}><Sparkles size={17}/><span>Pixelate</span></button>
          <button className={tool === "blur" ? "active" : ""} type="button" title="Blur (B / 8)" onClick={() => setTool("blur")}><Sparkles size={17}/><span>Blur</span></button>
          <button className={tool === "text" ? "active" : ""} type="button" title="Text (T / 9)" onClick={() => setTool("text")}><ScanText size={17}/><span>Text</span></button>
          <button type="button" title="Undo (Ctrl+Z)" disabled={!undoCount} onClick={undo}><Undo2 size={17} /></button>
          <button type="button" title="Redo (Ctrl+Y / Ctrl+Shift+Z)" disabled={!redoCount} onClick={redo}><Redo2 size={17} /></button>
          <label className="image-editor-color" title="เลือกสี"><span style={{ background: color }} /><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
          <button type="button" title="ล้างการแก้ไข" disabled={!ready} onClick={clearEdits}><Trash size={17} /></button>
          <button type="button" title="Copy image (Ctrl+C)" disabled={!ready} onClick={() => void copyImage()}><Copy size={17}/><span>Copy</span></button>
          <button type="button" title="บันทึกรูปที่แก้ไข (Ctrl+S)" disabled={!ready} onClick={saveImage}><Save size={17}/><span>Save</span></button>
          <button type="button" title="ย่อ" onClick={() => setZoom((value) => Math.max(0.4, Number((value - 0.2).toFixed(1))))}><Minus size={17} /></button>
          <button type="button" title="ขนาดจริง (0)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" title="ขยาย" onClick={() => setZoom((value) => Math.min(3, Number((value + 0.2).toFixed(1))))}><Plus size={17} /></button>
          <button type="button" title={`Theme: ${themeMode} (Ctrl+Shift+L)`} onClick={toggleTheme}>{dark ? <Sun size={17}/> : <Moon size={17}/>}</button>
          <button type="button" title="ปิด (Esc)" onClick={onClose}><X size={17} /></button>
        </div>
      </header>
      <section className="image-viewer-canvas">
        <img ref={sourceRef} className="image-viewer-source" src={src} alt="" onLoad={initialiseCanvas} onError={() => setError("ไม่สามารถโหลดไฟล์รูปภาพนี้ได้")} />
        <canvas ref={canvasRef} className={`image-editor-canvas ${tool !== "view" && tool !== "text" && tool !== "marker" ? "editing" : ""}`} style={{ transform: `scale(${zoom})` }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stopDrawing} onPointerCancel={stopDrawing} />
        {!ready && !error ? <span>กำลังเปิดรูปภาพ…</span> : null}
        {error ? <span className="image-viewer-error">{error}</span> : null}
      </section>
      <footer className="image-editor-statusbar">
        <div className="status-group colors" aria-label="Quick colors">
          {["#ef4444","#f97316","#eab308","#22c55e","#06b6d4","#3b82f6","#8b5cf6","#ec4899","#ffffff","#111111"].map((c) => <button key={c} type="button" className={color === c ? "selected" : ""} style={{ background: c }} title={c} onClick={() => setColor(c)} />)}
          <label className="status-custom-color" title="Custom color"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /><span style={{ background: color }} /></label>
        </div>
        <div className="status-group stroke-sizes" aria-label="Stroke size">
          <button className={strokeScale === .65 ? "active" : ""} onClick={() => setStrokeScale(.65)}>S</button>
          <button className={strokeScale === 1 ? "active" : ""} onClick={() => setStrokeScale(1)}>M</button>
          <button className={strokeScale === 1.6 ? "active" : ""} onClick={() => setStrokeScale(1.6)}>L</button>
        </div>
        <div className="status-spacer" />
        <div className="status-group zoom-controls">
          <button type="button" title="Zoom out (-)" onClick={() => setZoom((v) => Math.max(.4, Number((v-.2).toFixed(1))))}><Minus size={14}/></button>
          <button type="button" title="100% (0)" onClick={() => setZoom(1)}>{Math.round(zoom*100)}%</button>
          <button type="button" title="Zoom in (+)" onClick={() => setZoom((v) => Math.min(3, Number((v+.2).toFixed(1))))}><Plus size={14}/></button>
        </div>
        <div className="status-group dimensions">{dimensions ? `${dimensions.width} × ${dimensions.height}` : "—"}</div>
      </footer>
      </main>
    </motion.div>
  );
}
