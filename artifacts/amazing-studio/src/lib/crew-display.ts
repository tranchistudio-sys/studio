/**
 * NGUỒN NHÂN SỰ CANONICAL DUY NHẤT cho mọi màn hiển thị crew (sự cố DH0248 27/07/2026):
 * booking có 11 phân công trong items[0].assignedStaff nhưng màn chi tiết show chỉ hiện
 * 3–4 dòng (dedupe theo TÊN toàn cục — người giữ 6 vai trò chỉ hiện 1 lần), card
 * tuần/tháng rớt hẳn Marketing/Khác và nén Trợ lý/Thợ phụ thành chip "TL" không tên.
 *
 * Quy tắc:
 *  - Nguồn chính = items[].assignedStaff (TẤT CẢ items của dịch vụ, không chỉ items[0]).
 *  - Legacy photoName/makeupName chỉ là fallback-union; taskAssignees chỉ đắp vào role
 *    đang trống (tránh tên cũ từ bảng tasks đè tên mới ở items).
 *  - Dedupe DUY NHẤT theo (role canonical, tên lower-case) — cùng người khác vai trò
 *    hiện đủ ở mọi vai trò; 2 người cùng vai trò hiện đủ 2 tên.
 *  - Không giới hạn số người, không slice, không hard-code 4 role; role lạ/mới hiện
 *    nhãn raw viết hoa chữ đầu, KHÔNG bị rớt.
 *  - Thuần TS (không React/fetch) để test được bằng vitest node.
 */

export type CrewAssignmentLike = { role?: string | null; staffName?: string | null; staffId?: number | null };
export type CrewItemLike = {
  assignedStaff?: unknown;
  photoName?: string | null;
  makeupName?: string | null;
  /** Xác nhận thủ công "Đã đủ nhân sự" cho DÒNG DỊCH VỤ này (khoá ổ khoá trong form show). */
  staffLocked?: boolean | null;
};
export type CrewTaskAssigneeLike = {
  role?: string | null;
  taskType?: string | null;
  assigneeName?: string | null;
};

// ─── Role canonical hoá (chuyển từ calendar.tsx — một nơi duy nhất) ───────────
// "sale" (số ít) là literal thật trong tasks/staff legacy — gộp về "sales" để không
// sinh 2 badge Sale (1 stale) và để guard fallback taskAssignees hoạt động.
export const ROLE_CANONICAL: Record<string, string> = {
  photo: "photographer", photographer: "photographer",
  makeup: "makeup", make_up: "makeup",
  assistant: "assistant", tro_ly: "assistant", tro_li: "assistant",
  support: "support", ho_tro: "support",
  video: "videographer", videographer: "videographer", quay_phim: "videographer", "quay phim": "videographer",
  photoshop: "photoshop", pts: "photoshop",
  assistant_photo: "assistant_photo",
  marketing: "marketing", sales: "sales", sale: "sales",
  print: "print", in_anh: "print",
  deliver: "deliver", giao_file: "deliver",
  call: "call", goi_khach: "call",
  chup: "photographer",
};

export function canonicalRole(role: string | null | undefined): string {
  if (!role) return "other";
  return ROLE_CANONICAL[role.toLowerCase()] ?? role.toLowerCase();
}

export type CrewRoleMeta = { label: string; short: string; border: string; order: number };

export const CREW_ROLE_META: Record<string, CrewRoleMeta> = {
  photographer:    { label: "Nhiếp ảnh", short: "P",    border: "border-sky-300",    order: 0 },
  makeup:          { label: "Makeup",    short: "M",    border: "border-pink-300",   order: 1 },
  videographer:    { label: "Quay phim", short: "Quay", border: "border-amber-300",  order: 2 },
  sales:           { label: "Sale",      short: "Sale", border: "border-violet-300", order: 3 },
  assistant:       { label: "Trợ lý",    short: "TL",   border: "border-blue-200",   order: 4 },
  assistant_photo: { label: "Thợ phụ",   short: "TP",   border: "border-blue-200",   order: 5 },
  support:         { label: "Hỗ trợ",    short: "HT",   border: "border-blue-200",   order: 6 },
  photoshop:       { label: "PTS",       short: "PTS",  border: "border-blue-200",   order: 7 },
  marketing:       { label: "Marketing", short: "Mkt",  border: "border-blue-200",   order: 8 },
  print:           { label: "In ảnh",    short: "In",   border: "border-blue-200",   order: 9 },
  deliver:         { label: "Giao file", short: "Giao", border: "border-blue-200",   order: 10 },
  call:            { label: "Gọi khách", short: "Gọi",  border: "border-blue-200",   order: 11 },
  other:           { label: "Khác",      short: "Khác", border: "border-blue-200",   order: 12 },
};

