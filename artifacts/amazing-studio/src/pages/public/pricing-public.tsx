import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, MessageCircle, Loader2 } from "lucide-react";
import { CMS_BASE } from "@/components/cms-shared";
import { formatVND } from "@/lib/utils";
import { discountBadgeText, type DiscountResult } from "@/lib/discount";
import { CONSULTANTS, STUDIO_PHONE, STUDIO_PHONE_DISPLAY } from "@/lib/public-site-config";
import { openZalo } from "@/lib/public-zalo";

interface PublicPackage {
  id: number;
  code: string | null;
  name: string;
  price: number;
  shortDescription: string | null;
  description: string | null;
  products: string[];
  groupName: string | null;
  discount?: DiscountResult; // backend tính sẵn (chỉ ưu đãi đang hiệu lực)
}

function usePublicPackages() {
  return useQuery<PublicPackage[]>({
    queryKey: ["public-packages"],
    queryFn: async () => {
      const r = await fetch(`${CMS_BASE}/api/cms/public/packages`);
      if (!r.ok) throw new Error("Lỗi tải bảng giá");
      return r.json();
    },
  });
}

function ZaloConsultButton({
  phone = STUDIO_PHONE,
  label = "Tư vấn miễn phí",
  className = "",
}: {
  phone?: string;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => openZalo(phone)}
      className={`inline-flex items-center justify-center gap-2 px-8 py-3.5 bg-[#0068ff] text-white rounded-xl text-sm font-semibold hover:opacity-90 transition-opacity ${className}`}
    >
      <MessageCircle className="w-4 h-4" />
      {label}
    </button>
  );
}

function PricingZaloFallback({ message }: { message: string }) {
  return (
    <div className="max-w-md mx-auto text-center py-12 px-4">
      <p className="text-neutral-600 leading-relaxed mb-8">{message}</p>
      <ZaloConsultButton className="w-full sm:w-auto" />
      <p className="mt-4 text-sm text-neutral-500">
        Hoặc gọi{" "}
        <a href={`tel:${STUDIO_PHONE}`} className="text-neutral-900 font-medium hover:underline">
          {STUDIO_PHONE_DISPLAY}
        </a>
      </p>
      <div className="mt-10 space-y-3 text-left border-t border-neutral-200 pt-8">
        <p className="text-[10px] tracking-[0.3em] uppercase text-neutral-500 text-center">Nhân viên tư vấn</p>
        {CONSULTANTS.map((c) => (
          <div
            key={c.phone}
            className="flex flex-wrap items-center justify-between gap-3 py-3 border-b border-neutral-100"
          >
            <div>
              <p className="text-sm font-medium text-neutral-900">{c.name}</p>
              <a href={`tel:${c.phone}`} className="text-sm text-neutral-500 hover:text-neutral-900">
                {c.phone}
              </a>
            </div>
            <button
              type="button"
              onClick={() => openZalo(c.phone)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#0068ff] text-white rounded-xl text-xs font-semibold hover:opacity-90"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              Zalo
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PublicPricingPage() {
  const { data: packages = [], isLoading, error } = usePublicPackages();

  const grouped = useMemo(() => {
    const m = new Map<string, PublicPackage[]>();
    packages.forEach((p) => {
      const k = p.groupName ?? "Khác";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    });
    return Array.from(m.entries());
  }, [packages]);

  return (
    <div className="max-w-7xl mx-auto px-5 sm:px-8 py-16 sm:py-24">
      <header className="text-center mb-12 sm:mb-20">
        <p className="text-[11px] tracking-[0.35em] text-neutral-500 uppercase mb-4">
          Dịch vụ & Báo giá
        </p>
        <h1 className="font-serif text-4xl sm:text-5xl lg:text-6xl font-light text-neutral-900 mb-4">
          Bảng giá
        </h1>
        <p className="text-neutral-600 max-w-xl mx-auto leading-relaxed">
          Các gói dịch vụ chụp ảnh và cho thuê trang phục được cập nhật liên tục.
        </p>
      </header>

      {isLoading && (
        <div className="text-center py-16 text-neutral-500">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3" />
          Đang tải bảng giá...
        </div>
      )}

      {error && (
        <PricingZaloFallback message="Không thể tải bảng giá lúc này. Nhắn Zalo để xem báo giá và được tư vấn miễn phí." />
      )}

      {!isLoading && !error && packages.length === 0 && (
        <PricingZaloFallback message="Bảng giá đang được cập nhật. Nhắn Zalo để xem báo giá chi tiết và được tư vấn miễn phí." />
      )}

      <div className="space-y-10">
        {grouped.map(([groupName, pkgs]) => (
          <section key={groupName}>
            <h2 className="text-sm font-semibold tracking-widest uppercase text-neutral-500 mb-4 px-1">
              {groupName}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {pkgs.map((p) => (
                <div
                  key={p.id}
                  className="border border-neutral-200 rounded-2xl p-5 sm:p-6 hover:border-neutral-400 transition-colors bg-white"
                >
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      {p.code && (
                        <span className="text-[10px] tracking-wider uppercase text-neutral-400 font-medium">
                          {p.code}
                        </span>
                      )}
                      <h3 className="font-serif text-lg sm:text-xl leading-tight">{p.name}</h3>
                      {p.discount?.discountApplied && (
                        <span className="inline-block mt-1.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200">
                          🏷️ {discountBadgeText(p.discount)}{p.discount.discountName ? ` · ${p.discount.discountName}` : ""}
                        </span>
                      )}
                    </div>
                    {p.discount?.discountApplied ? (
                      <div className="text-right whitespace-nowrap">
                        <span className="block text-lg sm:text-xl font-bold text-rose-600">{formatVND(p.discount.finalPrice)}</span>
                        <span className="text-xs line-through text-neutral-400">{formatVND(p.price)}</span>
                      </div>
                    ) : (
                      <span className="text-lg sm:text-xl font-bold text-rose-600 whitespace-nowrap">
                        {formatVND(p.price)}
                      </span>
                    )}
                  </div>

                  {p.shortDescription && (
                    <p className="text-sm text-neutral-600 mb-3 leading-relaxed">{p.shortDescription}</p>
                  )}

                  {p.products && p.products.length > 0 && (
                    <ul className="text-sm text-neutral-600 space-y-1.5 mb-5">
                      {p.products.slice(0, 6).map((item, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="w-1 h-1 rounded-full bg-neutral-400 mt-2 flex-shrink-0" />
                          {item}
                        </li>
                      ))}
                      {p.products.length > 6 && (
                        <li className="text-xs text-neutral-400 italic">
                          + {p.products.length - 6} sản phẩm khác
                        </li>
                      )}
                    </ul>
                  )}

                  <div className="flex gap-2 mt-auto">
                    <a
                      href={`tel:${STUDIO_PHONE}`}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-neutral-100 rounded-xl text-xs sm:text-sm font-medium hover:bg-neutral-200 transition-colors"
                    >
                      <Phone className="w-3.5 h-3.5" />
                      Gọi
                    </a>
                    <button
                      type="button"
                      onClick={() => openZalo(STUDIO_PHONE)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-[#0068ff] text-white rounded-xl text-xs sm:text-sm font-medium hover:opacity-90 transition-opacity"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      Tư vấn miễn phí
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {!isLoading && !error && packages.length > 0 && (
        <div className="text-center mt-12 flex flex-col items-center gap-4">
          <ZaloConsultButton />
          <p className="text-sm text-neutral-500">
            Xem báo giá chi tiết và đặt lịch qua Zalo — miễn phí tư vấn
          </p>
        </div>
      )}
    </div>
  );
}
