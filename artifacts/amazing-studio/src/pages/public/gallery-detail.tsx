import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, MessageCircle, User, Play, Camera } from "lucide-react";
import { CMS_BASE } from "@/components/cms-shared";
import { getImageSrc } from "@/lib/imageUtils";
import { Tilt3D, STYLE_3D } from "@/components/public-3d";
import PublicGalleryLightbox from "@/components/public/PublicGalleryLightbox";

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

// ── Media grid — giống album view của "Ý tưởng chụp ảnh" ─────────────────────
function MediaGrid({ items, albumName, onOpen }: {
  items: MediaItem[];
  albumName: string;
  onOpen: (idx: number) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-neutral-400">
        <Camera className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">Album đang được cập nhật</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 sm:gap-4" style={{ perspective: "1200px" }}>
      {items.map((m, i) => (
        <div key={m.id} className="pi-grid-item" style={{ animationDelay: `${Math.min(i * 60, 480)}ms` }}>
          <Tilt3D
            intensity={7}
            onClick={() => onOpen(i)}
            className="relative aspect-[4/5] sm:aspect-[3/4] rounded-xl overflow-hidden bg-neutral-100 cursor-zoom-in"
          >
            <div className="pi-shine absolute inset-0 z-10 pointer-events-none overflow-hidden rounded-xl" aria-hidden />
            {isVideo(m) ? (
              <>
                <video
                  src={getImageSrc(m.imageUrl) ?? m.imageUrl}
                  muted
                  playsInline
                  preload="metadata"
                  className="w-full h-full object-cover"
                />
                <span className="absolute inset-0 z-[5] flex items-center justify-center pointer-events-none">
                  <span className="w-12 h-12 rounded-full bg-black/45 backdrop-blur-sm flex items-center justify-center shadow-lg">
                    <Play className="w-5 h-5 text-white fill-white ml-0.5" />
                  </span>
                </span>
              </>
            ) : (
              <img
                src={getImageSrc(m.imageUrl) ?? m.imageUrl}
                alt={m.caption ?? `${albumName} ${i + 1}`}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            )}
          </Tilt3D>
        </div>
      ))}
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
  const photoCount = media.filter(m => !isVideo(m)).length;
  const videoCount = media.length - photoCount;
  const tags = (album.tagsText ?? "").split(",").map(s => s.trim()).filter(Boolean);

  return (
    <div className="min-h-screen bg-white pb-24">
      <style>{STYLE_3D}</style>
      {/* Back nav */}
      <div className="sticky top-0 z-30 bg-white/90 backdrop-blur-sm border-b border-neutral-200 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => setLocation(`${BASE}/bo-anh`)}
          className="flex items-center gap-1.5 text-sm text-neutral-600 hover:text-neutral-900 hover:-translate-x-0.5 transition-all"
        >
          <ArrowLeft className="w-4 h-4" /> Bộ sưu tập concept
        </button>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
        {/* Header — giống album view của Ý tưởng chụp ảnh */}
        <div className="mb-7">
          {album.categoryName && (
            <p className="text-[11px] tracking-[0.3em] uppercase text-neutral-500 mb-2">{album.categoryName}</p>
          )}
          <h1 className="font-serif text-2xl sm:text-3xl font-light text-neutral-900 mb-2 leading-tight">{album.name}</h1>
          <p className="text-xs text-neutral-500">
            {photoCount} ảnh{videoCount > 0 ? ` · ${videoCount} video` : ""}
          </p>
          {album.description && (
            <p className="text-neutral-600 mt-3 leading-relaxed whitespace-pre-line">{album.description}</p>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {tags.map(t => (
                <span key={t} className="text-[11px] px-2.5 py-1 rounded-full bg-neutral-100 text-neutral-600 shadow-sm">{t}</span>
              ))}
            </div>
          )}
        </div>

        <MediaGrid items={media} albumName={album.name} onOpen={setLightboxIdx} />

        {/* Consultant CTA */}
        <div className="border-t border-neutral-200 mt-10 pt-6 space-y-3 max-w-3xl">
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

      {lightboxIdx !== null && media.length > 0 && (
        <PublicGalleryLightbox
          items={media.map(m => ({ src: m.imageUrl, type: isVideo(m) ? "video" as const : "image" as const }))}
          startIndex={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}
