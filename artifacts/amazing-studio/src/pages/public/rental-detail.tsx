import { useState, useRef, useEffect, useMemo } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Phone,
  ChevronLeft,
  ChevronRight,
  X,
  MessageCircle,
  Tag,
  Ruler,
  Palette,
  Package,
  User,
  Plus,
  Copy,
  Calendar,
  Sparkles,
  Info,
  Shirt,
  ArrowRight,
} from "lucide-react";
import { CMS_BASE } from "@/components/cms-shared";
import { getImageSrc } from "@/lib/imageUtils";
import { formatVND } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { OutfitTagBadge } from "@/lib/outfit-tags";
import { useOutfitSchedule } from "@/hooks/use-outfit-schedule";
import { format, parseISO } from "date-fns";
import { vi } from "date-fns/locale";
import {
  CONSULTANTS,
  STUDIO_PHONE,
  STUDIO_PHONE_DISPLAY,
} from "@/lib/public-site-config";

const STUDIO_MESSENGER = import.meta.env.VITE_STUDIO_MESSENGER ?? "";

const RENTAL_NOTES = [
  "Đặt cọc theo quy định của studio; số tiền phụ thuộc loại trang phục.",
  "Giữ gìn trang phục cẩn thận; trả đúng hạn để tránh phí phạt.",
  "Nên thử đồ trước 1–2 ngày để chỉnh size và phụ kiện.",
  "Ngày cưới / sự kiện lớn: liên hệ sớm 2–3 ngày để giữ lịch.",
];

const STYLING_PLACEHOLDERS = [
  "Kết hợp makeup nhẹ và tóc búi / xõa tự nhiên để tôn form trang phục.",
  "Concept studio minimal hoặc ngoại cảnh Tây Ninh — ánh sáng vàng chiều rất hợp.",
  "Phụ kiện tinh tế: hoa tai, voan pastel hoặc khăn lụa đồng tone màu.",
];

function isMobileDevice(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

function toZaloNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, "");
  return cleaned.startsWith("0") ? "84" + cleaned.slice(1) : cleaned;
}

function openZalo(phone: string) {
  const zaloNum = toZaloNumber(phone);
  const webUrl = `https://zalo.me/${zaloNum}`;
  try {
    if (!isMobileDevice()) {
      window.open(webUrl, "_blank", "noopener,noreferrer");
      return;
    }
    let opened = false;
    const onHide = () => {
      opened = true;
      document.removeEventListener("visibilitychange", onHide);
    };
    document.addEventListener("visibilitychange", onHide);
    const fallback = () => {
      document.removeEventListener("visibilitychange", onHide);
      if (opened) return;
      try {
        window.location.href = webUrl;
      } catch {}
    };
    setTimeout(fallback, 1200);
    try {
      window.location.href = `zalo://chat?phone=${zaloNum}`;
    } catch {
      try {
        window.location.href = webUrl;
      } catch {}
    }
  } catch {
    try {
      window.open(webUrl, "_blank", "noopener,noreferrer");
    } catch {}
  }
}

