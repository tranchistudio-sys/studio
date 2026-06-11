import { Router, type IRouter } from "express";
import { loadAllData } from "./data";

const router: IRouter = Router();

router.get("/revenue/v2/warnings", async (_req, res) => {
  const { validBookings, castByBooking, directExpByBooking } = await loadAllData();

  const warnings: { type: string; bookingId: number; message: string }[] = [];

  for (const b of validBookings) {
    const cast = castByBooking.get(b.id) ?? 0;
    const staff = b.assignedStaff;
    const hasStaff = Array.isArray(staff) ? staff.length > 0 : (staff && typeof staff === "object" && Object.keys(staff).length > 0);

    if (hasStaff && cast === 0) {
      warnings.push({ type: "no_cast", bookingId: b.id, message: "Có nhân viên nhưng chưa có bảng giá cast" });
    }
    if (!hasStaff) {
      warnings.push({ type: "no_staff", bookingId: b.id, message: "Chưa giao nhân viên" });
    }

    const total = parseFloat(b.totalAmount) || 0;
    const directExp = directExpByBooking.get(b.id) ?? 0;
    if (total > 0 && (total - cast - directExp) < 0) {
      warnings.push({ type: "negative_profit", bookingId: b.id, message: "Lợi nhuận âm" });
    }

    const disc = parseFloat(b.discountAmount) || 0;
    const paid = parseFloat(b.paidAmount) || 0;
    const remaining = total - disc - paid;
    if (remaining > 0 && b.shootDate) {
      const shootDate = new Date(b.shootDate);
      const now = new Date();
      const daysSinceShoot = Math.floor((now.getTime() - shootDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSinceShoot > 30) {
        warnings.push({ type: "overdue", bookingId: b.id, message: `Còn nợ ${Math.round(remaining).toLocaleString("vi-VN")}đ, đã ${daysSinceShoot} ngày sau chụp` });
      }
    }
  }

  res.json(warnings);
});

export default router;
