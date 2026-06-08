import { Gift, Phone } from "lucide-react";

export function WeddingCardGiftSection({
  groomName,
  brideName,
  contactPhone,
}: {
  groomName: string;
  brideName: string;
  contactPhone: string | null;
}) {
  return (
    <section className="wc-bt-view-section" id="wc-section-gift">
      <p className="wc-bt-section-eyebrow">Mừng cưới</p>
      <h2 className="wc-bt-section-title">Gửi quà từ xa</h2>
      <p className="wc-bt-section-desc">
        Sự hiện diện của bạn là món quà ý nghĩa nhất. Nếu muốn gửi lời chúc mừng đến {groomName} & {brideName},
        vui lòng liên hệ trực tiếp.
      </p>
      {contactPhone ? (
        <a href={`tel:${contactPhone.replace(/\s/g, "")}`} className="wc-bt-btn wc-bt-btn-primary mt-4">
          <Phone className="h-4 w-4" />
          {contactPhone}
        </a>
      ) : (
        <p className="text-sm text-[var(--wc-bt-muted)] mt-3 flex items-center justify-center gap-2">
          <Gift className="h-4 w-4" />
          Liên hệ cô dâu chú rể qua số trên thiệp
        </p>
      )}
    </section>
  );
}
