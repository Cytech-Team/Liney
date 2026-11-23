import { LoaderCircle, Play, RotateCw } from "lucide-react";
import type { Message } from "../data/mock";
import { formatMediaDuration } from "../lib/message-presentation";
import { useAppTranslation } from "../lib/i18n";

export type VideoMessageState = {
  status: "loading" | "ready" | "error";
  url?: string;
  error?: string;
};

export function VideoMessage({ message, state, onPlay }: {
  message: Message;
  state?: VideoMessageState;
  onPlay: () => void;
}) {
  const { t } = useAppTranslation();
  const duration = formatMediaDuration(message.durationMs);
  const label = t("วิดีโอ");

  if (state?.status === "ready" && state.url) {
    return (
      <div className="video-message video-message-ready">
        <video
          className="video-message-player"
          src={state.url}
          controls
          autoPlay
          playsInline
          preload="metadata"
          aria-label={message.filename ? `${label}: ${message.filename}` : label}
        >{t("เบราว์เซอร์นี้เล่นวิดีโอไม่ได้")}</video>
      </div>
    );
  }

  if (state?.status === "loading") {
    return (
      <div className="video-message video-message-card video-message-loading" role="status" aria-live="polite">
        <span className="video-message-play" aria-hidden="true"><LoaderCircle className="spin" size={22} /></span>
        <span className="video-message-title">{t("กำลังโหลดวิดีโอ…")}</span>
        {duration ? <span className="video-message-duration">{duration}</span> : null}
      </div>
    );
  }

  if (state?.status === "error") {
    return (
      <div className="video-message video-message-card video-message-error" role="alert">
        <span className="video-message-title">{label}</span>
        <span className="video-message-error-text">{state.error || t("โหลดวิดีโอไม่สำเร็จ")}</span>
        <button type="button" className="video-message-retry" onClick={onPlay}>
          <RotateCw size={13} />{t("ลองโหลดวิดีโออีกครั้ง")}
        </button>
        {duration ? <span className="video-message-duration">{duration}</span> : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="video-message video-message-card"
      onClick={onPlay}
      title={t("เล่นวิดีโอ")}
      aria-label={message.filename ? `${t("เล่นวิดีโอ")}: ${message.filename}` : t("เล่นวิดีโอ")}
    >
      <span className="video-message-play" aria-hidden="true"><Play size={24} fill="currentColor" /></span>
      <span className="video-message-title">{label}</span>
      {message.filename ? <span className="video-message-filename">{message.filename}</span> : null}
      {duration ? <span className="video-message-duration">{duration}</span> : null}
    </button>
  );
}
