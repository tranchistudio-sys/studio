import { useState, useRef, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight, X, MessageCircle, User, Play } from "lucide-react";
import { CMS_BASE, LazyImage } from "@/components/cms-shared";
import { getImageSrc } from "@/lib/imageUtils";

const CONSULTANTS: { name: string; phone: string }[] = [
  { name: "Nhân viên tư vấn 1", phone: "0364902228" },
  { name: "Nhân viên tư vấn 2", phone: "0392817079" },
];

interface MediaItem {
  id: number;
  imageUrl: string;
  caption: string | null;
  mimeType: string | null;
  sortOrder: number;
}
interface AlbumDetail {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  categoryId: number | null;
  categoryName: string | null;
  tagsText: string | null;
  coverImageUrl: string | null;
  media: MediaItem[];
}

function isVideo(m: MediaItem): boolean {
  return !!m.mimeType && m.mimeType.startsWith("video/");
}
function isMobileDevice(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  } catch { return false; }
}
function toZaloNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, "");
  return cleaned.startsWith("0") ? "84" + cleaned.slice(1) : cleaned;
}
function openZalo(phone: string) {
  const zaloNum = toZaloNumber(phone);
  const webUrl = `https://zalo.me/${zaloNum}`;
  try {
    if (!isMobileDevice()) { window.open(webUrl, "_blank", "noopener,noreferrer"); return; }
    let opened = false;
    const onHide = () => { opened = true; document.removeEventListener("visibilitychange", onHide); };
    document.addEventListener("visibilitychange", onHide);
    setTimeout(() => {
      document.removeEventListener("visibilitychange", onHide);
      if (!opened) { try { window.location.href = webUrl; } catch {} }
    }, 1200);
    try { window.location.href = `zalo://chat?phone=${zaloNum}`; }
    catch { try { window.location.href = webUrl; } catch {} }
  } catch { try { window.open(webUrl, "_blank", "noopener,noreferrer"); } catch {} }
}

