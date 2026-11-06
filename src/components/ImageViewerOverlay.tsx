import { motion } from "motion/react";
import { useAppTranslation } from "../lib/i18n";
import { Minus, Plus, Trash, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type ImageEditorTool = "view" | "draw" | "blur" | "text";

export function ImageViewerOverlay({ src, onClose }: { src: string; onClose: () => void }) {
  const { t } = useAppTranslation();
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<ImageEditorTool>("view");
  const [ready, setReady] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const sourceRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const undoRef = useRef<ImageData[]>([]);

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
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    undoRef.current = [];
    setUndoCount(0);
    setReady(true);
  }

  function draw(from: { x: number; y: number }, to: { x: number; y: number }) {
    const canvas = canvasRef.current;
    const ctx = context();
    if (!canvas || !ctx) return;
    const size = Math.max(5, Math.round(canvas.width / 180));
    if (tool === "draw") {
      ctx.save();
      ctx.strokeStyle = "#22c55e";
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
    if (tool === "text") {
      const text = window.prompt(t("Enter text"));
      if (!text?.trim()) return;
      const canvas = canvasRef.current;
      const ctx = context();
      if (!canvas || !ctx) return;
      snapshot();
      ctx.save();
      ctx.fillStyle = "#ffffff";
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
  }

  function undo() {
    const canvas = canvasRef.current;
    const ctx = context();
    const previous = undoRef.current.pop();
    if (!canvas || !ctx || !previous) return;
    ctx.putImageData(previous, 0, 0);
    setUndoCount(undoRef.current.length);
  }

  function clearEdits() {
    initialiseCanvas();
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "+" || event.key === "=") setZoom((value) => Math.min(3, Number((value + 0.2).toFixed(1))));
      if (event.key === "-") setZoom((value) => Math.max(0.4, Number((value - 0.2).toFixed(1))));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <motion.div className="image-viewer-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button className="image-viewer-backdrop" type="button" aria-label={t("Close image viewer")} onClick={onClose} />
      <main className="image-viewer-window" role="dialog" aria-modal="true" aria-label={t("Image viewer")}>
      <header className="image-viewer-toolbar">
        <strong>{t("Image viewer")}</strong>
        <div>
          <button className={tool === "view" ? "active" : ""} type="button" title={t("Pan image")} onClick={() => setTool("view")}>{t("View")}</button>
          <button className={tool === "draw" ? "active" : ""} type="button" title={t("Draw")} onClick={() => setTool("draw")}>{t("Draw")}</button>
          <button className={tool === "blur" ? "active" : ""} type="button" title={t("Blur")} onClick={() => setTool("blur")}>{t("Blur")}</button>
          <button className={tool === "text" ? "active" : ""} type="button" title={t("Add text")} onClick={() => setTool("text")}>{t("Text")}</button>
          <button type="button" title={t("Undo")} disabled={!undoCount} onClick={undo}><Undo2 size={17} /></button>
          <button type="button" title={t("Clear edits")} disabled={!ready} onClick={clearEdits}><Trash size={17} /></button>
          <button type="button" title={t("Save edited image")} disabled={!ready} onClick={saveImage}>{t("Save")}</button>
          <button type="button" title={t("Zoom out")} onClick={() => setZoom((value) => Math.max(0.4, Number((value - 0.2).toFixed(1))))}><Minus size={17} /></button>
          <button type="button" title={t("Actual size")} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button type="button" title={t("Zoom in")} onClick={() => setZoom((value) => Math.min(3, Number((value + 0.2).toFixed(1))))}><Plus size={17} /></button>
          <button type="button" title={t("Close")} onClick={onClose}><X size={17} /></button>
        </div>
      </header>
      <section className="image-viewer-canvas">
        <img ref={sourceRef} className="image-viewer-source" src={src} alt="" onLoad={initialiseCanvas} onError={() => setError(t("Unable to load this image file"))} />
        <canvas ref={canvasRef} className={`image-editor-canvas ${tool === "draw" || tool === "blur" ? "editing" : ""}`} style={{ transform: `scale(${zoom})` }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stopDrawing} onPointerCancel={stopDrawing} />
        {!ready && !error ? <span>{t("Opening image…")}</span> : null}
        {error ? <span className="image-viewer-error">{error}</span> : null}
      </section>
      </main>
    </motion.div>
  );
}
