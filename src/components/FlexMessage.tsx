import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useState } from "react";
import type { FlexMessageData } from "../data/mock";
import { RemoteImage } from "./RemoteImage";

type FlexNode = Record<string, unknown>;

export type FlexAction = FlexNode;
export type FlexActionHandler = (action: FlexAction) => void | Promise<void>;

type FlexLayout = "horizontal" | "vertical" | "baseline";
type FlexContext = {
  onAction?: FlexActionHandler;
  parentLayout?: FlexLayout;
  inheritedTextDecoration?: CSSProperties["textDecoration"];
  inheritedScaling?: boolean;
};

const spacing: Record<string, number> = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 42,
};

const borderWidths: Record<string, number> = {
  none: 0,
  light: 1,
  normal: 2,
  medium: 3,
  "semi-bold": 4,
  bold: 5,
};

const cornerRadii: Record<string, number> = {
  none: 0,
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
};

const textSizes: Record<string, number> = {
  xxs: 10,
  xs: 11,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 42,
};

const imageSizes: Record<string, number | string> = {
  xxs: 20,
  xs: 32,
  sm: 48,
  md: 64,
  lg: 80,
  xl: 100,
  xxl: 120,
  "3xl": 140,
  "4xl": 180,
  "5xl": 220,
  full: "100%",
};

const bubbleSizes: Record<string, number> = {
  nano: 56,
  micro: 92,
  deca: 180,
  hecto: 220,
  kilo: 280,
  mega: 360,
  giga: 460,
};

function asRecord(value: unknown): FlexNode | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as FlexNode
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeColor(value: unknown): string | undefined {
  const color = asString(value).trim();
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : undefined;
}

function safeDimension(value: unknown, allowSpacing = true): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(value, 1200));
  const text = asString(value).trim().toLowerCase();
  if (!text) return undefined;
  if (allowSpacing && text in spacing) return `${spacing[text]}px`;
  if (/^\d+(?:\.\d+)?(?:px|%|em|rem)?$/.test(text)) return text;
  return undefined;
}

function semanticDimension(value: unknown, values: Record<string, number>): string | number | undefined {
  const text = asString(value).trim().toLowerCase();
  if (text in values) return `${values[text]}px`;
  return safeDimension(value, false);
}

function safeFlex(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 20 ? number : undefined;
}

function safeUrl(value: unknown, protocols: string[]): string | undefined {
  const raw = asString(value).trim();
  if (!raw || raw.length > 2000) return undefined;
  try {
    const url = new URL(raw);
    return protocols.includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function imageUrl(value: unknown): string | undefined {
  // LINE Flex assets are HTTPS URLs. Never render javascript:, data:, file:, or
  // other payload-controlled schemes in the desktop WebView.
  return safeUrl(value, ["https:"]);
}

function videoUrl(value: unknown): string | undefined {
  return safeUrl(value, ["https:"]);
}

function actionType(action: unknown): string {
  return asString(asRecord(action)?.type).trim().toLowerCase();
}

function actionUri(action: unknown): string | undefined {
  const value = asRecord(action);
  if (!value || actionType(value) !== "uri") return undefined;
  const desktopUri = asRecord(value.altUri)?.desktop;
  const desktop = safeUrl(desktopUri, ["https:", "http:", "line:", "tel:", "mailto:"]);
  const primary = safeUrl(value.uri, ["https:", "http:", "line:", "tel:", "mailto:"]);
  // Official Account cards often provide a line:// desktop deep link plus an
  // https://liff.line.me fallback.  Linux does not have a LINE URL handler,
  // so choose the browser-safe URL before the Line-only desktop shortcut.
  if (desktop?.startsWith("https:") || desktop?.startsWith("http:")) return desktop;
  return primary ?? desktop;
}

function actionLabel(action: unknown): string {
  const value = asRecord(action);
  const explicit = asString(value?.label).trim();
  if (explicit) return explicit;
  switch (actionType(action)) {
    case "message": return asString(value?.text) || "ส่งข้อความ";
    case "clipboard": return "คัดลอก";
    case "datetimepicker": return "เลือกวันเวลา";
    case "postback": return "ดำเนินการ";
    default: return "เปิด";
  }
}

function actionTitle(action: unknown): string {
  switch (actionType(action)) {
    case "message": return "ส่งข้อความนี้ในห้องแชต";
    case "clipboard": return "คัดลอกข้อความไปยัง clipboard";
    case "datetimepicker": return "เลือกวันเวลาสำหรับการดำเนินการนี้";
    case "postback": return "ดำเนินการกับ LINE Official Account";
    case "camera": return "เปิดกล้อง";
    case "cameraroll": return "เลือกรูปภาพจากเครื่อง";
    case "location": return "เปิดตำแหน่งที่ตั้ง";
    case "richmenuswitch": return "สลับ Rich Menu";
    default: return "ดำเนินการกับ Flex Message";
  }
}

function safeAspectRatio(value: unknown): string | undefined {
  const raw = asString(value).trim();
  const match = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 100000 || height > 100000 || height > width * 3) return undefined;
  return `${width} / ${height}`;
}

function safeAngle(value: unknown): string | undefined {
  const raw = typeof value === "number" ? `${value}deg` : asString(value).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)deg$/.exec(raw);
  if (!match) return undefined;
  const angle = Number(match[1]);
  return Number.isFinite(angle) && angle >= 0 && angle < 360 ? `${angle}deg` : undefined;
}

