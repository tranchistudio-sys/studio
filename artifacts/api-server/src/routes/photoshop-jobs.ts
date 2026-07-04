import { Router } from "express";
import { db, pool } from "@workspace/db";
import { photoshopJobsTable, bookingsTable, bookingItemsTable, paymentsTable, staffJobEarningsTable, staffRatePricesTable, staffTable, staffCastRatesTable } from "@workspace/db/schema";
import { eq, desc, inArray, and, sql } from "drizzle-orm";
import { verifyToken, getCallerRole } from "./auth";
import { emitNotification } from "./notifications";
import { BOOKING_REQUIRES_POST_PRODUCTION_SQL, bookingRequiresPostProduction } from "../lib/post-production-eligibility";


function pkgRequiresPostProductionFlag(v: unknown): boolean {
  if (v === false || v === 0 || v === "0") return false;
  if (v === true || v === 1 || v === "1") return true;
  return false;
}

const router = Router();

// ── Date / service helpers ────────────────────────────────────────────────────
// Normalize Vietnamese text: remove diacritics → lowercase (e.g. "Ngoại Cảnh" → "ngoai canh")
export function normalizeViet(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

// Returns days-to-add for deadline based on service name (with/without diacritics)
export function daysForService(serviceName: string | null | undefined): number {
  const n = normalizeViet(serviceName ?? "");
  return (n.includes("album") || n.includes("ngoai canh")) ? 15 : 10;
}

// Safe date add: parses YYYY-MM-DD as LOCAL date to avoid UTC drift, returns YYYY-MM-DD
export function addDaysToStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// ── Helper: tính deadline_system từ shoot_date + tên dịch vụ ─────────────────
// received_file_date is informational only — does NOT affect deadline_system
export function calcSystemDeadline(shootDate: string | null | undefined, serviceName: string | null | undefined): string | null {
  if (!shootDate || shootDate === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shootDate)) return null;
  return addDaysToStr(shootDate, daysForService(serviceName));
}

// Task #383 Bước 2: tính deadline ưu tiên theo cấu hình gói dịch vụ
// (service_packages.default_editing_days). Nếu gói chưa cấu hình thì fallback
// sang logic cũ theo tên dịch vụ để booking cũ không bị ảnh hưởng.
export function calcSystemDeadlineWithPackage(
  shootDate: string | null | undefined,
  serviceName: string | null | undefined,
  defaultEditingDays: number | null | undefined,
): string | null {
  if (!shootDate || shootDate === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shootDate)) return null;
  if (defaultEditingDays != null && Number.isFinite(defaultEditingDays) && defaultEditingDays >= 0) {
    return addDaysToStr(shootDate, Math.floor(defaultEditingDays));
  }
  return addDaysToStr(shootDate, daysForService(serviceName));
}

// ── Helper: tính deadlineCode từ deadline_system và customer_deadline ─────────

function shootYearMonth(val: unknown): string {
  if (val == null || val === "") return "";
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return `${val.getUTCFullYear()}-${String(val.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const s = String(val);
  const m = s.match(/^(\d{4}-\d{2})/);
  return m ? m[1] : s.slice(0, 7);
}

async function bookingOrderCode(bookingId: number | null | undefined): Promise<string> {
  if (!bookingId) return "";
  try {
    const r = await pool.query(`SELECT order_code FROM bookings WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [bookingId]);
    return String(r.rows[0]?.order_code ?? "").trim();
  } catch {
    return "";
  }
}

function notifTitle(orderCode: string, action: string, customerName: string): string {
  const customer = String(customerName ?? "").trim() || "Khách";
  return orderCode ? `${orderCode} · ${action} · ${customer}` : `${action} · ${customer}`;
}

const DONE_STATUSES = ["xong_show", "hoan_thanh"]; // hoan_thanh kept for BC
const IN_PROGRESS_STATUSES = ["dang_pts", "da_pts", "da_fix", "da_gui_in", "dang_xu_ly", "cho_duyet"];

// effectiveDeadline: customer_deadline wins when set (agreed date); falls back to deadline_system.
function calcDeadlineCode(
  status: string | null,
  deadlineSystem: string | null | undefined,
  customerDeadline: string | null | undefined,
  today: string
): "fire" | "red" | "yellow" | "green" | "done" | "paused" {
  if (status && DONE_STATUSES.includes(status)) return "done";
  if (status === "tam_hoan") return "paused";
  const effectiveDl = (customerDeadline && customerDeadline !== "") ? customerDeadline
    : (deadlineSystem || null);
  if (!effectiveDl) return "green";
  if (effectiveDl < today) return "fire";
  const daysToEffective = Math.ceil((new Date(effectiveDl).getTime() - new Date(today).getTime()) / 86400000);
  if (daysToEffective <= 2) return "yellow";
  return "green";
}

function deadlineCodePriority(code: string): number {
  return ({ fire: 10, red: 20, yellow: 30, green: 50, paused: 80, done: 99 } as Record<string, number>)[code] ?? 50;
}

// ── Helper: deactivate ALL extra_retouched items for a booking ───────────────
async function clearExtraRetouchedItem(bookingId: number) {
  await db
    .update(bookingItemsTable)
    .set({ qty: 0, totalPrice: "0", isActive: 0 })
    .where(and(eq(bookingItemsTable.bookingId, bookingId), eq(bookingItemsTable.type, "extra_retouched")));
}

// ── Helper: sync extra_retouched booking_item after job update ────────────────
// extra = max(0, donePhotos - includedSnapshot)
// Keeps canonical row (highest id), deactivates duplicates, inserts when none exists
async function syncExtraRetouchedItem(bookingId: number, donePhotos: number, extraRetouchPrice?: number) {
  const [booking] = await db
    .select({ snap: bookingsTable.includedRetouchedPhotosSnapshot })
    .from(bookingsTable)
    .where(eq(bookingsTable.id, bookingId));
  if (!booking) return;

  const included = booking.snap ?? 0;
  const extra = Math.max(0, donePhotos - included);

  // Fetch all existing extra_retouched items for this booking (sorted so canonical is first)
  const allExisting = await db
    .select()
    .from(bookingItemsTable)
    .where(and(eq(bookingItemsTable.bookingId, bookingId), eq(bookingItemsTable.type, "extra_retouched")));

  if (extra > 0) {
    // Use the first row as canonical; deactivate any duplicates
    const [canonical, ...duplicates] = allExisting;
    if (duplicates.length > 0) {
      for (const dup of duplicates) {
        await db.update(bookingItemsTable).set({ qty: 0, totalPrice: "0", isActive: 0 }).where(eq(bookingItemsTable.id, dup.id));
      }
    }
    if (canonical) {
      const unitPrice = extraRetouchPrice !== undefined
        ? extraRetouchPrice
        : (parseFloat(String(canonical.unitPrice)) || 0);
      await db
        .update(bookingItemsTable)
        .set({ qty: extra, unitPrice: String(unitPrice), totalPrice: String(unitPrice * extra), isActive: 1 })
        .where(eq(bookingItemsTable.id, canonical.id));
    } else {
      const unitPrice = extraRetouchPrice ?? 0;
      await db.insert(bookingItemsTable).values({
        bookingId,
        type: "extra_retouched",
        title: "Ảnh hậu kỳ vượt gói",
        qty: extra,
        unitPrice: String(unitPrice),
        totalPrice: String(unitPrice * extra),
        isActive: 1,
        notes: `Vượt ${included} ảnh bao gồm`,
      });
    }
  } else {
    // No extra — deactivate ALL existing items for this booking
    await clearExtraRetouchedItem(bookingId);
  }
}

// ── Helper: sync incident booking_item after job update ──────────────────────
// Keeps canonical row (highest id), deactivates duplicates, inserts when none exists
// If chiPhiPhatSinh = 0, deactivates all incident rows for this booking
async function syncIncidentItem(bookingId: number, chiPhiPhatSinh: number, moTa?: string) {
  const allExisting = await db
    .select()
    .from(bookingItemsTable)
    .where(and(eq(bookingItemsTable.bookingId, bookingId), eq(bookingItemsTable.type, "incident")));

  if (chiPhiPhatSinh > 0) {
    const [canonical, ...duplicates] = allExisting;
    for (const dup of duplicates) {
      await db.update(bookingItemsTable).set({ qty: 0, totalPrice: "0", isActive: 0 }).where(eq(bookingItemsTable.id, dup.id));
    }
    if (canonical) {
      await db.update(bookingItemsTable)
        .set({ qty: 1, unitPrice: String(chiPhiPhatSinh), totalPrice: String(chiPhiPhatSinh), isActive: 1, notes: moTa || null })
        .where(eq(bookingItemsTable.id, canonical.id));
    } else {
      await db.insert(bookingItemsTable).values({
        bookingId,
        type: "incident",
        title: moTa || "Chi phí phát sinh hậu kỳ",
        qty: 1,
        unitPrice: String(chiPhiPhatSinh),
        totalPrice: String(chiPhiPhatSinh),
        isActive: 1,
        notes: moTa || null,
      });
    }
  } else {
    for (const item of allExisting) {
      await db.update(bookingItemsTable).set({ qty: 0, totalPrice: "0", isActive: 0 }).where(eq(bookingItemsTable.id, item.id));
    }
  }
}

