import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { bookingsTable, bookingOccurrencesTable, bookingChangeLogTable } from "@workspace/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { verifyToken } from "./auth";
import { isDuplicateOccurrence, normalizeDate, normalizeTime } from "../lib/booking-occurrences";

/**
 * Ngày thực hiện PHỤ của booking ("dịch vụ nhiều ngày").
 * - Ngày 1 = bookings.shoot_date/shoot_time — KHÔNG quản lý ở đây, không đổi logic cũ.
 * - Bảng booking_occurrences thuần lịch trình + nhãn, không có tiền → không thể
 *   nhân đôi doanh thu/công nợ/hoa hồng.
 * - bookingId luôn lấy từ URL (không tin bookingId trong body).
 */
const router: IRouter = Router();

/** Load booking còn hiệu lực (tồn tại + không nằm trong thùng rác). */
async function loadActiveBooking(bookingId: number) {
  if (!Number.isInteger(bookingId) || bookingId <= 0) return { error: "bookingId không hợp lệ", status: 400 as const };
  const [b] = await db
    .select({
      id: bookingsTable.id,
      shootDate: bookingsTable.shootDate,
      shootTime: bookingsTable.shootTime,
      deletedAt: bookingsTable.deletedAt,
    })
    .from(bookingsTable)
    .where(eq(bookingsTable.id, bookingId));
  if (!b) return { error: "Không tìm thấy đơn hàng", status: 404 as const };
  if (b.deletedAt) return { error: "Đơn đang ở trong thùng rác — không sửa lịch thực hiện", status: 400 as const };
  return { booking: b };
}

async function listOccurrences(bookingId: number) {
  return db
    .select()
    .from(bookingOccurrencesTable)
    .where(eq(bookingOccurrencesTable.bookingId, bookingId))
    .orderBy(asc(bookingOccurrencesTable.sortOrder), asc(bookingOccurrencesTable.shootDate), asc(bookingOccurrencesTable.id));
}

function occLogValue(o: { shootDate: string | Date; shootTime?: string | null; label?: string | null }): string {
  const t = normalizeTime(o.shootTime);
  const l = (o.label ?? "").trim();
  return `${normalizeDate(o.shootDate)}${t ? ` ${t}` : ""}${l ? ` — ${l}` : ""}`;
}

