import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { getImageSrc } from "@/lib/imageUtils";
import { clampEvidenceIndex, stepEvidenceIndex } from "@/lib/evidence-viewer";

export type EvidenceViewerState = { urls: string[]; index: number } | null;

/**
 * Lightbox xem ảnh bằng chứng thu/chi dùng chung (gần full màn hình).
 * - Dùng đúng URL ảnh như thumbnail (data URL / /api/storage giữ nguyên cơ chế auth).
 * - Nhiều ảnh: nút ‹ ›, swipe trái/phải trên mobile, chỉ số "1 / 2".
 * - Chạm/click ảnh để phóng to 2× (cuộn xem chi tiết), chạm lại để thu về.
 * - Portal ra document.body để không bị dialog/sheet phía dưới cắt hoặc lệch vị trí.
 */
export function EvidenceImageViewer({
  urls,
  initialIndex = 0,
  onClose,
}: {
  urls: string[];
  initialIndex?: number;
  onClose: () => void;
}) {
  const count = urls.length;
  const [index, setIndex] = useState(() => clampEvidenceIndex(initialIndex, count));
  const [zoomed, setZoomed] = useState(false);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const goto = (i: number) => { setIndex(i); setZoomed(false); };
  const prev = () => goto(stepEvidenceIndex(index, -1, count));
  const next = () => goto(stepEvidenceIndex(index, 1, count));

  useEffect(() => {
    // Capture ở window để chạy TRƯỚC listener document của Radix Dialog/Sheet —
    // ESC chỉ đóng viewer, không đóng luôn Sheet Thu tiền phía dưới.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowLeft" && count > 1) prev();
      else if (e.key === "ArrowRight" && count > 1) next();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, count, onClose]);

  // Khoá scroll trang phía sau khi viewer mở.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  if (count === 0) return null;

  const raw = urls[index];
  const src = getImageSrc(raw) || raw;
  const alt = `Bằng chứng ${index + 1}/${count}`;

  const onTouchStartCapture = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) { touchStart.current = null; return; }
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEndCapture = (e: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || zoomed || count <= 1) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) next(); else prev();
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Xem ảnh bằng chứng"
      className="fixed inset-0 z-[100] bg-black/90 flex flex-col pointer-events-auto"
      onClick={onClose}
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={onTouchStartCapture}
      onTouchEnd={onTouchEndCapture}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 pb-1"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        {count > 1 ? (
          <span className="text-white/90 text-xs font-semibold px-2.5 py-1 rounded-full bg-white/15">
            {index + 1} / {count}
          </span>
        ) : <span />}
        <button
          type="button"
          aria-label="Đóng"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="p-2.5 rounded-full bg-white/15 text-white hover:bg-white/25 active:scale-95 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div
        className="flex-1 min-h-0 flex items-center justify-center px-3 pt-1"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        {failed[index] ? (
          <div
            onClick={(e) => e.stopPropagation()}
            className="text-white/70 text-sm px-5 py-6 border border-white/20 rounded-xl bg-white/5"
          >
            Không tải được ảnh này.
          </div>
        ) : zoomed ? (
          <div
            className="w-full h-full overflow-auto overscroll-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={src}
              alt={alt}
              style={{ width: "200%", maxWidth: "none" }}
              className="cursor-zoom-out"
              onClick={() => setZoomed(false)}
              onError={() => setFailed(f => ({ ...f, [index]: true }))}
            />
          </div>
        ) : (
          <img
            src={src}
            alt={alt}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl cursor-zoom-in select-none"
            onClick={(e) => { e.stopPropagation(); setZoomed(true); }}
            onError={() => setFailed(f => ({ ...f, [index]: true }))}
          />
        )}
      </div>

      {count > 1 && !zoomed && (
        <>
          <button
            type="button"
            aria-label="Ảnh trước"
            onClick={(e) => { e.stopPropagation(); prev(); }}
            className="absolute left-2 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/15 text-white hover:bg-white/25 active:scale-95 transition-colors"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            type="button"
            aria-label="Ảnh sau"
            onClick={(e) => { e.stopPropagation(); next(); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/15 text-white hover:bg-white/25 active:scale-95 transition-colors"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
