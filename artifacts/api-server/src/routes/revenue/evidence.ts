/**
 * /api/revenue/v2/evidence — BẰNG CHỨNG SỐ LIỆU cho từng ô trên màn Doanh thu & Lợi nhuận.
 *
 * Nguyên tắc MỘT NGUỒN SỰ THẬT:
 *  - Card đọc số từ computeBucketStats (monthly-core) + engineReceivableForRange.
 *  - Bằng chứng đọc từ ĐÚNG hai nguồn đó: computeBucketStats với EvidenceCollector
 *    (mỗi khoản được cộng vào tổng đồng thời được đẩy ra bảng — khớp by-construction)
 *    + engineReceivableRowsForRange (cùng biểu thức SQL với số tổng).
 *  - Enrichment (tên khách, mã đơn, người thu…) CHỈ phục vụ NHÃN hiển thị, tuyệt đối
 *    không tham gia vào số tiền — enrichment lỗi thì nhãn trống, số vẫn đúng.
 *
 * Response luôn kèm cardTotal (tính lại bằng đúng code path của card) +
 * detailTotal (tổng các dòng bằng chứng) + reconciliationDelta = detail − card.
 * Delta ≠ 0 nghĩa là engine có bug thật — FE hiển thị đỏ, không che.
 */
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { loadAllData } from "./data";
import { generateMonthRange, getBookingDate, getPaymentDate } from "./helpers";
import {
  computeBucketStats,
  deriveMoney,
  bucketRanges,
  type ActivePayment,
  type ValidBooking,
  type ClassifiedExpense,
  type BucketStats,
  type DerivedMoney,
} from "./monthly-core";
import {
  engineReceivableRowsForRange,
  REVENUE_SCOPES,
  type EngineLaborMeta,
  type ReceivableEvidenceRow,
} from "../../lib/finance/financial-engine";

const router: IRouter = Router();

export const EVIDENCE_METRICS = [
  "collected",
  "remaining",
  "cost",
  "realProfit",
  "contractValue",
  "expectedCost",
  "expectedProfit",
] as const;
export type EvidenceMetric = (typeof EVIDENCE_METRICS)[number];

export type EvidenceRow = {
  date: string | null;
  code: string | null;
  name: string | null;
  kind: string | null;
  detail: string | null;
  status: string | null;
  by: string | null;
  amount: number;
  bookingId: number | null;
  paymentId: number | null;
  expenseId: number | null;
};

export type EvidenceGroup = {
  key: string;
  label: string;
  /** +1 = cộng vào tổng, -1 = trừ khỏi tổng (phần Chi của các metric lợi nhuận). */
  sign: 1 | -1;
  rows: EvidenceRow[];
  subtotal: number;
};

const PAYMENT_KIND: Record<string, string> = {
  deposit: "Cọc",
  payment: "Thanh toán",
  final_payment: "Tất toán",
  ad_hoc: "Thu lẻ (không gắn đơn)",
};

const EXPENSE_KIND: Record<string, string> = {
  direct: "CP trực tiếp",
  operating: "CP vận hành",
  depreciation: "Khấu hao",
  interest: "Lãi vay",
};