export type CrewGroup = {
  canon: string;
  label: string;
  short: string;
  border: string;
  order: number;
  names: string[];
};

function metaOf(canon: string): CrewRoleMeta {
  return (
    CREW_ROLE_META[canon] ?? {
      // Role mới/lạ: hiện raw viết hoa chữ đầu — KHÔNG được rớt.
      label: canon.charAt(0).toUpperCase() + canon.slice(1),
      short: canon.charAt(0).toUpperCase() + canon.slice(1),
      border: "border-blue-200",
      order: 99,
    }
  );
}

/**
 * Thu thập TOÀN BỘ crew từ mọi nguồn, nhóm theo role canonical.
 * Dedupe trong từng role theo ĐỊNH DANH (review #134 F1):
 *  - entry có staffId → khoá theo staffId: 2 NGƯỜI KHÁC staffId trùng tên hiển thị
 *    ĐỦ CẢ HAI; cùng staffId chỉ 1 lần.
 *  - entry legacy KHÔNG staffId (photoName/makeupName, taskAssignees) → khoá theo
 *    tên lower-case: trùng tên với người đã có (id hoặc không) = bản sao → bỏ.
 *  - legacy vào TRƯỚC rồi canonical-có-id cùng tên vào SAU → coi là CÙNG người
 *    (nâng cấp record, không hiện đôi).
 * KHÔNG BAO GIỜ dùng tên làm khoá chính khi có staffId.
 */
export function collectCrew(input: {
  items?: CrewItemLike[] | null;
  bookingAssignedStaff?: unknown;
  parentAssignedStaff?: unknown;
  taskAssignees?: CrewTaskAssigneeLike[] | null;
}): CrewGroup[] {
  type Group = { names: string[]; seenIds: Set<number>; seenNames: Map<string, { hasId: boolean }> };
  const groups = new Map<string, Group>();
  const push = (canon: string, name: string | null | undefined, staffId?: number | null) => {
    const n = (name ?? "").trim();
    if (!n) return;
    let g = groups.get(canon);
    if (!g) { g = { names: [], seenIds: new Set(), seenNames: new Map() }; groups.set(canon, g); }
    const key = n.toLowerCase();
    if (staffId != null) {
      if (g.seenIds.has(staffId)) return; // cùng người (theo id) + cùng role — trùng thật
      const prev = g.seenNames.get(key);
      if (prev && !prev.hasId) {
        // legacy (không id) đã vào trước với đúng tên này → cùng người, nâng cấp record
        prev.hasId = true;
        g.seenIds.add(staffId);
        return;
      }
      g.seenIds.add(staffId);
      if (!prev) g.seenNames.set(key, { hasId: true });
      g.names.push(n); // prev.hasId=true (NGƯỜI KHÁC trùng tên) → vẫn push: đủ cả hai
      return;
    }
    // legacy/không id: trùng tên với bất kỳ ai đã có trong role = bản sao → bỏ
    if (g.seenNames.has(key)) return;
    g.seenNames.set(key, { hasId: false });
    g.names.push(n);
  };
  const pushArr = (arr: unknown) => {
    if (!Array.isArray(arr)) return; // legacy object {sale: N} không có tên — bỏ qua như mọi surface hiện tại
    for (const sa of arr as CrewAssignmentLike[]) {
      if (!sa || !sa.staffName) continue;
      push(canonicalRole(sa.role), sa.staffName, sa.staffId);
    }
  };

  // 1) TẤT CẢ items của dịch vụ (nguồn canonical) + legacy photoName/makeupName (fallback-union)
  for (const it of input.items ?? []) {
    if (!it) continue;
    pushArr(it.assignedStaff);
    push("photographer", it.photoName);
    push("makeup", it.makeupName);
  }
  // 2) Nhân sự tầng hợp đồng cha + tầng booking (Sale/PTS gắn ở tầng đơn, Giao việc module)
  pushArr(input.parentAssignedStaff);
  pushArr(input.bookingAssignedStaff);
  // 3) taskAssignees — CHỈ đắp vào role đang trống TÍNH TẠI THỜI ĐIỂM TRƯỚC vòng
  //    lặp (review #134 F2: snapshot trước — role trống nhận ĐỦ MỌI người từ tasks,
  //    không phải chỉ người đầu tiên). Role đã có nhân sự canonical từ items[]:
  //    GIỮ ẨN tên từ tasks (quyết định chủ 27/07 — tên bảng tasks có thể cũ/stale,
  //    hiện lên card dễ làm nhân viên hiểu nhầm ai thực sự đi show; mục "Giao việc"
  //    riêng trong panel vẫn liệt kê đầy đủ tasks).
  const rolesFilledBeforeTasks = new Set(
    Array.from(groups.entries()).filter(([, g]) => g.names.length > 0).map(([canon]) => canon),
  );
  for (const ta of input.taskAssignees ?? []) {
    if (!ta?.assigneeName) continue;
    const canon = canonicalRole(ta.role ?? ta.taskType);
    if (!rolesFilledBeforeTasks.has(canon)) push(canon, ta.assigneeName);
  }

  return Array.from(groups.entries())
    .filter(([, g]) => g.names.length > 0)
    .map(([canon, g]) => ({ canon, ...metaOf(canon), names: g.names }))
    .sort((a, b) => a.order - b.order);
}

