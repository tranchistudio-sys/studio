import { useState } from "react";
import { Link } from "wouter";
import { Check, Copy, ExternalLink, Share2 } from "lucide-react";
import { buildShareUrl } from "./wedding-card-config";

export function WeddingCardSuccessScreen({
  slug,
  groomName,
  brideName,
}: {
  slug: string;
  groomName: string;
  brideName: string;
}) {
  const shareUrl = buildShareUrl(slug);
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt("Sao chép link thiệp:", shareUrl);
    }
  };

  const shareFb = () => {
    window.open(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const shareZalo = () => {
    window.open(
      `https://zalo.me/share?url=${encodeURIComponent(shareUrl)}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mb-6">
        <Check className="w-8 h-8 text-emerald-700" />
      </div>
      <h1 className="font-serif text-2xl sm:text-3xl text-neutral-900">Thiệp đã sẵn sàng!</h1>
      <p className="mt-2 text-sm text-neutral-600 max-w-md">
        Thiệp cưới của <strong>{groomName}</strong> & <strong>{brideName}</strong> đã được tạo.
        Gửi link cho khách mời.
      </p>
      <div className="mt-8 w-full max-w-md rounded-xl border border-neutral-200 bg-white p-4 text-left">
        <p className="text-[10px] uppercase tracking-wider text-neutral-400 mb-2">Link thiệp</p>
        <p className="text-sm text-neutral-800 break-all font-mono leading-relaxed">{shareUrl}</p>
      </div>
      <div className="mt-6 flex flex-col sm:flex-row gap-3 w-full max-w-md">
        <button
          type="button"
          onClick={copyLink}
          className="flex-1 inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-neutral-900 text-white text-sm font-semibold"
        >
          <Copy className="w-4 h-4" />
          {copied ? "Đã copy!" : "Copy link"}
        </button>
        <Link
          href={`/thiep-cuoi/${slug}`}
          className="flex-1 inline-flex items-center justify-center gap-2 py-3 rounded-xl border border-neutral-300 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
        >
          <ExternalLink className="w-4 h-4" />
          Xem thiệp
        </Link>
      </div>
      <div className="mt-4 flex gap-3 w-full max-w-md">
        <button
          type="button"
          onClick={shareZalo}
          className="flex-1 py-2.5 rounded-xl bg-[#0068ff] text-white text-xs font-semibold"
        >
          Chia sẻ Zalo
        </button>
        <button
          type="button"
          onClick={shareFb}
          className="flex-1 py-2.5 rounded-xl bg-[#1877f2] text-white text-xs font-semibold inline-flex items-center justify-center gap-1"
        >
          <Share2 className="w-3.5 h-3.5" />
          Facebook
        </button>
      </div>
      <Link href="/thiep-cuoi-online" className="mt-10 text-xs text-neutral-500 hover:text-neutral-800 underline">
        Tạo thiệp khác
      </Link>
    </div>
  );
}
