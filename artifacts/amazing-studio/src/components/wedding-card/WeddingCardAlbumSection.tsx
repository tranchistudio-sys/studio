import { Heart } from "lucide-react";
import { getImageSrc } from "@/lib/imageUtils";
import { WeddingCardPreviewImage } from "./WeddingCardPreviewImage";
import { WeddingCardReveal } from "./WeddingCardReveal";

export function WeddingCardAlbumSection({
  coverImageUrl,
  coupleImageUrl,
}: {
  coverImageUrl: string | null;
  coupleImageUrl: string | null;
}) {
  const base = [coverImageUrl, coupleImageUrl]
    .map((u) => getImageSrc(u))
    .filter((s): s is string => !!s);

  const images = base.length >= 6 ? base.slice(0, 6) : [...base, ...base, ...base].slice(0, 6);

  if (images.length === 0) return <div id="wc-section-album" className="sr-only" aria-hidden />;

  return (
    <WeddingCardReveal className="wc-bt-view-section wc-bt-album" id="wc-section-album">
      <p className="wc-bt-section-eyebrow">Photo Album</p>
      <h2 className="wc-bt-section-title">Album Ảnh Cưới</h2>
      <div className="wc-bt-section-heart">
        <Heart className="w-3 h-3 fill-current" />
      </div>
      <div className="wc-bt-album-grid">
        {images.map((src, i) => (
          <div key={src + i} className="wc-bt-album-grid-item">
            <WeddingCardPreviewImage src={src} className="w-full h-full object-cover" />
          </div>
        ))}
      </div>
    </WeddingCardReveal>
  );
}