// ── Slider with image + video support ────────────────────────────────────────
function MediaSlider({ items, onZoom }: { items: MediaItem[]; onZoom: (idx: number) => void }) {
  const [idx, setIdx] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  function prev() { setIdx(i => Math.max(0, i - 1)); }
  function next() { setIdx(i => Math.min(items.length - 1, i + 1)); }
  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) { if (dx < 0) next(); else prev(); }
    touchStartX.current = null; touchStartY.current = null;
  }

  if (items.length === 0) {
    return (
      <div className="aspect-[3/4] bg-neutral-100 border border-neutral-200 flex items-center justify-center">
        <p className="text-neutral-500 text-sm">Chưa có ảnh</p>
      </div>
    );
  }

  const cur = items[idx];
  const curIsVideo = isVideo(cur);

  return (
    <div className="relative select-none">
      <div
        className="aspect-[4/5] sm:aspect-[3/4] overflow-hidden bg-neutral-100 border border-neutral-200"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {curIsVideo ? (
          <video
            key={cur.id}
            src={getImageSrc(cur.imageUrl) ?? cur.imageUrl}
            controls
            playsInline
            className="w-full h-full object-contain bg-black"
          />
        ) : (
          <img
            src={getImageSrc(cur.imageUrl) ?? cur.imageUrl}
            alt={cur.caption ?? `Ảnh ${idx + 1}`}
            onClick={() => onZoom(idx)}
            className="w-full h-full object-cover cursor-zoom-in"
            draggable={false}
          />
        )}
      </div>

      {items.length > 1 && (
        <>
          <button
            onClick={e => { e.stopPropagation(); prev(); }}
            disabled={idx === 0}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/80 backdrop-blur-sm rounded-full flex items-center justify-center shadow disabled:opacity-30"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={e => { e.stopPropagation(); next(); }}
            disabled={idx === items.length - 1}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/80 backdrop-blur-sm rounded-full flex items-center justify-center shadow disabled:opacity-30"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
          <div className="absolute top-3 right-3 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
            {idx + 1} / {items.length}
          </div>
        </>
      )}

      {items.length > 1 && (
        <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
          {items.map((m, i) => (
            <button
              key={m.id}
              onClick={() => setIdx(i)}
              className={`relative flex-shrink-0 w-16 aspect-square overflow-hidden border-2 transition-all ${
                i === idx ? "border-neutral-900" : "border-transparent opacity-60 hover:opacity-80"
              }`}
            >
              <img
                src={getImageSrc(m.imageUrl) ?? m.imageUrl}
                alt=""
                className="w-full h-full object-cover bg-neutral-200"
              />
              {isVideo(m) && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <Play className="w-4 h-4 text-white fill-white" />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Lightbox (images only) ────────────────────────────────────────────────────
function Lightbox({ images, startIdx, onClose }: { images: string[]; startIdx: number; onClose: () => void }) {
  const [idx, setIdx] = useState(startIdx);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && idx > 0) setIdx(i => i - 1);
      if (e.key === "ArrowRight" && idx < images.length - 1) setIdx(i => i + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, images.length, onClose]);

  function onTouchStart(e: React.TouchEvent) { touchStartX.current = e.touches[0].clientX; }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (dx < -40 && idx < images.length - 1) setIdx(i => i + 1);
    if (dx > 40 && idx > 0) setIdx(i => i - 1);
    touchStartX.current = null;
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center"
      onClick={onClose} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <button className="absolute top-4 right-4 text-white/80 hover:text-white z-10" onClick={onClose}>
        <X className="w-7 h-7" />
      </button>
      {idx > 0 && (
        <button onClick={e => { e.stopPropagation(); setIdx(i => i - 1); }}
          className="absolute left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white z-10">
          <ChevronLeft className="w-10 h-10" />
        </button>
      )}
      {idx < images.length - 1 && (
        <button onClick={e => { e.stopPropagation(); setIdx(i => i + 1); }}
          className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white z-10">
          <ChevronRight className="w-10 h-10" />
        </button>
      )}
      <img
        src={getImageSrc(images[idx]) ?? images[idx]}
        alt=""
        className="max-h-screen max-w-screen-md w-full object-contain"
        onClick={e => e.stopPropagation()}
        draggable={false}
      />
      {images.length > 1 && (
        <div className="absolute bottom-4 inset-x-0 text-center text-white/60 text-sm">
          {idx + 1} / {images.length}
        </div>
      )}
    </div>
  );
}

export default function PublicGalleryDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, setLocation] = useLocation();
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  const { data: album, isLoading, error } = useQuery<AlbumDetail>({
    queryKey: ["public-gallery-album", slug],
    queryFn: async () => {
      const r = await fetch(`${CMS_BASE}/api/cms/public/gallery/albums/${encodeURIComponent(slug ?? "")}`);
      if (!r.ok) throw new Error(r.status === 404 ? "not_found" : "error");
      return r.json();
    },
    enabled: !!slug,
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-neutral-500">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">Đang tải...</p>
        </div>
      </div>
    );
  }

  if ((error as Error)?.message === "not_found" || !album) {
    return (
      <div className="min-h-screen flex items-center justify-center text-center p-6">
        <div>
          <p className="text-4xl mb-4">😔</p>
          <h1 className="text-xl font-semibold mb-2">Không tìm thấy bộ ảnh</h1>
          <p className="text-neutral-500 text-sm mb-6">Bộ ảnh này có thể đã được ẩn hoặc xoá.</p>
          <button
            onClick={() => setLocation(`${BASE}/bo-anh`)}
            className="px-5 py-2.5 bg-neutral-900 text-white text-sm font-medium hover:opacity-90"
          >
            Xem tất cả bộ ảnh
          </button>
        </div>
      </div>
    );
  }

  const media = album.media ?? [];
  const photoUrls = media.filter(m => !isVideo(m)).map(m => m.imageUrl);
  const tags = (album.tagsText ?? "").split(",").map(s => s.trim()).filter(Boolean);

  // Mở lightbox theo index ảnh (chỉ ảnh, không video)
  function openLightbox(mediaIdx: number) {
    const target = media[mediaIdx];
    if (!target || isVideo(target)) return;
    const photoIdx = photoUrls.indexOf(target.imageUrl);
    if (photoIdx >= 0) setLightboxIdx(photoIdx);
  }

  return (
    <div className="min-h-screen bg-white pb-24">
      {/* Back nav */}
      <div className="sticky top-0 z-30 bg-white/90 backdrop-blur-sm border-b border-neutral-200 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => setLocation(`${BASE}/bo-anh`)}
          className="flex items-center gap-1.5 text-sm text-neutral-600 hover:text-neutral-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Bộ sưu tập concept
        </button>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-5 space-y-6">
        <MediaSlider items={media} onZoom={openLightbox} />

        {/* Header */}
        <div className="space-y-2">
          {album.categoryName && (
            <p className="text-[11px] tracking-[0.3em] uppercase text-neutral-500">{album.categoryName}</p>
          )}
          <h1 className="font-serif text-2xl sm:text-3xl font-light text-neutral-900 leading-tight">{album.name}</h1>
          <p className="text-xs text-neutral-500">
            {photoUrls.length} ảnh
            {media.length - photoUrls.length > 0 ? ` · ${media.length - photoUrls.length} video` : ""}
          </p>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {tags.map(t => (
                <span key={t} className="text-[11px] px-2 py-0.5 bg-neutral-100 text-neutral-700 border border-neutral-200">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>

        {album.description && (
          <div className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap border-t border-neutral-200 pt-4">
            {album.description}
          </div>
        )}

        {/* Consultant CTA */}
        <div className="border-t border-neutral-200 pt-6 space-y-3">
          <h2 className="text-base font-semibold text-neutral-900">Liên hệ tư vấn concept</h2>
          <p className="text-sm text-neutral-600">
            Bạn thích concept này? Liên hệ ngay để được tư vấn thực hiện bộ ảnh của riêng bạn.
          </p>
          <div className="space-y-3">
            {CONSULTANTS.map(c => (
              <div
                key={c.phone}
                className="w-full bg-white border border-neutral-200 rounded-2xl p-3 flex items-center gap-3"
              >
                <div className="flex-shrink-0 w-12 h-12 rounded-full bg-gradient-to-br from-pink-400 to-purple-500 flex items-center justify-center text-white">
                  <User className="w-6 h-6" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-neutral-900 truncate">{c.name}</p>
                  <a href={`tel:${c.phone}`} className="text-xs text-neutral-500 tabular-nums hover:text-neutral-900">
                    {c.phone}
                  </a>
                </div>
                <button
                  type="button"
                  onClick={() => openZalo(c.phone)}
                  className="flex-shrink-0 inline-flex items-center gap-1.5 px-4 h-11 min-w-[110px] justify-center bg-[#0068ff] text-white rounded-xl text-sm font-semibold hover:opacity-90"
                >
                  <MessageCircle className="w-4 h-4" />
                  Chat Zalo
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {lightboxIdx !== null && photoUrls.length > 0 && (
        <Lightbox images={photoUrls} startIdx={lightboxIdx} onClose={() => setLightboxIdx(null)} />
      )}
    </div>
  );
}
