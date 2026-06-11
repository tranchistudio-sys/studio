import { STUDIO_NAME } from "@/lib/public-site-config";

export function WeddingCardBrandingFooter({ className = "" }: { className?: string }) {
  return (
    <footer
      className={`py-8 px-6 text-center border-t border-black/5 ${className}`}
      aria-label="Thương hiệu Amazing Studio"
    >
      <div className="inline-flex flex-col items-center gap-2 max-w-xs mx-auto">
        <span className="font-serif text-sm tracking-[0.35em] uppercase text-inherit opacity-90">
          {STUDIO_NAME}
        </span>
        <p className="text-[10px] leading-relaxed opacity-70">
          Thiệp cưới online được thực hiện bởi Amazing Studio
        </p>
        <p className="text-[9px] tracking-widest uppercase opacity-50">Designed by Amazing Studio</p>
      </div>
    </footer>
  );
}
