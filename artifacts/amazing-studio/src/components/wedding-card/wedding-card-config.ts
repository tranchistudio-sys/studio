import type { PublicWeddingCard, WeddingCardTemplate } from "@/hooks/use-wedding-cards";

/**
 * Ảnh mẫu do Amazing Studio chuẩn bị — CHỈ dùng minh họa trên landing / preview / mẫu thiệp.
 * Khách tạo thiệp vẫn upload ảnh riêng; các URL này không ghi vào thiệp của khách.
 *
 * Cách thêm ảnh mới:
 * 1. Copy file vào public/uploads/wedding-samples/ (webp/jpg, nên < 500KB)
 * 2. Khai báo đường dẫn bên dưới (bắt đầu bằng /uploads/wedding-samples/...)
 * 3. F5 trang /thiep-cuoi-online — mockup hero & kho mẫu đổi ngay
 *
 * Hoặc upload qua CMS → Mẫu thiệp → trường Mockup / Ảnh nền mặc định (ưu tiên hơn file tĩnh).
 */
export const WEDDING_SAMPLE_IMAGES = {
  /** Demo chung — ô preview hero landing */
  demoCover: "/uploads/wedding-samples/demo-cover.webp",
  demoCouple: "/uploads/wedding-samples/demo-couple.webp",
  /** Theo từng mẫu — kho giao diện + dialog Xem mẫu */
  byTemplate: {
    classic: {
      mockup: "/uploads/wedding-samples/classic-mockup.webp",
      cover: "/uploads/wedding-samples/demo-cover.webp",
      couple: "/uploads/wedding-samples/demo-couple.webp",
    },
    modern: {
      mockup: "/uploads/wedding-samples/modern-mockup.webp",
      cover: "/uploads/wedding-samples/modern-mockup.webp",
      couple: "/uploads/wedding-samples/demo-couple.webp",
    },
    romantic: {
      mockup: "/uploads/wedding-samples/romantic-mockup.webp",
      cover: "/uploads/wedding-samples/romantic-mockup.webp",
      couple: "/uploads/wedding-samples/demo-couple.webp",
    },
  },
} as const;

export type WeddingSampleSlug = keyof typeof WEDDING_SAMPLE_IMAGES.byTemplate;

export function getTemplateSampleImages(slug: string) {
  const key = slug as WeddingSampleSlug;
  return WEDDING_SAMPLE_IMAGES.byTemplate[key] ?? null;
}

/** Gộp ảnh mẫu studio + ảnh từ CMS/API (CMS ưu tiên hơn file tĩnh). */
export function resolveTemplatePreviewUrls(template: Pick<
  WeddingCardTemplate,
  "slug" | "mockupImageUrl" | "previewImageUrl" | "thumbnailUrl" | "defaultBackgroundUrl"
>) {
  const samples = getTemplateSampleImages(template.slug);
  return {
    mockup:
      template.mockupImageUrl ??
      template.previewImageUrl ??
      samples?.mockup ??
      null,
    cover:
      template.defaultBackgroundUrl ??
      template.mockupImageUrl ??
      samples?.cover ??
      WEDDING_SAMPLE_IMAGES.demoCover,
    couple:
      template.thumbnailUrl ??
      samples?.couple ??
      WEDDING_SAMPLE_IMAGES.demoCouple,
  };
}

/** Thiệp demo trên landing — luôn có ảnh mẫu studio, không dùng ảnh khách. */
export function buildDemoCard(
  template?: Pick<WeddingCardTemplate, "slug" | "themeKey" | "mockupImageUrl" | "previewImageUrl" | "thumbnailUrl" | "defaultBackgroundUrl"> | null,
): PublicWeddingCard {
  const slug = template?.slug ?? "classic";
  const urls = template
    ? resolveTemplatePreviewUrls(template)
    : {
        mockup: null,
        cover: WEDDING_SAMPLE_IMAGES.demoCover,
        couple: WEDDING_SAMPLE_IMAGES.demoCouple,
      };

  return {
    ...DEMO_CARD,
    templateSlug: slug,
    themeKey: template?.themeKey ?? slug,
    coverImageUrl: urls.cover,
    coupleImageUrl: urls.couple,
  };
}

/** Hiển thị ngay khi API lỗi hoặc trả rỗng — slug khớp DB. */
export const FALLBACK_WEDDING_TEMPLATES: WeddingCardTemplate[] = [
  {
    id: 1,
    slug: "classic",
    name: "Hàn Quốc",
    description: "Tối giản pastel, chữ thanh lịch — phong cách thiệp Hàn",
    category: "Hàn Quốc",
    thumbnailUrl: WEDDING_SAMPLE_IMAGES.byTemplate.classic.couple,
    previewImageUrl: WEDDING_SAMPLE_IMAGES.byTemplate.classic.mockup,
    mockupImageUrl: WEDDING_SAMPLE_IMAGES.byTemplate.classic.mockup,
    defaultBackgroundUrl: WEDDING_SAMPLE_IMAGES.byTemplate.classic.cover,
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
    thumbnailUrl: WEDDING_SAMPLE_IMAGES.byTemplate.modern.couple,
    previewImageUrl: WEDDING_SAMPLE_IMAGES.byTemplate.modern.mockup,
    mockupImageUrl: WEDDING_SAMPLE_IMAGES.byTemplate.modern.mockup,
    defaultBackgroundUrl: WEDDING_SAMPLE_IMAGES.byTemplate.modern.cover,
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
    thumbnailUrl: WEDDING_SAMPLE_IMAGES.byTemplate.romantic.couple,
    previewImageUrl: WEDDING_SAMPLE_IMAGES.byTemplate.romantic.mockup,
    mockupImageUrl: WEDDING_SAMPLE_IMAGES.byTemplate.romantic.mockup,
    defaultBackgroundUrl: WEDDING_SAMPLE_IMAGES.byTemplate.romantic.cover,
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
