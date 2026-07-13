/**
 * contractPayload.ts — assembler DUY NHẤT cho trang hợp đồng online (nội bộ + public).
 *
 * Quy tắc bảo mật: payload build theo WHITELIST từng field, KHÔNG spread row DB.
 * - mode "public"  : bản sạch cho khách — hợp đồng, dịch vụ, tổng/đã trả/còn lại,
 *   lịch sử thanh toán (kèm ảnh cọc/chuyển khoản — bằng chứng minh bạch), chữ ký 2 bên.
 *   KHÔNG có: ghi chú nội bộ, người thu tiền, tên ekip, chi phí/lương/hoa hồng,
 *   lịch sử chỉnh sửa, cờ updatedAfterSign.
 * - mode "internal": thêm notes, publicToken, tên ekip, người thu, updatedAfterSign.
 *
 * Tiền nong mirror đúng GET /bookings/:id (routes/bookings.ts):
 * child booking → dùng payments + total/discount của PARENT; parent/standalone → của chính nó.
 */
import { db } from "@workspace/db";
import {
  contractsTable,
  customersTable,
  bookingsTable,
  bookingOccurrencesTable,
  paymentsTable,
  servicePackagesTable,
  staffTable,
} from "@workspace/db/schema";
import { eq, inArray, asc } from "drizzle-orm";
import { isCollectedPayment, money } from "./booking-money";

export const STUDIO_INFO = {
  name: "Amazing Studio",
  desc: "Chụp ảnh cưới & cho thuê váy cưới chuyên nghiệp",
  address: "Số 80, Hẻm 71, CMT8, KP Hiệp Bình, P. Hiệp Ninh, Tây Ninh",
  phone: "0392817079",
};

// ─── Types trả về cho frontend ───────────────────────────────────────────────
export type ContractServiceItem = {
  name: string;
  description: string | null;
  price: number;
  deductions: { label: string; amount: number }[];
  surcharges: { name: string; amount: number }[];
  // internal only — public luôn null
  photoName: string | null;
  makeupName: string | null;
};

export type ContractService = {
  bookingId: number;
  orderCode: string | null;
  serviceLabel: string | null;
  shootDate: string | null;
  shootTime: string | null;
  location: string | null;
  totalAmount: number;
  surcharges: { name: string; amount: number }[];
  items: ContractServiceItem[];
};

export type ContractPaymentRow = {
  paidAt: string | null;
  paidDate: string | null;
  amount: number;
  paymentMethod: string;
  paymentType: string;
  /** Ảnh cọc / chuyển khoản — đường dẫn public, khách xem được */
  proofImages: string[];
  // internal only — public luôn null
  collectorName: string | null;
  notes: string | null;
};

