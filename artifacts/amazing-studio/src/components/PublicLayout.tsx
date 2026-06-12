import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { PublicAiAdvisor } from "@/components/public-ai-advisor";
import {
  STUDIO_ADDRESS,
  STUDIO_EMAIL,
  STUDIO_PHONE_DISPLAY,
} from "@/lib/public-site-config";

const PUBLIC_NAV = [
  { href: "/", label: "Trang chủ" },
  { href: "/bo-anh", label: "Dịch vụ" },
  { href: "/bang-gia", label: "Bảng giá" },
  { href: "/cho-thue-do", label: "Cho thuê đồ" },
  { href: "/y-tuong-chup-anh", label: "Ý tưởng chụp ảnh" },
  { href: "/thiep-cuoi-online", label: "Thiệp cưới" },
  { href: "/lien-he", label: "Liên hệ" },
];

export function PublicLayout({ children }: { children: React.ReactNode }) {
  const { viewer, authChecked } = useStaffAuth();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const isHomePage = location === "/" || location === "/trang-chu";
  const isGallerySection =
    location === "/bo-anh" || location.startsWith("/bo-anh/");
  const isRentalSection =
    location === "/cho-thue-do" ||
    location.startsWith("/cho-thue-do") ||
    location.startsWith("/san-pham/");
  const isWeddingCardSection =
    location === "/thiep-cuoi-online" || location.startsWith("/thiep-cuoi-online/");
  const isCreamSection = isGallerySection || isRentalSection || isWeddingCardSection;
  const overlayHeader = isHomePage && !scrolled;

  useEffect(() => {
    if (!isHomePage) {
      setScrolled(true);
      return;
    }
    setScrolled(false);
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isHomePage, location]);

  const isActive = (href: string) => {
    if (href === "/") return location === "/" || location === "/trang-chu";
    return location === href || location.startsWith(href + "/");
  };

  const linkClass = (active: boolean, href: string) =>
    cn(
      "px-2.5 py-1.5 rounded text-sm tracking-wide whitespace-nowrap transition-colors",
      overlayHeader
        ? active
          ? "text-white font-semibold"
          : "text-white/80 hover:text-white"
        : active
          ? cn(
              "text-neutral-900 font-semibold",
              isCreamSection &&
                (href === "/bo-anh" || href === "/cho-thue-do") &&
                "gallery-nav-active",
            )
          : "text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50",
    );

  const logoClass = overlayHeader
    ? "text-white group-hover:text-white/80"
    : "text-neutral-900 group-hover:text-neutral-600";

  const subLogoClass = overlayHeader
    ? "text-white/70 border-white/40"
    : "text-neutral-500 border-neutral-300";

  return (
    <div
      className={cn(
        "public-site min-h-screen flex flex-col text-neutral-900",
        isCreamSection ? "bg-[var(--public-cream,#faf8f5)]" : "bg-white",
      )}
    >
      <header
        className={cn(
          "z-50 w-full transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          overlayHeader
            ? "absolute top-0 left-0 right-0 bg-transparent border-b border-transparent"
            : cn(
                "sticky top-0 backdrop-blur-sm border-b",
                isCreamSection
                  ? "public-header-gallery"
                  : "bg-white/95 border-neutral-200",
              ),
        )}
      >
        <div className="max-w-7xl mx-auto px-5 sm:px-8">
          <div className="min-[540px]:hidden flex flex-col items-center py-3">
            <Link href="/" className="flex items-center gap-2 group">
              <span className={cn("font-serif text-xl font-light tracking-wider transition-colors", logoClass)}>
                AMAZING
              </span>
              <span
                className={cn(
                  "text-[10px] tracking-[0.3em] font-medium uppercase border-l pl-2",
                  subLogoClass,
                )}
              >
                Studio
              </span>
            </Link>
            <nav className="flex flex-wrap justify-center gap-1 mt-2">
              {PUBLIC_NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "px-2 py-1 text-[12px] tracking-wide",
                    overlayHeader
                      ? isActive(item.href)
                        ? "text-white font-medium"
                        : "text-white/75"
                      : isActive(item.href)
                        ? "bg-neutral-100 text-neutral-900 font-medium"
                        : "text-neutral-600",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            {authChecked && viewer ? (
              <Link
                href="/calendar"
                className={cn(
                  "mt-2 text-[11px] tracking-widest uppercase px-3 py-1 border transition-colors",
                  overlayHeader
                    ? "text-white/80 border-white/40 hover:border-white"
                    : "text-neutral-500 border-neutral-200 hover:border-neutral-900",
                )}
              >
                Vào hệ thống
              </Link>
            ) : (
              <Link
                href="/login"
                className={cn(
                  "mt-2 text-[11px] tracking-widest uppercase px-3 py-1 border transition-colors",
                  overlayHeader
                    ? "text-white/80 border-white/40 hover:border-white"
                    : "text-neutral-500 border-neutral-200 hover:border-neutral-900",
                )}
              >
                Đăng nhập
              </Link>
            )}
          </div>

          <div className="hidden min-[540px]:flex items-center justify-between h-16 gap-4">
            <Link href="/" className="flex items-center gap-2 group flex-shrink-0">
              <span className={cn("font-serif text-xl font-light tracking-wider transition-colors", logoClass)}>
                AMAZING
              </span>
              <span
                className={cn(
                  "text-[10px] tracking-[0.3em] font-medium uppercase border-l pl-2",
                  subLogoClass,
                )}
              >
                Studio
              </span>
            </Link>

            <nav className="flex items-center gap-1 flex-1 justify-center">
              {PUBLIC_NAV.map((item) => (
                <Link key={item.href} href={item.href} className={linkClass(isActive(item.href), item.href)}>
                  {item.label}
                  {isActive(item.href) && !overlayHeader && (
                    <span className="sr-only"> (active)</span>
                  )}
                </Link>
              ))}
            </nav>

            {authChecked && viewer ? (
              <Link
                href="/calendar"
                className={cn(
                  "hidden md:inline-flex flex-shrink-0 text-xs tracking-widest uppercase px-4 py-2 border transition-colors",
                  overlayHeader
                    ? "text-white/90 border-white/50 hover:bg-white/10"
                    : "text-neutral-600 border-neutral-300 hover:border-neutral-900",
                )}
              >
                Vào hệ thống
              </Link>
            ) : (
              <Link
                href="/login"
                className={cn(
                  "hidden md:inline-flex flex-shrink-0 text-xs tracking-widest uppercase px-4 py-2 border transition-colors",
                  overlayHeader
                    ? "text-white/90 border-white/50 hover:bg-white/10"
                    : "text-neutral-600 border-neutral-300 hover:border-neutral-900",
                )}
            >
              Đăng nhập
            </Link>
            )}

            <button
              type="button"
              onClick={() => setMobileOpen((v) => !v)}
              className={cn("lg:hidden p-2 -mr-1 flex-shrink-0", overlayHeader ? "text-white" : "text-neutral-900")}
              aria-label="Mở menu"
            >
              {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>

          {mobileOpen && (
            <div
              className={cn(
                "lg:hidden border-t py-3 space-y-0.5",
                overlayHeader ? "border-white/20" : "border-neutral-200",
              )}
            >
              {PUBLIC_NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center px-3 py-2.5 text-sm tracking-wide",
                    overlayHeader
                      ? isActive(item.href)
                        ? "text-white font-semibold"
                        : "text-white/80"
                      : isActive(item.href)
                        ? "text-neutral-900 font-semibold bg-neutral-50"
                        : "text-neutral-600 hover:text-neutral-900",
                  )}
                >
                  {item.label}
                </Link>
              ))}
              <Link
                href="/login"
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center px-3 py-3 mt-1 text-xs tracking-widest uppercase border-t",
                  overlayHeader
                    ? "text-white/80 border-white/20"
                    : "text-neutral-500 border-neutral-200",
                )}
              >
                Đăng nhập nội bộ
              </Link>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <PublicAiAdvisor />

      <footer className="border-t border-neutral-200 bg-stone-50">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-16 sm:py-20">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-10 text-sm">
            <div>
              <h3 className="font-serif text-xl mb-3 tracking-wide">Amazing Studio</h3>
              <p className="text-neutral-600 leading-relaxed">
                Chụp ảnh cưới &amp; cho thuê trang phục cao cấp tại Tây Ninh.
              </p>
            </div>
            <div>
              <h4 className="text-[10px] tracking-[0.3em] uppercase text-neutral-500 mb-3">Liên hệ</h4>
              <p className="text-neutral-700 leading-relaxed">
                {STUDIO_ADDRESS}
                <br />
                {STUDIO_PHONE_DISPLAY}
                <br />
                <a href={`mailto:${STUDIO_EMAIL}`} className="underline hover:text-neutral-900">
                  {STUDIO_EMAIL}
                </a>
              </p>
            </div>
            <div>
              <h4 className="text-[10px] tracking-[0.3em] uppercase text-neutral-500 mb-3">Khám phá</h4>
              <ul className="space-y-2 text-neutral-700">
                {PUBLIC_NAV.filter((n) => n.href !== "/").map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} className="hover:text-neutral-900 transition-colors">
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-12 pt-6 border-t border-neutral-200 text-xs text-neutral-500 text-center tracking-wider">
            © {new Date().getFullYear()} AMAZING STUDIO
          </div>
        </div>
      </footer>
    </div>
  );
}
