import { useState, useEffect, useCallback, useRef } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { getImageSrc } from "@/lib/imageUtils";

/**
 * Lightbox dùng chung cho website public (Ý tưởng chụp ảnh, Concept ảnh, Cho thuê đồ).
 * Chuẩn giao diện lấy từ module "Ý tưởng chụp ảnh": nền đen, nút tròn mờ,
 * counter 1/4, swipe trên mobile, phím Esc/←/→, zoom-in nhẹ khi mở.
 */

export interface PublicLightboxItem {
  src: string;
  type?: "image" | "video";
}

const STYLE_LIGHTBOX = `
@keyframes pglFadeIn { 0% { opacity: 0; } 100% { opacity: 1; } }
@keyframes pglZoomIn {
  0%   { opacity: 0; transform: scale(.9); }
  100% { opacity: 1; transform: scale(1); }
}
.pgl-backdrop { animation: pglFadeIn .25s ease both; }
.pgl-media { animation: pglZoomIn .35s cubic-bezier(.22,.85,.35,1) both; }
@media (prefers-reduced-motion: reduce) {
  .pgl-backdrop, .pgl-media { animation: none; }
}
`;

function normalize(item: string | PublicLightboxItem): PublicLightboxItem {
  return typeof item === "string" ? { src: item, type: "image" } : { type: "image", ...item };
}

export default function PublicGalleryLightbox({ items, startIndex = 0, onClose }: {
  items: Array<string | PublicLightboxItem>;
  startIndex?: number;
  onClose: () => void;
}) {
  const media = items.map(normalize);
  const count = media.length;
  const [index, setIndex] = useState(() => Math.min(Math.max(startIndex, 0), Math.max(count - 1, 0)));
  const touchX = useRef<number | null>(null);

  const prev = useCallback(() => setIndex(i => (i - 1 + count) % count), [count]);
  const next = useCallback(() => setIndex(i => (i + 1) % count), [count]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose, prev, next]);

  if (count === 0) return null;
  const cur = media[index];
  const src = getImageSrc(cur.src) ?? cur.src;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Xem ảnh phóng to"
      className="pgl-backdrop fixed inset-0 z-[100] bg-black/95 flex items-center justify-center"
      onClick={onClose}
      onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
      onTouchEnd={e => {
        if (touchX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        if (dx > 48) prev(); else if (dx < -48) next();
        touchX.current = null;
      }}
    >
      <style>{STYLE_LIGHTBOX}</style>
      <button
        onClick={e => { e.stopPropagation(); onClose(); }}
        className="absolute top-4 right-4 z-10 w-11 h-11 rounded-full bg-white/10 hover:bg-white/25 hover:rotate-90 text-white flex items-center justify-center transition-all duration-300"
        aria-label="Đóng"
      >
        <X className="w-5 h-5" />
      </button>
      {count > 1 && (
        <>
          <button
            onClick={e => { e.stopPropagation(); prev(); }}
            className="absolute left-2 sm:left-5 z-10 w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-white/10 hover:bg-white/25 hover:scale-110 text-white flex items-center justify-center transition-all"
            aria-label="Ảnh trước"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); next(); }}
            className="absolute right-2 sm:right-5 z-10 w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-white/10 hover:bg-white/25 hover:scale-110 text-white flex items-center justify-center transition-all"
            aria-label="Ảnh sau"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </>
      )}
      {cur.type === "video" ? (
        <video
          key={cur.src}
          src={src}
          controls
          playsInline
          autoPlay
          onClick={e => e.stopPropagation()}
          className="pgl-media max-w-[94vw] max-h-[88vh] rounded-lg bg-black shadow-[0_40px_90px_-30px_rgba(0,0,0,.9)]"
        />
      ) : (
        <img
          key={cur.src}
          src={src}
          alt=""
          onClick={e => e.stopPropagation()}
          className="pgl-media max-w-[94vw] max-h-[88vh] object-contain select-none rounded-lg shadow-[0_40px_90px_-30px_rgba(0,0,0,.9)]"
          draggable={false}
        />
      )}
      {count > 1 && (
        <div className="absolute bottom-4 inset-x-0 text-center text-white/70 text-xs tracking-widest tabular-nums">
          {index + 1} / {count}
        </div>
      )}
    </div>
  );
}
