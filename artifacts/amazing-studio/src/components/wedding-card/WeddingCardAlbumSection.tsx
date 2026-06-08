import { getImageSrc } from "@/lib/imageUtils";
import { WeddingCardPreviewImage } from "./WeddingCardPreviewImage";

export function WeddingCardAlbumSection({
  coverImageUrl,
  coupleImageUrl,
}: {
  coverImageUrl: string | null;
  coupleImageUrl: string | null;
}) {
  const images = [coverImageUrl, coupleImageUrl]
    .map((u) => getImageSrc(u))
    .filter((s): s is string => !!s);

  if (images.length === 0) return <div id="wc-section-album" className="sr-only" aria-hidden />;

  return (
    <section className="wc-bt-view-section" id="wc-section-album">
      <p className="wc-bt-section-eyebrow">Khoảnh khắc</p>
      <h2 className="wc-bt-section-title">Album ảnh</h2>
      <div className={images.length >= 2 ? "wc-bt-album-duo" : "wc-bt-album-single"}>
        {images.map((src, i) => (
          <div key={src + i} className="wc-bt-album-item">
            <WeddingCardPreviewImage src={src} className="w-full h-full object-cover" />
          </div>
        ))}
      </div>
    </section>
  );
}
