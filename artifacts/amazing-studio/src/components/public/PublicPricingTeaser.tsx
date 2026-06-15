import { Link } from "wouter";
import { formatVND } from "@/lib/utils";
import type { PublicPackage } from "@/hooks/use-public-cms";
import { PublicReveal, PublicRevealItem } from "./PublicReveal";
import { PublicSectionHeader } from "./PublicSectionHeader";

type Props = {
  packages: PublicPackage[];
  limit?: number;
};

export function PublicPricingTeaser({ packages, limit = 6 }: Props) {
  const items = packages.slice(0, limit);
  if (items.length === 0) return null;

  return (
    <PublicReveal stagger className="py-20 sm:py-28 lg:py-32 bg-stone-50">
      <div className="max-w-7xl mx-auto px-5 sm:px-8">
        <PublicSectionHeader
          eyebrow="Bảng giá"
          title="Bảng giá dịch vụ"
          description="Gói chụp ảnh minh bạch — tư vấn miễn phí trước khi đặt lịch."
        />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8 max-w-5xl mx-auto">
          {items.map((pkg) => (
            <PublicRevealItem key={pkg.id}>
              <article className="border-t border-neutral-300 pt-6">
                {pkg.groupName && (
                  <p className="text-[10px] tracking-[0.3em] uppercase text-neutral-500 mb-2">
                    {pkg.groupName}
                  </p>
                )}
                <h3 className="font-serif text-2xl text-neutral-900 mb-2">{pkg.name}</h3>
                {pkg.shortDescription && (
                  <p className="text-sm text-neutral-600 leading-relaxed mb-4 line-clamp-3">
                    {pkg.shortDescription}
                  </p>
                )}
                <p className="font-serif text-2xl text-[var(--public-accent-dark)]">
                  {formatVND(pkg.price)}
                </p>
              </article>
            </PublicRevealItem>
          ))}
        </div>
        <div className="text-center mt-12">
          <Link
            href="/bang-gia"
            className="text-xs tracking-[0.25em] uppercase text-neutral-900 border-b border-neutral-900 pb-1 hover:opacity-60 transition-opacity"
          >
            Xem bảng giá đầy đủ
          </Link>
        </div>
      </div>
    </PublicReveal>
  );
}
