import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  contractsTable,
  contractChangeLogTable,
  customersTable,
  bookingsTable,
  notificationsTable,
  staffTable,
} from "@workspace/db/schema";
import { eq, ne, desc, and, isNull, inArray } from "drizzle-orm";
import crypto from "node:crypto";
import { getPublicBaseUrl } from "../lib/publicUrl";
import { verifyToken, getCallerRole } from "./auth";
import {
  buildContractPayload,
  buildSignedSnapshot,
} from "../lib/contractPayload";
import {
  contractCandidateBookingIds,
  newestContractIdByBooking,
  pickContractIdForBooking,
} from "../lib/contract-resolve";
import { overlayLiveContractRows } from "../lib/contract-live";

const router: IRouter = Router();

// ─── Helpers hợp đồng online v2 ──────────────────────────────────────────────

/** Token public cố định cho 1 hợp đồng (1 đơn = 1 link). Race-safe: chỉ set khi còn NULL. */
async function ensurePublicToken(id: number): Promise<string | null> {
  const token = crypto.randomBytes(24).toString("base64url");
  const updated = await db
    .update(contractsTable)
    .set({ publicToken: token })
    .where(and(eq(contractsTable.id, id), isNull(contractsTable.publicToken)))
    .returning({ publicToken: contractsTable.publicToken });
  if (updated.length > 0) return updated[0].publicToken;
  const [row] = await db
    .select({ publicToken: contractsTable.publicToken })
    .from(contractsTable)
    .where(eq(contractsTable.id, id));
  return row?.publicToken ?? null;
}

/** Validate chữ ký PNG base64 từ canvas. Trả message lỗi hoặc null nếu hợp lệ. */
function validateSignatureData(sig: unknown): string | null {
  if (typeof sig !== "string" || !sig.startsWith("data:image/png;base64,")) {
    return "Chữ ký không hợp lệ (yêu cầu ảnh PNG)";
  }
  if (sig.length > 700_000) return "Ảnh chữ ký quá lớn (tối đa ~500KB)";
  return null;
}

/** Ghi lịch sử chỉnh sửa NỘI BỘ. Không throw — lỗi log không được chặn nghiệp vụ chính. */
async function logContractChanges(
  contractId: number,
  changes: { field: string; oldValue?: unknown; newValue?: unknown; reason?: string }[],
  changedById: number | null,
): Promise<void> {
  if (changes.length === 0) return;
  await db
    .insert(contractChangeLogTable)
    .values(
      changes.map((ch) => ({
        contractId,
        fieldChanged: ch.field,
        oldValue: ch.oldValue == null ? null : String(ch.oldValue),
        newValue: ch.newValue == null ? null : String(ch.newValue),
        reason: ch.reason ?? null,
        changedById,
      })),
    )
    .catch(() => null);
}

/**
 * Ký Bên B (khách) — dùng chung cho endpoint public mới và mark-signed cũ.
 * Lưu chữ ký + chụp signed_snapshot (phát hiện sửa-sau-ký NỘI BỘ) + clear cờ
 * yêu-cầu-ký-lại + giữ nguyên side-effect cũ (booking → completed, notification).
 */
