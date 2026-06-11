import { getImageSrc } from "@/lib/imageUtils";
import type { WeddingCardData } from "./wedding-card-types";
import { WeddingCardClassic } from "./templates/WeddingCardClassic";
import { WeddingCardModern } from "./templates/WeddingCardModern";
import { WeddingCardRomantic } from "./templates/WeddingCardRomantic";
import type { RefObject } from "react";

export function WeddingCardRenderer({
  card,
  embed = false,
  onGroomNameChange,
  onBrideNameChange,
  onCoverImageClick,
  onCoupleImageClick,
  coverInputRef,
  coupleInputRef,
}: {
  card: WeddingCardData;
  embed?: boolean;
  onGroomNameChange?: (name: string) => void;
  onBrideNameChange?: (name: string) => void;
  onCoverImageClick?: () => void;
  onCoupleImageClick?: () => void;
  coverInputRef?: RefObject<HTMLInputElement | null>;
  coupleInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const coverSrc = getImageSrc(card.coverImageUrl);
  const coupleSrc = getImageSrc(card.coupleImageUrl);
  const key = card.themeKey ?? card.templateSlug ?? "classic";
  const props = {
    card,
    coverSrc,
    coupleSrc,
    embed,
    onGroomNameChange,
    onBrideNameChange,
    onCoverImageClick,
    onCoupleImageClick,
    coverInputRef,
    coupleInputRef,
  };

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
