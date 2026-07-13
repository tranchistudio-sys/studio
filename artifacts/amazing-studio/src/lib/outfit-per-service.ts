/**
 * outfit-per-service.ts — logic THUẦN cho "Trang phục / Đạo cụ đi kèm" THEO TỪNG DỊCH VỤ
 * trong form sửa/tạo show (calendar.tsx).
 *
 * Bug gốc: form nhiều dịch vụ render mỗi service card 1 OutfitBookingSection nhưng TẤT CẢ trỏ
 * vào 1 mảng outfitDrafts DÙNG CHUNG + load/save theo booking CHA ⇒ thêm váy ở Dịch vụ 1 thì
 * Dịch vụ 2/3… hiện y chang. Fix: mỗi sub-service giữ mảng riêng (key theo sub.id), load/save
 * theo CHILD booking id (bảng booking_dresses đã có cột booking_id — không cần đổi schema).
 *
 * Data CŨ (phương án 1 chủ chốt): váy của đơn cũ đang gắn ở booking CHA, các con trống, hệ thống
 * không biết váy nào thuộc dịch vụ nào ⇒ hiển thị TẠM toàn bộ ở Dịch vụ 1 (không mất data);
 * admin phân bổ lại rồi bấm Lưu ⇒ váy được ghi vào đúng child, cha được dọn (move, không mất).
 *
 * Tách thuần ở đây để test không cần render React.
 */

/** Row API /bookings/:id/dresses (snake_case) → OutfitDraft (shape của outfit-booking-section). */
export type OutfitDraftLike = {
  tempId: string;
  dressId: number;
  outfitCode: string;
  outfitName: string;
  outfitImage?: string | null;
  category?: string | null;
  size?: string | null;
  rentalPrice?: number;
  pickupDate: string;
  returnDate: string;
  status: DressStatus;
  note?: string;
  dbId?: number | null;
  // Vòng đời thuê váy (ngày thực tế + ghi chú). overdue = tính tự động, không lưu.
  actualPickupDate?: string | null;
  actualReturnDate?: string | null;
  preparationNote?: string;
  returnNote?: string;
  damageNote?: string;
};

/** 8 trạng thái LƯU trong DB (mirror lib backend dress-lifecycle.ts). */
export type DressStatus =
  | "reserved" | "preparing" | "picked_up" | "waiting_return"
  | "returned" | "cleaning" | "ready" | "cancelled";

export function mapDressRowToDraft(r: Record<string, unknown>, genTempId: () => string): OutfitDraftLike {
  return {
    tempId: genTempId(),
    dressId: Number(r.dress_id),
    outfitCode: String(r.outfit_code),
    outfitName: String(r.outfit_name),
    outfitImage: (r.outfit_image as string) || null,
    category: (r.category as string) || null,
    size: (r.size as string) || null,
    rentalPrice: Number(r.rental_price) || 0,
    pickupDate: String(r.pickup_date),
    returnDate: String(r.return_date),
    status: String(r.status) as OutfitDraftLike["status"],
    note: (r.note as string) || "",
    dbId: Number(r.id) || null,
    actualPickupDate: (r.actual_pickup_date as string) || null,
    actualReturnDate: (r.actual_return_date as string) || null,
    preparationNote: (r.preparation_note as string) || "",
    returnNote: (r.return_note as string) || "",
    damageNote: (r.damage_note as string) || "",
  };
}

/** Nhãn + màu badge cho từng trạng thái hiển thị (gồm "overdue" suy ra). */
export const DRESS_STATUS_META: Record<string, { label: string; cls: string }> = {
  reserved:       { label: "Đã giữ",        cls: "bg-slate-100 text-slate-700 border-slate-300" },
  preparing:      { label: "Đang chuẩn bị", cls: "bg-amber-100 text-amber-800 border-amber-300" },
  picked_up:      { label: "Khách đang giữ", cls: "bg-red-100 text-red-700 border-red-300" },
  waiting_return: { label: "Chờ khách trả",  cls: "bg-orange-100 text-orange-800 border-orange-300" },
  overdue:        { label: "Quá hạn!",       cls: "bg-red-200 text-red-900 border-red-500 font-bold" },
  returned:       { label: "Đã trả",         cls: "bg-slate-100 text-slate-600 border-slate-300" },
  cleaning:       { label: "Đang giặt/kiểm tra", cls: "bg-blue-100 text-blue-700 border-blue-300" },
  ready:          { label: "Sẵn sàng",       cls: "bg-green-100 text-green-700 border-green-400" },
  cancelled:      { label: "Đã huỷ",         cls: "bg-slate-100 text-slate-400 border-slate-200 line-through" },
};

/** overdue derived (mirror backend isOverdue). today = "YYYY-MM-DD". */
export function dressIsOverdue(status: string, returnDate: string, actualReturnDate: string | null | undefined, today: string): boolean {
  if (status !== "picked_up" && status !== "waiting_return") return false;
  if ((actualReturnDate || "").slice(0, 10)) return false;
  const rd = (returnDate || "").slice(0, 10);
  return !!rd && rd < today;
}

/** Trạng thái hiển thị hiệu dụng (đắp overdue). */
export function effectiveDressStatusFE(d: { status: string; returnDate: string; actualReturnDate?: string | null }, today: string): string {
  return dressIsOverdue(d.status, d.returnDate, d.actualReturnDate, today) ? "overdue" : d.status;
}

