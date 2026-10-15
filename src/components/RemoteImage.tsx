import type { CSSProperties, ReactNode, SyntheticEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { lineyEngine } from "../lib/engine";

export type RemoteImageStatus = "loading" | "loaded" | "failed";

type RemoteImageProps = {
  src: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
  animated?: boolean;
  loading?: "eager" | "lazy";
  fallback?: ReactNode;
  onStatus?: (status: RemoteImageStatus) => void;
  maxAspectRatio?: number;
  preferProxy?: boolean;
};

type ImageState = {
  requestUrl: string;
  source: string;
  proxyLoading: boolean;
  proxyAttempted: boolean;
  failed: boolean;
};

function initialImageState(requestUrl: string, preferProxy = false): ImageState {
  return {
    requestUrl,
    source: requestUrl,
    proxyLoading: preferProxy,
    proxyAttempted: false,
    failed: false,
  };
}

function imageDataUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 12 * 1024 * 1024) return undefined;
  return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(value) ? value : undefined;
}

/**
 * Load an HTTPS asset in the WebView and retry through the engine when the
 * WebView cannot reach the remote host. The engine response is a bounded,
 * validated image data URL, so no arbitrary markup crosses into the UI.
 */
export function RemoteImage({
  src,
  alt,
  className,
  style,
  animated = false,
  loading = "lazy",
  fallback,
  onStatus,
  maxAspectRatio,
  preferProxy = false,
}: RemoteImageProps) {
  const statusRef = useRef(onStatus);
  const [state, setState] = useState<ImageState>(() => initialImageState(src, preferProxy));
  const currentState = state.requestUrl === src ? state : initialImageState(src, preferProxy);
  const proxyLoading = currentState.proxyLoading;
  const proxyAttempted = currentState.proxyAttempted;
  const failed = currentState.failed;

  useEffect(() => {
    statusRef.current = onStatus;
  }, [onStatus]);

  useEffect(() => {
    statusRef.current?.("loading");
  }, [src]);

  useEffect(() => {
    if (!proxyLoading) return;
    let alive = true;
    lineyEngine
      .request<{ dataUrl?: unknown }>("asset.preview", { url: src }, 20_000)
      .then((result) => {
        const dataUrl = imageDataUrl(result?.dataUrl);
        if (!dataUrl) throw new Error("engine returned an invalid image");
        if (!alive) return;
        setState({ requestUrl: src, source: dataUrl, proxyLoading: false, proxyAttempted: true, failed: false });
      })
      .catch(() => {
        if (!alive) return;
        setState((current) => current.requestUrl === src
          ? {
              ...current,
              source: preferProxy ? src : current.source,
              proxyLoading: false,
              proxyAttempted: true,
              failed: !preferProxy,
            }
          : current);
        if (!preferProxy) statusRef.current?.("failed");
      });
    return () => {
      alive = false;
    };
  }, [src, proxyLoading, preferProxy]);

  const handleError = () => {
    if (
      lineyEngine.isNative
      && preferProxy
      && proxyAttempted
      && currentState.source.startsWith("data:image/")
    ) {
      setState({ requestUrl: src, source: src, proxyLoading: false, proxyAttempted: true, failed: false });
      statusRef.current?.("loading");
      return;
    }
    if (lineyEngine.isNative && !proxyAttempted && !proxyLoading) {
      setState({ requestUrl: src, source: src, proxyLoading: true, proxyAttempted: false, failed: false });
      statusRef.current?.("loading");
      return;
    }
    setState({ requestUrl: src, source: src, proxyLoading: false, proxyAttempted: true, failed: true });
    statusRef.current?.("failed");
  };

  const handleLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    const aspectRatio = Math.max(naturalWidth / naturalHeight, naturalHeight / naturalWidth);
    if (maxAspectRatio && aspectRatio > maxAspectRatio) {
      setState((current) => current.requestUrl === src
        ? { ...current, proxyLoading: false, proxyAttempted: true, failed: true }
        : current);
      statusRef.current?.("failed");
      return;
    }
    statusRef.current?.("loaded");
  };

  if (proxyLoading || failed) {
    return <>{fallback ?? <span className="remote-image-fallback">{alt || "รูปภาพโหลดไม่ได้"}</span>}</>;
  }

  return (
    <img
      className={className}
      src={currentState.source}
      alt={alt}
      loading={loading}
      referrerPolicy="no-referrer"
      style={style}
      data-flex-animated={animated ? "true" : undefined}
      onLoad={handleLoad}
      onError={handleError}
    />
  );
}
