import { Phone, MapPin, Clock, Mail, User, MessageCircle } from "lucide-react";
import { playPublicSound } from "@/lib/feedback";

const CONSULTANTS: { name: string; phone: string }[] = [
  { name: "Nhân viên tư vấn 1", phone: "0364902228" },
  { name: "Nhân viên tư vấn 2", phone: "0392817079" },
];

function isMobileDevice(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  } catch { return false; }
}

/** Chuyển số VN (0xxxx) sang định dạng quốc tế (+84) cho Zalo */
function toZaloNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, "");
  return cleaned.startsWith("0") ? "84" + cleaned.slice(1) : cleaned;
}

function openZalo(phone: string) {
  playPublicSound("public_contact_clicked");
  const zaloNum = toZaloNumber(phone);
  const webUrl = `https://zalo.me/${zaloNum}`;
  try {
    if (!isMobileDevice()) {
      window.open(webUrl, "_blank", "noopener,noreferrer");
      return;
    }
    let opened = false;
    const onHide = () => { opened = true; document.removeEventListener("visibilitychange", onHide); };
    document.addEventListener("visibilitychange", onHide);
    const fallback = () => {
      document.removeEventListener("visibilitychange", onHide);
      if (opened) return;
      try { window.location.href = webUrl; } catch {}
    };
    setTimeout(fallback, 1200);
    try {
      window.location.href = `zalo://chat?phone=${zaloNum}`;
    } catch {
      try { window.location.href = webUrl; } catch {}
    }
  } catch {
    try { window.open(webUrl, "_blank", "noopener,noreferrer"); } catch {}
  }
}

function ZaloButton({ phone, className = "" }: { phone: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openZalo(phone)}
      className={`flex-shrink-0 inline-flex items-center gap-1 sm:gap-1.5 px-3 sm:px-4 h-9 sm:h-10 justify-center bg-[#0068ff] text-white rounded-xl text-xs sm:text-sm font-semibold hover:opacity-90 transition-opacity ${className}`}
    >
      <MessageCircle className="w-4 h-4" />
      <span className="hidden sm:inline">Chat </span>Zalo
    </button>
  );
}

