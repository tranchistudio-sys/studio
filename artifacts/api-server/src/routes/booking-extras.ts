import { Router, type IRouter } from "express";
import { db, pool } from "@workspace/db";
import {
  bookingItemsTable, bookingChangeLogTable, bookingsTable, staffTable,
} from "@workspace/db/schema";
import { eq, desc, and, isNull } from "drizzle-orm";
import { verifyToken } from "./auth";

const router: IRouter = Router();

const fmtItem = (i: Record<string, unknown>) => ({
  ...i,
  unitPrice: i.unitPrice ? parseFloat(i.unitPrice as string) : 0,
  totalPrice: i.totalPrice ? parseFloat(i.totalPrice as string) : 0,
});

// ── Task #10: Booking Items ─────────────────────────────────────────────────────

router.get("/bookings/:id/items", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const bookingId = parseInt(req.params.id);
  if (isNaN(bookingId)) return res.status(400).json({ error: "ID không hợp lệ" });
  const items = await db.select().from(bookingItemsTable)
    .where(eq(bookingItemsTable.bookingId, bookingId))
    .orderBy(bookingItemsTable.createdAt);
  res.json(items.map(fmtItem));
});

router.post("/bookings/:id/items", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const bookingId = parseInt(req.params.id);
  if (isNaN(bookingId)) return res.status(400).json({ error: "ID không hợp lệ" });
  const { type = "addon", title, qty = 1, unitPrice = 0, soldByStaffId, notes } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: "Vui lòng nhập tên hạng mục" });

  const totalPrice = parseFloat(String(qty)) * parseFloat(String(unitPrice));
  const [item] = await db.insert(bookingItemsTable).values({
    bookingId, type, title: title.trim(),
    qty: parseInt(String(qty)), unitPrice: String(unitPrice),
    totalPrice: String(totalPrice),
    soldByStaffId: soldByStaffId ? parseInt(String(soldByStaffId)) : null,
    notes: notes || null,
    isActive: 1,
  }).returning();
  res.status(201).json(fmtItem(item as unknown as Record<string, unknown>));
});

router.put("/bookings/:id/items/:itemId", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const itemId = parseInt(req.params.itemId);
  const { title, qty, unitPrice, soldByStaffId, notes, isActive } = req.body;
  const update: Record<string, unknown> = {};
  if (title !== undefined) update.title = title;
  if (qty !== undefined) update.qty = parseInt(String(qty));
  if (unitPrice !== undefined) update.unitPrice = String(unitPrice);
  if (qty !== undefined && unitPrice !== undefined) {
    update.totalPrice = String(parseFloat(String(qty)) * parseFloat(String(unitPrice)));
  }
  if (soldByStaffId !== undefined) update.soldByStaffId = soldByStaffId ? parseInt(String(soldByStaffId)) : null;
  if (notes !== undefined) update.notes = notes;
  if (isActive !== undefined) update.isActive = isActive ? 1 : 0;

  const [updated] = await db.update(bookingItemsTable)
    .set(update).where(eq(bookingItemsTable.id, itemId)).returning();
  if (!updated) return res.status(404).json({ error: "Không tìm thấy hạng mục" });
  res.json(fmtItem(updated as unknown as Record<string, unknown>));
});

// Nâng gói (upgrade): tạo upgrade_delta, deactivate old base_package, cập nhật total_amount
router.post("/bookings/:id/upgrade", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const bookingId = parseInt(req.params.id);
  if (isNaN(bookingId)) return res.status(400).json({ error: "ID không hợp lệ" });

  const { newPackageName, newPrice, soldByStaffId, notes } = req.body;
  if (!newPackageName || newPrice === undefined) {
    return res.status(400).json({ error: "Vui lòng nhập tên gói mới và giá" });
  }

  const [booking] = await db.select().from(bookingsTable).where(and(eq(bookingsTable.id, bookingId), isNull(bookingsTable.deletedAt)));
  if (!booking) return res.status(404).json({ error: "Không tìm thấy booking" });

  const existingItems = await db.select().from(bookingItemsTable)
    .where(and(eq(bookingItemsTable.bookingId, bookingId), eq(bookingItemsTable.isActive, 1)));

  const oldBase = existingItems.find(i => i.type === "base_package");
  const oldPrice = oldBase ? parseFloat(oldBase.totalPrice) : parseFloat(booking.totalAmount);
  const delta = parseFloat(String(newPrice)) - oldPrice;

  if (oldBase) {
    await db.update(bookingItemsTable)
      .set({ isActive: 0 })
      .where(eq(bookingItemsTable.id, oldBase.id));
  }

  // Thêm item gói mới
  await db.insert(bookingItemsTable).values({
    bookingId, type: "base_package", title: newPackageName,
    qty: 1, unitPrice: String(newPrice), totalPrice: String(newPrice),
    soldByStaffId: soldByStaffId ? parseInt(String(soldByStaffId)) : null,
    notes: notes || null, isActive: 1,
  });

  if (Math.abs(delta) > 0) {
    await db.insert(bookingItemsTable).values({
      bookingId, type: "upgrade_delta",
      title: `Chênh lệch nâng gói → ${newPackageName}`,
      qty: 1, unitPrice: String(delta), totalPrice: String(delta),
      soldByStaffId: soldByStaffId ? parseInt(String(soldByStaffId)) : null,
      notes: notes || null, isActive: 1,
    });
  }

  // Cập nhật total_amount booking
  const [updatedBooking] = await db.update(bookingsTable)
    .set({ totalAmount: String(newPrice), packageType: newPackageName })
    .where(eq(bookingsTable.id, bookingId))
    .returning();

  res.json({ booking: updatedBooking, delta });
});