async function applyCustomerSignature(
  existing: typeof contractsTable.$inferSelect,
  body: { customerName?: string; customerPhone?: string; signedAt?: string; signatureData?: string },
): Promise<void> {
  const { customerName, customerPhone, signedAt, signatureData } = body;

  await db
    .update(contractsTable)
    .set({
      status: "signed",
      signedAt: signedAt ?? new Date().toISOString(),
      ...(signatureData ? { signatureImageUrl: signatureData } : {}),
      ...(customerName ? { signerName: customerName } : {}),
      ...(customerPhone ? { signerPhone: customerPhone } : {}),
      resignRequestedAt: null,
    })
    .where(eq(contractsTable.id, existing.id));

  if (existing.customerId && (customerName !== undefined || customerPhone !== undefined)) {
    const customerUpdate: Record<string, unknown> = {};
    if (customerName !== undefined) customerUpdate.name = customerName;
    if (customerPhone !== undefined) customerUpdate.phone = customerPhone;
    if (Object.keys(customerUpdate).length) {
      await db.update(customersTable).set(customerUpdate).where(eq(customersTable.id, existing.customerId));
    }
  }

  if (existing.bookingId) {
    await db.update(bookingsTable).set({ status: "completed" }).where(eq(bookingsTable.id, existing.bookingId));
  }

  // Snapshot field quan trọng TẠI THỜI ĐIỂM KÝ (sau khi update) — mốc so sánh sửa-sau-ký.
  // forSnapshot: chụp bản LIVE hiện tại — ký lại phải chốt theo hiện trạng booking
  // khách vừa xác nhận, không chụp nhầm bản đóng băng của lần ký trước.
  const payload = await buildContractPayload(existing.id, "internal", { forSnapshot: true });
  if (payload) {
    await db
      .update(contractsTable)
      .set({ signedSnapshot: buildSignedSnapshot(payload) })
      .where(eq(contractsTable.id, existing.id));
  }

  await logContractChanges(
    existing.id,
    [{ field: "customer_signature", newValue: customerName ?? existing.signerName ?? "khách hàng" }],
    null,
  );

  // Tạo thông báo nội bộ
  const [customer] = existing.customerId
    ? await db
        .select({ name: customersTable.name })
        .from(customersTable)
        .where(eq(customersTable.id, existing.customerId))
    : [null];
  await db
    .insert(notificationsTable)
    .values({
      type: "contract_signed",
      title: "Khách ký hợp đồng online",
      body: `${customer?.name ?? "Khách hàng"} vừa ký hợp đồng ${existing.contractCode} online thành công.`,
      isRead: false,
    } as Record<string, unknown>)
    .catch(() => null);
}

router.get("/contracts", async (req, res) => {
  const customerId = req.query.customerId
    ? parseInt(req.query.customerId as string)
    : undefined;
  const bookingId = req.query.bookingId
    ? parseInt(req.query.bookingId as string)
    : undefined;
  const rows = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      bookingId: contractsTable.bookingId,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      totalValue: contractsTable.totalValue,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      notes: contractsTable.notes,
      createdAt: contractsTable.createdAt,
      bookingDeductions: bookingsTable.deductions,
      bookingSurcharges: bookingsTable.surcharges,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .leftJoin(bookingsTable, eq(contractsTable.bookingId, bookingsTable.id))
    .orderBy(desc(contractsTable.createdAt));

  let filtered = rows;
  if (customerId)
    filtered = filtered.filter((c) => c.customerId === customerId);
  if (bookingId) filtered = filtered.filter((c) => c.bookingId === bookingId);
  // Hợp đồng CHƯA KÝ đọc tổng tiền + khách LIVE từ booking (booking = source of
  // truth) — total_value/customer_id trong bảng chỉ là copy lúc tạo, đã chứng
  // minh lệch thực tế (HD0036, HD0050...). Đã ký giữ nguyên số bản ký.
  res.json(await overlayLiveContractRows(filtered));
});

router.post("/contracts", async (req, res) => {
  const {
    bookingId,
    customerId,
    title,
    content,
    status,
    signedAt,
    expiresAt,
    totalValue,
    notes,
  } = req.body ?? {};
  const count = await db.select().from(contractsTable);
  const contractCode = `HD${String(count.length + 1).padStart(4, "0")}`;
  const [contract] = await db
    .insert(contractsTable)
    .values({
      contractCode,
      bookingId: bookingId || null,
      customerId,
      title,
      content: content || "",
      status: status || "draft",
      signedAt: signedAt || null,
      expiresAt: expiresAt || null,
      totalValue: totalValue ? String(totalValue) : "0",
      notes,
    })
    .returning();
  const [customer] = await db
    .select()
    .from(customersTable)
    .where(eq(customersTable.id, customerId));
  res
    .status(201)
    .json({
      ...contract,
      customerName: customer.name,
      customerPhone: customer.phone,
    });
});