/** Tổng số "tên" hiển thị = tổng assignment hợp lệ (1 người 2 vai trò đếm 2). */
export function crewNameCount(groups: CrewGroup[]): number {
  return groups.reduce((n, g) => n + g.names.length, 0);
}

// ─── Xác nhận thủ công "Đã đủ nhân sự" theo TỪNG DỊCH VỤ ─────────────────────
// Có show không cần studio cử người (khách chỉ thuê váy, khách tự lo photographer/
// makeup, giữ ngày…) nhưng logic tự động vẫn coi là thiếu ⇒ lịch kẹt cảnh báo đỏ.
// Cờ `staffLocked` nằm trên TỪNG phần tử bookings.items (JSONB) — mỗi dịch vụ một
// cờ riêng, KHÔNG có công tắc chung cho cả show. Mặc định thiếu/undefined = false
// nên mọi show cũ giữ NGUYÊN hành vi hiện tại.

/** Dịch vụ đã được người dùng khoá & xác nhận "Đã đủ nhân sự". */
export function isServiceStaffLocked(item: unknown): boolean {
  return !!item && typeof item === "object" && (item as CrewItemLike).staffLocked === true;
}

/**
 * Show được XÁC NHẬN THỦ CÔNG là đủ nhân sự: có ít nhất 1 dịch vụ và MỌI dịch vụ
 * đều đã khoá. Còn 1 dịch vụ chưa khoá ⇒ false, lịch quay lại chấm theo logic tự
 * động (dịch vụ chưa khoá đó vẫn phải được kiểm tra như trước).
 */
export function allServicesStaffLocked(items: unknown): boolean {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every(isServiceStaffLocked);
}

export type CrewFlagOptions = {
  /** true = mọi dịch vụ của show đã khoá "Đã đủ nhân sự" (xem allServicesStaffLocked). */
  staffConfirmedComplete?: boolean;
};

/** Giữ NGUYÊN ngữ nghĩa cảnh báo cũ của lịch; chỉ thêm nhánh xác nhận thủ công. */
export function crewFlags(
  groups: CrewGroup[],
  opts?: CrewFlagOptions,
): { unassigned: boolean; isFullyAssigned: boolean } {
  // Xác nhận thủ công thắng: không cảnh báo "Chưa giao việc" và cũng không "Thiếu"
  // (nếu chỉ tắt `unassigned`, show khoá mà không có ai lại rơi vào nhánh "Thiếu").
  if (opts?.staffConfirmedComplete) return { unassigned: false, isFullyAssigned: true };
  const has = (c: string) => groups.some(g => g.canon === c && g.names.length > 0);
  const unassigned = !has("photographer") && !has("makeup") && !has("sales") && !has("videographer");
  const isFullyAssigned = (has("photographer") && has("makeup")) || has("videographer");
  return { unassigned, isFullyAssigned };
}

/** Chi tiết booking: mỗi role 1 dòng "Nhãn: tên, tên" — đủ MỌI role, đủ MỌI người. */
export function crewDetailLines(groups: CrewGroup[]): { canon: string; label: string; names: string[] }[] {
  return groups.map(g => ({ canon: g.canon, label: g.label, names: g.names }));
}

/**
 * Card tuần/tháng (dạng gọn): 4 role chính dạng chuỗi + extras CÓ TÊN cho mọi
 * role còn lại — thay chip "TL" không tên và hết rớt Marketing/Thợ phụ/Khác.
 */
export function crewCompactLine(groups: CrewGroup[], opts?: CrewFlagOptions): {
  p: string; m: string; v: string; sale: string;
  extras: { canon: string; short: string; names: string[] }[];
  unassigned: boolean;
} {
  const get = (c: string) => groups.find(g => g.canon === c)?.names.join(", ") ?? "";
  const MAIN = new Set(["photographer", "makeup", "videographer", "sales"]);
  const extras = groups
    .filter(g => !MAIN.has(g.canon))
    .map(g => ({ canon: g.canon, short: g.short, names: g.names }));
  return {
    p: get("photographer"),
    m: get("makeup"),
    v: get("videographer"),
    sale: get("sales"),
    extras,
    unassigned: crewFlags(groups, opts).unassigned,
  };
}
