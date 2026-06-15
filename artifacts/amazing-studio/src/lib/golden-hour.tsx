// Giờ vàng (Golden Hour) — helper dùng chung cho trang Cho thuê đồ.
// goldenHourPercent + goldenHourName do API trả về (đã áp quy tắc ưu tiên + bỏ qua
// SP có sale_price riêng ở backend). Frontend chỉ tính giá sau giảm để hiển thị.

/** Giá sau giảm giờ vàng (làm tròn). percent <= 0 → giữ giá gốc. */
export function ghDiscounted(rentalPrice: number, percent?: number | null): number {
  if (!percent || percent <= 0) return rentalPrice;
  return Math.round(rentalPrice * (1 - percent / 100));
}

/** true nếu sản phẩm đang được áp giờ vàng (và KHÔNG có sale riêng — backend đã lọc). */
export function hasGoldenHour(d: { goldenHourPercent?: number | null }): boolean {
  return !!d.goldenHourPercent && d.goldenHourPercent > 0;
}

export function GoldenHourBadge({
  percent,
  className = "",
}: {
  percent?: number | null;
  className?: string;
}) {
  if (!percent || percent <= 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full font-semibold uppercase tracking-wider whitespace-nowrap text-[9px] sm:text-[10px] px-2 py-[3px] bg-amber-100 text-amber-800 border border-amber-300 shadow-sm ${className}`}
    >
      ⚡ Giờ vàng -{Math.round(percent)}%
    </span>
  );
}
