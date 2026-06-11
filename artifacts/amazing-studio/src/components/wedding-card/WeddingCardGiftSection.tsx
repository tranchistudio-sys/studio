import { useState } from "react";
import { Gift, Heart } from "lucide-react";
import { WeddingCardReveal } from "./WeddingCardReveal";

export function WeddingCardGiftSection({
  groomName,
  brideName,
  contactPhone,
}: {
  groomName: string;
  brideName: string;
  contactPhone: string | null;
}) {
  const [showInfo, setShowInfo] = useState(false);

  return (
    <WeddingCardReveal className="wc-bt-view-section wc-bt-gift" id="wc-section-gift">
      <p className="wc-bt-section-eyebrow">Wedding Gift</p>
      <h2 className="wc-bt-section-title">Quà Mừng Cưới</h2>
      <p className="wc-bt-section-desc italic">
        Sự hiện diện của quý khách đã là món quà ý nghĩa nhất
      </p>
      <div className="wc-bt-section-heart">
        <Heart className="w-3 h-3 fill-current" />
      </div>
      <button
        type="button"
        className="wc-bt-gift-icon-btn"
        onClick={() => setShowInfo((v) => !v)}
        aria-expanded={showInfo}
      >
        <Gift className="w-6 h-6" />
      </button>
      <button
        type="button"
        className="wc-bt-btn wc-bt-btn-outline-pink mt-4"
        onClick={() => setShowInfo((v) => !v)}
      >
        {showInfo ? "Ẩn thông tin" : "Xem thông tin tặng quà"}
      </button>
      {showInfo && (
        <div className="wc-bt-gift-info wc-fade-in">
          <p>
            Xin gửi lời chúc mừng đến {groomName} & {brideName}.
            {contactPhone ? (
              <>
                {" "}
                Liên hệ:{" "}
                <a href={`tel:${contactPhone.replace(/\s/g, "")}`} className="font-semibold text-[#c2185b]">
                  {contactPhone}
                </a>
              </>
            ) : (
              " Vui lòng liên hệ trực tiếp cô dâu chú rể."
            )}
          </p>
        </div>
      )}
    </WeddingCardReveal>
  );
}
