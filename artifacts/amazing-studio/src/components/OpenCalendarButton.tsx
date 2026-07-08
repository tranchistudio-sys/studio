import type { MouseEvent } from "react";
import { CalendarDays } from "lucide-react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { bookingCalendarUrl, canOpenBookingCalendar } from "@/lib/open-calendar";

/**
 * OpenCalendarButton — nút "Mở lịch chụp" DÙNG CHUNG cho mọi màn có booking/show (đơn hàng, khách
 * hàng, thu chi, hậu kỳ…). Bấm → điều hướng `/calendar?bookingId=N`; Calendar tự nhảy đúng ngày +
 * mở detail của show (deep-link sẵn có). Tránh mỗi màn tự viết một kiểu.
 *
 * - Không có bookingId hợp lệ (item không gắn booking / booking đã xóa) ⇒ KHÔNG render (null).
 * - `requireShootDate`: nếu bật mà thiếu shootDate ⇒ disable + đổi nhãn "Không còn lịch chụp".
 * - `iconOnly`: chỉ hiện icon (chỗ hẹp như panel khách). Mặc định: icon + text ẩn ở mobile.
 * - Luôn stopPropagation (dòng/card cha thường là <button>, tránh mở nhầm modal/detail).
 */
export function OpenCalendarButton({
  bookingId,
  shootDate,
  requireShootDate = false,
  iconOnly = false,
  className,
  label = "Mở lịch chụp",
}: {
  bookingId: number | null | undefined;
  shootDate?: string | null;
  requireShootDate?: boolean;
  iconOnly?: boolean;
  className?: string;
  label?: string;
}) {
  const [, setLocation] = useLocation();
  if (!canOpenBookingCalendar(bookingId)) return null;

  const noShoot = requireShootDate && !shootDate;
  const text = noShoot ? "Không còn lịch chụp" : label;

  return (
    <button
      type="button"
      disabled={noShoot}
      title={noShoot ? "Không còn lịch chụp" : "Mở show này trên lịch chụp để sửa lịch / giao việc / giờ chụp"}
      aria-label={text}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        if (!noShoot) setLocation(bookingCalendarUrl(bookingId as number));
      }}
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors flex-shrink-0",
        noShoot
          ? "border-border text-muted-foreground/50 cursor-not-allowed"
          : "border-primary/40 text-primary hover:bg-primary/10",
        className,
      )}
    >
      <CalendarDays className="w-3.5 h-3.5 shrink-0" />
      {!iconOnly && <span className="hidden sm:inline whitespace-nowrap">{text}</span>}
    </button>
  );
}
