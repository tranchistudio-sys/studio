import { Link } from "wouter";
import { MessageCircle, Phone, MapPin, Clock } from "lucide-react";
import { STUDIO_HOURS, CONSULTANTS } from "@/lib/public-site-config";
import { usePublicBranding } from "@/hooks/use-public-branding";
import { openZalo } from "@/lib/public-zalo";
import { PublicReveal } from "./PublicReveal";
import { PublicSectionHeader } from "./PublicSectionHeader";
import { PublicCta } from "./PublicCta";

function ZaloBtn({ phone, className = "" }: { phone: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openZalo(phone)}
      className={`inline-flex items-center gap-2 px-5 py-3 bg-[#0068ff] text-white text-xs tracking-widest uppercase hover:opacity-90 transition-opacity ${className}`}
    >
      <MessageCircle className="w-4 h-4" />
      Chat Zalo
    </button>
  );
}

export function PublicContactStrip() {
  const { view: branding } = usePublicBranding();
  const consultants = branding.isAmazingLegacy ? CONSULTANTS : [];
  return (
    <PublicReveal className="py-20 sm:py-28 lg:py-32 bg-stone-50">
      <div className="max-w-7xl mx-auto px-5 sm:px-8">
        <PublicSectionHeader
          eyebrow="Liên hệ"
          title="Đặt lịch & tư vấn"
          description="Chúng tôi sẵn sàng hỗ trợ bạn 7 ngày trong tuần."
        />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20">
          <div className="space-y-8 font-sans">
            <div className="flex gap-4">
              <Phone className="w-5 h-5 text-neutral-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-[10px] tracking-[0.3em] uppercase text-neutral-500 mb-1">Điện thoại</p>
                {branding.phone ? <a href={`tel:${branding.phone}`} className="text-xl text-neutral-900 hover:opacity-70 transition-opacity">
                  {branding.phoneDisplay}
                </a> : <p className="text-neutral-500">Đang cập nhật</p>}
              </div>
            </div>
            <div className="flex gap-4">
              <MapPin className="w-5 h-5 text-neutral-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-[10px] tracking-[0.3em] uppercase text-neutral-500 mb-1">Địa chỉ</p>
                <p className="text-neutral-800 leading-relaxed">{branding.address || "Đang cập nhật"}</p>
              </div>
            </div>
            <div className="flex gap-4">
              <Clock className="w-5 h-5 text-neutral-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-[10px] tracking-[0.3em] uppercase text-neutral-500 mb-1">Giờ làm việc</p>
                <p className="text-neutral-800">{STUDIO_HOURS}</p>
              </div>
            </div>
            {branding.email && <p className="text-sm text-neutral-600">
              Email:{" "}
              <a href={`mailto:${branding.email}`} className="text-neutral-900 underline hover:opacity-70">
                {branding.email}
              </a>
            </p>}
          </div>

          <div className="flex flex-col justify-center gap-6">
            <div className="flex flex-col sm:flex-row gap-3">
              <PublicCta href="/lien-he" className="flex-1 text-center">
                Đặt lịch tư vấn
              </PublicCta>
              {branding.phone && <a
                href={`tel:${branding.phone}`}
                className="btn-public-ghost flex-1 inline-flex items-center justify-center border border-neutral-900 text-neutral-900 text-xs tracking-[0.2em] uppercase px-8 py-3.5 hover:bg-neutral-900 hover:text-white transition-colors text-center"
              >
                Gọi ngay
              </a>}
            </div>
            {consultants.length > 0 && <div className="space-y-3 pt-2">
              <p className="text-[10px] tracking-[0.3em] uppercase text-neutral-500">Nhân viên tư vấn</p>
              {consultants.map((c) => (
                <div
                  key={c.phone}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 border-b border-neutral-200"
                >
                  <div>
                    <p className="text-sm font-medium text-neutral-900">{c.name}</p>
                    <a href={`tel:${c.phone}`} className="text-sm text-neutral-500 hover:text-neutral-900">
                      {c.phone}
                    </a>
                  </div>
                  <ZaloBtn phone={c.phone} />
                </div>
              ))}
            </div>}
            <Link
              href="/lien-he"
              className="text-xs tracking-[0.25em] uppercase text-neutral-500 hover:text-neutral-900 transition-colors"
            >
              Trang liên hệ đầy đủ →
            </Link>
          </div>
        </div>
      </div>
    </PublicReveal>
  );
}