const vndText = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ`;

// ─── Enrichment (CHỈ nhãn — không bao giờ đụng số tiền) ────────────────────────

type BookingInfo = {
  orderCode: string | null;
  customerName: string | null;
  serviceLabel: string | null;
  shootDate: string | null;
};

async function fetchBookingInfo(ids: number[]): Promise<Map<number, BookingInfo>> {
  const map = new Map<number, BookingInfo>();
  if (ids.length === 0) return map;
  try {
    const r = await pool.query(
      `SELECT b.id, b.order_code, b.service_label, b.shoot_date::text AS shoot_date, c.name AS customer_name
       FROM bookings b
       LEFT JOIN customers c ON c.id = b.customer_id
       WHERE b.id = ANY($1::int[])`,
      [ids],
    );
    for (const row of r.rows as Array<{
      id: number; order_code: string | null; service_label: string | null;
      shoot_date: string | null; customer_name: string | null;
    }>) {
      map.set(Number(row.id), {
        orderCode: row.order_code,
        customerName: row.customer_name,
        serviceLabel: row.service_label,
        shootDate: row.shoot_date,
      });
    }
  } catch {
    // enrichment lỗi → nhãn trống, số tiền không bị ảnh hưởng
  }
  return map;
}

type PaymentInfo = {
  method: string | null;
  collector: string | null;
  payerName: string | null;
  description: string | null;
  status: string | null;
};

async function fetchPaymentInfo(ids: number[]): Promise<Map<number, PaymentInfo>> {
  const map = new Map<number, PaymentInfo>();
  if (ids.length === 0) return map;
  try {
    const r = await pool.query(
      `SELECT p.id, p.payment_method, p.collector_name, p.payer_name, p.description, p.status
       FROM payments p WHERE p.id = ANY($1::int[])`,
      [ids],
    );
    for (const row of r.rows as Array<{
      id: number; payment_method: string | null; collector_name: string | null;
      payer_name: string | null; description: string | null; status: string | null;
    }>) {
      map.set(Number(row.id), {
        method: row.payment_method,
        collector: row.collector_name,
        payerName: row.payer_name,
        description: row.description,
        status: row.status,
      });
    }
  } catch {
    // enrichment lỗi → nhãn trống
  }
  return map;
}

type FixedCostItem = { label: string; amount: number };

async function fetchActiveFixedCosts(): Promise<FixedCostItem[]> {
  try {
    const r = await pool.query(
      `SELECT label, amount FROM fixed_costs WHERE active = true ORDER BY id`,
    );
    return (r.rows as Array<{ label: string; amount: string }>).map(x => ({
      label: x.label,
      amount: Number(x.amount) || 0,
    }));
  } catch {
    return [];
  }
}

// ─── Thu thập bằng chứng qua ĐÚNG vòng lặp bucket của monthly ──────────────────

type RawEvidence = {
  contractBookings: ValidBooking[];
  payments: ActivePayment[];
  castRows: Array<{ bookingId: number; amount: number }>;
  expenses: {
    direct: ClassifiedExpense[];
    operating: ClassifiedExpense[];
    depreciation: ClassifiedExpense[];
    interest: ClassifiedExpense[];
  };
  /** Mỗi bucket tháng trong kỳ — card cộng fixedCostPerMonth cho TỪNG bucket. */
  fixedBuckets: string[];
  /** Tổng cộng dồn TỪNG BUCKET — y hệt totals của /revenue/v2/monthly. */
  totals: BucketStats & DerivedMoney;
  laborMeta: EngineLaborMeta;
};

async function collectRangeEvidence(from: string, to: string): Promise<RawEvidence> {
  const data = await loadAllData();
  const months = generateMonthRange(from.slice(0, 7), to.slice(0, 7));

  const contractBookings: ValidBooking[] = [];
  const payments: ActivePayment[] = [];
  const castRows: Array<{ bookingId: number; amount: number }> = [];
  const expenses: RawEvidence["expenses"] = { direct: [], operating: [], depreciation: [], interest: [] };
  const fixedBuckets: string[] = [];

  const acc: BucketStats = {
    contractValue: 0, collected: 0, staffCast: 0, directExp: 0,
    operatingExp: 0, depreciation: 0, interest: 0, bookingCount: 0,
  };
  const accDerived: DerivedMoney = {
    directCost: 0, grossProfit: 0, operatingProfit: 0, netProfit: 0, totalCost: 0, realProfit: 0,
  };

  for (const { effFrom, effTo } of bucketRanges(months, from, to)) {
    const stats = computeBucketStats(data, effFrom, effTo, {
      contractRow: b => contractBookings.push(b),
      paymentRow: p => payments.push(p),
      castRow: (bookingId, amount) => castRows.push({ bookingId, amount }),
      expenseRow: (e, cls) => expenses[cls].push(e),
      fixedCostBucket: ym => fixedBuckets.push(ym),
    });
    const derived = deriveMoney(stats);
    acc.contractValue += stats.contractValue;
    acc.collected += stats.collected;
    acc.staffCast += stats.staffCast;
    acc.directExp += stats.directExp;
    acc.operatingExp += stats.operatingExp;
    acc.depreciation += stats.depreciation;
    acc.interest += stats.interest;
    acc.bookingCount += stats.bookingCount;
    accDerived.directCost += derived.directCost;
    accDerived.grossProfit += derived.grossProfit;
    accDerived.operatingProfit += derived.operatingProfit;
    accDerived.netProfit += derived.netProfit;
    accDerived.totalCost += derived.totalCost;
    accDerived.realProfit += derived.realProfit;
  }

  return {
    contractBookings, payments, castRows, expenses, fixedBuckets,
    totals: { ...acc, ...accDerived },
    laborMeta: data.laborMeta,
  };
}

// ─── Dựng group bằng chứng cho từng thành phần ─────────────────────────────────

function sum(rows: EvidenceRow[]): number {
  return rows.reduce((s, r) => s + r.amount, 0);
}

function byDate(a: EvidenceRow, b: EvidenceRow): number {
  return (a.date ?? "").localeCompare(b.date ?? "");
}

function paymentGroup(
  payments: ActivePayment[],
  bInfo: Map<number, BookingInfo>,
  pInfo: Map<number, PaymentInfo>,
): EvidenceGroup {
  const rows: EvidenceRow[] = payments.map(p => {
    const info = pInfo.get(p.id);
    const bk = p.bookingId != null ? bInfo.get(p.bookingId) : undefined;
    const isAdHoc = p.paymentType === "ad_hoc" || p.bookingId == null;
    return {
      date: getPaymentDate(p),
      code: bk?.orderCode ?? (p.bookingId != null ? `#${p.bookingId}` : null),
      name: isAdHoc ? (info?.payerName ?? "Thu lẻ") : (bk?.customerName ?? null),
      kind: PAYMENT_KIND[p.paymentType ?? ""] ?? (p.paymentType || "Phiếu thu"),
      detail: info?.description ?? (info?.method ? `Hình thức: ${info.method}` : null),
      status: info?.status ?? p.status ?? "active",
      by: info?.collector ?? null,
      amount: parseFloat(p.amount) || 0,
      bookingId: p.bookingId ?? null,
      paymentId: p.id,
      expenseId: null,
    };
  }).sort(byDate);
  return { key: "payments", label: "Phiếu thu hợp lệ trong kỳ", sign: 1, rows, subtotal: sum(rows) };
}