// ── Task #11: Reschedule ────────────────────────────────────────────────────────
// Phân quyền: admin đổi tất cả; staff chỉ đổi khi được assigned vào buổi đó.
// Kiểm tra xung đột nhân viên được phân công trước khi cập nhật.
// Ghi log booking_change_log với old/new date+time và lý do.

router.patch("/bookings/:id/reschedule", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

  const bookingId = parseInt(req.params.id);
  if (isNaN(bookingId)) return res.status(400).json({ error: "ID không hợp lệ" });

  const { newDate, newTime, reason } = req.body;
  if (!newDate) return res.status(400).json({ error: "Vui lòng chọn ngày mới" });
  if (!reason?.trim()) return res.status(400).json({ error: "Vui lòng nhập lý do đổi lịch" });

  const [booking] = await db.select().from(bookingsTable).where(and(eq(bookingsTable.id, bookingId), isNull(bookingsTable.deletedAt)));
  if (!booking) return res.status(404).json({ error: "Không tìm thấy booking" });

  // Phân quyền: admin hoặc nhân viên được assigned vào buổi đó
  const callerR = await pool.query(`SELECT role, roles FROM staff WHERE id = $1`, [callerId]);
  const caller = callerR.rows[0] as Record<string, unknown> | undefined;
  const isAdmin = caller && (caller.role === "admin" || (Array.isArray(caller.roles) && caller.roles.includes("admin")));

  if (!isAdmin) {
    const assigned = booking.assignedStaff as Record<string, unknown> | number[] | null;
    let isAssigned = false;
    if (Array.isArray(assigned)) {
      isAssigned = assigned.map(Number).includes(callerId);
    } else if (assigned && typeof assigned === "object") {
      // Chỉ lấy các key thực sự là nhân viên (bỏ *Task và các meta key không phải số)
      const staffIdValues = Object.entries(assigned)
        .filter(([k]) => !k.endsWith("Task"))
        .map(([, v]) => Number(v))
        .filter(n => Number.isInteger(n) && n > 0);
      isAssigned = staffIdValues.includes(callerId);
    }
    if (!isAssigned) return res.status(403).json({ error: "Bạn không có quyền đổi lịch buổi này" });
  }

  // Kiểm tra xung đột lịch: nhân viên được phân công đã có buổi khác cùng ngày?
  if (booking.assignedStaff) {
    const assigned = booking.assignedStaff as Record<string, unknown> | number[];
    let staffIds: number[] = [];
    if (Array.isArray(assigned)) {
      staffIds = assigned.map(Number).filter(Boolean);
    } else if (typeof assigned === "object") {
      // Bỏ qua các key không phải số (vd: saleTask, photoTask...)
      staffIds = Object.entries(assigned)
        .filter(([k]) => !k.endsWith("Task"))
        .map(([, v]) => Number(v))
        .filter(Boolean);
    }

    if (staffIds.length > 0) {
      // Tìm buổi chụp khác cùng ngày/giờ có chung nhân viên được phân công.
      // Nếu newTime được cung cấp: conflict khi trùng ngày VÀ (trùng giờ hoặc giờ bên kia NULL).
      // Nếu không có newTime: conflict khi trùng ngày.
      // Dùng jsonb_each để duyệt toàn bộ các key gán nhân viên (bỏ *Task và giá trị không phải số).
      const conflictR = await pool.query(`
        SELECT b.id, b.shoot_date, b.shoot_time, c.name AS customer_name,
          (
            SELECT string_agg(s.name, ', ')
            FROM staff s
            WHERE s.id = ANY($3::int[])
              AND (
                (jsonb_typeof(b.assigned_staff) = 'array'
                  AND b.assigned_staff @> to_jsonb(s.id))
                OR (jsonb_typeof(b.assigned_staff) = 'object'
                  AND EXISTS (
                    SELECT 1 FROM jsonb_each(b.assigned_staff) kv
                    WHERE kv.key NOT LIKE '%Task'
                      AND kv.value::text ~ '^[0-9]+$'
                      AND (kv.value::text)::int = s.id
                  ))
              )
          ) AS conflicting_staff_names
        FROM bookings b
        LEFT JOIN customers c ON c.id = b.customer_id
        WHERE b.shoot_date = $1
          AND b.id != $2
          AND b.deleted_at IS NULL
          AND b.status NOT IN ('cancelled', 'huy')
          AND (
            $4::text IS NULL
            OR b.shoot_time IS NULL
            OR b.shoot_time = $4::text
          )
          AND (
            (jsonb_typeof(b.assigned_staff) = 'array'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(b.assigned_staff) elem
                WHERE elem::text ~ '^[0-9]+$'
                  AND elem::text::int = ANY($3::int[])
              ))
            OR (jsonb_typeof(b.assigned_staff) = 'object'
              AND EXISTS (
                SELECT 1 FROM jsonb_each(b.assigned_staff) kv
                WHERE kv.key NOT LIKE '%Task'
                  AND kv.value::text ~ '^[0-9]+$'
                  AND (kv.value::text)::int = ANY($3::int[])
              ))
          )
        LIMIT 3
      `, [newDate, bookingId, staffIds, newTime !== undefined ? (newTime || null) : null]);

      if (conflictR.rows.length > 0) {
        const conflicts = conflictR.rows as {
          customer_name: string;
          shoot_date: string;
          shoot_time: string;
          conflicting_staff_names: string | null;
        }[];
        return res.status(409).json({
          error: "Xung đột lịch với nhân viên được phân công",
          conflicts: conflicts.map(c => ({
            customerName: c.customer_name,
            date: c.shoot_date,
            time: c.shoot_time,
            staffNames: c.conflicting_staff_names || "",
          })),
        });
      }
    }
  }

  // Ghi log lịch sử đổi lịch vào booking_change_log
  await db.insert(bookingChangeLogTable).values({
    bookingId,
    fieldChanged: "schedule",
    oldValue: `${booking.shootDate}${booking.shootTime ? " " + booking.shootTime : ""}`,
    newValue: `${newDate}${newTime ? " " + newTime : ""}`,
    reason: reason.trim(),
    changedById: callerId,
  });

  // Cập nhật shoot_date và shoot_time:
  // - newTime là chuỗi có giá trị => dùng newTime
  // - newTime là "" hoặc null/undefined => giữ nguyên giờ cũ (không xóa)
  const resolvedTime = newTime !== undefined && newTime !== "" ? newTime : (booking.shootTime ?? null);
  const [updated] = await db.update(bookingsTable)
    .set({ shootDate: newDate, shootTime: resolvedTime })
    .where(eq(bookingsTable.id, bookingId))
    .returning();

  res.json(updated);
});

// Lấy lịch sử đổi lịch
router.get("/bookings/:id/change-log", async (req, res) => {
  const callerId = verifyToken(req.headers.authorization);
  if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });
  const bookingId = parseInt(req.params.id);
  const fieldFilter = req.query.field as string | undefined;

  const conditions = [eq(bookingChangeLogTable.bookingId, bookingId)];
  if (fieldFilter) {
    conditions.push(eq(bookingChangeLogTable.fieldChanged, fieldFilter));
  }

  const logs = await db.select({
    id: bookingChangeLogTable.id,
    bookingId: bookingChangeLogTable.bookingId,
    fieldChanged: bookingChangeLogTable.fieldChanged,
    oldValue: bookingChangeLogTable.oldValue,
    newValue: bookingChangeLogTable.newValue,
    reason: bookingChangeLogTable.reason,
    changedById: bookingChangeLogTable.changedById,
    createdAt: bookingChangeLogTable.createdAt,
    changedByName: staffTable.name,
  })
    .from(bookingChangeLogTable)
    .leftJoin(staffTable, eq(bookingChangeLogTable.changedById, staffTable.id))
    .where(and(...conditions))
    .orderBy(desc(bookingChangeLogTable.createdAt));
  res.json(logs);
});

export default router;
