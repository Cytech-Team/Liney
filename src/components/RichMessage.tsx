import { useState } from "react";
import type { RichMessageData } from "../data/mock";
import type { FlexAction } from "./FlexMessage";
import { RemoteImage, type RemoteImageStatus } from "./RemoteImage";

function safeHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function RichMessage({ data, onAction, messageId, chatId, kind, onOpenOriginal }: {
  data: RichMessageData;
  onAction?: (action: FlexAction) => void | Promise<void>;
  messageId?: string;
  chatId?: string;
  kind?: string;
  onOpenOriginal?: () => void;
}) {
  const [imageStatus, setImageStatus] = useState<RemoteImageStatus>("loading");
  const [retry, setRetry] = useState(0);
  const width = data.width && data.width > 0 ? data.width : undefined;
  const height = data.height && data.height > 0 ? data.height : undefined;
  const imageUrl = safeHttpsUrl(data.imageUrl);
  const actions = (data.actions ?? []).filter((action) => (
    action.width > 0 && action.height > 0 && safeHttpsUrl(action.link)
  ));
  const artworkUnavailable = imageStatus === "failed" || !imageUrl;
  const style = width && height && !artworkUnavailable ? { aspectRatio: `${width} / ${height}` } : undefined;
  const fallback = (
    <div className={`rich-message-fallback ${artworkUnavailable ? "rich-message-fallback-error" : ""}`}>
      <span>{artworkUnavailable ? "ไม่สามารถโหลดภาพจาก LINE ได้" : "กำลังโหลดรูปจาก LINE…"}</span>
      {artworkUnavailable ? (
        <>
          {data.altText && <p>{data.altText}</p>}
          <div className="rich-message-fallback-actions">
            <button type="button" onClick={() => { setImageStatus("loading"); setRetry((n) => n + 1); }}>ลองใหม่</button>
            {onOpenOriginal && <button type="button" onClick={onOpenOriginal}>เปิดใน LINE ทางการ</button>}
          </div>
        </>
      ) : null}
    </div>
  );

  return (
    <div className={`rich-message ${width && height && !artworkUnavailable ? "rich-message-canvas" : ""}`} style={style}>
      {imageUrl ? (
        <RemoteImage
          key={`${imageUrl}:${retry}`}
          src={imageUrl}
          lineMessage={messageId && chatId ? { messageId, chatId, kind: kind === "openchat" ? "openchat" : "talk" } : undefined}
          preferProxy={Boolean(messageId && chatId)}
          alt={data.altText || "Rich message"}
          loading="lazy"
          fallback={fallback}
          onStatus={setImageStatus}
        />
      ) : fallback}
      {imageStatus === "loaded" && imageUrl ? actions.map((action, index) => {
        const link = safeHttpsUrl(action.link);
        if (!link) return null;
        const regionStyle = width && height ? {
          left: `${(action.x / width) * 100}%`,
          top: `${(action.y / height) * 100}%`,
          width: `${(action.width / width) * 100}%`,
          height: `${(action.height / height) * 100}%`,
        } : undefined;
        return (
          <button
            key={`${action.x}-${action.y}-${index}`}
            type="button"
            className="rich-message-action"
            aria-label={`เปิด ${data.altText || "เนื้อหา"}`}
            title="เปิดเนื้อหา"
            style={regionStyle}
            onClick={(event) => {
              event.stopPropagation();
              void onAction?.({ type: "uri", uri: link });
            }}
          />
        );
      }) : null}
    </div>
  );
}