function contractGroup(bookings: ValidBooking[], bInfo: Map<number, BookingInfo>): EvidenceGroup {
  const rows: EvidenceRow[] = bookings.map(b => {
    const bk = bInfo.get(b.id);
    const gross = Math.max(0, parseFloat(String(b.totalAmount)) || 0);
    const discount = parseFloat(String(b.discountAmount)) || 0;
    return {
      date: getBookingDate(b),
      code: bk?.orderCode ?? `#${b.id}`,
      name: bk?.customerName ?? null,
      kind: bk?.serviceLabel ?? b.serviceCategory ?? "Đơn chốt",
      detail: discount > 0
        ? `Hợp đồng ${vndText(gross)} − giảm giá ${vndText(discount)}`
        : `Hợp đồng ${vndText(gross)}`,
      status: b.status ?? null,
      by: null,
      amount: b.netAmount || 0,
      bookingId: b.id,
      paymentId: null,
      expenseId: null,
    };
  }).sort(byDate);
  return { key: "contracts", label: "Đơn chốt trong kỳ (giá trị NET)", sign: 1, rows, subtotal: sum(rows) };
}

function castGroup(
  castRows: Array<{ bookingId: number; amount: number }>,
  bInfo: Map<number, BookingInfo>,
): EvidenceGroup {
  const rows: EvidenceRow[] = castRows.map(c => {
    const bk = bInfo.get(c.bookingId);
    return {
      date: bk?.shootDate ?? null,
      code: bk?.orderCode ?? `#${c.bookingId}`,
      name: bk?.customerName ?? null,
      kind: "Cast nhân sự",
      detail: "Tổng cast từ sổ lương theo show (staff_job_earnings)",
      status: null,
      by: null,
      amount: c.amount,
      bookingId: c.bookingId,
      paymentId: null,
      expenseId: null,
    };
  }).sort(byDate);
  return { key: "cast", label: "Cast nhân sự (sổ lương theo show)", sign: 1, rows, subtotal: sum(rows) };
}

