import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Phone, MessageCircle, Loader2 } from "lucide-react";
import { CMS_BASE } from "@/components/cms-shared";
import { formatVND } from "@/lib/utils";

interface PublicPackage {
  id: number;
  code: string | null;
  name: string;
  price: number;
  shortDescription: string | null;
  description: string | null;
  products: string[];
  groupName: string | null;
}

const STUDIO_PHONE = "0392817079";

function toZaloNumber(phone: string): string {
  const cleaned = phone.replace(/\D/g, "");
  return cleaned.startsWith("0") ? "84" + cleaned.slice(1) : cleaned;
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

export default function PublicPricingPage() {
  const { data: packages = [], isLoading, error } = usePublicPackages();

  const grouped = useMemo(() => {
    const m = new Map<string, PublicPackage[]>();
    packages.forEach(p => {
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
        <div className="text-center py-16 text-neutral-500">
          Không thể tải bảng giá. Vui lòng thử lại sau.
        </div>
      )}

      {!isLoading && !error && packages.length === 0 && (
        <div className="text-center py-16 text-neutral-500">
          Bảng giá đang được cập nhật. Vui lòng liên hệ trực tiếp để được tư vấn.
        </div>
      )}

      <div className="space-y-10">
        {grouped.map(([groupName, pkgs]) => (
          <section key={groupName}>
            <h2 className="text-sm font-semibold tracking-widest uppercase text-neutral-500 mb-4 px-1">
              {groupName}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {pkgs.map(p => (
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
                    </div>
                    <span className="text-lg sm:text-xl font-bold text-rose-600 whitespace-nowrap">
                      {formatVND(p.price)}
                    </span>
                  </div>

                  {p.shortDescription && (
                    <p className="text-sm text-neutral-600 mb-3 leading-relaxed">
                      {p.shortDescription}
                    </p>
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
                    <a
                      href={`https://zalo.me/${toZaloNumber(STUDIO_PHONE)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-[#0068ff] text-white rounded-xl text-xs sm:text-sm font-medium hover:opacity-90 transition-opacity"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      Zalo
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {!isLoading && !error && packages.length > 0 && (
        <div className="text-center mt-12">
          <Link
            href="/lien-he"
            className="inline-block text-xs tracking-widest uppercase border border-neutral-900 px-8 py-3 hover:bg-neutral-900 hover:text-white transition-colors"
          >
            Liên hệ tư vấn chi tiết
          </Link>
        </div>
      )}
    </div>
  );
}