function safePosition(value: unknown): string | undefined {
  const raw = typeof value === "number" ? `${value}%` : asString(value).trim();
  const match = /^(\d+(?:\.\d+)?)%$/.exec(raw);
  if (!match) return undefined;
  const position = Number(match[1]);
  return Number.isFinite(position) && position >= 0 && position <= 100 ? `${position}%` : undefined;
}

function gradientStyle(value: unknown): CSSProperties {
  const background = asRecord(value);
  if (asString(background?.type).toLowerCase() !== "lineargradient") return {};
  const angle = safeAngle(background?.angle);
  const startColor = safeColor(background?.startColor);
  const endColor = safeColor(background?.endColor);
  if (!angle || !startColor || !endColor) return {};
  const centerColor = safeColor(background?.centerColor);
  const centerPosition = safePosition(background?.centerPosition) ?? "50%";
  const gradient = centerColor
    ? `linear-gradient(${angle}, ${startColor} 0%, ${centerColor} ${centerPosition}, ${endColor} 100%)`
    : `linear-gradient(${angle}, ${startColor} 0%, ${endColor} 100%)`;
  return { backgroundImage: gradient };
}

function gravityValue(value: unknown): CSSProperties["alignSelf"] {
  const map: Record<string, CSSProperties["alignSelf"]> = {
    top: "flex-start",
    center: "center",
    bottom: "flex-end",
  };
  return map[asString(value).toLowerCase()] ?? undefined;
}

function alignValue(value: unknown): CSSProperties["textAlign"] {
  const map: Record<string, CSSProperties["textAlign"]> = { start: "left", center: "center", end: "right" };
  return map[asString(value).toLowerCase()] ?? undefined;
}

function justifyValue(value: unknown): CSSProperties["justifyContent"] {
  const map: Record<string, CSSProperties["justifyContent"]> = {
    start: "flex-start",
    "flex-start": "flex-start",
    center: "center",
    end: "flex-end",
    "flex-end": "flex-end",
    space: "space-between",
    "space-between": "space-between",
    "space-around": "space-around",
    "space-evenly": "space-evenly",
  };
  return map[asString(value).toLowerCase()] ?? undefined;
}

function alignItemsValue(value: unknown): CSSProperties["alignItems"] {
  const map: Record<string, CSSProperties["alignItems"]> = {
    start: "flex-start",
    "flex-start": "flex-start",
    center: "center",
    end: "flex-end",
    "flex-end": "flex-end",
    baseline: "baseline",
    stretch: "stretch",
  };
  return map[asString(value).toLowerCase()] ?? undefined;
}

