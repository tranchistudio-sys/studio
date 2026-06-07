import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  quotesTable,
  customersTable,
  bookingsTable,
  paymentsTable,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { getCallerRole } from "./auth";

const router: IRouter = Router();

const QUOTE_STATUSES = ["draft", "sent", "considering", "converted", "cancelled"] as const;
type QuoteStatus = typeof QUOTE_STATUSES[number];

type ChargeRow = { label: string; amount: number };
type QuoteItemRow = { name: string; quantity: number; unitPrice: number; total: number };

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
};

const sumCharges = (rows: unknown): number => {
  if (!Array.isArray(rows)) return 0;
  return (rows as ChargeRow[]).reduce((s, r) => s + num(r?.amount), 0);
};

// Validate charges có amount >= 0 (chặn lách luật: dùng surcharge âm thay cho deduction)
const validateCharges = (rows: unknown, fieldName: string): string | null => {
  if (rows === undefined || rows === null) return null;
  if (!Array.isArray(rows)) return `${fieldName} phải là mảng`;
  for (const [i, r] of (rows as ChargeRow[]).entries()) {
    const a = num(r?.amount);
    if (!Number.isFinite(a)) return `${fieldName}[${i}].amount không hợp lệ`;
    if (a < 0) return `${fieldName}[${i}].amount không được âm`;
  }
  return null;
};

const computeTotals = (
  items: QuoteItemRow[],
  surcharges: ChargeRow[],
  deductions: ChargeRow[],
  discount: number,
) => {
  const itemsTotal = items.reduce((s, i) => s + num(i.total), 0);
  const surchargeTotal = sumCharges(surcharges);
  const deductionTotal = sumCharges(deductions);
  const totalAmount = itemsTotal + surchargeTotal;
  const finalAmount = Math.max(0, totalAmount - deductionTotal - num(discount));
  return { totalAmount, finalAmount };
};

const formatQuote = (
  row: Record<string, unknown> & {
    totalAmount: string | number;
    discount: string | number;
    finalAmount: string | number;
    depositAmount?: string | number;
  },
) => ({
  ...row,
  totalAmount: num(row.totalAmount),
  discount: num(row.discount),
  finalAmount: num(row.finalAmount),
  depositAmount: num(row.depositAmount ?? 0),
});

// Đọc 1 quote + thông tin khách (LEFT JOIN vì customer_id có thể null)
const selectQuote = () =>
  db
    .select({
      id: quotesTable.id,
      customerId: quotesTable.customerId,
      customerName: sql<string | null>`COALESCE(${customersTable.name}, ${quotesTable.customerName})`,
      customerPhone: sql<string | null>`COALESCE(${customersTable.phone}, ${quotesTable.phone})`,
      title: quotesTable.title,
      items: quotesTable.items,
      surcharges: quotesTable.surcharges,
      deductions: quotesTable.deductions,
      totalAmount: quotesTable.totalAmount,
      discount: quotesTable.discount,
      finalAmount: quotesTable.finalAmount,
      depositAmount: quotesTable.depositAmount,
      status: quotesTable.status,
      validUntil: quotesTable.validUntil,
      expectedDate: quotesTable.expectedDate,
      expectedTime: quotesTable.expectedTime,
      notes: quotesTable.notes,
      convertedBookingId: quotesTable.convertedBookingId,
      convertedAt: quotesTable.convertedAt,
      createdAt: quotesTable.createdAt,
    })
    .from(quotesTable)
    .leftJoin(customersTable, eq(quotesTable.customerId, customersTable.id));

router.get("/quotes", async (req, res) => {
  const customerId = req.query.customerId ? parseInt(req.query.customerId as string) : undefined;
  const status = req.query.status as string | undefined;

  const rows = await selectQuote().orderBy(quotesTable.createdAt);

  let filtered = rows;
  if (customerId) filtered = filtered.filter((q) => q.customerId === customerId);
  if (status) filtered = filtered.filter((q) => q.status === status);

  res.json(filtered.map(formatQuote));
});