// ── Task #476: Sync earning lương Photoshop từ photoshop_jobs ────────────────
// QUY ĐỊNH STUDIO: Ai bấm "Xong show" + nhập số ảnh → tiền PTS tính cho NGƯỜI ĐÓ
// (completed_by = tài khoản đang đăng nhập lúc chốt). Không tính theo người được giao
// job nếu người khác bấm chốt.
// Nguồn DUY NHẤT của earning Photoshop. Idempotent: gọi nhiều lần OK.
// - Job xong_show/hoan_thanh + completed_by + booking_id + (detail+party count)>0
//   → upsert 1 row staff_job_earnings (role=photoshop, status=pending).
// - Job rời trạng thái done → void earning (status='voided'), KHÔNG xoá.
// Dedup theo notes prefix `photoshop_job:{id}`.
const PHOTOSHOP_JOB_NOTE_PREFIX = "photoshop_job:";
const fmtVND = (v: number) => new Intl.NumberFormat("vi-VN").format(Math.round(v));

// Task #493: Shared SQL fragment — derive effective package_id của booking giống
// như `getPackageInfoForBooking` (TS): ưu tiên b.service_package_id, fallback
// items[].packageId / items[].servicePackageId / items[].serviceKey='pkg-<id>'.
// Yêu cầu alias bảng bookings là `b`. Trả về row `ep(package_id)`.
const EFFECTIVE_PKG_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      b.service_package_id,
      (
        SELECT CASE
          WHEN jsonb_typeof(elem->'packageId') = 'number'                                        THEN (elem->>'packageId')::int
          WHEN jsonb_typeof(elem->'packageId') = 'string' AND (elem->>'packageId') ~ '^[0-9]+$'  THEN (elem->>'packageId')::int
          WHEN jsonb_typeof(elem->'servicePackageId') = 'number'                                 THEN (elem->>'servicePackageId')::int
          WHEN jsonb_typeof(elem->'servicePackageId') = 'string'
               AND (elem->>'servicePackageId') ~ '^[0-9]+$'                                     THEN (elem->>'servicePackageId')::int
          WHEN (elem->>'serviceKey') ~ '^pkg-[0-9]+$'                                            THEN substring(elem->>'serviceKey' FROM 5)::int
          ELSE NULL
        END
        FROM jsonb_array_elements(COALESCE(b.items, '[]'::jsonb)) elem
        WHERE jsonb_typeof(elem->'packageId') IN ('number','string')
           OR jsonb_typeof(elem->'servicePackageId') IN ('number','string')
           OR (elem->>'serviceKey') ~ '^pkg-[0-9]+$'
        LIMIT 1
      )
    ) AS package_id
  ) ep ON TRUE
