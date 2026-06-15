import type { PublicWeddingCard } from "@/hooks/use-wedding-cards";
import { WeddingCardRenderer } from "./WeddingCardRenderer";
import { WeddingCardViewExtras } from "./WeddingCardViewExtras";
import { WeddingCardPetals } from "./WeddingCardPetals";

/** Preview dài đầy đủ như khách xem thiệp BT */
export function WeddingCardFullPreview({ card }: { card: PublicWeddingCard }) {
  return (
    <div className="wc-bt-full-preview relative">
      <WeddingCardPetals />
      <div className="relative z-10">
        <WeddingCardRenderer card={card} embed={false} />
        <WeddingCardViewExtras card={card} preview />
      </div>
    </div>
  );
}