function nodeStyle(node: FlexNode, context: FlexContext): CSSProperties {
  const style: CSSProperties = { ...gradientStyle(node.background) };
  const backgroundColor = safeColor(node.backgroundColor);
  const color = safeColor(node.color);
  const borderColor = safeColor(node.borderColor);
  if (backgroundColor) style.backgroundColor = backgroundColor;
  if (color) style.color = color;
  if (borderColor) style.borderColor = borderColor;

  const borderWidth = semanticDimension(node.borderWidth, borderWidths);
  if (borderWidth !== undefined) {
    if (borderWidth === "0px" || borderWidth === 0) style.borderStyle = "none";
    else {
      style.borderStyle = "solid";
      style.borderWidth = borderWidth;
    }
  }
  const cornerRadius = semanticDimension(node.cornerRadius, cornerRadii);
  if (cornerRadius !== undefined) style.borderRadius = cornerRadius;

  const margin = safeDimension(node.margin);
  if (margin !== undefined) style.margin = margin;
  const paddingAll = safeDimension(node.paddingAll);
  if (paddingAll !== undefined) style.padding = paddingAll;
  else {
    const paddingVertical = safeDimension(node.paddingVertical);
    const paddingHorizontal = safeDimension(node.paddingHorizontal);
    const paddingTop = safeDimension(node.paddingTop);
    const paddingBottom = safeDimension(node.paddingBottom);
    const paddingStart = safeDimension(node.paddingStart);
    const paddingEnd = safeDimension(node.paddingEnd);
    if (paddingVertical !== undefined) {
      style.paddingTop = paddingVertical;
      style.paddingBottom = paddingVertical;
    }
    if (paddingHorizontal !== undefined) {
      style.paddingLeft = paddingHorizontal;
      style.paddingRight = paddingHorizontal;
    }
    if (paddingTop !== undefined) style.paddingTop = paddingTop;
    if (paddingBottom !== undefined) style.paddingBottom = paddingBottom;
    if (paddingStart !== undefined) style.paddingInlineStart = paddingStart;
    if (paddingEnd !== undefined) style.paddingInlineEnd = paddingEnd;
  }

  const width = safeDimension(node.width, false);
  const maxWidth = safeDimension(node.maxWidth, false);
  const height = safeDimension(node.height, false);
  const maxHeight = safeDimension(node.maxHeight, false);
  if (width !== undefined) style.width = width;
  if (maxWidth !== undefined) style.maxWidth = maxWidth;
  if (height !== undefined) style.height = height;
  if (maxHeight !== undefined) style.maxHeight = maxHeight;

  const flex = safeFlex(node.flex);
  if (flex !== undefined) style.flex = flex === 0 ? "0 0 auto" : `${flex} 0 0`;
  else if (context.parentLayout === "horizontal") style.flex = "1 1 0";

  const position = asString(node.position).toLowerCase();
  const offsets: Array<[keyof CSSProperties, unknown]> = [
    ["top", node.offsetTop],
    ["bottom", node.offsetBottom],
    ["insetInlineStart", node.offsetStart],
    ["insetInlineEnd", node.offsetEnd],
  ];
  const hasOffset = offsets.some(([, value]) => safeDimension(value, false) !== undefined);
  if (position === "absolute" || position === "relative") style.position = position;
  else if (hasOffset) style.position = "relative";
  for (const [property, value] of offsets) {
    const dimension = safeDimension(value, false);
    if (dimension !== undefined) style[property] = dimension as never;
  }

  const opacity = Number(node.opacity);
  if (Number.isFinite(opacity) && opacity >= 0 && opacity <= 1) style.opacity = opacity;
  return style;
}

function componentStyle(node: FlexNode, context: FlexContext): CSSProperties {
  const style = nodeStyle(node, context);
  const gravity = gravityValue(node.gravity);
  if (gravity) style.alignSelf = gravity;
  return style;
}

function regionStyle(styles: FlexNode | undefined, name: string, canSeparate: boolean): CSSProperties | undefined {
  const block = asRecord(styles?.[name]);
  if (!block) return undefined;
  const style: CSSProperties = {};
  const color = safeColor(block.backgroundColor);
  if (color) style.backgroundColor = color;
  if (canSeparate && block.separator === true) {
    style.borderTop = `1px solid ${safeColor(block.separatorColor) ?? "#e2e7eb"}`;
  }
  return style;
}

async function copyText(text: string): Promise<void> {
  if (!text || typeof navigator === "undefined") return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy WebView clipboard path.
  }
  if (typeof document === "undefined") return;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try { document.execCommand("copy"); } catch { /* clipboard permission is optional */ }
  textarea.remove();
}

function notifyAction(action: FlexNode, context: FlexContext, value?: string): void {
  const nextAction = value === undefined ? action : { ...action, value };
  if (actionType(action) === "clipboard") void copyText(asString(action.clipboardText));
  if (!context.onAction) return;
  try {
    void Promise.resolve(context.onAction(nextAction)).catch(() => undefined);
  } catch {
    // A failed action must not take down the message renderer.
  }
}