export type ContractPayload = {
  contract: {
    id: number;
    contractCode: string | null;
    title: string;
    content: string;
    status: string;
    createdAt: string;
    signedAt: string | null;
    expiresAt: string | null;
    totalValue: number;
  };
  studio: typeof STUDIO_INFO;
  customer: { name: string; phone: string | null };
  services: ContractService[];
  // Lịch thực hiện: ngày chính của (các) dịch vụ + ngày phụ (booking_occurrences),
  // theo thứ tự. KHÔNG ảnh hưởng tiền — chỉ để hiển thị "Lịch thực hiện" trên HĐ.
  schedule: { date: string; time: string | null; label: string | null }[];
  money: {
    totalAmount: number;
    discountAmount: number;
    paidAmount: number;
    remainingAmount: number;
  };
  payments: ContractPaymentRow[];
  signatures: {
    customer: {
      imageUrl: string | null;
      name: string | null;
      phone: string | null;
      signedAt: string | null;
    };
    studio: {
      imageUrl: string | null;
      signedAt: string | null;
      signedByName: string | null; // internal only — public luôn null
    };
  };
  signState: "unsigned" | "signed";
  resignRequested: boolean;
  /** CHỈ internal (public luôn null): hợp đồng có bị sửa field quan trọng sau khi khách ký? */
  internal: {
    notes: string | null;
    bookingId: number | null;
    customerId: number;
    publicToken: string | null;
    updatedAfterSign: boolean;
  } | null;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
/** /objects/... → /api/storage/objects/... (route public, không cần đăng nhập). */
function normalizeProofUrl(u: unknown): string | null {
  if (typeof u !== "string" || !u.trim()) return null;
  const s = u.trim();
  if (s.startsWith("data:") || /^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/objects/")) return `/api/storage/objects/${s.slice("/objects/".length)}`;
  return s.startsWith("/") ? s : null;
}

type RawItem = {
  serviceKey?: string | null;
  serviceName?: string | null;
  price?: number | string | null;
  unitPrice?: number | string | null;
  photoName?: string | null;
  makeupName?: string | null;
  deductions?: { label?: string; amount?: number }[] | null;
  surcharges?: { name?: string; label?: string; amount?: number }[] | null;
};

type BookingRow = {
  id: number;
  orderCode: string | null;
  customerId: number | null;
  shootDate: string | null;
  shootTime: string | null;
  packageType: string | null;
  serviceLabel: string | null;
  location: string | null;
  items: unknown;
  surcharges: unknown;
  totalAmount: string | null;
  discountAmount: string | null;
  parentId: number | null;
  isParentContract: boolean | null;
};

const bookingCols = {
  id: bookingsTable.id,
  orderCode: bookingsTable.orderCode,
  customerId: bookingsTable.customerId,
  shootDate: bookingsTable.shootDate,
  shootTime: bookingsTable.shootTime,
  packageType: bookingsTable.packageType,
  serviceLabel: bookingsTable.serviceLabel,
  location: bookingsTable.location,
  items: bookingsTable.items,
  surcharges: bookingsTable.surcharges,
  totalAmount: bookingsTable.totalAmount,
  discountAmount: bookingsTable.discountAmount,
  parentId: bookingsTable.parentId,
  isParentContract: bookingsTable.isParentContract,
};

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function pkgIdOf(item: RawItem): number | null {
  const key = item.serviceKey ?? "";
  if (!key.startsWith("pkg-")) return null;
  const n = parseInt(key.slice(4));
  return Number.isFinite(n) ? n : null;
}

function buildService(
  b: BookingRow,
  pkgMap: Map<number, { name: string; description: string | null }>,
  mode: "internal" | "public",
): ContractService {
  const rawItems = asArray<RawItem>(b.items);
  const items: ContractServiceItem[] = rawItems.map((line) => {
    const pkg = pkgIdOf(line) != null ? pkgMap.get(pkgIdOf(line)!) : undefined;
    return {
      name: pkg?.name || line.serviceName || "—",
      description: pkg?.description ?? null,
      price: money(line.price ?? line.unitPrice),
      deductions: asArray<{ label?: string; amount?: number }>(line.deductions).map((d) => ({
        label: d.label ?? "Giảm trừ",
        amount: money(d.amount),
      })),
      surcharges: asArray<{ name?: string; label?: string; amount?: number }>(line.surcharges).map((s) => ({
        name: s.name ?? s.label ?? "Phụ thu",
        amount: money(s.amount),
      })),
      photoName: mode === "internal" ? (line.photoName ?? null) : null,
      makeupName: mode === "internal" ? (line.makeupName ?? null) : null,
    };
  });
  return {
    bookingId: b.id,
    orderCode: b.orderCode,
    serviceLabel: b.serviceLabel || b.packageType,
    shootDate: b.shootDate,
    shootTime: b.shootTime,
    location: b.location,
    totalAmount: money(b.totalAmount),
    surcharges: asArray<{ name?: string; label?: string; amount?: number }>(b.surcharges).map((s) => ({
      name: s.name ?? s.label ?? "Phụ thu",
      amount: money(s.amount),
    })),
    items,
  };
}

// ─── Snapshot "field quan trọng" lúc khách ký ────────────────────────────────
// KHÔNG gồm paidAmount/ảnh cọc: đóng thêm tiền là bình thường, không tính là sửa hợp đồng.
export function buildSignedSnapshot(payload: ContractPayload): Record<string, unknown> {
  return {
    title: payload.contract.title,
    content: payload.contract.content,
    totalValue: payload.contract.totalValue,
    totalAmount: payload.money.totalAmount,
    discountAmount: payload.money.discountAmount,
    services: payload.services.map((s) => ({
      bookingId: s.bookingId,
      shootDate: s.shootDate,
      shootTime: s.shootTime,
      serviceLabel: s.serviceLabel,
      totalAmount: s.totalAmount,
      surcharges: s.surcharges,
      items: s.items.map((i) => ({
        name: i.name,
        price: i.price,
        deductions: i.deductions,
        surcharges: i.surcharges,
      })),
    })),
  };
}

/** Stringify ổn định (sort key) để so sánh snapshot không phụ thuộc thứ tự field. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function snapshotsDiffer(a: unknown, b: unknown): boolean {
  return stableStringify(a) !== stableStringify(b);
}

// ─── Assembler chính ─────────────────────────────────────────────────────────
export async function buildContractPayload(
  contractId: number,
  mode: "internal" | "public",
): Promise<ContractPayload | null> {
  const [c] = await db
    .select({
      id: contractsTable.id,
      contractCode: contractsTable.contractCode,
      bookingId: contractsTable.bookingId,
      customerId: contractsTable.customerId,
      customerName: customersTable.name,
      customerPhone: customersTable.phone,
      title: contractsTable.title,
      content: contractsTable.content,
      status: contractsTable.status,
      totalValue: contractsTable.totalValue,
      signedAt: contractsTable.signedAt,
      expiresAt: contractsTable.expiresAt,
      notes: contractsTable.notes,
      createdAt: contractsTable.createdAt,
      signatureImageUrl: contractsTable.signatureImageUrl,
      signerName: contractsTable.signerName,
      signerPhone: contractsTable.signerPhone,
      publicToken: contractsTable.publicToken,
      studioSignatureImageUrl: contractsTable.studioSignatureImageUrl,
      studioSignedAt: contractsTable.studioSignedAt,
      studioSignedById: contractsTable.studioSignedById,
      signedSnapshot: contractsTable.signedSnapshot,
      resignRequestedAt: contractsTable.resignRequestedAt,
    })
    .from(contractsTable)
    .innerJoin(customersTable, eq(contractsTable.customerId, customersTable.id))
    .where(eq(contractsTable.id, contractId));
  if (!c) return null;

  // ── Booking family: child → dùng parent làm nguồn tiền; parent → children ──
  let serviceRows: BookingRow[] = [];
  let moneyBase: { totalAmount: number; discountAmount: number } | null = null;
  let paymentTargetId: number | null = null;

  if (c.bookingId) {
    const [b] = await db.select(bookingCols).from(bookingsTable).where(eq(bookingsTable.id, c.bookingId));
    if (b) {
      if (b.parentId != null) {
        const [parent] = await db.select(bookingCols).from(bookingsTable).where(eq(bookingsTable.id, b.parentId));
        const children = await db
          .select(bookingCols)
          .from(bookingsTable)
          .where(eq(bookingsTable.parentId, b.parentId))
          .orderBy(asc(bookingsTable.shootDate));
        serviceRows = children.length > 0 ? children : [b];
        const base = parent ?? b;
        moneyBase = { totalAmount: money(base.totalAmount), discountAmount: money(base.discountAmount) };
        paymentTargetId = b.parentId;
      } else if (b.isParentContract) {
        const children = await db
          .select(bookingCols)
          .from(bookingsTable)
          .where(eq(bookingsTable.parentId, b.id))
          .orderBy(asc(bookingsTable.shootDate));
        serviceRows = children.length > 0 ? children : [b];
        moneyBase = { totalAmount: money(b.totalAmount), discountAmount: money(b.discountAmount) };
        paymentTargetId = b.id;
      } else {
        serviceRows = [b];
        moneyBase = { totalAmount: money(b.totalAmount), discountAmount: money(b.discountAmount) };
        paymentTargetId = b.id;
      }
    }
  }

  // ── Gói dịch vụ (mô tả) cho các item serviceKey "pkg-N" ──────────────────
  const pkgIds = [
    ...new Set(serviceRows.flatMap((b) => asArray<RawItem>(b.items).map(pkgIdOf)).filter((n): n is number => n != null)),
  ];
  const pkgMap = new Map<number, { name: string; description: string | null }>();
  if (pkgIds.length > 0) {
    const pkgs = await db
      .select({
        id: servicePackagesTable.id,
        name: servicePackagesTable.name,
        description: servicePackagesTable.description,
      })
      .from(servicePackagesTable)
      .where(inArray(servicePackagesTable.id, pkgIds));
    for (const p of pkgs) pkgMap.set(p.id, { name: p.name, description: p.description });
  }

  const services = serviceRows.map((b) => buildService(b, pkgMap, mode));

  // ── Lịch thực hiện: ngày chính từng dịch vụ + ngày phụ (occurrences) ────────
  // Thuần lịch trình, không đọc/không đụng tiền. Thứ tự: theo serviceRows, mỗi
  // dịch vụ hiện ngày chính rồi tới các ngày phụ của chính nó.
  const schedule: { date: string; time: string | null; label: string | null }[] = [];
  const serviceRowIds = serviceRows.map((b) => b.id).filter((n): n is number => n != null);
  const occByBooking = new Map<number, { shootDate: string; shootTime: string | null; label: string | null }[]>();
  if (serviceRowIds.length > 0) {
    const occRows = await db
      .select({ bookingId: bookingOccurrencesTable.bookingId, shootDate: bookingOccurrencesTable.shootDate, shootTime: bookingOccurrencesTable.shootTime, label: bookingOccurrencesTable.label })
      .from(bookingOccurrencesTable)
      .where(inArray(bookingOccurrencesTable.bookingId, serviceRowIds))
      .orderBy(asc(bookingOccurrencesTable.sortOrder), asc(bookingOccurrencesTable.shootDate), asc(bookingOccurrencesTable.id));
    for (const o of occRows) {
      (occByBooking.get(o.bookingId) ?? occByBooking.set(o.bookingId, []).get(o.bookingId)!).push({ shootDate: o.shootDate as string, shootTime: o.shootTime, label: o.label });
    }
  }
  for (const b of serviceRows) {
    if (b.shootDate) schedule.push({ date: b.shootDate, time: b.shootTime, label: b.serviceLabel || b.packageType || null });
    for (const o of (b.id != null ? occByBooking.get(b.id) ?? [] : [])) {
      schedule.push({ date: o.shootDate, time: o.shootTime, label: o.label });
    }
  }

  // ── Thanh toán ────────────────────────────────────────────────────────────
  let paymentRows: ContractPaymentRow[] = [];
  let paidAmount = 0;
  if (paymentTargetId != null) {
    const pays = await db.select().from(paymentsTable).where(eq(paymentsTable.bookingId, paymentTargetId));
    const collected = pays.filter(isCollectedPayment);
    paidAmount = collected.reduce((s, p) => s + money(p.amount), 0);
    paymentRows = collected
      .sort((a, b) => {
        const ta = new Date(a.paidDate || a.paidAt || 0).getTime();
        const tb = new Date(b.paidDate || b.paidAt || 0).getTime();
        return ta - tb;
      })
      .map((p) => ({
        paidAt: p.paidAt ? new Date(p.paidAt).toISOString() : null,
        paidDate: p.paidDate ?? null,
        amount: money(p.amount),
        paymentMethod: p.paymentMethod,
        paymentType: p.paymentType,
        proofImages: [p.proofImageUrl, ...(p.proofImageUrls ?? [])]
          .map(normalizeProofUrl)
          .filter((u): u is string => !!u)
          .filter((u, i, arr) => arr.indexOf(u) === i),
        collectorName: mode === "internal" ? (p.collectorName ?? null) : null,
        notes: mode === "internal" ? (p.notes ?? null) : null,
      }));
  }

  const totalAmount = moneyBase?.totalAmount ?? money(c.totalValue);
  const discountAmount = moneyBase?.discountAmount ?? 0;
  const remainingAmount = Math.max(0, totalAmount - discountAmount - paidAmount);

  // ── Chữ ký ────────────────────────────────────────────────────────────────
  let studioSignedByName: string | null = null;
  if (mode === "internal" && c.studioSignedById) {
    const [st] = await db.select({ name: staffTable.name }).from(staffTable).where(eq(staffTable.id, c.studioSignedById));
    studioSignedByName = st?.name ?? null;
  }

  const signState: "unsigned" | "signed" = c.status === "signed" || c.signatureImageUrl ? "signed" : "unsigned";

  const payload: ContractPayload = {
    contract: {
      id: c.id,
      contractCode: c.contractCode,
      title: c.title,
      content: c.content,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
      signedAt: c.signedAt,
      expiresAt: c.expiresAt,
      totalValue: money(c.totalValue),
    },
    studio: STUDIO_INFO,
    customer: { name: c.customerName, phone: c.customerPhone ?? null },
    services,
    schedule,
    money: { totalAmount, discountAmount, paidAmount, remainingAmount },
    payments: paymentRows,
    signatures: {
      customer: {
        imageUrl: c.signatureImageUrl,
        name: c.signerName ?? c.customerName,
        phone: c.signerPhone,
        signedAt: c.signedAt,
      },
      studio: {
        imageUrl: c.studioSignatureImageUrl,
        signedAt: c.studioSignedAt ? c.studioSignedAt.toISOString() : null,
        signedByName: studioSignedByName,
      },
    },
    signState,
    resignRequested: c.resignRequestedAt != null,
    internal: null,
  };

  if (mode === "internal") {
    // Cảnh báo NỘI BỘ "sửa sau khi ký": diff snapshot lúc ký vs hiện tại.
    // signedSnapshot null (hợp đồng ký trước khi có tính năng) → không cảnh báo.
    const updatedAfterSign =
      signState === "signed" && c.signedSnapshot != null
        ? snapshotsDiffer(buildSignedSnapshot(payload), c.signedSnapshot)
        : false;
    payload.internal = {
      notes: c.notes,
      bookingId: c.bookingId,
      customerId: c.customerId,
      publicToken: c.publicToken,
      updatedAfterSign,
    };
  }

  return payload;
}
