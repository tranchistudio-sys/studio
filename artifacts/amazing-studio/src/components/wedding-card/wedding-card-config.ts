import type { PublicWeddingCard, WeddingCardTemplate } from "@/hooks/use-wedding-cards";

/** Hiển thị ngay khi API lỗi hoặc trả rỗng — slug khớp DB. */
export const FALLBACK_WEDDING_TEMPLATES: WeddingCardTemplate[] = [
  {
    id: 1,
    slug: "classic",
    name: "Hàn Quốc",
    description: "Tối giản pastel, chữ thanh lịch — phong cách thiệp Hàn",
    category: "Hàn Quốc",
    thumbnailUrl: null,
    previewImageUrl: null,
    mockupImageUrl: null,
    defaultBackgroundUrl: null,
    themeColor: "#e8dfd4",
    themeKey: "classic",
    sortOrder: 1,
  },
  {
    id: 2,
    slug: "modern",
    name: "Hiện Đại",
    description: "Trắng đen, layout gọn — nét đương đại",
    category: "Hiện Đại",
    thumbnailUrl: null,
    previewImageUrl: null,
    mockupImageUrl: null,
    defaultBackgroundUrl: null,
    themeColor: "#171717",
    themeKey: "modern",
    sortOrder: 2,
  },
  {
    id: 3,
    slug: "romantic",
    name: "Burgundy",
    description: "Đỏ rượu vang, ấm áp và sang trọng",
    category: "Burgundy",
    thumbnailUrl: null,
    previewImageUrl: null,
    mockupImageUrl: null,
    defaultBackgroundUrl: null,
    themeColor: "#8B2942",
    themeKey: "romantic",
    sortOrder: 3,
  },
];

/** Slug DB giữ nguyên; hiển thị tên marketing không đổi schema. */
export const TEMPLATE_DISPLAY: Record<
  string,
  {
    title: string;
    subtitle: string;
    badge?: "popular" | "new";
    previewGradient: string;
    previewAccent: string;
  }
> = {
  classic: {
    title: "Hàn Quốc",
    subtitle: "Tối giản pastel, chữ thanh lịch — phong cách thiệp Hàn",
    badge: "popular",
    previewGradient: "from-[#f8f4f0] via-[#efe8e0] to-[#e8dfd4]",
    previewAccent: "text-stone-600",
  },
  modern: {
    title: "Hiện Đại",
    subtitle: "Trắng đen, layout gọn — nét đương đại",
    badge: "new",
    previewGradient: "from-neutral-900 via-neutral-800 to-neutral-700",
    previewAccent: "text-white/90",
  },
  romantic: {
    title: "Burgundy",
    subtitle: "Đỏ rượu vang, ấm áp và sang trọng",
    previewGradient: "from-[#4a1525] via-[#6b2d3e] to-[#8b3d52]",
    previewAccent: "text-rose-50/95",
  },
};

export function getTemplateDisplay(slug: string, fallbackName?: string) {
  return (
    TEMPLATE_DISPLAY[slug] ?? {
      title: fallbackName ?? slug,
      subtitle: "",
      previewGradient: "from-neutral-100 to-neutral-200",
      previewAccent: "text-neutral-700",
    }
  );
}

export const DEMO_CARD: PublicWeddingCard = {
  id: 0,
  slug: "demo",
  status: "published",
  templateId: 0,
  templateSlug: "classic",
  themeKey: "classic",
  groomName: "Minh",
  brideName: "Lan",
  weddingDate: "2026-10-18",
  ceremonyTime: "09:00",
  receptionTime: "17:30",
  venueGroom: "Nhà trai — Tây Ninh",
  venueBride: "Nhà gái — Tây Ninh",
  venueReception: "Nhà hàng tiệc cưới",
  mapsUrlGroom: null,
  mapsUrlBride: null,
  mapsUrlReception: null,
  invitationMessage:
    "Trân trọng kính mời quý khách đến chung vui cùng gia đình chúng tôi trong ngày trọng đại.",
  coverImageUrl: null,
  coupleImageUrl: null,
  contactPhone: "0392817079",
  viewCount: 0,
  publishedAt: null,
  createdAt: new Date().toISOString(),
};

export function buildShareUrl(slug: string): string {
  if (typeof window === "undefined") return `/thiep-cuoi/${slug}`;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${window.location.origin}${base}/thiep-cuoi/${slug}`;
}
