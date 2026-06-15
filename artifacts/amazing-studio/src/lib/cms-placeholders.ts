/** Ảnh placeholder sang trọng khi CMS chưa upload (Unsplash, crop web). */

export const PLACEHOLDER_HERO =
  "https://images.unsplash.com/photo-1511285560929-80b456fea0bc?w=1600&auto=format&fit=crop&q=80";

export const PLACEHOLDER_ABOUT =
  "https://images.unsplash.com/photo-1606216794074-735e91aa2c92?w=900&auto=format&fit=crop&q=80";

export const PLACEHOLDER_FEATURED_CONCEPT =
  "https://images.unsplash.com/photo-1522673607200-164d1b6fc486?w=1200&auto=format&fit=crop&q=80";

export const PLACEHOLDER_FEATURED_SERVICE =
  "https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?w=1200&auto=format&fit=crop&q=80";

export const PLACEHOLDER_FOOTER_BANNER =
  "https://images.unsplash.com/photo-1464366400600-7168b8af9bc3?w=1600&auto=format&fit=crop&q=80";

export const PLACEHOLDER_WEDDING_CARD =
  "https://images.unsplash.com/photo-1519741497674-611481863552?w=600&auto=format&fit=crop&q=85";

export function weddingTemplatePlaceholder(category: string | null | undefined): string {
  switch (category) {
    case "Hàn Quốc":
      return "https://images.unsplash.com/photo-1529634806980-85c3dd6d34ac?w=600&auto=format&fit=crop&q=85";
    case "Hiện Đại":
      return "https://images.unsplash.com/photo-1515934751635-c81c6bc9a2d8?w=600&auto=format&fit=crop&q=85";
    case "Burgundy":
      return "https://images.unsplash.com/photo-1465495976277-4387d4b0b4c6?w=600&auto=format&fit=crop&q=85";
    case "Lãng Mạn":
      return "https://images.unsplash.com/photo-1520854221256-174b7ce0ed8c?w=600&auto=format&fit=crop&q=85";
    default:
      return PLACEHOLDER_WEDDING_CARD;
  }
}