// ── Danh sách ngày phụ của một đơn ───────────────────────────────────────────
router.get("/bookings/:id/occurrences", async (req, res) => {
  try {
    if (!verifyToken(req.headers.authorization)) return res.status(401).json({ error: "Chưa đăng nhập" });
    const bookingId = parseInt(req.params.id);
    const loaded = await loadActiveBooking(bookingId);
    if ("error" in loaded) return res.status(loaded.status).json({ error: loaded.error });
    res.json(await listOccurrences(bookingId));
  } catch (err) {
    console.error("GET /bookings/:id/occurrences error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// ── Thêm ngày phụ ────────────────────────────────────────────────────────────
router.post("/bookings/:id/occurrences", async (req, res) => {
  try {
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
    const bookingId = parseInt(req.params.id);
    const loaded = await loadActiveBooking(bookingId);
    if ("error" in loaded) return res.status(loaded.status).json({ error: loaded.error });

    const shootDate = typeof req.body?.shootDate === "string" ? req.body.shootDate.slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shootDate)) return res.status(400).json({ error: "Ngày thực hiện không hợp lệ (YYYY-MM-DD)" });
    const shootTime = typeof req.body?.shootTime === "string" && req.body.shootTime ? normalizeTime(req.body.shootTime) : null;
    const label = typeof req.body?.label === "string" ? req.body.label.trim().slice(0, 120) : null;

    const existing = await listOccurrences(bookingId);
    if (isDuplicateOccurrence({ shootDate, shootTime }, loaded.booking.shootDate, loaded.booking.shootTime, existing)) {
      return res.status(400).json({ error: "Ngày + giờ này trùng hoàn toàn với một ngày thực hiện đã có của đơn" });
    }

    const nextSort = existing.reduce((m, o) => Math.max(m, o.sortOrder), 0) + 1;
    const [created] = await db
      .insert(bookingOccurrencesTable)
      .values({ bookingId, shootDate, shootTime, label: label || null, sortOrder: nextSort })
      .returning();

    await db.insert(bookingChangeLogTable).values({
      bookingId,
      fieldChanged: "occurrence_add",
      oldValue: null,
      newValue: occLogValue(created),
      reason: "Thêm ngày thực hiện",
      changedById: callerId,
    });
    res.status(201).json(created);
  } catch (err) {
    console.error("POST /bookings/:id/occurrences error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// ── Sửa ngày phụ (chỉ đổi đúng occurrence đó) ────────────────────────────────
router.put("/bookings/:id/occurrences/:occId", async (req, res) => {
  try {
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
    const bookingId = parseInt(req.params.id);
    const occId = parseInt(req.params.occId);
    const loaded = await loadActiveBooking(bookingId);
    if ("error" in loaded) return res.status(loaded.status).json({ error: loaded.error });

    // Ownership: occurrence phải thuộc ĐÚNG booking trên URL — cách ly tuyệt đối.
    const [occ] = await db
      .select()
      .from(bookingOccurrencesTable)
      .where(and(eq(bookingOccurrencesTable.id, occId), eq(bookingOccurrencesTable.bookingId, bookingId)));
    if (!occ) return res.status(404).json({ error: "Không tìm thấy ngày thực hiện này trong đơn" });

    const shootDate = req.body?.shootDate !== undefined ? String(req.body.shootDate).slice(0, 10) : normalizeDate(occ.shootDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(shootDate)) return res.status(400).json({ error: "Ngày thực hiện không hợp lệ (YYYY-MM-DD)" });
    const shootTime = req.body?.shootTime !== undefined
      ? (req.body.shootTime ? normalizeTime(String(req.body.shootTime)) : null)
      : occ.shootTime;
    const label = req.body?.label !== undefined
      ? (typeof req.body.label === "string" ? req.body.label.trim().slice(0, 120) || null : null)
      : occ.label;

    const existing = await listOccurrences(bookingId);
    if (isDuplicateOccurrence({ shootDate, shootTime }, loaded.booking.shootDate, loaded.booking.shootTime, existing, occId)) {
      return res.status(400).json({ error: "Ngày + giờ này trùng hoàn toàn với một ngày thực hiện đã có của đơn" });
    }

    const [updated] = await db
      .update(bookingOccurrencesTable)
      .set({ shootDate, shootTime, label, updatedAt: new Date() })
      .where(and(eq(bookingOccurrencesTable.id, occId), eq(bookingOccurrencesTable.bookingId, bookingId)))
      .returning();

    const oldVal = occLogValue(occ);
    const newVal = occLogValue(updated);
    if (oldVal !== newVal) {
      await db.insert(bookingChangeLogTable).values({
        bookingId,
        fieldChanged: "occurrence_update",
        oldValue: oldVal,
        newValue: newVal,
        reason: "Sửa ngày thực hiện",
        changedById: callerId,
      });
    }
    res.json(updated);
  } catch (err) {
    console.error("PUT /bookings/:id/occurrences/:occId error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

// ── Xóa ngày phụ (booking + các ngày khác giữ nguyên) ────────────────────────
router.delete("/bookings/:id/occurrences/:occId", async (req, res) => {
  try {
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
    const bookingId = parseInt(req.params.id);
    const occId = parseInt(req.params.occId);
    const loaded = await loadActiveBooking(bookingId);
    if ("error" in loaded) return res.status(loaded.status).json({ error: loaded.error });

    const [occ] = await db
      .select()
      .from(bookingOccurrencesTable)
      .where(and(eq(bookingOccurrencesTable.id, occId), eq(bookingOccurrencesTable.bookingId, bookingId)));
    if (!occ) return res.status(404).json({ error: "Không tìm thấy ngày thực hiện này trong đơn" });

    await db
      .delete(bookingOccurrencesTable)
      .where(and(eq(bookingOccurrencesTable.id, occId), eq(bookingOccurrencesTable.bookingId, bookingId)));
    await db.insert(bookingChangeLogTable).values({
      bookingId,
      fieldChanged: "occurrence_remove",
      oldValue: occLogValue(occ),
      newValue: null,
      reason: "Xóa ngày thực hiện",
      changedById: callerId,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /bookings/:id/occurrences/:occId error:", err);
    res.status(500).json({ error: "Lỗi hệ thống" });
  }
});

export default router;