function onActionKeyDown(event: KeyboardEvent<HTMLDivElement>, activate: () => void): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activate();
}

function flexItemStyle(style: CSSProperties): CSSProperties {
  return {
    flex: style.flex,
    width: style.width,
    maxWidth: style.maxWidth,
    height: style.height,
    maxHeight: style.maxHeight,
  };
}

function FlexAction({
  action,
  children,
  className,
  style,
  context,
}: {
  action: unknown;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  context: FlexContext;
}) {
  const value = asRecord(action);
  if (!value) return <>{children}</>;
  const uri = actionUri(value);
  const label = actionLabel(value);
  if (uri) {
    return (
      <a
        className={`${className ?? ""} flex-action-link`}
        href={uri}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={label}
        title={label}
        style={style}
        onClick={(event) => {
          // Tauri's WebView does not reliably hand target=_blank links to the
          // desktop browser.  Delegate to the app so it can use the native
          // opener, while retaining a normal anchor for accessibility/fallback.
          event.preventDefault();
          event.stopPropagation();
          notifyAction(value, context);
        }}
      >
        {children}
      </a>
    );
  }
  const interactive = Boolean(context.onAction) || actionType(value) === "clipboard";
  const activate = () => {
    if (interactive) notifyAction(value, context);
  };
  return (
    <div
      className={`${className ?? ""} flex-action-surface`}
      style={style}
      role="button"
      tabIndex={interactive ? 0 : -1}
      aria-label={label}
      aria-disabled={interactive ? undefined : true}
      title={actionTitle(value)}
      onClick={(event) => {
        event.stopPropagation();
        activate();
      }}
      onKeyDown={(event) => onActionKeyDown(event, activate)}
    >
      {children}
    </div>
  );
}

function imageFrameStyle(node: FlexNode, context: FlexContext, icon: boolean): CSSProperties {
  const component = componentStyle(node, context);
  const style: CSSProperties = {
    ...component,
    position: component.position ?? "relative",
    overflow: "hidden",
  };
  const requestedSize = asString(node.size).toLowerCase();
  if (style.width === undefined && imageSizes[requestedSize] !== undefined) style.width = imageSizes[requestedSize];
  const aspectRatio = safeAspectRatio(node.aspectRatio);
  if (aspectRatio) style.aspectRatio = aspectRatio;
  if (icon) {
    style.flex = "0 0 auto";
    style.width = style.width ?? imageSizes.md;
    style.height = style.height ?? style.width;
  }
  const align = alignValue(node.align);
  if (align === "left") style.marginInlineEnd = "auto";
  else if (align === "center") {
    style.marginInlineStart = "auto";
    style.marginInlineEnd = "auto";
  } else if (align === "right") style.marginInlineStart = "auto";
  return style;
}

function FlexImage({ node, context, icon = false }: { node: FlexNode; context: FlexContext; icon?: boolean }) {
  const url = imageUrl(node.url);
  const [failed, setFailed] = useState(false);
  const alt = asString(node.altText ?? node.text) || "Flex image";
  const frameStyle = imageFrameStyle(node, context, icon);
  const aspectRatio = safeAspectRatio(node.aspectRatio);
  const imageStyle: CSSProperties = {
    display: "block",
    width: "100%",
    height: aspectRatio ? "100%" : "auto",
    objectFit: asString(node.aspectMode).toLowerCase() === "cover" ? "cover" : "contain",
  };
  const placeholder = (
    <div className={`flex-image-placeholder ${icon ? "flex-icon-placeholder" : ""}`}>
      {alt}
    </div>
  );
  const content = (
    <div className={`flex-image-frame ${icon ? "flex-icon-frame" : ""}`} style={frameStyle}>
      {!url || failed ? placeholder : (
        <RemoteImage
          className={icon ? "flex-icon" : "flex-image"}
          src={url}
          alt={alt}
          animated={node.animated === true}
          loading="lazy"
          style={imageStyle}
          fallback={placeholder}
          onStatus={(status) => setFailed(status === "failed")}
        />
      )}
    </div>
  );
  return <FlexAction action={node.action} className="flex-action-image" style={flexItemStyle(frameStyle)} context={context}>{content}</FlexAction>;
}

