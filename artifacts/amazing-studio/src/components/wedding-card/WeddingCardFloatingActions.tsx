import { useEffect, useState } from "react";
import { Copy, Gift, Heart, Images, MapPin, Share2 } from "lucide-react";

const NAV = [
  { id: "wc-section-wishes", label: "Gửi lời chúc", icon: Heart },
  { id: "wc-section-album", label: "Album", icon: Images },
  { id: "wc-section-gift", label: "Quà tặng", icon: Gift },
  { id: "wc-section-map", label: "Bản đồ", icon: MapPin },
] as const;

function scrollTo(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function WeddingCardFloatingActions({ shareUrl }: { shareUrl: string }) {
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [visible, setVisible] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const check = () => {
      const next: Record<string, boolean> = {};
      for (const { id } of NAV) next[id] = !!document.getElementById(id);
      setVisible(next);
    };
    check();
    const t = setTimeout(check, 400);
    return () => clearTimeout(t);
  }, []);

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
        <div className="fixed inset-0 z-40 bg-black/25" onClick={() => setShareOpen(false)} aria-hidden />
      )}
      {shareOpen && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 flex gap-2 bg-white rounded-2xl shadow-xl border p-2 max-w-[calc(100vw-2rem)] wc-success-pop">
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

      <nav className="wc-bt-float-nav" aria-label="Điều hướng thiệp">
        {NAV.map(({ id, label, icon: Icon }) => {
          if (!visible[id]) return null;
          return (
            <button
              key={id}
              type="button"
              onClick={() => scrollTo(id)}
              className="wc-bt-float-nav-btn"
              title={label}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{label}</span>
            </button>
          );
        })}
        <button type="button" onClick={shareNative} className="wc-bt-float-nav-btn" title="Chia sẻ">
          <Share2 className="h-4 w-4 shrink-0" />
          <span>Chia sẻ</span>
        </button>
        <button type="button" onClick={copyLink} className="wc-bt-float-nav-btn wc-bt-float-nav-btn--accent" title="Copy link">
          <Copy className="h-4 w-4 shrink-0" />
          <span>{copied ? "Đã copy" : "Copy link"}</span>
        </button>
      </nav>
    </>
  );
}