function expenseGroup(
  key: string,
  label: string,
  list: ClassifiedExpense[],
  bInfo: Map<number, BookingInfo>,
): EvidenceGroup {
  const rows: EvidenceRow[] = list.map(e => {
    const bk = e.bookingId != null ? bInfo.get(e.bookingId) : undefined;
    return {
      date: e.date || null,
      code: e.expenseCode ?? (e.bookingId != null ? bk?.orderCode ?? `#${e.bookingId}` : null),
      name: bk?.customerName ?? null,
      kind: EXPENSE_KIND[e.cls] ?? e.cls,
      detail: e.description ?? null,
      status: "đã duyệt/đã chi",
      by: null,
      amount: e.amount,
      bookingId: e.bookingId,
      paymentId: null,
      expenseId: e.id,
    };
  }).sort(byDate);
  return { key, label, sign: 1, rows, subtotal: sum(rows) };
}

/**
 * Nhóm chi phí cố định: card cộng fixedCostPerMonth cho TỪNG bucket tháng
 * ⇒ phần fixed trong card = totals.operatingExp − Σ phiếu chi vận hành.
 * Liệt kê từng khoản trong danh mục hiện tại × số tháng; nếu danh mục hiện tại
 * không khớp đúng số đã tính (danh mục vừa đổi / enrichment lỗi) thì thêm dòng
 * điều chỉnh cho đủ TỪNG ĐỒNG — không được để bảng thiếu tiền so với card.
 */
export function fixedCostGroup(items: FixedCostItem[], bucketCount: number, cardFixedTotal: number): EvidenceGroup {
  const rows: EvidenceRow[] = items.map(it => ({
    date: null,
    code: null,
    name: it.label,
    kind: "CP cố định",
    detail: `${vndText(it.amount)}/tháng × ${bucketCount} tháng trong kỳ`,
    status: "đang áp dụng",
    by: null,
    amount: it.amount * bucketCount,
    bookingId: null,
    paymentId: null,
    expenseId: null,
  }));
  let subtotal = sum(rows);
  if (Math.abs(subtotal - cardFixedTotal) > 0.001) {
    rows.push({
      date: null, code: null,
      name: "Điều chỉnh khớp số đã tính trong kỳ",
      kind: "CP cố định",
      detail: "Danh mục chi phí cố định hiện tại khác số đã cộng vào kỳ (danh mục vừa được sửa hoặc không đọc được) — dòng này bù đúng phần chênh.",
      status: null, by: null,
      amount: cardFixedTotal - subtotal,
      bookingId: null, paymentId: null, expenseId: null,
    });
    subtotal = cardFixedTotal;
  }
  return { key: "fixed", label: "Chi phí cố định hàng tháng", sign: 1, rows, subtotal };
}

function receivableGroup(list: ReceivableEvidenceRow[]): EvidenceGroup {
  const rows: EvidenceRow[] = list.map(r => ({
    date: r.shootDate,
    code: r.orderCode ?? `#${r.bookingId}`,
    name: r.customerName,
    kind: r.serviceLabel ?? "Đơn còn nợ",
    detail: `Giá trị NET ${vndText(r.net)} − đã thu phân bổ ${vndText(r.allocPaid)}`,
    status: null,
    by: null,
    amount: r.debt,
    bookingId: r.bookingId,
    paymentId: null,
    expenseId: null,
  }));
  return { key: "receivables", label: "Đơn còn nợ có show trong kỳ", sign: 1, rows, subtotal: sum(rows) };
}

// ─── Route ─────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày phải TỒN TẠI trên lịch (2026-02-31, 2026-13-01 đúng regex nhưng là ngày rác). */
function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

