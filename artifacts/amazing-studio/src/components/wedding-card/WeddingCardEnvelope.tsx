import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Heart } from "lucide-react";
import type { WeddingCardData } from "./wedding-card-types";

type Phase = "closed" | "opening" | "opened";

function formatShortDate(d: string | null) {
  if (!d) return null;
  try {
    const dt = new Date(d + "T12:00:00");
    const wd = dt.toLocaleDateString("vi-VN", { weekday: "long" });
    const day = dt.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
    return `${wd}, ${day}`;
  } catch {
    return d;
  }
}

export function WeddingCardEnvelope({
  card,
  children,
  storageKey,
  autoOpen = false,
  onOpened,
}: {
  card: WeddingCardData;
  children: ReactNode;
  /** sessionStorage key — bỏ qua phong bì nếu đã mở trong phiên */
  storageKey?: string;
  autoOpen?: boolean;
  onOpened?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("closed");
  const dateLabel = formatShortDate(card.weddingDate);

  useEffect(() => {
    if (autoOpen) {
      const t = setTimeout(() => openEnvelope(), 400);
      return () => clearTimeout(t);
    }
    if (storageKey) {
      try {
        if (sessionStorage.getItem(storageKey) === "1") {
          setPhase("opened");
          onOpened?.();
        }
      } catch {
        /* ignore */
      }
    }
  }, [autoOpen, storageKey]);

  const openEnvelope = useCallback(() => {
    if (phase !== "closed") return;
    setPhase("opening");
    if (storageKey) {
      try {
        sessionStorage.setItem(storageKey, "1");
      } catch {
        /* ignore */
      }
    }
    window.setTimeout(() => {
      setPhase("opened");
      onOpened?.();
    }, 1100);
  }, [phase, storageKey, onOpened]);

  if (phase === "opened") {
    return <div className="wc-bt-envelope-opened wc-fade-in">{children}</div>;
  }

  return (
    <div className={`wc-bt-envelope-gate ${phase === "opening" ? "is-opening" : ""}`}>
      <div className="wc-bt-envelope-scene" aria-hidden={phase === "opening"}>
        <div className="wc-bt-envelope">
          <div className="wc-bt-envelope-flap">
            <span className="wc-bt-envelope-flap-heart">
              <Heart className="w-3 h-3 fill-current" />
            </span>
          </div>
          <div className="wc-bt-envelope-pocket" />
          <div className="wc-bt-envelope-body">
            <p className="wc-bt-envelope-kicker">Wedding Invitation</p>
            <p className="wc-bt-envelope-name">{card.groomName}</p>
            <div className="wc-bt-envelope-divider">
              <span />
              <Heart className="w-2.5 h-2.5 fill-current" />
              <span />
            </div>
            <p className="wc-bt-envelope-name">{card.brideName}</p>
            {dateLabel && <p className="wc-bt-envelope-date">{dateLabel}</p>}
          </div>
          <div className="wc-bt-envelope-base" />
        </div>

        <button
          type="button"
          className="wc-bt-envelope-btn"
          onClick={openEnvelope}
          disabled={phase === "opening"}
        >
          <Heart className="w-4 h-4 fill-current" />
          Mở thiệp cưới
        </button>
        <p className="wc-bt-envelope-hint">Nhấn để mở phong bì ✉️</p>
      </div>

      <div className="wc-bt-envelope-reveal" aria-hidden={phase === "closed"}>
        {children}
      </div>
    </div>
  );
}
