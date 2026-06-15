import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { getTemplateDisplay, resolveTemplatePreviewUrls } from "./wedding-card-config";
import type { WeddingCardTemplate } from "@/hooks/use-wedding-cards";
import { getImageSrc } from "@/lib/imageUtils";
import { weddingTemplatePlaceholder } from "@/lib/cms-placeholders";

function templateImage(template: WeddingCardTemplate): string {
  const urls = resolveTemplatePreviewUrls(template);
  return (
    getImageSrc(urls.mockup) ??
    getImageSrc(urls.cover) ??
    weddingTemplatePlaceholder(template.category)
  );
}

const SWIPE_THRESHOLD = 48;

export function WeddingCardBtCarousel({
  templates,
  onPreview,
}: {
  templates: WeddingCardTemplate[];
  onPreview: (t: WeddingCardTemplate) => void;
}) {
  const [active, setActive] = useState(0);
  const [metaKey, setMetaKey] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [paused, setPaused] = useState(false);
  const pointerStart = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const count = templates.length;

  const safeActive = count > 0 ? ((active % count) + count) % count : 0;
  const current = templates[safeActive];

  const relIndex = useMemo(() => {
    return templates.map((_, i) => {
      let d = i - safeActive;
      if (d > count / 2) d -= count;
      if (d < -count / 2) d += count;
      return d;
    });
  }, [templates, safeActive, count]);

  const go = useCallback(
    (delta: number) => {
      setActive((v) => v + delta);
      setMetaKey((k) => k + 1);
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) setPaused(true);
  }, []);

  useEffect(() => {
    if (count < 2 || paused) return;
    const id = window.setInterval(() => go(1), 5500);
    return () => window.clearInterval(id);
  }, [count, go, paused]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    pointerStart.current = e.clientX;
    setIsDragging(true);
    setDragOffset(0);
    stageRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setDragOffset(e.clientX - pointerStart.current);
  };

  const finishDrag = (e: React.PointerEvent) => {
    if (!isDragging) return;
    const delta = e.clientX - pointerStart.current;
    setIsDragging(false);
    setDragOffset(0);
    try {
      stageRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (delta > SWIPE_THRESHOLD) go(-1);
    else if (delta < -SWIPE_THRESHOLD) go(1);
  };

  if (!count || !current) return null;

  const display = getTemplateDisplay(current.slug, current.name);
  const href = `/thiep-cuoi-online/tao?template=${current.slug}`;

  return (
    <div
      className="wc-bt-carousel"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div
        ref={stageRef}
        className={`wc-bt-carousel-stage ${isDragging ? "is-dragging" : ""}`}
        aria-live="polite"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        style={{ ["--wc-drag" as string]: `${dragOffset}px` }}
      >
        {templates.map((template, i) => {
          const rel = relIndex[i];
          const abs = Math.abs(rel);
          if (abs > 2) return null;
          const imgSrc = templateImage(template);
          return (
            <div
              key={template.slug}
              className={`wc-bt-carousel-item ${rel === 0 ? "is-active" : ""} ${rel < 0 ? "is-left" : ""} ${rel > 0 ? "is-right" : ""}`}
              style={{
                ["--wc-rel" as string]: String(rel),
                ["--wc-abs" as string]: String(abs),
              }}
              aria-hidden={rel !== 0}
            >
              {rel === 0 && safeActive === 0 && (
                <span className="wc-bt-carousel-badge">Phổ biến</span>
              )}
              <div className="wc-bt-carousel-phone">
                <img src={imgSrc} alt={template.name} loading="lazy" draggable={false} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="wc-bt-carousel-controls">
        <button type="button" className="wc-bt-carousel-arrow" onClick={() => go(-1)} aria-label="Mẫu trước">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="wc-bt-carousel-dots">
          {templates.map((t, i) => (
            <button
              key={t.slug}
              type="button"
              className={`wc-bt-carousel-dot ${i === safeActive ? "is-active" : ""}`}
              onClick={() => {
                setActive(i);
                setMetaKey((k) => k + 1);
              }}
              aria-label={`Mẫu ${i + 1}`}
            />
          ))}
        </div>
        <button type="button" className="wc-bt-carousel-arrow" onClick={() => go(1)} aria-label="Mẫu sau">
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      <div className="wc-bt-carousel-meta wc-bt-meta-pop" key={`${current.slug}-${metaKey}`}>
        <p className="wc-bt-carousel-cat">{current.category || display.title}</p>
        <h3 className="wc-bt-carousel-title">{display.coupleNames || current.name || display.title}</h3>
        <p className="wc-bt-carousel-sub">{display.styleTag || display.subtitle}</p>
        <p className="wc-bt-carousel-desc">{current.description || display.subtitle}</p>
      </div>

      <div className="wc-bt-carousel-actions">
        <button type="button" onClick={() => onPreview(current)} className="wc-bt-btn wc-bt-btn-primary">
          <Eye className="w-4 h-4" />
          Xem mẫu
        </button>
        <Link href={href} className="wc-bt-btn wc-bt-btn-outline-pink">
          Dùng mẫu này
        </Link>
      </div>
    </div>
  );
}
