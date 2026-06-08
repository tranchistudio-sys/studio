import { cn } from "@/lib/utils";

/** Khung mobile 390–430px — `bare` = giống khách xem (không viền máy giả). */
export function WeddingCardPhoneFrame({
  children,
  className,
  label,
  variant = "bare",
  fullLength = false,
}: {
  children: React.ReactNode;
  className?: string;
  label?: string;
  variant?: "bare" | "device";
  /** Thiệp dài như BT — không cắt chiều cao */
  fullLength?: boolean;
}) {
  const scrollClass = fullLength
    ? "overflow-visible"
    : "max-h-[min(85vh,780px)] overflow-y-auto overflow-x-hidden overscroll-contain";

  const shell = (
    <div
      className={cn(
        "wc-card-shell bg-white",
        fullLength ? "overflow-visible rounded-xl shadow-md border border-neutral-200/60" : "overflow-hidden",
        variant === "device"
          ? "rounded-[1.75rem] border border-neutral-200/90 shadow-2xl shadow-neutral-300/40"
          : !fullLength && "rounded-xl shadow-md border border-neutral-200/60",
      )}
    >
      {variant === "device" && (
        <div className="h-6 bg-neutral-900/95 flex items-center justify-center gap-1.5">
          <span className="w-1 h-1 rounded-full bg-white/30" />
          <span className="w-8 h-0.5 rounded-full bg-white/20" />
          <span className="w-1 h-1 rounded-full bg-white/30" />
        </div>
      )}
      <div className={cn(scrollClass, fullLength && "wc-bt-phone-full-inner")}>{children}</div>
    </div>
  );

  return (
    <div className={cn("flex flex-col items-center w-full px-3 sm:px-4", className)}>
      {label && (
        <p className="text-[10px] tracking-[0.3em] uppercase text-neutral-400 mb-2">{label}</p>
      )}
      {variant === "device" ? (
        <div className="relative w-full max-w-[430px]">
          <div className="pointer-events-none absolute -inset-0.5 rounded-[1.85rem] bg-neutral-200/50 hidden sm:block" />
          <div className="relative">{shell}</div>
        </div>
      ) : (
        <div className={cn("w-full max-w-[430px]", fullLength && "wc-bt-phone-full-wrap")}>{shell}</div>
      )}
    </div>
  );
}