/** Chặn range quá dài (request 1 phát quét cả trăm năm sẽ khóa event loop). */
const MAX_RANGE_MONTHS = 60;

function rangeMonths(from: string, to: string): number {
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  return (ty - fy) * 12 + (tm - fm) + 1;
}

router.get("/revenue/v2/evidence", async (req, res) => {
  const metric = String(req.query["metric"] ?? "") as EvidenceMetric;
  const from = String(req.query["from"] ?? "");
  const to = String(req.query["to"] ?? "");

  if (!EVIDENCE_METRICS.includes(metric)) {
    return res.status(400).json({ error: `metric không hợp lệ — dùng một trong: ${EVIDENCE_METRICS.join(", ")}` });
  }
  if (!isRealDate(from) || !isRealDate(to) || from > to) {
    return res.status(400).json({ error: "from/to phải là ngày có thật dạng YYYY-MM-DD và from <= to" });
  }
  if (rangeMonths(from, to) > MAX_RANGE_MONTHS) {
    return res.status(400).json({ error: `kỳ lọc tối đa ${MAX_RANGE_MONTHS} tháng` });
  }

  // "Còn nợ" là metric SQL thuần (engine receivable) — không cần nạp toàn bộ
  // dữ liệu doanh thu + enrichment của các metric khác. rows và cardTotal lấy từ
  // CÙNG MỘT câu SQL (một snapshot) nên không thể lệch do ghi đồng thời.
  if (metric === "remaining") {
    const { rows: rcvRows, total } = await engineReceivableRowsForRange(from, to);
    const groups = [receivableGroup(rcvRows)];
    const detailTotal = groups.reduce((s, g) => s + g.sign * g.subtotal, 0);
    return res.json({
      metric,
      from,
      to,
      formula: "Còn nợ = Σ từng đơn hợp lệ có ngày chụp/ngày thực hiện trong kỳ: max(0, giá trị hợp đồng NET − đã thu PHÂN BỔ theo gia đình đơn)",
      scopeNote: `Scope: ${REVENUE_SCOPES.receivableAmount.scope} — công nợ sống theo NGÀY THỰC HIỆN; phiếu thu trên hợp đồng cha được phân bổ pro-rata xuống từng dịch vụ con.`,
      notes: [],
      groups,
      detailTotal,
      cardTotal: total,
      reconciliationDelta: detailTotal - total,
      rowCount: groups.reduce((s, g) => s + g.rows.length, 0),
    });
  }

  const ev = await collectRangeEvidence(from, to);
  const bucketCount = ev.fixedBuckets.length;

  // Enrichment nhãn (không đụng số tiền)
  const bookingIds = new Set<number>();
  for (const b of ev.contractBookings) bookingIds.add(b.id);
  for (const p of ev.payments) if (p.bookingId != null) bookingIds.add(p.bookingId);
  for (const c of ev.castRows) bookingIds.add(c.bookingId);
  for (const cls of ["direct", "operating", "depreciation", "interest"] as const) {
    for (const e of ev.expenses[cls]) if (e.bookingId != null) bookingIds.add(e.bookingId);
  }
  const [bInfo, pInfo, fixedItems] = await Promise.all([
    fetchBookingInfo([...bookingIds]),
    fetchPaymentInfo(ev.payments.map(p => p.id)),
    fetchActiveFixedCosts(),
  ]);

  // Phần fixed ĐÚNG như card đã cộng: totals.operatingExp − Σ phiếu chi vận hành.
  const operatingRowsTotal = ev.expenses.operating.reduce((s, e) => s + e.amount, 0);
  const cardFixedTotal = ev.totals.operatingExp - operatingRowsTotal;

  const buildCostGroups = (): EvidenceGroup[] => [
    castGroup(ev.castRows, bInfo),
    expenseGroup("direct", "Chi phí trực tiếp gắn show (phiếu chi)", ev.expenses.direct, bInfo),
    expenseGroup("operating", "Chi phí vận hành (phiếu chi)", ev.expenses.operating, bInfo),
    fixedCostGroup(fixedItems, bucketCount, cardFixedTotal),
    expenseGroup("depreciation", "Khấu hao", ev.expenses.depreciation, bInfo),
    expenseGroup("interest", "Lãi vay", ev.expenses.interest, bInfo),
  ];

  const costNotes = ev.laborMeta?.notes ?? [];

  let formula = "";
  let scopeNote = "";
  let groups: EvidenceGroup[] = [];
  let cardTotal = 0;
  let notes: string[] = [];

  switch (metric) {
    case "collected": {
      formula = "Đã thu = Σ tất cả PHIẾU THU hợp lệ có ngày thu trong kỳ (loại: phiếu đã hủy, phiếu hoàn tiền, phiếu nằm trên hợp đồng cha rỗng)";
      scopeNote = `Scope: ${REVENUE_SCOPES.collectedAmount.scope} — tính theo NGÀY THU TIỀN, không phụ thuộc đơn chốt/tháng chụp.`;
      groups = [paymentGroup(ev.payments, bInfo, pInfo)];
      cardTotal = ev.totals.collected;
      break;
    }
    case "cost":
    case "expectedCost": {
      formula = "Chi phí = Cast nhân sự + Chi phí trực tiếp + Chi phí vận hành + Chi phí cố định + Khấu hao + Lãi vay (chỉ phiếu đã duyệt/đã chi; loại: phiếu bị từ chối, chi cá nhân, trả gốc vay)";
      scopeNote = metric === "expectedCost"
        ? "Đây cũng là CHI PHÍ DỰ KIẾN của kỳ: cast + chi phí gắn theo đơn chốt trong kỳ + chi phí theo ngày chi trong kỳ."
        : "Chi phí trực tiếp gắn show tính theo ĐƠN CHỐT trong kỳ; các lớp còn lại tính theo NGÀY CHI trong kỳ.";
      groups = buildCostGroups();
      cardTotal = ev.totals.totalCost;
      notes = costNotes;
      break;
    }
    case "realProfit": {
      formula = "Lợi nhuận thực = Đã thu − Chi phí";
      scopeNote = "Phần A (+) là tiền đã vào túi trong kỳ; phần B (−) là chi phí thực tế đã phát sinh trong kỳ.";
      groups = [
        paymentGroup(ev.payments, bInfo, pInfo),
        ...buildCostGroups().map(g => ({ ...g, sign: -1 as const })),
      ];
      cardTotal = ev.totals.realProfit;
      notes = costNotes;
      break;
    }
    case "contractValue": {
      formula = "Doanh thu hợp đồng = Σ giá trị NET (đã trừ giảm giá) các đơn CHỐT trong kỳ (loại: đơn xóa/hủy/báo giá tạm/đơn cha tổng/con mồ côi của cha chết)";
      scopeNote = `Scope: ${REVENUE_SCOPES.signedContractValue.scope} — chỉ số BÁN HÀNG theo ngày tạo đơn, KHÔNG phải tiền đã thu.`;
      groups = [contractGroup(ev.contractBookings, bInfo)];
      cardTotal = ev.totals.contractValue;
      break;
    }
    case "expectedProfit": {
      formula = "Lợi nhuận kỳ vọng = Doanh thu hợp đồng − Chi phí dự kiến";
      scopeNote = "Phần A (+) là giá trị hợp đồng chốt trong kỳ; phần B (−) là chi phí dự kiến của kỳ.";
      groups = [
        contractGroup(ev.contractBookings, bInfo),
        ...buildCostGroups().map(g => ({ ...g, sign: -1 as const })),
      ];
      cardTotal = ev.totals.netProfit;
      notes = costNotes;
      break;
    }
  }

  const detailTotal = groups.reduce((s, g) => s + g.sign * g.subtotal, 0);
  const reconciliationDelta = detailTotal - cardTotal;

  res.json({
    metric,
    from,
    to,
    formula,
    scopeNote,
    notes,
    groups,
    detailTotal,
    cardTotal,
    reconciliationDelta,
    rowCount: groups.reduce((s, g) => s + g.rows.length, 0),
  });
});

export default router;