export default function PublicContactPage() {
  return (
    <div className="max-w-7xl mx-auto px-5 sm:px-8 py-16 sm:py-24">
      <header className="text-center mb-12 sm:mb-20">
        <p className="text-[11px] tracking-[0.35em] text-neutral-500 uppercase mb-4">
          Đặt lịch & Tư vấn
        </p>
        <h1 className="font-serif text-4xl sm:text-5xl lg:text-6xl font-light text-neutral-900 mb-4">
          Liên hệ
        </h1>
        <p className="text-neutral-600 max-w-xl mx-auto leading-relaxed">
          Chúng tôi sẵn sàng tư vấn miễn phí và hỗ trợ bạn 7 ngày trong tuần.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16">
        {/* Contact info */}
        <div className="space-y-8">
          <div className="flex gap-4">
            <Phone className="w-5 h-5 text-neutral-400 flex-shrink-0 mt-1" />
            <div>
              <h3 className="text-xs tracking-widest uppercase text-neutral-500 mb-1">
                Điện thoại
              </h3>
              <a
                href="tel:0392817079"
                onClick={() => playPublicSound("public_contact_clicked")}
                className="text-lg text-neutral-900 hover:text-neutral-600 transition-colors"
              >
                0392 817 079
              </a>
            </div>
          </div>

          <div className="flex gap-4">
            <MapPin className="w-5 h-5 text-neutral-400 flex-shrink-0 mt-1" />
            <div>
              <h3 className="text-xs tracking-widest uppercase text-neutral-500 mb-1">
                Địa chỉ
              </h3>
              <p className="text-neutral-900">Số 80, Hẻm 71, CMT8, KP Hiệp Bình, P. Hiệp Ninh, TP Tây Ninh</p>
            </div>
          </div>

          <div className="flex gap-4">
            <Clock className="w-5 h-5 text-neutral-400 flex-shrink-0 mt-1" />
            <div>
              <h3 className="text-xs tracking-widest uppercase text-neutral-500 mb-1">
                Giờ làm việc
              </h3>
              <p className="text-neutral-900">
                Thứ 2 — Chủ nhật<br />
                8:00 — 18:00
              </p>
            </div>
          </div>

          <div className="flex gap-4">
            <Mail className="w-5 h-5 text-neutral-400 flex-shrink-0 mt-1" />
            <div>
              <h3 className="text-xs tracking-widest uppercase text-neutral-500 mb-1">
                Email
              </h3>
              <a href="mailto:tranchistudio@gmail.com" className="text-neutral-900 hover:text-neutral-600 transition-colors">
                tranchistudio@gmail.com
              </a>
            </div>
          </div>

          {/* Nhân viên tư vấn — giống rental-detail */}
          <div className="space-y-3 pt-2">
            <h2 className="text-base font-semibold text-neutral-900">Nhân viên tư vấn</h2>
            <div className="space-y-3">
              {CONSULTANTS.map(c => (
                <div
                  key={c.phone}
                  className="w-full bg-white border border-neutral-200 rounded-2xl p-2.5 sm:p-3 flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-3 shadow-sm"
                >
                  <div className="flex items-center gap-2.5 w-full">
                    <div className="flex-shrink-0 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-gradient-to-br from-pink-400 to-purple-500 flex items-center justify-center text-white">
                      <User className="w-5 h-5 sm:w-6 sm:h-6" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{c.name}</p>
                      <a href={`tel:${c.phone}`} onClick={() => playPublicSound("public_contact_clicked")} className="text-xs text-neutral-500 tabular-nums hover:text-neutral-900">
                        {c.phone}
                      </a>
                    </div>
                    <ZaloButton phone={c.phone} className="sm:hidden" />
                  </div>
                  <ZaloButton phone={c.phone} className="hidden sm:flex" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Placeholder contact form */}
        <div className="bg-neutral-50 p-8">
          <h2 className="font-serif text-2xl mb-6">Gửi tin nhắn</h2>
          <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
            <div>
              <label htmlFor="contact-name" className="block text-xs tracking-widest uppercase text-neutral-500 mb-2">
                Họ và tên
              </label>
              <input
                id="contact-name"
                type="text"
                autoComplete="name"
                className="w-full border border-neutral-300 px-4 py-3 text-sm focus:outline-none focus:border-neutral-900 transition-colors bg-white"
                placeholder="Nguyễn Văn A"
              />
            </div>
            <div>
              <label htmlFor="contact-phone" className="block text-xs tracking-widest uppercase text-neutral-500 mb-2">
                Số điện thoại
              </label>
              <input
                id="contact-phone"
                type="tel"
                autoComplete="tel"
                className="w-full border border-neutral-300 px-4 py-3 text-sm focus:outline-none focus:border-neutral-900 transition-colors bg-white"
                placeholder="0xxx xxx xxx"
              />
            </div>
            <div>
              <label htmlFor="contact-message" className="block text-xs tracking-widest uppercase text-neutral-500 mb-2">
                Nội dung
              </label>
              <textarea
                id="contact-message"
                rows={4}
                className="w-full border border-neutral-300 px-4 py-3 text-sm focus:outline-none focus:border-neutral-900 transition-colors bg-white"
                placeholder="Tôi muốn tư vấn về..."
              />
            </div>
            <button
              type="submit"
              disabled
              className="w-full bg-neutral-900 text-white text-xs tracking-widest uppercase py-3 hover:bg-neutral-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Gửi tin nhắn
            </button>
            <p className="text-xs text-neutral-500 text-center italic">
              Form sẽ hoạt động sau khi hoàn tất giai đoạn 3.
            </p>
          </form>
        </div>
      </div>

    </div>
  );
}