router.post("/contracts/:id/sign-link", async (req, res): Promise<void> => {
  if (!verifyToken(req.headers.authorization)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = parseInt(req.params.id);
  const [row] = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .where(eq(contractsTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }

  // Link hợp đồng online CỐ ĐỊNH theo token (trang public SPA), không dùng id thô.
  const token = await ensurePublicToken(id);
  if (!token) {
    res.status(500).json({ error: "Không tạo được link hợp đồng" });
    return;
  }
  const signUrl = `${getPublicBaseUrl()}/contract/${token}`;

  res.json({
    signUrl,
    publicToken: token,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    contractCode: row.contractCode,
    title: row.title,
  });
});

// Link ký kiểu cũ (/api/contracts/:id/sign) — redirect 302 sang trang hợp đồng
// online mới theo token, để các link đã gửi khách trước đây vẫn dùng được.
router.get("/contracts/:id/sign", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [row] = await db
    .select({ id: contractsTable.id })
    .from(contractsTable)
    .where(eq(contractsTable.id, id));
  if (!row) {
    res.status(404).send("Không tìm thấy hợp đồng");
    return;
  }
  const token = await ensurePublicToken(id);
  if (!token) {
    res.status(500).send("Không tạo được link hợp đồng");
    return;
  }
  res.redirect(302, `${getPublicBaseUrl()}/contract/${token}`);
});

router.get("/contracts/:id/sync", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [contract] = await db
    .select({
      id: contractsTable.id,
      customerId: contractsTable.customerId,
      bookingId: contractsTable.bookingId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      totalValue: contractsTable.totalValue,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      notes: contractsTable.notes,
      content: contractsTable.content,
      contractCode: contractsTable.contractCode,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .where(eq(contractsTable.id, id));

  if (!contract) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }

  const [booking] = contract.bookingId
    ? await db
        .select()
        .from(bookingsTable)
        .where(and(eq(bookingsTable.id, contract.bookingId), isNull(bookingsTable.deletedAt)))
    : [];

  res.json({
    contract,
    booking: booking ?? null,
  });
});

router.get("/contracts/:id/public", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [row] = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      content: contractsTable.content,
      totalValue: contractsTable.totalValue,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      notes: contractsTable.notes,
      bookingId: contractsTable.bookingId,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .where(eq(contractsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  res.json(row);
});

// Endpoint ký kiểu cũ — giữ cho tương thích (trang ký cũ đã cache / QR đang lưu).
router.post("/contracts/:id/mark-signed", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const { signatureData } = req.body ?? {};
  const [existing] = await db
    .select()
    .from(contractsTable)
    .where(eq(contractsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  if (signatureData) {
    const sigErr = validateSignatureData(signatureData);
    if (sigErr) {
      res.status(400).json({ error: sigErr });
      return;
    }
  }
  await applyCustomerSignature(existing, req.body ?? {});
  res.json({ ok: true });
});

// ─── Hợp đồng online v2 — endpoints mới ──────────────────────────────────────

// PUBLIC: khách xem hợp đồng đầy đủ qua token (bản sạch — xem contractPayload.ts).
router.get("/public/contracts/by-token/:token", async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  if (!token) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  const [row] = await db
    .select({ id: contractsTable.id })
    .from(contractsTable)
    .where(eq(contractsTable.publicToken, token));
  if (!row) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  const payload = await buildContractPayload(row.id, "public");
  if (!payload) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  res.json(payload);
});

// PUBLIC: khách ký Bên B qua token. Khách ký 1 LẦN — đã ký rồi chỉ ký lại được
// khi admin chủ động bật "Yêu cầu khách ký lại" (resign_requested_at).
router.post("/public/contracts/by-token/:token/sign", async (req, res): Promise<void> => {
  const token = String(req.params.token ?? "");
  const [existing] = await db
    .select()
    .from(contractsTable)
    .where(eq(contractsTable.publicToken, token));
  if (!existing) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }

  const { signerName, signerPhone, signatureData } = req.body ?? {};
  const name = typeof signerName === "string" ? signerName.trim() : "";
  const phone = typeof signerPhone === "string" ? signerPhone.trim() : "";
  if (!name || name.length > 120) {
    res.status(400).json({ error: "Vui lòng nhập họ tên người ký" });
    return;
  }
  if (!phone || phone.length > 20) {
    res.status(400).json({ error: "Vui lòng nhập số điện thoại" });
    return;
  }
  const sigErr = validateSignatureData(signatureData);
  if (sigErr) {
    res.status(400).json({ error: sigErr });
    return;
  }

  const alreadySigned = existing.status === "signed" || existing.signatureImageUrl;
  if (alreadySigned && existing.resignRequestedAt == null) {
    res.status(409).json({ error: "Hợp đồng đã được ký" });
    return;
  }

  await applyCustomerSignature(existing, {
    customerName: name,
    customerPhone: phone,
    signatureData,
    signedAt: new Date().toISOString(),
  });
  res.json({ ok: true, signedAt: new Date().toISOString() });
});

// STAFF: ký Bên A (đại diện studio).
router.post("/contracts/:id/sign-studio", async (req, res): Promise<void> => {
  const staffId = verifyToken(req.headers.authorization);
  if (!staffId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = parseInt(req.params.id);
  const [existing] = await db
    .select({ id: contractsTable.id })
    .from(contractsTable)
    .where(eq(contractsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  const { signatureData } = req.body ?? {};
  const sigErr = validateSignatureData(signatureData);
  if (sigErr) {
    res.status(400).json({ error: sigErr });
    return;
  }
  const now = new Date();
  await db
    .update(contractsTable)
    .set({
      studioSignatureImageUrl: signatureData,
      studioSignedAt: now,
      studioSignedById: staffId,
    })
    .where(eq(contractsTable.id, id));
  await logContractChanges(id, [{ field: "studio_signature", newValue: "Bên A đã ký" }], staffId);
  res.json({ ok: true, studioSignedAt: now.toISOString() });
});

// STAFF: bật/tắt yêu cầu khách ký lại (KHÔNG bao giờ tự động — chỉ admin chủ động).
router.post("/contracts/:id/request-resign", async (req, res): Promise<void> => {
  const staffId = verifyToken(req.headers.authorization);
  if (!staffId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = parseInt(req.params.id);
  const [existing] = await db
    .select({ id: contractsTable.id, resignRequestedAt: contractsTable.resignRequestedAt })
    .from(contractsTable)
    .where(eq(contractsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  const enable = req.body?.enable !== false;
  await db
    .update(contractsTable)
    .set({ resignRequestedAt: enable ? new Date() : null })
    .where(eq(contractsTable.id, id));
  await logContractChanges(
    id,
    [{ field: "resign_requested", oldValue: existing.resignRequestedAt ? "bật" : "tắt", newValue: enable ? "bật" : "tắt" }],
    staffId,
  );
  res.json({ ok: true, resignRequested: enable });
});

// STAFF: payload đầy đủ cho trang hợp đồng nội bộ.
router.get("/contracts/:id/document", async (req, res): Promise<void> => {
  if (!verifyToken(req.headers.authorization)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = parseInt(req.params.id);
  const payload = await buildContractPayload(id, "internal");
  if (!payload) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  res.json(payload);
});

// STAFF: lịch sử chỉnh sửa NỘI BỘ (không bao giờ trả qua public API).
router.get("/contracts/:id/change-log", async (req, res): Promise<void> => {
  if (!verifyToken(req.headers.authorization)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = parseInt(req.params.id);
  const rows = await db
    .select({
      id: contractChangeLogTable.id,
      fieldChanged: contractChangeLogTable.fieldChanged,
      oldValue: contractChangeLogTable.oldValue,
      newValue: contractChangeLogTable.newValue,
      reason: contractChangeLogTable.reason,
      changedByName: staffTable.name,
      createdAt: contractChangeLogTable.createdAt,
    })
    .from(contractChangeLogTable)
    .leftJoin(staffTable, eq(contractChangeLogTable.changedById, staffTable.id))
    .where(eq(contractChangeLogTable.contractId, id))
    .orderBy(desc(contractChangeLogTable.createdAt));
  res.json(rows);
});

// STAFF: tìm-hoặc-tạo hợp đồng cho 1 booking (server-side, tránh tạo trùng khi
// bấm nhanh nhiều lần — chuyển từ logic cũ trong calendar.tsx handleViewInvoice).
router.post("/contracts/find-or-create", async (req, res): Promise<void> => {
  if (!verifyToken(req.headers.authorization)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const bookingId = parseInt(String(req.body?.bookingId ?? ""));
  if (!Number.isFinite(bookingId)) {
    res.status(400).json({ error: "Thiếu bookingId" });
    return;
  }
  const [booking] = await db
    .select({
      id: bookingsTable.id,
      customerId: bookingsTable.customerId,
      packageType: bookingsTable.packageType,
      serviceCategory: bookingsTable.serviceCategory,
      totalAmount: bookingsTable.totalAmount,
      parentId: bookingsTable.parentId,
    })
    .from(bookingsTable)
    .where(eq(bookingsTable.id, bookingId));
  if (!booking) {
    res.status(404).json({ error: "Không tìm thấy đơn hàng" });
    return;
  }

  // Hợp đồng gắn theo TỪNG đơn (contracts.booking_id): chỉ tìm theo bookingId — đơn hiện tại,
  // rồi tới đơn CHA nếu là đơn gộp. TUYỆT ĐỐI không fallback sang hợp đồng gần nhất của cùng
  // khách (bug P0: đơn mới của khách cũ mở nhầm hợp đồng cũ đã ký). Xem lib/contract-resolve.ts.
  const candidateBookingIds = contractCandidateBookingIds(bookingId, booking.parentId);
  const existingRows = await db
    .select({ id: contractsTable.id, bookingId: contractsTable.bookingId })
    .from(contractsTable)
    .where(inArray(contractsTable.bookingId, candidateBookingIds))
    .orderBy(desc(contractsTable.createdAt));
  const existingId = pickContractIdForBooking(
    candidateBookingIds,
    newestContractIdByBooking(existingRows),
  );
  if (existingId != null) {
    // Self-heal: đơn đã ĐỔI KHÁCH sau khi tạo hợp đồng → hợp đồng CHƯA KÝ đi theo
    // khách hiện tại của đơn. Đã ký thì giữ nguyên (bản pháp lý).
    if (booking.customerId) {
      await db
        .update(contractsTable)
        .set({ customerId: booking.customerId })
        .where(
          and(
            eq(contractsTable.id, existingId),
            ne(contractsTable.status, "signed"),
            ne(contractsTable.customerId, booking.customerId),
          ),
        )
        .catch(() => null);
    }
    res.json({ id: existingId, created: false });
    return;
  }

  // Chưa có hợp đồng cho đơn này ⇒ TẠO MỚI, gắn đúng bookingId hiện tại.
  if (!booking.customerId) {
    res.status(400).json({ error: "Show này chưa có khách hàng để tạo hóa đơn" });
    return;
  }
  const count = await db.select({ id: contractsTable.id }).from(contractsTable);
  const contractCode = `HD${String(count.length + 1).padStart(4, "0")}`;
  const [created] = await db
    .insert(contractsTable)
    .values({
      contractCode,
      bookingId,
      customerId: booking.customerId,
      title: booking.packageType || booking.serviceCategory || "Dịch vụ chụp ảnh",
      content: "",
      status: "active",
      totalValue: booking.totalAmount ?? "0",
    })
    .returning({ id: contractsTable.id });
  res.status(201).json({ id: created.id, created: true });
});

router.get(
  "/customers/:customerId/contracts",
  async (req, res): Promise<void> => {
    const customerId = parseInt(req.params.customerId);
    const [customer] = await db
      .select()
      .from(customersTable)
      .where(eq(customersTable.id, customerId));
    if (!customer) {
      res.status(404).json({ error: "Không tìm thấy khách hàng" });
      return;
    }

    const rows = await db
      .select({
        id: contractsTable.id,
        contractCode: contractsTable.contractCode,
        bookingId: contractsTable.bookingId,
        customerId: contractsTable.customerId,
        customerName: customersTable.name,
        customerPhone: customersTable.phone,
        title: contractsTable.title,
        totalValue: contractsTable.totalValue,
        status: contractsTable.status,
        signedAt: contractsTable.signedAt,
        expiresAt: contractsTable.expiresAt,
        notes: contractsTable.notes,
        createdAt: contractsTable.createdAt,
      })
      .from(contractsTable)
      .innerJoin(
        customersTable,
        eq(contractsTable.customerId, customersTable.id),
      )
      .where(eq(contractsTable.customerId, customerId))
      .orderBy(desc(contractsTable.createdAt));

    // Chưa ký → tổng tiền/khách live theo booking (mirror GET /contracts).
    res.json(await overlayLiveContractRows(rows));
  },
);

router.put("/contracts/:id/sync", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const {
    customerName,
    customerPhone,
    title,
    totalValue,
    status,
    signedAt,
    expiresAt,
    notes,
    content,
  } = req.body ?? {};

  const [existing] = await db
    .select()
    .from(contractsTable)
    .where(eq(contractsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }

  const update: Record<string, unknown> = {};
  if (title !== undefined) update.title = title;
  if (totalValue !== undefined) update.totalValue = String(totalValue);
  if (status !== undefined) update.status = status;
  if (signedAt !== undefined) update.signedAt = signedAt;
  if (expiresAt !== undefined) update.expiresAt = expiresAt;
  if (notes !== undefined) update.notes = notes;
  if (content !== undefined) update.content = content;

  await db.update(contractsTable).set(update).where(eq(contractsTable.id, id));

  // Lịch sử chỉnh sửa NỘI BỘ (sync đồng thời sửa cả booking package/total).
  {
    const changedById = verifyToken(req.headers.authorization);
    const diffs: { field: string; oldValue?: unknown; newValue?: unknown }[] = [];
    for (const [field, newVal] of Object.entries(update)) {
      const oldVal = (existing as Record<string, unknown>)[field];
      if (String(oldVal ?? "") !== String(newVal ?? "")) {
        diffs.push({ field, oldValue: oldVal, newValue: newVal });
      }
    }
    await logContractChanges(id, diffs, changedById);
  }

  if (
    existing.customerId &&
    (customerName !== undefined || customerPhone !== undefined)
  ) {
    const customerUpdate: Record<string, unknown> = {};
    if (customerName !== undefined) customerUpdate.name = customerName;
    if (customerPhone !== undefined) customerUpdate.phone = customerPhone;
    if (Object.keys(customerUpdate).length) {
      await db
        .update(customersTable)
        .set(customerUpdate)
        .where(eq(customersTable.id, existing.customerId));
    }
  }

  if (existing.bookingId && (title !== undefined || totalValue !== undefined)) {
    const bookingUpdate: Record<string, unknown> = {};
    if (title !== undefined) bookingUpdate.package_type = title;
    if (totalValue !== undefined)
      bookingUpdate.total_amount = String(totalValue);
    if (Object.keys(bookingUpdate).length) {
      await db
        .update(bookingsTable)
        .set(bookingUpdate)
        .where(eq(bookingsTable.id, existing.bookingId));
    }
  }

  res.json({ ok: true });
});

router.get("/contracts/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [row] = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      bookingId: contractsTable.bookingId,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      content: contractsTable.content,
      totalValue: contractsTable.totalValue,
      status: contractsTable.status,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      fileUrl: contractsTable.fileUrl,
      notes: contractsTable.notes,
      signatureImageUrl: contractsTable.signatureImageUrl,
      signerName: contractsTable.signerName,
      signerPhone: contractsTable.signerPhone,
      createdAt: contractsTable.createdAt,
      bookingDeductions: bookingsTable.deductions,
      bookingSurcharges: bookingsTable.surcharges,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .leftJoin(bookingsTable, eq(contractsTable.bookingId, bookingsTable.id))
    .where(eq(contractsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  res.json(row);
});

router.put("/contracts/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const { title, content, status, signedAt, expiresAt, totalValue, notes } =
    req.body;
  const [existing] = await db
    .select()
    .from(contractsTable)
    .where(eq(contractsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Không tìm thấy hợp đồng" });
    return;
  }
  const update: Record<string, unknown> = {};
  if (title !== undefined) update.title = title;
  if (content !== undefined) update.content = content;
  if (status !== undefined) update.status = status;
  if (signedAt !== undefined) update.signedAt = signedAt;
  if (expiresAt !== undefined) update.expiresAt = expiresAt;
  if (totalValue !== undefined) update.totalValue = String(totalValue);
  if (notes !== undefined) update.notes = notes;
  const [contract] = await db
    .update(contractsTable)
    .set(update)
    .where(eq(contractsTable.id, id))
    .returning();

  // Lịch sử chỉnh sửa NỘI BỘ — caller không đăng nhập thì ghi với người sửa null.
  const changedById = verifyToken(req.headers.authorization);
  const diffs: { field: string; oldValue?: unknown; newValue?: unknown }[] = [];
  for (const [field, newVal] of Object.entries(update)) {
    const oldVal = (existing as Record<string, unknown>)[field];
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      diffs.push({ field, oldValue: oldVal, newValue: newVal });
    }
  }
  await logContractChanges(id, diffs, changedById);

  res.json(contract);
});

router.delete("/contracts/:id", async (req, res) => {
  // XOÁ CỨNG hợp đồng (không có thùng rác) mà trước đây KHÔNG cần đăng nhập.
  // Chặn trước khi chạm DB; giữ nguyên mức quyền cũ của màn Hợp đồng (staff/admin
  // đều xoá được như trước) để không đổi quy trình đang chạy.
  if (!(await getCallerRole(req.headers.authorization))) {
    res.status(401).json({ error: "Chưa đăng nhập hoặc phiên hết hạn" });
    return;
  }
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "id không hợp lệ" }); return; }
  await db.delete(contractsTable).where(eq(contractsTable.id, id));
  res.status(204).send();
});

export default router;