function FlexVideo({ node, context }: { node: FlexNode; context: FlexContext }) {
  const url = videoUrl(node.url);
  const previewUrl = imageUrl(node.previewUrl);
  const [failed, setFailed] = useState(false);
  const frameStyle: CSSProperties = {
    ...componentStyle(node, context),
    position: "relative",
    overflow: "hidden",
    aspectRatio: safeAspectRatio(node.aspectRatio) ?? "1 / 1",
  };
  const altContent = asRecord(node.altContent);
  if (!url || failed) {
    return altContent
      ? <FlexNodeView node={altContent} context={context} />
      : <div className="flex-unsupported" style={frameStyle}>วิดีโอ Flex โหลดไม่ได้</div>;
  }
  const video = (
    <div className="flex-video-frame" style={frameStyle}>
      <video
        className="flex-video"
        src={url}
        poster={previewUrl}
        controls
        playsInline
        preload="metadata"
        aria-label={asString(node.altText) || "Flex video"}
        onError={() => setFailed(true)}
      />
    </div>
  );
  return <FlexAction action={node.action} className="flex-action-video" style={flexItemStyle(frameStyle)} context={context}>{video}</FlexAction>;
}

function textDecoration(value: unknown): CSSProperties["textDecoration"] {
  const map: Record<string, CSSProperties["textDecoration"]> = {
    none: "none",
    underline: "underline",
    "line-through": "line-through",
  };
  return map[asString(value).toLowerCase()] ?? undefined;
}

function fontSizeFor(node: FlexNode, fallback: number, scaling: boolean): CSSProperties["fontSize"] {
  const key = asString(node.size).trim().toLowerCase();
  const base = textSizes[key] ?? fallback;
  const size = scaling ? `calc(${base}px * var(--liney-flex-scale, 1))` : `${base}px`;
  return asString(node.adjustMode).toLowerCase() === "shrink-to-fit"
    ? `min(${size}, 100%)`
    : size;
}

function FlexSpan({ node, context }: { node: FlexNode; context: FlexContext }) {
  const inheritedDecoration = context.inheritedTextDecoration;
  const style: CSSProperties = {
    color: safeColor(node.color),
    fontSize: fontSizeFor(node, 13, context.inheritedScaling === true),
    fontWeight: asString(node.weight).toLowerCase() === "bold" ? 700 : 400,
    fontStyle: asString(node.style).toLowerCase() === "italic" ? "italic" : undefined,
    textDecoration: inheritedDecoration ?? textDecoration(node.decoration),
  };
  return <span className="flex-span" style={style}>{asString(node.text)}</span>;
}

function FlexText({ node, context, inline = false }: { node: FlexNode; context: FlexContext; inline?: boolean }) {
  const children = Array.isArray(node.contents) ? node.contents : [];
  const decoration = textDecoration(node.decoration);
  const wrap = node.wrap === true;
  const style: CSSProperties = {
    ...componentStyle(node, context),
    display: inline ? "inline" : "block",
    fontSize: fontSizeFor(node, inline ? 13 : 14, node.scaling === true || context.inheritedScaling === true),
    fontWeight: asString(node.weight).toLowerCase() === "bold" ? 700 : 400,
    fontStyle: asString(node.style).toLowerCase() === "italic" ? "italic" : undefined,
    textAlign: alignValue(node.align),
    whiteSpace: wrap ? "pre-wrap" : "nowrap",
    overflow: inline ? "visible" : "hidden",
    textDecoration: decoration,
  };
  const lineSpacing = safeDimension(node.lineSpacing, false);
  if (lineSpacing !== undefined && wrap) style.lineHeight = `calc(1em + ${lineSpacing})`;
  const maxLines = Number(node.maxLines);
  if (!inline && Number.isInteger(maxLines) && maxLines > 0) {
    style.display = "-webkit-box";
    style.WebkitLineClamp = maxLines;
    style.WebkitBoxOrient = "vertical";
  }
  const childContext: FlexContext = {
    ...context,
    inheritedTextDecoration: decoration,
    inheritedScaling: node.scaling === true || context.inheritedScaling === true,
  };
  const content = children.length
    ? children.map((child, index) => <FlexNodeView key={index} node={asRecord(child) ?? {}} context={childContext} inline />)
    : asString(node.text);
  const text = <span className={`flex-text ${inline ? "flex-inline-text" : ""}`} style={style}>{content}</span>;
  return node.action ? <FlexAction action={node.action} className="flex-text-action" context={context} style={flexItemStyle(style)}>{text}</FlexAction> : text;
}

