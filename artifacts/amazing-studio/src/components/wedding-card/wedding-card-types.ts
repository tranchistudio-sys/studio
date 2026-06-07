import type { PublicWeddingCard } from "@/hooks/use-wedding-cards";

export type WeddingCardData = PublicWeddingCard;

export interface WeddingCardTemplateProps {
  card: WeddingCardData;
  coverSrc: string | null;
  coupleSrc: string | null;
  embed?: boolean;
}