router.post("/quotes", async (req, res) => {
  try {
    const {
      customerId,
      customerName,
      phone,
      title,
      items = [],
      surcharges = [],
      deductions = [],
      discount = 0,
      depositAmount = 0,
      validUntil,
      expectedDate,
      expectedTime,
      notes,
      status = "draft",
    } = req.body ?? {};

    if (!title || typeof title !== "string") {
      return res.status(400).json({ error: "title is required" });
    }
    if (!customerId && !phone && !customerName) {
      return res
        .status(400)
        .json({ error: "Cần customerId hoặc thông tin khách (phone/customerName)" });
    }
    if (!QUOTE_STATUSES.includes(status as QuoteStatus)) {
      return res.status(400).json({ error: `status không hợp lệ: ${status}` });
    }
    // Không cho FE đặt status=converted thủ công — phải dùng convert endpoint
    if (status === "converted") {
      return res.status(400).json({
        error: "Dùng POST /quotes/:id/convert-to-booking để chuyển trạng thái converted.",
      });
    }
    // Server-side enforcement: chỉ admin được set deductions
    if (Array.isArray(deductions) && deductions.length > 0) {
      const role = await getCallerRole(req.headers.authorization);
      if (role !== "admin") {
        return res.status(403).json({ error: "Chỉ admin mới được nhập giảm trừ." });
      }
    }
    // Validate amounts không âm (chặn lách qua surcharge âm)
    for (const [field, rows] of [
      ["surcharges", surcharges],
      ["deductions", deductions],
    ] as const) {
      const err = validateCharges(rows, field);
      if (err) return res.status(400).json({ error: err });
    }
    if (num(discount) < 0) return res.status(400).json({ error: "discount không được âm" });
    if (num(depositAmount) < 0) return res.status(400).json({ error: "depositAmount không được âm" });

    const { totalAmount, finalAmount } = computeTotals(
      items as QuoteItemRow[],
      surcharges as ChargeRow[],
      deductions as ChargeRow[],
      num(discount),
    );

    const [quote] = await db
      .insert(quotesTable)
      .values({
        customerId: customerId ?? null,
        customerName: customerName ?? null,
        phone: phone ?? null,
        title,
        items: items as QuoteItemRow[],
        surcharges: surcharges as ChargeRow[],
        deductions: deductions as ChargeRow[],
        totalAmount: String(totalAmount),
        discount: String(num(discount)),
        finalAmount: String(finalAmount),
        depositAmount: String(num(depositAmount)),
        validUntil: validUntil || null,
        expectedDate: expectedDate || null,
        expectedTime: expectedTime || null,
        notes: notes || null,
        status,
      })
      .returning();

    const [row] = await selectQuote().where(eq(quotesTable.id, quote.id));
    res.status(201).json(formatQuote(row));
  } catch (err) {
    console.error("[POST /quotes] error:", err);
    res.status(500).json({ error: "Lỗi tạo báo giá" });
  }
});

router.get("/quotes/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [row] = await selectQuote().where(eq(quotesTable.id, id));
  if (!row) return res.status(404).json({ error: "Quote not found" });
  res.json(formatQuote(row));
});

router.put("/quotes/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const body = req.body ?? {};

  const [existing] = await db.select().from(quotesTable).where(eq(quotesTable.id, id));
  if (!existing) return res.status(404).json({ error: "Quote not found" });

  if (existing.status === "converted") {
    return res
      .status(409)
      .json({ error: "Báo giá đã chuyển thành booking, không thể sửa." });
  }

  const update: Record<string, unknown> = {};
  const fields = [
    "customerId", "customerName", "phone", "title",
    "validUntil", "expectedDate", "expectedTime", "notes", "status",
  ] as const;
  for (const f of fields) {
    if (body[f] !== undefined) update[f === "customerId" ? "customerId" : f] = body[f] === "" ? null : body[f];
  }

  if (body.status !== undefined && !QUOTE_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: `status không hợp lệ: ${body.status}` });
  }
  // Không cho FE đặt status=converted thủ công — phải dùng convert endpoint
  if (body.status === "converted") {
    return res
      .status(400)
      .json({ error: "Dùng POST /quotes/:id/convert-to-booking để chuyển trạng thái converted." });
  }

  // Server-side enforcement: chỉ admin được sửa deductions
  if (body.deductions !== undefined) {
    const role = await getCallerRole(req.headers.authorization);
    const newDed = Array.isArray(body.deductions) ? body.deductions : [];
    const oldDed = Array.isArray(existing.deductions) ? existing.deductions : [];
    // Cho phép non-admin nếu họ không thay đổi deductions (gửi lại như cũ)
    const sameAsExisting = JSON.stringify(newDed) === JSON.stringify(oldDed);
    if (!sameAsExisting && role !== "admin") {
      return res.status(403).json({ error: "Chỉ admin mới được sửa giảm trừ." });
    }
  }

  // Validate amounts không âm (chặn lách qua surcharge âm)
  for (const field of ["surcharges", "deductions"] as const) {
    if (body[field] !== undefined) {
      const err = validateCharges(body[field], field);
      if (err) return res.status(400).json({ error: err });
    }
  }
  if (body.discount !== undefined && num(body.discount) < 0) {
    return res.status(400).json({ error: "discount không được âm" });
  }
  if (body.depositAmount !== undefined && num(body.depositAmount) < 0) {
    return res.status(400).json({ error: "depositAmount không được âm" });
  }

  const items = body.items !== undefined ? body.items : existing.items;
  const surcharges = body.surcharges !== undefined ? body.surcharges : existing.surcharges;
  const deductions = body.deductions !== undefined ? body.deductions : existing.deductions;
  const discount = body.discount !== undefined ? num(body.discount) : num(existing.discount);
  const depositAmount =
    body.depositAmount !== undefined ? num(body.depositAmount) : num(existing.depositAmount);

  if (
    body.items !== undefined ||
    body.surcharges !== undefined ||
    body.deductions !== undefined ||
    body.discount !== undefined
  ) {
    const { totalAmount, finalAmount } = computeTotals(
      items as QuoteItemRow[],
      surcharges as ChargeRow[],
      deductions as ChargeRow[],
      discount,
    );
    update.items = items;
    update.surcharges = surcharges;
    update.deductions = deductions;
    update.totalAmount = String(totalAmount);
    update.discount = String(discount);
    update.finalAmount = String(finalAmount);
  }
  if (body.depositAmount !== undefined) update.depositAmount = String(depositAmount);

  await db.update(quotesTable).set(update).where(eq(quotesTable.id, id));
  const [row] = await selectQuote().where(eq(quotesTable.id, id));
  res.json(formatQuote(row));
});

