import { X } from "lucide-react";
import { WeddingCardRenderer } from "./WeddingCardRenderer";
import { WeddingCardPhoneFrame } from "./WeddingCardPhoneFrame";
import { DEMO_CARD } from "./wedding-card-config";
import type { WeddingCardTemplate } from "@/hooks/use-wedding-cards";

export function WeddingCardPreviewDialog({
  template,
  open,
  onClose,
}: {
  template: WeddingCardTemplate | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!open || !template) return null;

  const card = {
    ...DEMO_CARD,
    templateSlug: template.slug,
    themeKey: template.themeKey,
  };

  return (
    <div
      className="wc-overlay fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal
      onClick={onClose}
    >
      <div
        className="wc-success-pop w-full sm:max-w-md bg-[#faf8f5] rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200/80">
          <p className="text-sm font-medium text-neutral-800">Xem mẫu thiệp</p>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full hover:bg-neutral-200/60"
            aria-label="Đóng"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <WeddingCardPhoneFrame variant="bare">
            <WeddingCardRenderer card={card} embed />
          </WeddingCardPhoneFrame>
        </div>
      </div>
    </div>
  );
}