`;

// Task #493: lookup packageId + group_id từ booking để resolve đơn giá hậu kỳ.
// Priority: bookings.service_package_id → items[].packageId / items[].servicePackageId
// → items[].serviceKey "pkg-{id}".
async function getPackageInfoForBooking(
  bookingId: number
): Promise<{ packageId: number | null; isPartyGroup: boolean }> {
  const r = await pool.query(
    `SELECT b.service_package_id, b.items, sp.group_id
       FROM bookings b
       LEFT JOIN service_packages sp ON sp.id = b.service_package_id
      WHERE b.id = $1
      LIMIT 1`,
    [bookingId],
  );
  if (r.rows.length === 0) return { packageId: null, isPartyGroup: false };
  const row = r.rows[0] as { service_package_id: number | null; items: unknown; group_id: number | null };
  let packageId: number | null = row.service_package_id ?? null;
  let groupId: number | null = row.group_id ?? null;
  if (!packageId && row.items != null) {
    try {
      const itemsRaw = typeof row.items === "string" ? JSON.parse(row.items) : row.items;
      const items = Array.isArray(itemsRaw) ? (itemsRaw as Array<Record<string, unknown>>) : null;
      if (items) {
        for (const it of items) {
          if (!it) continue;
          const p = it.packageId ?? it.servicePackageId;
          if (typeof p === "number" && p > 0) { packageId = p; break; }
          if (typeof p === "string") {
            const n = parseInt(p, 10);
            if (!Number.isNaN(n) && n > 0) { packageId = n; break; }
          }
          const key = typeof it.serviceKey === "string" ? it.serviceKey : null;
          if (key && key.startsWith("pkg-")) {
            const n = parseInt(key.slice(4), 10);
            if (!Number.isNaN(n) && n > 0) { packageId = n; break; }
          }
        }
      }
    } catch { /* ignore parse errors */ }
    if (packageId) {
      const gr = await pool.query(`SELECT group_id FROM service_packages WHERE id = $1`, [packageId]);
      groupId = (gr.rows[0]?.group_id as number | null | undefined) ?? null;
    }
  }
  return { packageId, isPartyGroup: groupId === 17 };
}

// Task #493: Photoshop unit rate lookup theo nguyên tắc cast-driven.
// Priority:
//  (1) staff_cast_rates role=photoshop + packageId của booking.
//  (2) staff_rate_prices role=photoshop, taskKey=mac_dinh, rateType=per_photo.
//  (3) Fallback theo group gói: tiệc/phóng sự (group_id=17) → 1.000đ; còn lại → 12.000đ.
// KHÔNG còn dùng job.detail_photos_rate / party_photos_rate làm nguồn.
async function resolvePhotoshopUnitRate(
  staffId: number, packageId: number | null, isPartyGroup: boolean,
): Promise<number> {
  // (1) Per-package cast rate
  if (packageId) {
    const cast = await db.select().from(staffCastRatesTable).where(and(
      eq(staffCastRatesTable.staffId, staffId),
      eq(staffCastRatesTable.role, "photoshop"),
      eq(staffCastRatesTable.packageId, packageId),
    ));
    if (cast.length > 0 && cast[0].amount !== null) {
      const a = parseFloat(cast[0].amount as unknown as string);
      if (!Number.isNaN(a) && a > 0) return a;
    }
  }
  // (2) Per-staff default per_photo rate
  const rows = await db.select().from(staffRatePricesTable).where(and(
    eq(staffRatePricesTable.staffId, staffId),
    eq(staffRatePricesTable.role, "photoshop"),
    eq(staffRatePricesTable.taskKey, "mac_dinh"),
  ));
  if (rows.length > 0 && rows[0].rate !== null && rows[0].rateType === "per_photo") {
    const r = parseFloat(rows[0].rate!);
    if (!Number.isNaN(r) && r > 0) return r;
  }
  // (3) Fallback by package group
  return isPartyGroup ? 1000 : 12000;
}

export async function syncPhotoshopEarning(jobId: number): Promise<void> {
  const [job] = await db.select().from(photoshopJobsTable).where(eq(photoshopJobsTable.id, jobId));
  if (!job) return;

  const isDone = DONE_STATUSES.includes(job.status);
  const noteKey = `${PHOTOSHOP_JOB_NOTE_PREFIX}${job.id}`;

  // Fetch any existing earnings tied to this job.
  // EXACT match (eq) — KHÔNG dùng LIKE để tránh collision giữa
  // photoshop_job:12 và photoshop_job:123.
  const existing = await db.select().from(staffJobEarningsTable)
    .where(eq(staffJobEarningsTable.notes, noteKey));

  if (!isDone) {
    // Void all existing earnings for this job (keep audit trail)
    for (const e of existing) {
      if (e.status !== "voided") {
        await db.update(staffJobEarningsTable)
          .set({ status: "voided" })
          .where(eq(staffJobEarningsTable.id, e.id));
      }
    }
    return;
  }

  // isDone — tiền gắn người bấm Xong show (completed_by). Fallback assigned chỉ cho job cũ.
  const staffId = job.completedBy ?? job.assignedStaffId;
  const detailCount = job.detailPhotosCount ?? 0;
  const partyCount = job.partyPhotosCount ?? 0;
  const count = detailCount + partyCount;
  const bookingId = job.bookingId;

  if (!staffId || !bookingId || count <= 0) {
    // Cannot create earning — void any stale existing to avoid wrong amounts
    for (const e of existing) {
      if (e.status !== "voided") {
        await db.update(staffJobEarningsTable)
          .set({ status: "voided" })
          .where(eq(staffJobEarningsTable.id, e.id));
      }
    }
    if (!bookingId) console.warn(`[photoshop-jobs] sync skip — job ${jobId} thiếu booking_id`);
    return;
  }

  // Verify staff exists (FK guard)
  const [staffRow] = await db.select({ id: staffTable.id }).from(staffTable).where(eq(staffTable.id, staffId));
  if (!staffRow) {
    console.warn(`[photoshop-jobs] sync skip — staff ${staffId} không tồn tại`);
    return;
  }

  const pkgInfo = await getPackageInfoForBooking(bookingId);
  const unitRate = await resolvePhotoshopUnitRate(staffId, pkgInfo.packageId, pkgInfo.isPartyGroup);
  const total = count * unitRate;
  const earnedDate = (job.shootDate && /^\d{4}-\d{2}-\d{2}$/.test(job.shootDate))
    ? job.shootDate
    : (job.completedAt ?? new Date()).toISOString().slice(0, 10);
  const d = new Date(earnedDate);
  const month = d.getUTCMonth() + 1;
  const year = d.getUTCFullYear();
  const serviceName = (detailCount > 0 && partyCount > 0)
    ? `Photoshop · ${job.jobCode} · (${detailCount}+${partyCount}) ảnh × ${fmtVND(unitRate)}đ = ${fmtVND(total)}đ`
    : `Photoshop · ${job.jobCode} · ${count} ảnh × ${fmtVND(unitRate)}đ = ${fmtVND(total)}đ`;
  const serviceKey = `photoshop_job_${job.id}`;

  // Find non-voided existing for THIS job + staff
  const matching = existing.find(e => e.staffId === staffId && e.status !== "voided");

  if (matching) {
    await db.update(staffJobEarningsTable).set({
      rate: String(total),
      serviceKey,
      serviceName,
      earnedDate,
      month,
      year,
      status: "pending",
      notes: noteKey,
      bookingId,
    }).where(eq(staffJobEarningsTable.id, matching.id));
    // Void other existing rows (e.g. completed_by changed → previous staff's earning)
    for (const e of existing) {
      if (e.id !== matching.id && e.status !== "voided") {
        await db.update(staffJobEarningsTable)
          .set({ status: "voided" })
          .where(eq(staffJobEarningsTable.id, e.id));
      }
    }
  } else {
    // Void any stale rows (different staff) before insert
    for (const e of existing) {
      if (e.status !== "voided") {
        await db.update(staffJobEarningsTable)
          .set({ status: "voided" })
          .where(eq(staffJobEarningsTable.id, e.id));
      }
    }
    await db.insert(staffJobEarningsTable).values({
      bookingId,
      staffId,
      role: "photoshop",
      serviceKey,
      serviceName,
      rate: String(total),
      earnedDate,
      month,
      year,
      status: "pending",
      notes: noteKey,
    });
  }
}

// ── NEW: Booking-centric view (MUST be before /:id) ───────────────────────────
router.get("/photoshop-jobs/booking-view", async (req, res) => {
  try {
    const { search, status, staffId, month, shootMonth, bookingId: bookingIdParam } = req.query as Record<string, string>;
    const today = new Date().toISOString().slice(0, 10);

    // Deep-link bypass: when a specific bookingId is requested, include it regardless of date/package filters
    const deepLinkId = bookingIdParam && /^\d+$/.test(bookingIdParam) ? Number(bookingIdParam) : null;

    // Build optional SQL-level shoot_date filter (avoids JS Date object parsing issues)
    const shootMonthFilter = shootMonth || month;
    const useMonthFilter = shootMonthFilter && shootMonthFilter !== "all";
    const queryParams: unknown[] = [];
    // Tháng chọn: đơn chụp trong tháng + nợ HK từ tháng trước (chưa xong show)
    const monthCond = useMonthFilter
      ? (() => {
          queryParams.push(shootMonthFilter);
          const p = `$${queryParams.length}`;
          return `AND (
            TO_CHAR(b.shoot_date, 'YYYY-MM') = ${p}
            OR (
              TO_CHAR(b.shoot_date, 'YYYY-MM') < ${p}
              AND COALESCE(pj.status, 'chua_nhan') NOT IN ('xong_show', 'hoan_thanh')
            )
          )`;
        })()
      : "";

    // When deep-linking, add a bypass param for the specific booking and its children
    let deepLinkBypassCond = "";
    if (deepLinkId != null) {
      queryParams.push(deepLinkId);
      const pIdx = queryParams.length;
      deepLinkBypassCond = `OR b.id = $${pIdx} OR b.parent_id = $${pIdx}`;
    }

    const result = await pool.query(`
      SELECT
        b.id              AS booking_id,
        b.order_code,
        b.shoot_date,
        b.created_at      AS booking_created_at,
        b.package_type,
        b.service_label,
        b.parent_id,
        b.is_parent_contract,
        b.total_amount,
        b.paid_amount,
        (COALESCE(b.total_amount, 0) - COALESCE(b.paid_amount, 0)) AS remaining_amount,
        b.notes                           AS booking_notes,
        b.items                           AS booking_items,
        b.surcharges                      AS booking_surcharges,
        b.assigned_staff                  AS booking_assigned_staff,
        b.included_retouched_photos_snapshot,
        c.id              AS customer_id,
        c.name            AS customer_name,
        c.phone           AS customer_phone,
        c.avatar          AS customer_avatar,
        pj.id             AS job_id,
        pj.job_code,
        pj.status,
        pj.assigned_staff_id,
        pj.assigned_staff_name,
        pj.received_file_date,
        pj.internal_deadline,
        pj.customer_deadline,
        pj.deadline_system,
        pj.total_photos,
        pj.done_photos,
        pj.progress_percent,
        pj.notes,
        pj.photoshop_note,
        pj.extra_retouch_price,
        pj.extra_photos_requested,
        pj.drive_link,
        pj.print_notes,
        pj.da_xuat_in,
        pj.chi_phi_phat_sinh,
        pj.mo_ta_phat_sinh,
        pj.detail_photos_count,
        pj.detail_photos_rate,
        pj.party_photos_count,
        pj.party_photos_rate,
        pj.updated_at     AS job_updated_at,
        sp.name           AS package_name,
        sp.code           AS package_code,
        sp.price          AS package_price,
        sp.print_cost     AS package_print_cost,
        sp.operating_cost AS package_operating_cost,
        sp.description    AS package_description,
        sp.notes          AS package_notes,
        sp.default_editing_days AS package_default_editing_days,
        sp.requires_post_production AS package_requires_post_production,
        sp.requires_printing AS package_requires_printing,
        sp.group_id       AS package_group_id,
        sg.name           AS package_group_name,
        (
          SELECT json_agg(pi ORDER BY pi.sort_order)
          FROM package_items pi
          WHERE pi.package_id = sp.id
        )                 AS package_items_list
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id
      LEFT JOIN photoshop_jobs pj
        ON pj.booking_id = b.id AND pj.is_active = true
      LEFT JOIN service_packages sp ON sp.id = b.service_package_id
      LEFT JOIN service_groups sg ON sg.id = sp.group_id
      WHERE b.status NOT IN ('cancelled','temp_quote')
        AND b.deleted_at IS NULL
        AND COALESCE(b.is_parent_contract, false) = false
        AND (
          (
            b.shoot_date::date <= NOW()::date
            ${monthCond}
            AND (
              (
    b.service_package_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM service_packages sp_req
      WHERE sp_req.id = b.service_package_id AND sp_req.requires_post_production = true
    )
  )
  OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(COALESCE(b.items, '[]'::jsonb)) = 'array'
           THEN b.items ELSE '[]'::jsonb END
    ) AS it
    WHERE
      (
        (it->>'packageId') ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM service_packages spc
          WHERE spc.id = (it->>'packageId')::int AND spc.requires_post_production = true
        )
      )
      OR (
        (it->>'servicePackageId') ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM service_packages spc
          WHERE spc.id = (it->>'servicePackageId')::int AND spc.requires_post_production = true
        )
      )
      OR (
        (it->>'serviceKey') ~ '^pkg-[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM service_packages spc
          WHERE spc.id = REPLACE(it->>'serviceKey', 'pkg-', '')::int
            AND spc.requires_post_production = true
        )
      )
  )
            )
          )
          ${deepLinkBypassCond}
        )
      ORDER BY b.created_at DESC
    `, queryParams);

    let data = result.rows as Record<string, unknown>[];

    const bookingIds = data.map(r => r.booking_id).filter((id): id is number => typeof id === "number");
    const paymentMap: Record<number, Array<{ id: number; amount: number; paidAt: string; paymentType: string; notes: string | null }>> = {};
    const conceptMap: Record<number, string[]> = {};
    if (bookingIds.length > 0) {
      const paymentRows = await pool.query(`
        SELECT id, booking_id, amount, paid_at, payment_type, notes
        FROM payments
        WHERE booking_id = ANY($1::int[])
        ORDER BY paid_at ASC, id ASC
      `, [bookingIds]);
      for (const row of paymentRows.rows as Array<Record<string, unknown>>) {
        const bid = Number(row.booking_id);
        if (!paymentMap[bid]) paymentMap[bid] = [];
        paymentMap[bid].push({
          id: Number(row.id),
          amount: Number(row.amount ?? 0),
          paidAt: String(row.paid_at ?? ""),
          paymentType: String(row.payment_type ?? ""),
          notes: row.notes == null ? null : String(row.notes),
        });
      }
    }

    const parseItems = (raw: unknown) => {
      if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
      if (typeof raw === "string") {
        try { return JSON.parse(raw) as Array<Record<string, unknown>>; } catch { return []; }
      }
      return [];
    };

    for (const row of data) {
      const bid = Number(row.booking_id);
      const items = parseItems(row.booking_items);
      const concepts = items.flatMap(item => {
        const imgs = item.conceptImages;
        return Array.isArray(imgs) ? imgs.filter(Boolean).map(String) : [];
      });
      conceptMap[bid] = concepts;
      row.booking_items = items;
      row.booking_concept_images = concepts;
      row.booking_payments = paymentMap[bid] ?? [];
      row.remaining_amount = Number(row.remaining_amount ?? 0);
      row.paid_amount = Number(row.paid_amount ?? 0);
    }

    // ── Auto-create photoshop_job for bookings whose shoot_date has passed but no job yet ──
    // Idempotent: SELECT-first before INSERT; reload/concurrent requests won't create duplicates
    const noJobRows = data.filter(r => r.job_id == null);
    const isPlaceholderLabel = (s: unknown): boolean => {
      const v = String(s ?? "").trim();
      return !v || /^Dịch vụ\s*\d+\s*$/i.test(v);
    };
    const pickRealItemName = (items: unknown): string => {
      if (!Array.isArray(items)) return "";
      for (const it of items as Array<Record<string, unknown>>) {
        const candidates = [it?.packageName, it?.serviceName, it?.serviceLabel, it?.label, it?.name];
        for (const c of candidates) {
          const v = String(c ?? "").trim();
          if (v && !isPlaceholderLabel(v)) return v;
        }
      }
      return "";
    };
    for (const row of noJobRows) {
      const pkgRequires = pkgRequiresPostProductionFlag(row.package_requires_post_production);
      if (!pkgRequires) {
        const eligible = await bookingRequiresPostProduction({
          servicePackageId: null,
          items: row.booking_items,
        });
        if (!eligible) continue;
      }
      const pkgName = String(row.package_name ?? "").trim();
      const itemName = pickRealItemName(row.booking_items);
      const labelReal = !isPlaceholderLabel(row.service_label) ? String(row.service_label).trim() : "";
      const svcName = pkgName || itemName || labelReal || String(row.package_type ?? "");
      const shootDate = String(row.shoot_date ?? "");
      // Task #383 Bước 2: ưu tiên default_editing_days của gói nếu admin đã cấu
      // hình, nếu không thì fallback theo tên dịch vụ (giữ hành vi cũ 10/15 ngày)
      const pkgDaysRaw = row.package_default_editing_days;
      const pkgDays = pkgDaysRaw == null ? null : Number(pkgDaysRaw);
      const dl = calcSystemDeadlineWithPackage(shootDate, svcName, pkgDays);
      const jobCode = `JOB-${row.booking_id}-${today.replace(/-/g, "")}`;
      // ON CONFLICT relies on the partial unique index (booking_id WHERE is_active=true).
      // If a concurrent request just inserted the same job, DO NOTHING fires and RETURNING
      // yields 0 rows — we then SELECT to get the existing job.
      const snap = Number(row.included_retouched_photos_snapshot ?? 0);
      const ins = await pool.query(`
        INSERT INTO photoshop_jobs
          (job_code, booking_id, customer_name, customer_phone,
           service_name, shoot_date, deadline_system, status,
           progress_percent, total_photos, done_photos, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'chua_nhan',0,$8,0,true)
        ON CONFLICT (booking_id) WHERE is_active = true
        DO NOTHING
        RETURNING id, job_code, deadline_system
      `, [jobCode, row.booking_id, row.customer_name, row.customer_phone,
          svcName, shootDate, dl, snap]);
      if (ins.rows.length > 0) {
        row.job_id = ins.rows[0].id;
        row.job_code = ins.rows[0].job_code;
        row.status = "chua_nhan";
        row.deadline_system = ins.rows[0].deadline_system;
      } else {
        // Conflict — fetch the existing active job's ID
        const existing = await pool.query(
          `SELECT id, job_code, deadline_system FROM photoshop_jobs WHERE booking_id = $1 AND is_active = true LIMIT 1`,
          [row.booking_id]
        );
        if (existing.rows.length > 0) {
          row.job_id = existing.rows[0].id;
          row.job_code = existing.rows[0].job_code;
          row.deadline_system = existing.rows[0].deadline_system;
        }
      }
    }
    // ── Sync old jobs: total_photos = 0 but booking snapshot > 0 ──────────────
    await pool.query(`
      UPDATE photoshop_jobs pj
      SET total_photos = b.included_retouched_photos_snapshot
      FROM bookings b
      WHERE pj.booking_id = b.id
        AND pj.is_active = true
        AND pj.total_photos = 0
        AND b.included_retouched_photos_snapshot > 0
    `);
    // Patch in-memory rows so this response already reflects updated totals
    for (const row of data) {
      const snap = Number(row.included_retouched_photos_snapshot ?? 0);
      if ((row.total_photos == null || Number(row.total_photos) === 0) && snap > 0) {
        row.total_photos = snap;
      }
    }
    // ── End auto-create ────────────────────────────────────────────────────────

    // Add computed fields: deadlineCode, isOverdue (legacy), progressStatus
    data = data.map(r => {
      const st = r.status as string | null;
      const dl = r.internal_deadline as string | null;
      const deadlineSystem = r.deadline_system as string | null | undefined;
      const customerDeadline = r.customer_deadline as string | null | undefined;
      const deadlineCode = calcDeadlineCode(st, deadlineSystem, customerDeadline, today);
      const isOverdue = !!(dl && st && !DONE_STATUSES.includes(st) && dl < today);
      let progressStatus: string;
      if (!r.job_id) progressStatus = "pending";
      else if (st && DONE_STATUSES.includes(st)) progressStatus = "done";
      else if (st === "tam_hoan") progressStatus = "paused";
      else if (deadlineCode === "fire" || deadlineCode === "red" || isOverdue) progressStatus = "overdue";
      else if (st && IN_PROGRESS_STATUSES.includes(st)) progressStatus = "in_progress";
      else progressStatus = "pending";
      return { ...r, deadlineCode, isOverdue, progressStatus };
    });

    // list_section: phân biệt đơn tháng chọn vs nợ từ tháng trước
    if (useMonthFilter) {
      data = data.map(r => {
        const shootYm = shootYearMonth(r.shoot_date);
        const isBacklog = shootYm < shootMonthFilter && !DONE_STATUSES.includes(String(r.status ?? ""));
        return { ...r, list_section: isBacklog ? "backlog" : "month" };
      });
    } else {
      data = data.map(r => ({ ...r, list_section: "all" }));
    }

    const summaryRows = data.filter(r => !DONE_STATUSES.includes(r.status as string));
    const priorBacklog = useMonthFilter
      ? summaryRows.filter(r => r.list_section === "backlog").length
      : 0;
    const summary = {
      myActive: summaryRows.filter(r => IN_PROGRESS_STATUSES.includes(r.status as string)).length,
      myDoneThisMonth: useMonthFilter
        ? data.filter(r => r.status === "xong_show" && shootYearMonth(r.shoot_date) === shootMonthFilter).length
        : data.filter(r => r.status === "xong_show").length,
      backlog: summaryRows.length,
      priorBacklog,
    };

    if (status && status !== "all") {
      if (status === "chua_nhan") {
        data = data.filter(r => !r.job_id || !r.assigned_staff_id || r.status === "chua_nhan");
      } else {
        data = data.filter(r => r.status === status);
      }
    }

    if (staffId) {
      data = data.filter(r => String(r.assigned_staff_id) === staffId);
    }

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(r =>
        String(r.customer_name ?? "").toLowerCase().includes(q) ||
        String(r.customer_phone ?? "").toLowerCase().includes(q) ||
        String(r.shoot_date ?? "").includes(q) ||
        String(r.order_code ?? "").toLowerCase().includes(q)
      );
    }

    res.json({ rows: data, summary });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── NEW: Deep-link resolver — given any booking id (parent or child),
//        return the row(s) for opening DetailModal. Bypasses ALL filters.
router.get("/photoshop-jobs/deep-link", async (req, res) => {
  try {
    const bookingIdParam = String((req.query as Record<string, string>).bookingId ?? "");
    if (!/^\d+$/.test(bookingIdParam)) {
      return res.status(400).json({ error: "bookingId required" });
    }
    const bookingId = Number(bookingIdParam);
    const today = new Date().toISOString().slice(0, 10);

    // Resolve: if it's a parent contract, find all children. Otherwise, use itself.
    const result = await pool.query(`
      SELECT
        b.id              AS booking_id,
        b.order_code,
        b.shoot_date,
        b.created_at      AS booking_created_at,
        b.package_type,
        b.service_label,
        b.parent_id,
        b.is_parent_contract,
        b.total_amount,
        b.paid_amount,
        (COALESCE(b.total_amount, 0) - COALESCE(b.paid_amount, 0)) AS remaining_amount,
        b.notes                           AS booking_notes,
        b.items                           AS booking_items,
        b.surcharges                      AS booking_surcharges,
        b.assigned_staff                  AS booking_assigned_staff,
        b.included_retouched_photos_snapshot,
        c.id              AS customer_id,
        c.name            AS customer_name,
        c.phone           AS customer_phone,
        c.avatar          AS customer_avatar,
        pj.id             AS job_id,
        pj.job_code,
        pj.status,
        pj.assigned_staff_id,
        pj.assigned_staff_name,
        pj.received_file_date,
        pj.internal_deadline,
        pj.customer_deadline,
        pj.deadline_system,
        pj.total_photos,
        pj.done_photos,
        pj.progress_percent,
        pj.notes,
        pj.photoshop_note,
        pj.extra_retouch_price,
        pj.extra_photos_requested,
        pj.drive_link,
        pj.print_notes,
        pj.da_xuat_in,
        pj.chi_phi_phat_sinh,
        pj.mo_ta_phat_sinh,
        pj.detail_photos_count,
        pj.detail_photos_rate,
        pj.party_photos_count,
        pj.party_photos_rate,
        pj.updated_at     AS job_updated_at,
        sp.name           AS package_name,
        sp.code           AS package_code,
        sp.price          AS package_price,
        sp.print_cost     AS package_print_cost,
        sp.operating_cost AS package_operating_cost,
        sp.description    AS package_description,
        sp.notes          AS package_notes,
        sp.default_editing_days AS package_default_editing_days,
        sp.requires_post_production AS package_requires_post_production,
        sp.requires_printing AS package_requires_printing,
        sp.group_id       AS package_group_id,
        sg.name           AS package_group_name,
        (SELECT json_agg(pi ORDER BY pi.sort_order) FROM package_items pi WHERE pi.package_id = sp.id) AS package_items_list
      FROM bookings b
      JOIN customers c ON c.id = b.customer_id
      LEFT JOIN photoshop_jobs pj ON pj.booking_id = b.id AND pj.is_active = true
      LEFT JOIN service_packages sp ON sp.id = b.service_package_id
      LEFT JOIN service_groups sg ON sg.id = sp.group_id
      WHERE b.status NOT IN ('cancelled','temp_quote')
        AND b.deleted_at IS NULL
        AND COALESCE(b.is_parent_contract, false) = false
        AND (b.id = $1 OR b.parent_id = $1)
      ORDER BY b.created_at ASC
    `, [bookingId]);

    let data = result.rows as Record<string, unknown>[];
    if (data.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy đơn hậu kỳ" });
    }

    // Hydrate payments + items (same as booking-view)
    const bookingIds = data.map(r => Number(r.booking_id));
    const paymentMap: Record<number, Array<{ id: number; amount: number; paidAt: string; paymentType: string; notes: string | null }>> = {};
    const paymentRows = await pool.query(
      `SELECT id, booking_id, amount, paid_at, payment_type, notes FROM payments WHERE booking_id = ANY($1::int[]) ORDER BY paid_at ASC, id ASC`,
      [bookingIds]
    );
    for (const row of paymentRows.rows as Array<Record<string, unknown>>) {
      const bid = Number(row.booking_id);
      if (!paymentMap[bid]) paymentMap[bid] = [];
      paymentMap[bid].push({
        id: Number(row.id),
        amount: Number(row.amount ?? 0),
        paidAt: String(row.paid_at ?? ""),
        paymentType: String(row.payment_type ?? ""),
        notes: row.notes == null ? null : String(row.notes),
      });
    }
    const parseItems = (raw: unknown) => {
      if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
      if (typeof raw === "string") { try { return JSON.parse(raw) as Array<Record<string, unknown>>; } catch { return []; } }
      return [];
    };
    for (const row of data) {
      const bid = Number(row.booking_id);
      const items = parseItems(row.booking_items);
      const concepts = items.flatMap(item => {
        const imgs = (item as Record<string, unknown>).conceptImages;
        return Array.isArray(imgs) ? imgs.filter(Boolean).map(String) : [];
      });
      row.booking_items = items;
      row.booking_concept_images = concepts;
      row.booking_payments = paymentMap[bid] ?? [];
      row.remaining_amount = Number(row.remaining_amount ?? 0);
      row.paid_amount = Number(row.paid_amount ?? 0);
    }

    // Pick target row first: prefer row with existing job, else first child by created_at.
    // We ONLY auto-create for this single target — never fan out create on all children.
    const targetRow = data.find(r => r.job_id != null) ?? data[0];

    // Auto-create photoshop_job ONLY for the target row when it has no job yet AND
    // the shoot has happened (avoid materializing jobs for future-dated children).
    const isPlaceholderLabel = (s: unknown): boolean => {
      const v = String(s ?? "").trim();
      return !v || /^Dịch vụ\s*\d+\s*$/i.test(v);
    };
    const pickRealItemName = (items: unknown): string => {
      if (!Array.isArray(items)) return "";
      for (const it of items as Array<Record<string, unknown>>) {
        for (const c of [it?.packageName, it?.serviceName, it?.serviceLabel, it?.label, it?.name]) {
          const v = String(c ?? "").trim();
          if (v && !isPlaceholderLabel(v)) return v;
        }
      }
      return "";
    };
    if (targetRow && targetRow.job_id == null) {
      const shootDateStr = String(targetRow.shoot_date ?? "").slice(0, 10);
      const dlEligible = pkgRequiresPostProductionFlag(targetRow.package_requires_post_production)
        || await bookingRequiresPostProduction({ servicePackageId: null, items: targetRow.booking_items });
      if (shootDateStr && shootDateStr <= today && dlEligible) {
        const pkgName = String(targetRow.package_name ?? "").trim();
        const itemName = pickRealItemName(targetRow.booking_items);
        const labelReal = !isPlaceholderLabel(targetRow.service_label) ? String(targetRow.service_label).trim() : "";
        const svcName = pkgName || itemName || labelReal || String(targetRow.package_type ?? "");
        const pkgDaysRaw = targetRow.package_default_editing_days;
        const pkgDays = pkgDaysRaw == null ? null : Number(pkgDaysRaw);
        const dl = calcSystemDeadlineWithPackage(shootDateStr, svcName, pkgDays);
        const jobCode = `JOB-${targetRow.booking_id}-${today.replace(/-/g, "")}`;
        const snap = Number(targetRow.included_retouched_photos_snapshot ?? 0);
        const ins = await pool.query(`
          INSERT INTO photoshop_jobs
            (job_code, booking_id, customer_name, customer_phone,
             service_name, shoot_date, deadline_system, status,
             progress_percent, total_photos, done_photos, is_active)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'chua_nhan',0,$8,0,true)
          ON CONFLICT (booking_id) WHERE is_active = true DO NOTHING
          RETURNING id, job_code, deadline_system
        `, [jobCode, targetRow.booking_id, targetRow.customer_name, targetRow.customer_phone, svcName, shootDateStr, dl, snap]);
        if (ins.rows.length > 0) {
          targetRow.job_id = ins.rows[0].id;
          targetRow.job_code = ins.rows[0].job_code;
          targetRow.status = "chua_nhan";
          targetRow.deadline_system = ins.rows[0].deadline_system;
        } else {
          const existing = await pool.query(
            `SELECT id, job_code, deadline_system FROM photoshop_jobs WHERE booking_id = $1 AND is_active = true LIMIT 1`,
            [targetRow.booking_id]
          );
          if (existing.rows.length > 0) {
            targetRow.job_id = existing.rows[0].id;
            targetRow.job_code = existing.rows[0].job_code;
            targetRow.deadline_system = existing.rows[0].deadline_system;
          }
        }
      }
    }

    // Add computed fields (same as booking-view)
    data = data.map(r => {
      const st = r.status as string | null;
      const dl = r.internal_deadline as string | null;
      const deadlineSystem = r.deadline_system as string | null | undefined;
      const customerDeadline = r.customer_deadline as string | null | undefined;
      const deadlineCode = calcDeadlineCode(st, deadlineSystem, customerDeadline, today);
      const isOverdue = !!(dl && st && !DONE_STATUSES.includes(st) && dl < today);
      let progressStatus: string;
      if (!r.job_id) progressStatus = "pending";
      else if (st && DONE_STATUSES.includes(st)) progressStatus = "done";
      else if (st === "tam_hoan") progressStatus = "paused";
      else if (deadlineCode === "fire" || deadlineCode === "red" || isOverdue) progressStatus = "overdue";
      else if (st && IN_PROGRESS_STATUSES.includes(st)) progressStatus = "in_progress";
      else progressStatus = "pending";
      return { ...r, deadlineCode, isOverdue, progressStatus };
    });

    // Prefer the row that has a job; else the first child by created_at
    const preferred = data.find(r => r.job_id != null) ?? data[0];
    res.json({ rows: data, preferred });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── NEW: My stats (MUST be before /:id) ───────────────────────────────────────
router.get("/photoshop-jobs/my-stats", async (req, res) => {
  try {
    const callerId = verifyToken(req.headers.authorization);
    if (!callerId) return res.status(401).json({ error: "Chưa đăng nhập" });

    const staffRow = await pool.query(`SELECT role FROM staff WHERE id = $1`, [callerId]);
    const isAdmin = staffRow.rows[0]?.role === "admin";

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Đơn đang làm (dang_pts / da_pts / da_fix / da_gui_in + cũ BC)
    const myActiveQ = isAdmin
      ? await pool.query(`SELECT COUNT(*) FROM photoshop_jobs WHERE status IN ('dang_pts','da_pts','da_fix','da_gui_in','dang_xu_ly','cho_duyet') AND is_active = true`)
      : await pool.query(`SELECT COUNT(*) FROM photoshop_jobs WHERE assigned_staff_id = $1 AND status IN ('dang_pts','da_pts','da_fix','da_gui_in','dang_xu_ly','cho_duyet') AND is_active = true`, [callerId]);

    // Đơn hoàn thành tháng này (xong_show + hoan_thanh BC)
    const myDoneQ = isAdmin
      ? await pool.query(`SELECT COUNT(*) FROM photoshop_jobs WHERE status IN ('xong_show','hoan_thanh') AND updated_at >= $1 AND is_active = true`, [monthStart])
      : await pool.query(`SELECT COUNT(*) FROM photoshop_jobs WHERE assigned_staff_id = $1 AND status IN ('xong_show','hoan_thanh') AND updated_at >= $2 AND is_active = true`, [callerId, monthStart]);

    // Đơn tồn: booking đã qua ngày chụp, chưa xong
    const backlogQ = await pool.query(`
      SELECT COUNT(*) FROM bookings b
      WHERE b.status NOT IN ('cancelled','temp_quote')
        AND b.deleted_at IS NULL
        AND b.shoot_date::date <= NOW()::date
        AND (b.parent_id IS NULL OR b.is_parent_contract = true)
        AND NOT EXISTS (
          SELECT 1 FROM photoshop_jobs pj
          WHERE pj.booking_id = b.id
            AND pj.is_active = true
            AND pj.status IN ('xong_show','hoan_thanh')
        )
    `);

    res.json({
      myActive: parseInt(myActiveQ.rows[0]?.count ?? "0"),
      myDoneThisMonth: parseInt(myDoneQ.rows[0]?.count ?? "0"),
      backlog: parseInt(backlogQ.rows[0]?.count ?? "0"),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Monthly stats: sản lượng hậu kỳ theo nhân viên (admin only) ──────────────
router.get("/photoshop-jobs/monthly-stats", async (req, res) => {
  try {
    const role = await getCallerRole(req.headers.authorization);
    if (!role) return res.status(401).json({ error: "Chưa đăng nhập" });
    if (role !== "admin") return res.status(403).json({ error: "Chỉ admin mới có quyền xem thống kê này" });

    const { month } = req.query as Record<string, string>;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "Thiếu hoặc sai định dạng tham số month (YYYY-MM)" });
    }
    // Task #493: đơn giá lấy từ staff_cast_rates (theo effective package_id của
    // booking — derive cả từ items[]) → staff_rate_prices per_photo → fallback
    // group_id=17 ⇒ 1.000đ, else 12.000đ.
    // Task #493: group theo effective_staff_id = COALESCE(completed_by, assigned_staff_id)
    // — đồng bộ với syncPhotoshopEarning (gắn earning về staff thực sự hoàn thành).
    const result = await pool.query(`
      WITH job_rates AS (
        SELECT
          pj.id,
          COALESCE(pj.completed_by, pj.assigned_staff_id)         AS effective_staff_id,
          COALESCE(cs.name, pj.assigned_staff_name)               AS effective_staff_name,
          COALESCE(pj.detail_photos_count, 0)  AS detail_count,
          COALESCE(pj.party_photos_count, 0)   AS party_count,
          COALESCE(
            scr.amount,
            CASE WHEN srp.rate_type = 'per_photo' THEN srp.rate::numeric ELSE NULL END,
            CASE WHEN sp.group_id = 17 THEN 1000 ELSE 12000 END
          )::numeric AS unit_rate
        FROM photoshop_jobs pj
        LEFT JOIN bookings b ON b.id = pj.booking_id
        LEFT JOIN staff cs ON cs.id = pj.completed_by
        ${EFFECTIVE_PKG_LATERAL}
        LEFT JOIN service_packages sp ON sp.id = ep.package_id
        LEFT JOIN staff_cast_rates scr
          ON scr.staff_id = COALESCE(pj.completed_by, pj.assigned_staff_id)
         AND scr.role = 'photoshop'
         AND scr.package_id = ep.package_id
        LEFT JOIN staff_rate_prices srp
          ON srp.staff_id = COALESCE(pj.completed_by, pj.assigned_staff_id)
         AND srp.role = 'photoshop'
         AND srp.task_key = 'mac_dinh'
        WHERE pj.status IN ('xong_show', 'hoan_thanh')
          AND pj.is_active = true
          AND pj.shoot_date ~ '^\d{4}-\d{2}-\d{2}'
          AND SUBSTRING(pj.shoot_date, 1, 7) = $1
      )
      SELECT
        effective_staff_id                                      AS staff_id,
        effective_staff_name                                    AS staff_name,
        COUNT(*)::int                                           AS job_count,
        SUM(detail_count)::int                                  AS total_detail_photos,
        SUM(party_count)::int                                   AS total_party_photos,
        SUM(detail_count * unit_rate)::bigint                   AS detail_earnings,
        SUM(party_count * unit_rate)::bigint                    AS party_earnings,
        SUM((detail_count + party_count) * unit_rate)::bigint   AS total_earnings
      FROM job_rates
      GROUP BY effective_staff_id, effective_staff_name
      ORDER BY total_earnings DESC NULLS LAST
    `, [month]);
    const rows = result.rows.map(r => ({
      staffId: r.staff_id,
      staffName: r.staff_name || "—",
      jobCount: Number(r.job_count),
      detailPhotos: Number(r.total_detail_photos),
      detailAmount: Number(r.detail_earnings),
      partyPhotos: Number(r.total_party_photos),
      partyAmount: Number(r.party_earnings),
      grandTotal: Number(r.total_earnings),
    }));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Productivity history: multi-month stats per staff (admin only) ────────────
router.get("/photoshop-jobs/productivity-history", async (req, res) => {
  try {
    const role = await getCallerRole(req.headers.authorization);
    if (!role) return res.status(401).json({ error: "Chưa đăng nhập" });
    if (role !== "admin") return res.status(403).json({ error: "Chỉ admin mới có quyền xem thống kê này" });

    const { months } = req.query as Record<string, string>;
    if (!months) return res.status(400).json({ error: "Thiếu tham số months" });

    const monthList = months.split(",").map(m => m.trim()).filter(m => /^\d{4}-\d{2}$/.test(m)).slice(0, 13);
    if (monthList.length === 0) return res.status(400).json({ error: "Không có tháng hợp lệ" });

    // Task #493: cast-driven unit rate dùng effective package_id (derive từ items[]).
    const result = await pool.query(`
      WITH job_rates AS (
        SELECT
          SUBSTRING(pj.shoot_date, 1, 7)                          AS month,
          COALESCE(pj.completed_by, pj.assigned_staff_id)         AS effective_staff_id,
          COALESCE(cs.name, pj.assigned_staff_name)               AS effective_staff_name,
          COALESCE(pj.detail_photos_count, 0)  AS detail_count,
          COALESCE(pj.party_photos_count, 0)   AS party_count,
          COALESCE(
            scr.amount,
            CASE WHEN srp.rate_type = 'per_photo' THEN srp.rate::numeric ELSE NULL END,
            CASE WHEN sp.group_id = 17 THEN 1000 ELSE 12000 END
          )::numeric AS unit_rate
        FROM photoshop_jobs pj
        LEFT JOIN bookings b ON b.id = pj.booking_id
        LEFT JOIN staff cs ON cs.id = pj.completed_by
        ${EFFECTIVE_PKG_LATERAL}
        LEFT JOIN service_packages sp ON sp.id = ep.package_id
        LEFT JOIN staff_cast_rates scr
          ON scr.staff_id = COALESCE(pj.completed_by, pj.assigned_staff_id)
         AND scr.role = 'photoshop'
         AND scr.package_id = ep.package_id
        LEFT JOIN staff_rate_prices srp
          ON srp.staff_id = COALESCE(pj.completed_by, pj.assigned_staff_id)
         AND srp.role = 'photoshop'
         AND srp.task_key = 'mac_dinh'
        WHERE pj.status IN ('xong_show', 'hoan_thanh')
          AND pj.is_active = true
          AND pj.shoot_date ~ '^\\d{4}-\\d{2}-\\d{2}'
          AND SUBSTRING(pj.shoot_date, 1, 7) = ANY($1::text[])
      )
      SELECT
        month,
        effective_staff_id                                      AS staff_id,
        effective_staff_name                                    AS staff_name,
        COUNT(*)::int                                           AS job_count,
        SUM(detail_count)::int                                  AS total_detail_photos,
        SUM(party_count)::int                                   AS total_party_photos,
        SUM(detail_count * unit_rate)::bigint                   AS detail_earnings,
        SUM(party_count * unit_rate)::bigint                    AS party_earnings,
        SUM((detail_count + party_count) * unit_rate)::bigint   AS total_earnings
      FROM job_rates
      GROUP BY month, effective_staff_id, effective_staff_name
      ORDER BY month ASC, total_earnings DESC NULLS LAST
    `, [monthList]);

    const rows = result.rows.map(r => ({
      month: r.month,
      staffId: r.staff_id,
      staffName: r.staff_name || "—",
      jobCount: Number(r.job_count),
      detailPhotos: Number(r.total_detail_photos),
      detailAmount: Number(r.detail_earnings),
      partyPhotos: Number(r.total_party_photos),
      partyAmount: Number(r.party_earnings),
      grandTotal: Number(r.total_earnings),
    }));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Staff-month detail: individual job list for one staff + one month ────────
router.get("/photoshop-jobs/staff-month-detail", async (req, res) => {
  try {
    const role = await getCallerRole(req.headers.authorization);
    if (!role) return res.status(401).json({ error: "Chưa đăng nhập" });
    if (role !== "admin") return res.status(403).json({ error: "Chỉ admin mới có quyền xem thống kê này" });

    const { staffId, month } = req.query as Record<string, string>;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: "Thiếu hoặc sai định dạng tham số month (YYYY-MM)" });
    }

    const params: unknown[] = [month];
    let staffCond = "";
    if (staffId && staffId !== "null" && staffId !== "") {
      const parsedStaffId = parseInt(staffId, 10);
      if (!Number.isFinite(parsedStaffId) || parsedStaffId <= 0) {
        return res.status(400).json({ error: "staffId không hợp lệ" });
      }
      params.push(parsedStaffId);
      // Task #493: filter theo effective staff (completed_by ưu tiên, fallback assigned).
      staffCond = `AND COALESCE(pj.completed_by, pj.assigned_staff_id) = $${params.length}`;
    } else {
      staffCond = "AND COALESCE(pj.completed_by, pj.assigned_staff_id) IS NULL";
    }

    // Task #493: cast-driven unit_rate dùng effective package_id (derive từ items[]).
    const result = await pool.query(`
      SELECT
        pj.id,
        pj.job_code,
        pj.shoot_date,
        COALESCE(pj.customer_name, c.name, '') AS customer_name,
        COALESCE(pj.detail_photos_count, 0)    AS detail_photos_count,
        COALESCE(pj.party_photos_count, 0)     AS party_photos_count,
        COALESCE(
          scr.amount,
          CASE WHEN srp.rate_type = 'per_photo' THEN srp.rate::numeric ELSE NULL END,
          CASE WHEN sp.group_id = 17 THEN 1000 ELSE 12000 END
        )::numeric AS unit_rate,
        (
          (COALESCE(pj.detail_photos_count, 0) + COALESCE(pj.party_photos_count, 0))
          * COALESCE(
              scr.amount,
              CASE WHEN srp.rate_type = 'per_photo' THEN srp.rate::numeric ELSE NULL END,
              CASE WHEN sp.group_id = 17 THEN 1000 ELSE 12000 END
            )::numeric
        ) AS total_earnings
      FROM photoshop_jobs pj
      LEFT JOIN bookings b ON b.id = pj.booking_id
      LEFT JOIN customers c ON c.id = b.customer_id
      ${EFFECTIVE_PKG_LATERAL}
      LEFT JOIN service_packages sp ON sp.id = ep.package_id
      LEFT JOIN staff_cast_rates scr
        ON scr.staff_id = COALESCE(pj.completed_by, pj.assigned_staff_id)
       AND scr.role = 'photoshop'
       AND scr.package_id = ep.package_id
      LEFT JOIN staff_rate_prices srp
        ON srp.staff_id = COALESCE(pj.completed_by, pj.assigned_staff_id)
       AND srp.role = 'photoshop'
       AND srp.task_key = 'mac_dinh'
      WHERE pj.status IN ('xong_show', 'hoan_thanh')
        AND pj.is_active = true
        AND pj.shoot_date ~ '^\\d{4}-\\d{2}-\\d{2}'
        AND SUBSTRING(pj.shoot_date, 1, 7) = $1
        ${staffCond}
      ORDER BY pj.shoot_date ASC, pj.id ASC
    `, params);

    const rows = result.rows.map(r => ({
      id: Number(r.id),
      jobCode: String(r.job_code ?? ""),
      shootDate: String(r.shoot_date ?? ""),
      customerName: String(r.customer_name ?? ""),
      detailPhotos: Number(r.detail_photos_count),
      detailRate: Number(r.unit_rate),
      partyPhotos: Number(r.party_photos_count),
      partyRate: Number(r.unit_rate),
      totalEarnings: Number(r.total_earnings),
    }));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Original list endpoint ────────────────────────────────────────────────────
router.get("/photoshop-jobs", async (req, res) => {
  try {
    const { search, status } = req.query as Record<string, string>;
    let rows = await db.select().from(photoshopJobsTable).orderBy(desc(photoshopJobsTable.createdAt));
    if (status) rows = rows.filter(r => r.status === status);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.jobCode.toLowerCase().includes(q) ||
        r.customerName.toLowerCase().includes(q) ||
        (r.assignedStaffName ?? "").toLowerCase().includes(q)
      );
    }

    // Join includedRetouchedPhotosSnapshot from linked bookings
    const bookingIds = rows.map(r => r.bookingId).filter((id): id is number => id != null);
    let includedMap: Record<number, number> = {};
    let extraFeeMap: Record<number, { qty: number; unitPrice: number; totalPrice: number }> = {};

    if (bookingIds.length > 0) {
      const bRows = await db
        .select({ id: bookingsTable.id, snap: bookingsTable.includedRetouchedPhotosSnapshot })
        .from(bookingsTable)
        .where(inArray(bookingsTable.id, bookingIds));
      includedMap = Object.fromEntries(bRows.map(b => [b.id, b.snap ?? 0]));

      // Fetch extra_retouched booking items for these bookings
      const extraItems = await db
        .select()
        .from(bookingItemsTable)
        .where(and(inArray(bookingItemsTable.bookingId, bookingIds), eq(bookingItemsTable.type, "extra_retouched")));
      for (const item of extraItems) {
        extraFeeMap[item.bookingId] = {
          qty: item.qty,
          unitPrice: parseFloat(String(item.unitPrice)),
          totalPrice: parseFloat(String(item.totalPrice)),
        };
      }
    }

    const result = rows.map(r => {
      const included = r.bookingId != null ? (includedMap[r.bookingId] ?? null) : null;
      const extraCount = included != null
        ? Math.max(0, (r.donePhotos ?? 0) - included)
        : null;
      const extraFee = r.bookingId != null ? (extraFeeMap[r.bookingId] ?? null) : null;
      return {
        ...r,
        includedCount: included,
        extraCount,
        extraFeeUnitPrice: extraFee?.unitPrice ?? 0,
        extraFeeTotal: extraFee?.totalPrice ?? 0,
      };
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Single job by id ──────────────────────────────────────────────────────────
router.get("/photoshop-jobs/:id", async (req, res) => {
  try {
    const rows = await db.select().from(photoshopJobsTable).where(eq(photoshopJobsTable.id, +req.params.id));
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Create job — bookingId REQUIRED ──────────────────────────────────────────
router.post("/photoshop-jobs", async (req, res) => {
  try {
    const {
      jobCode, bookingId, customerName, customerPhone, serviceName,
      assignedStaffId, assignedStaffName, shootDate, receivedFileDate,
      internalDeadline, customerDeadline, status, progressPercent,
      totalPhotos, donePhotos, notes, photoshopNote, extraRetouchPrice,
      extraPhotosRequested,
      driveLink, printNotes, daXuatIn, chiPhiPhatSinh, moTaPhatSinh,
    } = req.body;

    if (!bookingId) {
      return res.status(400).json({ error: "Phải gắn với đơn hàng. bookingId là bắt buộc." });
    }

    // Prevent duplicate active job for the same booking
    const existing = await db
      .select({ id: photoshopJobsTable.id })
      .from(photoshopJobsTable)
      .where(and(eq(photoshopJobsTable.bookingId, Number(bookingId)), eq(photoshopJobsTable.isActive, true)));
    if (existing.length > 0) {
      return res.status(400).json({ error: "Đơn hàng này đã có job hậu kỳ", jobId: existing[0].id });
    }

    // deadline_system is always computed from shoot_date; received_file_date is informational only.
    // Task #383 Bước 2: nếu booking có gắn service_package_id và gói đó có
    // default_editing_days thì ưu tiên dùng, fallback tên dịch vụ.
    let pkgDefaultDays: number | null = null;
    try {
      const r = await pool.query(
        `SELECT sp.default_editing_days AS d
           FROM bookings b
           LEFT JOIN service_packages sp ON sp.id = b.service_package_id
          WHERE b.id = $1
          LIMIT 1`,
        [Number(bookingId)],
      );
      const v = r.rows[0]?.d;
      if (v != null) pkgDefaultDays = Number(v);
    } catch (e) {
      console.error("[photoshop-jobs] lookup default_editing_days failed:", e);
    }
    const autoDeadlineSystem = calcSystemDeadlineWithPackage(shootDate, serviceName, pkgDefaultDays);
    const chiPhiVal = chiPhiPhatSinh != null ? Math.max(0, Math.floor(Number(chiPhiPhatSinh) || 0)) : 0;

    const [row] = await db.insert(photoshopJobsTable).values({
      jobCode: jobCode || `JOB-${Date.now()}`,
      bookingId: Number(bookingId),
      customerName: customerName || "",
      customerPhone: customerPhone || "",
      serviceName: serviceName || "",
      assignedStaffId: assignedStaffId || null,
      assignedStaffName: assignedStaffName || "",
      shootDate: shootDate || "",
      receivedFileDate: receivedFileDate || "",
      internalDeadline: internalDeadline || "",
      customerDeadline: customerDeadline || "",
      deadlineSystem: autoDeadlineSystem,
      status: status || "chua_nhan",
      progressPercent: progressPercent ?? 0,
      totalPhotos: totalPhotos ?? 0,
      donePhotos: donePhotos ?? 0,
      notes: notes || "",
      photoshopNote: photoshopNote || "",
      extraRetouchPrice: extraRetouchPrice ?? 0,
      extraPhotosRequested: (() => { const n = Number(extraPhotosRequested); return extraPhotosRequested != null && !isNaN(n) && n >= 0 ? Math.floor(n) : null; })(),
      driveLink: driveLink || "",
      printNotes: printNotes || "",
      daXuatIn: !!daXuatIn,
      chiPhiPhatSinh: chiPhiVal,
      moTaPhatSinh: moTaPhatSinh || "",
    }).returning();

    if (row.bookingId && row.donePhotos > 0) {
      await syncExtraRetouchedItem(row.bookingId, row.donePhotos, row.extraRetouchPrice ?? undefined).catch(err =>
        console.error("[photoshop-jobs] syncExtraRetouchedItem (POST) failed:", err)
      );
    }

    if (row.bookingId) {
      await syncIncidentItem(row.bookingId, chiPhiVal, row.moTaPhatSinh ?? undefined).catch(err =>
        console.error("[photoshop-jobs] syncIncidentItem (POST) failed:", err)
      );
    }

    // Task #476: sync earning (chỉ chạy nếu job tạo ngay ở trạng thái done)
    await syncPhotoshopEarning(row.id).catch(err =>
      console.error("[photoshop-jobs] syncPhotoshopEarning (POST) failed:", err)
    );

    const oc = await bookingOrderCode(row.bookingId);
    const cust = customerName || row.customerName || "Khách";
    const svc = serviceName || row.serviceName || "";
    if (assignedStaffId) {
      emitNotification({
        staffId: assignedStaffId,
        type: "task_assigned",
        priority: "high",
        title: notifTitle(oc, "Giao hậu kỳ", cust),
        message: `Bạn được giao PTS · ${svc || "Hậu kỳ"}. Mở đơn xử lý.`,
        targetModule: "photoshop-jobs",
        targetId: String(row.id),
        bookingId: row.bookingId ?? undefined,
      });
    }
    emitNotification({
      staffId: null,
      type: "photoshop_new",
      title: notifTitle(oc, "Hậu kỳ mới", cust),
      message: `${svc || "Hậu kỳ"} · Mở Tiến độ Hậu kỳ.`,
      targetModule: "photoshop-jobs",
      targetId: String(row.id),
      bookingId: row.bookingId ?? undefined,
    });
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Update job ────────────────────────────────────────────────────────────────
router.put("/photoshop-jobs/:id", async (req, res) => {
  try {
    // Determine caller role for rate-field protection
    const callerRole = await getCallerRole(req.headers.authorization);
    const callerIsAdmin = callerRole === "admin";

    const {
      jobCode, bookingId, customerName, customerPhone, serviceName,
      assignedStaffId, assignedStaffName, shootDate, receivedFileDate,
      internalDeadline, customerDeadline, status, progressPercent,
      totalPhotos, donePhotos, notes, isActive, photoshopNote, extraRetouchPrice,
      extraPhotosRequested,
      driveLink, printNotes, daXuatIn, chiPhiPhatSinh, moTaPhatSinh,
      detailPhotosCount, detailPhotosRate, partyPhotosCount, partyPhotosRate,
    } = req.body;

    const [oldJob] = await db
      .select({
        bookingId: photoshopJobsTable.bookingId,
        status: photoshopJobsTable.status,
        completedBy: photoshopJobsTable.completedBy,
      })
      .from(photoshopJobsTable)
      .where(eq(photoshopJobsTable.id, +req.params.id));
    const oldBookingId = oldJob?.bookingId ?? null;
    const oldStatus = oldJob?.status ?? null;

    // Task #476: snapshot completedBy/completedAt khi chuyển sang xong_show
    const callerId = verifyToken(req.headers.authorization);
    const wasDone = oldStatus ? DONE_STATUSES.includes(oldStatus) : false;
    const willBeDone = status !== undefined ? DONE_STATUSES.includes(status) : wasDone;

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (jobCode !== undefined) updates.jobCode = jobCode;
    if (bookingId !== undefined) updates.bookingId = bookingId;
    if (customerName !== undefined) updates.customerName = customerName;
    if (customerPhone !== undefined) updates.customerPhone = customerPhone;
    if (serviceName !== undefined) updates.serviceName = serviceName;
    if (assignedStaffId !== undefined) updates.assignedStaffId = assignedStaffId;
    if (assignedStaffName !== undefined) updates.assignedStaffName = assignedStaffName;
    if (shootDate !== undefined) updates.shootDate = shootDate;
    // received_file_date: informational only — does NOT affect deadline_system
    if (receivedFileDate !== undefined) updates.receivedFileDate = receivedFileDate;
    if (internalDeadline !== undefined) updates.internalDeadline = internalDeadline;
    if (customerDeadline !== undefined) updates.customerDeadline = customerDeadline;
    if (status !== undefined) updates.status = status;
    // Quy định: ai bấm Xong show → completed_by = người đó (bắt buộc đăng nhập).
    if (!wasDone && willBeDone) {
      if (!callerId) {
        return res.status(401).json({ error: "Cần đăng nhập để chốt Xong show và tính lương PTS" });
      }
      updates.completedAt = new Date();
      updates.completedBy = callerId;
    }
    if (progressPercent !== undefined) updates.progressPercent = progressPercent;
    if (totalPhotos !== undefined) updates.totalPhotos = totalPhotos;
    if (donePhotos !== undefined) updates.donePhotos = donePhotos;
    if (notes !== undefined) updates.notes = notes;
    if (isActive !== undefined) updates.isActive = isActive;
    if (photoshopNote !== undefined) updates.photoshopNote = photoshopNote;
    if (extraRetouchPrice !== undefined) updates.extraRetouchPrice = extraRetouchPrice;
    if (extraPhotosRequested !== undefined) {
      const n = Number(extraPhotosRequested);
      updates.extraPhotosRequested = extraPhotosRequested != null && !isNaN(n) && n >= 0 ? Math.floor(n) : null;
    }
    if (driveLink !== undefined) updates.driveLink = driveLink;
    if (printNotes !== undefined) updates.printNotes = printNotes;
    if (daXuatIn !== undefined) updates.daXuatIn = !!daXuatIn;
    if (chiPhiPhatSinh !== undefined) updates.chiPhiPhatSinh = Math.max(0, Math.floor(Number(chiPhiPhatSinh) || 0));
    if (moTaPhatSinh !== undefined) updates.moTaPhatSinh = moTaPhatSinh;
    if (detailPhotosCount !== undefined) updates.detailPhotosCount = Math.max(0, Math.floor(Number(detailPhotosCount) || 0));
    if (partyPhotosCount !== undefined) updates.partyPhotosCount = Math.max(0, Math.floor(Number(partyPhotosCount) || 0));
    // Task #493: KHÔNG còn nhận detailPhotosRate / partyPhotosRate từ client.
    // Đơn giá hậu kỳ tính từ Bảng cast (staff_cast_rates) theo packageId của booking.
    // Giữ cột DB cho audit lịch sử nhưng không update nữa.
    void detailPhotosRate; void partyPhotosRate; void callerIsAdmin;

    const [row] = await db
      .update(photoshopJobsTable)
      .set(updates as never)
      .where(eq(photoshopJobsTable.id, +req.params.id))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });

    const newBookingId = row.bookingId ?? null;
    const bookingIdChanged = bookingId !== undefined && oldBookingId !== newBookingId;

    if (bookingIdChanged && oldBookingId != null) {
      await clearExtraRetouchedItem(oldBookingId).catch(err =>
        console.error("[photoshop-jobs] clearExtraRetouchedItem (old booking) failed:", err)
      );
      await syncIncidentItem(oldBookingId, 0).catch(err =>
        console.error("[photoshop-jobs] syncIncidentItem clear (old booking) failed:", err)
      );
    }

    if ((donePhotos !== undefined || extraRetouchPrice !== undefined || bookingIdChanged) && newBookingId) {
      await syncExtraRetouchedItem(newBookingId, row.donePhotos ?? 0, row.extraRetouchPrice ?? undefined).catch(err =>
        console.error("[photoshop-jobs] syncExtraRetouchedItem (PUT) failed:", err)
      );
    }

    if ((chiPhiPhatSinh !== undefined || moTaPhatSinh !== undefined || bookingIdChanged) && newBookingId) {
      await syncIncidentItem(newBookingId, row.chiPhiPhatSinh ?? 0, row.moTaPhatSinh ?? undefined).catch(err =>
        console.error("[photoshop-jobs] syncIncidentItem (PUT) failed:", err)
      );
    }

    // Task #476: sync earning sau update (xử lý cả forward done & revert void)
    await syncPhotoshopEarning(row.id).catch(err =>
      console.error("[photoshop-jobs] syncPhotoshopEarning (PUT) failed:", err)
    );

    if (status && row.status) {
      const oc = await bookingOrderCode(row.bookingId);
      const statusLabel = row.status === "xong_show" ? "Xong show" : row.status;
      emitNotification({
        staffId: row.assignedStaffId ?? null,
        type: "photoshop_updated",
        priority: row.status === "xong_show" ? "normal" : "warning",
        title: notifTitle(oc, "Cập nhật HK", row.customerName || "Khách"),
        message: `Trạng thái: ${statusLabel}. Mở đơn xem chi tiết.`,
        targetModule: "photoshop-jobs",
        targetId: String(row.id),
        bookingId: row.bookingId ?? undefined,
      });
    }
    res.json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Delete job ────────────────────────────────────────────────────────────────
router.delete("/photoshop-jobs/:id", async (req, res) => {
  try {
    const [job] = await db
      .select({ bookingId: photoshopJobsTable.bookingId })
      .from(photoshopJobsTable)
      .where(eq(photoshopJobsTable.id, +req.params.id));
    if (job?.bookingId) {
      await clearExtraRetouchedItem(job.bookingId).catch(err =>
        console.error("[photoshop-jobs] clearExtraRetouchedItem (DELETE) failed:", err)
      );
    }
    await db.delete(photoshopJobsTable).where(eq(photoshopJobsTable.id, +req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

export async function maybeCreatePhotoshopJobForBooking(bookingId: number): Promise<void> {
  const [bk] = await db.select().from(bookingsTable).where(eq(bookingsTable.id, bookingId));
  // Báo giá tạm tính không vào hậu kỳ — chưa phải đơn thật
  if (!bk || bk.isParentContract || bk.status === "temp_quote") return;
  const eligible = await bookingRequiresPostProduction({
    servicePackageId: bk.servicePackageId,
    items: bk.items,
  });
  if (!eligible) return;
  const existing = await db.select({ id: photoshopJobsTable.id })
    .from(photoshopJobsTable)
    .where(and(eq(photoshopJobsTable.bookingId, bookingId), eq(photoshopJobsTable.isActive, true)));
  if (existing.length > 0) return;
  const shootDate = bk.shootDate ? String(bk.shootDate).slice(0, 10) : "";
  const today = new Date().toISOString().slice(0, 10);
  if (!shootDate || shootDate > today) return;
  let pkgDays: number | null = null;
  if (bk.servicePackageId) {
    const pr = await pool.query(`SELECT default_editing_days, name FROM service_packages WHERE id = $1`, [bk.servicePackageId]);
    pkgDays = pr.rows[0]?.default_editing_days != null ? Number(pr.rows[0].default_editing_days) : null;
  }
  const cust = await pool.query(`SELECT name, phone FROM customers WHERE id = $1`, [bk.customerId]);
  const customerName = cust.rows[0]?.name ?? "";
  const customerPhone = cust.rows[0]?.phone ?? "";
  const svcName = String(bk.packageType ?? bk.serviceLabel ?? "").trim() || "Dịch vụ";
  const dl = calcSystemDeadlineWithPackage(shootDate, svcName, pkgDays);
  const snap = bk.includedRetouchedPhotosSnapshot ?? 0;
  const jobCode = `JOB-${bookingId}-${today.replace(/-/g, "")}`;
  await pool.query(`
    INSERT INTO photoshop_jobs
      (job_code, booking_id, customer_name, customer_phone,
       service_name, shoot_date, deadline_system, status,
       progress_percent, total_photos, done_photos, is_active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'chua_nhan',0,$8,0,true)
    ON CONFLICT (booking_id) WHERE is_active = true DO NOTHING
  `, [jobCode, bookingId, customerName, customerPhone, svcName, shootDate, dl, snap]);
}

export default router;
