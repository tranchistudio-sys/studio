import { getImageSrc } from "@/lib/imageUtils";
import type { WeddingCardData } from "./wedding-card-types";
import { WeddingCardClassic } from "./templates/WeddingCardClassic";
import { WeddingCardModern } from "./templates/WeddingCardModern";
import { WeddingCardRomantic } from "./templates/WeddingCardRomantic";

export function WeddingCardRenderer({
  card,
  embed = false,
}: {
  card: WeddingCardData;
  /** Trong khung preview điện thoại — không full viewport */
  embed?: boolean;
}) {
  const coverSrc = getImageSrc(card.coverImageUrl);
  const coupleSrc = getImageSrc(card.coupleImageUrl);
  const key = card.themeKey ?? card.templateSlug ?? "classic";
  const props = { card, coverSrc, coupleSrc, embed };

  switch (key) {
    case "modern":
      return <WeddingCardModern {...props} />;
    case "romantic":
      return <WeddingCardRomantic {...props} />;
    case "classic":
    default:
      return <WeddingCardClassic {...props} />;
  }
}