function buildConsultMessage(dress: {
  code: string;
  name: string;
  size?: string;
  sizeText?: string | null;
}): string {
  const size = (dress.sizeText && dress.sizeText.trim()) || (dress.size && dress.size.trim()) || "";
  const url = typeof window !== "undefined" ? window.location.href : "";
  const lines = ["Em muốn tư vấn sản phẩm:", "", `Mã: ${dress.code}`, `Tên: ${dress.name}`];
  if (size) lines.push(`Size: ${size}`);
  lines.push("", "Link sản phẩm:", url, "", "Shop tư vấn giúp em nhé.");
  return lines.join("\n");
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function ConsultantSection({ dress }: { dress: PublicDressDetail }) {
  const { toast } = useToast();

  async function handleCopy() {
    const ok = await copyToClipboard(buildConsultMessage(dress));
    if (ok) {
      toast({
        title: "Đã sao chép",
        description: "Nội dung tư vấn đã copy. Bạn có thể dán vào Zalo.",
      });
    } else {
      toast({
        title: "Không sao chép được",
        description: "Trình duyệt không cho phép. Bạn có thể copy thủ công.",
        variant: "destructive",
      });
    }
  }

  function handleZalo(phone: string) {
    try {
      openZalo(phone);
    } catch {
      toast({
        title: "Không mở được Zalo",
        description: `Vui lòng nhắn số ${phone} hoặc dùng Sao chép nội dung tư vấn.`,
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-serif text-lg font-light text-neutral-900">Nhân viên tư vấn</h2>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 text-[11px] tracking-wide uppercase text-neutral-600 hover:text-neutral-900 transition-colors px-2 py-1"
        >
          <Copy className="w-3.5 h-3.5" />
          Sao chép
        </button>
      </div>
      <div className="space-y-2.5">
        {CONSULTANTS.map((c) => (
          <div
            key={c.phone}
            className="w-full bg-white/90 border border-neutral-200/80 rounded-2xl p-3 flex items-center gap-3 shadow-sm"
          >
            <div className="flex-shrink-0 w-11 h-11 rounded-full bg-gradient-to-br from-[var(--public-accent)] to-[var(--public-accent-dark)] flex items-center justify-center text-white">
              <User className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-neutral-900 truncate">{c.name}</p>
              <a
                href={`tel:${c.phone}`}
                className="text-xs text-neutral-500 tabular-nums hover:text-neutral-900"
              >
                {c.phone}
              </a>
            </div>
            <button
              type="button"
              onClick={() => handleZalo(c.phone)}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-3.5 h-10 min-w-[100px] justify-center border border-[var(--public-accent-dark)] text-[var(--public-accent-dark)] bg-white rounded-xl text-xs font-medium tracking-wide hover:bg-[var(--public-cream-deep)] transition-colors"
              aria-label={`Chat Zalo với ${c.name}`}
            >
              <MessageCircle className="w-3.5 h-3.5" />
              Zalo
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface PublicDressDetail {
  id: number;
  code: string;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  rentalPrice: number;
  depositRequired: number;
  sellPrice: number;
  salePrice?: number;
  coverImageUrl: string | null;
  publicImageUrl: string | null;
  imageUrl: string | null;
  extraImages: string[];
  color: string;
  size: string;
  sizeText: string | null;
  colorText: string | null;
  tagsText: string | null;
  materialText: string | null;
  description: string | null;
  rentalStatus: string;
  outfitTag: string | null;
  slug: string;
}

interface PublicDressListItem {
  id: number;
  code: string;
  name: string;
  categoryId: number | null;
  slug: string | null;
  coverImageUrl: string | null;
  rentalPrice: number;
  salePrice?: number;
  rentalStatus: string;
}

const STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
  san_sang: { label: "Có sẵn", color: "text-emerald-800", bg: "bg-emerald-50 border-emerald-200/60" },
  dang_cho_thue: { label: "Đang thuê", color: "text-amber-800", bg: "bg-amber-50 border-amber-200/60" },
  giu_do: { label: "Đang thuê", color: "text-amber-800", bg: "bg-amber-50 border-amber-200/60" },
  ngung_cho_thue: { label: "Ngưng thuê", color: "text-neutral-600", bg: "bg-neutral-100 border-neutral-200/60" },
};

function getPublicStatus(status: string) {
  return STATUS_MAP[status] ?? STATUS_MAP.san_sang;
}

function Chip({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  if (!value) return null;
  const items = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return (
    <div className="space-y-1">
      <p className="text-[11px] tracking-wide uppercase text-neutral-500 flex items-center gap-1">
        {icon}
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="px-2.5 py-1 bg-[var(--public-cream-deep)] text-neutral-800 text-sm rounded-full border border-neutral-200/60"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function ImageSlider({
  images,
  onZoom,
  outfitTag,
}: {
  images: string[];
  onZoom: (idx: number) => void;
  outfitTag?: string | null;
}) {
  const [idx, setIdx] = useState(0);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  useEffect(() => {
    setIdx((i) => Math.min(i, Math.max(0, images.length - 1)));
  }, [images.length]);

  function prev() {
    setIdx((i) => Math.max(0, i - 1));
  }
  function next() {
    setIdx((i) => Math.min(images.length - 1, i + 1));
  }

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
      if (dx < 0) next();
      else prev();
    }
    touchStartX.current = null;
    touchStartY.current = null;
  }

  if (images.length === 0) {
    return (
      <div className="aspect-[4/5] bg-[var(--public-cream-deep)] rounded-3xl flex items-center justify-center border border-neutral-200/60 shadow-sm">
        <p className="text-neutral-500 text-sm">Chưa có ảnh</p>
      </div>
    );
  }

  return (
    <div className="relative select-none">
      <div
        className="aspect-[4/5] overflow-hidden rounded-3xl cursor-zoom-in bg-neutral-100 shadow-md border border-neutral-200/50"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onClick={() => onZoom(idx)}
      >
        <img
          src={getImageSrc(images[idx]) ?? images[idx]}
          alt={`Ảnh ${idx + 1}`}
          className="w-full h-full object-cover transition-opacity duration-200"
          draggable={false}
        />
      </div>

      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              prev();
            }}
            disabled={idx === 0}
            className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/90 backdrop-blur-sm rounded-full flex items-center justify-center shadow-sm border border-neutral-200/80 disabled:opacity-25 transition-opacity"
            aria-label="Ảnh trước"
          >
            <ChevronLeft className="w-5 h-5 text-neutral-800" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              next();
            }}
            disabled={idx === images.length - 1}
            className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-white/90 backdrop-blur-sm rounded-full flex items-center justify-center shadow-sm border border-neutral-200/80 disabled:opacity-25 transition-opacity"
            aria-label="Ảnh sau"
          >
            <ChevronRight className="w-5 h-5 text-neutral-800" />
          </button>
          <div className="absolute top-3 right-3 bg-neutral-900/55 text-white text-[11px] px-2.5 py-0.5 rounded-full tabular-nums">
            {idx + 1} / {images.length}
          </div>
        </>
      )}

      {outfitTag && (
        <div className="absolute top-3 left-3 z-10">
          <OutfitTagBadge tag={outfitTag} />
        </div>
      )}

      {images.length > 1 && (
        <div className="flex gap-2 mt-3 overflow-x-auto pb-1 scrollbar-thin">
          {images.map((src, i) => (
            <button
              key={`${src}-${i}`}
              type="button"
              onClick={() => setIdx(i)}
              className={`flex-shrink-0 w-[4.25rem] sm:w-[4.75rem] aspect-square rounded-xl overflow-hidden border-2 transition-all shadow-sm ${
                i === idx ? "border-neutral-900 opacity-100" : "border-transparent opacity-55 hover:opacity-80"
              }`}
            >
              <img src={getImageSrc(src) ?? src} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Lightbox({
  images,
  startIdx,
  onClose,
}: {
  images: string[];
  startIdx: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(startIdx);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    setIdx(startIdx);
  }, [startIdx]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && idx > 0) setIdx((i) => i - 1);
      if (e.key === "ArrowRight" && idx < images.length - 1) setIdx((i) => i + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, images.length, onClose]);

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (dx < -40 && idx < images.length - 1) setIdx((i) => i + 1);
    if (dx > 40 && idx > 0) setIdx((i) => i - 1);
    touchStartX.current = null;
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center"
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <button
        type="button"
        className="absolute top-4 right-4 text-white/80 hover:text-white z-10"
        onClick={onClose}
      >
        <X className="w-7 h-7" />
      </button>
      {idx > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIdx((i) => i - 1);
          }}
          className="absolute left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white z-10"
        >
          <ChevronLeft className="w-10 h-10" />
        </button>
      )}
      {idx < images.length - 1 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIdx((i) => i + 1);
          }}
          className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white z-10"
        >
          <ChevronRight className="w-10 h-10" />
        </button>
      )}
      <img
        src={getImageSrc(images[idx]) ?? images[idx]}
        alt=""
        className="max-h-screen max-w-screen-sm w-full object-contain"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
      {images.length > 1 && (
        <div className="absolute bottom-4 inset-x-0 text-center text-white/60 text-sm tabular-nums">
          {idx + 1} / {images.length}
        </div>
      )}
    </div>
  );
}

function ProductCtaButtons({
  dress,
  layout,
}: {
  dress: PublicDressDetail;
  layout: "card" | "bar";
}) {
  const { toast } = useToast();
  const phone = CONSULTANTS[0]?.phone ?? STUDIO_PHONE;

  async function handleConsult() {
    const ok = await copyToClipboard(buildConsultMessage(dress));
    if (ok) {
      toast({ title: "Đã sao chép", description: "Dán nội dung vào Zalo để được tư vấn nhanh." });
      try {
        openZalo(phone);
      } catch {}
    } else {
      toast({ title: "Không sao chép được", variant: "destructive" });
    }
  }

  const isBar = layout === "bar";
  const btnBase = isBar
    ? "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-colors min-h-[44px]"
    : "flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-colors w-full";

  return (
    <div className={isBar ? "flex gap-2.5" : "flex flex-col gap-2 sm:flex-row sm:flex-wrap"}>
      {phone && (
        <a
          href={`tel:${phone}`}
          className={`${btnBase} bg-white border border-neutral-300 text-neutral-900 hover:bg-[var(--public-cream-deep)]`}
        >
          <Phone className="w-4 h-4 shrink-0" />
          Gọi điện
        </a>
      )}
      {phone && (
        <button
          type="button"
          onClick={() => openZalo(phone)}
          className={`${btnBase} border border-[var(--public-accent-dark)] text-[var(--public-accent-dark)] bg-white hover:bg-[var(--public-cream-deep)]`}
        >
          <MessageCircle className="w-4 h-4 shrink-0" />
          Zalo
        </button>
      )}
      {!isBar && (
        <button
          type="button"
          onClick={handleConsult}
          className={`${btnBase} bg-neutral-900 text-white hover:bg-neutral-800`}
        >
          <MessageCircle className="w-4 h-4 shrink-0" />
          Nhắn tin tư vấn
        </button>
      )}
      {STUDIO_MESSENGER && !isBar && (
        <a
          href={STUDIO_MESSENGER}
          target="_blank"
          rel="noopener noreferrer"
          className={`${btnBase} border border-neutral-200 text-neutral-700 hover:bg-neutral-50`}
        >
          Messenger
        </a>
      )}
    </div>
  );
}

function SectionBlock({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-neutral-200/70 bg-white/80 shadow-sm p-5 sm:p-6 space-y-4">
      <div>
        <div className="flex items-center gap-2 text-[var(--public-accent-dark)] mb-1">
          {icon}
          <span className="text-[10px] tracking-[0.25em] uppercase text-neutral-500">Amazing Studio</span>
        </div>
        <h2 className="font-serif text-xl sm:text-2xl font-light text-neutral-900">{title}</h2>
        {subtitle && <p className="text-sm text-neutral-600 mt-1">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function RelatedProducts({
  items,
  basePath,
}: {
  items: PublicDressListItem[];
  basePath: string;
}) {
  if (items.length === 0) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((n) => (
          <div
            key={n}
            className="rounded-2xl border border-dashed border-neutral-300/80 bg-[var(--public-cream-deep)]/50 aspect-[3/4] flex flex-col items-center justify-center p-3 text-center"
          >
            <Shirt className="w-8 h-8 text-neutral-300 mb-2" />
            <p className="text-[11px] text-neutral-500 leading-snug">Sắp cập nhật sản phẩm tương tự</p>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
      {items.map((d) => (
        <Link
          key={d.id}
          href={`${basePath}/san-pham/${d.slug}`}
          className="group rounded-2xl overflow-hidden border border-neutral-200/70 bg-white shadow-sm hover:shadow-md transition-shadow"
        >
          <div className="aspect-[3/4] bg-neutral-100 overflow-hidden">
            {d.coverImageUrl ? (
              <img
                src={getImageSrc(d.coverImageUrl) ?? d.coverImageUrl}
                alt={d.name}
                className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-neutral-400">
                <Shirt className="w-10 h-10" />
              </div>
            )}
          </div>
          <div className="p-2.5 sm:p-3">
            <p className="text-sm font-medium text-neutral-900 line-clamp-2 leading-snug">{d.name}</p>
            {(d.salePrice ?? 0) > 0 && (d.salePrice ?? 0) < d.rentalPrice ? (
              <p className="text-xs mt-0.5">
                <span className="text-neutral-400 line-through">{formatVND(d.rentalPrice)}</span>{" "}
                <span className="text-rose-600 font-semibold">{formatVND(d.salePrice!)}</span>
              </p>
            ) : (
              <p className="text-xs text-neutral-500 mt-0.5">
                {d.rentalPrice > 0 ? formatVND(d.rentalPrice) : "Liên hệ"}
              </p>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}

export default function RentalDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [, setLocation] = useLocation();
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const { data: dress, isLoading, error } = useQuery<PublicDressDetail>({
    queryKey: ["public-dress-detail", slug],
    queryFn: async () => {
      const r = await fetch(
        `${CMS_BASE}/api/cms/public/dresses/slug/${encodeURIComponent(slug ?? "")}`,
      );
      if (!r.ok) throw new Error(r.status === 404 ? "not_found" : "error");
      return r.json();
    },
    enabled: !!slug,
    staleTime: 60_000,
    retry: false,
  });

  const { data: allDresses = [] } = useQuery<PublicDressListItem[]>({
    queryKey: ["public-dresses-related"],
    queryFn: async () => {
      const r = await fetch(`${CMS_BASE}/api/cms/public/dresses`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!dress,
    staleTime: 120_000,
  });

  const images = useMemo(() => {
    if (!dress) return [];
    const raw = [dress.coverImageUrl, ...(dress.extraImages || [])].filter(Boolean) as string[];
    return [...new Set(raw)];
  }, [dress]);

  const related = useMemo(() => {
    if (!dress) return [];
    const others = allDresses.filter((d) => d.slug && d.slug !== dress.slug);
    const sameCat = others.filter((d) => d.categoryId === dress.categoryId && dress.categoryId != null);
    return (sameCat.length >= 2 ? sameCat : others).slice(0, 4);
  }, [allDresses, dress]);

  const status = dress ? getPublicStatus(dress.rentalStatus) : null;
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  if (isLoading) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-neutral-500">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-neutral-300 border-t-neutral-900 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm tracking-wide">Đang tải...</p>
        </div>
      </div>
    );
  }

  const isNotFound = (error as Error)?.message === "not_found" || !dress;

  if (isNotFound) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center text-center px-6">
        <div>
          <p className="text-4xl mb-4">😔</p>
          <h1 className="font-serif text-xl font-light mb-2">Không tìm thấy sản phẩm</h1>
          <p className="text-neutral-600 text-sm mb-6">
            Sản phẩm này có thể đã hết hoặc không còn cho thuê.
          </p>
          <button
            type="button"
            onClick={() => setLocation(`${BASE}/cho-thue-do`)}
            className="px-6 py-2.5 bg-neutral-900 text-white rounded-xl text-sm tracking-wide hover:bg-neutral-800"
          >
            Xem tất cả đồ cho thuê
          </button>
        </div>
      </div>
    );
  }

  const shortDesc =
    dress.description?.trim() ||
    (dress.categoryName
      ? `Trang phục ${dress.categoryName.toLowerCase()} — liên hệ Amazing Studio để đặt thuê và phối concept.`
      : "Liên hệ Amazing Studio để đặt thuê và được tư vấn phối đồ phù hợp.");

  return (
    <div className="min-h-screen pb-28 lg:pb-16">
      <div className="sticky top-0 z-30 bg-[var(--public-cream,#faf8f5)]/90 backdrop-blur-sm border-b border-neutral-200/80 px-4 sm:px-6 py-3">
        <button
          type="button"
          onClick={() => setLocation(`${BASE}/cho-thue-do`)}
          className="flex items-center gap-1.5 text-sm text-neutral-600 hover:text-neutral-900 transition-colors max-w-[1100px] mx-auto"
        >
          <ArrowLeft className="w-4 h-4" />
          Cho thuê đồ
        </button>
      </div>

      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-5 sm:py-8">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:gap-10 lg:items-start">
          <div className="min-w-0">
            <ImageSlider
              images={images}
              onZoom={(i) => setLightboxIdx(i)}
              outfitTag={dress.outfitTag}
            />
          </div>

          <div className="mt-6 lg:mt-0 lg:sticky lg:top-[4.5rem] space-y-5">
            <div className="rounded-2xl border border-neutral-200/70 bg-white/90 shadow-sm p-5 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                {status && (
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${status.bg} ${status.color}`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
                    {status.label}
                  </span>
                )}
                <OutfitTagBadge tag={dress.outfitTag} />
              </div>

              {dress.categoryName && (
                <p className="text-[11px] tracking-[0.3em] uppercase text-neutral-500">
                  {dress.categoryName}
                </p>
              )}
              <h1 className="font-serif text-2xl sm:text-[1.75rem] font-light text-neutral-900 leading-tight capitalize">
                {dress.name}
              </h1>
              {dress.code && (
                <p className="text-xs text-neutral-500 font-mono tracking-wide">Mã: {dress.code}</p>
              )}

              <p className="text-sm text-neutral-600 leading-relaxed">{shortDesc}</p>

              <div className="rounded-xl bg-[var(--public-cream-deep)]/80 border border-neutral-200/50 p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs tracking-wide uppercase text-neutral-500">Giá thuê</span>
                  {(dress.salePrice ?? 0) > 0 && (dress.salePrice ?? 0) < dress.rentalPrice ? (
                    <span className="text-right">
                      <span className="block text-sm text-neutral-400 line-through leading-tight">
                        {formatVND(dress.rentalPrice)}
                      </span>
                      <span className="block font-serif text-xl text-rose-600 leading-tight">
                        {formatVND(dress.salePrice!)}
                      </span>
                    </span>
                  ) : (
                    <span className="font-serif text-xl text-[var(--public-accent-dark)]">
                      {dress.rentalPrice > 0 ? formatVND(dress.rentalPrice) : "Liên hệ"}
                    </span>
                  )}
                </div>
                {dress.depositRequired > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-neutral-500">Đặt cọc</span>
                    <span className="font-medium text-neutral-800">{formatVND(dress.depositRequired)}</span>
                  </div>
                )}
              </div>

              <div className="hidden lg:block pt-1">
                <p className="text-[11px] tracking-wide uppercase text-neutral-500 mb-2.5 text-center">
                  Liên hệ đặt thuê
                </p>
                <ProductCtaButtons dress={dress} layout="card" />
                {STUDIO_PHONE_DISPLAY && (
                  <p className="text-center text-xs text-neutral-500 mt-2 tabular-nums">
                    Hotline: {STUDIO_PHONE_DISPLAY}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 lg:mt-10 space-y-6 max-w-3xl lg:max-w-none">
          {(dress.sizeText ||
            dress.size ||
            dress.colorText ||
            dress.color ||
            dress.materialText ||
            dress.tagsText) && (
            <div className="rounded-2xl border border-neutral-200/70 bg-white/80 p-5 sm:p-6 space-y-3">
              <h2 className="font-serif text-lg font-light text-neutral-900">Chi tiết</h2>
              <Chip icon={<Ruler className="w-3 h-3" />} label="Size / Số đo" value={dress.sizeText || dress.size || ""} />
              <Chip icon={<Palette className="w-3 h-3" />} label="Màu sắc" value={dress.colorText || dress.color || ""} />
              <Chip icon={<Package className="w-3 h-3" />} label="Chất liệu" value={dress.materialText ?? ""} />
              <Chip icon={<Tag className="w-3 h-3" />} label="Tags" value={dress.tagsText ?? ""} />
            </div>
          )}

          {dress.description && (
            <div className="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap border-t border-neutral-200/80 pt-6">
              <p className="text-[11px] tracking-[0.25em] uppercase text-neutral-500 mb-2">Mô tả</p>
              {dress.description}
            </div>
          )}

          <PublicScheduleBlock dressId={dress.id} />
          <ConsultantSection dress={dress} />
        </div>

        <div className="mt-10 sm:mt-12 space-y-6">
          <SectionBlock
            icon={<Sparkles className="w-4 h-4" />}
            title="Gợi ý phối đồ & concept"
            subtitle="Tham khảo cách phối hài hòa với bộ ảnh của Amazing Studio."
          >
            <ul className="space-y-3">
              {STYLING_PLACEHOLDERS.map((tip, i) => (
                <li key={i} className="flex gap-3 text-sm text-neutral-700 leading-relaxed">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--public-cream-deep)] text-[var(--public-accent-dark)] text-xs flex items-center justify-center font-medium">
                    {i + 1}
                  </span>
                  {tip}
                </li>
              ))}
            </ul>
            <Link
              href={`${BASE}/bo-anh`}
              className="inline-flex items-center gap-1.5 text-sm text-[var(--public-accent-dark)] hover:text-neutral-900 transition-colors mt-2"
            >
              Xem bộ sưu tập concept
              <ArrowRight className="w-4 h-4" />
            </Link>
          </SectionBlock>

          <SectionBlock
            icon={<Info className="w-4 h-4" />}
            title="Lưu ý khi thuê đồ"
            subtitle="Quy trình chuẩn tại studio — có thể điều chỉnh theo từng sản phẩm."
          >
            <ul className="space-y-2.5">
              {RENTAL_NOTES.map((note, i) => (
                <li key={i} className="flex gap-2.5 text-sm text-neutral-700 leading-relaxed">
                  <span className="text-[var(--public-accent-dark)] mt-0.5">·</span>
                  {note}
                </li>
              ))}
            </ul>
          </SectionBlock>

          <SectionBlock
            icon={<Shirt className="w-4 h-4" />}
            title="Sản phẩm liên quan"
            subtitle={
              related.length > 0
                ? "Cùng danh mục hoặc phong cách tương tự."
                : "Đang bổ sung thêm mẫu trong kho."
            }
          >
            <RelatedProducts items={related} basePath={BASE} />
          </SectionBlock>
        </div>
      </div>

      <div className="lg:hidden fixed inset-x-0 bottom-0 z-40 bg-[var(--public-cream,#faf8f5)]/95 backdrop-blur-md border-t border-neutral-200/80 px-4 py-3 safe-area-bottom">
        <p className="text-[10px] tracking-wide uppercase text-center text-neutral-500 mb-2">
          Đặt thuê nhanh
        </p>
        <ProductCtaButtons dress={dress} layout="bar" />
      </div>

      {lightboxIdx !== null && images.length > 0 && (
        <Lightbox images={images} startIdx={lightboxIdx} onClose={() => setLightboxIdx(null)} />
      )}
    </div>
  );
}

function PublicScheduleBlock({ dressId }: { dressId: number }) {
  const { data: schedule = [], isLoading } = useOutfitSchedule(dressId, "public");
  const today = new Date().toISOString().slice(0, 10);
  const future = schedule.filter((s) => s.returnDate >= today);
  if (isLoading)
    return (
      <div className="py-2 text-xs text-neutral-500 flex items-center gap-1">
        <Calendar className="w-3 h-3 animate-pulse" /> Đang tải lịch...
      </div>
    );
  if (!future.length) return null;
  const fmtDM = (d: string) => {
    try {
      return format(parseISO(d), "dd/MM", { locale: vi });
    } catch {
      return d;
    }
  };
  return (
    <div className="rounded-2xl border border-neutral-200/70 bg-white/80 p-4 space-y-2">
      <div className="flex items-center gap-1.5 text-sm font-medium text-neutral-900">
        <Calendar className="w-4 h-4 text-[var(--public-accent-dark)]" />
        Lịch đã có
      </div>
      <div className="space-y-1.5">
        {future.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between text-xs bg-[var(--public-cream-deep)]/60 rounded-lg px-2.5 py-1.5 border border-neutral-200/50"
          >
            <span className="text-neutral-600">
              {fmtDM(s.pickupDate)} → {fmtDM(s.returnDate)}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] ${
                s.status === "returned"
                  ? "bg-emerald-100 text-emerald-700"
                  : s.status === "picked_up"
                    ? "bg-neutral-200 text-neutral-700"
                    : "bg-amber-100 text-amber-800"
              }`}
            >
              {s.status === "returned" ? "Đã trả" : s.status === "picked_up" ? "Đã lấy" : "Đã giữ"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
