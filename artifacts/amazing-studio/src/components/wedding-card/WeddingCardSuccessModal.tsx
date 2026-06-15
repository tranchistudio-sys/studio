import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Check, Copy, ExternalLink, Share2, X } from "lucide-react";
import { buildShareUrl } from "./wedding-card-config";

export function WeddingCardSuccessModal({
  slug,
  groomName,
  brideName,
  onClose,
}: {
  slug: string;
  groomName: string;
  brideName: string;
  onClose?: () => void;
}) {
  const shareUrl = buildShareUrl(slug);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt("Sao chép link thiệp:", shareUrl);
    }
  };

  return (
    <div className="wc-success-backdrop fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-4 sm:p-6 bg-black/40 backdrop-blur-sm">
      <div className="wc-success-pop w-full max-w-md rounded-2xl bg-[var(--wc-bt-cream,#fdfbf9)] shadow-2xl overflow-hidden border border-[var(--wc-bt-border)]" role="dialog">
        <div className="px-6 pt-8 pb-6 text-center relative">
          {onClose && (
            <button type="button" onClick={onClose} className="absolute top-3 right-3 p-2 rounded-full hover:bg-black/5" aria-label="Đóng">
              <X className="h-5 w-5 text-[var(--wc-bt-muted)]" />
            </button>
          )}
          <div className="wc-success-check mx-auto w-16 h-16 rounded-full bg-[rgba(212,165,154,0.2)] flex items-center justify-center mb-4">
            <Check className="w-8 h-8 text-[var(--wc-bt-taupe)]" />
          </div>
          <h2 className="font-serif text-2xl text-[var(--wc-bt-text)]">Thiệp cưới đã sẵn sàng</h2>
          <p className="mt-2 text-sm text-[var(--wc-bt-muted)]">
            <span className="font-medium text-[var(--wc-bt-text)]">{groomName}</span>
            <span className="text-[var(--wc-bt-rose-text)] mx-1">&</span>
            <span className="font-medium text-[var(--wc-bt-text)]">{brideName}</span>
          </p>
          <p className="mt-1 text-xs text-[var(--wc-bt-muted)]">Gửi link cho bạn bè & người thân</p>
        </div>
        <div className="px-6 pb-6 space-y-3">
          <div className="rounded-xl border border-[var(--wc-bt-border)] bg-white p-3 text-left">
            <p className="text-[10px] uppercase tracking-wider text-[var(--wc-bt-muted)] mb-1">Link thiệp</p>
            <p className="text-xs text-[var(--wc-bt-text)] break-all font-mono leading-relaxed">{shareUrl}</p>
          </div>
          <button type="button" onClick={copyLink} className="wc-bt-btn wc-bt-btn-primary w-full">
            <Copy className="w-4 h-4" />
            {copied ? "Đã copy link!" : "Copy link"}
          </button>
          <Link href={`/thiep-cuoi/${slug}`} className="wc-bt-btn wc-bt-btn-outline w-full">
            <ExternalLink className="w-4 h-4" />
            Xem thiệp
          </Link>
          <div className="flex gap-2">
            <a href={`https://zalo.me/share?url=${encodeURIComponent(shareUrl)}`} target="_blank" rel="noopener noreferrer" className="wc-bt-btn flex-1 bg-[#0068ff] text-white text-xs">
              Zalo
            </a>
            <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`} target="_blank" rel="noopener noreferrer" className="wc-bt-btn flex-1 bg-[#1877f2] text-white text-xs">
              <Share2 className="w-3.5 h-3.5" />
              Facebook
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
