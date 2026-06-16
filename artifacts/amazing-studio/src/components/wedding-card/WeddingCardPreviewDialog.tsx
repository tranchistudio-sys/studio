import { X } from "lucide-react";
import { WeddingCardFullPreview } from "./WeddingCardFullPreview";
import { WeddingCardPhoneFrame } from "./WeddingCardPhoneFrame";
import { buildDemoCard } from "./wedding-card-config";
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

  const card = buildDemoCard(template);

  return (
    <div
      className="wc-overlay fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal
      onClick={onClose}
    >
      <div
        className="wc-success-pop w-full sm:max-w-md bg-[var(--wc-bt-cream,#fdfbf9)] rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--wc-bt-border,#e8e0d8)]">
          <p className="text-sm font-medium text-[var(--wc-bt-text)]">Xem mẫu thiệp</p>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full hover:bg-[var(--wc-bt-cream-2,#f5f0eb)]"
            aria-label="Đóng"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <WeddingCardPhoneFrame variant="bare" fullLength>
            <WeddingCardFullPreview card={card} />
          </WeddingCardPhoneFrame>
        </div>
        <div className="p-4 border-t border-[var(--wc-bt-border,#e8e0d8)]">
          <a
            href={`/thiep-cuoi-online/tao?template=${template.slug}`}
            className="wc-bt-btn wc-bt-btn-primary w-full"
          >
            Dùng mẫu này
          </a>
        </div>
      </div>
    </div>
  );
}