router.delete("/quotes/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(quotesTable).where(eq(quotesTable.id, id));
  if (!existing) return res.status(204).send();
  if (existing.status === "converted") {
    return res
      .status(409)
      .json({ error: "Báo giá đã chuyển thành booking, không thể xoá." });
  }
  await db.delete(quotesTable).where(eq(quotesTable.id, id));
  res.status(204).send();
});

// ─── Convert quote → booking (idempotent + atomic) ───────────────────────────
// Toàn bộ flow nằm trong 1 transaction + SELECT ... FOR UPDATE để chặn race:
// 2 request đồng thời sẽ tuần tự hoá; request thứ 2 đọc quote đã converted và trả 409.
router.post("/quotes/:id/convert-to-booking", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const {
      shootDate,
      shootTime,
      assignedStaff,
      depositAmount: depositOverride,
      depositPaymentMethod,
      depositCollector,
      packageType: packageTypeOverride,
      location,
    } = req.body ?? {};

    if (!shootDate) {
      return res.status(400).json({ error: "shootDate là bắt buộc khi chuyển booking." });
    }
    if (depositOverride !== undefined && num(depositOverride) < 0) {
      return res.status(400).json({ error: "depositAmount không được âm." });
    }

    const result = await db.transaction(async (tx) => {
      // Row-lock quote để chặn concurrent convert
      const lockRows = await tx.execute(
        sql`SELECT * FROM quotes WHERE id = ${id} FOR UPDATE`,
      );
      // pg trả `.rows`; drizzle proxy-pg cũng vậy
      const lockedRow = (lockRows as { rows?: unknown[] }).rows?.[0] as
        | (typeof quotesTable.$inferSelect & { converted_booking_id?: number | null; converted_at?: Date | null })
        | undefined;
      if (!lockedRow) {
        return { kind: "not_found" as const };
      }
      // raw SQL trả snake_case
      const lockedConvertedBookingId =
        (lockedRow as Record<string, unknown>).converted_booking_id as number | null ??
        (lockedRow as { convertedBookingId?: number | null }).convertedBookingId ?? null;
      const lockedConvertedAt =
        (lockedRow as Record<string, unknown>).converted_at as Date | null ??
        (lockedRow as { convertedAt?: Date | null }).convertedAt ?? null;

      // Bất kỳ row nào status='converted' đều trả 409 (kể cả nếu data corrupt thiếu bookingId)
      if (lockedRow.status === "converted") {
        return {
          kind: "already_converted" as const,
          bookingId: lockedConvertedBookingId,
          convertedAt: lockedConvertedAt,
        };
      }
      if (lockedRow.status === "cancelled") {
        return { kind: "cancelled" as const };
      }

      // Re-fetch typed row qua drizzle (đã lock hàng nên an toàn)
      const [quote] = await tx.select().from(quotesTable).where(eq(quotesTable.id, id));

      // Cần customerId thật để tạo booking
      let customerId = quote.customerId;
      if (!customerId) {
        if (!quote.phone) {
          return { kind: "no_customer" as const };
        }
        const [foundByPhone] = await tx
          .select()
          .from(customersTable)
          .where(eq(customersTable.phone, quote.phone));
        if (foundByPhone) {
          customerId = foundByPhone.id;
        } else {
          const [newCust] = await tx
            .insert(customersTable)
            .values({
              name: quote.customerName || "Khách báo giá",
              phone: quote.phone,
            })
            .returning();
          customerId = newCust.id;
        }
      }

      const items = (quote.items as QuoteItemRow[]) || [];
      const surcharges = (quote.surcharges as ChargeRow[]) || [];
      const deductions = (quote.deductions as ChargeRow[]) || [];

      // QUAN TRỌNG: quote.finalAmount đã = totalAmount - deductions - discount.
      // Booking remaining = totalAmount - discountAmount - paidAmount.
      // → Để tránh trừ discount 2 lần, set booking.totalAmount = quote.finalAmount
      //   và booking.discountAmount = 0. Phần discount/deductions đã hấp thụ trong totalAmount.
      const bookingTotal = num(quote.finalAmount);
      const depositAmount = num(depositOverride ?? quote.depositAmount);

      // Serialize orderCode generation trong tx để chặn race tạo mã trùng khi
      // 2 convert chạy song song (count+1 không atomic). Advisory xact lock tự
      // release khi tx commit/rollback. Key cố định = hash 'bookings.order_code'.
      // (Lưu ý: routes/bookings.ts có race tương tự — out-of-scope task này.)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(736271001)`);
      const countRows = await tx.select({ id: bookingsTable.id }).from(bookingsTable);
      const orderCode = `DH${String(countRows.length + 1).padStart(4, "0")}`;

      const packageType =
        packageTypeOverride || items[0]?.name || quote.title || "Dịch vụ báo giá";

      const [booking] = await tx
        .insert(bookingsTable)
        .values({
          orderCode,
          customerId,
          shootDate,
          shootTime: shootTime || "08:00",
          serviceCategory: "wedding",
          packageType,
          location: location || null,
          status: "pending",
          items: items.map((it) => ({
            type: "manual",
            title: it.name,
            qty: it.quantity,
            unitPrice: it.unitPrice,
            totalPrice: it.total,
          })),
          surcharges,
          deductions: deductions.map((d) => ({ label: d.label, amount: Math.abs(num(d.amount)) })),
          totalAmount: String(bookingTotal),
          depositAmount: String(depositAmount),
          paidAmount: String(depositAmount),
          // Discount/deductions đã ĐƯỢC trừ trong bookingTotal — giữ 0 để không trừ lần 2.
          discountAmount: "0",
          assignedStaff: assignedStaff || {},
          notes: quote.notes || null,
          internalNotes: `Tạo từ Báo giá tạm tính #${quote.id} (gốc: total=${num(quote.totalAmount)}, deductions=${sumCharges(deductions)}, discount=${num(quote.discount)})`,
        })
        .returning();

      if (depositAmount > 0) {
        await tx.insert(paymentsTable).values({
          bookingId: booking.id,
          amount: String(depositAmount),
          paymentMethod: depositPaymentMethod || "cash",
          paymentType: "deposit",
          collectorName: depositCollector || null,
          paidDate: shootDate,
          notes: `Cọc giữ lịch (chuyển từ báo giá #${quote.id})`,
        });
      }

      // Conditional update — chỉ thành công nếu vẫn chưa converted
      // (FOR UPDATE đã đảm bảo, nhưng thêm guard để chắc chắn)
      const updated = await tx
        .update(quotesTable)
        .set({
          status: "converted",
          convertedBookingId: booking.id,
          convertedAt: new Date(),
          customerId,
        })
        .where(and(eq(quotesTable.id, id), sql`${quotesTable.status} <> 'converted'`))
        .returning({ id: quotesTable.id });

      if (updated.length === 0) {
        // Không bao giờ tới đây vì đã FOR UPDATE, nhưng rollback để an toàn
        throw new Error("Race detected: quote đã converted bởi request khác.");
      }

      return { kind: "ok" as const, bookingId: booking.id, orderCode: booking.orderCode };
    });

    if (result.kind === "not_found") {
      return res.status(404).json({ error: "Quote not found" });
    }
    if (result.kind === "already_converted") {
      return res.status(409).json({
        error: "Báo giá đã được chuyển thành booking trước đó.",
        bookingId: result.bookingId,
        convertedAt: result.convertedAt,
      });
    }
    if (result.kind === "cancelled") {
      return res.status(400).json({ error: "Báo giá đã huỷ, không thể chuyển booking." });
    }
    if (result.kind === "no_customer") {
      return res.status(400).json({
        error: "Báo giá chưa có khách hàng. Vui lòng gắn khách (phone) trước khi chuyển.",
      });
    }

    const [row] = await selectQuote().where(eq(quotesTable.id, id));
    return res.status(201).json({
      bookingId: result.bookingId,
      orderCode: result.orderCode,
      quote: formatQuote(row),
    });
  } catch (err) {
    console.error("[POST /quotes/:id/convert-to-booking] error:", err);
    res.status(500).json({ error: "Lỗi chuyển báo giá thành booking" });
  }
});

export default router;
