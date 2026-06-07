import { useEffect } from "react";
import { Link } from "wouter";
import { Check, Copy, ExternalLink, Share2, X } from "lucide-react";
import { buildShareUrl } from "./wedding-card-config";
import { useState } from "react";

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
      <div
        className="wc-success-pop w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-hidden"
        role="dialog"
        aria-labelledby="wc-success-title"
      >
        <div className="bg-gradient-to-br from-rose-50 via-white to-amber-50 px-6 pt-8 pb-6 text-center relative">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="absolute top-3 right-3 p-2 rounded-full hover:bg-black/5"
              aria-label="Đóng"
            >
              <X className="h-5 w-5 text-neutral-500" />
            </button>
          )}
          <div className="wc-success-check mx-auto w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mb-4 ring-4 ring-emerald-50">
            <Check className="w-8 h-8 text-emerald-600" />
          </div>
          <h2 id="wc-success-title" className="font-serif text-2xl text-neutral-900">
            Thiệp cưới đã sẵn sàng
          </h2>
          <p className="mt-2 text-sm text-neutral-600">
            <span className="font-medium text-neutral-800">{groomName}</span>
            <span className="text-rose-400 mx-1">&</span>
            <span className="font-medium text-neutral-800">{brideName}</span>
          </p>
          <p className="mt-1 text-xs text-neutral-500">Gửi link cho bạn bè & người thân</p>
        </div>
        <div className="px-6 pb-6 space-y-3">
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-left">
            <p className="text-[10px] uppercase tracking-wider text-neutral-400 mb-1">Link thiệp</p>
            <p className="text-xs text-neutral-800 break-all font-mono leading-relaxed">{shareUrl}</p>
          </div>
          <button
            type="button"
            onClick={copyLink}
            className="wc-touch-btn wc-btn-glow w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-neutral-900 text-white text-sm font-bold"
          >
            <Copy className="w-4 h-4" />
            {copied ? "Đã copy link!" : "Copy link"}
          </button>
          <Link
            href={`/thiep-cuoi/${slug}`}
            className="wc-touch-btn w-full flex items-center justify-center gap-2 py-3.5 rounded-xl border-2 border-rose-200 text-rose-700 text-sm font-semibold hover:bg-rose-50"
          >
            <ExternalLink className="w-4 h-4" />
            Xem thiệp
          </Link>
          <div className="flex gap-2">
            <a
              href={`https://zalo.me/share?url=${encodeURIComponent(shareUrl)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="wc-touch-btn flex-1 flex items-center justify-center py-2.5 rounded-xl bg-[#0068ff] text-white text-xs font-semibold"
            >
              Zalo
            </a>
            <a
              href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="wc-touch-btn flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl bg-[#1877f2] text-white text-xs font-semibold"
            >
              <Share2 className="w-3.5 h-3.5" />
              Facebook
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
