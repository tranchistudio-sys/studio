import { LazyImage } from "@/components/cms-shared";

/** Ảnh preview — fade-in khi URL đổi (sau upload). */
export function WeddingCardPreviewImage({
  src,
  alt = "",
  className = "",
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  if (!src) return null;
  return (
    <LazyImage
      key={src}
      src={src}
      alt={alt}
      className={`wc-img-fade-in ${className}`.trim()}
    />
  );
}
