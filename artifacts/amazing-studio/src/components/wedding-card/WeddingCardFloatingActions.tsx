import { useState } from "react";
import { Copy, Home, Share2 } from "lucide-react";
import { Link } from "wouter";

export function WeddingCardFloatingActions({ shareUrl }: { shareUrl: string }) {
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Sao chép link:", shareUrl);
    }
  };

  const shareNative = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: "Thiệp cưới", url: shareUrl });
        return;
      } catch {
        /* cancelled */
      }
    }
    setShareOpen((o) => !o);
  };

  return (
    <>
      {shareOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/25 wc-overlay-in"
          onClick={() => setShareOpen(false)}
          aria-hidden
        />
      )}
      {shareOpen && (
        <div className="fixed bottom-[5.5rem] left-1/2 -translate-x-1/2 z-50 flex gap-2 bg-white rounded-2xl shadow-xl border p-2 max-w-[calc(100vw-2rem)] wc-success-pop">
          <a
            href={`https://zalo.me/share?url=${encodeURIComponent(shareUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="wc-touch-btn flex-1 flex items-center justify-center px-4 rounded-xl bg-[#0068ff] text-white text-sm font-semibold"
          >
            Zalo
          </a>
          <a
            href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="wc-touch-btn flex-1 flex items-center justify-center px-4 rounded-xl bg-[#1877f2] text-white text-sm font-semibold"
          >
            Facebook
          </a>
        </div>
      )}
      <div
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-3 items-end pb-[env(safe-area-inset-bottom)]"
        role="toolbar"
        aria-label="Thao tác thiệp"
      >
        <Link
          href="/thiep-cuoi-online"
          className="wc-touch-btn flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-lg border border-neutral-200/90 text-neutral-700 active:scale-95 transition-transform"
          title="Trang chủ thiệp"
          aria-label="Trang chủ"
        >
          <Home className="h-5 w-5" />
        </Link>
        <button
          type="button"
          onClick={shareNative}
          className="wc-touch-btn flex h-12 w-12 items-center justify-center rounded-full bg-neutral-900 text-white shadow-lg active:scale-95 transition-transform"
          title="Chia sẻ"
          aria-label="Chia sẻ"
        >
          <Share2 className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={copyLink}
          className="wc-touch-btn flex h-12 min-w-[8.5rem] items-center justify-center gap-2 rounded-full bg-rose-600 text-white shadow-lg px-4 text-sm font-semibold active:scale-95 transition-transform"
        >
          <Copy className="h-4 w-4 shrink-0" />
          {copied ? "Đã copy" : "Copy link"}
        </button>
      </div>
    </>
  );
}
