/** Static copy & testimonials for public marketing site (no CMS/DB). */

export const STUDIO_NAME = "Amazing Studio";
export const STUDIO_TAGLINE = "Amazing Studio · Tây Ninh";

export const HERO = {
  eyebrow: "Premium Wedding Photography",
  titleLine1: "Lưu giữ khoảnh khắc",
  titleLine2: "đẹp nhất của bạn",
  subtitle:
    "Chụp ảnh cưới, beauty, áo dài, Việt phục và cho thuê trang phục cao cấp — đồng hành cùng bạn trong những ngày trọng đại.",
  ctaPrimary: { label: "Tư vấn ngay", href: "/lien-he" },
  ctaSecondary: { label: "Xem bảng giá", href: "/bang-gia" },
} as const;

/** Optional override; empty → use first visible album cover from CMS */
export const HERO_IMAGE_URL: string | null = null;

export const ABOUT = {
  eyebrow: "Về chúng tôi",
  title: "Câu chuyện của Amazing Studio",
  paragraphs: [
    "Amazing Studio là tiệm chụp ảnh và cho thuê trang phục tại Tây Ninh. Chúng tôi tin rằng mỗi khoảnh khắc đều xứng đáng được lưu giữ một cách trọn vẹn và chân thật.",
    "Với đội ngũ nhiếp ảnh gia, makeup artist và kho trang phục đa dạng, chúng tôi đồng hành cùng bạn — từ concept ảnh đến ngày cưới trọng đại.",
  ],
} as const;

export const STUDIO_PHONE = "0392817079";
export const STUDIO_PHONE_DISPLAY = "0392 817 079";
export const STUDIO_EMAIL = "tranchistudio@gmail.com";
export const STUDIO_ADDRESS =
  "Số 80, Hẻm 71, CMT8, KP Hiệp Bình, P. Hiệp Ninh, TP Tây Ninh";
export const STUDIO_HOURS = "Thứ 2 — Chủ nhật · 8:00 — 18:00";

export const CONSULTANTS: { name: string; phone: string }[] = [
  { name: "Nhân viên tư vấn 1", phone: "0364902228" },
  { name: "Nhân viên tư vấn 2", phone: "0392817079" },
];

/**
 * Link chat tư vấn — thứ tự ưu tiên link Fanpage:
 * 1. env VITE_FANPAGE_MESSENGER (tương đương settings FACEBOOK_MESSENGER_URL — hiện chưa có)
 * 2. https://m.me/{PAGE_ID} — PAGE_ID thật từ settings.fb_active_page_id (page "Amazing Studio")
 * Fallback hiển thị page công khai: FANPAGE_URL.
 * Lưu ý: desktop chưa đăng nhập Facebook sẽ thấy trang login Messenger trước —
 * hành vi bắt buộc của Facebook; trên điện thoại m.me mở thẳng app Messenger.
 */
export const FACEBOOK_PAGE_ID = "105341331408346";
export const FANPAGE_MESSENGER_URL: string =
  import.meta.env.VITE_FANPAGE_MESSENGER || `https://m.me/${FACEBOOK_PAGE_ID}`;
export const FANPAGE_URL = "https://www.facebook.com/Amazingstudio";

/** Facebook cá nhân Trần Chí (chat trực tiếp với chủ studio). */
export const TRANCHI_CHAT_URL: string =
  import.meta.env.VITE_TRANCHI_MESSENGER || "https://www.facebook.com/LyonTrann/";

/** Zalo tư vấn — số hotline studio. */
export const ZALO_CHAT_PHONE = "0392817079";

export interface Testimonial {
  quote: string;
  author: string;
  role?: string;
}

export const GALLERY_PAGE = {
  eyebrow: "AMAZING STUDIO · PORTFOLIO",
  title: "Bộ sưu tập concept",
  subtitle: "Khoảnh khắc đáng nhớ",
  description:
    "Những concept đẹp nhất Amazing Studio đã thực hiện cho khách hàng.",
  watermark: "GALLERY",
} as const;

export const RENTAL_PAGE = {
  eyebrow: "TRANG PHỤC",
  title: "Cho thuê đồ",
  description:
    "Kho trang phục đa dạng cho chụp ảnh, ngày cưới và mọi dịp đặc biệt.",
  watermark: "WARDROBE",
} as const;

export const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "Ảnh cưới đẹp tự nhiên, team tư vấn nhiệt tình. Concept và makeup rất hợp với phong cách chúng mình.",
    author: "Chị Lan & Anh Minh",
    role: "Khách chụp pre-wedding",
  },
  {
    quote:
      "Váy cưới đa dạng, form đẹp. Thuê đồ và chụp cùng một chỗ nên tiện lắm, không phải chạy nhiều nơi.",
    author: "Chị Hương",
    role: "Khách cho thuê váy",
  },
  {
    quote:
      "Bảng giá rõ ràng, không phát sinh bất ngờ. Album giao đúng hẹn, màu ảnh sang và ấm.",
    author: "Anh Tuấn & Chị Vy",
    role: "Khách gói phóng sự cưới",
  },
  {
    quote:
      "Studio sạch sẽ, ánh sáng đẹp. Nhân viên hỗ trợ thay đồ và tạo dáng rất có tâm.",
    author: "Chị Thảo",
    role: "Khách chụp beauty",
  },
];
