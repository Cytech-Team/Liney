import { Image as ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AlbumThumbnailLoader, type Request } from "../lib/album-thumbnail-loader";

export function AlbumThumbnail({
  loader, cacheKey, request, className, alt,
}: {
  loader: AlbumThumbnailLoader;
  cacheKey: string;
  request: Request;
  className: string;
  alt: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const method = request.method;
  const chatId = request.params.chatId;
  const albumId = request.params.albumId;
  const oid = request.params.oid;
  const [state, setState] = useState<{ key: string; image: string | null }>();
  const cached = loader.peek(cacheKey);
  const image = state?.key === cacheKey ? state.image : cached;

  useEffect(() => {
    let mounted = true;
    let started = false;
    let observer: IntersectionObserver | undefined;
    function load() {
      if (started) return;
      started = true;
      observer?.disconnect();
      void loader.load(cacheKey, {
        method, params: { chatId, albumId, ...(oid ? { oid } : {}) },
      }).then((result) => {
        if (mounted) setState({ key: cacheKey, image: result });
      });
    }
    const element = anchor.current;
    if (typeof IntersectionObserver === "undefined" || !element) load();
    else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      }, { rootMargin: "160px" });
      observer.observe(element);
    }
    return () => {
      mounted = false;
      observer?.disconnect();
    };
  }, [loader, cacheKey, method, chatId, albumId, oid]);

  return (
    <span ref={anchor} className={className}>
      {image ? <img src={image} alt={alt} decoding="async" /> : <ImageIcon aria-hidden="true" size={21} />}
    </span>
  );
}