function pickerValue(value: unknown, mode: string): string {
  const raw = asString(value).trim().replace("t", "T");
  if (mode === "date") return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
  if (mode === "time") return /^\d{2}:\d{2}$/.test(raw) ? raw : "";
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw.slice(0, 16)) ? raw.slice(0, 16) : "";
}

function FlexDatetimeButton({ action, context, outerStyle, labelStyle, label }: {
  action: FlexNode;
  context: FlexContext;
  outerStyle: CSSProperties;
  labelStyle: CSSProperties;
  label: string;
}) {
  const mode = asString(action.mode).toLowerCase();
  const inputType = mode === "date" ? "date" : mode === "time" ? "time" : mode === "datetime" ? "datetime-local" : "";
  const [value, setValue] = useState(() => pickerValue(action.initial, mode));
  if (!inputType) return <FlexAction action={action} className="flex-button" style={outerStyle} context={context}><span style={labelStyle}>{label}</span></FlexAction>;
  return (
    <label className="flex-button flex-button-picker" style={outerStyle} title={actionTitle(action)}>
      <span style={labelStyle}>{label}</span>
      <input
        type={inputType}
        value={value}
        min={pickerValue(action.min, mode) || undefined}
        max={pickerValue(action.max, mode) || undefined}
        aria-label={label}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setValue(next);
          if (next) notifyAction(action, context, next);
        }}
      />
    </label>
  );
}

function FlexButton({ node, context }: { node: FlexNode; context: FlexContext }) {
  const action = asRecord(node.action);
  const label = actionLabel(action);
  const variant = ["primary", "secondary", "link"].includes(asString(node.style).toLowerCase())
    ? asString(node.style).toLowerCase()
    : "link";
  const component = componentStyle(node, context);
  const outerStyle: CSSProperties = {
    ...component,
    width: node.width === undefined ? "100%" : component.width,
  };
  const buttonHeight = asString(node.height).toLowerCase() === "sm" ? "28px" : "38px";
  const buttonColor = safeColor(node.color);
  const labelStyle: CSSProperties = {
    minHeight: buttonHeight,
    backgroundColor: variant === "link" ? "transparent" : buttonColor ?? (variant === "primary" ? "#20b968" : "#eef4f0"),
    color: variant === "link" ? buttonColor ?? "#168b57" : variant === "primary" ? "#ffffff" : "#168b57",
    fontSize: fontSizeFor(node, 13, node.scaling === true),
  };
  if (variant === "link") labelStyle.textDecoration = "none";
  if (action && actionType(action) === "datetimepicker") {
    return <FlexDatetimeButton action={action} context={context} outerStyle={outerStyle} labelStyle={labelStyle} label={label} />;
  }
  return <FlexAction action={action} className={`flex-button flex-button-${variant}`} style={outerStyle} context={context}><span style={labelStyle}>{label}</span></FlexAction>;
}

