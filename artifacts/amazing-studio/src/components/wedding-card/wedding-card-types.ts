import type { PublicWeddingCard } from '@/hooks/use-wedding-cards';
import type { RefObject } from 'react';

export type WeddingCardData = PublicWeddingCard;

export interface WeddingCardTemplateProps {
  card: WeddingCardData;
  coverSrc: string | null;
  coupleSrc: string | null;
  embed?: boolean;
  onGroomNameChange?: (name: string) => void;
  onBrideNameChange?: (name: string) => void;
  onCoverImageClick?: () => void;
  onCoupleImageClick?: () => void;
  coverInputRef?: RefObject<HTMLInputElement | null>;
  coupleInputRef?: RefObject<HTMLInputElement | null>;
}