/** Ngày gợi ý: lấy trước ngày cưới N ngày, trả sau N ngày. */
export function suggestDressDatesFE(weddingDate: string, beforeDays = 3, afterDays = 3): { pickupDate: string; returnDate: string } {
  const base = (weddingDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) return { pickupDate: "", returnDate: "" };
  const shift = (iso: string, days: number) => {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  };
  return { pickupDate: shift(base, -beforeDays), returnDate: shift(base, afterDays) };
}

/**
 * Chia trang phục đã load về TỪNG dịch vụ (key = sub.id trên form).
 *
 * - Đơn 1 dịch vụ (không sibling): váy nằm ngay trên booking chính → gán hết cho sub đầu.
 * - Đơn nhiều dịch vụ: mỗi sub nhận váy của CHILD booking (bySibling[siblingId]).
 *   Váy còn gắn ở CHA (data cũ) → dồn vào Dịch vụ 1 (prepend), legacyParent=true.
 *   (Cả case mixed — con có váy VÀ cha còn váy cũ — vẫn dồn váy cha vào Dịch vụ 1
 *   để KHÔNG BAO GIỜ mất data; lưu xong cha được dọn nên chỉ xảy ra 1 lần.)
 */
export function splitOutfitsBySub<T>(
  subs: { key: string; siblingId: number | null }[],
  bySibling: Record<number, T[]>,
  parentOutfits: T[],
): { bySubKey: Record<string, T[]>; legacyParent: boolean } {
  const bySubKey: Record<string, T[]> = {};
  const isMulti = subs.some((s) => s.siblingId != null);

  if (!isMulti) {
    subs.forEach((s, i) => { bySubKey[s.key] = i === 0 ? parentOutfits : []; });
    return { bySubKey, legacyParent: false };
  }

  for (const s of subs) {
    bySubKey[s.key] = s.siblingId != null ? (bySibling[s.siblingId] ?? []) : [];
  }
  if (parentOutfits.length > 0 && subs.length > 0) {
    const firstKey = subs[0].key;
    bySubKey[firstKey] = [...parentOutfits, ...bySubKey[firstKey]];
    return { bySubKey, legacyParent: true };
  }
  return { bySubKey, legacyParent: false };
}

/**
 * Kế hoạch sync 1 booking: draft nào UPDATE (dbId thuộc chính booking này), draft nào INSERT
 * (mới hoặc dbId thuộc booking KHÁC — vd váy legacy của cha chuyển xuống con ⇒ move = insert
 * dưới con + row cũ ở cha bị dọn khi sync cha), row nào DELETE (không còn trong drafts).
 * Đây là bản THUẦN của syncOutfitDrafts (calendar.tsx) để test được.
 */
export function planOutfitSync<T extends { dbId?: number | null }>(
  existingIds: number[],
  drafts: T[],
): { toUpdate: T[]; toInsert: T[]; deleteIds: number[] } {
  const existing = new Set(existingIds);
  const toUpdate: T[] = [];
  const toInsert: T[] = [];
  const kept = new Set<number>();
  for (const d of drafts) {
    if (d.dbId && existing.has(d.dbId)) { toUpdate.push(d); kept.add(d.dbId); }
    else toInsert.push(d);
  }
  const deleteIds = existingIds.filter((id) => !kept.has(id));
  return { toUpdate, toInsert, deleteIds };
}

/** Cập nhật outfits của ĐÚNG 1 dịch vụ trong map, các dịch vụ khác giữ nguyên tham chiếu. */
export function setSubOutfits<T>(
  map: Record<string, T[]>,
  subKey: string,
  next: T[],
): Record<string, T[]> {
  return { ...map, [subKey]: next };
}

/**
 * Loại khỏi danh sách váy CHA những bản đã có dưới CHILD của Dịch vụ 1 (trùng dress + ngày lấy/trả).
 * Chống hiển thị đúp khi lần lưu trước fail giữa chừng: vài bản copy đã insert xuống con nhưng cha
 * chưa được dọn ⇒ mở lại sẽ thấy 1 váy 2 dòng nếu không dedupe (review finding #3).
 */
export function dedupeParentOutfits<T extends { dressId: number; pickupDate: string; returnDate: string }>(
  parentOutfits: T[],
  firstSubChildOutfits: T[],
): T[] {
  const key = (t: T) => `${t.dressId}|${t.pickupDate}|${t.returnDate}`;
  const seen = new Set(firstSubChildOutfits.map(key));
  return parentOutfits.filter((p) => !seen.has(key(p)));
}

/**
 * Khi user XOÁ 1 service card: váy của child đó mất theo card là đúng (remove-child sẽ xoá row DB),
 * NHƯNG váy LEGACY của CHA (fromParent — chỉ hiển thị "tạm" ở card đó, không thuộc child) phải được
 * CHUYỂN sang card còn lại đầu tiên thay vì bị dọn mất khi lưu (review finding #2).
 */
export function moveOutfitsOnSubRemove<T extends { fromParent?: boolean }>(
  map: Record<string, T[]>,
  removedKey: string,
  fallbackKey: string | null,
): Record<string, T[]> {
  const { [removedKey]: removed = [], ...rest } = map;
  const legacy = removed.filter((o) => o.fromParent);
  if (!fallbackKey || legacy.length === 0) return rest;
  return { ...rest, [fallbackKey]: [...legacy, ...(rest[fallbackKey] ?? [])] };
}
