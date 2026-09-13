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

export function RichMessage({ data, onAction }: { data: RichMessageData; onAction?: (action: FlexAction) => void | Promise<void> }) {
  const [imageStatus, setImageStatus] = useState<RemoteImageStatus>("loading");
  const width = data.width && data.width > 0 ? data.width : undefined;
  const height = data.height && data.height > 0 ? data.height : undefined;
  const imageUrl = safeHttpsUrl(data.imageUrl);
  const actions = (data.actions ?? []).filter((action) => (
    action.width > 0 && action.height > 0 && safeHttpsUrl(action.link)
  ));
  const style = width && height ? { aspectRatio: `${width} / ${height}` } : undefined;
  const fallback = <div className="rich-message-fallback">{data.altText || "Rich message โหลดไม่ได้"}</div>;

  return (
    <div className={`rich-message ${width && height ? "rich-message-canvas" : ""}`} style={style}>
      {imageUrl ? (
        <RemoteImage
          src={imageUrl}
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