function FlexNodeView({ node, context, inline = false }: { node: FlexNode; context: FlexContext; inline?: boolean }) {
  const type = asString(node.type).toLowerCase();
  if (type === "box") {
    const requestedLayout = asString(node.layout).toLowerCase();
    const layout: FlexLayout = requestedLayout === "horizontal" || requestedLayout === "baseline" ? requestedLayout : "vertical";
    const contents = Array.isArray(node.contents) ? node.contents : [];
    const style: CSSProperties = {
      ...nodeStyle(node, context),
      display: "flex",
      flexDirection: layout === "horizontal" || layout === "baseline" ? "row" : "column",
      alignItems: layout === "baseline" ? "baseline" : alignItemsValue(node.alignItems),
      justifyContent: justifyValue(node.justifyContent),
      gap: safeDimension(node.spacing),
      ...(asString(node.position).toLowerCase() === "absolute" ? {} : { position: "relative" }),
    };
    const childContext: FlexContext = { ...context, parentLayout: layout };
    const box = (
      <div className={`flex-box flex-layout-${layout}`} style={style}>
        {contents.map((child, index) => <FlexNodeView key={index} node={asRecord(child) ?? {}} context={childContext} />)}
      </div>
    );
    return <FlexAction action={node.action} className="flex-action-box" style={flexItemStyle(style)} context={context}>{box}</FlexAction>;
  }
  if (type === "text") return <FlexText node={node} context={context} inline={inline} />;
  if (type === "span") return <FlexSpan node={node} context={context} />;
  if (type === "image") return <FlexImage node={node} context={context} />;
  if (type === "icon") return <FlexImage node={{ ...node, size: node.size ?? "md", aspectMode: "fit" }} context={context} icon />;
  if (type === "video") return <FlexVideo node={node} context={context} />;
  if (type === "button") return <FlexButton node={node} context={context} />;
  if (type === "separator") {
    const horizontal = context.parentLayout === "horizontal";
    const separatorStyle: CSSProperties = {
      ...nodeStyle(node, { ...context, parentLayout: undefined }),
      flex: "0 0 auto",
      ...(horizontal ? { width: "1px", height: "100%", minHeight: "1em" } : { width: "100%", height: "1px", minHeight: "1px" }),
      backgroundColor: safeColor(node.color) ?? "#e1e5e8",
    };
    return <div className={`flex-separator ${horizontal ? "flex-separator-vertical" : ""}`} style={separatorStyle} />;
  }
  if (type === "spacer") {
    const dimension = safeDimension(node.size) ?? "8px";
    const horizontal = context.parentLayout === "horizontal";
    return <div className={`flex-spacer ${horizontal ? "flex-spacer-horizontal" : ""}`} style={horizontal ? { width: dimension, height: "1px" } : { height: dimension, width: "1px" }} />;
  }
  if (type === "filler") return <span className="flex-filler" style={{ flex: safeFlex(node.flex) === 0 ? "0 0 auto" : `${safeFlex(node.flex) ?? 1} 1 auto` }} />;
  if (type) return <div className="flex-unsupported">ไม่รองรับ Flex component: {type}</div>;
  return null;
}

function FlexBubble({ node, styles, context, carousel = false }: { node: FlexNode; styles?: FlexNode; context: FlexContext; carousel?: boolean }) {
  const size = asString(node.size).toLowerCase();
  const direction = asString(node.direction).toLowerCase() === "rtl" ? "rtl" : "ltr";
  const sections = ["header", "hero", "body", "footer"] as const;
  const bubbleStyle = { "--flex-bubble-width": `${bubbleSizes[size] ?? bubbleSizes.mega}px` } as CSSProperties;
  const bubble = (
    <article
      className={`flex-bubble ${carousel ? "flex-carousel-bubble" : ""} flex-size-${size || "mega"}`}
      dir={direction}
      style={bubbleStyle}
    >
      {sections.map((name, index) => {
        const section = asRecord(node[name]);
        if (!section) return null;
        return (
          <div className={`flex-region flex-region-${name}`} key={name} style={regionStyle(styles, name, index > 0)}>
            <FlexNodeView node={section} context={{ ...context, parentLayout: undefined }} />
          </div>
        );
      })}
    </article>
  );
  return <FlexAction action={node.action} className="flex-action-bubble" context={context}>{bubble}</FlexAction>;
}

function FlexRoot({ contents, context }: { contents: FlexNode; context: FlexContext }) {
  const type = asString(contents.type).toLowerCase();
  const styles = asRecord(contents.styles);
  if (type === "carousel") {
    const bubbles = Array.isArray(contents.contents) ? contents.contents : [];
    return (
      <div className="flex-carousel" dir={asString(contents.direction).toLowerCase() === "rtl" ? "rtl" : "ltr"}>
        {bubbles.map((bubble, index) => {
          const item = asRecord(bubble);
          return item ? <FlexBubble key={index} node={item} styles={styles} context={context} carousel /> : null;
        })}
      </div>
    );
  }
  return <FlexBubble node={contents} styles={styles} context={context} />;
}

export function FlexMessage({ data, onAction }: { data: FlexMessageData; onAction?: FlexActionHandler }) {
  return (
    <div className="flex-message" aria-label={data.altText || "Flex message"} data-flex-version={data.version} data-flex-effect-tag={data.effectTag}>
      <FlexRoot contents={data.contents} context={{ onAction }} />
    </div>
  );
}
