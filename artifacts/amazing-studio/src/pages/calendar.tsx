import { useState, useMemo, useCallback, useRef, useEffect, Component, Fragment } from "react";
import { useToast } from "@/hooks/use-toast";
import { orderCreatedFeedback } from "@/lib/feedback";
import type { ReactNode, ErrorInfo, TouchEvent as ReactTouchEvent } from "react";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  convertSolarToLunar, getCanChi, getLunarMonthName, getTietKhi,
  LUNAR_HOLIDAYS, SOLAR_HOLIDAYS,
} from "@/lib/lunar";
import {
  format, addMonths, subMonths, startOfMonth, endOfMonth, eachDayOfInterval,
  isSameDay, isToday, addDays, subDays, parseISO, startOfWeek,
} from "date-fns";
import { vi } from "date-fns/locale";
import { formatVND } from "@/lib/utils";
import { ServicePriceBreakdown, renderServiceBreakdownCardHTML } from "@/components/ServiceBreakdownCard";
import { getImageSrc } from "@/lib/imageUtils";
import { ConceptImage } from "@/components/ConceptImage";
import {
  ChevronLeft, ChevronRight, Calendar, Clock, Phone, Package2, Sun, Moon,
  AlertCircle, Plus, X, Check, Camera, User, Users, Sparkles,
  ChevronDown, Trash2, Save, MapPin, CreditCard, ArrowLeft,
  Pencil, ShieldCheck, Eye, FileText, CalendarDays, CheckCircle2, Palette, Crown,
  LayoutList, Rows3, ZoomIn, ZoomOut, DollarSign, Receipt, Briefcase, TrendingDown,
  Coffee,
  Shirt,
  Copy,
} from "lucide-react";
import {
  Dialog as UIDialog, DialogContent as UIDialogContent, DialogHeader as UIDialogHeader,
  DialogTitle as UIDialogTitle, DialogFooter as UIDialogFooter, DialogDescription as UIDialogDescription,
} from "@/components/ui/dialog";
import { useLocation, useSearch } from "wouter";
import { Button, Input } from "@/components/ui";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Switch } from "@/components/ui/switch";
import { ServiceSearchBox } from "@/components/service-search-box";
import { SurchargeEditor, type SurchargeItem } from "@/components/surcharge-editor";
import { DeductionEditor, type DeductionItem } from "@/components/deduction-editor";
import { StaffAssignmentEditor, type StaffAssignment, newStaffAssignment } from "@/components/staff-assignment-editor";
import { castAmountFromResult, lookupCastByPkg, resolveCastAmount } from "@/lib/resolve-cast";
import { reflowDescriptionLines, firstDescriptionLine, parseDescriptionBlocks } from "@/lib/package-description";
import { buildDressWarningsByDate, type DressWarnRow, type DressWarnChip } from "@/lib/dress-warnings";
import { invalidateBookingRelated } from "@/lib/booking-cache";
import OutfitBookingSection, { type OutfitDraft } from "@/components/outfit-booking-section";
import { splitOutfitsBySub, planOutfitSync, mapDressRowToDraft, dedupeParentOutfits, moveOutfitsOnSubRemove } from "@/lib/outfit-per-service";
import AdditionalServicesSection, { validateAdditionalServicesForm, type AdditionalServiceLine, newAdditionalServiceLine } from "@/components/additional-services-section";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("amazingStudioToken_v2");
  const headers = { ...(opts.headers as Record<string, string> ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return fetch(url, { ...opts, headers });
}

// Nén 1 ảnh → data URL jpeg (≤1.5MB, cạnh dài ≤1600px). Dùng cho ảnh bằng chứng cọc.
function compressImageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Đọc file ảnh lỗi"));
    reader.onload = ev => {
      const img = new Image();
      img.onerror = () => reject(new Error("Ảnh không hợp lệ"));
      img.onload = () => {
        const MAX_BYTES = 1.5 * 1024 * 1024;
        const canvas = document.createElement("canvas");
        let { width, height } = img;
        const MAX_DIM = 1600;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
        let quality = 0.85;
        let compressed = canvas.toDataURL("image/jpeg", quality);
        while (compressed.length * 0.75 > MAX_BYTES && quality > 0.3) {
          quality -= 0.1;
          compressed = canvas.toDataURL("image/jpeg", quality);
        }
        resolve(compressed);
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// ─── SĐT: chỉ chữ số + nhận diện placeholder ("0", "chưa có"...) ────────────────
function digitsOnly(raw: string | null | undefined): string {
  return String(raw ?? "").replace(/\D/g, "");
}
/** SĐT placeholder/thiếu → coi như KHÔNG có số (không dùng để tra/merge khách). */
function isMissingPhone(raw: string | null | undefined): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return true;
  if (["chưa có", "chua co", "không", "khong", "n/a", "na", "-", "/"].includes(s)) return true;
  const d = s.replace(/\D/g, "");
  if (!d) return true;            // không có chữ số
  if (/^0+$/.test(d)) return true; // toàn số 0: "0", "00", "000"...
  return false;
}

// ─── Types ────────────────────────────────────────────────────────────────────
type TaskAssignee = {
  role: string | null;
  taskType: string | null;
  assigneeName: string;
  status: string;
};
type Booking = {
  id: number; orderCode: string; customerId: number; customerName: string;
  customerPhone: string; customerRank?: string | null; shootDate: string; shootTime: string;
  serviceCategory: string; packageType: string; location: string | null;
  status: string; items: OrderLine[]; surcharges?: { name: string; amount: number }[];
  totalAmount: number; depositAmount: number; discountAmount?: number;
  paidAmount: number; remainingAmount: number;
  // assignedStaff can be:
  //   - StaffAssignment[] when saved by Giao việc module
  //   - Record<string,unknown> legacy object {sale:N, photoshop:M}
  //   - null / empty when not yet assigned
  assignedStaff: StaffAssignment[] | Record<string, unknown> | null;
  notes: string | null;
  // Multi-service contract fields
  parentId: number | null;
  serviceLabel: string | null;
  isParentContract: boolean;
  photoCount?: number | null;
  servicePackageId?: number | null;
  createdByStaffId?: number | null;
  // Task assignees từ module Giao việc
  taskAssignees?: TaskAssignee[];
  // Duration from linked service (e.g. "2h", "90 phút")
  shootDuration?: string | null;
  // Loaded on detail fetch
  siblings?: Booking[];
  parentContract?: Booking & { remainingAmount: number };
  children?: Booking[];
  additionalServices?: AdditionalServiceLine[];
  // Ngày thực hiện phụ (dịch vụ nhiều ngày). Ngày 1 = shootDate; đây là ngày 2..n.
  occurrences?: BookingOccurrence[];
  // Setting nhắc thuê đồ (gói bật "Thuê đồ"): null = mặc định lấy trước 3 / trả sau 2 ngày.
  dressWarnPickupDays?: number | null;
  dressWarnReturnDays?: number | null;
  // Chỉ dùng ở tầng HIỂN THỊ lịch: khi 1 booking nhiều ngày được "bung" thành nhiều
  // event, mỗi event mang nhãn "Ngày k/n — label" + key riêng. KHÔNG gửi lên server.
  _occLabel?: string | null;
  _occKey?: string;
};
type BookingOccurrence = { id: number; shootDate: string; shootTime: string | null; label: string | null; sortOrder: number };
// Draft ngày phụ trong form (id âm = chưa lưu; id dương = occurrence thật trong DB).
type OccurrenceDraft = { id: number | null; shootDate: string; shootTime: string; label: string };

// ─── Helper: lấy tên nhân sự từ 2 nguồn (ưu tiên giảm dần) ──────────────────
// 1. item.photoName / item.makeupName  (trực tiếp từ Booking modal)
// 2. item.assignedStaff[role=photographer/makeup]  (từ StaffAssignmentEditor / Giao việc module)
function resolveItemStaff(
  item: OrderLine | null | undefined,
): { photoName: string; makeupName: string } {
  if (!item) {
    return { photoName: "", makeupName: "" };
  }
  let photoName = (item.photoName ?? "").trim();
  let makeupName = (item.makeupName ?? "").trim();
  if (Array.isArray(item.assignedStaff)) {
    const staff = item.assignedStaff as StaffAssignment[];
    if (!photoName) {
      const p = staff.find(s => canonicalRole(s.role) === "photographer");
      if (p?.staffName) photoName = p.staffName.trim();
    }
    if (!makeupName) {
      const m = staff.find(s => canonicalRole(s.role) === "makeup");
      if (m?.staffName) makeupName = m.staffName.trim();
    }
  }
  return { photoName, makeupName };
}

// ─── Helper: trả về TẤT CẢ photographers/makeup của 1 item ──────────────────
// Dùng cho card lịch khi 1 dịch vụ có nhiều người
// (ví dụ: "Nhiếp ảnh: Thanh Hà Photofreelancer, QUAN").
// Lấy union của item.assignedStaff[role] + item.photoName/makeupName, đã dedupe
// theo TÊN ĐẦY ĐỦ (case-insensitive) — KHÔNG cắt còn chữ cuối, để user thấy
// rõ tên ai (ví dụ "Thanh Hà Photofreelancer" thay vì "Photofreelancer").
function collectConceptImageUrls(...sources: Array<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const src = getImageSrc(value.trim());
    if (!src || seen.has(src)) return;
    seen.add(src);
    out.push(src);
  };
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const item of source) push(item);
      continue;
    }
    if (source && typeof source === "object") {
      const obj = source as Record<string, unknown>;
      push(obj.url);
      push(obj.src);
      push(obj.path);
      push(obj.imageUrl);
      push(obj.thumbnailUrl);
      push(obj.coverUrl);
      push(obj.attachments);
      push(obj.images);
      push(obj.gallery);
    }
  }
  return out;
}

function resolveItemStaffAll(
  item: OrderLine | null | undefined,
): { photoNames: string[]; makeupNames: string[]; videoNames: string[] } {
  if (!item) return { photoNames: [], makeupNames: [], videoNames: [] };
  const photoNames: string[] = [];
  const makeupNames: string[] = [];
  const videoNames: string[] = [];
  const seenP = new Set<string>();
  const seenM = new Set<string>();
  const seenV = new Set<string>();
  const pushP = (full: string) => {
    const name = full.trim();
    const key = name.toLowerCase();
    if (name && !seenP.has(key)) { seenP.add(key); photoNames.push(name); }
  };
  const pushM = (full: string) => {
    const name = full.trim();
    const key = name.toLowerCase();
    if (name && !seenM.has(key)) { seenM.add(key); makeupNames.push(name); }
  };
  const pushV = (full: string) => {
    const name = full.trim();
    const key = name.toLowerCase();
    if (name && !seenV.has(key)) { seenV.add(key); videoNames.push(name); }
  };
  if (Array.isArray(item.assignedStaff)) {
    for (const sa of item.assignedStaff as StaffAssignment[]) {
      if (!sa?.staffName) continue;
      const cr = canonicalRole(sa.role);
      if (cr === "photographer") pushP(sa.staffName);
      else if (cr === "makeup") pushM(sa.staffName);
      else if (cr === "videographer") pushV(sa.staffName);
    }
  }
  if (item.photoName) pushP(item.photoName);
  if (item.makeupName) pushM(item.makeupName);
  return { photoNames, makeupNames, videoNames };
}

// ─── Helper: chuẩn hóa role key về canonical form ──────────────────────────
// Giải quyết nhiều biến thể của cùng 1 vai trò (photo/photographer, makeup/make_up…)
const ROLE_CANONICAL: Record<string, string> = {
  photo: "photographer", photographer: "photographer",
  makeup: "makeup", make_up: "makeup",
  assistant: "assistant", tro_ly: "assistant", tro_li: "assistant",
  support: "support", ho_tro: "support",
  video: "videographer", videographer: "videographer", quay_phim: "videographer", "quay phim": "videographer",
  photoshop: "photoshop", pts: "photoshop",
  assistant_photo: "assistant_photo",
  marketing: "marketing", sales: "sales",
  print: "print", in_anh: "print",
  deliver: "deliver", giao_file: "deliver",
  call: "call", goi_khach: "call",
  chup: "photographer",
};
function canonicalRole(role: string | null | undefined): string {
  if (!role) return "other";
  return ROLE_CANONICAL[role.toLowerCase()] ?? role.toLowerCase();
}

// ─── Helper: parse duration text → hours (null nếu không nhận dạng được) ─────
// Hỗ trợ: "2h", "2 giờ", "90 phút", "1.5h", "1h30", "1h30m"
function parseDurationHours(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  // "Xh" or "X giờ"
  const hoursOnly = t.match(/^(\d+(?:\.\d+)?)\s*(?:h|giờ|gio|hr|hours?)$/);
  if (hoursOnly) return parseFloat(hoursOnly[1]);
  // "Xh Ym" or "XhYm" e.g. "1h30m", "1h30"
  const hourMin = t.match(/^(\d+)\s*h\s*(\d+)(?:m|phút|p)?$/);
  if (hourMin) return parseInt(hourMin[1]) + parseInt(hourMin[2]) / 60;
  // "X phút"
  const minsOnly = t.match(/^(\d+)\s*(?:phút|p|min|minutes?)$/);
  if (minsOnly) return parseInt(minsOnly[1]) / 60;
  return null;
}

// ─── Helper: compute end time string "HH:MM" from start + duration hours ─────
function addHours(startTime: string, hours: number): string {
  const [hStr, mStr] = startTime.split(":");
  const totalMins = parseInt(hStr) * 60 + parseInt(mStr || "0") + Math.round(hours * 60);
  const endH = Math.floor(totalMins / 60) % 24;
  const endM = totalMins % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

// ─── Helper: format duration label for booking card ──────────────────────────
// Always includes start time. Returns:
//   "09:00 – 11:00"  when duration is parseable as hours
//   "09:00 • 2h"     when duration text exists but can't be parsed
//   null             when no duration (caller should fall back to bare start time)
function formatBookingDuration(shootTime: string | null | undefined, duration: string | null | undefined): string | null {
  if (!duration) return null;
  const startStr = shootTime?.slice(0, 5);
  if (!startStr) return `• ${duration}`;
  const hours = parseDurationHours(duration);
  if (hours !== null && hours > 0) {
    const endStr = addHours(startStr, hours);
    return `${startStr} – ${endStr}`;
  }
  return `${startStr} • ${duration}`;
}

type Customer = {
  id: number; name: string; phone: string; email?: string;
  facebook?: string; zalo?: string; avatar?: string; customCode?: string; totalDebt?: number;
  customerRank?: string;
};

// ─── Phân hạng khách hàng (đồng bộ với module Khách hàng) ───────────────────
const RANK_LABELS: Record<string, string> = {
  new: "Khách mới",
  potential: "Khách tiềm năng",
  vip: "Khách VIP",
  super_vip: "Siêu VIP",
  model: "Khách mẫu",
  needs_care: "Cần chăm sóc",
};
const RANK_COLORS: Record<string, string> = {
  new: "bg-slate-100 text-slate-700",
  potential: "bg-blue-100 text-blue-700",
  vip: "bg-amber-100 text-amber-800",
  super_vip: "bg-gradient-to-r from-amber-200 to-yellow-300 text-amber-900",
  model: "bg-pink-100 text-pink-700",
  needs_care: "bg-orange-100 text-orange-700",
};
// Thứ tự ưu tiên khi sort kết quả tìm kiếm — số nhỏ = nổi bật trước
const RANK_PRIORITY: Record<string, number> = {
  super_vip: 0, vip: 1, model: 2, potential: 3, needs_care: 4, new: 5,
};
function rankPriority(r?: string | null): number {
  return RANK_PRIORITY[r ?? "new"] ?? 99;
}
function isPriorityRank(r?: string | null): boolean {
  return r === "vip" || r === "super_vip";
}
function RankBadge({ rank, size = "sm" }: { rank?: string | null; size?: "xs" | "sm" }) {
  if (!rank || rank === "new") return null;
  const cls = RANK_COLORS[rank] ?? "bg-muted text-muted-foreground";
  const txt = RANK_LABELS[rank] ?? rank;
  const sizeCls = size === "xs"
    ? "text-[9px] px-1.5 py-0.5 gap-0.5"
    : "text-[10px] px-1.5 py-0.5 gap-0.5";
  const iconCls = size === "xs" ? "w-2 h-2" : "w-2.5 h-2.5";
  return (
    <span className={`rounded-full font-semibold inline-flex items-center whitespace-nowrap ${sizeCls} ${cls}`}>
      {isPriorityRank(rank) && <Crown className={iconCls} />}
      {txt}
    </span>
  );
}
type Staff = { id: number; name: string; role: string; roles: string[]; isActive: boolean; staffType?: string; color?: string | null };
type ServiceSplit = { role: string; amount: number; rateType: "fixed" | "percent" };
type Service = { id: number; name: string; price: number; category: string; code: string; splits?: ServiceSplit[] };
type Addon = { key: string; name: string; price: number };
type PkgItem = { name: string; quantity: string; unit?: string; notes?: string };
type ServiceOption = {
  key: string; name: string; price: number;
  splits?: ServiceSplit[];
  printCost?: number; operatingCost?: number; salePercent?: number;
  items?: PkgItem[];
  addons?: Addon[];
  products?: string[];
  serviceType?: string | null;
  photoCount?: number | null;
  includesMakeup?: boolean;
  description?: string | null;
  notes?: string | null;
};
type OrderLine = {
  tempId: string;
  serviceLabel?: string | null;
  serviceName: string; serviceId: number | null; serviceKey: string; price: number;
  unitPrice?: number;
  basePrice: number;
  selectedAddons: string[];
  surcharges: SurchargeItem[];
  deductions: DeductionItem[];
  baseJobType: string; // Base job type key from BASE_TASKS (e.g., "chup_cong", "chup_album")
  photoId: number | null; photoName: string; photoTask: string;
  makeupId: number | null; makeupName: string; makeupTask: string;
  assignedStaff: StaffAssignment[];
  notes?: string;
  conceptImages?: string[];
  serviceImages?: string[];
  attachedImages?: string[];
  images?: string[];
  gallery?: string[];
};
type SubServiceDraft = {
  id: string;
  siblingId?: number;
  serviceLabel: string;
  shootDate: string;       // "" = inherit contract date
  shootTime: string;
  items: OrderLine[];
  photoId: number | null; photoName: string; photoTask: string;
  makeupId: number | null; makeupName: string; makeupTask: string;
  notes: string;
  additionalServices: AdditionalServiceLine[];
  occurrences: OccurrenceDraft[];
};

const STATUS = {
  draft:            { label: "Lịch tạm",          color: "bg-slate-100 text-slate-600 border-slate-300",   dot: "bg-slate-400",   bar: "bg-slate-300 text-slate-700" },
  pending_service:  { label: "Chưa chốt dịch vụ", color: "bg-orange-100 text-orange-700 border-orange-300", dot: "bg-orange-400",  bar: "bg-orange-400 text-white" },
  pending:          { label: "Chờ xác nhận",       color: "bg-yellow-100 text-yellow-800 border-yellow-300", dot: "bg-yellow-400",  bar: "bg-yellow-400 text-yellow-900" },
  confirmed:        { label: "Đã xác nhận",        color: "bg-blue-100 text-blue-800 border-blue-300",       dot: "bg-blue-500",    bar: "bg-blue-500 text-white" },
  in_progress:      { label: "Đang chụp",          color: "bg-purple-100 text-purple-800 border-purple-300", dot: "bg-purple-500",  bar: "bg-purple-500 text-white" },
  completed:        { label: "Hoàn thành",         color: "bg-green-100 text-green-800 border-green-300",    dot: "bg-green-500",   bar: "bg-green-500 text-white" },
  cancelled:        { label: "Đã hủy",             color: "bg-gray-100 text-gray-500 border-gray-300",       dot: "bg-gray-400",    bar: "bg-gray-300 text-gray-600" },
  temp_quote:       { label: "Báo giá tạm",        color: "bg-purple-100 text-purple-800 border-purple-400", dot: "bg-purple-600",  bar: "bg-purple-600 text-white" },
} as const;

// ─── Staff color palette (màu theo nhân viên) ────────────────────────────────
const STAFF_PALETTE = [
  { key: "sky",     bar: "bg-sky-500 text-white",         card: "bg-sky-100 text-sky-800 border-sky-300",           dot: "#0ea5e9" },
  { key: "indigo",  bar: "bg-indigo-500 text-white",      card: "bg-indigo-100 text-indigo-800 border-indigo-300",   dot: "#6366f1" },
  { key: "violet",  bar: "bg-violet-500 text-white",      card: "bg-violet-100 text-violet-800 border-violet-600",   dot: "#8b5cf6" },
  { key: "emerald", bar: "bg-emerald-500 text-white",     card: "bg-emerald-100 text-emerald-800 border-emerald-300", dot: "#10b981" },
  { key: "amber",   bar: "bg-amber-400 text-amber-900",   card: "bg-amber-100 text-amber-800 border-amber-300",      dot: "#fbbf24" },
  { key: "rose",    bar: "bg-rose-500 text-white",        card: "bg-rose-100 text-rose-800 border-rose-300",         dot: "#f43f5e" },
  { key: "orange",  bar: "bg-orange-500 text-white",      card: "bg-orange-100 text-orange-800 border-orange-300",   dot: "#f97316" },
  { key: "slate",   bar: "bg-slate-500 text-white",       card: "bg-slate-100 text-slate-700 border-slate-300",      dot: "#64748b" },
  { key: "teal",    bar: "bg-teal-500 text-white",        card: "bg-teal-100 text-teal-800 border-teal-300",         dot: "#14b8a6" },
  { key: "pink",    bar: "bg-pink-500 text-white",        card: "bg-pink-100 text-pink-800 border-pink-300",         dot: "#ec4899" },
] as const;
const STAFF_PALETTE_DEFAULT = { bar: "bg-slate-300 text-slate-700", card: "bg-slate-50 text-slate-600 border-slate-300", dot: "#94a3b8" };

function getStaffPaletteEntry(booking: { assignedStaff?: unknown }, allStaff: Staff[]) {
  const toId = (val: unknown): number | null => {
    if (val == null) return null;
    const n = Number(val);
    return (!isNaN(n) && n > 0) ? n : null;
  };
  const fallbackStaff = (seed: number | null) => {
    if (!seed) return null;
    const staff = allStaff.find(s => s.id === seed);
    if (staff) return staff;
    return { id: seed, color: STAFF_PALETTE[Math.abs(seed) % STAFF_PALETTE.length].key } as Staff;
  };
  const bookingId = toId((booking as Record<string, unknown>).id);
  const creatorId = toId(
    (booking as Record<string, unknown>).createdByStaffId ||
    (booking as Record<string, unknown>).createdBy ||
    (booking as Record<string, unknown>).createdById ||
    (booking as Record<string, unknown>).creatorId ||
    (booking as Record<string, unknown>).created_by ||
    (booking as Record<string, unknown>).created_by_staff_id
  );
  const saleId = (() => {
    if (Array.isArray(booking.assignedStaff)) {
      const arr = booking.assignedStaff as Array<number | { role?: string; staffId?: unknown }>;
      for (const entry of arr) {
        if (typeof entry === "number") return toId(entry);
        if (entry?.role === "sales") return toId(entry.staffId);
      }
    } else if (booking.assignedStaff && typeof booking.assignedStaff === "object") {
      const obj = booking.assignedStaff as Record<string, unknown>;
      return toId(obj.sale) || toId(obj.saleStaffId);
    }
    return null;
  })();
  if (saleId) return fallbackStaff(saleId);
  if (creatorId) return fallbackStaff(creatorId);
  if (Array.isArray(booking.assignedStaff)) {
    const arr = booking.assignedStaff as Array<number | { staffId?: unknown }>;
    for (const entry of arr) {
      const id = typeof entry === "number" ? toId(entry) : toId(entry.staffId);
      if (id) return fallbackStaff(id);
    }
  } else if (booking.assignedStaff && typeof booking.assignedStaff === "object") {
    const obj = booking.assignedStaff as Record<string, unknown>;
    for (const key of ["photo", "photographer"]) {
      const id = toId(obj[key]);
      if (id) return fallbackStaff(id);
    }
  }
  return bookingId ? fallbackStaff(bookingId) : null;
}

// Màu TÍM cố định toàn hệ thống cho Báo giá tạm tính — không theo màu nhân viên,
// không trùng màu show thường. Quy ước cả tiệm: nhìn lịch thấy tím = báo giá tạm.
const TEMP_QUOTE_COLORS = {
  bar: "bg-purple-600 text-white",
  card: "bg-purple-100 text-purple-900 border-purple-400",
  dot: "#9333ea", // tailwind purple-600
};

function getStaffColors(booking: { assignedStaff?: unknown; status?: string }, allStaff: Staff[]): { bar: string; card: string; dot: string } {
  // Báo giá tạm tính: luôn tím, bất kể nhân viên — đổi status là màu đổi theo ngay.
  if (booking.status === "temp_quote") return TEMP_QUOTE_COLORS;
  const staff = getStaffPaletteEntry(booking, allStaff);
  if (!staff) return STAFF_PALETTE_DEFAULT;
  if (staff.color) {
    const p = STAFF_PALETTE.find(c => c.key === staff.color);
    if (p) return { bar: p.bar, card: p.card, dot: p.dot };
  }
  const p = STAFF_PALETTE[staff.id % STAFF_PALETTE.length];
  return { bar: p.bar, card: p.card, dot: p.dot };
}

function genId() { return Math.random().toString(36).slice(2); }

// ─── Helper: sync booking-dresses after booking save ───────────────────────────
// Per-booking (mỗi DỊCH VỤ sync với CHILD booking id của nó — không còn dồn hết vào cha).
// Draft mang dbId của booking KHÁC (váy legacy đang nằm ở CHA) ⇒ planOutfitSync xếp vào
// toInsert ⇒ POST row MỚI dưới booking này; row cũ ở cha được dọn khi sync cha với [] (move).
// Đồng bộ ngày thực hiện phụ của MỘT booking sau khi có id thật (mirror syncOutfitDrafts):
// diff theo id → PUT (occurrence cũ), POST (draft mới id=null), DELETE (occurrence bị gỡ).
// Mọi request phải res.ok, lỗi THROW để handleSave dừng — không để dữ liệu nửa vời.
/** Parse ô nhập số ngày nhắc thuê đồ: "" = null (dùng mặc định 3/2), clamp 0..30. */
function parseWarnDays(s: string): number | null {
  const t = (s ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(30, Math.floor(n));
}

async function syncOccurrences(bookingId: number, drafts: OccurrenceDraft[]) {
  const existing: BookingOccurrence[] = await authFetch(`${BASE}/api/bookings/${bookingId}/occurrences`)
    .then(r => (r.ok ? r.json() : [])).catch(() => []);
  const draftIds = new Set(drafts.map(d => d.id).filter((n): n is number => n != null));
  const valid = drafts.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.shootDate));
  for (const d of valid) {
    const body = JSON.stringify({ shootDate: d.shootDate, shootTime: d.shootTime || null, label: d.label?.trim() || null });
    if (d.id != null) {
      const r = await authFetch(`${BASE}/api/bookings/${bookingId}/occurrences/${d.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
      if (!r.ok) throw new Error("Lỗi lưu ngày thực hiện");
    } else {
      const r = await authFetch(`${BASE}/api/bookings/${bookingId}/occurrences`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (!r.ok) { const e = await r.json().catch(() => null); throw new Error(e?.error || "Lỗi thêm ngày thực hiện"); }
    }
  }
  for (const row of existing) {
    if (!draftIds.has(row.id)) {
      const r = await authFetch(`${BASE}/api/bookings/${bookingId}/occurrences/${row.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Lỗi gỡ ngày thực hiện cũ");
    }
  }
}

// Ngày phụ gửi KÈM body PUT /bookings/:id — backend diff + ghi trong CÙNG
// transaction với booking (atomic save). syncOccurrences ở trên chỉ còn dùng cho
// nhánh TẠO MỚI (booking chưa có id lúc build body, chưa có card nào trên lịch
// nên không có rủi ro "mất tạm").
function occurrencesPayload(drafts: OccurrenceDraft[] | undefined) {
  return (drafts ?? [])
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.shootDate))
    .map(d => ({ id: d.id, shootDate: d.shootDate, shootTime: d.shootTime || null, label: d.label?.trim() || null }));
}

// "Bung" 1 booking thành các event theo ngày để vẽ lên lịch. Đơn 1 ngày → [b] (giữ
// nguyên hành vi cũ, không nhãn). Đơn nhiều ngày → event ngày chính ("Ngày 1/n") +
// mỗi occurrence 1 event ("Ngày k/n — label"), TẤT CẢ cùng id + mã đơn. Không đụng tiền.
function expandBookingToDayEvents(b: Booking): Booking[] {
  const occ = Array.isArray(b.occurrences) ? b.occurrences : [];
  if (occ.length === 0) return [b];
  const total = occ.length + 1;
  const events: Booking[] = [{ ...b, _occLabel: `Ngày 1/${total}`, _occKey: `${b.id}-main` }];
  occ.forEach((o, i) => {
    const base = `Ngày ${i + 2}/${total}`;
    const lbl = (o.label ?? "").trim();
    events.push({
      ...b,
      shootDate: (o.shootDate || "").slice(0, 10),
      shootTime: (o.shootTime || b.shootTime || "").slice(0, 5),
      _occLabel: lbl ? `${base} — ${lbl}` : base,
      _occKey: `${b.id}-occ-${o.id}`,
    });
  });
  return events;
}

async function syncOutfitDrafts(bookingId: number, drafts: OutfitDraft[]) {
  const existing = await authFetch(`${BASE}/api/bookings/${bookingId}/dresses`).then(r => r.ok ? r.json() : []).catch(() => []);
  const existingIds: number[] = [];
  for (const row of existing) { if (row?.id) existingIds.push(row.id); }
  const { toUpdate, toInsert, deleteIds } = planOutfitSync(existingIds, drafts);
  // MỌI request phải res.ok — lỗi là THROW ngay để handleSave abort TRƯỚC bước dọn cha.
  // (Nếu insert bản copy dưới con fail mà vẫn dọn cha ⇒ MẤT váy vĩnh viễn — review finding #1.)
  for (const d of toUpdate) {
    const r = await authFetch(`${BASE}/api/booking-dresses/${d.dbId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickupDate: d.pickupDate, returnDate: d.returnDate, status: d.status, note: d.note, rentalPrice: d.rentalPrice, preparationNote: d.preparationNote ?? "", returnNote: d.returnNote ?? "", damageNote: d.damageNote ?? "" }),
    });
    if (!r.ok) throw new Error(`Lỗi lưu trang phục ${d.outfitCode}`);
  }
  for (const d of toInsert) {
    const r = await authFetch(`${BASE}/api/booking-dresses`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookingId, dressId: d.dressId, outfitCode: d.outfitCode, outfitName: d.outfitName,
        outfitImage: d.outfitImage, category: d.category, size: d.size, rentalPrice: d.rentalPrice,
        pickupDate: d.pickupDate, returnDate: d.returnDate, status: d.status, note: d.note,
      }),
    });
    if (!r.ok) throw new Error(`Lỗi lưu trang phục ${d.outfitCode}`);
  }
  for (const id of deleteIds) {
    const r = await authFetch(`${BASE}/api/booking-dresses/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error("Lỗi gỡ trang phục cũ");
  }
}

// ─── Lunar helpers ─────────────────────────────────────────────────────────────
function getLunarInfo(date: Date) {
  const d = date.getDate(), m = date.getMonth() + 1, y = date.getFullYear();
  const lunar = convertSolarToLunar(d, m, y);
  const tietKhi = getTietKhi(d, m, y);
  return {
    lunar, tietKhi,
    solarHoliday: SOLAR_HOLIDAYS[`${d}-${m}`] ?? null,
    lunarHoliday: LUNAR_HOLIDAYS[`${lunar.day}-${lunar.month}`] ?? null,
  };
}

// ─── Phone autocomplete ───────────────────────────────────────────────────────
function PhoneAutocomplete({ value, onChange, onSelect }: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (c: Customer) => void;
}) {
  const [open, setOpen] = useState(false);
  const [matchedCustomer, setMatchedCustomer] = useState<Customer | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const autoSelectedRef = useRef<string | null>(null);
  const { data: results = [] } = useQuery<Customer[]>({
    queryKey: ["customer-search", value],
    queryFn: () => authFetch(`${BASE}/api/customers?search=${encodeURIComponent(value)}`)
      .then(r => r.ok ? r.json() : [])
      .then((d: unknown) => Array.isArray(d) ? d : []),
    enabled: value.length >= 1,
    staleTime: 5_000,
  });
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  useEffect(() => {
    const digits = value.replace(/\D/g, "");
    if (digits.length >= 10 && results.length > 0 && autoSelectedRef.current !== digits) {
      const exact = results.find(c => c.phone?.replace(/\D/g, "") === digits);
      if (exact) {
        autoSelectedRef.current = digits;
        setMatchedCustomer(exact);
        onSelect(exact);
        setOpen(false);
      }
    }
    if (digits.length < 10) { autoSelectedRef.current = null; setMatchedCustomer(null); }
  }, [results, value, onSelect]);
  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          className="pl-9 h-10"
          placeholder="Số điện thoại *"
          value={value}
          onChange={e => { onChange(e.target.value); setOpen(true); setMatchedCustomer(null); }}
          onFocus={() => value.length >= 1 && setOpen(true)}
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 bg-background border border-border rounded-xl shadow-lg mt-1 max-h-56 overflow-y-auto">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-3 pt-2 pb-1">Khách cũ gợi ý</p>
          {[...results].sort((a, b) => rankPriority(a.customerRank) - rankPriority(b.customerRank)).slice(0, 8).map(c => (
            <button
              key={c.id}
              className={`w-full text-left px-3 py-2 hover:bg-muted/60 transition-colors flex items-center gap-2.5 ${isPriorityRank(c.customerRank) ? "bg-amber-50/50 dark:bg-amber-900/10" : ""}`}
              onMouseDown={() => { onSelect(c); setOpen(false); setMatchedCustomer(null); }}
            >
              <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 bg-primary/20 flex items-center justify-center">
                {c.avatar
                  ? <img src={c.avatar} alt="" className="w-full h-full object-cover" />
                  : <span className="text-xs font-bold text-primary">{(c.name || "?").charAt(0)}</span>
                }
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm truncate flex items-center gap-1.5">
                  {c.name}
                  <RankBadge rank={c.customerRank} size="xs" />
                </p>
                <p className="text-xs text-muted-foreground">{c.phone || "—"}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      {matchedCustomer && !open && (
        <div className="flex items-center gap-1.5 text-xs text-emerald-600 mt-1 px-1 flex-wrap">
          <Check className="w-3 h-3" /> Khách cũ: <span className="font-semibold">{matchedCustomer.name}</span>
          <RankBadge rank={matchedCustomer.customerRank} size="xs" />
        </div>
      )}
    </div>
  );
}

function CustomerNameSuggest({ value, phone, onSelect }: {
  value: string;
  phone: string;
  onSelect: (c: Customer) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const suppressRef = useRef(false);
  const normalizedPhone = String(phone ?? "").replace(/\D/g, "");
  const query = value.trim();
  const { data: results = [] } = useQuery<Customer[]>({
    queryKey: ["customer-name-search", query],
    queryFn: () => authFetch(`${BASE}/api/customers?search=${encodeURIComponent(query)}`)
      .then(r => r.ok ? r.json() : [])
      .then((d: unknown) => Array.isArray(d) ? d : []),
    enabled: query.length >= 1,
    staleTime: 5_000,
  });
  const filtered = useMemo(() => {
    const seen = new Set<number>();
    return results.filter(c => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      const p = c.phone?.replace(/\D/g, "") ?? "";
      return !normalizedPhone || p !== normalizedPhone;
    }).slice(0, 8);
  }, [results, normalizedPhone]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  useEffect(() => {
    if (suppressRef.current) { suppressRef.current = false; return; }
    if (query.length >= 1 && filtered.length > 0) setOpen(true);
    else setOpen(false);
  }, [query, filtered.length]);
  if (!open || filtered.length === 0) return null;
  return (
    <div ref={ref} className="absolute top-full left-0 right-0 z-50 bg-background border border-border rounded-xl shadow-lg mt-1 max-h-56 overflow-y-auto">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-3 pt-2 pb-1">Khách cũ gợi ý</p>
      {[...filtered].sort((a, b) => rankPriority(a.customerRank) - rankPriority(b.customerRank)).map(c => (
        <button
          key={c.id}
          type="button"
          onMouseDown={() => { suppressRef.current = true; onSelect(c); setOpen(false); }}
          className={`w-full text-left px-3 py-2 hover:bg-muted/60 transition-colors flex items-center gap-2.5 ${isPriorityRank(c.customerRank) ? "bg-amber-50/50 dark:bg-amber-900/10" : ""}`}
        >
          <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0 bg-primary/20 flex items-center justify-center">
            {c.avatar
              ? <img src={c.avatar} alt="" className="w-full h-full object-cover" />
              : <span className="text-xs font-bold text-primary">{(c.name || "?").charAt(0)}</span>
            }
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm truncate flex items-center gap-1.5">
              {c.name}
              <RankBadge rank={c.customerRank} size="xs" />
            </p>
            <p className="text-xs text-muted-foreground">{c.phone || "—"}</p>
          </div>
          {c.totalDebt && c.totalDebt > 0 ? (
            <span className="text-[10px] rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 whitespace-nowrap flex-shrink-0">Nợ {formatVND(c.totalDebt)}</span>
          ) : (
            <span className="text-[10px] rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 whitespace-nowrap flex-shrink-0">Khách cũ</span>
          )}
        </button>
      ))}
    </div>
  );
}

function EditCustomerField({ customerId, value, phone, onChangeName, onChangePhone, onSelectCustomer, onClearCustomer }: {
  customerId: number | null;
  value: string;
  phone: string;
  onChangeName: (v: string) => void;
  onChangePhone: (v: string) => void;
  onSelectCustomer: (c: Customer) => void;
  onClearCustomer?: () => void;
}) {
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(customerId);
  const [lockedCustomerName, setLockedCustomerName] = useState(value);
  const [lockedCustomerPhone, setLockedCustomerPhone] = useState(phone);
  const hasMatch = selectedCustomerId != null && (value ?? "").trim() === (lockedCustomerName ?? "").trim() && String(phone ?? "").replace(/\D/g, "") === String(lockedCustomerPhone ?? "").replace(/\D/g, "");

  useEffect(() => {
    setSelectedCustomerId(customerId);
    setLockedCustomerName(value);
    setLockedCustomerPhone(phone);
  }, [customerId, value, phone]);

  const handleSelect = useCallback((c: Customer) => {
    setSelectedCustomerId(c.id);
    setLockedCustomerName(c.name);
    setLockedCustomerPhone(c.phone ?? "");
    onSelectCustomer(c);
  }, [onSelectCustomer]);

  const handleChangeName = useCallback((v: string) => {
    if (selectedCustomerId != null && v !== lockedCustomerName) setSelectedCustomerId(null);
    onChangeName(v);
  }, [lockedCustomerName, onChangeName, selectedCustomerId]);

  const handleChangePhone = useCallback((v: string) => {
    if (selectedCustomerId != null && v !== lockedCustomerPhone) {
      setSelectedCustomerId(null);
      onClearCustomer?.();
    }
    onChangePhone(v);
  }, [lockedCustomerPhone, onChangePhone, selectedCustomerId, onClearCustomer]);

  return (
    <>
      <Input value={value} onChange={e => handleChangeName(e.target.value)} placeholder="Tên khách" />
      <PhoneAutocomplete
        value={phone}
        onChange={handleChangePhone}
        onSelect={handleSelect}
      />
      {!hasMatch && <CustomerNameSuggest value={value} phone={phone} onSelect={handleSelect} />}
    </>
  );
}

// ─── Order line row ────────────────────────────────────────────────────────────
function fmtVND(n: number | null | undefined) {
  return ((n ?? 0) || 0).toLocaleString("vi-VN") + "đ";
}

type StaffRate = { staffId: number; role: string; taskKey: string; rate: number | null; rateType: string };
type RecentBooking = { id: number; shootDate: string | null; serviceLabel: string | null; serviceCategory: string | null; packageType: string | null; status: string; totalAmount: string | null };
type CastRatePkg = { id: number; staffId: number; role: string; packageId: number; amount: number | null };

function lookupRate(staffId: number | null, role: string, taskKey: string, rates: StaffRate[]): number {
  if (!staffId) return 0;
  const exact = rates.find(r => r.staffId === staffId && r.role === role && r.taskKey === taskKey && r.rate != null);
  if (exact) return exact.rateType === "percent" ? 0 : (exact.rate ?? 0);
  return 0;
}

function OrderLineRow({ line, photographers, makeupArtists, services, allStaffRates, allCastRates, allStaff, onChange, onRemove, isAdmin, bookingId, serviceBookingId, onUploadStart, onUploadEnd, hideConceptUpload }: {
  line: OrderLine;
  photographers: Staff[];
  makeupArtists: Staff[];
  services: ServiceOption[];
  allStaffRates: StaffRate[];
  allCastRates: CastRatePkg[];
  allStaff: Staff[];
  onChange: (u: OrderLine) => void;
  onRemove?: () => void;
  isAdmin: boolean;
  bookingId?: number | null;
  serviceBookingId?: number | null;
  /** Báo cho form cha biết dòng này đang tải ảnh (để khoá nút Lưu, tránh mất ảnh). */
  onUploadStart?: () => void;
  onUploadEnd?: () => void;
  /** Báo giá tạm tính: ẩn ô ảnh concept để không upload file lên storage khi chưa chắc thành show. */
  hideConceptUpload?: boolean;
}) {
  const [useCustom, setUseCustom] = useState(!line.serviceId && !line.serviceKey && !!line.serviceName);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);
  const uploadingConcept = uploadProgress !== null;
  const [uploadConceptError, setUploadConceptError] = useState<string | null>(null);
  const [failedConceptFiles, setFailedConceptFiles] = useState<File[]>([]);
  const [descExpanded, setDescExpanded] = useState(false);
  const conceptImgRef = useRef<HTMLInputElement>(null);
  // Giữ tham chiếu "line" mới nhất + cờ đang-tải để: (1) gắn ảnh theo bản mới nhất (không clobber
  // ghi chú), (2) giảm bộ đếm upload của form nếu dòng bị gỡ giữa chừng.
  const lineRef = useRef(line); lineRef.current = line;
  const conceptUploadingRef = useRef(false);
  const onUploadEndRef = useRef(onUploadEnd); onUploadEndRef.current = onUploadEnd;
  useEffect(() => () => { if (conceptUploadingRef.current) onUploadEndRef.current?.(); }, []);

  // Upload TỪNG ảnh concept; gắn objectPath vào state NGAY sau mỗi ảnh xong (không mất ảnh).
  // Báo form cha begin/end để khoá nút Lưu trong lúc tải. Ảnh lỗi → giữ lại để bấm Thử lại.
  const runConceptUpload = async (files: File[]) => {
    if (!files.length) return;
    conceptUploadingRef.current = true;
    onUploadStart?.();
    setUploadProgress({ current: 0, total: files.length });
    const baseImages = lineRef.current.conceptImages ?? [];
    const uploaded: string[] = [];
    const failed: File[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setUploadProgress({ current: i + 1, total: files.length });
        try {
          const res = await authFetch(`${BASE}/api/storage/uploads/request-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
          });
          const { uploadURL, objectPath } = await res.json();
          if (!uploadURL || !objectPath) throw new Error("Invalid response from storage service");
          const putRes = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
          if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
          uploaded.push(objectPath);
          // Gắn ngay vào state — giữ các field khác theo bản mới nhất (lineRef) để không đè ghi chú.
          onChange({ ...lineRef.current, conceptImages: [...baseImages, ...uploaded] });
        } catch (err) {
          console.error("Concept image upload failed:", err);
          failed.push(file);
        }
      }
      setFailedConceptFiles(failed);
      setUploadConceptError(failed.length ? `${failed.length} ảnh tải lỗi — bấm "Thử lại" để tải lại (ảnh đã tải vẫn được giữ).` : null);
    } finally {
      setUploadProgress(null);
      conceptUploadingRef.current = false;
      onUploadEnd?.();
    }
  };

  const selectedSvc = line.serviceKey ? services.find(s => s.key === line.serviceKey) : null;
  const isPkg = !!selectedSvc?.key?.startsWith("pkg-");

  // Extract packageId from serviceKey (format: "pkg-{id}")
  const packageId = selectedSvc?.key?.startsWith("pkg-") ? parseInt(selectedSvc.key.replace("pkg-", "")) : null;

  useEffect(() => {
    setDescExpanded(false);
  }, [line.serviceKey]);

  const staffRatesForResolve = useMemo(
    () => allStaffRates.map(r => ({ staffId: r.staffId, role: r.role, taskKey: r.taskKey, rate: r.rate })),
    [allStaffRates],
  );

  const staffResolveKey = (line.assignedStaff || [])
    .map(s => `${s.id}:${s.staffId}:${s.role}`)
    .join("|");

  useEffect(() => {
    if (!line.assignedStaff?.length) return;
    let changed = false;
    const next = line.assignedStaff.map(s => {
      // Giá tay (castSource='manual'): admin đã gõ đè — không auto-resolve đè lại.
      if (!s.staffId || !s.role || s.castSource === "manual") return s;
      const result = resolveCastAmount(
        s.staffId, s.role, line.baseJobType || "mac_dinh", packageId,
        allCastRates, staffRatesForResolve,
      );
      const amt = castAmountFromResult(result);
      const source = result.source;
      if (amt === (s.castAmount ?? 0) && source === (s.castSource ?? source)) return s;
      changed = true;
      return { ...s, castAmount: amt, castSource: source };
    });
    if (changed) onChange({ ...line, assignedStaff: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.serviceKey, packageId, allCastRates, staffRatesForResolve, staffResolveKey]);

  const actualPtsCastPkg = lookupCastByPkg(line.photoId, "photoshop", packageId, allCastRates);

  const staffCastFromAssignments = (line.assignedStaff || []).reduce(
    (s, a) => s + (Number(a.castAmount) || 0),
    0,
  );
  const ptsCast = line.photoId ? (actualPtsCastPkg ?? 0) : 0;

  // Chi phí cố định gói
  const printCost = selectedSvc?.printCost || 0;
  const operatingCost = selectedSvc?.operatingCost || 0;
  const salePercent = selectedSvc?.salePercent || 0;
  const saleAmt = Math.round(line.price * salePercent / 100);
  
  // Phí phát sinh cho gói này
  const surchargesTotal = (line.surcharges || []).reduce((s, i) => s + (i.amount || 0), 0);
  const deductionsTotal = (line.deductions || []).reduce((s, d) => s + (d.amount || 0), 0);
  
  const totalCost = staffCastFromAssignments + ptsCast + printCost + operatingCost + saleAmt + surchargesTotal;
  const effectiveRevenue = Math.max(0, line.price - deductionsTotal);
  const profit = effectiveRevenue - totalCost;

  // Addon state — computed from line.selectedAddons + selectedSvc.addons
  const availableAddons: Addon[] = selectedSvc?.addons || [];
  const selectedAddonObjs = availableAddons.filter(a => line.selectedAddons?.includes(a.key));
  const addonTotal = selectedAddonObjs.reduce((s, a) => s + a.price, 0);

  // Dịch vụ đơn: splits cũ
  const splits = (selectedSvc?.splits || []).filter(() => !isPkg);
  const photoSplit = splits.find(sp => sp.role === "photographer");
  const makeupSplit = splits.find(sp => sp.role === "makeup");
  function calcSplit(sp: ServiceSplit | undefined) {
    if (!sp) return 0;
    return sp.rateType === "percent" ? (line.price * sp.amount / 100) : sp.amount;
  }

  function handleSelectPackage(key: string) {
    setUseCustom(false);
    const svc = services.find(s => s.key === key);
    const idNum = key.startsWith("svc-") ? parseInt(key.replace("svc-", "")) : null;
    const noMakeup = svc?.includesMakeup === false;
    onChange({
      ...line,
      serviceId: idNum,
      serviceKey: key,
      serviceName: svc?.name ?? "",
      price: svc?.price ?? 0,
      basePrice: svc?.price ?? 0,
      selectedAddons: [],
      surcharges: [],
      deductions: [],
      baseJobType: "mac_dinh", // Reset to default when selecting new service
      // Tự xóa makeup khi chọn gói không có makeup
      ...(noMakeup ? { makeupId: null, makeupName: "", makeupTask: "" } : {}),
    });
  }

  function handleToggleAddon(addonKey: string, addonPrice: number) {
    const current = line.selectedAddons || [];
    const isSelected = current.includes(addonKey);
    const next = isSelected ? current.filter(k => k !== addonKey) : [...current, addonKey];
    const newAddonTotal = availableAddons.filter(a => next.includes(a.key)).reduce((s, a) => s + a.price, 0);
    onChange({ ...line, selectedAddons: next, price: (line.basePrice || 0) + newAddonTotal });
  }

  // Build a ServiceOption from current line for controlled state
  const currentServiceValue = selectedSvc ? {
    key: selectedSvc.key,
    id: line.serviceId ?? 0,
    name: selectedSvc.name,
    groupName: "",
    price: selectedSvc.price,
    serviceType: selectedSvc.serviceType,
    includesMakeup: selectedSvc.includesMakeup,
    photoCount: selectedSvc.photoCount,
    printCost: selectedSvc.printCost,
    operatingCost: selectedSvc.operatingCost,
    salePercent: selectedSvc.salePercent,
    addons: selectedSvc.addons,
    items: selectedSvc.items?.map(item => ({
      name: item.name,
      quantity: Number(item.quantity),
      unit: item.unit || "",
      notes: item.notes,
    })),
    products: selectedSvc.products,
    description: selectedSvc.description,
    notes: selectedSvc.notes,
  } : null;

  return (
    <div className="p-2.5 bg-muted/30 rounded-xl border border-border/50 space-y-2">
      {/* Chọn dịch vụ / gói — ServiceSearchBox */}
      <div className="flex gap-1.5 items-start">
        <div className="flex-1 min-w-0">
          <ServiceSearchBox
            value={useCustom ? null : currentServiceValue}
            onChange={svc => {
              if (!svc) { setUseCustom(false); onChange({ ...line, serviceId: null, serviceKey: "", serviceName: "", basePrice: 0, selectedAddons: [] }); return; }
              handleSelectPackage(svc.key);
            }}
            placeholder="Tìm gói / dịch vụ..."
            allowCustom
            onCustom={() => { setUseCustom(true); onChange({ ...line, serviceId: null, serviceKey: "", serviceName: "", basePrice: 0, selectedAddons: [] }); }}
          />
          {useCustom && (
            <Input className="h-9 text-sm mt-1.5" placeholder="Tên dịch vụ tự nhập..." value={line.serviceName} onChange={e => onChange({ ...line, serviceName: e.target.value })} />
          )}
        </div>
        <button onClick={onRemove} className="p-1.5 mt-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors flex-shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Gói: badge loại dịch vụ + số photo — chỉ hiện khi có serviceType */}
      {isPkg && selectedSvc?.serviceType && (() => {
        const typeLabel: Record<string, string> = {
          tiec: "🎊 Tiệc cưới",
          tiec_le: "🎊 Tiệc + Lễ",
          phong_su: "📸 Phóng sự",
          phong_su_luxury: "📸 Phóng sự luxury (2 photo)",
          combo_co_makeup: "💄 Combo có makeup",
          combo_khong_makeup: "👗 Combo không makeup",
          quay_phim: "🎬 Quay phim",
          beauty: "✨ Chụp Beauty",
          gia_dinh: "👨‍👩‍👧 Chụp Gia đình",
          makeup_le: "💋 Makeup lẻ",
          in_anh: "🖨️ In ảnh",
        };
        const label = typeLabel[selectedSvc.serviceType] ?? selectedSvc.serviceType;
        const photoN = selectedSvc?.photoCount ?? 1;
        const isNoPhoto = ["makeup_le", "in_anh"].includes(selectedSvc.serviceType ?? "");
        return (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 bg-indigo-100 text-indigo-700 text-[10px] font-semibold px-2 py-1 rounded-full">
              {label}
            </span>
            {/* Badge photographer — chỉ hiện cho gói chụp ảnh, không phải combo/makeup/in ảnh */}
            {!selectedSvc?.serviceType?.startsWith("combo") && !isNoPhoto && photoN > 0 && (
              <span className="inline-flex items-center gap-1 bg-sky-100 text-sky-700 text-[10px] font-semibold px-2 py-1 rounded-full">
                📷 {photoN} photographer
              </span>
            )}
          </div>
        );
      })()}

      {/* Gói: description + notes panel — thu gọn mặc định */}
      {isPkg && selectedSvc?.description && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
          <button
            type="button"
            onClick={() => setDescExpanded((v) => !v)}
            className="w-full flex items-center justify-between gap-2 text-left hover:opacity-80 transition-opacity"
            aria-expanded={descExpanded}
          >
            <p className="text-[10px] font-semibold text-amber-800">📋 Mô tả dịch vụ</p>
            <ChevronDown
              className={`w-3.5 h-3.5 text-amber-700 flex-shrink-0 transition-transform duration-200 ${descExpanded ? "rotate-180" : ""}`}
            />
          </button>
          {!descExpanded && (
            <p className="text-[10px] text-amber-600/80 mt-1 line-clamp-1 italic">
              {firstDescriptionLine(selectedSvc.description) || "Bấm mũi tên để xem chi tiết"}
            </p>
          )}
          {descExpanded && (
            <>
              <div className="space-y-1 mt-1.5">
                {reflowDescriptionLines(selectedSvc.description).map((descLine, i) => (
                  <p key={i} className="text-[10px] text-amber-700 leading-relaxed">{descLine}</p>
                ))}
              </div>
              {selectedSvc.notes && (
                <div className="mt-1.5 pt-1.5 border-t border-amber-200">
                  <p className="text-[10px] font-semibold text-amber-900 mb-0.5">⚠️ Lưu ý</p>
                  <p className="text-[10px] text-amber-800">{selectedSvc.notes}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Chọn nhân sự — Dynamic staff list (Task #487: phụ cấp inline trong từng dòng) */}
      <StaffAssignmentEditor
        value={line.assignedStaff}
        onChange={newStaff => onChange({ ...line, assignedStaff: newStaff })}
        staffOptions={allStaff.map(s => ({ id: s.id, name: s.name, roles: s.roles || [] }))}
        allStaffRates={allStaffRates.map(r => ({ staffId: r.staffId, role: r.role, taskKey: r.taskKey, rate: r.rate }))}
        allCastRates={allCastRates}
        packageId={packageId}
        baseJobType={line.baseJobType}
        bookingId={bookingId ?? null}
        serviceBookingId={serviceBookingId ?? null}
        canManualPrice={isAdmin}
      />

      {/* Phí phát sinh — Surcharges per package */}
      <SurchargeEditor 
        value={line.surcharges || []} 
        onChange={newSurcharges => onChange({ ...line, surcharges: newSurcharges })} 
      />

      {/* Giảm trừ dịch vụ — Deductions per package */}
      <DeductionEditor
        deductions={line.deductions || []}
        onChange={newDeductions => onChange({ ...line, deductions: newDeductions })}
      />

      {/* Addon */}
      {isPkg && availableAddons.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2">
          <p className="text-[10px] font-semibold text-amber-800 mb-1.5">➕ Tuỳ chọn gói</p>
          <div className="space-y-1">
            {availableAddons.map(addon => {
              const checked = line.selectedAddons?.includes(addon.key) ?? false;
              return (
                <label key={addon.key} className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleToggleAddon(addon.key, addon.price)}
                    className="w-3.5 h-3.5 accent-amber-600 cursor-pointer"
                  />
                  <span className={`text-[10px] flex-1 ${checked ? "text-amber-900 font-semibold" : "text-amber-700"}`}>{addon.name}</span>
                  <span className="text-[10px] text-amber-700 font-medium">+{fmtVND(addon.price)}</span>
                </label>
              );
            })}
          </div>
          {addonTotal > 0 && (
            <div className="mt-1.5 pt-1.5 border-t border-amber-200 flex justify-between text-[10px] font-semibold text-amber-800">
              <span>Addon cộng thêm</span><span>+{fmtVND(addonTotal)}</span>
            </div>
          )}
        </div>
      )}

      {/* Giá bán — khóa với gói, cho sửa với dịch vụ đơn */}
      <div className="flex items-end gap-3">
        <div>
          <p className="text-[10px] text-muted-foreground mb-1 flex items-center gap-1">
            <CreditCard className="w-3 h-3" /> Giá {isPkg ? "tổng" : "bán"} (đ)
            {isPkg && <span className="ml-1 bg-green-100 text-green-700 text-[9px] px-1 py-0.5 rounded font-semibold">Cố định tiệm</span>}
          </p>
          {isPkg ? (
            <div className="h-8 flex items-center px-3 bg-green-50 border border-green-200 rounded-lg text-sm font-bold text-green-700">
              {fmtVND(line.price)}
              {addonTotal > 0 && <span className="ml-2 text-[10px] text-amber-600 font-normal">({fmtVND(line.basePrice || 0)} + addon)</span>}
            </div>
          ) : (
            <CurrencyInput className="h-8 text-sm w-40" value={String(line.price || "")} placeholder="0"
              onChange={raw => onChange({ ...line, price: parseFloat(raw) || 0 })} />
          )}
        </div>
        {/* Dịch vụ đơn: studio giữ */}
        {!isPkg && line.price > 0 && splits.length > 0 && (
          <div className="text-[10px] text-muted-foreground pb-1">
            Studio giữ: <span className="font-semibold text-green-600">
              {fmtVND(line.price - calcSplit(photoSplit) - calcSplit(makeupSplit))}
            </span>
          </div>
        )}
      </div>

      {/* Ghi chú & Ảnh concept per dịch vụ */}
      <div className="space-y-2 border-t border-border/30 pt-2">
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">📝 Ghi chú / Yêu cầu dịch vụ này</p>
          <textarea
            value={line.notes ?? ""}
            onChange={e => onChange({ ...line, notes: e.target.value })}
            rows={2}
            placeholder="Ghi chú yêu cầu của khách cho dịch vụ này…"
            className="w-full text-xs border border-input rounded-lg px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary/20 resize-none"
          />
        </div>
        {!hideConceptUpload && <div>
          <p className="text-[10px] text-muted-foreground mb-1.5">🖼️ Ảnh concept ({(line.conceptImages ?? []).length})</p>
          {(line.conceptImages ?? []).length > 0 && (
            <div className="grid grid-cols-4 gap-1.5 mb-2">
              {(line.conceptImages ?? []).map((imgUrl, i) => {
                const src = getImageSrc(imgUrl);
                return src ? (
                  <div key={src} className="relative aspect-square">
                    <ConceptImage src={src} alt={`concept ${i + 1}`} className="w-full h-full object-cover rounded-lg" />
                    <button
                      type="button"
                      disabled={uploadingConcept}
                      onClick={() => onChange({ ...line, conceptImages: (line.conceptImages ?? []).filter((_, j) => j !== i) })}
                      className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 rounded-full flex items-center justify-center text-white hover:bg-destructive transition-colors disabled:opacity-40"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ) : null;
              })}
            </div>
          )}
          <button
            type="button"
            onClick={() => conceptImgRef.current?.click()}
            disabled={uploadingConcept}
            className="flex items-center gap-1.5 text-xs text-muted-foreground border border-dashed border-border rounded-lg px-2.5 py-1.5 hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
          >
            {uploadProgress
              ? <span>{uploadProgress.total} ảnh đã chọn — Đang tải {uploadProgress.current}/{uploadProgress.total}...</span>
              : <><Plus className="w-3 h-3" /> Thêm ảnh concept</>}
          </button>
          {uploadConceptError && (
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <p className="text-xs text-red-500">{uploadConceptError}</p>
              {failedConceptFiles.length > 0 && !uploadingConcept && (
                <button
                  type="button"
                  onClick={() => { const retry = failedConceptFiles; setFailedConceptFiles([]); void runConceptUpload(retry); }}
                  className="text-xs text-primary underline"
                >
                  Thử lại {failedConceptFiles.length} ảnh lỗi
                </button>
              )}
            </div>
          )}
          <input
            ref={conceptImgRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const MAX = 20;
              const rawFiles = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (!rawFiles.length) return;
              const files = rawFiles.slice(0, MAX);
              setUploadConceptError(rawFiles.length > MAX ? `Chỉ upload tối đa ${MAX} ảnh mỗi lần (đã chọn ${rawFiles.length}).` : null);
              setFailedConceptFiles([]);
              void runConceptUpload(files);
            }}
          />
        </div>}
      </div>

      {isAdmin && isPkg && line.price > 0 && (
        <div className="text-[11px] rounded-lg border overflow-hidden">
          <div className="bg-emerald-600 text-white px-3 py-1.5 flex justify-between items-center">
            <span className="font-bold">📊 Dự tính lợi nhuận</span>
            <span className={`font-bold text-sm ${profit >= 0 ? "text-emerald-100" : "text-red-200"}`}>
              {profit >= 0 ? "+" : ""}{fmtVND(profit)}
            </span>
          </div>
          <div className="bg-white px-3 py-1">
            <div className="flex justify-between font-semibold text-emerald-700 text-[10px]">
              <span>💵 Doanh thu</span><span>{fmtVND(line.price)}</span>
            </div>
            {deductionsTotal > 0 && (
              <div className="flex justify-between text-red-600 text-[10px]">
                <span>⬇ Giảm trừ dịch vụ</span><span>−{fmtVND(deductionsTotal)}</span>
              </div>
            )}
            {deductionsTotal > 0 && (
              <div className="flex justify-between font-semibold text-emerald-700 text-[10px] border-t border-emerald-100 pt-0.5">
                <span>= Thực thu</span><span>{fmtVND(effectiveRevenue)}</span>
              </div>
            )}
          </div>
          <div className="bg-red-50 px-3 py-1.5 space-y-0.5 text-[10px]">
            <p className="font-semibold text-red-800">(-) Chi phí sản xuất</p>
            {(line.assignedStaff || []).filter(s => (s.castAmount ?? 0) > 0).map(s => (
              <div key={s.id} className="flex justify-between text-red-700">
                <span>{s.staffName || "—"} ({s.role})</span>
                <span>{fmtVND(s.castAmount ?? 0)}</span>
              </div>
            ))}
            {ptsCast > 0 && (
              <div className="flex justify-between text-purple-700">
                <span>🖥️ PTS chỉnh ảnh</span>
                <span>{fmtVND(ptsCast)}</span>
              </div>
            )}
            {printCost > 0 && <div className="flex justify-between text-red-700"><span>🖨️ In ấn</span><span>{fmtVND(printCost)}</span></div>}
            {operatingCost > 0 && <div className="flex justify-between text-red-700"><span>⚡ Vận hành</span><span>{fmtVND(operatingCost)}</span></div>}
            {saleAmt > 0 && <div className="flex justify-between text-red-700"><span>💼 Sale {salePercent}%</span><span>{fmtVND(saleAmt)}</span></div>}
            <div className="flex justify-between font-semibold text-red-800 border-t border-red-200 pt-0.5">
              <span>Tổng chi phí</span><span>{fmtVND(totalCost)}</span>
            </div>
          </div>
          <div className={`px-3 py-1.5 flex justify-between font-bold text-[11px] ${profit >= 0 ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>
            <span>= Lợi nhuận</span>
            <span>{profit >= 0 ? "+" : ""}{fmtVND(profit)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Allowance labels (Task #487: phụ cấp đã chuyển inline trong StaffAssignmentEditor)
const ALLOWANCE_TYPE_LABELS: Record<string, string> = {
  di_xa: "Đi xa", tang_ca: "Tăng ca", xang_xe: "Xăng xe",
  gui_xe: "Gửi xe", an_uong: "Ăn uống", khac: "Khác",
};

// ─── Show form (create / edit booking) ────────────────────────────────────────
function ShowFormPanel({
  date, initialTime = "07:00", onDateChange, booking, onClose, onSaved, siblingBookings = [], isAdmin, viewerId,
}: {
  date: Date;
  initialTime?: string;
  onDateChange: (d: Date) => void;
  booking: Booking | null;
  onClose: () => void;
  /** savedDate (YYYY-MM-DD) = ngày chính vừa lưu — calendar nhảy thẳng tới ngày đó. */
  onSaved: (savedDate?: string) => void;
  siblingBookings?: Booking[];
  isAdmin: boolean;
  viewerId?: number | null;
}) {
  const qc = useQueryClient();
  const isEdit = !!booking;

  const [phone, setPhone] = useState(booking?.customerPhone ?? "");
  const [customerName, setCustomerName] = useState(booking?.customerName ?? "");
  const [customerId, setCustomerId] = useState<number | null>(booking?.customerId ?? null);
  const [selectedCustomerRank, setSelectedCustomerRank] = useState<string | null>(booking?.customerRank ?? null);
  const [facebook, setFacebook] = useState("");
  const [zalo, setZalo] = useState("");
  const [avatar, setAvatar] = useState<string>("");
  const [showExtra, setShowExtra] = useState(false);
  const [recentBookings, setRecentBookings] = useState<RecentBooking[]>([]);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const matchedNameRef = useRef(booking?.customerName ?? "");
  const matchedPhoneRef = useRef(booking?.customerPhone ?? "");
  const recentBookingsForIdRef = useRef<number | null>(null);

  const [shootDate, setShootDateLocal] = useState(() => format(date, "yyyy-MM-dd"));
  const shootDateObj = useMemo(() => {
    try { const d = parseISO(shootDate); return isNaN(d.getTime()) ? date : d; } catch { return date; }
  }, [shootDate, date]);
  const [location, setLocation] = useState(booking?.location ?? "");
  const [status, setStatus] = useState(booking?.status ?? "confirmed");

  const handleShootDateChange = (newVal: string) => {
    setShootDateLocal(newVal);
    try {
      const parsed = parseISO(newVal);
      if (!isNaN(parsed.getTime())) onDateChange(parsed);
    } catch { /* ignore */ }
  };


  const [deposit, setDeposit] = useState(booking?.depositAmount?.toString() ?? "0");
  const [depositMethod, setDepositMethod] = useState<"cash" | "bank_transfer">("cash");
  // Ngày + giờ cọc = thời điểm thực tế studio nhận tiền (KHÔNG lấy theo shootDate).
  // Ưu tiên: payments[deposit].paidAt → paidDate → fallback bây giờ (chỉ khi tạo mới).
  const { initialDepositDate, initialDepositTime } = (() => {
    const pmts = (booking as unknown as { payments?: Array<{ paymentType?: string; paidDate?: string | null; paidAt?: string | null }> })?.payments;
    const dep = Array.isArray(pmts) ? pmts.find(p => p.paymentType === "deposit") : null;
    if (dep?.paidAt) {
      const d = new Date(dep.paidAt);
      if (!isNaN(d.getTime())) {
        return { initialDepositDate: format(d, "yyyy-MM-dd"), initialDepositTime: format(d, "HH:mm") };
      }
    }
    if (dep?.paidDate) {
      return { initialDepositDate: String(dep.paidDate).slice(0, 10), initialDepositTime: "" };
    }
    if (booking) return { initialDepositDate: "", initialDepositTime: "" };
    const now = new Date();
    return { initialDepositDate: format(now, "yyyy-MM-dd"), initialDepositTime: format(now, "HH:mm") };
  })();
  const [depositDate, setDepositDate] = useState(initialDepositDate);
  const [depositTime, setDepositTime] = useState(initialDepositTime);
  const initialDepositDateRef = useRef(initialDepositDate);
  const initialDepositTimeRef = useRef(initialDepositTime);

  // CỌC (tạo show mới): ngày + giờ cọc mặc định theo THỜI ĐIỂM HIỆN TẠI, chỉ tự điền khi đang trống
  // → không bao giờ đè giá trị user đã gõ. KHÔNG suy theo ngày chụp (dời show không đổi ngày cọc);
  // muốn đổi thì sửa tay. Edit show có cọc cũ thì giữ nguyên (đã xử lý ở init + fetch riêng).
  useEffect(() => {
    if (isEdit) return;
    if (parseFloat(deposit) > 0) {
      const now = new Date();
      if (!depositDate) setDepositDate(format(now, "yyyy-MM-dd"));
      if (!depositTime) setDepositTime(format(now, "HH:mm"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deposit, isEdit]);

  // Khi edit show, Booking type không kèm payments → fetch riêng để preload đúng
  // ngày + giờ cọc gốc. Cập nhật cả state lẫn ref để so sánh "user đã sửa?" chính xác,
  // tránh trường hợp ô trống → user nghĩ chưa có cọc → vô tình đè lên giá trị gốc.
  useEffect(() => {
    if (!isEdit || !booking?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(`${BASE}/api/payments?bookingId=${booking.id}`);
        if (!res.ok) return;
        const list = await res.json();
        if (cancelled || !Array.isArray(list)) return;
        const dep = list.find((p: { paymentType?: string }) => p.paymentType === "deposit") as
          { id?: number; paymentType?: string; paidDate?: string | null; paidAt?: string | null; proofImageUrl?: string | null; proofImageUrls?: string[] | null } | undefined;
        if (!dep) return;
        // Nạp ảnh bằng chứng cọc đang có để form sửa show hiển thị lại (đã bị ẩn từ bản money-source-of-truth).
        if (dep.id != null) setDepositPaymentId(Number(dep.id));
        setEditDepositProofs(
          Array.isArray(dep.proofImageUrls) && dep.proofImageUrls.length
            ? dep.proofImageUrls
            : (dep.proofImageUrl ? [dep.proofImageUrl] : []),
        );
        let isoDate = "";
        let isoTime = "";
        if (dep.paidAt) {
          const d = new Date(dep.paidAt);
          if (!isNaN(d.getTime())) {
            isoDate = format(d, "yyyy-MM-dd");
            isoTime = format(d, "HH:mm");
          }
        }
        if (!isoDate && dep.paidDate) {
          isoDate = String(dep.paidDate).slice(0, 10);
        }
        if (!isoDate) return;
        setDepositDate(prev => (prev ? prev : isoDate));
        setDepositTime(prev => (prev ? prev : isoTime));
        if (!initialDepositDateRef.current) initialDepositDateRef.current = isoDate;
        if (!initialDepositTimeRef.current) initialDepositTimeRef.current = isoTime;
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, booking?.id]);

  // Load existing booking-dresses when editing — THEO TỪNG DỊCH VỤ.
  // Đơn nhiều dịch vụ: váy của child booking nào về đúng dịch vụ đó. DATA CŨ (váy còn gắn ở
  // booking CHA vì bug dùng chung trước đây): dồn tạm vào Dịch vụ 1 để KHÔNG mất data — admin
  // phân bổ lại rồi bấm Cập nhật là váy được lưu vào đúng child (cha được dọn khi lưu).
  useEffect(() => {
    if (!booking?.id) { setOutfitsBySub({}); setOutfitsLoaded(true); return; } // đơn MỚI: không có gì để load
    let cancelled = false;
    setOutfitsLoaded(false);
    (async () => {
      try {
        const genTempId = () => Math.random().toString(36).slice(2);
        const fetchDrafts = async (bid: number): Promise<OutfitDraft[]> => {
          const r = await authFetch(`${BASE}/api/bookings/${bid}/dresses`);
          if (!r.ok) throw new Error(`Lỗi tải trang phục booking ${bid}`);
          const rows = await r.json();
          return Array.isArray(rows)
            ? rows.map((row: Record<string, unknown>) => mapDressRowToDraft(row, genTempId) as OutfitDraft)
            : [];
        };
        const subs = subDrafts.map(s => ({ key: s.id, siblingId: s.siblingId ?? null }));
        const rawParent = await fetchDrafts(booking.id);
        const bySibling: Record<number, OutfitDraft[]> = {};
        for (const s of subs) {
          if (s.siblingId != null) bySibling[s.siblingId] = await fetchDrafts(s.siblingId);
        }
        if (cancelled) return;
        // Váy cha (data cũ): bỏ bản trùng đã copy dở xuống child DV1 (retry) + đánh dấu fromParent
        // để khi user xoá card thì váy legacy được chuyển card, không bị dọn mất.
        const firstChild = subs[0]?.siblingId != null ? (bySibling[subs[0].siblingId] ?? []) : [];
        const parentOutfits = dedupeParentOutfits(rawParent, firstChild).map(d => ({ ...d, fromParent: true }));
        const { bySubKey } = splitOutfitsBySub(subs, bySibling, parentOutfits);
        setOutfitsBySub(bySubKey);
        setOutfitsLoaded(true);
      } catch {
        // Load lỗi: KHÔNG set loaded ⇒ lượt save này bỏ qua sync trang phục (không xoá nhầm data).
        if (!cancelled) setOutfitsBySub({});
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking?.id]);
  const [depositProofImages, setDepositProofImages] = useState<string[]>([]);
  // EDIT mode (show đã có cọc, số tiền khóa): vẫn cho XEM + THÊM ảnh bằng chứng cọc.
  // Ảnh gắn thẳng vào payment cọc qua PATCH /payments/:id → KHÔNG đụng số tiền (tránh lệch tiền).
  const [depositPaymentId, setDepositPaymentId] = useState<number | null>(null);
  const [editDepositProofs, setEditDepositProofs] = useState<string[]>([]);
  const [savingDepositProof, setSavingDepositProof] = useState(false);
  const [depositProofError, setDepositProofError] = useState("");
  const [discount, setDiscount] = useState(booking?.discountAmount?.toString() ?? "0");
  const [notes, setNotes] = useState(booking?.notes ?? "");
  // Setting nhắc thuê đồ per booking ("" = mặc định: lấy trước 3 ngày / trả sau 2 ngày).
  // Chỉ có tác dụng khi gói thuộc nhóm bảng giá đã gạt "Thuê đồ". Thuần lịch nhắc, không đụng tiền.
  const [dressWarnPickupDays, setDressWarnPickupDays] = useState<string>(() => booking?.dressWarnPickupDays != null ? String(booking.dressWarnPickupDays) : "");
  const [dressWarnReturnDays, setDressWarnReturnDays] = useState<string>(() => booking?.dressWarnReturnDays != null ? String(booking.dressWarnReturnDays) : "");
  // Giữ lại giá trị photoCount cũ của show (để lưu lại không bị mất); ô nhập đã bỏ khỏi form.
  const [photoCount] = useState<string>(() => String(booking?.photoCount ?? ""));
  const [surcharges, setSurcharges] = useState<SurchargeItem[]>(() => {
    const raw = booking?.surcharges ?? [];
    return raw.map((s: { name: string; amount: number }, i: number) => ({ id: `s${i}`, ...s }));
  });
  const [error, setError] = useState("");
  const [proofWarning, setProofWarning] = useState("");
  const [saving, setSaving] = useState(false);
  // ── Báo giá tạm tính — MỘT toggle duy nhất, nguồn chân lý = bookings.status.
  // Tạo mới: bật để lưu thành báo giá (mã BG, không countable). Sửa: admin bật/
  // tắt bất kỳ lúc nào — backend flip cả GIA ĐÌNH (cha + con) trong 1 transaction.
  // Không khóa, không tạo/xóa record, đổi qua lại bao nhiêu lần cũng được.
  const [tempQuoteMode, setTempQuoteMode] = useState(booking?.status === "temp_quote");
  const initialTempQuoteRef = useRef(booking?.status === "temp_quote");
  const { toast } = useToast();
  // ── Lưới an toàn upload ảnh ──────────────────────────────────────────────────
  // Đếm số ảnh đang tải ở các dòng dịch vụ (ảnh concept). Khi > 0 thì KHOÁ nút Lưu
  // để tránh bấm "Cập nhật/Lưu show" lúc ảnh chưa upload xong → mất ảnh (bug đã gặp).
  const [activeUploads, setActiveUploads] = useState(0);
  const isUploadingImages = activeUploads > 0;
  const beginUpload = useCallback(() => setActiveUploads(n => n + 1), []);
  const endUpload = useCallback(() => setActiveUploads(n => Math.max(0, n - 1)), []);
  // Cảnh báo khi rời trang / reload lúc ảnh đang tải (tránh mất ảnh).
  useEffect(() => {
    if (!isUploadingImages) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isUploadingImages]);
  // Trang phục THEO TỪNG DỊCH VỤ — key = sub.id (SubServiceDraft). Trước đây là 1 mảng dùng
  // chung cho cả form ⇒ thêm váy ở Dịch vụ 1 thì mọi dịch vụ khác hiện y chang (bug).
  const [outfitsBySub, setOutfitsBySub] = useState<Record<string, OutfitDraft[]>>({});
  // Chỉ cho phép SYNC trang phục khi đã load thành công — load lỗi mà vẫn save sẽ sync mảng rỗng
  // ⇒ xoá nhầm váy thật trong DB (review finding #5).
  const [outfitsLoaded, setOutfitsLoaded] = useState(false);
  const hasSiblingEdit = siblingBookings.length > 0;

  // ── Service blocks (unified: single or multi-service) ────────────────────
  const emptyOrderLine = (): OrderLine => ({
    tempId: genId(), serviceName: "", serviceId: null, serviceKey: "",
    price: 0, basePrice: 0, selectedAddons: [], surcharges: [], deductions: [],
    baseJobType: "mac_dinh", // Default job type for staff rates lookup
    photoId: null, photoName: "", photoTask: "",
    makeupId: null, makeupName: "", makeupTask: "",
    assignedStaff: [],
    notes: "", conceptImages: [],
  });
  // Dòng "có nhân sự thật": có entry đã chọn người (staffId hoặc tên). Entry
  // placeholder rỗng (bấm "+ Thêm nhân sự" rồi bỏ dở) KHÔNG tính. Item legacy
  // không có mảng assignedStaff thì xét photoId/makeupId; còn khi mảng tồn tại
  // (kể cả rỗng do user gỡ hết người) thì KHÔNG xét photoId cũ còn sót — để gỡ
  // phân công xong, dòng chưa chốt gói lại bị loại khỏi items như trước.
  const lineHasStaff = (l: OrderLine): boolean =>
    Array.isArray(l.assignedStaff)
      ? l.assignedStaff.some(s => !!s.staffId || !!(s.staffName || "").trim())
      : !!(l.photoId || l.makeupId);
  const makeSubDraft = (defaultDate: string, defaultTime: string): SubServiceDraft => {
    const rawItems: OrderLine[] = booking?.items?.length
      ? booking.items.map(i => ({ ...i, tempId: genId() }))
      : [emptyOrderLine()];

    if (booking && rawItems.length > 0) {
      const extraStaff: StaffAssignment[] = [];
      const seenKeys = new Set<string>();
      // PER-ROLE check: nếu items[0].assignedStaff đã có ENTRY với role này
      // (kể cả người khác), KHÔNG inject thêm từ taskAssignees/booking-level —
      // tránh hiển thị tên cũ từ tasks table khi user đã đổi nhân sự ở items[].
      const seenRoles = new Set<string>();
      for (const item of rawItems) {
        if (Array.isArray(item.assignedStaff)) {
          for (const sa of item.assignedStaff) {
            const cr = canonicalRole(sa.role);
            seenKeys.add(sa.staffId ? `${cr}:${sa.staffId}` : `${cr}:${sa.staffName}`);
            seenRoles.add(cr);
          }
        }
      }
      const addExtra = (role: string, staffId: number | null, staffName: string) => {
        const cr = canonicalRole(role);
        if (cr === "sales" || cr === "photoshop") return;
        if (seenRoles.has(cr)) return; // role đã có entry, không inject thêm
        const key = staffId ? `${cr}:${staffId}` : `${cr}:${staffName}`;
        if (!staffName || seenKeys.has(key)) return;
        seenKeys.add(key);
        extraStaff.push({ id: genId(), staffId, staffName, role: cr, castAmount: 0 });
      };
      if (Array.isArray(booking.assignedStaff)) {
        for (const sa of booking.assignedStaff as StaffAssignment[]) {
          if (sa.role && sa.staffName) addExtra(sa.role, sa.staffId ?? null, sa.staffName);
        }
      }
      if (Array.isArray((booking as any).taskAssignees)) {
        for (const ta of (booking as any).taskAssignees as { role?: string | null; taskType?: string | null; assigneeName?: string }[]) {
          if (ta.assigneeName) addExtra(ta.role ?? ta.taskType ?? "", null, ta.assigneeName);
        }
      }
      if (extraStaff.length > 0) {
        const first = rawItems[0];
        rawItems[0] = { ...first, assignedStaff: [...(first.assignedStaff || []), ...extraStaff] };
      }
    }

    return {
      id: genId(), serviceLabel: "", shootDate: defaultDate, shootTime: defaultTime,
      items: rawItems,
      photoId: null, photoName: "", photoTask: "",
      makeupId: null, makeupName: "", makeupTask: "",
      notes: booking?.notes ?? "",
      additionalServices: Array.isArray(booking?.additionalServices) ? booking!.additionalServices!.map(l => ({ ...l })) : [],
      occurrences: Array.isArray(booking?.occurrences)
        ? booking!.occurrences!.map(o => ({ id: o.id, shootDate: (o.shootDate || "").slice(0, 10), shootTime: (o.shootTime || "").slice(0, 5), label: o.label || "" }))
        : [],
    };
  };
  const [subDrafts, setSubDrafts] = useState<SubServiceDraft[]>(() => siblingBookings.length > 0 ? siblingBookings.map(sib => {
    const rawItems: OrderLine[] = sib.items?.length ? sib.items.map(i => ({ ...i, tempId: genId() })) : [emptyOrderLine()];

    const extraStaff: StaffAssignment[] = [];
    const seenStaffIds = new Set<number>();
    const seenKeys = new Set<string>();
    // PER-ROLE check (cùng lý do như makeSubDraft): role đã có entry rồi
    // thì không inject thêm từ booking/task assignees cũ.
    const seenRoles = new Set<string>();
    for (const item of rawItems) {
      if (Array.isArray(item.assignedStaff)) {
        for (const sa of item.assignedStaff) {
          if (sa.staffId) seenStaffIds.add(sa.staffId);
          const cr = canonicalRole(sa.role);
          seenKeys.add(`${cr}:${sa.staffId ?? sa.staffName}`);
          seenRoles.add(cr);
        }
      }
    }
    const addExtra = (role: string, staffId: number | null, staffName: string, castAmt = 0) => {
      const cr = canonicalRole(role);
      if (cr === "sales" || cr === "photoshop") return;
      if (!staffName) return;
      if (seenRoles.has(cr)) return; // role đã có entry, không inject thêm
      if (staffId && seenStaffIds.has(staffId)) return;
      const key = `${cr}:${staffId ?? staffName}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      if (staffId) seenStaffIds.add(staffId);
      extraStaff.push({ id: genId(), staffId, staffName, role: cr, castAmount: castAmt });
    };
    if (Array.isArray(sib.assignedStaff)) {
      for (const sa of sib.assignedStaff as StaffAssignment[]) {
        if (sa.role && sa.staffName) addExtra(sa.role, sa.staffId ?? null, sa.staffName);
      }
    }
    if (booking && Array.isArray(booking.assignedStaff)) {
      for (const sa of booking.assignedStaff as StaffAssignment[]) {
        if (sa.role && sa.staffName) addExtra(sa.role, sa.staffId ?? null, sa.staffName, sa.castAmount ?? 0);
      }
    }
    if (Array.isArray((sib as any).taskAssignees)) {
      for (const ta of (sib as any).taskAssignees as { role?: string | null; taskType?: string | null; assigneeName?: string }[]) {
        if (ta.assigneeName) addExtra(ta.role ?? ta.taskType ?? "", null, ta.assigneeName);
      }
    }
    if (booking && Array.isArray((booking as any).taskAssignees)) {
      for (const ta of (booking as any).taskAssignees as { role?: string | null; taskType?: string | null; assigneeName?: string }[]) {
        if (ta.assigneeName) addExtra(ta.role ?? ta.taskType ?? "", null, ta.assigneeName);
      }
    }
    if (extraStaff.length > 0 && rawItems.length > 0) {
      const first = rawItems[0];
      rawItems[0] = { ...first, assignedStaff: [...(first.assignedStaff || []), ...extraStaff] };
    }

    return {
      id: genId(),
      siblingId: sib.id,
      serviceLabel: sib.serviceLabel || sib.packageType || "",
      shootDate: sib.shootDate || format(date, "yyyy-MM-dd"),
      shootTime: sib.shootTime || "08:00",
      items: rawItems,
      photoId: null, photoName: "", photoTask: "",
      makeupId: null, makeupName: "", makeupTask: "",
      notes: sib.notes ?? "",
      additionalServices: Array.isArray((sib as Booking).additionalServices) ? (sib as Booking).additionalServices!.map(l => ({ ...l })) : [],
      occurrences: Array.isArray((sib as Booking).occurrences)
        ? (sib as Booking).occurrences!.map(o => ({ id: o.id, shootDate: (o.shootDate || "").slice(0, 10), shootTime: (o.shootTime || "").slice(0, 5), label: o.label || "" }))
        : [],
    };
  }) : [makeSubDraft(format(date, "yyyy-MM-dd"), initialTime)]);
  const updateSubDraft = (id: string, patch: Partial<SubServiceDraft>) =>
    setSubDrafts(p => p.map(s => s.id === id ? { ...s, ...patch } : s));
  const addSubDraft = () =>
    setSubDrafts(p => [...p, { id: genId(), serviceLabel: "", shootDate: shootDate, shootTime: "08:00", items: [emptyOrderLine()], photoId: null, photoName: "", photoTask: "", makeupId: null, makeupName: "", makeupTask: "", notes: "", additionalServices: [], occurrences: [] }]);

  const { data: allStaff = [] } = useQuery<Staff[]>({ queryKey: ["staff-assignable"], queryFn: () => authFetch(`${BASE}/api/staff/assignable`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []) });
  const { data: services = [] } = useQuery<Service[]>({ queryKey: ["services"], queryFn: () => authFetch(`${BASE}/api/services`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []) });
  const { data: pricingPackages = [] } = useQuery<{
    id: number; name: string; price: number;
    printCost: number; operatingCost: number; salePercent: number;
    items?: PkgItem[]; addons?: Addon[]; products?: string[]; description?: string | null; notes?: string | null;
    serviceType?: string | null; photoCount?: number | null; includesMakeup?: boolean;
  }[]>({ queryKey: ["service-packages"], queryFn: () => authFetch(`${BASE}/api/service-packages`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []) });
  const { data: allStaffRates = [] } = useQuery<StaffRate[]>({ queryKey: ["staff-rates"], queryFn: () => authFetch(`${BASE}/api/staff-rates`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []) });
  const { data: allCastRates = [] } = useQuery<CastRatePkg[]>({ queryKey: ["staff-cast-all"], queryFn: () => authFetch(`${BASE}/api/staff-cast`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []), staleTime: 60_000 });

  // Support both old single-role and new multi-role staff
  const hasRole = (s: Staff, role: string) => s.roles?.includes(role) || s.role === role;
  const photographers = allStaff.filter(s => s.isActive && hasRole(s, "photographer"));
  const makeupArtists = allStaff.filter(s => s.isActive && hasRole(s, "makeup"));
  // Người sale: bất kỳ nhân viên active nào (không filter theo role "sale")
  const saleStaff = allStaff.filter(s => s.isActive);
  const photoshopStaff = allStaff.filter(s => s.isActive && hasRole(s, "photoshop"));

  // Booking-level role assignments
  const getAssignedObj = () => {
    const as = booking?.assignedStaff;
    if (as && !Array.isArray(as) && typeof as === "object") return as as Record<string, number>;
    return {};
  };
  const [saleId, setSaleId] = useState<number | null>(() => {
    const legacyVal = getAssignedObj().sale;
    if (legacyVal) { const n = Number(legacyVal); if (!isNaN(n) && n > 0) return n; }
    // Also read from new StaffAssignment array format
    if (Array.isArray(booking?.assignedStaff)) {
      const entry = (booking!.assignedStaff as { role?: string; staffId?: unknown }[]).find(a => a.role === "sales");
      if (entry?.staffId != null) { const n = Number(entry.staffId); if (!isNaN(n) && n > 0) return n; }
    }
    return null;
  });
  const [saleTask, setSaleTask] = useState<string>(() => {
    const legacyTask = getAssignedObj().saleTask;
    if (legacyTask) return String(legacyTask);
    if (Array.isArray(booking?.assignedStaff)) {
      const entry = (booking!.assignedStaff as { role?: string; taskKey?: string }[]).find(a => a.role === "sales");
      if (entry?.taskKey) return entry.taskKey;
    }
    return "mac_dinh";
  });
  const [photoshopId, setPhotoshopId] = useState<number | null>(() => {
    const legacyVal = getAssignedObj().photoshop;
    if (legacyVal) { const n = Number(legacyVal); if (!isNaN(n) && n > 0) return n; }
    if (Array.isArray(booking?.assignedStaff)) {
      const entry = (booking!.assignedStaff as { role?: string; staffId?: unknown }[]).find(a => a.role === "photoshop");
      if (entry?.staffId != null) { const n = Number(entry.staffId); if (!isNaN(n) && n > 0) return n; }
    }
    return null;
  });
  const [photoshopTask, setPhotoshopTask] = useState<string>(() => {
    const legacyTask = getAssignedObj().photoshopTask;
    if (legacyTask) return String(legacyTask);
    if (Array.isArray(booking?.assignedStaff)) {
      const entry = (booking!.assignedStaff as { role?: string; taskKey?: string }[]).find(a => a.role === "photoshop");
      if (entry?.taskKey) return entry.taskKey;
    }
    return "mac_dinh";
  });
  const allServices: ServiceOption[] = [
    ...services.map(s => ({ key: `svc-${s.id}`, name: s.name, price: s.price, splits: s.splits || [] })),
    ...pricingPackages.map(p => ({
      key: `pkg-${p.id}`, name: p.name, price: p.price, splits: [],
      printCost: p.printCost || 0, operatingCost: p.operatingCost || 0, salePercent: p.salePercent || 0,
      items: p.items || [], addons: p.addons || [], products: p.products || [],
      serviceType: p.serviceType ?? null,
      photoCount: p.photoCount ?? null,
      includesMakeup: p.includesMakeup !== false,
      description: p.description ?? null,
      notes: p.notes ?? null,
    })),
  ];

  const calcSubPackageTotal = (items: OrderLine[]) => items.reduce((si, l) => {
    const lineSurchTotal = (l.surcharges || []).reduce((ls, sc) => ls + (sc.amount || 0), 0);
    const lineDeductTotal = (l.deductions || []).reduce((ld, d) => ld + (d.amount || 0), 0);
    return si + Math.max(0, (l.price || 0) + lineSurchTotal - lineDeductTotal);
  }, 0);
  const cleanAdditionalServicesForSave = (services: AdditionalServiceLine[]) =>
    (services || []).filter(l => (l.title || "").trim() && (l.unitPrice || 0) > 0);
  const calcSubExtrasTotal = (services: AdditionalServiceLine[]) =>
    cleanAdditionalServicesForSave(services).reduce(
      (x, l) => x + (l.totalPrice || Math.round((l.qty || 0) * (l.unitPrice || 0))),
      0,
    );
  const subDraftsTotal = subDrafts.reduce((s, sub) => s + calcSubPackageTotal(sub.items), 0);
  const extrasTotal = subDrafts.reduce((s, sub) => s + calcSubExtrasTotal(sub.additionalServices || []), 0);
  const packageTotal = subDraftsTotal;
  const totalAmount = packageTotal + extrasTotal;
  const extrasFormValidation = validateAdditionalServicesForm(
    subDrafts.flatMap(s => s.additionalServices || []).filter(l => (l.title || "").trim()),
  );
  const depositNum = parseFloat(deposit) || 0;
  const discountNum = parseFloat(discount) || 0;
  const afterDiscount = Math.max(0, totalAmount - discountNum);
  // ── Đồng bộ tiền ───────────────────────────────────────────────────────────
  // Khi SỬA đơn đã có thu tiền: dùng TỔNG ĐÃ THU thực tế (booking.paidAmount = tổng lịch sử
  // thanh toán, do API tính), KHÔNG dùng cọc ban đầu → tránh "Còn lại" hiển thị sai.
  // Tạo mới (hoặc sửa đơn chưa thu) thì vẫn dùng ô "Đặt cọc" như cũ.
  const actualPaid = Number(booking?.paidAmount ?? 0) || 0;
  const showActualPaid = isEdit && actualPaid > 0;
  const effectivePaid = showActualPaid ? actualPaid : depositNum;
  const remaining = Math.max(0, afterDiscount - effectivePaid);

  // ── Báo giá tạm tính: dựng text gửi khách + chuyển thành show thật ─────────
  const buildQuoteText = () => {
    const fmtDate = (d?: string | null) => (d ? d.split("-").reverse().join("/") : "");
    const out: string[] = ["Dạ em gửi mình báo giá tạm tính bên Amazing Studio ạ:"];
    if (customerName.trim()) out.push(`Khách: ${customerName.trim()}`);
    for (const sub of subDrafts) {
      const when = [fmtDate(sub.shootDate), sub.shootTime].filter(Boolean).join(" · ");
      for (const l of sub.items) {
        if (!(l.serviceName || "").trim() && !(l.price || 0)) continue;
        const lineSurch = (l.surcharges || []).reduce((s, sc) => s + (sc.amount || 0), 0);
        const lineDeduct = (l.deductions || []).reduce((s, d) => s + (d.amount || 0), 0);
        const lineTotal = Math.max(0, (l.price || 0) + lineSurch - lineDeduct);
        out.push(`• ${(l.serviceName || "Dịch vụ").trim()}${when ? ` — ${when}` : ""}: ${formatVND(lineTotal)}`);
      }
      for (const a of cleanAdditionalServicesForSave(sub.additionalServices || [])) {
        const aTotal = a.totalPrice || Math.round((a.qty || 0) * (a.unitPrice || 0));
        out.push(`• ${(a.title || "").trim()}${(a.qty || 0) > 1 ? ` x${a.qty}` : ""}: ${formatVND(aTotal)}`);
      }
    }
    out.push(`Tổng dịch vụ: ${formatVND(totalAmount)}`);
    if (discountNum > 0) out.push(`Giảm giá: -${formatVND(discountNum)}`);
    out.push(`TỔNG TẠM TÍNH: ${formatVND(afterDiscount)}`);
    out.push("(*) Báo giá tạm tính, chưa phải hợp đồng chính thức — giá có thể thay đổi theo dịch vụ thực tế.");
    return out.join("\n");
  };
  const copyQuoteText = () => {
    const text = buildQuoteText();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast({ title: "Đã copy báo giá — dán gửi khách được luôn" }),
        () => prompt("Copy báo giá:", text),
      );
    } else {
      prompt("Copy báo giá:", text);
    }
  };
  const handleSelectCustomer = (c: Customer) => {
    matchedNameRef.current = c.name ?? "";
    matchedPhoneRef.current = c.phone ?? "";
    setCustomerId(c.id); setCustomerName(c.name ?? ""); setPhone(c.phone ?? "");
    setSelectedCustomerRank(c.customerRank ?? null);
    setFacebook(c.facebook ?? ""); setZalo(c.zalo ?? "");
    if (c.avatar) setAvatar(c.avatar);
    setRecentBookings([]);
    recentBookingsForIdRef.current = c.id;
    const fetchId = c.id;
    authFetch(`${BASE}/api/customers/${c.id}/recent-bookings`)
      .then(r => r.ok ? r.json() : [])
      .then((data: unknown) => { if (recentBookingsForIdRef.current === fetchId) setRecentBookings(Array.isArray(data) ? data as RecentBooking[] : []); })
      .catch(() => { if (recentBookingsForIdRef.current === fetchId) setRecentBookings([]); });
  };

  // Load existing customer avatar/facebook/zalo when editing a booking
  useEffect(() => {
    const cid = booking?.customerId;
    if (!cid) return;
    let cancelled = false;
    authFetch(`${BASE}/api/customers/${cid}`)
      .then(r => r.ok ? r.json() : null)
      .then((c: Customer | null) => {
        if (cancelled || !c) return;
        if (c.avatar) setAvatar(prev => prev || c.avatar || "");
        if (c.facebook) setFacebook(prev => prev || c.facebook || "");
        if (c.zalo) setZalo(prev => prev || c.zalo || "");
        if (c.customerRank) setSelectedCustomerRank(prev => prev ?? c.customerRank ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [booking?.customerId]);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const original = ev.target?.result as string;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;
        const MAX_DIM = 400;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
        setAvatar(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.src = original;
    };
    reader.readAsDataURL(file);
  };

  const handleDepositProofChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = ev => {
        const original = ev.target?.result as string;
        const img = new Image();
        img.onload = () => {
          const MAX_BYTES = 1.5 * 1024 * 1024;
          const canvas = document.createElement("canvas");
          let { width, height } = img;
          const MAX_DIM = 1600;
          if (width > MAX_DIM || height > MAX_DIM) {
            const scale = MAX_DIM / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
          let quality = 0.85;
          let compressed = canvas.toDataURL("image/jpeg", quality);
          while (compressed.length * 0.75 > MAX_BYTES && quality > 0.3) {
            quality -= 0.1;
            compressed = canvas.toDataURL("image/jpeg", quality);
          }
          setDepositProofImages(prev => [...prev, compressed]);
        };
        img.src = original;
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  // EDIT mode: ghi ảnh bằng chứng cọc thẳng vào payment cọc (CHỈ ảnh, số tiền giữ nguyên).
  const patchDepositProofs = async (urls: string[]): Promise<boolean> => {
    if (depositPaymentId == null) return false;
    try {
      const res = await authFetch(`${BASE}/api/payments/${depositPaymentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proofImageUrl: urls[0] ?? null, proofImageUrls: urls }),
      });
      return res.ok;
    } catch { return false; }
  };

  const handleEditDepositProofAdd = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Chụp danh sách File NGAY (reset e.target.value bên dưới sẽ làm rỗng e.target.files).
    const picked = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = "";
    if (picked.length === 0 || depositPaymentId == null) return;
    setDepositProofError("");
    setSavingDepositProof(true);
    try {
      const compressed = await Promise.all(picked.map(compressImageToDataUrl));
      const next = [...editDepositProofs, ...compressed].slice(0, 20);
      if (!(await patchDepositProofs(next))) throw new Error("patch fail");
      setEditDepositProofs(next);
      qc.invalidateQueries({ queryKey: ["bookings"] });
    } catch {
      setDepositProofError("Lưu ảnh cọc chưa được, anh thử lại giúp em nha.");
    } finally {
      setSavingDepositProof(false);
    }
  };

  const handleEditDepositProofRemove = async (idx: number) => {
    if (depositPaymentId == null || savingDepositProof) return;
    const next = editDepositProofs.filter((_, i) => i !== idx);
    setDepositProofError("");
    setSavingDepositProof(true);
    try {
      if (!(await patchDepositProofs(next))) throw new Error("patch fail");
      setEditDepositProofs(next);
      qc.invalidateQueries({ queryKey: ["bookings"] });
    } catch {
      setDepositProofError("Xóa ảnh chưa được, anh thử lại nha.");
    } finally {
      setSavingDepositProof(false);
    }
  };

  const save = async () => {
    setError("");
    setProofWarning("");
    if (!customerName.trim()) { setError("Vui lòng nhập tên khách hàng"); return; }
    if (!shootDate) { setError("Vui lòng chọn ngày hợp đồng"); return; }
    if (isUploadingImages) { setError("Ảnh đang tải, vui lòng chờ tải xong để tránh mất ảnh."); return; }
    const extrasValidation = validateAdditionalServicesForm(
      subDrafts.flatMap(s => s.additionalServices || []).filter(l => (l.title || "").trim()),
    );
    if (!extrasValidation.ok) { setError(extrasValidation.errors[0]); return; }
    const isMulti = subDrafts.length >= 2;

    // ── Giải quyết khách hàng cho show (dùng chung cho cả luồng đơn & hợp đồng gộp) ──
    // Quy tắc chống bug "khách bị quay về khách cũ":
    //  • KHÔNG dùng SĐT placeholder ("0", rỗng...) để tra/merge khách.
    //  • Còn liên kết khách (customerId) → cập nhật đúng khách đó.
    //  • Đã gỡ liên kết / gõ tên mới → tạo/tìm khách mới theo SĐT hợp lệ, không có thì tạo khách mới.
    const resolveCustomerForSave = async (): Promise<number | null> => {
      let cid = customerId;
      if (isEdit && cid) {
        const normalizedNew = digitsOnly(phone);
        const normalizedOld = digitsOnly(matchedPhoneRef.current);
        let reassigned = false;
        if (!isMissingPhone(phone) && normalizedNew !== normalizedOld) {
          // SĐT hợp lệ & đổi khác → tra trước để tránh trùng
          const byPhoneRes = await authFetch(`${BASE}/api/customers/by-phone?phone=${encodeURIComponent(normalizedNew)}`).catch(() => null);
          if (byPhoneRes && byPhoneRes.ok) {
            const found = await byPhoneRes.json() as Customer;
            cid = found.id; reassigned = true;
          } else {
            await authFetch(`${BASE}/api/customers/${cid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) });
          }
        }
        if (!reassigned) {
          const patch: Record<string, unknown> = {};
          if (customerName.trim() && customerName.trim() !== matchedNameRef.current.trim()) patch.name = customerName.trim();
          if (avatar) patch.avatar = avatar;
          if (facebook) patch.facebook = facebook;
          if (zalo) patch.zalo = zalo;
          if (Object.keys(patch).length > 0) {
            await authFetch(`${BASE}/api/customers/${cid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
          }
        }
        return cid;
      }
      if (!cid) {
        if (!isMissingPhone(phone)) {
          const foundRaw = await authFetch(`${BASE}/api/customers?search=${encodeURIComponent(phone)}`, { headers: { "Content-Type": "application/json" } }).then(r => r.ok ? r.json() : []).catch(() => []);
          const found: Customer[] = Array.isArray(foundRaw) ? foundRaw : [];
          const existing = found.find(c => digitsOnly(c.phone) === digitsOnly(phone));
          if (existing) {
            cid = existing.id;
            if (avatar && !existing.avatar) {
              await authFetch(`${BASE}/api/customers/${cid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ avatar }) });
            }
          } else {
            const nc = await authFetch(`${BASE}/api/customers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: customerName, phone, facebook: facebook || undefined, zalo: zalo || undefined, avatar: avatar || undefined, source: "walk-in" }) }).then(r => r.json()) as Customer;
            cid = nc.id;
          }
        } else {
          // Không có SĐT hợp lệ → tạo khách mới theo tên nhập tay (phone = null).
          const nc = await authFetch(`${BASE}/api/customers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: customerName, facebook: facebook || undefined, zalo: zalo || undefined, avatar: avatar || undefined, source: "walk-in" }) }).then(r => r.json()) as Customer;
          cid = nc.id;
        }
      }
      return cid;
    };

    const normalizeItems = (items: typeof subDrafts[number]["items"]) => {
      const seen = new Set<string>();
      return items.filter(item => {
        // Dòng chưa chốt gói nhưng ĐÃ giao nhân sự vẫn phải lưu — nếu lọc bỏ,
        // phân công (Nhiếp ảnh/Makeup...) mất lặng lẽ, show kẹt "Chưa giao việc".
        if (!(item.serviceName || item.serviceId || lineHasStaff(item))) return false;
        const key = item.serviceKey
          || (item.serviceName || item.serviceId
            ? `svc-${item.serviceId ?? "custom"}-${item.serviceName ?? ""}`
            : `line-${item.tempId}`);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    // Reconcile hợp đồng gộp phải chạy MIỄN LÀ đang sửa hợp đồng đã load siblings,
    // kể cả khi xoá xuống còn 1 dịch vụ (isMulti=false) — nếu không, remove-child bị
    // bỏ qua và dịch vụ đã gỡ vẫn sống sót trong DB + vẫn bị tính tiền.
    if (isEdit && hasSiblingEdit) {
      setSaving(true);
      try {
        // Giải quyết khách cho hợp đồng gộp (cập nhật khách cũ / tạo khách mới) — placeholder-safe.
        // cidResolved sẽ được gán cho cha + tất cả dịch vụ con để show hiển thị đúng tên.
        // KHÔNG invalidate giữa chừng — mọi cache refetch MỘT LẦN sau khi cả chuỗi lưu xong
        // (invalidate sớm làm list repaint khi gia đình booking mới cập nhật một nửa).
        const cidResolved = await resolveCustomerForSave();
        // Map sub.id → booking id THẬT của dịch vụ (sibling cũ giữ id, dịch vụ mới lấy id từ
        // response add-child) — để sync trang phục vào ĐÚNG child booking.
        const subBookingIds: Record<string, number> = {};
        for (const sub of subDrafts) {
          const validItems = normalizeItems(sub.items);
          const subPackageTotal = calcSubPackageTotal(sub.items);
          const subExtrasTotal = calcSubExtrasTotal(sub.additionalServices || []);
          const subTotal = subPackageTotal + subExtrasTotal;
          const pkgLine = validItems.find(l => (l.serviceKey ?? "").startsWith("pkg-"));
          const servicePackageId = pkgLine ? parseInt(pkgLine.serviceKey.replace("pkg-", "")) : null;
          if (sub.siblingId) {
            const res = await authFetch(`${BASE}/api/bookings/${sub.siblingId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                customerId: cidResolved,
                serviceLabel: sub.serviceLabel || "",
                shootDate: sub.shootDate || shootDate,
                shootTime: sub.shootTime || "08:00",
                items: validItems.map(({ tempId: _t, ...rest }) => rest),
                totalAmount: subTotal,
                additionalServices: cleanAdditionalServicesForSave(sub.additionalServices || []),
                servicePackageId,
                // Ngày phụ đi CÙNG transaction với booking — đổi ngày là atomic,
                // hết cảnh booking mới mà ngày phụ cũ khi lỗi giữa chừng.
                occurrences: occurrencesPayload(sub.occurrences),
              }),
            });
            if (!res.ok) {
              const errBody = await res.json().catch(() => null);
              throw new Error(errBody?.error || "Lỗi lưu dịch vụ");
            }
            subBookingIds[sub.id] = sub.siblingId;
          } else if (booking?.id) {
            const res = await authFetch(`${BASE}/api/bookings/${booking.id}/add-child`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                customerId: cidResolved,
                serviceLabel: sub.serviceLabel || "",
                shootDate: sub.shootDate || shootDate,
                shootTime: sub.shootTime || "08:00",
                items: validItems.map(({ tempId: _t, ...rest }) => rest),
                totalAmount: subTotal,
                additionalServices: cleanAdditionalServicesForSave(sub.additionalServices || []),
                servicePackageId,
              }),
            });
            if (!res.ok) throw new Error("Lỗi thêm dịch vụ mới");
            const createdChild = await res.json().catch(() => null);
            if (createdChild?.id) subBookingIds[sub.id] = createdChild.id;
          }
        }
        // ── BUG FIX (tiền bạc): xoá các dịch vụ con đã bị gỡ khỏi form ──
        // Trước đây vòng lặp trên CHỈ PUT sibling cũ + POST dịch vụ mới, KHÔNG xoá
        // sibling user đã xoá khỏi form → child booking vẫn còn trong DB. Vì tổng
        // của hợp đồng cha = Σ children (recalcParentTotalFromChildren ở backend),
        // dịch vụ đã xoá vẫn bị tính tiền (đội tổng + còn lại lên). Phải gọi
        // remove-child để xoá đúng. Chạy SAU vòng add/PUT để luôn còn ≥1 dịch vụ con
        // (backend chặn xoá dịch vụ con cuối cùng).
        if (booking?.id) {
          const keptSiblingIds = new Set(
            subDrafts
              .map(s => s.siblingId)
              .filter((v): v is number => typeof v === "number"),
          );
          const removedSiblingIds = siblingBookings
            .map(s => s.id)
            .filter(sid => !keptSiblingIds.has(sid));
          for (const childId of removedSiblingIds) {
            const delRes = await authFetch(`${BASE}/api/bookings/${booking.id}/remove-child/${childId}`, {
              method: "DELETE",
            });
            // 404 = dịch vụ con đã KHÔNG còn là con hợp lệ của hợp đồng này (đã bị xoá
            // trước đó / parentId lệch) → coi như đã gỡ xong, KHÔNG abort cả lượt lưu.
            // Lỗi khác (400/500) vẫn ném ra để không che giấu sự cố thật.
            if (!delRes.ok && delRes.status !== 404) {
              const errBody = await delRes.json().catch(() => null);
              throw new Error(errBody?.error || "Lỗi xoá dịch vụ đã gỡ khỏi hợp đồng");
            }
          }
        }
        // Sync booking-dresses THEO TỪNG DỊCH VỤ (child booking id) — hết cảnh dồn chung vào cha.
        // Guard outfitsLoaded: load lỗi thì bỏ qua toàn bộ sync (kể cả dọn cha) — không xoá nhầm.
        if (outfitsLoaded) {
          for (const sub of subDrafts) {
            const bid = subBookingIds[sub.id];
            if (bid) await syncOutfitDrafts(bid, outfitsBySub[sub.id] ?? []);
          }
          // Dọn váy còn gắn ở CHA (data cũ): đã hiển thị ở Dịch vụ 1 và (nếu user giữ) vừa được
          // insert lại dưới child ⇒ xoá row cha = HOÀN TẤT move, mở lại không còn lẫn. Cha là hợp
          // đồng tổng, không giữ trang phục riêng. syncOutfitDrafts THROW khi request fail nên
          // bước dọn này chỉ chạy khi mọi bản copy đã nằm an toàn dưới child (chống mất data).
          if (booking?.id) {
            await syncOutfitDrafts(booking.id, []);
          }
        }
        // Ngày phụ của dịch vụ CŨ đã đi kèm PUT ở trên (atomic). Chỉ còn dịch vụ
        // MỚI tạo qua add-child (chưa có id lúc build body) là sync sau khi có id.
        for (const sub of subDrafts) {
          const bid = subBookingIds[sub.id];
          if (bid && !sub.siblingId) await syncOccurrences(bid, sub.occurrences ?? []);
        }
        if (booking?.id) {
          const editMultiAssignedStaff: { id: string; role: string; staffId: number; staffName: string; castAmount: number; taskKey: string }[] = [];
          if (saleId) {
            const saleName = allStaff.find(s => s.id === saleId)?.name ?? "";
            editMultiAssignedStaff.push({ id: genId(), role: "sales", staffId: saleId, staffName: saleName, castAmount: 0, taskKey: saleTask || "mac_dinh" });
          }
          if (photoshopId) {
            const ptsName = allStaff.find(s => s.id === photoshopId)?.name ?? "";
            editMultiAssignedStaff.push({ id: genId(), role: "photoshop", staffId: photoshopId, staffName: ptsName, castAmount: 0, taskKey: photoshopTask || "mac_dinh" });
          }
          await authFetch(`${BASE}/api/bookings/${booking.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              customerId: cidResolved,
              totalAmount: totalAmount,
              depositAmount: depositNum,
              discountAmount: discountNum,
              packageType: subDrafts.map(s => s.serviceLabel || "Dịch vụ").join(" + "),
              dressWarnPickupDays: parseWarnDays(dressWarnPickupDays),
              dressWarnReturnDays: parseWarnDays(dressWarnReturnDays),
              // Only send assignedStaff when non-empty to avoid wiping item-level photographer/makeup
              ...(editMultiAssignedStaff.length > 0 ? { assignedStaff: editMultiAssignedStaff } : {}),
              // Toggle Báo giá tạm đổi phía → gửi status cho CHA; backend flip cả
              // gia đình (con + cha) trong 1 transaction. Không đổi thì không gửi
              // status — tránh ghi đè trạng thái vận hành hiện tại của cha.
              ...(tempQuoteMode !== initialTempQuoteRef.current
                ? { status: tempQuoteMode ? "temp_quote" : "confirmed" }
                : {}),
            }),
          });
        }
        // Invalidate MỘT LẦN sau khi toàn bộ chuỗi lưu xong — phủ cả hợp đồng,
        // khách hàng, thu tiền, tìm kiếm, dashboard (trước đây thiếu → màn khác
        // hiện dữ liệu cũ tới 5 phút vì staleTime toàn cục).
        invalidateBookingRelated(qc);
        if (isEdit && tempQuoteMode !== initialTempQuoteRef.current) {
          // UX như xóa/phục hồi mềm — nhưng kỹ thuật chỉ là flip status, không xóa gì.
          toast({
            title: tempQuoteMode
              ? "Đã chuyển sang báo giá tạm — đơn đã được loại khỏi số liệu chính thức."
              : "Đã chuyển thành booking chính thức — đơn đã được đưa trở lại hệ thống.",
          });
        }
        orderCreatedFeedback();
        onSaved(subDrafts[0]?.shootDate || shootDate);
        return;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Lỗi lưu hợp đồng");
        setSaving(false);
        return;
      }
    }
    setSaving(true);
    try {
      // ── 1. Tạo / tìm / cập nhật khách hàng (placeholder-safe, chống bug quay về khách cũ) ──
      const cid = await resolveCustomerForSave();

      let saved: Booking;

      // ── Defensive guard: nếu đang edit hợp đồng gộp mà rơi xuống đây ──
      // có nghĩa siblings chưa được load → KHÔNG được POST tạo mới (sẽ trùng).
      // Trước đây bug này tạo ra DH0090 trùng với DH0048 (xem commit log).
      if (isEdit && isMulti && (booking?.isParentContract || booking?.parentId)) {
        setError("Lỗi: hợp đồng gộp chưa được load đầy đủ. Vui lòng đóng form, mở lại từ chi tiết show và thử lại.");
        setSaving(false);
        return;
      }

      // ── Multi-service contract mode (CREATE only) ──
      if (isMulti && !isEdit) {
        const assignedStaff: { id: string; role: string; staffId: number; staffName: string; castAmount: number; taskKey: string }[] = [];
        if (saleId) {
          const saleName = allStaff.find(s => s.id === saleId)?.name ?? "";
          assignedStaff.push({ id: genId(), role: "sales", staffId: saleId, staffName: saleName, castAmount: 0, taskKey: saleTask || "mac_dinh" });
        }
        if (photoshopId) {
          const ptsName = allStaff.find(s => s.id === photoshopId)?.name ?? "";
          assignedStaff.push({ id: genId(), role: "photoshop", staffId: photoshopId, staffName: ptsName, castAmount: 0, taskKey: photoshopTask || "mac_dinh" });
        }

        const subServicePayloads = subDrafts.map(sub => {
          // Giữ cả dòng chưa chốt gói nhưng đã giao nhân sự (xem lineHasStaff)
          const validItems = sub.items.filter(l => l.serviceName || l.serviceId || lineHasStaff(l));
          const subPackageTotal = calcSubPackageTotal(sub.items);
          const subExtrasTotal = calcSubExtrasTotal(sub.additionalServices || []);
          const subTotal = subPackageTotal + subExtrasTotal;
          const subDeductions = validItems
            .flatMap(l => (l.deductions || []))
            .filter(d => d.label?.trim() && d.amount > 0)
            .map(({ label, amount }) => ({ label, amount }));
          const subAssigned: Record<string, unknown> = {};
          if (sub.photoId) { subAssigned.photo = sub.photoId; subAssigned.photoTask = sub.photoTask || "mac_dinh"; }
          if (sub.makeupId) { subAssigned.makeup = sub.makeupId; subAssigned.makeupTask = sub.makeupTask || "mac_dinh"; }
          return {
            serviceLabel: sub.serviceLabel || `Dịch vụ ${subDrafts.indexOf(sub) + 1}`,
            shootDate: sub.shootDate || shootDate,
            shootTime: sub.shootTime || "08:00",
            items: validItems.map(({ tempId: _t, ...rest }) => rest),
            deductions: subDeductions,
            totalAmount: subTotal,
            additionalServices: cleanAdditionalServicesForSave(sub.additionalServices || []),
            assignedStaff: subAssigned,
            notes: sub.notes || null,
          };
        });

        const body = {
          customerId: cid,
          shootDate,
          shootTime: "08:00",
          totalAmount: totalAmount,
          depositAmount: depositNum,
          depositPaymentMethod: depositMethod,
          depositPaidDate: depositDate || null,
          depositPaidAt: depositDate
            ? new Date(`${depositDate}T${depositTime || "00:00"}:00`).toISOString()
            : null,
          discountAmount: discountNum,
          isParentContract: true,
          packageType: subDrafts.map(s => s.serviceLabel || "Dịch vụ").join(" + "),
          assignedStaff,
          notes: notes || null,
          location: location || null,
          subServices: subServicePayloads,
          dressWarnPickupDays: parseWarnDays(dressWarnPickupDays),
          dressWarnReturnDays: parseWarnDays(dressWarnReturnDays),
          // Báo giá tạm tính: backend lưu status temp_quote + mã BG, không phiếu thu/hậu kỳ
          isTempQuote: tempQuoteMode,
        };

        saved = await authFetch(`${BASE}/api/bookings`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }).then(r => { if (!r.ok) throw new Error("Lỗi tạo hợp đồng"); return r.json(); });

        // Sync trang phục THEO TỪNG DỊCH VỤ vào child booking vừa tạo (response trả children
        // đúng thứ tự subServices). Trước đây nhánh tạo hợp đồng nhiều dịch vụ KHÔNG sync
        // trang phục ⇒ váy chọn lúc tạo bị rơi lặng lẽ — vá luôn tại đây.
        // KHÔNG sync cho BÁO GIÁ TẠM (temp_quote): quote chưa chốt mà giữ váy sẽ chặn lịch
        // váy của đơn thật (schedule/conflict chỉ lọc theo status váy, không theo status đơn).
        if (!tempQuoteMode) {
          const createdChildren = Array.isArray(saved?.children) ? saved.children : [];
          for (let i = 0; i < subDrafts.length; i++) {
            const childId = createdChildren[i]?.id;
            const drafts = outfitsBySub[subDrafts[i].id] ?? [];
            if (childId && drafts.length > 0) await syncOutfitDrafts(childId, drafts);
            if (childId) await syncOccurrences(childId, subDrafts[i].occurrences ?? []);
          }
        }

        // Upload ảnh cọc riêng sau khi booking tạo xong (tách luồng để không làm fail booking)
        let proofUploadFailed = false;
        if (!tempQuoteMode && depositProofImages.length > 0 && depositNum > 0 && saved?.id) {
          try {
            const pmts = await authFetch(`${BASE}/api/payments?bookingId=${saved.id}`).then(r => r.ok ? r.json() : []).catch(() => []);
            const depPmt = Array.isArray(pmts) ? pmts.find((p: any) => p.paymentType === "deposit") : null;
            if (depPmt?.id) {
              const patchRes = await authFetch(`${BASE}/api/payments/${depPmt.id}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  proofImageUrl: depositProofImages[0] ?? null,
                  proofImageUrls: depositProofImages,
                }),
              });
              if (!patchRes.ok) proofUploadFailed = true;
            } else {
              proofUploadFailed = true;
            }
          } catch {
            proofUploadFailed = true;
          }
        }

        invalidateBookingRelated(qc);
        orderCreatedFeedback();
        if (proofUploadFailed) {
          setSaving(false);
          setProofWarning("Ảnh cọc chưa lưu được — đơn đã tạo thành công. Bạn có thể đóng form.");
          return;
        }
        onSaved(subDrafts[0]?.shootDate || shootDate);
        return;
      }

      // ── 2. Single booking ──
      // ── Guard P0 (sự cố DH0191): đơn THƯỜNG đang edit mà form có ≥2 dịch vụ thì
      // nhánh này chỉ gửi items của Dịch vụ 1 nhưng totalAmount = tổng TẤT CẢ dịch vụ
      // → tiền Dịch vụ 2 nhập vào tổng còn nội dung bị vứt. CHẶN LƯU, không lưu nửa vời.
      // (Nút "+ Thêm dịch vụ mới" đã ẩn khi edit đơn thường — guard này là chốt chặn cuối.)
      if (isEdit && subDrafts.length > 1) {
        alert(
          "Đơn này là đơn 1 dịch vụ — chưa hỗ trợ thêm dịch vụ mới khi chỉnh sửa (tránh lệch tiền).\n\n" +
          "Chưa có gì được lưu. Cách làm đúng:\n" +
          "• Tạo ĐƠN MỚI riêng cho dịch vụ mới, hoặc\n" +
          "• Tạo HỢP ĐỒNG GỘP mới và chọn đủ các dịch vụ ngay khi tạo.",
        );
        setSaving(false);
        return;
      }
      const sub0 = subDrafts[0];
      const effectiveShootDate = sub0.shootDate || shootDate;
      const validLines = sub0.items.filter(l => l.serviceName || l.serviceId);
      const hasServices = validLines.length > 0;
      // Dòng đã giao nhân sự nhưng chưa chọn gói vẫn phải gửi lên server —
      // trước đây bị lọc bỏ nên phân công mất lặng lẽ, show kẹt "Chưa giao việc".
      // (hasServices/packageType vẫn tính theo validLines: chưa chọn gói thì
      // show vẫn là "Chưa chốt dịch vụ", chỉ có nhân sự là được giữ lại.)
      const linesToSave = sub0.items.filter(l => l.serviceName || l.serviceId || lineHasStaff(l));

      const packageType = hasServices
        ? (validLines.length === 1
            ? (validLines[0].serviceName || "Dịch vụ")
            : `${validLines[0].serviceName || "Dịch vụ"} (+${validLines.length - 1})`)
        : "Chưa chốt dịch vụ";

      // temp_quote giữ nguyên cả khi chưa chốt gói — báo giá tạm không bị ép về "Chưa chốt dịch vụ".
      const finalStatus = hasServices ? status : (status === "confirmed" || status === "in_progress" || status === "completed" || status === "temp_quote" ? status : "pending_service");
      const finalTotal = totalAmount;
      const finalDeposit = hasServices ? depositNum : 0;

      const assignedStaff: { id: string; role: string; staffId: number; staffName: string; castAmount: number; taskKey: string }[] = [];
      if (saleId) {
        const saleName = allStaff.find(s => s.id === saleId)?.name ?? "";
        assignedStaff.push({ id: genId(), role: "sales", staffId: saleId, staffName: saleName, castAmount: 0, taskKey: saleTask || "mac_dinh" });
      }
      if (photoshopId) {
        const ptsName = allStaff.find(s => s.id === photoshopId)?.name ?? "";
        assignedStaff.push({ id: genId(), role: "photoshop", staffId: photoshopId, staffName: ptsName, castAmount: 0, taskKey: photoshopTask || "mac_dinh" });
      }

      const cleanedSurcharges: { name: string; amount: number }[] = [];

      const cleanedDeductions = validLines
        .flatMap(l => (l.deductions || []))
        .filter(d => d.label?.trim() && d.amount > 0)
        .map(({ label, amount }) => ({ label, amount }));

      // Task #24: trích servicePackageId từ service line có serviceKey "pkg-{id}"
      // Khi sửa đơn: nếu không có dòng nào là package → giữ nguyên packageId cũ (tránh unlink)
      const pkgLine = validLines.find(l => (l.serviceKey ?? "").startsWith("pkg-"));
      const servicePackageId = pkgLine
        ? parseInt(pkgLine.serviceKey.replace("pkg-", ""))
        : (isEdit ? (booking?.servicePackageId ?? null) : null);

      const body: Record<string, unknown> = {
        customerId: cid, shootDate: effectiveShootDate, shootTime: sub0.shootTime || "08:00",
        serviceCategory: "wedding", packageType,
        location: location || null, status: finalStatus,
        totalAmount: finalTotal, depositAmount: finalDeposit,
        depositPaymentMethod: finalDeposit > 0 ? depositMethod : undefined,
        // Chỉ gửi ngày/giờ cọc khi: (1) tạo mới có cọc, hoặc (2) edit và user đã chủ động đổi ô Ngày HOẶC Giờ.
        // Không tự suy ra từ shootDate — payment.paidAt là source of truth riêng.
        depositPaidDate:
          finalDeposit > 0 && (!isEdit || depositDate !== initialDepositDateRef.current || depositTime !== initialDepositTimeRef.current)
            ? (depositDate || null)
            : undefined,
        depositPaidAt:
          finalDeposit > 0 && (!isEdit || depositDate !== initialDepositDateRef.current || depositTime !== initialDepositTimeRef.current)
            ? (depositDate ? new Date(`${depositDate}T${depositTime || "00:00"}:00`).toISOString() : null)
            : undefined,
        discountAmount: discountNum,
        items: linesToSave.map(({ tempId: _t, ...rest }) => rest),
        surcharges: cleanedSurcharges,
        deductions: hasServices ? cleanedDeductions : [],
        // Only include assignedStaff in PUT when non-empty — sending [] would clear item-level photographer/makeup
        ...(isEdit && assignedStaff.length === 0 ? {} : { assignedStaff }),
        notes: notes || null,
        photoCount: photoCount !== "" ? parseInt(photoCount) : null,
      };
      body.additionalServices = cleanAdditionalServicesForSave(subDrafts[0]?.additionalServices || []);
      body.servicePackageId = servicePackageId ?? null;
      body.dressWarnPickupDays = parseWarnDays(dressWarnPickupDays);
      body.dressWarnReturnDays = parseWarnDays(dressWarnReturnDays);
      // Báo giá tạm tính (chỉ khi tạo mới): backend lưu status temp_quote + mã BG
      if (!isEdit) body.isTempQuote = tempQuoteMode;
      // EDIT: ngày phụ đi cùng transaction PUT (atomic). CREATE: booking chưa có id
      // → vẫn sync sau khi tạo (chưa có card trên lịch, không có rủi ro mất tạm).
      if (isEdit) body.occurrences = occurrencesPayload(subDrafts[0]?.occurrences);

      if (isEdit && booking) {
        saved = await authFetch(`${BASE}/api/bookings/${booking.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }).then(async r => {
          if (!r.ok) {
            const errBody = await r.json().catch(() => null);
            throw new Error(errBody?.error || "Lỗi cập nhật");
          }
          return r.json();
        });
      } else {
        saved = await authFetch(`${BASE}/api/bookings`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        }).then(r => { if (!r.ok) throw new Error("Lỗi tạo đơn"); return r.json(); });
      }

      // Sync booking-dresses after booking saved (đơn 1 dịch vụ: váy nằm trên booking chính).
      // Guard outfitsLoaded: load lỗi thì bỏ qua — tránh sync mảng rỗng xoá nhầm váy thật.
      const bookingIdToSync = isEdit && booking ? booking.id : saved?.id;
      if (bookingIdToSync && outfitsLoaded) {
        await syncOutfitDrafts(bookingIdToSync, outfitsBySub[subDrafts[0]?.id] ?? []);
      }
      // Ngày phụ: EDIT đã đi kèm PUT (atomic) — chỉ nhánh TẠO MỚI còn sync sau khi có id.
      if (!isEdit && bookingIdToSync) await syncOccurrences(bookingIdToSync, subDrafts[0]?.occurrences ?? []);

      // Upload ảnh cọc riêng sau khi booking tạo xong (tách luồng, không làm fail booking)
      let singleProofUploadFailed = false;
      if (!isEdit && !tempQuoteMode && depositProofImages.length > 0 && finalDeposit > 0 && saved?.id) {
        try {
          const pmts = await authFetch(`${BASE}/api/payments?bookingId=${saved.id}`).then(r => r.ok ? r.json() : []).catch(() => []);
          const depPmt = Array.isArray(pmts) ? pmts.find((p: any) => p.paymentType === "deposit") : null;
          if (depPmt?.id) {
            const patchRes = await authFetch(`${BASE}/api/payments/${depPmt.id}`, {
              method: "PATCH", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                proofImageUrl: depositProofImages[0] ?? null,
                proofImageUrls: depositProofImages,
              }),
            });
            if (!patchRes.ok) singleProofUploadFailed = true;
          } else {
            singleProofUploadFailed = true;
          }
        } catch {
          singleProofUploadFailed = true;
        }
      }

      invalidateBookingRelated(qc);
      if (isEdit && tempQuoteMode !== initialTempQuoteRef.current) {
        // UX như xóa/phục hồi mềm — nhưng kỹ thuật chỉ là flip status, không xóa gì.
        toast({
          title: tempQuoteMode
            ? "Đã chuyển sang báo giá tạm — đơn đã được loại khỏi số liệu chính thức."
            : "Đã chuyển thành booking chính thức — đơn đã được đưa trở lại hệ thống.",
        });
      }
      orderCreatedFeedback();
      if (singleProofUploadFailed) {
        setSaving(false);
        setProofWarning("Ảnh cọc chưa lưu được — đơn đã tạo thành công. Bạn có thể đóng form.");
        return;
      }
      onSaved(effectiveShootDate);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Có lỗi, thử lại");
    } finally { setSaving(false); }
  };

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`${BASE}/api/bookings/${booking?.id}`, { method: "DELETE" });
      if (!res.ok) {
        let msg = `Xoá thất bại (HTTP ${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {}
        throw new Error(msg);
      }
      return res;
    },
    onSuccess: () => { invalidateBookingRelated(qc); onSaved(); },
    onError: (err: unknown) => {
      console.error("[deleteBooking editor] error:", err);
      alert(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b flex-shrink-0 bg-card">
        <button
          onClick={() => {
            if (tempQuoteMode && !confirm("Báo giá tạm tính chưa được lưu. Bạn có chắc muốn thoát?")) return;
            onClose();
          }}
          className="p-1.5 rounded-lg hover:bg-muted transition-colors flex-shrink-0"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-sm">{isEdit ? "✏️ Chỉnh sửa show" : tempQuoteMode ? "🧮 Tạo báo giá tạm tính" : "✨ Tạo show mới"}</p>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {format(shootDateObj, "EEEE, dd/MM/yyyy", { locale: vi })} · {subDrafts[0]?.shootTime ?? initialTime}
          </p>
        </div>
        {/* Toggle Báo giá tạm — luôn thao tác được (edit: admin), không bao giờ khóa. */}
        {(!isEdit || isAdmin) && (
          <label className="flex items-center gap-2 flex-shrink-0 cursor-pointer select-none">
            <span className={`text-xs font-medium ${tempQuoteMode ? "text-purple-600" : "text-muted-foreground"}`}>
              {tempQuoteMode ? "Báo giá tạm tính" : "Booking chính thức"}
            </span>
            <Switch
              checked={tempQuoteMode}
              disabled={saving}
              onCheckedChange={(checked) => {
                setTempQuoteMode(checked);
                // status là nơi LƯU duy nhất — toggle và dropdown Trạng thái luôn khớp nhau.
                setStatus(prev => checked ? "temp_quote" : (prev === "temp_quote" ? "confirmed" : prev));
              }}
            />
          </label>
        )}
        {isEdit && (
          <button
            onClick={() => { if (confirm("Đưa show này vào thùng rác? Admin có thể phục hồi lại từ Thùng rác Booking.")) deleteMutation.mutate(); }}
            className="p-1.5 rounded-lg text-destructive/60 hover:text-destructive hover:bg-destructive/10 transition-colors flex-shrink-0"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-5 max-w-2xl mx-auto">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-xl text-destructive text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
            </div>
          )}
          {proofWarning && (
            <div className="flex items-center gap-2 p-3 bg-yellow-50 border border-yellow-300 rounded-xl text-yellow-800 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0 text-yellow-500" /> {proofWarning}
            </div>
          )}
          {tempQuoteMode && (
            <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-300 rounded-xl text-amber-800 text-sm font-medium">
              <Receipt className="w-4 h-4 flex-shrink-0 text-amber-500" /> Báo giá tạm tính — chưa phải hợp đồng chính thức, KHÔNG tính vào doanh thu/công nợ
            </div>
          )}
          {/* Báo giá tạm nhưng đã thu tiền thật: không xóa/sửa phiếu, chỉ cảnh báo
              rõ để admin chọn — tắt Báo giá tạm thành booking chính thức, hoặc
              hoàn/hủy phiếu thu theo flow Thu tiền. Không âm thầm mất tiền. */}
          {tempQuoteMode && isEdit && actualPaid > 0 && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-300 rounded-xl text-red-800 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-500" />
              <span>
                <b>Báo giá tạm này đang có tiền đã thu thực tế ({formatVND(actualPaid)}).</b>{" "}
                Số tiền này KHÔNG được tính vào doanh thu khi còn là báo giá tạm. Tắt "Báo giá tạm tính"
                để thành booking chính thức, hoặc hoàn/hủy phiếu thu ở màn Thu tiền.
              </span>
            </div>
          )}

          {/* A. Khách hàng */}
          <section className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <User className="w-3.5 h-3.5" /> A. Khách hàng
            </h4>
            {/* 1. Tên khách hàng */}
            <div className="relative">
              <Input className="h-10" placeholder="Tên khách hàng *" value={customerName} onChange={e => {
                const v = e.target.value;
                setCustomerName(v);
                if (customerId != null && v.trim() !== matchedNameRef.current.trim()) { setCustomerId(null); setSelectedCustomerRank(null); setRecentBookings([]); recentBookingsForIdRef.current = null; }
              }} />
              <CustomerNameSuggest value={customerName} phone={phone} onSelect={handleSelectCustomer} />
            </div>
            {/* 2. Số điện thoại */}
            <PhoneAutocomplete value={phone} onChange={v => {
              setPhone(v);
              if (customerId != null && v.trim() !== matchedPhoneRef.current.trim()) { setCustomerId(null); setSelectedCustomerRank(null); setRecentBookings([]); recentBookingsForIdRef.current = null; }
            }} onSelect={handleSelectCustomer} />
            {/* Cảnh báo nhập số 0 làm SĐT (placeholder) */}
            {phone.trim() !== "" && isMissingPhone(phone) && (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 px-1">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>Không dùng số 0. Để trống nếu khách chưa có số điện thoại.</span>
              </div>
            )}
            {customerId && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400 px-1 flex-wrap">
                  <Check className="w-3.5 h-3.5" />
                  <span>Đang liên kết khách: <strong>{matchedNameRef.current || customerName || `#${customerId}`}</strong></span>
                  <RankBadge rank={selectedCustomerRank} size="xs" />
                  <button
                    type="button"
                    onClick={() => {
                      setCustomerId(null); setSelectedCustomerRank(null);
                      setRecentBookings([]); recentBookingsForIdRef.current = null;
                      matchedNameRef.current = ""; matchedPhoneRef.current = "";
                    }}
                    className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive underline underline-offset-2"
                  >
                    <X className="w-3 h-3" /> Xoá liên kết
                  </button>
                </div>
                {isPriorityRank(selectedCustomerRank) && (
                  <div className="inline-flex items-center gap-1 w-fit text-[11px] font-semibold text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full border border-amber-300 dark:border-amber-700">
                    <Crown className="w-3 h-3" /> {selectedCustomerRank === "super_vip" ? "Siêu VIP" : "Khách VIP"}
                  </div>
                )}
              </div>
            )}
            {/* Recent bookings mini-card */}
            {recentBookings.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-2.5 space-y-1.5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <CalendarDays className="w-3 h-3 text-blue-500" /> Lịch sử gần nhất
                </p>
                {recentBookings.map(rb => {
                  const statusMap: Record<string, { label: string; color: string }> = {
                    draft: { label: "Nháp", color: "text-gray-500" },
                    confirmed: { label: "Đã xác nhận", color: "text-blue-600" },
                    deposited: { label: "Đã cọc", color: "text-amber-600" },
                    completed: { label: "Hoàn thành", color: "text-emerald-600" },
                    cancelled: { label: "Đã huỷ", color: "text-red-500" },
                  };
                  const st = statusMap[rb.status] ?? { label: rb.status, color: "text-gray-500" };
                  const serviceName = rb.serviceLabel || rb.serviceCategory || rb.packageType || "—";
                  const dateStr = rb.shootDate ? rb.shootDate.slice(0, 10).split("-").reverse().join("/") : "—";
                  const total = rb.totalAmount ? parseFloat(rb.totalAmount).toLocaleString("vi-VN") + "đ" : "—";
                  return (
                    <div key={rb.id} className="flex items-start justify-between gap-2 text-xs bg-muted/30 dark:bg-muted/20 rounded-lg px-2.5 py-1.5">
                      <div className="min-w-0">
                        <p className="font-medium text-foreground truncate">{serviceName}</p>
                        <p className="text-muted-foreground text-[11px]">{dateStr}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className={`font-semibold ${st.color}`}>{st.label}</p>
                        <p className="text-muted-foreground text-[11px]">{total}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* 3. Avatar khách hàng */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="relative w-14 h-14 rounded-full border-2 border-dashed border-border hover:border-primary overflow-hidden flex items-center justify-center bg-muted/40 transition-colors flex-shrink-0"
              >
                {avatar
                  ? <img src={avatar} alt="avatar" className="w-full h-full object-cover" />
                  : <Camera className="w-5 h-5 text-muted-foreground" />
                }
                <div className="absolute inset-0 bg-black/20 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center">
                  <Camera className="w-4 h-4 text-white" />
                </div>
              </button>
              <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
              <div className="flex-1">
                <p className="text-xs font-medium text-foreground">Ảnh đại diện khách hàng</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Bấm vào vòng tròn để chọn ảnh từ thiết bị</p>
                {avatar && (
                  <button type="button" onClick={() => setAvatar("")} className="text-[11px] text-destructive hover:underline mt-0.5">Xoá ảnh</button>
                )}
              </div>
            </div>
            {/* 4. + Mở rộng FB / Zalo */}
            <button type="button" onClick={() => setShowExtra(!showExtra)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground py-0.5">
              <span className={`w-4 h-4 rounded-full border border-current flex items-center justify-center transition-transform ${showExtra ? "rotate-45" : ""}`}>
                <Plus className="w-2.5 h-2.5" />
              </span>
              {showExtra ? "Ẩn Facebook / Zalo" : "Thêm Facebook / Zalo"}
            </button>
            {showExtra && (
              <div className="grid grid-cols-2 gap-2">
                <Input className="h-9 text-sm" placeholder="Facebook link" value={facebook} onChange={e => setFacebook(e.target.value)} />
                <Input className="h-9 text-sm" placeholder="Zalo SĐT" value={zalo} onChange={e => setZalo(e.target.value)} />
              </div>
            )}
          </section>

          {/* B. Thông tin hợp đồng */}
          <section className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" /> B. Thông tin hợp đồng
            </h4>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-muted-foreground mb-1 block">📅 Ngày hợp đồng *</label>
                <DateInput className="h-9 text-sm" value={shootDate} onChange={handleShootDateChange} />
              </div>
              <div>
                <label className="text-[10px] text-muted-foreground mb-1 block">Trạng thái</label>
                <select className="w-full h-9 border border-input rounded-lg px-2 text-sm bg-background" value={status} onChange={e => { const v = e.target.value; setStatus(v); setTempQuoteMode(v === "temp_quote"); }}>
                  <option value="draft">📋 Lịch tạm</option>
                  <option value="pending_service">⏳ Chưa chốt dịch vụ</option>
                  <option value="pending">🟡 Chờ xác nhận</option>
                  <option value="confirmed">🔵 Đã xác nhận</option>
                  <option value="in_progress">🟣 Đang thực hiện</option>
                  <option value="completed">🟢 Hoàn thành</option>
                  <option value="cancelled">⚫ Đã hủy</option>
                  <option value="temp_quote">🧮 Báo giá tạm tính (màu tím)</option>
                </select>
              </div>
            </div>
            <div className="relative">
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input className="pl-9 h-9 text-sm" placeholder="Địa điểm (tuỳ chọn)" value={location} onChange={e => setLocation(e.target.value)} />
            </div>
          </section>

          {/* C. Danh sách dịch vụ */}
          <section className="space-y-3">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Package2 className="w-3.5 h-3.5" /> C. Dịch vụ / Job chụp
              {subDrafts.length >= 2 && (
                <span className="normal-case text-[10px] font-medium text-foreground px-1.5 py-0.5 rounded-full border border-blue-300 dark:border-blue-700">
                  Hợp đồng {subDrafts.length} dịch vụ
                </span>
              )}
            </h4>
            {subDrafts.map((sub, idx) => {
              const subTotal = calcSubPackageTotal(sub.items) + calcSubExtrasTotal(sub.additionalServices || []);
              return (
                <div key={sub.id} className="rounded-xl border border-blue-200 dark:border-blue-800 overflow-hidden">
                  {/* Block header */}
                  <div className="flex items-center gap-2 px-3 py-2 bg-blue-50/50 dark:bg-blue-950/20 border-b border-blue-200 dark:border-blue-800">
                    <span className="w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">{idx + 1}</span>
                    <Input
                      className="h-7 text-sm border-0 bg-transparent p-0 font-semibold focus-visible:ring-0 placeholder:text-muted-foreground/60 flex-1"
                      placeholder={idx === 0 ? "Tên dịch vụ (VD: Đám hỏi, Ngày cưới...)" : `Tên dịch vụ ${idx + 1} (VD: Ngày cưới...)`}
                      value={sub.serviceLabel}
                      onChange={e => updateSubDraft(sub.id, { serviceLabel: e.target.value })}
                    />
                    {subTotal > 0 && (
                      <div className="text-right flex-shrink-0 px-1">
                        <p className="text-xs font-bold text-primary tabular-nums leading-tight">{formatVND(subTotal)}</p>
                        <p className="text-[9px] text-muted-foreground">Thành tiền</p>
                      </div>
                    )}
                    {subDrafts.length > 1 && (
                      <button type="button" onClick={() => {
                        // Váy LEGACY của cha đang "ở tạm" card này → chuyển sang card còn lại đầu
                        // tiên (không bị dọn mất khi lưu); váy của child thì mất theo card là đúng.
                        const fallback = subDrafts.find(s => s.id !== sub.id)?.id ?? null;
                        setOutfitsBySub(p => moveOutfitsOnSubRemove(p, sub.id, fallback));
                        setSubDrafts(p => p.filter(s => s.id !== sub.id));
                      }} className="p-1 text-muted-foreground hover:text-destructive transition-colors" title="Xoá dịch vụ này">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="p-3 space-y-2.5 bg-background">
                    {/* Date/time row */}
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[10px] text-muted-foreground mb-1 block">📅 Ngày thực hiện</label>
                        <DateInput className="h-8 text-sm" value={sub.shootDate} onChange={v => updateSubDraft(sub.id, { shootDate: v })} />
                      </div>
                      <div>
                        <label className="text-[10px] text-muted-foreground mb-1 block">⏰ Giờ bắt đầu</label>
                        <Input type="time" className="h-8 text-sm" value={sub.shootTime} onChange={e => updateSubDraft(sub.id, { shootTime: e.target.value })} />
                      </div>
                    </div>
                    {/* Ngày thực hiện phụ (dịch vụ nhiều ngày) — ngày 1 = ô trên; đây là ngày 2..n */}
                    {(sub.occurrences?.length ?? 0) > 0 && (
                      <div className="space-y-2">
                        {sub.occurrences.map((occ, oi) => (
                          <div key={occ.id ?? `new-${oi}`} className="rounded-lg border border-dashed border-blue-300 dark:border-blue-800 p-2 bg-blue-50/40 dark:bg-blue-950/10 space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-blue-600 dark:text-blue-400">📅 Ngày thực hiện {oi + 2}</span>
                              <button type="button" onClick={() => updateSubDraft(sub.id, { occurrences: sub.occurrences.filter((_, i) => i !== oi) })}
                                className="text-[10px] text-red-500 hover:underline">Xóa ngày</button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <DateInput className="h-8 text-sm" value={occ.shootDate} onChange={v => updateSubDraft(sub.id, { occurrences: sub.occurrences.map((o, i) => i === oi ? { ...o, shootDate: v } : o) })} />
                              <Input type="time" className="h-8 text-sm" value={occ.shootTime} onChange={e => updateSubDraft(sub.id, { occurrences: sub.occurrences.map((o, i) => i === oi ? { ...o, shootTime: e.target.value } : o) })} />
                            </div>
                            <Input className="h-8 text-sm" placeholder="Ghi chú: Nhà gái / Rước dâu / Tiệc…" value={occ.label}
                              onChange={e => updateSubDraft(sub.id, { occurrences: sub.occurrences.map((o, i) => i === oi ? { ...o, label: e.target.value } : o) })} />
                          </div>
                        ))}
                      </div>
                    )}
                    <button type="button"
                      onClick={() => updateSubDraft(sub.id, { occurrences: [...(sub.occurrences ?? []), { id: null, shootDate: sub.shootDate, shootTime: "08:00", label: "" }] })}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1">
                      <Plus className="w-3.5 h-3.5" /> Thêm ngày
                    </button>
                    {(sub.occurrences?.length ?? 0) > 0 && (
                      <p className="text-[10px] text-muted-foreground">{(sub.occurrences.length + 1)} ngày thực hiện · tổng tiền không đổi</p>
                    )}
                    {/* Service rows */}
                    <div>
                      <label className="text-[10px] text-muted-foreground mb-1 block">Gói / dịch vụ</label>
                      <div className="space-y-1.5">
                        {sub.items.map(line => (
                          <OrderLineRow key={line.tempId} line={line} photographers={photographers} makeupArtists={makeupArtists} services={allServices} allStaffRates={allStaffRates} allCastRates={allCastRates} allStaff={allStaff} isAdmin={isAdmin}
                            bookingId={sub.siblingId ?? booking?.id ?? null}
                            serviceBookingId={sub.siblingId ?? null}
                            onChange={updated => updateSubDraft(sub.id, { items: sub.items.map(l => l.tempId === line.tempId ? updated : l) })}
                            onRemove={sub.items.length > 1 ? () => updateSubDraft(sub.id, { items: sub.items.filter(l => l.tempId !== line.tempId) }) : undefined}
                            onUploadStart={beginUpload}
                            onUploadEnd={endUpload}
                          />
                        ))}
                        <button
                          type="button"
                          onClick={() => updateSubDraft(sub.id, { items: [...sub.items, emptyOrderLine()] })}
                          className="text-xs text-primary hover:underline"
                        >
                          + Thêm gói trong cùng ngày
                        </button>
                      </div>
                    </div>
                    <AdditionalServicesSection
                      lines={sub.additionalServices || []}
                      onChange={lines => updateSubDraft(sub.id, { additionalServices: lines })}
                      staffOptions={allStaff.map(s => ({ id: s.id, name: s.name, roles: s.roles || [] }))}
                      allCastRates={allCastRates}
                      allStaffRates={allStaffRates}
                      formatVND={formatVND}
                    />
                    {/* F. Trang phục / Đạo cụ đi kèm — RIÊNG từng dịch vụ (key theo sub.id).
                        Thêm/xoá/sửa váy ở dịch vụ này KHÔNG ảnh hưởng dịch vụ khác. */}
                    <OutfitBookingSection
                      draft={outfitsBySub[sub.id] ?? []}
                      onChange={next => setOutfitsBySub(p => ({ ...p, [sub.id]: next }))}
                      shootDate={sub.shootDate || shootDate}
                    />
                    {/* Notes */}
                    <Input className="h-8 text-sm" placeholder="Ghi chú cho dịch vụ này..." value={sub.notes} onChange={e => updateSubDraft(sub.id, { notes: e.target.value })} />
                    {/* Sub total */}
                    {subTotal > 0 && (
                      <div className="text-xs text-right text-primary font-semibold">{formatVND(subTotal)}</div>
                    )}
                    {/* Add next service button — inside the block, at the bottom.
                        ẨN khi edit đơn THƯỜNG (không phải hợp đồng gộp): nhánh lưu single
                        chỉ gửi items của Dịch vụ 1 → thêm Dịch vụ 2 sẽ lệch tiền (sự cố
                        DH0191). Muốn nhiều dịch vụ: tạo hợp đồng gộp mới hoặc đơn riêng. */}
                    {idx === subDrafts.length - 1 && (!isEdit || hasSiblingEdit) && (
                      <button
                        type="button"
                        onClick={addSubDraft}
                        className="w-full mt-1 py-2 border-2 border-dashed border-blue-300 dark:border-blue-700 rounded-lg text-sm text-foreground hover:border-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-950/20 transition-all flex items-center justify-center gap-2 font-medium"
                      >
                        <Plus className="w-4 h-4" /> Thêm dịch vụ mới
                      </button>
                    )}
                    {idx === subDrafts.length - 1 && isEdit && !hasSiblingEdit && (
                      <p className="mt-1 text-[10px] text-muted-foreground text-center">
                        Đơn 1 dịch vụ không thêm được dịch vụ mới khi chỉnh sửa — tạo đơn riêng hoặc hợp đồng gộp mới.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          {/* Nhắc thuê đồ — chỉ có tác dụng khi gói thuộc nhóm bảng giá gạt "Thuê đồ".
              Thuần lịch nhắc (chip trên Lịch), không đụng tiền/công nợ/lương. */}
          <section className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-dashed border-amber-300/70 dark:border-amber-700/50 bg-amber-50/40 dark:bg-amber-950/10 px-3 py-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
              <Shirt className="w-3.5 h-3.5" /> Nhắc thuê đồ
            </span>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Lấy trước
              <Input type="number" min={0} max={30} className="h-7 w-14 text-xs text-center" placeholder="3"
                value={dressWarnPickupDays} onChange={e => setDressWarnPickupDays(e.target.value)} />
              ngày
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Trả sau
              <Input type="number" min={0} max={30} className="h-7 w-14 text-xs text-center" placeholder="2"
                value={dressWarnReturnDays} onChange={e => setDressWarnReturnDays(e.target.value)} />
              ngày
            </label>
            <span className="text-[10px] text-muted-foreground">
              Bỏ trống = mặc định (3/2) · lấy theo ngày thực hiện ĐẦU, trả theo ngày CUỐI · chỉ áp dụng gói nhóm "Thuê đồ"
            </span>
          </section>

          {/* E. Phụ cấp nhân sự — REMOVED (Task #487): chuyển inline vào StaffAssignmentEditor */}

          {/* D. Phân công nhân sự (booking-level) — HIDDEN (Task #487): giữ state để submit nhưng không hiển thị */}
          {false && (saleStaff.length > 0 || photoshopStaff.length > 0) && (
            <section className="space-y-2">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" /> D. Phân công (Sale / Photoshop)
              </h4>
              <div className="grid grid-cols-2 gap-2">
                {saleStaff.length > 0 && (
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-1 block">💼 Người sale</label>
                    <select
                      className="w-full h-8 border border-input rounded-lg px-2 text-xs bg-background"
                      value={saleId ?? ""}
                      onChange={e => setSaleId(e.target.value ? parseInt(e.target.value) : null)}
                    >
                      <option value="">-- Chưa chọn --</option>
                      {saleStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    {saleId && (
                      <select className="w-full h-8 border border-input rounded-lg px-2 text-xs bg-background mt-1"
                        value={saleTask} onChange={e => setSaleTask(e.target.value)}>
                        <option value="mac_dinh">— Loại sale (mặc định) —</option>
                        <option value="sale_chup_cong">Sale chụp cổng</option>
                        <option value="sale_chup_album">Sale chụp album</option>
                        <option value="sale_chup_tiec">Sale chụp tiệc</option>
                        <option value="sale_beauty">Sale beauty</option>
                        <option value="sale_prewedding">Sale prewedding</option>
                        <option value="sale_combo_cuoi">Sale combo cưới</option>
                        <option value="sale_tron_goi">Sale trọn gói</option>
                        <option value="sale_phat_sinh">Sale phát sinh</option>
                      </select>
                    )}
                  </div>
                )}
                {photoshopStaff.length > 0 && (
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-1 block">🖥️ Người photoshop</label>
                    <select
                      className="w-full h-8 border border-input rounded-lg px-2 text-xs bg-background"
                      value={photoshopId ?? ""}
                      onChange={e => setPhotoshopId(e.target.value ? parseInt(e.target.value) : null)}
                    >
                      <option value="">-- Chưa chọn --</option>
                      {photoshopStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    {photoshopId && (
                      <select className="w-full h-8 border border-input rounded-lg px-2 text-xs bg-background mt-1"
                        value={photoshopTask} onChange={e => setPhotoshopTask(e.target.value)}>
                        <option value="mac_dinh">— Loại chỉnh sửa (mặc định) —</option>
                        <option value="chinh_album">Chỉnh album</option>
                        <option value="chinh_anh_le">Chỉnh ảnh lẻ</option>
                        <option value="chinh_anh_beauty">Chỉnh ảnh beauty</option>
                        <option value="chinh_anh_cuoi">Chỉnh ảnh cưới</option>
                        <option value="blend_mau">Blend màu</option>
                        <option value="retouch_da">Retouch da</option>
                        <option value="thiet_ke_album">Thiết kế album</option>
                        <option value="xuat_file">Xuất file</option>
                      </select>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* E. Tiền */}
          <section className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <CreditCard className="w-3.5 h-3.5" /> E. Thanh toán
            </h4>
            <div className="bg-muted/40 rounded-xl p-3 space-y-2.5 border border-border/50">
              {extrasTotal > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Gói chính</span>
                    <span>{formatVND(packageTotal)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Cộng thêm</span>
                    <span className="text-primary">{formatVND(extrasTotal)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Tổng tiền:</span>
                <span className="font-bold text-base">{formatVND(totalAmount)}</span>
              </div>
              <div className="flex justify-between items-center gap-3">
                <span className="text-sm text-muted-foreground flex-shrink-0">Giảm giá:</span>
                <CurrencyInput className="h-8 text-sm text-right w-40" value={discount} placeholder="0" onChange={setDiscount} />
              </div>
              {discountNum > 0 && (
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Sau giảm giá:</span>
                  <span className="font-semibold text-emerald-600">{formatVND(afterDiscount)}</span>
                </div>
              )}
              {showActualPaid ? (
                <>
                  <div className="flex justify-between items-center gap-3">
                    <span className="text-sm text-muted-foreground flex-shrink-0">Đã cọc / Đã thu:</span>
                    <span className="font-semibold text-emerald-600">{formatVND(actualPaid)}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground -mt-1">Tổng đã thu theo lịch sử thanh toán. Muốn thu thêm / chỉnh, dùng nút <b>Thu tiền</b> ở chi tiết show (không sửa ở đây để tránh lệch tiền).</p>
                  {/* Ảnh bằng chứng cọc: xem lại + thêm (chỉ gắn ảnh vào payment cọc, KHÔNG đổi số tiền). */}
                  <div className="space-y-1.5 pt-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">🧾 Ảnh bằng chứng cọc:</span>
                      {depositPaymentId != null ? (
                        <button
                          type="button"
                          onClick={() => document.getElementById("edit-deposit-proof-input")?.click()}
                          disabled={savingDepositProof || editDepositProofs.length >= 20}
                          className={`h-8 px-3 rounded-lg text-xs font-medium border transition-all ${editDepositProofs.length > 0 ? "border-primary/30 bg-primary/10 text-primary" : "border-dashed border-border text-muted-foreground hover:border-primary/40 hover:bg-muted/20"} ${savingDepositProof ? "opacity-60 cursor-not-allowed" : ""}`}
                        >
                          {savingDepositProof ? "Đang lưu…" : <>+ Ảnh cọc {editDepositProofs.length > 0 && `(${editDepositProofs.length})`}</>}
                        </button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">Chưa có phiếu cọc, thêm ảnh qua nút <b>Thu tiền</b> nha.</span>
                      )}
                    </div>
                    {editDepositProofs.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {editDepositProofs.map((img, idx) => {
                          const src = getImageSrc(img) || img;
                          return (
                            <div key={idx} className="relative rounded-xl overflow-hidden border border-border w-24 h-24">
                              <a href={src} target="_blank" rel="noopener noreferrer" className="block w-full h-full">
                                <img src={src} alt={`Ảnh cọc ${idx + 1}`} className="w-full h-full object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                              </a>
                              <button type="button" onClick={() => handleEditDepositProofRemove(idx)} disabled={savingDepositProof} className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center disabled:opacity-50">
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {depositProofError && <p className="text-[11px] text-destructive">{depositProofError}</p>}
                    <input id="edit-deposit-proof-input" type="file" accept="image/*" multiple className="hidden" onChange={handleEditDepositProofAdd} />
                  </div>
                </>
              ) : (
                <div className="flex justify-between items-center gap-3">
                  <span className="text-sm text-muted-foreground flex-shrink-0">Đặt cọc:</span>
                  <CurrencyInput className="h-8 text-sm text-right w-40" value={deposit} placeholder="0" onChange={setDeposit} />
                </div>
              )}
              {!showActualPaid && parseFloat(deposit) > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground flex-shrink-0">H.thức cọc:</span>
                  <div className="flex gap-1 ml-auto">
                    {([{ v: "cash", label: "💵 Tiền mặt" }, { v: "bank_transfer", label: "🏦 CK" }] as { v: "cash" | "bank_transfer"; label: string }[]).map(opt => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => setDepositMethod(opt.v)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${depositMethod === opt.v ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!showActualPaid && parseFloat(deposit) > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">Ngày cọc:</span>
                    <DateInput value={depositDate} onChange={setDepositDate} className="h-8 w-[170px]" />
                    <input
                      type="time"
                      value={depositTime}
                      onChange={e => setDepositTime(e.target.value)}
                      className="h-8 w-[100px] px-2 rounded-md border border-input bg-background text-sm"
                      title="Giờ cọc (thời điểm thực tế nhận tiền)"
                    />
                    <button type="button" onClick={() => document.getElementById("deposit-proof-input")?.click()} className={`h-8 px-3 rounded-lg text-xs font-medium border transition-all ${depositProofImages.length > 0 ? "border-primary/30 bg-primary/10 text-primary" : "border-dashed border-border text-muted-foreground hover:border-primary/40 hover:bg-muted/20"}`}>
                      + Ảnh cọc {depositProofImages.length > 0 && `(${depositProofImages.length})`}
                    </button>
                  </div>
                  {depositProofImages.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {depositProofImages.map((img, idx) => (
                        <div key={idx} className="relative rounded-xl overflow-hidden border border-border w-24 h-24">
                          <img src={img} alt={`Ảnh cọc ${idx + 1}`} className="w-full h-full object-cover" />
                          <button type="button" onClick={() => setDepositProofImages(prev => prev.filter((_, i) => i !== idx))} className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <input id="deposit-proof-input" type="file" accept="image/*" multiple className="hidden" onChange={handleDepositProofChange} />
                </div>
              )}
              <div className="flex justify-between items-center border-t border-border/60 pt-2">
                <span className="text-sm font-semibold">Còn lại:</span>
                <span className={`font-bold text-base ${remaining > 0 ? "text-destructive" : "text-emerald-600"}`}>{formatVND(remaining)}</span>
              </div>
            </div>
          </section>

          {/* Đã bỏ ô "Số tấm ảnh chỉnh" khỏi form: studio không dùng cast theo số ảnh (không có rate per_photo).
              Vẫn giữ photoCount khi lưu để KHÔNG xoá giá trị cũ của các show đã nhập trước đây. */}
          <textarea
            className="w-full border border-input rounded-xl px-3 py-2 text-sm bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
            rows={2} placeholder="Ghi chú nội bộ..."
            value={notes} onChange={e => setNotes(e.target.value)}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t flex-shrink-0 bg-background/80 max-w-2xl mx-auto w-full space-y-3">
        {tempQuoteMode && (
          <div className="bg-amber-50 border border-amber-300 rounded-xl p-3 space-y-1.5 text-sm text-amber-900">
            <p className="text-[11px] font-bold uppercase tracking-wider text-amber-700">Báo giá tạm tính — chưa phải hợp đồng chính thức</p>
            <div className="flex justify-between">
              <span>Tổng dịch vụ:</span>
              <span className="font-semibold">{formatVND(totalAmount)}</span>
            </div>
            {discountNum > 0 && (
              <div className="flex justify-between">
                <span>Giảm giá:</span>
                <span>−{formatVND(discountNum)}</span>
              </div>
            )}
            <div className="flex justify-between items-center border-t border-amber-300/60 pt-1.5">
              <span className="font-semibold">Tổng tạm tính:</span>
              <span className="font-bold text-base text-amber-700">{formatVND(afterDiscount)}</span>
            </div>
          </div>
        )}
        {tempQuoteMode ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={copyQuoteText} className="flex-1 gap-2 h-11">
              <Copy className="w-4 h-4" /> Copy báo giá gửi khách
            </Button>
            <Button onClick={save} disabled={saving || isUploadingImages || !extrasFormValidation.ok} className="flex-1 gap-2 h-11 bg-amber-500 hover:bg-amber-600 text-white">
              {saving
                ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang lưu...</>
                : isUploadingImages
                  ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang tải ảnh…</>
                  : <><Save className="w-4 h-4" /> Lưu báo giá tạm</>
              }
            </Button>
          </div>
        ) : (
          <Button onClick={save} disabled={saving || isUploadingImages || !extrasFormValidation.ok} className="w-full gap-2 h-11">
            {saving
              ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang lưu...</>
              : isUploadingImages
                ? <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang tải ảnh… (chờ tải xong để khỏi mất ảnh)</>
                : <><Save className="w-4 h-4" /> {isEdit ? "Cập nhật show" : "Lưu & tạo show"}</>
            }
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Show Detail Panel (read-only, Google Calendar style) ─────────────────────
type DetailAddon = { key: string; name: string; price: number };
type DetailPackage = { id: number; code: string; name?: string; addons?: DetailAddon[]; products?: string[]; items?: PkgItem[]; description?: string | null; notes?: string | null };

// ─── Xuất hợp đồng PDF ────────────────────────────────────────────────────────
const STUDIO_INFO = {
  name: "Amazing Studio",
  desc: "Chụp ảnh cưới & cho thuê váy cưới chuyên nghiệp",
  address: "Số 80, Hẻm 71, CMT8, KP Hiệp Bình, P. Hiệp Ninh, Tây Ninh",
  phone: "0392817079",
};

function fmtVNDStr(n: number) {
  return n.toLocaleString("vi-VN") + " đ";
}

function formatShootDate(dateStr: string): string {
  try { const d = parseISO(dateStr); return isNaN(d.getTime()) ? dateStr : format(d, "dd/MM/yyyy"); } catch { return dateStr; }
}

function safeFormatDate(input: string | number | Date | null | undefined, fallback = "—"): string {
  if (!input) return fallback;
  try { const d = new Date(input); return isNaN(d.getTime()) ? fallback : format(d, "dd/MM/yyyy"); } catch { return fallback; }
}

async function buildContractImages(htmlContent: string): Promise<string[]> {
  const html2canvas = (await import("html2canvas")).default;

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0";
  container.style.width = "820px";
  container.style.background = "#fff";
  container.style.zIndex = "-9999";
  container.innerHTML = htmlContent;
  document.body.appendChild(container);

  const pageDivs: HTMLElement[] = [];

  try {
    await new Promise(resolve => setTimeout(resolve, 600));

    const pageHeight = 1200;
    const totalHeight = container.scrollHeight;
    const pageCount = Math.max(1, Math.ceil(totalHeight / pageHeight));
    const dataUrls: string[] = [];

    for (let i = 0; i < pageCount; i++) {
      const pageDiv = document.createElement("div");
      pageDiv.style.position = "fixed";
      pageDiv.style.left = "-10000px";
      pageDiv.style.top = "0";
      pageDiv.style.width = "820px";
      pageDiv.style.height = pageHeight + "px";
      pageDiv.style.overflow = "hidden";
      pageDiv.style.background = "#fff";
      pageDiv.style.zIndex = "-9999";

      const cloned = container.cloneNode(true) as HTMLElement;
      cloned.style.marginTop = `-${i * pageHeight}px`;
      cloned.style.width = "820px";
      pageDiv.appendChild(cloned);
      document.body.appendChild(pageDiv);
      pageDivs.push(pageDiv);

      const canvas = await html2canvas(pageDiv, { scale: 2, useCORS: true, logging: false, backgroundColor: "#ffffff" });
      dataUrls.push(canvas.toDataURL("image/jpeg", 0.95));
    }

    return dataUrls;
  } finally {
    pageDivs.forEach(div => { if (div.parentNode) div.parentNode.removeChild(div); });
    if (container.parentNode) container.parentNode.removeChild(container);
  }
}

type ContractPayment = { amount?: number; paymentMethod?: string; collectorName?: string; paidDate?: string; paidAt?: string; notes?: string };

function generateContractHTML(
  booking: Booking,
  siblings: Booking[],
  allPackages: DetailPackage[],
  paymentSummary?: { totalAmount: number; paidAmount: number; discountAmount?: number; remainingAmount: number },
  forImageExport = false,
  paymentHistoryList: ContractPayment[] = [],
  signatureInfo?: { signatureImageUrl?: string | null; signerName?: string | null; signerPhone?: string | null; signedAt?: string | null },
): string {
  const today = new Date();
  const todayStr = format(today, "dd/MM/yyyy");

  // Multi-service: use siblings list; single: just this booking
  const allServices = siblings.length > 0 ? siblings : [booking];
  const isMulti = allServices.length > 1;

  // Payment summary: use caller-supplied summary (from parentContract or booking) — same source as on-screen
  const totalAmount     = Number(paymentSummary?.totalAmount     ?? booking.totalAmount     ?? 0) || 0;
  const paidAmount      = Number(paymentSummary?.paidAmount      ?? booking.paidAmount      ?? 0) || 0;
  const discountAmount  = Number(paymentSummary?.discountAmount  ?? booking.discountAmount  ?? 0) || 0;
  const remainingAmount = Number(paymentSummary?.remainingAmount ?? booking.remainingAmount ?? Math.max(0, totalAmount - discountAmount - paidAmount)) || 0;
  const paymentRows = [...paymentHistoryList].sort((a, b) => {
    const ta = new Date(a.paidDate || a.paidAt || 0).getTime();
    const tb = new Date(b.paidDate || b.paidAt || 0).getTime();
    return ta - tb;
  });
  let runningPaid = 0;

  // ── Lịch chụp section — đã gộp vào header mỗi dịch vụ trong phần Thanh toán ──

  // ── Helper: render 1 dịch vụ (1 booking + chi tiết gói) ──────────────────
  function renderServiceBlock(b: Booking, idx: number): string {
    const orderLines = b.items || [];
    const surcharges = b.surcharges || [];
    const surchargesTotal = surcharges.reduce((s, i) => s + (i.amount || 0), 0);
    const serviceTotal = (b.totalAmount || 0);
    const serviceLabel = b.serviceLabel || b.packageType || `Dịch vụ ${idx + 1}`;

    // For each order line, look up the package for full details
    const linesHTML = orderLines.map((line) => {
      const pkgId = line.serviceKey?.startsWith("pkg-") ? parseInt(line.serviceKey.replace("pkg-", "")) : null;
      const pkg = pkgId ? allPackages.find(p => p.id === pkgId) : null;
      const pkgName = pkg?.name || line.serviceName || "—";

      const pkgDescription = pkg?.description || "";

      const _staffLines: string[] = [];
      if (line.photoName) _staffLines.push(`📷 Nhiếp ảnh: <strong>${line.photoName}</strong>`);
      if (line.makeupName) _staffLines.push(`💄 Makeup: <strong>${line.makeupName}</strong>`);
      // Additional roles from assignedStaff (assistant, support, video…)
      if (Array.isArray(line.assignedStaff)) {
        const _extraRoleLabel: Record<string, string> = {
          assistant: "🤝 Trợ lý",
          support: "🙋 Hỗ trợ",
          videographer: "🎥 Quay phim",
          assistant_photo: "🔧 Thợ phụ",
        };
        for (const _sa of line.assignedStaff as StaffAssignment[]) {
          // canonicalRole gom các biến thể (video/videographer, tro_ly/assistant…) → khớp đúng nhãn.
          const _label = _extraRoleLabel[canonicalRole(_sa.role)];
          if (_label && _sa.staffName) _staffLines.push(`${_label}: <strong>${_sa.staffName}</strong>`);
        }
      }
      const staffHTML = _staffLines.length > 0
        ? `<div style="margin-top:8px;padding:6px 10px;background:#f0f4ff;border-radius:6px;font-size:12px;color:#555;">
            ${_staffLines.join("&nbsp;&nbsp;|&nbsp;&nbsp;")}
           </div>`
        : "";

      const lineDeductions = (line.deductions || []) as { label: string; amount: number }[];
      const lineDeductHTML = lineDeductions.length > 0
        ? `<div style="margin-top:10px;padding:8px 12px;background:#fff5f5;border-radius:8px;border:1px solid #fce4e4;">
             <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#c0392b;margin-bottom:6px;">⬇ Giảm trừ dịch vụ:</div>
             ${lineDeductions.map(d => `
               <div style="display:flex;justify-content:space-between;font-size:13px;padding:3px 0;">
                 <span style="color:#c0392b;">− ${d.label}</span>
                 <span style="font-weight:600;color:#c0392b;">−${fmtVNDStr(d.amount)}</span>
               </div>`).join("")}
           </div>`
        : "";

      return `
        <div style="border:1px solid #ddd;border-radius:10px;padding:16px;margin-bottom:12px;background:#fff;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div style="flex:1;">
              <div style="font-weight:700;font-size:15px;color:#111;">${pkgName}</div>
              ${pkgDescription ? `<div style="font-size:12px;color:#666;margin-top:3px;font-style:italic;">${pkgDescription}</div>` : ""}
            </div>
            <div style="font-size:16px;font-weight:800;color:#111;white-space:nowrap;margin-left:16px;">${fmtVNDStr(line.price || 0)}</div>
          </div>
          ${staffHTML}
          ${lineDeductHTML}
        </div>
      `;
    }).join("");

    const surchargesHTML = surcharges.length > 0
      ? `<div style="margin-top:4px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#c0392b;margin-bottom:6px;">Phụ thu / Phát sinh:</div>
          ${surcharges.map(s => `
            <div style="display:flex;justify-content:space-between;padding:5px 10px;background:#fff5f5;border-radius:6px;margin-bottom:4px;font-size:13px;">
              <span style="color:#c0392b;">+ ${s.name}</span>
              <span style="font-weight:600;color:#c0392b;">${fmtVNDStr(s.amount)}</span>
            </div>
          `).join("")}
         </div>`
      : "";

    const serviceTotalHTML = isMulti
      ? `<div style="display:flex;justify-content:flex-end;margin-top:8px;">
          <div style="background:#f5f5f5;border-radius:8px;padding:8px 16px;font-size:13px;">
            Thành tiền: <strong style="color:#111;font-size:15px;">${fmtVNDStr(serviceTotal)}</strong>
          </div>
         </div>`
      : "";

    const header = isMulti
      ? `<div style="border-left:4px solid #222;padding:10px 16px;margin-bottom:14px;border-radius:0 8px 8px 0;">
          <div style="font-weight:700;font-size:14px;color:#111;">📋 ${serviceLabel}</div>
          <div style="font-size:12px;color:#888;margin-top:2px;">${formatShootDate(b.shootDate)} &nbsp;·&nbsp; ${b.shootTime?.slice(0,5) || "—"}${b.location ? ` &nbsp;·&nbsp; ${b.location}` : ""}</div>
         </div>`
      : "";

    return `
      <div style="${isMulti ? "border:1px solid #ddd;border-radius:12px;padding:16px;margin-bottom:20px;" : ""}">
        ${header}
        ${linesHTML || `<div style="color:#888;font-style:italic;font-size:13px;padding:10px 0;">(Chưa có dịch vụ cụ thể)</div>`}
        ${surchargesHTML}
        ${serviceTotalHTML}
      </div>
    `;
  }

  const servicesHTML = allServices.map((b, idx) => renderServiceBlock(b, idx)).join("");
  const contractCode = booking.orderCode || `HD-${String(booking.id).padStart(4, "0")}`;
  const notesHTML = allServices.flatMap(b => b.notes ? [b.notes] : []).join(" | ");

  // ── Tổng hợp tất cả phụ thu (per-line + booking-level) ────────────────────
  const allLineSurcharges = allServices.flatMap(b => (b.items || []).flatMap(l => (l.surcharges || []) as { name: string; amount: number }[]));
  const allBookingSurcharges = allServices.flatMap(b => (b.surcharges || []) as { name: string; amount: number }[]);
  const allSurchargesFlat = [...allLineSurcharges, ...allBookingSurcharges];
  const totalSurchargesAmount = allSurchargesFlat.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  // ── Tổng hợp tất cả giảm trừ (per-line) ────────────────────────────────────
  const allLineDeductions = allServices.flatMap(b => (b.items || []).flatMap(l => (l.deductions || []) as { label: string; amount: number }[]));
  const totalDeductionsAmount = allLineDeductions.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const baseServicesAmount = Math.max(0, totalAmount - totalSurchargesAmount + totalDeductionsAmount);

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hóa Đơn Dịch Vụ - ${contractCode}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Be Vietnam Pro',sans-serif; color:#2c2c2c; background:#fff; font-size:14px; line-height:1.5; }
  .page { max-width:820px; margin:0 auto; padding:40px; }
  ul li { margin-bottom:2px; }
  @media print {
    body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .no-print { display:none !important; }
    .page { padding:24px; }
    #contract-body { outline:none !important; padding:0 !important; border-radius:0 !important; cursor:default !important; }
  }
</style>
</head>
<body>
<div class="page">

  ${!forImageExport ? `<!-- Nút in + Chỉnh sửa -->
  <div class="no-print" style="display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-bottom:24px;flex-wrap:wrap;">
    <span id="edit-hint" style="display:none;font-size:12px;color:#555;font-style:italic;margin-right:auto;">✏️ Đang chỉnh sửa — bấm vào bất kỳ chỗ nào để sửa nội dung</span>
    <button id="btn-edit" class="no-print" onclick="toggleEdit()" style="background:#666;color:#fff;border:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;letter-spacing:0.3px;">
      ✏️ Chỉnh sửa bản này
    </button>
    <button class="no-print" onclick="window.print()" style="background:#222;color:#fff;border:none;padding:11px 28px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;letter-spacing:0.3px;">
      🖨️ In / Lưu PDF
    </button>
  </div>` : ""}

  <div id="contract-body">

  <!-- Header Studio -->
  <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:28px;padding-bottom:20px;border-bottom:2px solid #222;">
    <div>
      <div style="font-size:26px;font-weight:800;color:#111;letter-spacing:-0.5px;">✨ ${STUDIO_INFO.name}</div>
      <div style="color:#555;font-size:12.5px;margin-top:5px;">${STUDIO_INFO.desc}</div>
      <div style="color:#444;font-size:12px;margin-top:4px;">📍 ${STUDIO_INFO.address}</div>
      <div style="color:#444;font-size:12px;margin-top:2px;">📞 ${STUDIO_INFO.phone}</div>
    </div>
    <div style="text-align:right;min-width:180px;">
      <div style="font-size:20px;font-weight:800;color:#111;text-transform:uppercase;">Hóa Đơn Dịch Vụ</div>
      <div style="font-size:13px;color:#444;margin-top:8px;">Số HĐ: <strong style="color:#111;">${contractCode}</strong></div>
      <div style="font-size:13px;color:#444;margin-top:3px;">Ngày lập: <strong style="color:#111;">${todayStr}</strong></div>
    </div>
  </div>

  <!-- 2 bên -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
    <div style="border:1px solid #ddd;border-radius:10px;padding:16px;">
      <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#111;margin-bottom:10px;">🏢 Bên A — Cung cấp dịch vụ</div>
      <div style="font-weight:700;font-size:14px;color:#111;">${STUDIO_INFO.name}</div>
      <div style="color:#444;margin-top:5px;font-size:12.5px;">📍 ${STUDIO_INFO.address}</div>
      <div style="color:#444;margin-top:3px;font-size:12.5px;">📞 ${STUDIO_INFO.phone}</div>
    </div>
    <div style="border:1px solid #ddd;border-radius:10px;padding:16px;">
      <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#111;margin-bottom:10px;">👤 Bên B — Khách hàng</div>
      <div style="font-weight:700;font-size:14px;color:#111;">${booking.customerName}</div>
      <div style="color:#444;margin-top:5px;font-size:12.5px;">📞 ${booking.customerPhone || "—"}</div>
    </div>
  </div>

  <!-- Thanh toán — breakdown từng dịch vụ -->
  <div style="margin-bottom:24px;">
    <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#111;margin-bottom:14px;">💰 Thanh toán</div>
    ${allServices.map((svc, svcIdx) => {
      const sItems = svc.items || [];
      const sRealName = sItems[0]?.serviceName || svc.serviceLabel || svc.packageType || "";
      const sTitle = `DỊCH VỤ ${svcIdx + 1}${sRealName ? `: ${sRealName}` : ""}`;
      const sBookingSurcharges = (svc.surcharges || []) as { name?: string; label?: string; amount: number }[];
      const sItemSurcharges = sItems.flatMap(it => (it.surcharges || []) as { name?: string; label?: string; amount: number }[]);
      const sAllSurcharges = [...sBookingSurcharges, ...sItemSurcharges];
      const sBase = sItems.reduce((s, it) => s + (it.price || it.unitPrice || 0), 0) || svc.totalAmount || 0;
      const sDeductions = sItems.flatMap(it => (it.deductions || []) as { label: string; amount: number }[]);
      const sPkgId = sItems[0]?.serviceKey?.startsWith("pkg-") ? parseInt(sItems[0].serviceKey.replace("pkg-", "")) : null;
      const sPkg = sPkgId ? allPackages.find(p => p.id === sPkgId) : null;
      const sPkgDesc = sPkg?.description || "";
      let sSubtitle: string | null = null;
      if (svc.shootDate) {
        let dateStr = svc.shootDate;
        try { dateStr = new Date(svc.shootDate).toLocaleDateString("vi-VN"); } catch { /* keep raw */ }
        sSubtitle = `📅 ${dateStr}${svc.shootTime ? ` • ${svc.shootTime.slice(0, 5)}` : ""}`;
      }
      return renderServiceBreakdownCardHTML({
        title: sTitle,
        subtitle: sSubtitle,
        description: sPkgDesc,
        basePrice: sBase,
        surcharges: sAllSurcharges,
        deductions: sDeductions,
        finalAmount: svc.totalAmount ?? sBase,
        formatVND: fmtVNDStr,
      });
    }).join("")}

    <div style="background:#111;border-radius:12px;padding:18px 22px;color:#fff;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:14px;">
        <span>Tổng tiền các dịch vụ</span>
        <span style="font-size:20px;font-weight:800;">${fmtVNDStr(totalAmount)}</span>
      </div>
      ${discountAmount > 0 ? `
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;">
        <span style="opacity:0.9;">🎁 Giảm giá chung hợp đồng</span>
        <span style="font-weight:600;">-${fmtVNDStr(discountAmount)}</span>
      </div>
      <div style="height:1px;background:rgba(255,255,255,0.25);margin:6px 0;"></div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13.5px;">
        <span style="opacity:0.9;">Tổng sau giảm</span>
        <span style="font-weight:700;">${fmtVNDStr(Math.max(0, totalAmount - discountAmount))}</span>
      </div>` : ""}
      <div style="display:flex;justify-content:space-between;margin-bottom:7px;font-size:13.5px;">
        <span style="opacity:0.9;">✅ Đã cọc / Đã thu</span>
        <span style="font-weight:600;">${fmtVNDStr(paidAmount)}</span>
      </div>
      <div style="height:1px;background:rgba(255,255,255,0.25);margin:6px 0;"></div>
      <div style="display:flex;justify-content:space-between;font-size:14px;">
        <span style="opacity:0.9;">💰 Còn lại cần thanh toán</span>
        <span style="font-weight:800;font-size:17px;">${fmtVNDStr(remainingAmount)}</span>
      </div>
    </div>
  </div>

  ${paymentHistoryList.length > 0 ? `
  <!-- Lịch sử thanh toán -->
  <div style="margin-bottom:24px;page-break-inside:avoid;">
    <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#111;margin-bottom:10px;">🧾 Lịch sử thanh toán</div>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:8px 12px;text-align:left;color:#111;font-weight:700;border-bottom:2px solid #999;">Ngày</th>
          <th style="padding:8px 12px;text-align:left;color:#111;font-weight:700;border-bottom:2px solid #999;">Hình thức</th>
          <th style="padding:8px 12px;text-align:left;color:#111;font-weight:700;border-bottom:2px solid #999;">Người thu</th>
          <th style="padding:8px 12px;text-align:right;color:#111;font-weight:700;border-bottom:2px solid #999;">Số tiền</th>
          <th style="padding:8px 12px;text-align:right;color:#111;font-weight:700;border-bottom:2px solid #999;">Còn lại</th>
        </tr>
      </thead>
      <tbody>
        ${paymentRows.map((p, idx) => {
          const dateVal = p.paidDate || p.paidAt || "";
          const dateDisp = safeFormatDate(dateVal);
          const methodDisp = p.paymentMethod === "bank_transfer" ? "Chuyển khoản" : "Tiền mặt";
          const rowBg = idx % 2 === 1 ? "background:#fafafa;" : "";
          runningPaid += Number(p.amount) || 0;
          const rowRemaining = Math.max(0, totalAmount - discountAmount - runningPaid);
          return `<tr style="${rowBg}">
            <td style="padding:7px 12px;border-bottom:1px solid #eee;">${dateDisp}</td>
            <td style="padding:7px 12px;border-bottom:1px solid #eee;">${methodDisp}</td>
            <td style="padding:7px 12px;border-bottom:1px solid #eee;color:#444;">${p.collectorName || "—"}</td>
            <td style="padding:7px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700;color:#1a7a4b;">+${fmtVNDStr(p.amount ?? 0)}</td>
            <td style="padding:7px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700;color:#111;">${fmtVNDStr(rowRemaining)}</td>
          </tr>`;
        }).join("")}
        <tr style="background:#f0fff4;">
          <td colspan="4" style="padding:8px 12px;font-weight:700;color:#1a7a4b;">Tổng đã thu</td>
          <td style="padding:8px 12px;text-align:right;font-weight:800;font-size:14px;color:#1a7a4b;">${fmtVNDStr(paidAmount)}</td>
        </tr>
      </tbody>
    </table>
  </div>
  ` : ""}

  ${notesHTML ? `
  <!-- Ghi chú -->
  <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:10px;padding:14px 18px;margin-bottom:24px;">
    <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#f57f17;margin-bottom:7px;">📝 Ghi chú</div>
    <div style="color:#555;font-size:13px;line-height:1.7;">${notesHTML}</div>
  </div>
  ` : ""}

  <!-- Điều khoản -->
  <div style="margin-bottom:32px;page-break-inside:avoid;">
    <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#111;margin-bottom:10px;">📋 Điều khoản &amp; cam kết</div>
    <div style="background:#f9f9f9;border:1px solid #eee;border-radius:10px;padding:16px 20px;font-size:12.5px;color:#444;line-height:1.85;">
      <p style="margin-bottom:6px;">✅ Bên A cam kết thực hiện đầy đủ dịch vụ theo nội dung đã thống nhất.</p>
      <p style="margin-bottom:6px;">✅ Khách thanh toán 100% chi phí còn lại ngay sau buổi chụp để nhận file.</p>
      <p style="margin-bottom:10px;">✅ Chưa thanh toán đủ, studio có quyền giữ sản phẩm.</p>

      <p style="font-weight:700;color:#333;margin-bottom:4px;">📅 Dời / hủy lịch:</p>
      <ul style="margin:0 0 10px 18px;padding:0;">
        <li style="margin-bottom:3px;">Dời 1 lần miễn phí nếu báo trước ≥ 3 ngày.</li>
        <li style="margin-bottom:3px;">Báo trễ / dời nhiều lần: có thể phát sinh phí.</li>
        <li style="margin-bottom:3px;">Hủy lịch: <strong>không hoàn cọc.</strong></li>
      </ul>

      <p style="font-weight:700;color:#333;margin-bottom:4px;">👗 Trang phục:</p>
      <ul style="margin:0 0 10px 18px;padding:0;">
        <li style="margin-bottom:3px;">Khách giữ gìn váy, vest, phụ kiện trong suốt buổi chụp.</li>
        <li style="margin-bottom:3px;">Hư hỏng / dơ nặng → đền bù theo thực tế.</li>
      </ul>

      <p style="font-weight:700;color:#333;margin-bottom:4px;">📦 Giao sản phẩm:</p>
      <ul style="margin:0 0 10px 18px;padding:0;">
        <li style="margin-bottom:3px;">Studio giao đúng thời gian cam kết.</li>
        <li style="margin-bottom:3px;">Yêu cầu gấp → có thể tính phí.</li>
      </ul>

      <p style="font-weight:700;color:#333;margin-bottom:4px;">⚡ Phát sinh:</p>
      <ul style="margin:0 0 10px 18px;padding:0;">
        <li style="margin-bottom:3px;">Các yêu cầu ngoài gói sẽ tính phí riêng.</li>
      </ul>

      <p style="margin-top:6px;font-style:italic;color:#666;">Hai bên xác nhận và đồng ý toàn bộ nội dung hóa đơn dịch vụ này.</p>
    </div>
  </div>

  <!-- Chữ ký -->
  <div style="page-break-inside:avoid;">
    <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#111;margin-bottom:14px;">✍️ Xác nhận &amp; ký tên</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:40px;">
      <div style="text-align:center;border:1px dashed #bbb;border-radius:10px;padding:20px 16px;">
        <div style="font-weight:700;font-size:13px;color:#111;margin-bottom:4px;">Bên A – Amazing Studio</div>
        <div style="font-size:11.5px;color:#888;margin-bottom:3px;">Đại diện ký tên</div>
        <div style="height:70px;border-bottom:1.5px solid #bbb;margin:12px 24px 8px;"></div>
        <div style="font-size:11.5px;color:#888;font-style:italic;">(Ký, ghi rõ họ tên)</div>
        <div style="margin-top:10px;font-size:12px;color:#666;">Ngày ___/___/______</div>
      </div>
      <div style="text-align:center;border:${signatureInfo?.signatureImageUrl ? "1.5px solid #a7f3d0" : "1px dashed #bbb"};border-radius:10px;padding:20px 16px;${signatureInfo?.signatureImageUrl ? "background:#f0fdf4;" : ""}">
        <div style="font-weight:700;font-size:13px;color:#111;margin-bottom:4px;">Bên B – Khách hàng</div>
        <div style="font-size:11.5px;color:#888;margin-bottom:3px;">${signatureInfo?.signerName || booking.customerName}</div>
        ${signatureInfo?.signerPhone ? `<div style="font-size:11px;color:#aaa;margin-bottom:6px;">${signatureInfo.signerPhone}</div>` : ""}
        ${signatureInfo?.signatureImageUrl
          ? `<img src="${signatureInfo.signatureImageUrl}" style="max-width:100%;max-height:100px;object-fit:contain;margin:8px auto 6px;display:block;border-radius:8px;background:#fff;padding:6px;border:1px solid #ddd;" />`
          : `<div style="height:70px;border-bottom:1.5px solid #bbb;margin:12px 24px 8px;"></div>`
        }
        <div style="font-size:11.5px;color:${signatureInfo?.signatureImageUrl ? "#065f46" : "#888"};font-style:italic;font-weight:${signatureInfo?.signatureImageUrl ? "700" : "400"};">${signatureInfo?.signatureImageUrl ? "✅ Đã ký xác nhận" : "(Ký, ghi rõ họ tên)"}</div>
        <div style="margin-top:10px;font-size:12px;color:#666;">${signatureInfo?.signedAt ? `Ngày ${safeFormatDate(signatureInfo.signedAt)}` : "Ngày ___/___/______"}</div>
      </div>
    </div>
  </div>

  <div style="text-align:center;margin-top:36px;padding-top:16px;border-top:1px solid #ddd;color:#999;font-size:11px;">
    Hóa đơn được tạo bởi Amazing Studio · ${todayStr}
  </div>

  </div><!-- end contract-body -->

</div>
${!forImageExport ? `<script>
  var editMode = false;
  function toggleEdit() {
    editMode = !editMode;
    var body = document.getElementById('contract-body');
    var btn = document.getElementById('btn-edit');
    var hint = document.getElementById('edit-hint');
    if (editMode) {
      body.contentEditable = 'true';
      body.style.outline = '2px dashed #999';
      body.style.borderRadius = '8px';
      body.style.padding = '8px';
      body.style.cursor = 'text';
      btn.textContent = '\u2705 Xong ch\u1ec9nh s\u1eeda';
      btn.style.background = '#27ae60';
      hint.style.display = 'inline';
      body.focus();
    } else {
      body.contentEditable = 'false';
      body.style.outline = 'none';
      body.style.padding = '';
      body.style.borderRadius = '';
      body.style.cursor = '';
      btn.textContent = '\u270f\ufe0f Ch\u1ec9nh s\u1eeda b\u1ea3n n\u00e0y';
      btn.style.background = '#7f8c8d';
      hint.style.display = 'none';
    }
  }
</script>` : ""}
</body>
</html>`;
}

function ShowDetailPanel({
  booking, onClose, onEdit, onDeleteDone, isAdmin, onNavigate, onEditAllSiblings, viewerId,
}: {
  booking: Booking;
  onClose: () => void;
  onEdit: (parent?: Booking, siblings?: Booking[]) => void;
  onDeleteDone: () => void;
  isAdmin: boolean;
  onNavigate?: (booking: Booking) => void;
  onEditAllSiblings?: (parent: Booking, siblings: Booking[]) => void;
  viewerId?: number | null;
}) {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const { data: allStaff = [] } = useQuery<Staff[]>({
    queryKey: ["staff-assignable"],
    queryFn: () => authFetch(`${BASE}/api/staff/assignable`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []),
    staleTime: 60_000,
  });
  const { data: allPackages = [] } = useQuery<DetailPackage[]>({
    queryKey: ["service-packages"],
    queryFn: () => authFetch(`${BASE}/api/service-packages`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []),
    staleTime: 60_000,
  });
  const { data: customersList = [] } = useQuery<Customer[]>({
    queryKey: ["customers", "all-avatars"],
    queryFn: () => authFetch(`${BASE}/api/customers`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d as Customer[] : []),
    staleTime: 60_000,
  });
  const customerAvatarMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of customersList) if (c.id && c.avatar) m.set(c.id, c.avatar);
    return m;
  }, [customersList]);

  // ── Fetch full detail (always — needed for siblings/parentContract and fresh paidAmount) ──
  const { data: fullDetail } = useQuery<Booking & { siblings?: Booking[]; parentContract?: Booking; children?: Booking[] }>({
    queryKey: ["booking-full", booking.id],
    queryFn: () => authFetch(`${BASE}/api/bookings/${booking.id}`).then(r => r.json()),
    enabled: true,
    staleTime: 0,
  });
  const siblings: Booking[] = [...(fullDetail?.siblings ?? [])].sort((a, b) => {
    const codeA = a.orderCode || "";
    const codeB = b.orderCode || "";
    const suffA = parseInt(codeA.split("-").pop() || "0") || 0;
    const suffB = parseInt(codeB.split("-").pop() || "0") || 0;
    if (suffA !== suffB) return suffA - suffB;
    return (a.shootDate || "").localeCompare(b.shootDate || "");
  });
  const parentContract: (Booking & { remainingAmount: number; paidAmount: number }) | null = (fullDetail?.parentContract as (Booking & { remainingAmount: number; paidAmount: number })) ?? null;

  // ── Booking dresses (outfits) for this booking ───────────────────────────
  type BookingDress = { id: number; booking_id: number; dress_id: number; outfit_code: string | null; outfit_name: string | null; outfit_image: string | null; category: string | null; size: string | null; rental_price: string | null; pickup_date: string | null; return_date: string | null; status: string | null; note: string | null };
  const { data: bookingDresses = [] } = useQuery<BookingDress[]>({
    queryKey: ["booking-dresses", booking.id],
    queryFn: () => authFetch(`${BASE}/api/bookings/${booking.id}/dresses`).then(r => r.ok ? r.json() : []),
    staleTime: 30_000,
  });

  // ── Payment history for this booking ─────────────────────────────────────
  type BookingPayment = { id?: number; amount?: number; paymentMethod?: string; paymentType?: string; collectorName?: string; notes?: string; paidAt?: string; paidDate?: string; proofImageUrl?: string | null; proofImageUrls?: string[] };
  const paymentTargetId = fullDetail?.parentContract?.id ?? booking.parentId ?? booking.id;
  const { data: paymentHistory = [] } = useQuery<BookingPayment[]>({
    queryKey: ["payments", paymentTargetId],
    queryFn: () => authFetch(`${BASE}/api/payments?bookingId=${paymentTargetId}`).then(r => r.ok ? r.json() : []),
    staleTime: 0,
  });

  type ChildRemovalLog = { id: number; bookingId: number; fieldChanged: string; oldValue: string | null; reason: string | null; changedByName: string | null; createdAt: string };
  const parentIdForLog = parentContract?.id ?? (booking.isParentContract ? booking.id : null);
  const { data: childRemovalLogs = [] } = useQuery<ChildRemovalLog[]>({
    queryKey: ["child-removal-log", parentIdForLog],
    queryFn: () => authFetch(`${BASE}/api/bookings/${parentIdForLog}/change-log?field=remove_child`).then(r => r.ok ? r.json() : []),
    enabled: isAdmin && !!parentIdForLog,
    staleTime: 30_000,
  });

  // Toàn bộ lịch sử chỉnh sửa đơn này (loại trừ remove_child vì có block riêng)
  type BookingChange = { id: number; bookingId: number; fieldChanged: string; oldValue: string | null; newValue: string | null; reason: string | null; changedByName: string | null; createdAt: string };
  const { data: bookingChanges = [] } = useQuery<BookingChange[]>({
    queryKey: ["booking-change-log", booking.id],
    queryFn: () => authFetch(`${BASE}/api/bookings/${booking.id}/change-log`).then(r => r.ok ? r.json() : []),
    staleTime: 15_000,
  });
  const editChanges = bookingChanges.filter(c => c.fieldChanged !== "remove_child");
  const FIELD_LABEL: Record<string, string> = {
    shootDate: "Ngày chụp", shootTime: "Giờ chụp", duration: "Thời lượng",
    location: "Địa điểm", notes: "Ghi chú", internalNotes: "Ghi chú nội bộ",
    serviceLabel: "Tên dịch vụ", status: "Trạng thái",
    totalAmount: "Tổng tiền", discountAmount: "Giảm giá", depositAmount: "Tiền cọc",
    customerName: "Khách hàng", assignedStaff: "Nhân sự", items: "Dịch vụ",
    surcharges: "Phụ thu", deductions: "Khấu trừ",
  };

  const [deleting, setDeleting] = useState(false);
  const [removingChildId, setRemovingChildId] = useState<number | null>(null);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  // Các dịch vụ admin đã chủ động THU GỌN (dịch vụ đang xem mặc định xổ ra; bấm để gập lại).
  const [collapsedSvcIds, setCollapsedSvcIds] = useState<Set<number>>(new Set());

  const [showContractImages, setShowContractImages] = useState(false);
  const [contractImageUrls, setContractImageUrls] = useState<string[]>([]);
  const [contractImagesLoading, setContractImagesLoading] = useState(false);

  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleForm, setRescheduleForm] = useState({ newDate: booking.shootDate, newTime: booking.shootTime || "", reason: "" });
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const [rescheduleConflicts, setRescheduleConflicts] = useState<{ customerName: string; date: string; time: string; staffNames?: string }[]>([]);
  const [rescheduling, setRescheduling] = useState(false);
  const st = STATUS[booking.status as keyof typeof STATUS] ?? STATUS.pending;

  // Parse assignedStaff — might be StaffAssignment array (new) or legacy object
  const _assignedArr = Array.isArray(booking.assignedStaff)
    ? (booking.assignedStaff as { role?: string; staffId?: unknown }[]) : [];
  const _assignedLegacy = booking.assignedStaff && !Array.isArray(booking.assignedStaff) && typeof booking.assignedStaff === "object"
    ? (booking.assignedStaff as Record<string, unknown>) : {};
  const findAssignedStaffId = (arrRole: string, legacyKey: string): number | undefined => {
    const arrEntry = _assignedArr.find(a => a.role === arrRole);
    if (arrEntry?.staffId != null) { const n = Number(arrEntry.staffId); if (!isNaN(n) && n > 0) return n; }
    const legacyVal = _assignedLegacy[legacyKey];
    if (legacyVal != null) { const n = Number(legacyVal); if (!isNaN(n) && n > 0) return n; }
    return undefined;
  };
  const saleStaffId = findAssignedStaffId("sales", "sale");
  const photoshopStaffId = findAssignedStaffId("photoshop", "photoshop");
  const saleStaffName = saleStaffId ? allStaff.find(s => s.id === saleStaffId)?.name : null;
  const photoshopStaffName = photoshopStaffId ? allStaff.find(s => s.id === photoshopStaffId)?.name : null;

  const surcharges = booking.surcharges ?? [];
  const surchargesTotal = surcharges.reduce((s, i) => s + (i.amount || 0), 0);

  const shootDateObj = useMemo(() => {
    try { const d = parseISO(booking.shootDate); return isNaN(d.getTime()) ? new Date() : d; } catch { return new Date(); }
  }, [booking.shootDate]);

  // Resolve package addons → names
  function resolveAddons(item: OrderLine): string[] {
    if (!item.selectedAddons?.length) return [];
    const pkgId = item.serviceKey?.startsWith("pkg-") ? parseInt(item.serviceKey.replace("pkg-", "")) : null;
    if (!pkgId) return item.selectedAddons;
    const pkg = allPackages.find(p => p.id === pkgId);
    if (!pkg?.addons) return item.selectedAddons;
    return item.selectedAddons.map(k => pkg.addons!.find(a => a.key === k)?.name ?? k);
  }

  // Resolve package products/description for first item
  function getPackageDetail(item: OrderLine): { description?: string | null; notes?: string | null; products?: string[]; items?: PkgItem[] } {
    const pkgId = item.serviceKey?.startsWith("pkg-") ? parseInt(item.serviceKey.replace("pkg-", "")) : null;
    if (!pkgId) return {};
    const pkg = allPackages.find(p => p.id === pkgId);
    return pkg ? { description: pkg.description, notes: pkg.notes, products: pkg.products, items: pkg.items } : {};
  }

  const handleDelete = async () => {
    if (!booking?.id) {
      alert("Không xác định được show cần xoá.");
      return;
    }
    if (!confirm("Đưa show này vào thùng rác? Admin có thể phục hồi lại từ Thùng rác Booking.")) return;
    setDeleting(true);
    try {
      const res = await authFetch(`${BASE}/api/bookings/${booking.id}`, { method: "DELETE" });
      if (!res.ok) {
        let msg = `Xoá thất bại (HTTP ${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {}
        alert(msg);
        return;
      }
      invalidateBookingRelated(qc);
      onDeleteDone();
    } catch (err) {
      console.error("[deleteBooking] error:", err);
      alert(`Lỗi khi xoá: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleRemoveChild = async (childId: number) => {
    const parentId = booking.parentId ?? parentContract?.id;
    if (!parentId) return;
    if (!confirm("Xoá dịch vụ này khỏi hợp đồng? Hành động không thể hoàn tác.")) return;
    setRemovingChildId(childId);
    try {
      const res = await authFetch(`${BASE}/api/bookings/${parentId}/remove-child/${childId}`, { method: "DELETE" });
      if (!res.ok) {
        let msg = `Xoá thất bại (HTTP ${res.status})`;
        try { const body = await res.json(); if (body?.error) msg = body.error; } catch {}
        alert(msg);
        return;
      }
      invalidateBookingRelated(qc);
      if (childId === booking.id) {
        const otherSib = siblings.find(s => s.id !== childId);
        if (otherSib) onNavigate?.(otherSib);
        else onClose();
      }
    } catch (err) {
      console.error("[removeChild] error:", err);
      alert(`Lỗi khi xoá: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRemovingChildId(null);
    }
  };

  const handlePrintContract = () => {
    const parentDiscount = Number(parentContract?.discountAmount ?? 0) || 0;
    const parentPaid     = Number(parentContract?.paidAmount     ?? 0) || 0;
    const parentTotal    = Number(parentContract?.totalAmount    ?? 0) || 0;
    const bookingPaid    = paymentHistory.reduce((s, p) => s + (p.amount ?? 0), 0);
    const bookingDiscount = Number((fullDetail ?? booking).discountAmount ?? 0) || 0;
    const bookingTotal    = Number((fullDetail ?? booking).totalAmount    ?? 0) || 0;

    const paymentSummary = parentContract
      ? {
          totalAmount:     parentTotal,
          paidAmount:      parentPaid,
          discountAmount:  parentDiscount,
          remainingAmount: Math.max(0, parentTotal - parentDiscount - parentPaid),
        }
      : {
          totalAmount:     bookingTotal,
          paidAmount:      bookingPaid,
          discountAmount:  bookingDiscount,
          remainingAmount: Math.max(0, bookingTotal - bookingDiscount - bookingPaid),
        };
    const html = generateContractHTML(booking, siblings, allPackages, paymentSummary, false, paymentHistory);
    const win = window.open("", "_blank");
    if (!win) { alert("Vui lòng cho phép trình duyệt mở cửa sổ mới để xuất hợp đồng."); return; }
    win.document.write(html);
    win.document.close();
  };

  const handleViewInvoice = async () => {
    // Mở trang hợp đồng/hóa đơn THỐNG NHẤT (không popup about:blank nữa).
    // find-or-create phía server → không tạo trùng khi bấm nhanh nhiều lần.
    try {
      const res = await authFetch(`${BASE}/api/contracts/find-or-create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId: booking.id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Không mở được hóa đơn");
      }
      const { id, created } = await res.json();
      if (created) qc.invalidateQueries({ queryKey: ["contracts"] });
      // Cùng tab + kèm from/bookingId để nút "← Quay lại" mở lại đúng booking này.
      setLocation(`/contracts/${id}?from=calendar&bookingId=${booking.id}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không mở được hóa đơn");
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* ── Header bar ── */}
      <div className="flex items-center gap-2 px-4 py-3 border-b flex-shrink-0 bg-card">
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors flex-shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${st.color}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
            {st.label}
          </span>
        </div>
        {/* Role indicator */}
        <div className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-full ${isAdmin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
          {isAdmin ? <ShieldCheck className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          {isAdmin ? "Admin" : "Nhân viên"}
        </div>
        {booking.status === "confirmed" && (
          <button
            onClick={() => {
              setShowReschedule(true);
              setRescheduleForm({ newDate: booking.shootDate, newTime: booking.shootTime || "", reason: "" });
              setRescheduleError(null);
              setRescheduleConflicts([]);
            }}
            className="p-1.5 rounded-lg text-sky-500 hover:text-sky-700 hover:bg-sky-50 dark:hover:bg-sky-950/30 transition-colors flex-shrink-0"
            title="Đổi lịch chụp"
          >
            <CalendarDays className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={handlePrintContract}
          className="p-1.5 rounded-lg text-blue-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors flex-shrink-0"
          title="Xuất hợp đồng PDF"
        >
          <FileText className="w-4 h-4" />
        </button>
        <button
          onClick={handleViewInvoice}
          className="p-1.5 rounded-lg text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors flex-shrink-0"
          title="Xem hóa đơn và QR ký online"
        >
          <FileText className="w-4 h-4" />
        </button>
        <button
          onClick={async () => {
            setContractImageUrls([]);
            setContractImagesLoading(true);
            setShowContractImages(true);
            try {
              const parentDiscount = Number(parentContract?.discountAmount ?? 0) || 0;
              const parentPaid     = Number(parentContract?.paidAmount     ?? 0) || 0;
              const parentTotal    = Number(parentContract?.totalAmount    ?? 0) || 0;
              const bookingPaid    = paymentHistory.reduce((s, p) => s + (p.amount ?? 0), 0);
              const bookingDiscount = Number((fullDetail ?? booking).discountAmount ?? 0) || 0;
              const bookingTotal    = Number((fullDetail ?? booking).totalAmount    ?? 0) || 0;

              const paymentSummary = parentContract
                ? {
                    totalAmount:     parentTotal,
                    paidAmount:      parentPaid,
                    discountAmount:  parentDiscount,
                    remainingAmount: Math.max(0, parentTotal - parentDiscount - parentPaid),
                  }
                : {
                    totalAmount:     bookingTotal,
                    paidAmount:      bookingPaid,
                    discountAmount:  bookingDiscount,
                    remainingAmount: Math.max(0, bookingTotal - bookingDiscount - bookingPaid),
                  };
              const html = generateContractHTML(booking, siblings, allPackages, paymentSummary, true, paymentHistory);
              const urls = await buildContractImages(html);
              setContractImageUrls(urls);
            } catch (err) {
              alert(`Lỗi tạo ảnh: ${err instanceof Error ? err.message : String(err)}`);
              setShowContractImages(false);
            } finally {
              setContractImagesLoading(false);
            }
          }}
          className="p-1.5 rounded-lg text-emerald-500 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors flex-shrink-0"
          title="Xem hợp đồng dạng ảnh"
        >
          <Camera className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            // Hợp đồng gộp: route qua flow edit-all-siblings (PUT từng dịch vụ)
            // để tránh tạo trùng hợp đồng cha mới khi user thêm/sửa dịch vụ.
            const isPartOfMerged = booking.isParentContract || !!booking.parentId;
            if (isPartOfMerged) {
              let mergedParent: Booking | null = null;
              let allSiblings: Booking[] = [];
              if (booking.isParentContract) {
                mergedParent = booking;
                allSiblings = (fullDetail?.children ?? []) as Booking[];
              } else if (parentContract) {
                mergedParent = parentContract;
                allSiblings = siblings;
              }
              if (mergedParent && allSiblings.length > 0) {
                onEdit(mergedParent, allSiblings);
                return;
              }
            }
            onEdit();
          }}
          className="p-1.5 rounded-lg text-primary hover:bg-primary/10 transition-colors flex-shrink-0"
          title="Chỉnh sửa"
        >
          <Pencil className="w-4 h-4" />
        </button>
        {/* Xoá mềm (vào thùng rác) — mọi nhân viên được dùng; phục hồi vẫn chỉ admin */}
        <button onClick={handleDelete} disabled={deleting} className="p-1.5 rounded-lg text-destructive/50 hover:text-destructive hover:bg-destructive/10 transition-colors flex-shrink-0" title="Xoá show">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4 max-w-2xl mx-auto">
          {/* 1. Khách hàng */}
          <div className="flex items-center gap-3">
            {booking.customerId && customerAvatarMap.get(booking.customerId) && (
              <img src={customerAvatarMap.get(booking.customerId)!} alt={booking.customerName || "avatar"} className="w-12 h-12 rounded-full object-cover border border-border flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-bold text-xl leading-tight truncate">{booking.customerName}</h2>
                {(parentContract?.orderCode || booking.orderCode) && <span className="text-xs font-mono font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded">{parentContract?.orderCode || booking.orderCode}</span>}
                <RankBadge rank={booking.customerRank} />
              </div>
              <a href={`tel:${booking.customerPhone}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary mt-0.5">
                <Phone className="w-3.5 h-3.5" />{booking.customerPhone}
              </a>
              {isPriorityRank(booking.customerRank) && (
                <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full border border-amber-300 dark:border-amber-700">
                  <Crown className="w-3 h-3" /> {booking.customerRank === "super_vip" ? "Siêu VIP" : "VIP"}
                </div>
              )}
            </div>
          </div>

          {/* ── Thao tác nhanh: nhảy qua module liên quan, giữ nguyên context show ── */}
          <div className="rounded-xl border border-border/60 bg-muted/30 p-2.5">
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
              Thao tác nhanh
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setLocation(`/payments?bookingId=${booking.parentId || booking.id}`)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-muted/50 active:scale-[0.98] transition-all text-sm font-semibold text-foreground"
                title="Mở phiếu thu tiền của show này"
              >
                <DollarSign className="w-4 h-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="truncate">Thu tiền</span>
              </button>
              <button
                type="button"
                onClick={() => setLocation(`/photoshop-jobs?bookingId=${booking.parentId || booking.id}&from=calendar`)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-muted/50 active:scale-[0.98] transition-all text-sm font-semibold text-foreground"
                title="Xem tiến độ hậu kỳ của show này"
              >
                <Palette className="w-4 h-4 flex-shrink-0 text-blue-600 dark:text-blue-400" />
                <span className="truncate">Tiến độ hậu kỳ</span>
              </button>
              <button
                type="button"
                onClick={() => booking.customerId && setLocation(`/customers?customerId=${booking.customerId}`)}
                disabled={!booking.customerId}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-muted/50 active:scale-[0.98] transition-all text-sm font-semibold text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                title={booking.customerId ? "Mở hồ sơ khách hàng" : "Show này chưa gắn khách hàng"}
              >
                <Users className="w-4 h-4 flex-shrink-0 text-sky-600 dark:text-sky-400" />
                <span className="truncate">Khách hàng</span>
              </button>
              <button
                type="button"
                onClick={() => setLocation(`/bookings?bookingId=${booking.id}`)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-muted/50 active:scale-[0.98] transition-all text-sm font-semibold text-foreground"
                title="Mở chi tiết đơn hàng"
              >
                <Receipt className="w-4 h-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="truncate">Đơn hàng</span>
              </button>
              <button
                type="button"
                onClick={() => setLocation(`/tasks?bookingId=${booking.parentId || booking.id}`)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-muted/50 active:scale-[0.98] transition-all text-sm font-semibold text-foreground"
                title="Giao việc / xem nhân sự cho show này"
              >
                <Briefcase className="w-4 h-4 flex-shrink-0 text-rose-600 dark:text-rose-400" />
                <span className="truncate">Giao việc</span>
              </button>
              <button
                type="button"
                onClick={() => setLocation(`/expenses?bookingId=${booking.id}&new=1`)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-card border border-border hover:bg-muted/50 active:scale-[0.98] transition-all text-sm font-semibold text-foreground"
                title="Ghi chi phí mua đồ / chi cho show này — sẽ trừ vào lợi nhuận"
              >
                <TrendingDown className="w-4 h-4 flex-shrink-0 text-red-600 dark:text-red-400" />
                <span className="truncate">Chi tiền</span>
              </button>
            </div>
          </div>

          <div className="border-t border-border/40" />

          {/* 2. Ngày giờ địa điểm */}
          <div className="space-y-2.5">
            <div className="flex items-center gap-2.5 text-sm">
              <Calendar className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="font-medium capitalize">{format(shootDateObj, "EEEE, dd/MM/yyyy", { locale: vi })}</span>
              <span className="text-muted-foreground">·</span>
              <Clock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <span className="font-bold text-primary">{booking.shootTime?.slice(0, 5)}</span>
            </div>
            {booking.location && (
              <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <MapPin className="w-4 h-4 flex-shrink-0" />
                <span>{booking.location}</span>
              </div>
            )}
            {/* Lịch thực hiện (dịch vụ nhiều ngày) — ngày 1 = trên; đây là ngày 2..n */}
            {(booking.occurrences?.length ?? 0) > 0 && (
              <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/10 p-2.5 space-y-1">
                <p className="text-[11px] font-bold text-blue-700 dark:text-blue-300">📅 Lịch thực hiện ({(booking.occurrences!.length + 1)} ngày)</p>
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-bold text-blue-600 dark:text-blue-400 flex-shrink-0">Ngày 1</span>
                  <span>{format(shootDateObj, "dd/MM/yyyy", { locale: vi })}{booking.shootTime ? ` · ${booking.shootTime.slice(0, 5)}` : ""}</span>
                </div>
                {booking.occurrences!.map((o, i) => (
                  <div key={o.id} className="flex items-center gap-2 text-xs">
                    <span className="font-bold text-blue-600 dark:text-blue-400 flex-shrink-0">Ngày {i + 2}</span>
                    <span>{(o.shootDate || "").slice(0, 10).split("-").reverse().join("/")}{o.shootTime ? ` · ${o.shootTime.slice(0, 5)}` : ""}{o.label ? ` — ${o.label}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-border/40" />

          {/* 2b. Hợp đồng đa dịch vụ — hiển thị các dịch vụ liên kết */}
          {booking.parentId && (
            <>
              {/* Service label badge */}
              {booking.serviceLabel && (
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1 rounded-full border border-blue-400 text-foreground">
                    📋 {booking.serviceLabel}
                  </span>
                  <span className="text-xs text-muted-foreground">trong hợp đồng nhiều dịch vụ</span>
                </div>
              )}

              {/* Siblings list — đã gộp vào phần Thanh toán bên dưới */}

              {isAdmin && childRemovalLogs.length > 0 && (
                <div className="rounded-xl border border-red-200 dark:border-red-800 overflow-hidden">
                  <div className="px-3 py-2 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-800">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-red-700 dark:text-red-300">
                      🗑️ Lịch sử xoá dịch vụ ({childRemovalLogs.length})
                    </p>
                  </div>
                  <div className="divide-y divide-red-100 dark:divide-red-900">
                    {childRemovalLogs.map(log => {
                      let childLabel = "Dịch vụ";
                      try {
                        const parsed = JSON.parse(log.oldValue || "{}");
                        childLabel = parsed.childServiceLabel || childLabel;
                      } catch {}
                      const logDate = (() => { try { return format(new Date(log.createdAt), "HH:mm dd/MM/yyyy"); } catch { return "—"; } })();
                      return (
                        <div key={log.id} className="px-3 py-2 text-xs space-y-0.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-red-700 dark:text-red-300 truncate">{childLabel}</span>
                            <span className="text-muted-foreground flex-shrink-0">{logDate}</span>
                          </div>
                          {log.changedByName && (
                            <p className="text-muted-foreground">Bởi: {log.changedByName}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Contract summary — moved outside parentId block below */}
            </>
          )}

          {/* Lịch sử chỉnh sửa đơn — luôn hiển thị (không chỉ child booking) */}
          {editChanges.length > 0 && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-800 overflow-hidden">
              <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 flex items-center justify-between">
                <p className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                  📝 Lịch sử chỉnh sửa ({editChanges.length})
                </p>
                <p className="text-[10px] text-muted-foreground">Mới nhất ở trên</p>
              </div>
              <div className="divide-y divide-amber-100 dark:divide-amber-900 max-h-72 overflow-y-auto">
                {editChanges.slice(0, 50).map(log => {
                  const fieldLabel = FIELD_LABEL[log.fieldChanged] || log.fieldChanged;
                  const logDate = (() => { try { return format(new Date(log.createdAt), "HH:mm dd/MM/yyyy"); } catch { return "—"; } })();
                  const truncate = (s: string | null, max = 60) => {
                    if (!s) return "—";
                    return s.length > max ? s.slice(0, max) + "…" : s;
                  };
                  return (
                    <div key={log.id} className="px-3 py-2 text-xs space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-amber-700 dark:text-amber-300">{fieldLabel}</span>
                        <span className="text-muted-foreground text-[10px] flex-shrink-0">{logDate}</span>
                      </div>
                      <div className="flex items-baseline gap-1.5 flex-wrap text-foreground/80">
                        <span className="line-through text-muted-foreground">{truncate(log.oldValue)}</span>
                        <span className="text-amber-600">→</span>
                        <span className="font-medium">{truncate(log.newValue)}</span>
                      </div>
                      {log.changedByName && (
                        <p className="text-[10px] text-muted-foreground">Bởi: <span className="font-medium text-foreground/70">{log.changedByName}</span></p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Contract summary — per-service breakdown + totals (works for both single & multi-service) */}
          {(() => {
                const contractSrc = parentContract ?? booking;
                const allSvc = siblings.length > 0 ? siblings : [booking];
                const cTotal = Number(contractSrc.totalAmount ?? 0) || 0;
                const cDiscount = Number(contractSrc.discountAmount ?? 0) || 0;
                const cPaid = parentContract
                  ? Number(parentContract.paidAmount ?? 0) || 0
                  : paymentHistory.reduce((s, p) => s + (p.amount ?? 0), 0);
                const cAfterDiscount = Math.max(0, cTotal - cDiscount);
                const cRemaining = Math.max(0, cAfterDiscount - cPaid);
                return (
                  <div className="rounded-xl border border-border/50 overflow-hidden bg-white dark:bg-card">
                    <div className="px-3 py-2 border-b border-border/40 bg-gray-50 dark:bg-muted/20 flex items-center justify-between">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-foreground/70">
                        {isAdmin ? (allSvc.length > 1 ? `💰 Thanh toán (${allSvc.length} dịch vụ)` : "💰 Thanh toán") : (allSvc.length > 1 ? `📋 Dịch vụ (${allSvc.length})` : "📋 Dịch vụ")}
                        {(parentContract?.orderCode || booking.orderCode) && <span className="ml-2 font-mono text-primary">{parentContract?.orderCode || booking.orderCode}</span>}
                      </p>
                      {isAdmin && onEditAllSiblings && parentContract && (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); onEditAllSiblings(parentContract, siblings); }}
                          title="Mở form chỉnh sửa tất cả dịch vụ"
                          className="p-1 rounded-md transition-colors hover:bg-blue-100 dark:hover:bg-blue-900 text-blue-500 dark:text-blue-400"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="divide-y divide-border/30">
                      {allSvc.map((svc, svcIdx) => {
                        const svcItems = svc.items || [];
                        const svcRealName = svcItems[0]?.serviceName || svc.serviceLabel || svc.packageType || "";
                        const svcTitle = `DỊCH VỤ ${svcIdx + 1}${svcRealName ? `: ${svcRealName}` : ""}`;
                        const svcShootDate = svc.shootDate ? safeFormatDate(svc.shootDate) : "";
                        const svcShootTime = svc.shootTime ? svc.shootTime.slice(0, 5) : "";
                        const svcBookingSurcharges = (svc.surcharges || []) as { name?: string; label?: string; amount: number }[];
                        const svcItemSurcharges = svcItems.flatMap(it => (it.surcharges || []) as { name?: string; label?: string; amount: number }[]);
                        const allSurcharges = [...svcBookingSurcharges, ...svcItemSurcharges];
                        const svcBasePrice = svcItems.reduce((s, it) => s + (it.price || it.unitPrice || 0), 0) || svc.totalAmount || 0;
                        const svcSurTotal = allSurcharges.reduce((s, sc) => s + (sc.amount || 0), 0);
                        const allDeductions = svcItems.flatMap(it => (it.deductions || []) as { label: string; amount: number }[]);
                        const svcPkgDetail = svcItems[0] ? getPackageDetail(svcItems[0]) : {};
                        const svcExtras=(svc.additionalServices||[]) as AdditionalServiceLine[];
                        const extrasReadOnly=svcExtras.length>0;
                        const svcAddonNames = svcItems[0] ? resolveAddons(svcItems[0]) : [];
                        const svcFirstItem = svcItems[0];
                        const svcLineTotal = Number(svc.totalAmount ?? 0) || svcBasePrice;
                        const isCurrent = svc.id === booking.id;
                        const canNavigate = !isCurrent && onNavigate;
                        // Chỉ dịch vụ đang xem mới có nội dung để thu gọn; mặc định xổ ra.
                        const svcCollapsed = isCurrent && collapsedSvcIds.has(svc.id);
                        const svcSt = STATUS[svc.status as keyof typeof STATUS] ?? STATUS.pending;
                        return (
                          <div key={svc.id} className="rounded-lg border border-blue-200 dark:border-blue-800 overflow-hidden mb-2 last:mb-0">
                            <div
                              className={`px-3 py-2 bg-blue-50/50 dark:bg-blue-950/20 border-b border-blue-200 dark:border-blue-800 flex items-center gap-2 ${canNavigate ? "cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors" : ""}`}
                              role={canNavigate ? "button" : undefined}
                              tabIndex={canNavigate ? 0 : undefined}
                              onClick={canNavigate ? () => onNavigate?.(svc) : undefined}
                              onKeyDown={canNavigate ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNavigate?.(svc); } } : undefined}
                            >
                              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${svcSt.dot}`} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[11px] font-bold text-foreground uppercase tracking-wide">{svcTitle}</span>
                                  {svc.orderCode && <span className="text-[9px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground font-bold">{svc.orderCode}</span>}
                                  {isCurrent && <span className="text-[9px] border border-blue-400 px-1.5 py-0.5 rounded font-bold text-foreground">Đang xem</span>}
                                </div>
                                {(svcShootDate || svcShootTime) && (
                                  <div className="flex items-baseline gap-1.5 mt-0.5">
                                    {svcShootTime && (
                                      <span className="text-base font-black text-primary tabular-nums leading-none">{svcShootTime}</span>
                                    )}
                                    {svcShootDate && (
                                      <span className="text-[11px] font-semibold text-foreground tabular-nums">📅 {svcShootDate}</span>
                                    )}
                                  </div>
                                )}
                              </div>
                              {svcLineTotal > 0 && (
                                <div className="text-right flex-shrink-0 px-1 self-center">
                                  <p className="text-xs font-bold text-primary tabular-nums leading-tight">{fmtVND(svcLineTotal)}</p>
                                  <p className="text-[9px] text-muted-foreground">Thành tiền</p>
                                </div>
                              )}
                              {isAdmin && siblings.length > 1 && (
                                <button
                                  type="button"
                                  onClick={e => { e.stopPropagation(); handleRemoveChild(svc.id); }}
                                  disabled={removingChildId === svc.id}
                                  className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors flex-shrink-0 disabled:opacity-50"
                                  title="Xoá dịch vụ này khỏi hợp đồng"
                                >
                                  {removingChildId === svc.id ? <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" /> : <Trash2 className="w-3.5 h-3.5" />}
                                </button>
                              )}
                              {isCurrent && (
                                <button
                                  type="button"
                                  onClick={e => {
                                    e.stopPropagation();
                                    setCollapsedSvcIds(prev => {
                                      const next = new Set(prev);
                                      if (next.has(svc.id)) next.delete(svc.id); else next.add(svc.id);
                                      return next;
                                    });
                                  }}
                                  className="p-1 rounded-md text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors flex-shrink-0"
                                  aria-expanded={!svcCollapsed}
                                  title={svcCollapsed ? "Mở rộng dịch vụ" : "Thu gọn dịch vụ"}
                                >
                                  <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${svcCollapsed ? "" : "rotate-180"}`} />
                                </button>
                              )}
                              {canNavigate && <ChevronRight className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />}
                            </div>
                            {isCurrent && !svcCollapsed && (() => {
                              const { photoName: rPhoto, makeupName: rMakeup } = svcFirstItem ? resolveItemStaff(svcFirstItem) : { photoName: "", makeupName: "" };
                              const roleLabelMap: Record<string, string> = {
                                assistant: "Trợ lý", tro_ly: "Trợ lý",
                                support: "Hỗ trợ", ho_tro: "Hỗ trợ",
                                video: "Quay phim", videographer: "Quay phim",
                                assistant_photo: "Thợ phụ",
                                marketing: "Marketing", sales: "Sale",
                                photoshop: "Photoshop", pts: "Photoshop",
                                print: "In ảnh", deliver: "Giao file",
                              };
                              const roleIconMap: Record<string, { icon: typeof Camera; cls: string }> = {
                                photographer: { icon: Camera, cls: "text-sky-500" },
                                makeup: { icon: Sparkles, cls: "text-pink-500" },
                              };
                              const staffList: { cr: string; name: string }[] = [];
                              const seenNames = new Set<string>();
                              const addStaff = (role: string, name: string) => {
                                if (!name) return;
                                const cr = canonicalRole(role);
                                const normName = name.trim().toUpperCase();
                                if (seenNames.has(normName)) return;
                                seenNames.add(normName);
                                staffList.push({ cr, name });
                              };
                              const parentStaff = parentContract && Array.isArray(parentContract.assignedStaff)
                                ? (parentContract.assignedStaff as StaffAssignment[]) : [];
                              const bookingStaffArr = Array.isArray((fullDetail ?? booking).assignedStaff)
                                ? ((fullDetail ?? booking).assignedStaff as StaffAssignment[]) : [];
                              const hasParentOrBookingStaff = parentStaff.length > 0 || bookingStaffArr.length > 0;
                              if (hasParentOrBookingStaff) {
                                for (const sa of parentStaff) { if (sa.staffName) addStaff(sa.role ?? "", sa.staffName); }
                                for (const sa of bookingStaffArr) { if (sa.staffName) addStaff(sa.role ?? "", sa.staffName); }
                              }
                              if (rPhoto) addStaff("photographer", rPhoto);
                              if (rMakeup) addStaff("makeup", rMakeup);
                              if (svcFirstItem && Array.isArray(svcFirstItem.assignedStaff)) {
                                for (const sa of svcFirstItem.assignedStaff as StaffAssignment[]) {
                                  if (sa.staffName) addStaff(sa.role ?? "", sa.staffName);
                                }
                              }
                              const ta: TaskAssignee[] = Array.isArray((fullDetail ?? booking).taskAssignees)
                                ? ((fullDetail ?? booking).taskAssignees as TaskAssignee[])
                                : [];
                              for (const t of ta) {
                                if (t.assigneeName) addStaff(t.role ?? t.taskType ?? "", t.assigneeName);
                              }
                              if (staffList.length === 0) return null;
                              const order = ["photographer", "makeup", "sales", "videographer", "assistant", "support", "photoshop"];
                              const entries = [...staffList].sort((a, b) => {
                                const ia = order.indexOf(a.cr); const ib = order.indexOf(b.cr);
                                return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
                              });
                              return (
                                <div className="px-3 py-1.5 border-b border-border/30 space-y-0.5">
                                  {entries.map((e, i) => {
                                    const ri = roleIconMap[e.cr];
                                    const IconComp = ri?.icon ?? User;
                                    const iconCls = ri?.cls ?? "text-blue-500";
                                    const label = e.cr === "photographer" ? "Nhiếp ảnh" : e.cr === "makeup" ? "Makeup" : (roleLabelMap[e.cr] ?? e.cr ?? "Khác");
                                    return (
                                      <div key={i} className="flex items-center gap-2 text-xs">
                                        <IconComp className={`w-3.5 h-3.5 ${iconCls} flex-shrink-0`} />
                                        <span className="text-muted-foreground">{label}:</span>
                                        <span className="font-medium">{e.name}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                            {isCurrent && !svcCollapsed && svcPkgDetail.description && (
                              <div className="px-3 py-1.5 border-b border-border/30 bg-gray-50/50 dark:bg-muted/10">
                                <p className="text-[10px] font-bold text-foreground mb-1">Nội dung gói:</p>
                                {/* Trình bày dễ đọc — giữ nguyên từng chữ: tiêu đề đậm, bullet thẳng hàng, câu gãy nối liền */}
                                {parseDescriptionBlocks(svcPkgDetail.description).map((b, i) =>
                                  b.type === "divider" ? (
                                    <div key={i} className="border-t border-border/50 my-1.5" aria-hidden />
                                  ) : b.type === "heading" ? (
                                    <p key={i} className="text-[11px] font-bold text-foreground pt-1 first:pt-0">{b.text}</p>
                                  ) : b.type === "bullet" ? (
                                    <p key={i} className="text-[11px] text-foreground leading-relaxed pl-3 -indent-3">{b.text}</p>
                                  ) : (
                                    <p key={i} className="text-[11px] text-foreground leading-relaxed pt-0.5 first:pt-0">{b.text}</p>
                                  ),
                                )}
                              </div>
                            )}
                            {isCurrent && !svcCollapsed && svcAddonNames.length > 0 && (
                              <div className="px-3 py-1.5 border-b border-border/30 bg-orange-50/30 dark:bg-orange-950/10">
                                <span className="text-[10px] font-bold text-orange-700 dark:text-orange-300">➕ Addon:</span>
                                {svcAddonNames.map((n, i) => (
                                  <span key={i} className="text-[11px] text-orange-700 dark:text-orange-400 ml-1">{n}{i < svcAddonNames.length - 1 ? "," : ""}</span>
                                ))}
                              </div>
                            )}
                            {isCurrent && !svcCollapsed && extrasReadOnly && (
                              <div className="px-3 py-1.5 border-b border-border/30 bg-muted/20">
                                <span className="text-[10px] font-bold">Dịch vụ cộng thêm theo số lượng</span>
                                {svcExtras.map((l, ix) => (
                                  <div key={ix} className="flex justify-between text-[11px] py-0.5 gap-2">
                                    <span className="truncate">{l.title} · {l.qty} × {fmtVND(l.unitPrice || 0)}</span>
                                    <span className="flex-shrink-0 font-medium">{fmtVND(l.totalPrice || 0)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {isCurrent && !svcCollapsed && isAdmin && (
                              <ServicePriceBreakdown
                                basePrice={svcBasePrice}
                                surcharges={allSurcharges}
                                deductions={allDeductions}
                                finalAmount={svc.totalAmount ?? svcBasePrice}
                                formatVND={fmtVND}
                              />
                            )}
                            {isCurrent && !svcCollapsed && svcFirstItem?.notes && (
                              <div className="px-3 py-1.5 border-t border-border/30">
                                <p className="text-[10px] font-bold text-muted-foreground mb-1">📝 Ghi chú dịch vụ</p>
                                <p className="text-xs text-foreground/80 leading-relaxed whitespace-pre-line">{svcFirstItem.notes}</p>
                              </div>
                            )}
                            {isCurrent && !svcCollapsed && svcFirstItem?.conceptImages && svcFirstItem.conceptImages.length > 0 && (
                              <div className="px-3 py-1.5 border-t border-border/30">
                                <p className="text-[10px] font-bold text-muted-foreground mb-2">🖼️ Ảnh concept ({svcFirstItem.conceptImages.length})</p>
                                <div className="grid grid-cols-3 gap-1.5">
                                  {svcFirstItem.conceptImages.map((imgUrl: string, ci: number) => {
                                    const src = getImageSrc(imgUrl);
                                    return src ? (
                                      <button
                                        key={ci}
                                        onClick={() => setPreviewImg(src)}
                                        className="aspect-square rounded-lg overflow-hidden bg-muted hover:ring-2 hover:ring-primary transition-all"
                                      >
                                        <img src={src} alt={`concept ${ci + 1}`} className="w-full h-full object-cover" />
                                      </button>
                                    ) : null;
                                  })}
                                </div>
                              </div>
                            )}
                            {isCurrent && !svcCollapsed && (() => {
                              const svcDresses = bookingDresses.filter(d => d.booking_id === svc.id);
                              if (svcDresses.length === 0) return null;
                              const fmtDR = (d: string | null) => { try { return format(parseISO(d || ""), "dd/MM", { locale: vi }); } catch { return d || ""; } };
                              const stLabel: Record<string, string> = { reserved: "Đặt trước", picked_up: "Đã lấy", returned: "Đã trả", cancelled: "Huỷ" };
                              const stCls: Record<string, string> = { reserved: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300", picked_up: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300", returned: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300", cancelled: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" };
                              return (
                                <div className="px-3 py-2 border-t border-border/30 bg-violet-50/40 dark:bg-violet-950/10">
                                  <p className="text-[10px] font-bold text-violet-700 dark:text-violet-300 mb-2 flex items-center gap-1">
                                    <Shirt className="w-3 h-3" /> Trang phục / Đạo cụ đi kèm ({svcDresses.length})
                                  </p>
                                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                    {svcDresses.map((od) => {
                                      const thumb = getImageSrc(od.outfit_image);
                                      const status = od.status || "reserved";
                                      return (
                                        <div key={od.id} className="rounded-lg border border-violet-200 dark:border-violet-800 bg-white dark:bg-card p-1.5 space-y-1">
                                          <div className="aspect-square rounded-md bg-muted overflow-hidden flex items-center justify-center">
                                            {thumb ? (
                                              <img src={thumb} alt={od.outfit_name || ""} className="w-full h-full object-cover" loading="lazy" />
                                            ) : (
                                              <Shirt className="w-6 h-6 text-muted-foreground" />
                                            )}
                                          </div>
                                          <div className="min-w-0">
                                            <p className="text-[10px] font-mono font-bold text-primary truncate">{od.outfit_code || "—"}{od.size ? ` · ${od.size}` : ""}</p>
                                            <p className="text-[10px] text-foreground truncate">{od.outfit_name || ""}</p>
                                            <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground mt-0.5">
                                              {od.pickup_date && <span>Lấy {fmtDR(od.pickup_date)}</span>}
                                              {od.return_date && <span>Trả {fmtDR(od.return_date)}</span>}
                                            </div>
                                            <span className={`inline-block mt-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded ${stCls[status] || stCls.reserved}`}>
                                              {stLabel[status] || status}
                                            </span>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        );
                      })}
                      {isAdmin && (
                        <div className="px-3 py-2.5 space-y-1.5 bg-gray-50/60 dark:bg-muted/10">
                          <div className="flex justify-between text-sm">
                            <span className="font-semibold text-foreground">Tổng tiền các dịch vụ</span>
                            <span className="font-bold text-base">{fmtVND(cTotal)}</span>
                          </div>
                          {cDiscount > 0 && (
                            <div className="flex justify-between text-sm">
                              <span className="text-muted-foreground">Giảm giá chung hợp đồng</span>
                              <span className="font-semibold text-amber-600">-{fmtVND(cDiscount)}</span>
                            </div>
                          )}
                          {cDiscount > 0 && (
                            <>
                              <div className="border-t border-dashed border-border/40" />
                              <div className="flex justify-between text-sm">
                                <span className="font-semibold text-foreground">Tổng sau giảm</span>
                                <span className="font-bold">{fmtVND(cAfterDiscount)}</span>
                              </div>
                            </>
                          )}
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Đã cọc / Đã thu</span>
                            <span className="font-semibold text-emerald-600">{fmtVND(cPaid)}</span>
                          </div>
                          <div className="flex justify-between text-sm border-t border-border/40 pt-1.5">
                            <span className="font-semibold text-foreground">Còn lại</span>
                            <span className={`font-bold text-base ${cRemaining > 0 ? "text-destructive" : "text-emerald-600"}`}>
                              {fmtVND(cRemaining)}
                            </span>
                          </div>
                        </div>
                      )}
                      {isAdmin && paymentHistory.length > 0 && (
                        <div className="px-3 py-2.5 space-y-2">
                          <p className="text-[10px] font-bold uppercase tracking-wider text-foreground/60">📜 Lịch sử thanh toán ({paymentHistory.length} lần)</p>
                          <div className="overflow-x-auto -mx-1">
                            <table className="w-full text-xs min-w-[400px]">
                              <thead>
                                <tr className="border-b border-border/40">
                                  <th className="text-left py-1.5 pr-2 font-semibold text-muted-foreground">Ngày</th>
                                  <th className="text-left py-1.5 pr-2 font-semibold text-muted-foreground">Hình thức</th>
                                  <th className="text-left py-1.5 pr-2 font-semibold text-muted-foreground">Người thu</th>
                                  <th className="text-right py-1.5 pr-2 font-semibold text-muted-foreground">Số tiền</th>
                                  <th className="text-right py-1.5 font-semibold text-muted-foreground">Còn lại</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(() => {
                                  let rPaid = 0;
                                  return paymentHistory.map((p, i) => {
                                    rPaid += (p.amount ?? 0);
                                    const rowRem = Math.max(0, cAfterDiscount - rPaid);
                                    const dateStr = p.paidDate ? safeFormatDate(p.paidDate) : safeFormatDate(p.paidAt);
                                    const method = p.paymentMethod === "bank_transfer" ? "Chuyển khoản" : "Tiền mặt";
                                    const proofUrls = (p.proofImageUrls && p.proofImageUrls.length)
                                      ? p.proofImageUrls
                                      : (p.proofImageUrl ? [p.proofImageUrl] : []);
                                    return (
                                      <Fragment key={p.id ?? i}>
                                        <tr className={proofUrls.length > 0 ? "" : "border-b border-border/20"}>
                                          <td className="py-1.5 pr-2 text-muted-foreground">{dateStr}</td>
                                          <td className="py-1.5 pr-2 text-muted-foreground">{method}</td>
                                          <td className="py-1.5 pr-2 text-muted-foreground">{p.collectorName || "—"}</td>
                                          <td className="py-1.5 pr-2 text-right font-semibold text-emerald-700">+{fmtVND(p.amount ?? 0)}</td>
                                          <td className="py-1.5 text-right font-medium">{fmtVND(rowRem)}</td>
                                        </tr>
                                        {proofUrls.length > 0 && (
                                          <tr className="border-b border-border/20">
                                            <td colSpan={5} className="pb-2 pt-0.5">
                                              <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className="text-[10px] text-muted-foreground">🧾 Bằng chứng:</span>
                                                {proofUrls.map((u, idx) => {
                                                  const src = getImageSrc(u) || u;
                                                  return (
                                                    <a key={`${u}-${idx}`} href={src} target="_blank" rel="noopener noreferrer" className="block">
                                                      <img
                                                        src={src}
                                                        alt={`Bằng chứng ${idx + 1}`}
                                                        loading="lazy"
                                                        className="w-12 h-12 rounded-md object-cover border border-border hover:opacity-80 transition"
                                                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                                      />
                                                    </a>
                                                  );
                                                })}
                                              </div>
                                            </td>
                                          </tr>
                                        )}
                                      </Fragment>
                                    );
                                  });
                                })()}
                              </tbody>
                              <tfoot>
                                <tr className="border-t border-border/40">
                                  <td colSpan={3} className="py-1.5 font-bold text-foreground">Tổng đã thu</td>
                                  <td colSpan={2} className="py-1.5 text-right font-bold text-emerald-700">{fmtVND(cPaid)}</td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      )}

                      {/* Lịch sử chi tiền của đơn này — kế lịch sử thanh toán */}
                      {isAdmin && (() => {
                        type BookingExpenseRow = {
                          id: number;
                          description: string;
                          category: string;
                          costClass?: string | null;
                          amount: number;
                          expenseDate?: string;
                          expenseAt?: string;
                          createdBy?: string | null;
                        };
                        const expenseRows: BookingExpenseRow[] = Array.isArray(
                          (fullDetail as { expenses?: BookingExpenseRow[] } | undefined)?.expenses,
                        )
                          ? (fullDetail as { expenses: BookingExpenseRow[] }).expenses
                          : [];
                        const costClassShort = (v?: string | null) => {
                          if (v === "direct") return "Trực tiếp";
                          if (v === "operating") return "Vận hành";
                          return v || "—";
                        };
                        const expenseDateStr = (ex: BookingExpenseRow) => {
                          if (ex.expenseAt) return safeFormatDate(ex.expenseAt);
                          if (ex.expenseDate) return safeFormatDate(ex.expenseDate);
                          return "—";
                        };
                        const totalExpenseAmt = expenseRows.reduce((s, x) => s + (x.amount || 0), 0);
                        return (
                          <div className="px-3 py-2.5 space-y-2 border-t border-border/30">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-foreground/60">
                              💸 Lịch sử chi tiền của đơn này
                              {expenseRows.length > 0 ? ` (${expenseRows.length})` : ""}
                            </p>
                            {expenseRows.length === 0 ? (
                              <p className="text-xs text-muted-foreground italic py-2">
                                Chưa có khoản chi nào cho đơn này.
                              </p>
                            ) : (
                              <div className="overflow-x-auto -mx-1">
                                <table className="w-full text-xs min-w-[420px]">
                                  <thead>
                                    <tr className="border-b border-border/40">
                                      <th className="text-left py-1.5 pr-2 font-semibold text-muted-foreground">Ngày</th>
                                      <th className="text-left py-1.5 pr-2 font-semibold text-muted-foreground">Nội dung</th>
                                      <th className="text-left py-1.5 pr-2 font-semibold text-muted-foreground">Nhóm chi</th>
                                      <th className="text-left py-1.5 pr-2 font-semibold text-muted-foreground">Người chi</th>
                                      <th className="text-right py-1.5 font-semibold text-muted-foreground">Số tiền</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {expenseRows.map((ex) => (
                                      <tr key={ex.id} className="border-b border-border/20">
                                        <td className="py-1.5 pr-2 text-muted-foreground whitespace-nowrap">{expenseDateStr(ex)}</td>
                                        <td className="py-1.5 pr-2 font-medium text-foreground">{ex.description}</td>
                                        <td className="py-1.5 pr-2 text-muted-foreground">
                                          {ex.category}
                                          {ex.costClass ? ` / ${costClassShort(ex.costClass)}` : ""}
                                        </td>
                                        <td className="py-1.5 pr-2 text-muted-foreground">{ex.createdBy || "—"}</td>
                                        <td className="py-1.5 text-right font-semibold text-red-600">-{fmtVND(ex.amount || 0)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                  <tfoot>
                                    <tr className="border-t border-border/40">
                                      <td colSpan={4} className="py-1.5 font-bold text-foreground">Tổng chi đơn này</td>
                                      <td className="py-1.5 text-right font-bold text-red-600">-{fmtVND(totalExpenseAmt)}</td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                    </div>
                  </div>
                );
              })()}

          {/* Dịch vụ đặt chụp — đã gộp vào phần Thanh toán ở trên */}
          {!isAdmin && booking.items && booking.items.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground italic py-2">
              <Package2 className="w-4 h-4" /> Chưa chốt dịch vụ
            </div>
          )}

          {/* 4. Sale / Photoshop — admin only (booking-level) */}
          {isAdmin && (saleStaffName || photoshopStaffName) && (
            <>
              <div className="border-t border-border/40" />
              <div className="space-y-1.5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5" /> Phân công thêm
                </p>
                {saleStaffName && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-base flex-shrink-0">💼</span>
                    <span className="font-medium">{saleStaffName}</span>
                    <span className="text-xs text-muted-foreground">(Sale)</span>
                  </div>
                )}
                {photoshopStaffName && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-base flex-shrink-0">🖥️</span>
                    <span className="font-medium">{photoshopStaffName}</span>
                    <span className="text-xs text-muted-foreground">(Photoshop)</span>
                  </div>
                )}
              </div>
            </>
          )}

          {/* 4b. Giao việc — task assignees từ module Giao việc */}
          {(() => {
            const ta: TaskAssignee[] = Array.isArray((fullDetail ?? booking).taskAssignees)
              ? ((fullDetail ?? booking).taskAssignees as TaskAssignee[])
              : [];
            if (ta.length === 0) return null;
            const taskTypeLabel: Record<string, string> = {
              photographer: "Nhiếp ảnh", photo: "Nhiếp ảnh", chup: "Chụp ảnh",
              makeup: "Makeup",
              photoshop: "Photoshop", pts: "Photoshop",
              assistant: "Trợ lý", tro_ly: "Trợ lý",
              support: "Hỗ trợ", ho_tro: "Hỗ trợ",
              video: "Quay phim", videographer: "Quay phim",
              print: "In ảnh", in_anh: "In ảnh",
              deliver: "Giao file", giao_file: "Giao file",
              call: "Gọi khách",
            };
            const statusLabel: Record<string, { label: string; cls: string }> = {
              todo: { label: "Chưa làm", cls: "text-muted-foreground" },
              in_progress: { label: "Đang làm", cls: "text-blue-500 font-semibold" },
              done: { label: "Xong", cls: "text-green-600 font-semibold" },
              completed: { label: "Xong", cls: "text-green-600 font-semibold" },
            };
            return (
              <>
                <div className="border-t border-border/40" />
                <div className="space-y-1.5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5" /> Giao việc
                  </p>
                  {ta.map((t, i) => {
                    const roleKey = (t.role ?? t.taskType ?? "").toLowerCase();
                    const label = taskTypeLabel[roleKey] ?? t.role ?? t.taskType ?? "Việc";
                    const st = statusLabel[t.status] ?? { label: t.status, cls: "text-muted-foreground" };
                    return (
                      <div key={i} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <User className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
                          <span className="text-muted-foreground">{label}:</span>
                          <span className="font-medium">{t.assigneeName}</span>
                        </div>
                        <span className={`text-[10px] ${st.cls}`}>{st.label}</span>
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}

          {/* 5. Phụ thu / phát sinh */}
          {surcharges.length > 0 && (
            <>
              <div className="border-t border-border/40" />
              <div className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">➕ Phụ thu / phát sinh</p>
                <div className="rounded-xl border border-amber-200/60 overflow-hidden">
                  {surcharges.map((s, i) => (
                    <div key={i} className={`flex justify-between items-center px-3 py-2 text-sm ${i > 0 ? "border-t border-amber-100" : ""} bg-amber-50/40`}>
                      <span className="text-amber-800 dark:text-amber-300">{s.name}</span>
                      {isAdmin && <span className="font-semibold text-amber-900 dark:text-amber-200">{fmtVND(s.amount)}</span>}
                    </div>
                  ))}
                  {isAdmin && surchargesTotal > 0 && (
                    <div className="flex justify-between items-center px-3 py-2 text-sm font-bold bg-amber-100/60 border-t border-amber-200">
                      <span className="text-amber-900">Tổng phụ thu</span>
                      <span className="text-amber-900">{fmtVND(surchargesTotal)}</span>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* 6. Thanh toán — moved into contract summary section above */}

          {/* 7. Photo count + Ghi chú */}
          {(booking.photoCount || booking.notes) && (
            <div className="border-t border-border/40" />
          )}
          {booking.photoCount != null && booking.photoCount > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">📸 Số tấm ảnh chỉnh:</span>
              <span className="font-semibold text-sky-600">{booking.photoCount.toLocaleString("vi-VN")} tấm</span>
            </div>
          )}
          {booking.notes && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">📝 Ghi chú nội bộ</p>
              <p className="text-sm text-muted-foreground bg-muted/30 rounded-xl px-3 py-2 leading-relaxed">{booking.notes}</p>
            </div>
          )}

          {/* 8. Quick links — admin */}
          {isAdmin && (
            <>
              <div className="border-t border-border/40" />
              <div className="flex gap-2 flex-wrap">
                <a href="/bookings" className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                  📋 Xem đơn hàng
                </a>
                <a href="/payments" className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-sm hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                  💳 Thu tiền
                </a>
              </div>
            </>
          )}

          {/* Order code footer */}
          <p className="text-center text-xs text-muted-foreground/60 pb-2">#{booking.orderCode}</p>
        </div>
      </div>

      {/* Modal xem hợp đồng dạng ảnh */}
      {showContractImages && (
        <div className="fixed inset-0 z-[300] bg-black/95 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-shrink-0">
            <div>
              <p className="text-white font-semibold text-sm">Hợp đồng dạng ảnh</p>
              <p className="text-white/50 text-xs mt-0.5">Bấm giữ ảnh để lưu vào điện thoại</p>
            </div>
            <button
              onClick={() => { setShowContractImages(false); setContractImageUrls([]); }}
              className="text-white/70 hover:text-white p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* Body */}
          <div className="flex-1 overflow-y-auto">
            {contractImagesLoading ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                <p className="text-white/60 text-sm">Đang tạo ảnh hợp đồng...</p>
              </div>
            ) : contractImageUrls.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-white/50 text-sm">Không có dữ liệu</p>
              </div>
            ) : (
              <div className="p-4 space-y-6 max-w-2xl mx-auto">
                {contractImageUrls.map((url, idx) => (
                  <div key={idx}>
                    <p className="text-white/50 text-xs mb-2 text-center">Trang {idx + 1} / {contractImageUrls.length}</p>
                    <img
                      src={url}
                      alt={`Trang ${idx + 1}`}
                      className="w-full rounded-lg shadow-xl"
                      style={{ touchAction: "manipulation" }}
                    />
                  </div>
                ))}
                <p className="text-center text-white/40 text-xs pb-4">Bấm giữ ảnh để lưu vào thư viện điện thoại</p>
              </div>
            )}
          </div>
        </div>
      )}

      {previewImg && (
        <div
          className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setPreviewImg(null)}
        >
          <img
            src={previewImg}
            alt="Xem ảnh concept"
            className="max-w-full max-h-full object-contain rounded-xl"
            onClick={e => e.stopPropagation()}
          />
          <button
            onClick={() => setPreviewImg(null)}
            className="absolute top-4 right-4 text-white/70 hover:text-white p-2 rounded-full bg-black/40 hover:bg-black/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* Đổi lịch Modal */}
      {showReschedule && (
        <div
          className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4"
          onClick={() => setShowReschedule(false)}
        >
          <div
            className="bg-background rounded-2xl shadow-2xl p-5 w-full max-w-sm space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-1">
              <CalendarDays className="w-5 h-5 text-primary" />
              <h3 className="font-bold text-base">Đổi lịch chụp</h3>
            </div>
            <div>
              <label className="text-sm font-medium">Ngày mới *</label>
              <DateInput
                className="w-full mt-1 h-9"
                value={rescheduleForm.newDate}
                onChange={v => setRescheduleForm(f => ({ ...f, newDate: v }))}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Giờ mới</label>
              <input
                type="time"
                className="w-full mt-1 h-9 px-3 border border-input rounded-lg bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary/20"
                value={rescheduleForm.newTime}
                onChange={e => setRescheduleForm(f => ({ ...f, newTime: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-sm font-medium">Lý do đổi lịch *</label>
              <textarea
                rows={2}
                placeholder="Nhập lý do đổi lịch (bắt buộc)..."
                className="w-full mt-1 px-3 py-2 border border-input rounded-lg bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary/20 resize-none"
                value={rescheduleForm.reason}
                onChange={e => setRescheduleForm(f => ({ ...f, reason: e.target.value }))}
              />
            </div>
            {rescheduleError && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm px-3 py-2">{rescheduleError}</div>
            )}
            {rescheduleConflicts.length > 0 && (
              <div className="rounded-lg bg-orange-50 border border-orange-200 text-sm px-3 py-2 space-y-1">
                <p className="font-semibold text-orange-800">⚠️ Xung đột lịch:</p>
                {rescheduleConflicts.map((c, i) => (
                  <p key={i} className="text-orange-700 text-xs">
                    • {c.customerName} — {c.date}{c.time ? " " + c.time.slice(0, 5) : ""}
                    {c.staffNames ? ` (${c.staffNames})` : ""}
                  </p>
                ))}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button
                className="flex-1"
                disabled={!rescheduleForm.newDate || !rescheduleForm.reason.trim() || rescheduling}
                onClick={async () => {
                  if (!rescheduleForm.reason.trim()) { setRescheduleError("Vui lòng nhập lý do đổi lịch"); return; }
                  setRescheduleError(null);
                  setRescheduleConflicts([]);
                  setRescheduling(true);
                  try {
                    const res = await authFetch(`${BASE}/api/bookings/${booking.id}/reschedule`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(rescheduleForm),
                    });
                    const data = await res.json();
                    if (!res.ok) {
                      if (res.status === 409 && data.conflicts) {
                        setRescheduleConflicts(data.conflicts);
                        setRescheduleError(data.error || "Xung đột lịch với nhân viên đã phân công");
                      } else {
                        setRescheduleError(data.error || "Lỗi đổi lịch");
                      }
                    } else {
                      invalidateBookingRelated(qc);
                      setShowReschedule(false);
                    }
                  } catch {
                    setRescheduleError("Lỗi kết nối, vui lòng thử lại");
                  } finally {
                    setRescheduling(false);
                  }
                }}
              >
                {rescheduling ? "Đang lưu..." : "Xác nhận đổi lịch"}
              </Button>
              <Button variant="outline" onClick={() => setShowReschedule(false)}>Hủy</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Density mode (Compact / Comfortable) ─────────────────────────────────────
type Density = "compact" | "comfortable";
const DENSITY_KEY = "calendar-density-v1";
const DENSITY_EVENT = "calendar-density-change";
function getStoredDensity(): Density {
  if (typeof window === "undefined") return "comfortable";
  const v = window.localStorage.getItem(DENSITY_KEY);
  return v === "compact" ? "compact" : "comfortable";
}
function useDensity(): [Density, (d: Density) => void] {
  const [density, setDensity] = useState<Density>(getStoredDensity);
  useEffect(() => {
    const handler = () => setDensity(getStoredDensity());
    window.addEventListener(DENSITY_EVENT, handler);
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener(DENSITY_EVENT, handler);
      window.removeEventListener("storage", handler);
    };
  }, []);
  const update = useCallback((d: Density) => {
    window.localStorage.setItem(DENSITY_KEY, d);
    window.dispatchEvent(new Event(DENSITY_EVENT));
  }, []);
  return [density, update];
}

function DensityToggle() {
  const [density, setDensity] = useDensity();
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border p-0.5 bg-muted/30" title="Chế độ hiển thị: Thoáng (dễ nhìn) hoặc Gọn (xem nhiều)">
      <button
        type="button"
        onClick={() => setDensity("comfortable")}
        aria-pressed={density === "comfortable"}
        aria-label="Chế độ hiển thị thoáng"
        className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-all ${
          density === "comfortable" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Rows3 className="w-3.5 h-3.5" /> Thoáng
      </button>
      <button
        type="button"
        onClick={() => setDensity("compact")}
        aria-pressed={density === "compact"}
        aria-label="Chế độ hiển thị gọn"
        className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-semibold transition-all ${
          density === "compact" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <LayoutList className="w-3.5 h-3.5" /> Gọn
      </button>
    </div>
  );
}

// ─── Rút gọn tên dịch vụ cho card lịch ────────────────────────────────────────
// "Album ngoại cảnh Basic" → "Album"
// "Chụp 1 tấm cổng" → "Cổng"
// "Chụp cổng Premium" → "Cổng"
// "Quay phim phóng sự" → "Quay phim"
function shortenServiceName(raw?: string | null): string {
  if (!raw) return "";
  let s = String(raw).trim();
  // Bỏ tier ở cuối: Basic/Premium/Standard/VIP/Pro/Cơ bản/Cao cấp/Tiêu chuẩn
  s = s.replace(/\s+(basic|premium|standard|vip|pro|deluxe|cao\s*cấp|cơ\s*bản|tiêu\s*chuẩn)\b.*$/i, "");
  // "Chụp [N tấm|N|tấm] X" → "X"
  s = s.replace(/^chụp\s+(?:\d+\s+tấm\s+|\d+\s+|tấm\s+)?/i, "");
  // "Album ..." → "Album"
  if (/^album\b/i.test(s)) return "Album";
  // "Quay phim ..." → "Quay phim"
  if (/^quay\s+phim\b/i.test(s)) return "Quay phim";
  // "Make[ ]up ..." → "Makeup"
  if (/^make\s*up\b/i.test(s)) return "Makeup";
  // Mặc định: lấy 1-2 từ đầu, viết hoa chữ cái đầu
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = words[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// ─── Map serviceCategory code → nhãn THỂ LOẠI ngắn (1-3 từ) cho card lịch ────
// Card lịch chỉ cần thể loại để nhìn nhanh, KHÔNG hiển thị tên gói dài.
const CATEGORY_LABELS: Record<string, string> = {
  wedding: "Tiệc",
  tiec: "Tiệc",
  tiec_cuoi: "Tiệc",
  studio: "Studio",
  album_studio: "Studio",
  outdoor: "Ngoại cảnh",
  album_outdoor: "Ngoại cảnh",
  prewedding: "Ngoại cảnh",
  beauty: "Beauty",
  fashion: "Beauty",
  nang_tho: "Nàng thơ",
  family: "Gia đình",
  gia_dinh: "Gia đình",
  video: "Quay phim",
  videography: "Quay phim",
  combo_makeup: "Combo makeup",
  combo_no_makeup: "Combo không makeup",
  makeup: "Makeup",
  makeup_only: "Makeup",
  print: "In ảnh",
  in_anh: "In ảnh",
  cong: "Cổng",
  chup_cong: "Cổng",
};

// Keyword-based inference khi không có serviceCategory.
// THỨ TỰ QUAN TRỌNG: kiểm tra cụm cụ thể trước (vd "combo không makeup"
// trước "combo makeup" trước "makeup").
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/combo\s*kh[ôo]ng\s*makeup|combo\s*no\s*makeup/i, "Combo không makeup"],
  [/combo\s*(?:c[óo]\s*)?makeup|combo\s*có\s*mu/i, "Combo makeup"],
  [/c[ổo]ng|chup\s*cong/i, "Cổng"],
  [/ngo[ạa]i\s*c[ảa]nh|prewedding|pre[-\s]?wedding|outdoor/i, "Ngoại cảnh"],
  [/album\s*studio|ch[ụu]p\s*studio|\bstudio\b/i, "Studio"],
  [/n[àa]ng\s*th[ơo]/i, "Nàng thơ"],
  [/beauty|th[ờo]i\s*trang|fashion/i, "Beauty"],
  [/gia\s*đ[ìi]nh|\bfamily\b/i, "Gia đình"],
  [/quay\s*phim|videography|\bvideo\b/i, "Quay phim"],
  [/in\s*[ảa]nh|\bprint\b/i, "In ảnh"],
  // "Tiệc" gom: tiệc cưới, phóng sự, truyền thống, sinh nhật, lễ
  [/ti[ệe]c|ph[óo]ng\s*s[ựu]|truy[ềe]n\s*th[ốo]ng|sinh\s*nh[ậa]t|\bl[ễe]\b/i, "Tiệc"],
  [/\bmakeup\b|\bmu\b/i, "Makeup"],
];

function inferCategoryFromText(text?: string | null): string {
  if (!text) return "";
  const s = String(text);
  for (const [re, label] of CATEGORY_KEYWORDS) {
    if (re.test(s)) return label;
  }
  return "";
}

// Fallback chain (luôn ra THỂ LOẠI ngắn, không phải tên gói):
//   1. booking.serviceCategory → CATEGORY_LABELS
//   2. infer keyword từ item.serviceLabel → item.serviceName
//                       → booking.serviceLabel → booking.packageType
//   3. "Dịch vụ"
function getServiceDisplay(
  booking: { serviceLabel?: string | null; packageType?: string | null; serviceCategory?: string | null },
  item?: { serviceLabel?: string | null; serviceName?: string | null } | null,
): string {
  const cat = (booking.serviceCategory ?? "").trim().toLowerCase();
  if (cat && CATEGORY_LABELS[cat]) return CATEGORY_LABELS[cat];

  const candidates = [
    item?.serviceLabel,
    item?.serviceName,
    booking.serviceLabel,
    booking.packageType,
  ];
  for (const c of candidates) {
    const inferred = inferCategoryFromText(c);
    if (inferred) return inferred;
  }

  return "Dịch vụ";
}

function getServiceDetailLine(
  booking: { serviceLabel?: string | null; packageType?: string | null; serviceCategory?: string | null },
  item?: { serviceLabel?: string | null; serviceName?: string | null } | null,
): string {
  const svcLabel = (booking.serviceLabel ?? "").trim();
  const pkgName = (item?.serviceName ?? item?.serviceLabel ?? "").trim();
  const pkgFallback = (booking.packageType ?? "").trim();
  const specificName = pkgName || pkgFallback;
  const isDvLabel = /^Dịch vụ \d/i.test(svcLabel);
  if (isDvLabel && specificName && !/^Dịch vụ \d/i.test(specificName)) {
    return `${svcLabel.toUpperCase()}: ${specificName.toUpperCase()}`;
  }
  if (specificName && !/^Dịch vụ \d/i.test(specificName)) return specificName;
  if (svcLabel && !isDvLabel) return svcLabel;
  return getServiceDisplay(booking, item);
}

// ─── Helper: build dòng nhân sự cho card lịch ────────────────────────────────
// Trả {p, m, sale, extras, unassigned}. Chỉ dùng "lastName" cho gọn.
// `extras` là các badge ngắn cho vai trò phụ (PTS / V / HT / TL), đã loại trùng
// và sắp xếp ổn định. `unassigned` chỉ phản ánh P/M/Sale (không tính extras) để
// giữ nguyên hành vi cảnh báo "Chưa giao việc" của Day/Week view.
function getStaffLine(
  booking: { assignedStaff?: unknown; taskAssignees?: TaskAssignee[] },
  item?: OrderLine | null,
): { p: string; m: string; sale: string; v: string; extras: string[]; unassigned: boolean } {
  // Lấy đủ tất cả P/M/Quay phim của item, không chỉ người đầu tiên (yêu cầu hiển thị
  // "P: TRUNG, QUAN" khi 1 dịch vụ có nhiều photographer).
  const { photoNames, makeupNames, videoNames } = resolveItemStaffAll(item);
  let p = photoNames.join(", ");
  let m = makeupNames.join(", ");
  let v = videoNames.join(", ");
  let sale = "";

  // Sale từ assignedStaff (booking-level hoặc item-level) — dùng tên đầy đủ
  const pickSale = (arr: unknown): string => {
    if (!Array.isArray(arr)) return "";
    for (const sa of arr as { role?: string; staffName?: string }[]) {
      if (sa?.role && canonicalRole(sa.role) === "sales" && sa.staffName) {
        return sa.staffName.trim();
      }
    }
    return "";
  };
  if (item) sale = pickSale(item.assignedStaff);
  if (!sale) sale = pickSale(booking.assignedStaff);

  // Vai trò phụ: PTS / Hỗ trợ / Trợ lý — chỉ lấy badge ngắn, không tên.
  // (Quay phim/videographer giờ hiển thị theo TÊN qua biến v, không còn badge "V".)
  const EXTRA_LABELS: Record<string, string> = {
    photoshop: "PTS",
    support: "HT",
    assistant: "TL",
    assistant_photo: "TL",
  };
  const extraSet = new Set<string>();
  const collectExtra = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const sa of arr as { role?: string; staffName?: string }[]) {
      if (!sa?.role || !sa.staffName) continue;
      const lbl = EXTRA_LABELS[canonicalRole(sa.role)];
      if (lbl) extraSet.add(lbl);
    }
  };
  collectExtra(booking.assignedStaff);
  if (item) collectExtra(item.assignedStaff);

  // taskAssignees fallback cho P/M + bắt thêm vai trò phụ
  // CHỈ fallback khi item KHÔNG có photographer/makeup nào — tránh hiển thị tên
  // cũ từ tasks table khi user đã đổi nhân sự ở items[] (data đã đồng bộ về items
  // nhưng tasks table chưa update kịp).
  for (const ta of (booking.taskAssignees ?? [])) {
    if (!ta.assigneeName) continue;
    const canon = canonicalRole(ta.role ?? ta.taskType);
    const fullName = ta.assigneeName.trim();
    if (canon === "photographer" && !p && photoNames.length === 0) p = fullName;
    else if (canon === "makeup" && !m && makeupNames.length === 0) m = fullName;
    else if (canon === "videographer" && !v && videoNames.length === 0) v = fullName;
    else if (canon === "sales" && !sale) sale = fullName;
    else if (EXTRA_LABELS[canon]) extraSet.add(EXTRA_LABELS[canon]);
  }

  // Thứ tự ổn định: PTS → HT → TL
  const order = ["PTS", "HT", "TL"];
  const extras = order.filter(x => extraSet.has(x));

  // unassigned (badge "Chưa giao việc") tính cả Quay phim — show chỉ có quay phim KHÔNG còn báo chưa giao.
  return { p, m, sale, v, extras, unassigned: !p && !m && !sale && !v };
}

// ─── (legacy) Mobile agenda — không còn dùng, giữ làm tham chiếu cho mode "Danh sách" tương lai ───
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _MonthAgendaMobile_DEPRECATED({
  daysInMonth, getBookingsForDay, onDayClick, onBookingClick, allStaff, selectedDate, showLunar,
}: {
  daysInMonth: Date[];
  getBookingsForDay: (d: Date) => Booking[];
  onDayClick: (d: Date) => void;
  onBookingClick?: (b: Booking) => void;
  allStaff: Staff[];
  selectedDate: Date;
  showLunar: boolean;
}) {
  const DAY_LABELS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  const daysWithBookings = daysInMonth
    .map(d => ({ date: d, bookings: getBookingsForDay(d) }))
    .filter(x => x.bookings.length > 0);

  if (daysWithBookings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <CalendarDays className="w-12 h-12 text-muted-foreground/40 mb-3" />
        <p className="text-sm text-muted-foreground">Tháng này chưa có show nào</p>
        <p className="text-xs text-muted-foreground/70 mt-1">Bấm nút "+ Tạo show" để thêm mới</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/40">
      {daysWithBookings.map(({ date, bookings }) => {
        const lunar = convertSolarToLunar(date.getDate(), date.getMonth() + 1, date.getFullYear());
        const dow = DAY_LABELS[date.getDay()];
        const isSun = date.getDay() === 0;
        const isSat = date.getDay() === 6;
        const isSel = isSameDay(date, selectedDate);
        const sortedBookings = [...bookings].sort((a, b) => (a.shootTime ?? "").localeCompare(b.shootTime ?? ""));
        return (
          <div key={date.toISOString()} className={isToday(date) ? "bg-orange-50/30 dark:bg-orange-950/10" : isSel ? "bg-primary/5" : ""}>
            {/* Day header */}
            <button
              type="button"
              onClick={() => onDayClick(date)}
              className="w-full flex items-center gap-3 px-4 py-2.5 sticky top-0 bg-card/95 backdrop-blur z-10 border-b border-border/30 hover:bg-muted/30 transition-colors"
            >
              <div className={[
                "w-11 h-11 rounded-xl flex flex-col items-center justify-center flex-shrink-0",
                isToday(date) ? "bg-primary text-primary-foreground" : "bg-muted/50",
              ].join(" ")}>
                <span className="text-lg font-black leading-none">{date.getDate()}</span>
                <span className={`text-[9px] font-semibold mt-0.5 leading-none ${isToday(date) ? "text-primary-foreground/80" : isSun ? "text-red-500" : isSat ? "text-blue-600" : "text-muted-foreground"}`}>{dow}</span>
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-sm font-bold">
                  {format(date, "dd 'tháng' MM", { locale: vi })}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">· {bookings.length} show</span>
                </div>
                {showLunar && (
                  <div className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                    <Moon className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                    AL {lunar.day}/{lunar.month}
                  </div>
                )}
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            </button>

            {/* Cards */}
            <div className="px-3 py-2 space-y-2">
              {sortedBookings.map(b => {
                const item = b.items?.[0];
                const hourStr = b.shootTime
                  ? b.shootTime.endsWith(":00") ? b.shootTime.slice(0, 2) + "h" : b.shootTime.slice(0, 5)
                  : "";
                const svcName = getServiceDisplay(b, item);
                const { p: pName, m: mName, sale: saleName, v: vName, unassigned: hasNoStaff } = getStaffLine(b, item);
                const { card: cardBg, bar: barColor } = getStaffColors(b, allStaff);
                const customerName = b.customerName?.trim() || "(Chưa có tên)";
                return (
                  <button
                    key={b._occKey ?? b.id}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onBookingClick?.(b); }}
                    className={`w-full text-left rounded-xl border ${cardBg} px-3 py-2.5 active:scale-[0.99] transition-transform shadow-sm flex gap-3`}
                  >
                    <div className={`w-1.5 rounded-full flex-shrink-0 ${barColor}`} />
                    <div className="flex-1 min-w-0">
                      {/* Time + name */}
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-base font-black tabular-nums">{hourStr}</span>
                        <span className="text-base font-bold flex-1 min-w-0 break-words">{customerName}</span>
                        {isPriorityRank(b.customerRank) && <RankBadge rank={b.customerRank} size="xs" />}
                      </div>
                      {/* Phone */}
                      {b.customerPhone && (
                        <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
                          <Phone className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                          <span className="font-medium tabular-nums">{b.customerPhone}</span>
                        </div>
                      )}
                      {/* Service — luôn hiện, không bao giờ ẩn */}
                      <div className="text-sm text-foreground/80 mt-0.5 break-words">{svcName}</div>
                      {/* Staff line */}
                      {(pName || mName || vName || saleName) && (
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                          {pName && (
                            <span className="flex items-center gap-1">
                              <Camera className="w-3 h-3 text-sky-500" />
                              <span className="font-medium text-foreground/90">Nhiếp ảnh: {pName}</span>
                            </span>
                          )}
                          {mName && (
                            <span className="flex items-center gap-1">
                              <Sparkles className="w-3 h-3 text-pink-500" />
                              <span className="font-medium text-foreground/90">Makeup: {mName}</span>
                            </span>
                          )}
                          {vName && (
                            <span className="flex items-center gap-1">
                              <span className="font-medium text-foreground/90">🎬 Quay phim: {vName}</span>
                            </span>
                          )}
                          {saleName && (
                            <span className="font-medium text-foreground/90">Sale: {saleName}</span>
                          )}
                        </div>
                      )}
                      {/* Status */}
                      {hasNoStaff && (
                        <div className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/15 text-red-600 dark:text-red-400 text-[11px] font-semibold">
                          <AlertCircle className="w-3 h-3 flex-shrink-0" /> Chưa giao việc
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Leave overlay (Xin nghỉ / Off) ────────────────────────────────────────────
// Source riêng — KHÔNG merge vào bookings[]. Item không drag/resize/edit, không contractId.
type LeaveRequest = {
  id: number;
  staffId: number;
  staffName?: string | null;
  startDate: string;
  endDate: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | string;
  approvedByName?: string | null;
  reviewedAt?: string | null;
  notes?: string | null;
  leaveType?: string | null;
  session?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  createdAt?: string;
};

const LEAVE_TYPE_OPTS: { value: string; label: string }[] = [
  { value: "off", label: "Xin off" },
  { value: "di_hoc", label: "Đi học" },
  { value: "viec_rieng", label: "Việc riêng" },
  { value: "benh", label: "Bệnh" },
  { value: "khac", label: "Khác" },
];
const LEAVE_SESSION_OPTS: { value: string; label: string }[] = [
  { value: "full_day", label: "Cả ngày" },
  { value: "morning", label: "Sáng" },
  { value: "afternoon", label: "Chiều" },
  { value: "custom", label: "Giờ riêng" },
];
function leaveTypeLabel(t?: string | null): string {
  return LEAVE_TYPE_OPTS.find(o => o.value === t)?.label ?? "Xin off";
}
function leaveSessionLabel(lv: { session?: string | null; startTime?: string | null; endTime?: string | null }): string {
  if (lv.session === "custom" && lv.startTime && lv.endTime) {
    return `${lv.startTime.slice(0, 5)}–${lv.endTime.slice(0, 5)}`;
  }
  return LEAVE_SESSION_OPTS.find(o => o.value === lv.session)?.label ?? "Cả ngày";
}
function leaveStatusLabel(lv: LeaveRequest): string {
  const name = lv.staffName || `NV#${lv.staffId}`;
  switch (lv.status) {
    case "approved": return `Đã duyệt nghỉ · ${name}`;
    case "rejected": return `Từ chối nghỉ · ${name}`;
    case "cancelled": return `Đã huỷ · ${name}`;
    default: return `Xin nghỉ · ${name}`;
  }
}
function leaveStatusClasses(status: string): string {
  switch (status) {
    case "approved":
      return "bg-green-100 text-green-700 border-green-300 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700";
    case "rejected":
    case "cancelled":
      return "bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200 line-through dark:bg-gray-800/50 dark:text-gray-400 dark:border-gray-700";
    default:
      return "bg-red-100 text-red-700 border-red-300 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700";
  }
}

// ─── Month day cell ────────────────────────────────────────────────────────────
const MAX_VISIBLE_COMPACT = 3;
const MAX_VISIBLE_COMFORT = 4;

function MonthDayCell({
  date, bookings, leaves, warnings, isSelected, isOtherMonth, onDayClick, onBookingClick, onLeaveClick, onWarningClick, allStaff, pkgGroupMap,
}: {
  date: Date; bookings: Booking[]; leaves?: LeaveRequest[]; warnings?: DressWarnChip[]; isSelected: boolean; isOtherMonth?: boolean;
  onDayClick: (d: Date) => void; onBookingClick?: (b: Booking) => void;
  onLeaveClick?: (l: LeaveRequest) => void;
  onWarningClick?: (bookingId: number) => void;
  allStaff: Staff[];
  pkgGroupMap?: Map<number, string>;
}) {
  const { lunar, solarHoliday, lunarHoliday } = useMemo(() => getLunarInfo(date), [date]);
  const isSun = date.getDay() === 0;
  const isSat = date.getDay() === 6;
  const isLunarNew = lunar.day === 1;
  const isRam = lunar.day === 15;
  const [density] = useDensity();
  const isComfort = density === "comfortable";
  const MAX_VISIBLE = isComfort ? MAX_VISIBLE_COMFORT : MAX_VISIBLE_COMPACT;

  return (
    <div
      className={[
        "group relative flex flex-col border-r border-b border-border/50 cursor-pointer select-none",
        "transition-colors duration-100",
        isComfort
          ? "min-h-[220px] sm:min-h-[260px]"
          : "min-h-[150px] sm:min-h-[170px] overflow-hidden",
        isSelected ? "bg-primary/5" : isToday(date) ? "bg-orange-50/30 dark:bg-orange-950/10" : "hover:bg-muted/20",
        isOtherMonth ? "opacity-25" : "",
      ].join(" ")}
      onClick={() => onDayClick(date)}
    >
      {/* Day header — click always goes to Day View */}
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onDayClick(date); }}
        className="w-full flex items-center justify-between px-1.5 pt-1 pb-0.5 flex-shrink-0 hover:bg-muted/30 transition-colors rounded-sm text-left"
      >
        <div className="flex items-center gap-1">
          <span className={[
            "text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full leading-none flex-shrink-0",
            isToday(date) ? "bg-primary text-primary-foreground" : isSun ? "text-red-500" : isSat ? "text-blue-600" : "text-foreground",
            isSelected && !isToday(date) ? "ring-2 ring-primary" : "",
          ].join(" ")}>
            {date.getDate()}
          </span>
          <span className={[
            "text-[8px] font-medium leading-none",
            lunarHoliday ? "text-red-500" : isLunarNew ? "text-primary" : isRam ? "text-amber-600" : "text-muted-foreground/60",
          ].join(" ")}>
            {isLunarNew ? `AL 1/${lunar.month}` : isRam ? "Rằm" : `AL${lunar.day}`}
          </span>
        </div>
        {(solarHoliday || lunarHoliday) && (
          <span className="text-[7px] text-red-500 font-semibold leading-none truncate max-w-[36px]">
            {(solarHoliday || lunarHoliday)?.slice(0, 7)}
          </span>
        )}
      </button>

      {/* Show cards */}
      <div className={`flex-1 ${isComfort ? "px-1 pb-1 space-y-1" : "px-[2%] pb-1 space-y-[3px] overflow-hidden"}`}>
        {/* Leave overlay — render TRƯỚC bookings, không gộp vào bookings[], không drag/resize/edit */}
        {leaves && leaves.length > 0 && leaves.map(lv => {
          const label = leaveStatusLabel(lv);
          const cls = leaveStatusClasses(lv.status);
          return (
            <button
              key={`lv-${lv.id}`}
              type="button"
              onClick={e => { e.stopPropagation(); onLeaveClick?.(lv); }}
              className={`w-full text-left rounded px-1 py-0.5 border text-[10px] leading-tight flex items-center gap-1 ${cls}`}
              title={`${label} — ${leaveTypeLabel(lv.leaveType)}${lv.session && lv.session !== "full_day" ? " · " + leaveSessionLabel(lv) : ""}`}
            >
              <Moon className="w-2.5 h-2.5 flex-shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
        {/* Nhắc thuê đồ — chip riêng kiểu Off, KHÔNG gộp bookings[] (không phải booking).
            Màu: lấy đồ = VÀNG, trả đồ = CAM, quá hạn = ĐỎ. Bấm mở đúng booking chính. */}
        {warnings && warnings.length > 0 && warnings.map(w => (
          <button
            key={w.key}
            type="button"
            onClick={e => { e.stopPropagation(); onWarningClick?.(w.bookingId); }}
            className={`w-full text-left rounded px-1 py-0.5 border text-[10px] leading-tight flex items-center gap-1 ${
              w.overdue
                ? "bg-red-200 text-red-900 border-red-500 font-semibold hover:bg-red-300 dark:bg-red-900/40 dark:text-red-200"
                : w.kind === "return"
                  ? "bg-orange-200 text-orange-900 border-orange-400 hover:bg-orange-300 dark:bg-orange-900/30 dark:text-orange-300"
                  : "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-200 dark:bg-amber-900/20 dark:text-amber-300"
            }`}
            title={w.label}
          >
            <Shirt className="w-2.5 h-2.5 flex-shrink-0" />
            <span className="truncate">{w.label}</span>
          </button>
        ))}
        {bookings
          .slice()
          .sort((a, b) => (a.shootTime ?? "").localeCompare(b.shootTime ?? ""))
          .slice(0, MAX_VISIBLE)
          .map(b => {
            const item = b.items?.[0];
            const hourStr = b.shootTime
              ? b.shootTime.endsWith(":00") ? b.shootTime.slice(0, 2) + "h" : b.shootTime.slice(0, 5)
              : "";
            const serviceName = getServiceDisplay(b, item);
            const gName = b.servicePackageId ? pkgGroupMap?.get(b.servicePackageId) : undefined;
            const { p: photoLast, m: makeupLast, sale: saleLast, v: videoLast, extras: extraRoles, unassigned: hasNoStaff } = getStaffLine(b, item);
            const staffParts: string[] = [];
            if (photoLast) staffParts.push(`P: ${photoLast}`);
            if (makeupLast) staffParts.push(`M: ${makeupLast}`);
            if (videoLast) staffParts.push(`Quay: ${videoLast}`);
            if (saleLast) staffParts.push(`Sale: ${saleLast}`);
            const staffLine = staffParts.join(" | ");
            const extrasSuffix = extraRoles.length > 0 ? ` +${extraRoles.join(", ")}` : "";

            const { bar: chipBar } = getStaffColors(b, allStaff);

            // Sizes — tinh chỉnh: nhỏ gọn hơn nhưng vẫn đọc rõ; auto scale theo viewport
            const cardPad = isComfort ? "px-1.5 py-1" : "px-1.5 py-1";
            const timeCls = isComfort ? "text-[12px] sm:text-[13px] font-black" : "text-[11px] font-black";
            const nameCls = isComfort ? "text-[12px] sm:text-[13px] font-bold leading-tight break-words" : "text-[11px] font-bold truncate";
            const lineCls = isComfort ? "text-[10px] sm:text-[11px] leading-tight break-words" : "text-[10px] leading-tight truncate";

            return (
              <button
                key={b._occKey ?? b.id}
                type="button"
                onClick={e => { e.stopPropagation(); onBookingClick ? onBookingClick(b) : onDayClick(date); }}
                className={`w-full text-left rounded ${cardPad} ${chipBar} hover:brightness-95 transition-all ${isComfort ? "shadow-sm" : ""}`}
              >
                {/* 1. Giờ + 2. Tên khách + 3. VIP crown */}
                <div className={`flex items-baseline gap-1 ${isComfort ? "flex-wrap" : "leading-tight"}`}>
                  {hourStr && <span className={`${timeCls} flex-shrink-0`}>{hourStr}</span>}
                  {isPriorityRank(b.customerRank) && (
                    <Crown className={`${isComfort ? "w-3 h-3" : "w-2.5 h-2.5"} text-amber-600 flex-shrink-0 self-center`} />
                  )}
                  <span className={nameCls}>{b.customerName || "(Chưa có tên)"}</span>
                </div>
                {b._occLabel && (
                  <div className="text-[9px] sm:text-[10px] font-bold text-blue-600 dark:text-blue-300 leading-tight truncate">📅 {b._occLabel}</div>
                )}
                {/* 3b. VIP badge — luôn xuống dòng riêng để không bị che (không thu nhỏ quá) */}
                {b.customerRank && b.customerRank !== "new" && (
                  <div className="mt-0.5"><RankBadge rank={b.customerRank} size={isComfort ? "sm" : "xs"} /></div>
                )}
                {/* Dòng dịch vụ — nhóm + tên gói */}
                <div className="text-[10px] sm:text-[11px] leading-tight break-words opacity-90 flex items-center gap-1 flex-wrap">
                  <span>{gName ? `${gName} · ${serviceName}` : serviceName}</span>
                </div>
                {/* Dòng nhân sự — luôn hiện (badge khi chưa giao) */}
                {staffLine ? (
                  <div className={`${lineCls} font-medium opacity-90 truncate`} title={extraRoles.length > 0 ? `Vai trò phụ: ${extraRoles.join(", ")}` : undefined}>
                    {staffLine}
                    {extrasSuffix && <span className="opacity-75">{extrasSuffix}</span>}
                  </div>
                ) : extraRoles.length > 0 ? (
                  <div className={`${lineCls} font-medium opacity-90 truncate`} title={`Vai trò phụ: ${extraRoles.join(", ")}`}>
                    +{extraRoles.join(", ")}
                  </div>
                ) : (
                  <div className={`${lineCls} font-semibold text-red-600 dark:text-red-400 truncate flex items-center gap-1`}>
                    <AlertCircle className="w-3 h-3 flex-shrink-0" /> Chưa giao việc
                  </div>
                )}
              </button>
            );
          })}
        {bookings.length > MAX_VISIBLE && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onDayClick(date); }}
            className={`${isComfort ? "text-xs" : "text-[9px]"} text-primary/70 hover:text-primary pl-1 underline-offset-2 hover:underline transition-colors font-semibold`}
          >
            +{bookings.length - MAX_VISIBLE} show nữa
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Leave form dialog (Xin nghỉ / Off) ───────────────────────────────────────
function LeaveFormDialog({
  open, onOpenChange, isAdmin, viewerId, allStaff, onSubmitted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isAdmin: boolean;
  viewerId?: number;
  allStaff: Staff[];
  onSubmitted: () => void;
}) {
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [staffId, setStaffId] = useState<number | undefined>(viewerId);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [session, setSession] = useState("full_day");
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("12:00");
  const [leaveType, setLeaveType] = useState("off");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setStaffId(viewerId);
      setStartDate(today); setEndDate(today);
      setSession("full_day"); setStartTime("08:00"); setEndTime("12:00");
      setLeaveType("off"); setReason("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, viewerId]);

  const submit = async () => {
    if (!startDate || !endDate) { toast({ title: "Thiếu ngày", variant: "destructive" }); return; }
    if (endDate < startDate) { toast({ title: "Ngày kết thúc phải ≥ ngày bắt đầu", variant: "destructive" }); return; }
    if (reason.trim().length < 5) { toast({ title: "Lý do phải ≥ 5 ký tự", variant: "destructive" }); return; }
    if (session === "custom" && (!startTime || !endTime)) {
      toast({ title: "Vui lòng nhập giờ bắt đầu/kết thúc", variant: "destructive" }); return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        startDate, endDate, reason: reason.trim(), leaveType, session,
      };
      if (isAdmin && staffId) body.staffId = staffId;
      if (session === "custom") { body.startTime = startTime; body.endTime = endTime; }
      const res = await authFetch(`${BASE}/api/leave-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Không gửi được đơn");
      }
      toast({ title: "Đã gửi đơn xin nghỉ" });
      onSubmitted();
      onOpenChange(false);
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <UIDialog open={open} onOpenChange={onOpenChange}>
      <UIDialogContent className="sm:max-w-md">
        <UIDialogHeader>
          <UIDialogTitle className="flex items-center gap-2">
            <Coffee className="w-4 h-4 text-red-500" /> Đơn xin nghỉ / Off
          </UIDialogTitle>
          <UIDialogDescription>Đơn nghỉ KHÔNG tạo booking — không ảnh hưởng doanh thu/show.</UIDialogDescription>
        </UIDialogHeader>
        <div className="space-y-3">
          {isAdmin && (
            <div>
              <label className="text-xs font-semibold mb-1 block">Nhân viên</label>
              <select className="w-full border rounded h-9 px-2 text-sm bg-background"
                value={staffId ?? ""}
                onChange={e => setStaffId(e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">— Chọn nhân viên —</option>
                {allStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold mb-1 block">Từ ngày</label>
              <input type="date" className="w-full border rounded h-9 px-2 text-sm bg-background" value={startDate} onChange={e => { setStartDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} />
            </div>
            <div>
              <label className="text-xs font-semibold mb-1 block">Đến ngày</label>
              <input type="date" className="w-full border rounded h-9 px-2 text-sm bg-background" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold mb-1 block">Buổi</label>
            <select className="w-full border rounded h-9 px-2 text-sm bg-background" value={session} onChange={e => setSession(e.target.value)}>
              {LEAVE_SESSION_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {session === "custom" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold mb-1 block">Giờ bắt đầu</label>
                <input type="time" className="w-full border rounded h-9 px-2 text-sm bg-background" value={startTime} onChange={e => setStartTime(e.target.value)} />
              </div>
              <div>
                <label className="text-xs font-semibold mb-1 block">Giờ kết thúc</label>
                <input type="time" className="w-full border rounded h-9 px-2 text-sm bg-background" value={endTime} onChange={e => setEndTime(e.target.value)} />
              </div>
            </div>
          )}
          <div>
            <label className="text-xs font-semibold mb-1 block">Loại nghỉ</label>
            <select className="w-full border rounded h-9 px-2 text-sm bg-background" value={leaveType} onChange={e => setLeaveType(e.target.value)}>
              {LEAVE_TYPE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold mb-1 block">Lý do (≥ 5 ký tự)</label>
            <textarea className="w-full border rounded p-2 text-sm bg-background" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Nhập lý do…" />
          </div>
        </div>
        <UIDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Huỷ</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Đang gửi…" : "Gửi đơn"}</Button>
        </UIDialogFooter>
      </UIDialogContent>
    </UIDialog>
  );
}

// ─── Leave detail dialog ──────────────────────────────────────────────────────
function LeaveDetailDialog({
  leave, onClose, isAdmin, canDelete = false, viewerId, viewerName, onChanged,
}: {
  leave: LeaveRequest | null;
  onClose: () => void;
  isAdmin: boolean;
  canDelete?: boolean;
  viewerId?: number;
  viewerName?: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const open = !!leave;

  useEffect(() => { if (!open) { setRejectOpen(false); setRejectReason(""); } }, [open]);

  if (!leave) return null;

  const isOwner = viewerId === leave.staffId;
  const canApproveReject = isAdmin && leave.status === "pending";
  const canUnapprove = isAdmin && leave.status === "approved";
  const canSelfCancel = !isAdmin && isOwner && leave.status === "pending";

  const onDelete = async () => {
    if (!window.confirm("Bạn có chắc muốn xóa đơn xin nghỉ này không?")) return;
    setBusy(true);
    try {
      const res = await authFetch(`${BASE}/api/leave-requests/${leave.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Xóa đơn thất bại");
      }
      onChanged();
      onClose();
      toast({ title: "Đã xóa đơn xin nghỉ" });
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const update = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await authFetch(`${BASE}/api/leave-requests/${leave.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Thao tác thất bại");
      }
      onChanged();
      onClose();
      toast({ title: "Đã cập nhật đơn" });
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally { setBusy(false); }
  };

  const onApprove = () => update({ status: "approved", approvedByName: viewerName });
  const onUnapprove = () => update({ status: "cancelled", approvedByName: viewerName });
  const onSelfCancel = () => update({ status: "cancelled" });
  const onConfirmReject = () => {
    if (rejectReason.trim().length < 5) { toast({ title: "Lý do từ chối phải ≥ 5 ký tự", variant: "destructive" }); return; }
    update({ status: "rejected", approvedByName: viewerName, notes: rejectReason.trim() });
  };

  return (
    <UIDialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <UIDialogContent className="sm:max-w-md">
        <UIDialogHeader>
          <UIDialogTitle className="flex items-center gap-2">
            <Moon className="w-4 h-4" /> Đơn xin nghỉ
          </UIDialogTitle>
        </UIDialogHeader>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Nhân viên</span><span className="font-semibold">{leave.staffName || `#${leave.staffId}`}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Ngày</span><span className="font-medium">{leave.startDate === leave.endDate ? leave.startDate : `${leave.startDate} → ${leave.endDate}`}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Buổi</span><span className="font-medium">{leaveSessionLabel(leave)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Loại</span><span className="font-medium">{leaveTypeLabel(leave.leaveType)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Trạng thái</span>
            <span className={`px-2 py-0.5 rounded text-xs font-semibold border ${leaveStatusClasses(leave.status)}`}>
              {leave.status === "approved" ? "Đã duyệt" : leave.status === "rejected" ? "Từ chối" : leave.status === "cancelled" ? "Đã huỷ" : "Chờ duyệt"}
            </span>
          </div>
          <div>
            <div className="text-muted-foreground mb-0.5">Lý do</div>
            <div className="border rounded p-2 bg-muted/30 whitespace-pre-wrap text-sm">{leave.reason}</div>
          </div>
          {leave.approvedByName && (
            <div className="flex justify-between"><span className="text-muted-foreground">Người duyệt</span><span className="font-medium">{leave.approvedByName}</span></div>
          )}
          {leave.status === "rejected" && leave.notes && (
            <div>
              <div className="text-muted-foreground mb-0.5">Ghi chú admin</div>
              <div className="border rounded p-2 bg-muted/30 text-sm">{leave.notes}</div>
            </div>
          )}
        </div>
        <UIDialogFooter className="gap-2 flex-wrap">
          {canApproveReject && (
            <>
              <Button variant="outline" onClick={() => setRejectOpen(true)} disabled={busy}>Từ chối</Button>
              <Button onClick={onApprove} disabled={busy}>Duyệt</Button>
            </>
          )}
          {canUnapprove && (
            <Button variant="outline" onClick={onUnapprove} disabled={busy}>Huỷ duyệt</Button>
          )}
          {canDelete && (
            <Button
              variant="outline"
              onClick={onDelete}
              disabled={busy}
              className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700 gap-1.5"
            >
              <Trash2 className="w-4 h-4" /> Xóa đơn
            </Button>
          )}
          {canSelfCancel && (
            <Button variant="outline" onClick={onSelfCancel} disabled={busy}>Huỷ đơn của tôi</Button>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>Đóng</Button>
        </UIDialogFooter>

        {rejectOpen && (
          <div className="mt-3 border-t pt-3">
            <label className="text-xs font-semibold mb-1 block">Lý do từ chối (≥ 5 ký tự)</label>
            <textarea className="w-full border rounded p-2 text-sm bg-background" rows={3} value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="ghost" onClick={() => setRejectOpen(false)} disabled={busy}>Quay lại</Button>
              <Button onClick={onConfirmReject} disabled={busy}>Xác nhận từ chối</Button>
            </div>
          </div>
        )}
      </UIDialogContent>
    </UIDialog>
  );
}

// ─── Day view — 24h timeline ───────────────────────────────────────────────────
function DayView({
  date, bookings, isLoading,
  onBack, onPrevDay, onNextDay,
  onTimeClick, onEventClick,
  isAdmin, onToggleMode, rawIsAdmin,
  allStaff, highlightedBookingId,
  pkgGroupMap,
}: {
  date: Date; bookings: Booking[]; isLoading: boolean;
  onBack: () => void; onPrevDay: () => void; onNextDay: () => void;
  onTimeClick: (time: string) => void; onEventClick: (b: Booking) => void;
  isAdmin: boolean; onToggleMode: () => void; rawIsAdmin?: boolean;
  allStaff: Staff[]; highlightedBookingId?: number | null;
  pkgGroupMap?: Map<number, string>;
}) {
  const { lunar, tietKhi, solarHoliday, lunarHoliday } = useMemo(() => getLunarInfo(date), [date]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Map customerId → avatar (for showing avatar next to customer name)
  const { data: customersList = [] } = useQuery<Customer[]>({
    queryKey: ["customers", "all-avatars"],
    queryFn: () => authFetch(`${BASE}/api/customers`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d as Customer[] : []),
    staleTime: 60_000,
  });
  const customerAvatarMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of customersList) if (c.id && c.avatar) m.set(c.id, c.avatar);
    return m;
  }, [customersList]);

  const [previewImg, setPreviewImg] = useState<string | null>(null);

  const nowH = new Date().getHours() + new Date().getMinutes() / 60;
  const nowHour = Math.floor(nowH);
  const isToday_ = isToday(date);

  // Group bookings by starting hour
  const bookingsByHour = useMemo(() => {
    const map = new Map<number, Booking[]>();
    for (const b of bookings) {
      const h = parseInt((b.shootTime ?? "00:00").split(":")[0]) || 0;
      if (!map.has(h)) map.set(h, []);
      map.get(h)!.push(b);
    }
    return map;
  }, [bookings]);

  useEffect(() => {
    const sample = bookings.find(b => b.orderCode === "DH0007-1") ?? bookings.find(b => b.id === 1);
    if (sample) console.log("[DayView] booking sample", sample);
  }, [bookings]);


  // Scroll to first booking hour, or current hour, or 07:00
  useEffect(() => {
    let targetBooking: Booking | undefined;
    if (highlightedBookingId) {
      targetBooking = bookings.find(b => b.id === highlightedBookingId);
    }
    if (!targetBooking) {
      targetBooking = bookings.slice().sort((a, b) => (a.shootTime ?? "").localeCompare(b.shootTime ?? ""))[0];
    }
    const scrollHour = targetBooking
      ? Math.max(0, (parseInt(targetBooking.shootTime ?? "07") || 7) - 1)
      : isToday_ ? Math.max(0, nowHour - 1) : 7;

    // Use requestAnimationFrame to ensure DOM is ready after render
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[data-hour="${scrollHour}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [date, bookings, highlightedBookingId, isToday_, nowHour]);

  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {/* Header */}
      <div className="flex-shrink-0 border-b bg-card">
        <div className="flex items-center gap-2 px-4 py-3">
          <button onClick={onBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Sun className="w-4 h-4 text-orange-400" />
              <span className="font-bold text-base capitalize">
                {format(date, "EEEE, dd/MM/yyyy", { locale: vi })}
              </span>
              {isToday_ && <span className="text-[10px] bg-primary text-primary-foreground px-2 py-0.5 rounded-full font-bold">Hôm nay</span>}
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Moon className="w-3 h-3 text-indigo-400" />
                {lunar.day}/{lunar.month} Âm lịch · {getCanChi(lunar.year)}
              </span>
              {tietKhi && <span className="text-xs text-orange-500">✦ {tietKhi}</span>}
              {(solarHoliday || lunarHoliday) && <span className="text-xs text-red-500 font-semibold">{solarHoliday || lunarHoliday}</span>}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {rawIsAdmin && (
              <button
                onClick={onToggleMode}
                title={isAdmin ? "Admin mode — Bấm để xem chế độ nhân viên" : "Nhân viên mode — Bấm để xem chế độ admin"}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-medium transition-all ${isAdmin ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400" : "border-orange-300 bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400"}`}
              >
                {isAdmin ? <ShieldCheck className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {isAdmin ? "Admin" : "NV"}
              </button>
            )}
            <button onClick={onPrevDay} className="p-2 rounded-lg hover:bg-muted transition-colors"><ChevronLeft className="w-4 h-4" /></button>
            <button onClick={onNextDay} className="p-2 rounded-lg hover:bg-muted transition-colors"><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>
        {/* Density toggle */}
        <div className="px-4 pb-2 flex items-center gap-2">
          <DensityToggle />
        </div>
      </div>

      {/* Lịch 24h — tóm tắt (chi tiết trong timeline bên dưới) */}
      {!isLoading && bookings.length > 0 && (
        <div className="flex-shrink-0 border-b bg-muted/10 px-3 sm:px-4 py-2 flex items-center justify-between gap-2">
          <p className="text-xs sm:text-sm text-muted-foreground font-semibold">
            {bookings.length} show · Cuộn xuống xem theo giờ
          </p>
          <button
            type="button"
            onClick={() => onTimeClick(bookings.slice().sort((a, b) => (a.shootTime ?? "").localeCompare(b.shootTime ?? ""))[0]?.shootTime?.slice(0, 5) || "07:00")}
            className="text-xs font-bold text-primary px-2.5 py-1.5 rounded-lg border border-primary/40 bg-primary/5 hover:bg-primary/10 touch-manipulation flex-shrink-0"
          >
            + Tạo show
          </button>
        </div>
      )}

      {/* 24h Timeline — flow-based, rows auto-expand to fit content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto pb-24">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Đang tải...</div>
        ) : (
          <div className="flex flex-col">
            {hours.map(h => {
              const hourBookings = bookingsByHour.get(h) ?? [];
              const hasBookings = hourBookings.length > 0;
              const isCurrentHour = isToday_ && h === nowHour;
              const timeLabel = `${String(h).padStart(2, "0")}:00`;

              return (
                <div
                  key={h}
                  data-hour={h}
                  className="group flex border-b border-border/40 min-h-[44px] cursor-pointer hover:bg-primary/5 transition-colors"
                  onClick={() => onTimeClick(`${String(h).padStart(2, "0")}:00`)}
                >
                  {/* Cột trái: nhãn giờ */}
                  <div className="w-14 flex-shrink-0 text-right pr-3 pt-2 select-none">
                    <span className="text-xs text-muted-foreground/70 font-medium">
                      {timeLabel}
                    </span>
                  </div>

                  {/* Cột phải: booking area + current time indicator */}
                  <div className="flex-1 min-w-0">
                    {/* Đường giờ hiện tại — trong đúng row */}
                    {isCurrentHour && (
                      <div className="flex items-center w-full pointer-events-none pt-0.5 pb-1">
                        <div className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                        <div className="flex-1 h-0.5 bg-red-500" />
                      </div>
                    )}

                    {/* Booking cards */}
                    {hasBookings && (
                      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-1.5 p-1 items-stretch content-start">
                        {hourBookings.map(b => {
                          const { dot: staffDot } = getStaffColors(b, allStaff);
                          const item = b.items?.[0];
                          const { p: photoDisplay, m: makeupDisplay, sale: saleDisplay, v: videoDisplay, extras: timelineExtras, unassigned } = getStaffLine(b, item);
                          const hasPhoto = !!photoDisplay;
                          const hasMakeup = !!makeupDisplay;
                          const hasSale = !!saleDisplay;
                          const hasVideo = !!videoDisplay;
                          // Đủ nhân sự khi: có cả nhiếp ảnh + makeup, HOẶC có quay phim (gói quay phim không cần makeup).
                          const isFullyAssigned = (hasPhoto && hasMakeup) || hasVideo;
                          const isAssigned = !unassigned;
                          const serviceName = getServiceDetailLine(b, item);
                          const groupName = b.servicePackageId ? pkgGroupMap?.get(b.servicePackageId) : undefined;
                          const isHighlighted = highlightedBookingId === b.id;
                          const isVip = isPriorityRank(b.customerRank);

                          const isPartOfMerged = b.isParentContract || !!b.parentId;
                          const avatarUrl = b.customerId ? customerAvatarMap.get(b.customerId) : undefined;
                          const dateLabel = b.shootDate
                            ? new Date(b.shootDate).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" })
                            : "";
                          const timeLabelCard = formatBookingDuration(b.shootTime, b.shootDuration) ?? b.shootTime?.slice(0, 5) ?? "";
                          const noteText = item?.notes || b.notes;

                          return (
                            <button
                              key={b._occKey ?? b.id}
                              onClick={e => { e.stopPropagation(); onEventClick(b); }}
                              className={`w-full sm:flex-[1_1_250px] sm:min-w-[230px] sm:max-w-[min(100%,360px)] rounded-xl px-2 py-2 sm:px-2.5 text-left shadow-sm hover:shadow-md transition-all border border-l-4 text-foreground touch-manipulation ${b.status === "temp_quote" ? "bg-purple-50 border-purple-300 hover:bg-purple-100/70" : "bg-card hover:bg-muted/30"} ${isHighlighted ? "ring-2 ring-offset-1 ring-primary animate-pulse" : isVip ? "ring-1 ring-amber-300/60" : ""}`}
                              style={{ borderLeftColor: staffDot }}
                            >
                              <div className="flex gap-2 items-start">
                                {/* Cột ngày/giờ — khối nổi bật, canh giữa dọc card */}
                                <div className="flex flex-col items-center justify-center self-stretch flex-shrink-0 w-[68px] px-1 py-1.5 rounded-lg bg-primary/5 border border-primary/15 text-center leading-tight">
                                  {dateLabel && (
                                    <span className="text-[11px] font-extrabold text-foreground tabular-nums whitespace-nowrap">{dateLabel}</span>
                                  )}
                                  <span className="text-lg sm:text-xl font-black tabular-nums text-primary leading-none mt-1">{timeLabelCard}</span>
                                </div>

                                {/* Avatar — luôn hiện */}
                                {avatarUrl ? (
                                  <img
                                    src={avatarUrl}
                                    alt={b.customerName || "avatar"}
                                    className="w-9 h-9 sm:w-10 sm:h-10 rounded-full object-cover border border-border flex-shrink-0"
                                  />
                                ) : (
                                  <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-muted border border-border flex items-center justify-center flex-shrink-0">
                                    <User className="w-4 h-4 text-muted-foreground" />
                                  </div>
                                )}

                                <div className="flex-1 min-w-0">
                                  {/* Tên + VIP + mã đơn */}
                                  <div className="flex items-start justify-between gap-1 mb-0.5">
                                    <div className="flex items-center gap-1 min-w-0 flex-wrap">
                                      <span className="font-bold text-sm leading-tight break-words">{b.customerName || "(Chưa có tên)"}</span>
                                      {isVip && <Crown className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />}
                                      {b.customerRank && b.customerRank !== "new" && <RankBadge rank={b.customerRank} size="xs" />}
                                      {isPartOfMerged && (
                                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-blue-400 text-blue-700 bg-blue-50 whitespace-nowrap">
                                          HĐ gộp
                                        </span>
                                      )}
                                      {b.status === "temp_quote" && (
                                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-purple-400 text-purple-800 bg-purple-100 whitespace-nowrap">
                                          🧮 Báo giá tạm
                                        </span>
                                      )}
                                      {b._occLabel && (
                                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-blue-400 text-blue-700 bg-blue-50 whitespace-nowrap">
                                          📅 {b._occLabel}
                                        </span>
                                      )}
                                    </div>
                                    {b.orderCode && (
                                      <span className="text-[9px] font-mono font-bold text-muted-foreground bg-muted px-1.5 py-0.5 rounded flex-shrink-0">
                                        {b.orderCode}
                                      </span>
                                    )}
                                  </div>

                                  {/* SĐT */}
                                  {b.customerPhone && (
                                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground mb-0.5">
                                      <Phone className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                                      <span className="font-medium tabular-nums">{b.customerPhone}</span>
                                    </div>
                                  )}

                                  {/* Dịch vụ */}
                                  <div className="flex items-start gap-1 text-[10px] sm:text-[11px] font-medium text-foreground mb-0.5">
                                    <Package2 className="w-3 h-3 flex-shrink-0 mt-0.5" />
                                    <span className="break-words leading-snug">{groupName ? `${groupName} · ${serviceName}` : serviceName}</span>
                                  </div>

                                  {/* Ghi chú */}
                                  {noteText && (
                                    <div className="text-[10px] text-foreground border border-amber-300 bg-amber-50/50 rounded px-1.5 py-0.5 mb-0.5 break-words leading-snug">
                                      📝 {noteText}
                                    </div>
                                  )}

                                  {/* Địa điểm */}
                                  {b.location && (
                                    <div className="flex items-center gap-0.5 text-[10px] text-muted-foreground mb-0.5 truncate">
                                      <MapPin className="w-3 h-3 flex-shrink-0" />{b.location}
                                    </div>
                                  )}

                                  {/* Nhân sự */}
                                  <div className="flex flex-wrap gap-0.5 text-[10px] mt-0.5">
                                    {isAssigned ? (
                                      <>
                                        {hasPhoto && (
                                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-sky-300 text-foreground font-medium">
                                            <Camera className="w-2.5 h-2.5 text-sky-500" />Nhiếp ảnh: {photoDisplay}
                                          </span>
                                        )}
                                        {hasMakeup && (
                                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-pink-300 text-foreground font-medium">
                                            <Sparkles className="w-2.5 h-2.5 text-pink-500" />Makeup: {makeupDisplay}
                                          </span>
                                        )}
                                        {hasVideo && (
                                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-300 text-foreground font-medium">
                                            🎬 Quay phim: {videoDisplay}
                                          </span>
                                        )}
                                        {hasSale && (
                                          <span className="px-1.5 py-0.5 rounded border border-violet-300 text-foreground font-medium">
                                            Sale: {saleDisplay}
                                          </span>
                                        )}
                                        {timelineExtras.map(ex => (
                                          <span key={ex} className="px-1 py-0.5 rounded border border-blue-200 text-foreground font-semibold text-[9px]">
                                            {ex}
                                          </span>
                                        ))}
                                        {!isFullyAssigned && (
                                          <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded border border-red-300 text-red-600 font-semibold">
                                            <AlertCircle className="w-2.5 h-2.5" />Thiếu
                                          </span>
                                        )}
                                      </>
                                    ) : (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full font-semibold border border-red-300 text-red-600 dark:text-red-400">
                                        <AlertCircle className="w-2.5 h-2.5" />Chưa giao việc
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {(() => {
                                  const thumbs = collectConceptImageUrls(item?.conceptImages, item?.serviceImages, item?.attachedImages, item?.images, item?.gallery).slice(0, 2);
                                  return thumbs.length > 0 ? (
                                    <div className="flex gap-1 self-start flex-shrink-0">
                                      {thumbs.map((src, idx) => (
                                        <button
                                          key={src}
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); setPreviewImg(src); }}
                                          className="relative w-10 h-10 sm:w-12 sm:h-12 rounded-lg overflow-hidden border border-border bg-muted shrink-0"
                                          title={`Concept ${idx + 1}`}
                                        >
                                          <ConceptImage src={src} alt={`concept ${idx + 1}`} className="w-full h-full object-cover" />
                                        </button>
                                      ))}
                                    </div>
                                  ) : null;
                                })()}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {!hasBookings && (
                      <div className="px-2 py-1.5 text-[10px] text-muted-foreground/60">
                        Bấm tạo show · {timeLabel}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* FAB — create show */}
      <div className="absolute bottom-20 right-4 sm:bottom-6 sm:right-6 z-30">
        <button
          onClick={() => onTimeClick("07:00")}
          className="w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl flex items-center justify-center transition-all hover:scale-105 active:scale-95"
        >
          <Plus className="w-6 h-6" />
        </button>
      </div>
      {previewImg && (
        <div
          className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-4"
          onClick={() => setPreviewImg(null)}
        >
          <img
            src={previewImg}
            alt="Xem ảnh concept"
            className="max-w-full max-h-full object-contain rounded-xl"
            onClick={e => e.stopPropagation()}
          />
          <button
            onClick={() => setPreviewImg(null)}
            className="absolute top-4 right-4 text-white/70 hover:text-white p-2 rounded-full bg-black/40 hover:bg-black/60 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Main Calendar Page ────────────────────────────────────────────────────────
type CalView = "month" | "week" | "day" | "detail" | "form";

// ─── WeekBookingCard ────────────────────────────────────────────────────────────
function WeekBookingCard({ booking: b, onEventClick, allStaff, pkgGroupMap }: { booking: Booking; onEventClick: (b: Booking) => void; allStaff: Staff[]; pkgGroupMap?: Map<number, string> }) {
  const { dot: staffDot } = getStaffColors(b, allStaff);
  const [density] = useDensity();
  const isComfort = density === "comfortable";

  const item = b.items?.[0];
  const { p: photoDisplay, m: makeupDisplay, sale: saleDisplay, v: videoDisplay, unassigned } = getStaffLine(b, item);
  const hasPhoto = !!photoDisplay;
  const hasMakeup = !!makeupDisplay;
  const hasSale = !!saleDisplay;
  const hasVideo = !!videoDisplay;
  const isAssigned = !unassigned;
  const svcName = getServiceDisplay(b, item);
  const gName = b.servicePackageId ? pkgGroupMap?.get(b.servicePackageId) : undefined;

  return (
    <button
      onClick={e => { e.stopPropagation(); onEventClick(b); }}
      className={`w-full text-left rounded-lg border border-l-4 bg-card text-foreground hover:bg-muted/40 transition-all shadow-sm ${
        isComfort ? "px-2.5 py-2 text-xs sm:text-[13px]" : "px-2 py-1.5 text-[10px]"
      }`}
      style={{ borderLeftColor: staffDot }}
    >
      {/* 1. Giờ + 2. Tên + 3. VIP */}
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span className={`font-black flex-shrink-0 ${isComfort ? "text-sm" : "text-[11px]"}`}>{b.shootTime?.slice(0, 5)}</span>
        {isPriorityRank(b.customerRank) && <Crown className={`${isComfort ? "w-3.5 h-3.5" : "w-2.5 h-2.5"} text-amber-600 flex-shrink-0 self-center`} />}
        <span className={`font-bold ${isComfort ? "text-sm break-words" : "text-xs truncate"}`}>{b.customerName || "(Chưa có tên)"}</span>
      </div>
      {b._occLabel && (
        <div className="text-[9px] font-bold text-blue-600 dark:text-blue-300 leading-tight truncate">📅 {b._occLabel}</div>
      )}
      {b.customerRank && b.customerRank !== "new" && (
        <div className="mt-1"><RankBadge rank={b.customerRank} size="xs" /></div>
      )}
      {/* 4. Dịch vụ — nhóm + tên gói */}
      <div className={`opacity-90 ${isComfort ? "mt-1" : "mt-0.5 text-[10px]"} flex items-center gap-1 flex-wrap`}>
        <span className="truncate">{gName ? `${gName} · ${svcName}` : svcName}</span>
      </div>
      {/* 5. Nhân sự — nếu hoàn toàn chưa giao thì hiện badge đỏ thay cho P:— M:— */}
      {!isAssigned ? (
        <div className={`mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold bg-red-500/15 text-red-600 dark:text-red-400 ${
          isComfort ? "text-[11px]" : "text-[9px]"
        }`}>
          <AlertCircle className={isComfort ? "w-3 h-3" : "w-2.5 h-2.5"} /> Chưa giao việc
        </div>
      ) : (
        <div className={`flex flex-wrap gap-x-2 gap-y-0.5 ${isComfort ? "mt-1 font-medium" : "mt-0.5"}`}>
          {hasPhoto && (
            <span className="flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400">
              <Camera className={isComfort ? "w-3 h-3" : "w-2 h-2"} />P:{photoDisplay}
            </span>
          )}
          {hasMakeup && (
            <span className="flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400">
              <Sparkles className={isComfort ? "w-3 h-3" : "w-2 h-2"} />M:{makeupDisplay}
            </span>
          )}
          {hasVideo && (
            <span className="flex items-center gap-0.5 text-amber-700 dark:text-amber-400">🎬{videoDisplay}</span>
          )}
          {hasSale && (
            <span className="text-foreground/80 font-medium">Sale:{saleDisplay}</span>
          )}
        </div>
      )}
      {/* 6. Còn nợ (badge "Chưa giao việc" đã hiện ở Section 5) */}
      {b.remainingAmount > 0 && (
        <div className={`text-money-debt font-semibold flex items-center gap-1 mt-1 ${isComfort ? "text-[12px]" : "text-[10px]"}`}>
          <AlertCircle className={isComfort ? "w-3 h-3" : "w-2.5 h-2.5"} /> Còn nợ {formatVND(b.remainingAmount)}
        </div>
      )}
    </button>
  );
}

// ─── WeekView ───────────────────────────────────────────────────────────────────
function WeekView({
  weekStart, bookings, isLoading,
  onBack, onPrevWeek, onNextWeek,
  onDayHeaderClick, onEventClick,
  isAdmin, onToggleMode, rawIsAdmin,
  allStaff, pkgGroupMap,
}: {
  weekStart: Date; bookings: Booking[]; isLoading: boolean;
  onBack: () => void; onPrevWeek: () => void; onNextWeek: () => void;
  onDayHeaderClick: (d: Date) => void; onEventClick: (b: Booking) => void;
  isAdmin: boolean; onToggleMode: () => void; rawIsAdmin?: boolean;
  allStaff: Staff[]; pkgGroupMap?: Map<number, string>;
}) {
  const days = eachDayOfInterval({ start: weekStart, end: addDays(weekStart, 6) });
  const DAY_LABELS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  const [weekDensity] = useDensity();

  const bookingsForDay = (d: Date) =>
    bookings
      .flatMap(expandBookingToDayEvents)
      .filter(b => {
        if (b.isParentContract || !b.shootDate) return false;
        const sd = new Date(b.shootDate);
        return !isNaN(sd.getTime()) && isSameDay(sd, d);
      })
      .sort((a, b) => (a.shootTime ?? "").localeCompare(b.shootTime ?? ""));

  const weekLabel = `${format(weekStart, "dd/MM")} – ${format(addDays(weekStart, 6), "dd/MM/yyyy")}`;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      <div className="flex-shrink-0 border-b bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4 text-primary" />
              <span className="font-bold text-base">Tuần: {weekLabel}</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {rawIsAdmin && (
              <button
                onClick={onToggleMode}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-medium transition-all ${
                  isAdmin
                    ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                    : "border-orange-300 bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400"
                }`}
              >
                {isAdmin ? <ShieldCheck className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                {isAdmin ? "Admin" : "NV"}
              </button>
            )}
            <DensityToggle />
            <button onClick={onPrevWeek} className="p-2 rounded-lg hover:bg-muted transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button onClick={onNextWeek} className="p-2 rounded-lg hover:bg-muted transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">Đang tải...</div>
        ) : (
          <div className="flex min-w-max h-full">
            {days.map(day => {
              const dayBookings = bookingsForDay(day);
              const isToday_ = isToday(day);
              const isSun = day.getDay() === 0;
              const label = DAY_LABELS[day.getDay()];

              return (
                <div
                  key={day.toISOString()}
                  className={`flex flex-col border-r border-border/50 flex-shrink-0 ${
                    weekDensity === "comfortable" ? "w-56 sm:w-64" : "w-40 sm:w-44"
                  }`}
                >
                  <button
                    onClick={() => onDayHeaderClick(day)}
                    className={`flex flex-col items-center py-2 px-1 border-b border-border/50 hover:bg-muted/40 transition-colors flex-shrink-0 ${
                      isToday_ ? "bg-primary/5" : ""
                    }`}
                  >
                    <span className={`text-xs font-semibold ${isSun ? "text-red-500" : "text-muted-foreground"}`}>
                      {label}
                    </span>
                    <span className={`text-lg font-bold leading-tight ${
                      isToday_
                        ? "w-8 h-8 flex items-center justify-center rounded-full bg-primary text-primary-foreground"
                        : isSun ? "text-red-500" : "text-foreground"
                    }`}>
                      {format(day, "d")}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60">{format(day, "MM/yyyy")}</span>
                    {dayBookings.length > 0 && (
                      <span className="mt-0.5 text-[10px] font-semibold text-primary">
                        {dayBookings.length} show
                      </span>
                    )}
                  </button>
                  <div className="flex-1 overflow-y-auto p-1 space-y-1">
                    {dayBookings.length === 0 ? (
                      <div className="text-center text-[10px] text-muted-foreground/50 pt-3 italic">Trống</div>
                    ) : (
                      dayBookings.map(b => <WeekBookingCard key={b._occKey ?? b.id} booking={b} onEventClick={onEventClick} allStaff={allStaff} pkgGroupMap={pkgGroupMap} />)
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Error boundary: catches render crashes in CalendarPage, logs stack ────────
interface EBState { hasError: boolean; error: Error | null }
class CalendarErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, EBState> {
  constructor(props: { children: ReactNode; onReset?: () => void }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): EBState {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("CalendarPage crash:", error, "\nComponent stack:", info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
          <p className="text-destructive font-semibold text-base">Đã có lỗi xảy ra, vui lòng tải lại trang.</p>
          <button
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold"
            onClick={() => {
              this.props.onReset?.();
              this.setState({ hasError: false, error: null });
            }}
          >
            Thử lại
          </button>
          {this.state.error && (
            <pre className="text-left text-xs text-muted-foreground bg-muted rounded p-3 max-w-full overflow-auto max-h-48">
              {this.state.error.message}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Zoom UI cho lịch tháng (không dùng pinch zoom) ────────────────────────
// v2: đổi mặc định 60% → 50% (ở 60% lịch bị tràn/cắt trên mobile). Bump key để reset zoom đã lưu
// về mặc định mới 1 lần (zoom cũ lưu ở "calendar-zoom-v1" sẽ bị bỏ qua); chỉnh tay sau vẫn được lưu.
const ZOOM_KEY = "calendar-zoom-v2";
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 1.4;
const ZOOM_STEP = 0.1;
const ZOOM_DEFAULT = 0.5;
function getStoredZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    if (raw === null) return ZOOM_DEFAULT;
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX) return v;
  } catch { /* ignore */ }
  return ZOOM_DEFAULT;
}

function CalendarPageInner() {
  const [zoomLevel, setZoomLevel] = useState<number>(getStoredZoom);
  const zoomIn = () => setZoomLevel(z => {
    const n = Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 10) / 10);
    try { localStorage.setItem(ZOOM_KEY, String(n)); } catch { /* */ }
    return n;
  });
  const zoomOut = () => setZoomLevel(z => {
    const n = Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 10) / 10);
    try { localStorage.setItem(ZOOM_KEY, String(n)); } catch { /* */ }
    return n;
  });
  const zoomReset = () => {
    setZoomLevel(ZOOM_DEFAULT);
    try { localStorage.setItem(ZOOM_KEY, String(ZOOM_DEFAULT)); } catch { /* */ }
  };
  // ── Bù chiều cao cho transform:scale của lưới tháng (UI-only, không đụng
  // logic lịch). transform KHÔNG đổi layout height → zoom < 1 để lại khoảng
  // trắng cao (1−z)×H dưới lưới. Đo natural height qua ResizeObserver
  // (offsetHeight không bị transform ảnh hưởng → không loop) rồi bù
  // margin-bottom = −H×(1−z) để chiều cao layout khớp chiều cao NHÌN THẤY:
  // lưới cần bao nhiêu chiếm bấy nhiêu, nội dung nhiều thì tự giãn/cuộn.
  // Dùng callback ref vì container unmount khi chuyển week/day/form view.
  const [monthGridNaturalH, setMonthGridNaturalH] = useState<number | null>(null);
  const monthGridRO = useRef<ResizeObserver | null>(null);
  const monthGridZoomRef = useCallback((el: HTMLDivElement | null) => {
    monthGridRO.current?.disconnect();
    monthGridRO.current = null;
    if (el && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => setMonthGridNaturalH(el.offsetHeight));
      ro.observe(el);
      monthGridRO.current = ro;
      setMonthGridNaturalH(el.offsetHeight);
    }
  }, []);
  const [calView, setCalView] = useState<CalView>("month");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedTime, setSelectedTime] = useState("07:00");
  const [editingBooking, setEditingBooking] = useState<Booking | null>(null);
  const [editingSiblings, setEditingSiblings] = useState<Booking[]>([]);
  const [viewingBooking, setViewingBooking] = useState<Booking | null>(null);
  const [showLunar, setShowLunar] = useState(true);
  const [prevCalView, setPrevCalView] = useState<CalView>("month");
  const [highlightedBookingId, setHighlightedBookingId] = useState<number | null>(null);

  const { effectiveIsAdmin, isAdmin: rawIsAdmin, viewMode, setViewMode } = useStaffAuth();
  const isAdmin = effectiveIsAdmin;
  const toggleAdminMode = () => setViewMode(viewMode === "admin" ? "staff" : "admin");

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: bookingsRaw = [], isLoading, isError: bookingsError } = useQuery<Booking[]>({
    queryKey: ["bookings"],
    // Lịch chụp là nơi duy nhất chủ động xem cả báo giá tạm (hiện nhãn "Báo giá tạm" màu riêng);
    // các trang khác gọi /api/bookings mặc định KHÔNG thấy temp_quote.
    // SỰ CỐ 2026-07-13: API 500 trả {error} mà .then(r => r.json()) nuốt luôn →
    // bookings = object → bookings.flatMap nổ → sập trắng cả /calendar.
    // Fix: !r.ok phải THROW (React Query giữ data mặc định []), tuyệt đối không
    // để non-array lọt vào state.
    queryFn: async () => {
      const r = await authFetch(`${BASE}/api/bookings?includeTempQuotes=1`);
      if (!r.ok) {
        const body = await r.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `Lỗi tải danh sách show (HTTP ${r.status})`);
      }
      const j = await r.json();
      return Array.isArray(j) ? (j as Booking[]) : [];
    },
    staleTime: 0,
  });
  // Chốt chặn cuối: mọi nơi dùng bookings.flatMap/.filter đều được đảm bảo là Array.
  const bookings = Array.isArray(bookingsRaw) ? bookingsRaw : [];

  // Deep-link ?bookingId=N → tự mở detail panel của booking đó. Dùng cho: thông báo, VÀ ô Tìm kiếm
  // thông minh (SmartSearch) — bấm 1 kết quả mở thẳng chi tiết SHOW (không phải trang Đơn hàng).
  // Reactive theo query string (useSearch) nên hoạt động KỂ CẢ khi đang ở sẵn /calendar (component
  // không remount → useState-initializer-1-lần sẽ bỏ sót). Bookings query load TẤT CẢ đơn nên tìm
  // được show ở bất kỳ tháng nào; effect dưới tự canh currentDate về đúng tháng của show.
  const calUrlSearch = useSearch();
  const [pendingBookingIdFromUrl, setPendingBookingIdFromUrl] = useState<number | null>(null);
  useEffect(() => {
    let n: number | null = null;
    try {
      const p = new URLSearchParams(calUrlSearch || window.location.search);
      const v = p.get("bookingId");
      if (v) { const x = Number(v); if (Number.isInteger(x) && x > 0) n = x; }
      // Dọn ?bookingId khỏi URL (kể cả invalid) — tránh mở lại khi reload / cho phép bấm lại cùng show.
      const url = new URL(window.location.href);
      if (url.searchParams.has("bookingId")) {
        url.searchParams.delete("bookingId");
        window.history.replaceState({}, "", url.toString());
      }
    } catch { /* ignore */ }
    if (n != null) setPendingBookingIdFromUrl(n);
  }, [calUrlSearch]);
  useEffect(() => {
    if (pendingBookingIdFromUrl == null) return;
    if (!bookings || bookings.length === 0) return;
    const b = bookings.find(x => x.id === pendingBookingIdFromUrl);
    setPendingBookingIdFromUrl(null); // chỉ thử 1 lần — không tìm thấy thì thôi
    if (!b) return;
    // Mở detail panel + canh ngày để back về tháng/tuần đúng
    if (b.shootDate) {
      const d = new Date(b.shootDate);
      if (!isNaN(d.getTime())) {
        setSelectedDate(d);
        setCurrentDate(d);
      }
    }
    setPrevCalView("month");
    setViewingBooking(b);
    setCalView("detail");
  }, [bookings, pendingBookingIdFromUrl]);

  const { data: allStaff = [] } = useQuery<Staff[]>({
    queryKey: ["staff-assignable"],
    queryFn: () => authFetch(`${BASE}/api/staff/assignable`).then(r => r.ok ? r.json() : []),
    staleTime: 30_000,
  });

  const { data: svcPackagesForMap = [] } = useQuery<{ id: number; groupId: number | null }[]>({
    queryKey: ["service-packages-map"],
    queryFn: () => authFetch(`${BASE}/api/service-packages`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []),
    staleTime: 300_000,
  });
  const { data: svcGroupsForMap = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["service-groups-map"],
    queryFn: () => authFetch(`${BASE}/api/service-groups`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []),
    staleTime: 300_000,
  });
  const pkgGroupMap = useMemo(() => {
    const groupById = new Map<number, string>();
    for (const g of svcGroupsForMap) groupById.set(g.id, g.name);
    const m = new Map<number, string>();
    for (const p of svcPackagesForMap) {
      if (p.groupId && groupById.has(p.groupId)) m.set(p.id, groupById.get(p.groupId)!);
    }
    return m;
  }, [svcPackagesForMap, svcGroupsForMap]);

  // Admin can recolor all staff (active + inactive); non-admin uses active-only list.
  // Dùng /api/staff/lite (id, name, roles, isActive, color) — KHÔNG kéo /api/staff full
  // vì bản full chứa ảnh base64 ~2MB làm mobile khựng lúc mở lịch.
  const { data: allStaffForPicker = [] } = useQuery<Staff[]>({
    queryKey: ["all-staff-for-color-picker"],
    queryFn: () => authFetch(`${BASE}/api/staff/lite`).then(r => r.ok ? r.json() : []),
    staleTime: 5 * 60_000,
    enabled: rawIsAdmin,
  });

  const { data: viewer } = useQuery<{ id: number; name: string; role: string } | null>({
    queryKey: ["viewer"],
    queryFn: () => authFetch(`${BASE}/api/auth/me`).then(r => r.ok ? r.json() : null),
    staleTime: 60_000,
  });

  // ── Leave overlay (Xin nghỉ / Off) — source RIÊNG, không ảnh hưởng bookings ──
  const [showLeaves, setShowLeaves] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const v = window.localStorage.getItem("calendar.showLeaves");
    return v === null ? true : v === "1";
  });
  useEffect(() => {
    try { window.localStorage.setItem("calendar.showLeaves", showLeaves ? "1" : "0"); } catch { /* ignore */ }
  }, [showLeaves]);
  const [leaveFormOpen, setLeaveFormOpen] = useState(false);
  const [viewingLeave, setViewingLeave] = useState<LeaveRequest | null>(null);

  const leavesFrom = useMemo(() => format(startOfMonth(currentDate), "yyyy-MM-dd"), [currentDate]);
  const leavesTo = useMemo(() => format(endOfMonth(currentDate), "yyyy-MM-dd"), [currentDate]);

  // Overlay query — KHÔNG được crash Calendar nếu lỗi/timeout: trả [].
  const { data: leaves = [] } = useQuery<LeaveRequest[]>({
    queryKey: ["leave-requests", "range", leavesFrom, leavesTo],
    queryFn: async () => {
      try {
        const res = await authFetch(`${BASE}/api/leave-requests?from=${leavesFrom}&to=${leavesTo}`);
        if (!res.ok) return [];
        const j = await res.json().catch(() => []);
        return Array.isArray(j) ? (j as LeaveRequest[]) : [];
      } catch { return []; }
    },
    enabled: showLeaves,
    staleTime: 30_000,
    retry: false,
    throwOnError: false,
  });

  const leavesByDate = useMemo(() => {
    const m = new Map<string, LeaveRequest[]>();
    if (!showLeaves || leaves.length === 0) return m;
    for (const lv of leaves) {
      try {
        const s = parseISO(lv.startDate);
        const e = parseISO(lv.endDate);
        if (isNaN(s.getTime()) || isNaN(e.getTime())) continue;
        for (const d of eachDayOfInterval({ start: s, end: e })) {
          const key = format(d, "yyyy-MM-dd");
          const arr = m.get(key) ?? [];
          arr.push(lv);
          m.set(key, arr);
        }
      } catch { /* skip bad row, không crash overlay */ }
    }
    return m;
  }, [leaves, showLeaves]);
  const getLeavesForDay = useCallback(
    (date: Date) => (showLeaves ? (leavesByDate.get(format(date, "yyyy-MM-dd")) ?? []) : []),
    [leavesByDate, showLeaves]
  );

  // ── Cảnh báo lấy/trả váy (source RIÊNG kiểu leaves, không đụng bookings[]/tiền) ──
  // Chỉ đơn dùng gói có bật nút gạt "warn_upcoming_show" mới có (lọc ở backend).
  const { data: dressWarnRows = [] } = useQuery<DressWarnRow[]>({
    queryKey: ["dress-warnings", "range", leavesFrom, leavesTo],
    queryFn: async () => {
      try {
        const res = await authFetch(`${BASE}/api/dress-warnings?from=${leavesFrom}&to=${leavesTo}`);
        if (!res.ok) return [];
        const j = await res.json().catch(() => []);
        return Array.isArray(j) ? (j as DressWarnRow[]) : [];
      } catch { return []; }
    },
    staleTime: 30_000,
    retry: false,
    throwOnError: false,
  });
  const warningsByDate = useMemo(
    () => buildDressWarningsByDate(dressWarnRows, format(new Date(), "yyyy-MM-dd")),
    [dressWarnRows],
  );
  const getWarningsForDay = useCallback(
    (date: Date) => warningsByDate.get(format(date, "yyyy-MM-dd")) ?? [],
    [warningsByDate],
  );
  const refreshLeaves = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["leave-requests"] });
  }, [queryClient]);

  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [selectedStaffForColor, setSelectedStaffForColor] = useState<number | null>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  // Mobile (<sm): nhóm công cụ phụ mặc định THU GỌN để lịch chiếm tối đa màn hình,
  // bấm "Tuỳ chọn ▾" mới xổ ra. Desktop (≥sm) luôn hiện đủ như cũ — UI-only, không đổi logic.
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);

  useEffect(() => {
    if (!colorPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerOpen(false);
        setSelectedStaffForColor(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [colorPickerOpen]);

  const handleColorChange = async (staffId: number, colorKey: string) => {
    const updater = (old: Staff[] | undefined) =>
      old ? old.map(s => s.id === staffId ? { ...s, color: colorKey } : s) : old;
    queryClient.setQueryData<Staff[]>(["staff-assignable"], updater);
    queryClient.setQueryData<Staff[]>(["all-staff-for-color-picker"], updater);
    await authFetch(`${BASE}/api/staff/${staffId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: colorKey }),
    });
  };

  const handleAutoAssignColors = async () => {
    const sorted = [...allStaffForPicker].sort((a, b) => a.id - b.id);
    const assignments = sorted.map((s, idx) => ({
      id: s.id,
      color: STAFF_PALETTE[idx % STAFF_PALETTE.length].key as string,
    }));
    // Optimistic update — cập nhật UI ngay lập tức
    const updater = (old: Staff[] | undefined) =>
      old ? old.map(s => {
        const a = assignments.find(x => x.id === s.id);
        return a ? { ...s, color: a.color } : s;
      }) : old;
    queryClient.setQueryData<Staff[]>(["staff-assignable"], updater);
    queryClient.setQueryData<Staff[]>(["all-staff-for-color-picker"], updater);
    // Sequential API calls — lần lượt từng người
    try {
      for (const { id, color } of assignments) {
        const res = await authFetch(`${BASE}/api/staff/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ color }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      toast({ title: "Đã đặt màu tự động cho tất cả nhân viên" });
    } catch {
      toast({ title: "Lỗi khi đặt màu tự động", variant: "destructive" });
    }
  };

  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const firstDayOfMonth = (monthStart.getDay() + 6) % 7;

  const monthLunar = useMemo(() => convertSolarToLunar(1, currentDate.getMonth() + 1, currentDate.getFullYear()), [currentDate]);
  const weekStart = useMemo(() => startOfWeek(selectedDate, { weekStartsOn: 1 }), [selectedDate]);

  const getBookingsForDay = useCallback(
    (date: Date) => bookings.flatMap(expandBookingToDayEvents).filter(b => {
      if (b.isParentContract) return false;
      if (!b.shootDate) return false;
      const d = new Date(b.shootDate);
      return !isNaN(d.getTime()) && isSameDay(d, date);
    }),
    [bookings]
  );

  const selectedBookings = getBookingsForDay(selectedDate);
  const monthBookings = bookings.flatMap(expandBookingToDayEvents).filter(b => {
    if (b.isParentContract) return false;
    if (!b.shootDate) return false;
    const d = new Date(b.shootDate);
    return !isNaN(d.getTime()) && d >= monthStart && d <= monthEnd;
  });

  // Handlers — month view
  const handleDayClick = useCallback((date: Date) => {
    setSelectedDate(date);
    setCurrentDate(date);
    setHighlightedBookingId(null);
    setCalView("day");
  }, []);

  const handleBookingClickFromMonth = useCallback((b: Booking) => {
    const bookingDate = new Date(b.shootDate);
    setSelectedDate(bookingDate);
    setCurrentDate(bookingDate);
    setHighlightedBookingId(b.id);
    setCalView("day");
  }, []);
  // Bấm chip cảnh báo váy → mở đúng đơn (không cần dialog riêng).
  const handleWarningClick = useCallback((bookingId: number) => {
    const b = bookings.find(x => x.id === bookingId);
    if (b) handleBookingClickFromMonth(b);
    // Không thấy trong list (hiếm — data đang refetch): đi đường deep-link ?bookingId.
    else setPendingBookingIdFromUrl(bookingId);
  }, [bookings, handleBookingClickFromMonth]);

  // Handlers — day view
  const handleTimeClick = useCallback((time: string) => {
    setSelectedTime(time);
    setEditingBooking(null);
    setViewingBooking(null);
    setCalView("form");
  }, []);

  // Click event on day → open detail panel
  const handleEventClickFromDay = useCallback((b: Booking) => {
    setPrevCalView("day");
    setViewingBooking(b);
    setSelectedTime(b.shootTime ?? "07:00");
    setCalView("detail");
  }, []);

  // Detail → back
  const handleDetailClose = useCallback(() => {
    setCalView(prevCalView);
    setViewingBooking(null);
  }, [prevCalView]);

  // Detail → edit form (pencil)
  // For merged contracts, parent + siblings are passed in so we route through
  // the multi-service edit flow (PUT each sibling) instead of accidentally
  // POSTing a brand-new parent contract (which used to silently duplicate the
  // entire merged contract on save).
  const handleDetailEdit = useCallback((parent?: Booking, sibs?: Booking[]) => {
    if (!viewingBooking) return;
    if (parent && sibs && sibs.length > 0) {
      setEditingBooking(parent);
      setEditingSiblings(sibs);
      const baseDate = parent.shootDate ? new Date(parent.shootDate) : new Date();
      setSelectedDate(baseDate);
      setCurrentDate(baseDate);
      setSelectedTime(parent.shootTime ?? "08:00");
    } else {
      setEditingBooking(viewingBooking);
      setEditingSiblings([]);
      setSelectedTime(viewingBooking.shootTime ?? "07:00");
    }
    setCalView("form");
  }, [viewingBooking]);

  const handleEditAllSiblings = useCallback((parent: Booking, sibs: Booking[]) => {
    setEditingBooking(parent);
    setEditingSiblings(sibs);
    setSelectedDate(new Date(parent.shootDate));
    setCurrentDate(new Date(parent.shootDate));
    setSelectedTime(parent.shootTime ?? "08:00");
    setCalView("form");
  }, []);

  // Detail → deleted
  const handleDetailDeleteDone = useCallback(() => {
    setCalView(prevCalView);
    setViewingBooking(null);
    setEditingBooking(null);
  }, [prevCalView]);

  // Week view handlers
  const prevWeek = useCallback(() => {
    const d = addDays(weekStart, -7);
    setSelectedDate(d);
    setCurrentDate(d);
  }, [weekStart]);
  const nextWeek = useCallback(() => {
    const d = addDays(weekStart, 7);
    setSelectedDate(d);
    setCurrentDate(d);
  }, [weekStart]);
  const handleDayClickFromWeek = useCallback((day: Date) => {
    setSelectedDate(day);
    setCurrentDate(day);
    setCalView("day");
  }, []);
  const handleEventClickFromWeek = useCallback((b: Booking) => {
    setPrevCalView("week");
    setViewingBooking(b);
    setCalView("detail");
  }, []);

  const handleBackToMonth = useCallback(() => {
    setCalView("month");
    setPrevCalView("month");
    setEditingBooking(null);
    setViewingBooking(null);
  }, []);

  const handleBackToDay = useCallback(() => {
    setCalView("day");
    setEditingBooking(null);
    setViewingBooking(null);
  }, []);

  const handleFormSaved = useCallback((savedDate?: string) => {
    // Nhảy thẳng tới ngày vừa lưu — đổi ngày chụp xong card phải hiện ngay trước
    // mắt, không bắt người dùng tự lật lịch đi tìm (test mobile: save là thấy).
    if (savedDate && /^\d{4}-\d{2}-\d{2}$/.test(savedDate)) {
      const jump = new Date(`${savedDate}T12:00:00`);
      if (!isNaN(jump.getTime())) setCurrentDate(jump);
    }
    setCalView("day");
    setEditingBooking(null);
    setEditingSiblings([]);
    setViewingBooking(null);
  }, []);

  const prevMonth = () => setCurrentDate(subMonths(currentDate, 1));
  const nextMonth = () => setCurrentDate(addMonths(currentDate, 1));

  // ── Vuốt ngang đổi tháng trên lưới tháng (CHỈ mobile <640px, kiểu Google
  // Calendar). Swipe từng bị tắt vì chạm nhẹ cũng đổi tháng → bật lại với
  // ngưỡng chống vuốt nhầm: |dx| > 50px VÀ |dx| > |dy|×1.5 (đang cuộn dọc
  // thì KHÔNG đổi tháng). Tap vào show card không đủ 50px nên không trigger;
  // dialog/form render qua portal (ngoài container) nên không lọt vào đây.
  const monthSwipeStart = useRef<{ x: number; y: number } | null>(null);
  const onMonthTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    monthSwipeStart.current = e.touches.length === 1
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
      : null;
  };
  const onMonthTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (e.touches.length > 1) monthSwipeStart.current = null; // pinch → huỷ swipe
  };
  const onMonthTouchEnd = (e: ReactTouchEvent<HTMLDivElement>) => {
    const start = monthSwipeStart.current;
    monthSwipeStart.current = null;
    if (!start || window.innerWidth >= 640) return; // desktop/tablet: giữ nguyên
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) <= 50 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    if (dx > 0) prevMonth(); else nextMonth();
  };
  const prevDay = () => { const d = subDays(selectedDate, 1); setSelectedDate(d); setCurrentDate(d); setHighlightedBookingId(null); };
  const nextDay = () => { const d = addDays(selectedDate, 1); setSelectedDate(d); setCurrentDate(d); setHighlightedBookingId(null); };

  // ── DETAIL VIEW (full screen) ──
  if (calView === "detail" && viewingBooking) {
    return (
      <div className="flex flex-col -m-4 sm:-m-6" style={{ height: "calc(100vh - 60px)" }}>
        <ShowDetailPanel
          key={viewingBooking.id}
          booking={viewingBooking}
          onClose={handleDetailClose}
          onEdit={handleDetailEdit}
          onDeleteDone={handleDetailDeleteDone}
          isAdmin={isAdmin}
          onNavigate={(sib) => setViewingBooking(sib)}
          onEditAllSiblings={handleEditAllSiblings}
          viewerId={viewer?.id}
        />
      </div>
    );
  }

  // ── FORM VIEW (full screen) ──
  if (calView === "form") {
    return (
      <div className="flex flex-col -m-4 sm:-m-6" style={{ height: "calc(100vh - 60px)" }}>
        <ShowFormPanel
          key={`${editingBooking?.id ?? "new"}-${format(selectedDate, "yyyy-MM-dd")}-${selectedTime}`}
          date={selectedDate}
          initialTime={selectedTime}
          onDateChange={d => { setSelectedDate(d); setCurrentDate(d); }}
          booking={editingBooking}
          onClose={editingBooking && viewingBooking ? () => { setCalView("detail"); setEditingBooking(null); } : handleBackToDay}
          onSaved={handleFormSaved}
          siblingBookings={[...editingSiblings].sort((a, b) => {
            const sA = parseInt((a.orderCode || "").split("-").pop() || "0") || 0;
            const sB = parseInt((b.orderCode || "").split("-").pop() || "0") || 0;
            if (sA !== sB) return sA - sB;
            return (a.shootDate || "").localeCompare(b.shootDate || "");
          })}
          isAdmin={isAdmin}
          viewerId={viewer?.id}
        />
      </div>
    );
  }

  // ── WEEK VIEW (full screen) ──
  if (calView === "week") {
    return (
      <div className="flex flex-col -m-4 sm:-m-6 relative" style={{ height: "calc(100vh - 60px)" }}>
        <WeekView
          weekStart={weekStart}
          bookings={bookings}
          isLoading={isLoading}
          onBack={handleBackToMonth}
          onPrevWeek={prevWeek}
          onNextWeek={nextWeek}
          onDayHeaderClick={handleDayClickFromWeek}
          onEventClick={handleEventClickFromWeek}
          isAdmin={isAdmin}
          onToggleMode={toggleAdminMode}
          rawIsAdmin={rawIsAdmin}
          allStaff={allStaff}
          pkgGroupMap={pkgGroupMap}
        />
      </div>
    );
  }

  // ── DAY VIEW (full screen) ──
  if (calView === "day") {
    return (
      <div className="flex flex-col -m-4 sm:-m-6 relative" style={{ height: "calc(100vh - 60px)" }}>
        <DayView
          date={selectedDate}
          bookings={selectedBookings}
          isLoading={isLoading}
          onBack={handleBackToMonth}
          onPrevDay={prevDay}
          onNextDay={nextDay}
          onTimeClick={handleTimeClick}
          onEventClick={handleEventClickFromDay}
          isAdmin={isAdmin}
          onToggleMode={toggleAdminMode}
          rawIsAdmin={rawIsAdmin}
          allStaff={allStaff}
          highlightedBookingId={highlightedBookingId}
          pkgGroupMap={pkgGroupMap}
        />
      </div>
    );
  }

  // ── MONTH VIEW (full screen) ──
  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>
      {/* API bookings lỗi (vd DB chưa migrate) → báo RÕ thay vì lịch trống im lặng / sập trắng. */}
      {bookingsError && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/20 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300 flex items-center justify-between gap-2 flex-wrap">
          <span>Không tải được danh sách show (lỗi máy chủ). Lịch đang hiển thị thiếu — thử tải lại; nếu vẫn lỗi, báo quản trị kiểm tra server/migration.</span>
          <button type="button" className="px-2 py-1 rounded-md border border-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 text-xs font-medium"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["bookings"] })}>Thử lại</button>
        </div>
      )}
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        {/* Khối tiêu đề riêng — chỉ desktop; mobile dùng tiêu đề gọn nằm chung hàng công cụ (bên dưới). */}
        <div className="hidden sm:block">
          <h1 className="text-2xl font-bold tracking-tight leading-tight">Lịch Chụp</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {new Set(monthBookings.map(b => b.id)).size} show tháng này · Bấm ngày để xem lịch 24h
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto">
          {/* Mobile: tiêu đề "Lịch Chụp" nằm chung hàng với Tháng/Tuần để tiết kiệm chiều cao (ẩn trên desktop). */}
          <span className="sm:hidden text-lg font-bold tracking-tight mr-0.5">Lịch Chụp</span>
          {/* View tabs: Tháng / Tuần */}
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5 bg-muted/30">
            <button
              onClick={() => setCalView("month")}
              className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                calView === "month" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >Tháng</button>
            <button
              onClick={() => setCalView("week")}
              className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                (calView as CalView) === "week" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >Tuần</button>
          </div>
          {/* Mobile: nút thu gọn/mở rộng công cụ phụ — ẩn hẳn trên desktop (sm:hidden) */}
          <button
            type="button"
            onClick={() => {
              if (mobileToolsOpen) { setColorPickerOpen(false); setSelectedStaffForColor(null); }
              setMobileToolsOpen(!mobileToolsOpen);
            }}
            aria-expanded={mobileToolsOpen}
            aria-controls="calendar-mobile-tools"
            className={`sm:hidden ml-auto flex items-center gap-1 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
              mobileToolsOpen ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {mobileToolsOpen ? "Thu gọn" : "Tuỳ chọn"}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${mobileToolsOpen ? "rotate-180" : ""}`} />
          </button>
          {/* Công cụ phụ: mobile mặc định ẩn (hidden), mở qua nút Tuỳ chọn; desktop luôn hiện
              (sm:contents = bỏ hộp wrapper, các nút vẫn là flex-item trực tiếp như cũ). */}
          <div
            id="calendar-mobile-tools"
            className={mobileToolsOpen ? "contents" : "hidden sm:contents"}
          >
          <DensityToggle />
          <button
            onClick={() => setShowLunar(!showLunar)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${showLunar ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}
          >
            <Moon className="w-3.5 h-3.5" /> Âm lịch
          </button>
          {/* Màu lịch — bảng màu nhân viên sale */}
          <div className="relative" ref={colorPickerRef}>
            <button
              onClick={() => { setColorPickerOpen(!colorPickerOpen); setSelectedStaffForColor(null); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${
                colorPickerOpen ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"
              }`}
            >
              <Palette className="w-3.5 h-3.5" /> Màu lịch
            </button>
            {colorPickerOpen && (
              <div className="absolute top-full right-0 mt-1 z-50 bg-card border border-border rounded-xl shadow-lg p-3 w-64">
                <p className="text-xs font-semibold text-muted-foreground mb-1">
                  Màu nhân viên Sale trên lịch{!rawIsAdmin && <span className="ml-1 font-normal text-muted-foreground/60">(chỉ xem)</span>}
                </p>
                {rawIsAdmin && (
                  <button
                    onClick={handleAutoAssignColors}
                    title="Gán mỗi nhân viên một màu riêng biệt tự động theo thứ tự"
                    className="w-full text-left text-[11px] text-primary/70 hover:text-primary underline mb-2 leading-tight"
                  >
                    Đặt màu tự động
                  </button>
                )}
                <div className="space-y-0.5 max-h-72 overflow-y-auto">
                  {rawIsAdmin ? (
                    // Admin: full picker — expand palette để đổi màu
                    allStaffForPicker.map(s => {
                      const pal = s.color
                        ? (STAFF_PALETTE.find(p => p.key === s.color) ?? STAFF_PALETTE[s.id % STAFF_PALETTE.length])
                        : STAFF_PALETTE[s.id % STAFF_PALETTE.length];
                      const isExpanded = selectedStaffForColor === s.id;
                      return (
                        <div key={s.id}>
                          <button
                            onClick={() => setSelectedStaffForColor(isExpanded ? null : s.id)}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted transition-colors text-left"
                          >
                            <span className="w-3.5 h-3.5 rounded-full flex-shrink-0 border border-white/50 shadow-sm" style={{ backgroundColor: pal.dot }} />
                            <span className="text-sm font-medium truncate flex-1">{s.name}</span>
                            <ChevronDown className={`w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                          </button>
                          {isExpanded && (
                            <div className="flex flex-wrap gap-1.5 px-2 pb-2 pt-1 ml-3">
                              {STAFF_PALETTE.map(p => (
                                <button
                                  key={p.key}
                                  onClick={() => { handleColorChange(s.id, p.key); setSelectedStaffForColor(null); }}
                                  title={p.key}
                                  className={`w-7 h-7 rounded-full flex-shrink-0 border-2 transition-transform hover:scale-110 active:scale-95 ${
                                    s.color === p.key ? "border-foreground scale-110" : "border-transparent hover:border-muted-foreground/40"
                                  }`}
                                  style={{ backgroundColor: p.dot }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    // Non-admin: read-only legend — chấm màu + tên, không expand palette
                    allStaff.map(s => {
                      const pal = s.color
                        ? (STAFF_PALETTE.find(p => p.key === s.color) ?? STAFF_PALETTE[s.id % STAFF_PALETTE.length])
                        : STAFF_PALETTE[s.id % STAFF_PALETTE.length];
                      return (
                        <div key={s.id} className="flex items-center gap-2 px-2 py-1.5">
                          <span className="w-3.5 h-3.5 rounded-full flex-shrink-0 border border-white/50 shadow-sm" style={{ backgroundColor: pal.dot }} />
                          <span className="text-sm font-medium truncate">{s.name}</span>
                        </div>
                      );
                    })
                  )}
                  {(rawIsAdmin ? allStaffForPicker : allStaff).length === 0 && (
                    <p className="text-xs text-muted-foreground italic px-2 py-1">Không có nhân viên</p>
                  )}
                </div>
              </div>
            )}
          </div>
          {/* Role toggle — chỉ hiện với tài khoản admin thật */}
          {rawIsAdmin && (
            <button
              onClick={toggleAdminMode}
              title={isAdmin ? "Đang xem chế độ Admin — Bấm để chuyển sang Nhân viên" : "Đang xem chế độ Nhân viên — Bấm để chuyển sang Admin"}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium transition-all ${isAdmin ? "border-emerald-400 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400" : "border-orange-300 bg-orange-50 text-orange-700 dark:bg-orange-900/20 dark:text-orange-400"}`}
            >
              {isAdmin ? <ShieldCheck className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              {isAdmin ? "Admin" : "Nhân viên"}
            </button>
          )}
          <Button onClick={() => { setEditingBooking(null); setViewingBooking(null); setSelectedTime("07:00"); setCalView("form"); }} className="gap-2 h-9">
            <Plus className="w-4 h-4" /> Tạo show
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setLeaveFormOpen(true)}
            className="gap-1.5 h-8"
            title="Tạo đơn xin nghỉ — KHÔNG tạo booking"
          >
            <Coffee className="w-3.5 h-3.5 text-red-500" /> Xin nghỉ / Off
          </Button>
          <label
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium cursor-pointer transition-all ${showLeaves ? "border-red-300 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300" : "border-border text-muted-foreground hover:border-primary/40"}`}
            title="Bật/tắt overlay lịch nghỉ. Tắt → Calendar không fetch overlay."
          >
            <input type="checkbox" className="sr-only" checked={showLeaves} onChange={e => setShowLeaves(e.target.checked)} />
            <Moon className="w-3 h-3" /> Hiện lịch off
          </label>
          </div>
        </div>
      </div>

      {/* Calendar card — mobile: bảng lịch khoá ngang (fit khung, chỉ cuộn dọc),
          vuốt ngang = chuyển tháng (có ngưỡng chống vuốt nhầm — xem onMonthTouch*). */}
      <div
        className="bg-card rounded-2xl border shadow-sm overflow-hidden flex flex-col"
        style={{ maxHeight: "calc(100svh - 160px)" }}
      >
        {/* Month nav — mobile: 1 hàng gọn (tên tháng trái + điều hướng phải), zoom ẩn; desktop giữ nguyên. */}
        <div className="flex flex-row items-center justify-between gap-2 px-3 py-2 border-b bg-gradient-to-r from-card to-muted/10 flex-shrink-0 sm:px-4 sm:py-3 sm:gap-4">
          {/* Tiêu đề tháng (hero) + âm lịch (phụ đề) */}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sun className="w-4 h-4 text-orange-400 flex-shrink-0" />
              <span className="text-lg font-bold capitalize truncate">{format(currentDate, "MMMM yyyy", { locale: vi })}</span>
            </div>
            {showLunar && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <Moon className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                <span className="truncate">{getLunarMonthName(monthLunar.month, monthLunar.leap)} {getCanChi(monthLunar.year)} ({monthLunar.year})</span>
              </p>
            )}
          </div>
          {/* Hàng điều khiển: cụm chuyển tháng (chính, trái) + cụm zoom (phụ, phải) — dạng segmented pill */}
          <div className="flex items-center justify-between gap-2 flex-shrink-0 sm:justify-end">
            {/* Chuyển tháng: ◀ | Hôm nay | ▶ */}
            <div className="inline-flex items-center rounded-lg border bg-background overflow-hidden">
              <button onClick={prevMonth} className="w-8 h-8 hover:bg-muted flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground" aria-label="Tháng trước"><ChevronLeft className="w-4 h-4" /></button>
              <button
                onClick={() => { const t = new Date(); setCurrentDate(t); setSelectedDate(t); }}
                className="px-3 h-8 text-sm font-medium hover:bg-muted transition-colors border-l border-r border-border"
              >Hôm nay</button>
              <button onClick={nextMonth} className="w-8 h-8 hover:bg-muted flex items-center justify-center transition-colors text-muted-foreground hover:text-foreground" aria-label="Tháng sau"><ChevronRight className="w-4 h-4" /></button>
            </div>
            {/* Zoom: − | NN% | + — ẩn trên mobile (lịch đã fit khung ở mức mặc định), chỉ hiện desktop */}
            <div className="hidden sm:inline-flex items-center rounded-lg border bg-background overflow-hidden" title={`Zoom ${Math.round(zoomLevel * 100)}%`}>
              <button onClick={zoomOut} disabled={zoomLevel <= ZOOM_MIN + 0.001} className="w-8 h-8 hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center transition-colors" aria-label="Thu nhỏ lịch"><ZoomOut className="w-3.5 h-3.5" /></button>
              <button onClick={zoomReset} className="px-2 h-8 text-[11px] font-semibold tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground transition-colors min-w-[44px] border-l border-r border-border" aria-label="Reset zoom">{Math.round(zoomLevel * 100)}%</button>
              <button onClick={zoomIn} disabled={zoomLevel >= ZOOM_MAX - 0.001} className="w-8 h-8 hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center transition-colors" aria-label="Phóng to lịch"><ZoomIn className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        </div>

        {/* Lưới tháng — single scroll container để header thứ + cells luôn align.
            Mobile (<640px): khoá scroll ngang kiểu Google Calendar — bảng lịch
            luôn fit khung 7 cột, CHỈ cuộn dọc (overflow-x-hidden + touch-action
            pan-y); vuốt ngang = chuyển tháng (onMonthTouch*). Đồng thời chặn
            bug WebKit tính scrollable overflow theo width layout (100/zoom%)
            TRƯỚC transform scale → trước đây kéo ngang ra khoảng trắng.
            Desktop/tablet (≥sm): overflow-auto như cũ, không đổi hành vi. */}
        <div
          className="overflow-y-auto overflow-x-hidden overscroll-x-none touch-pan-y touch-pinch-zoom sm:overflow-auto sm:overscroll-x-auto sm:touch-auto flex-1 min-h-0"
          onTouchStart={onMonthTouchStart}
          onTouchMove={onMonthTouchMove}
          onTouchEnd={onMonthTouchEnd}
        >
          {/* Scale toàn bộ nội dung (CHỮ + ô + cột + padding) đồng đều bằng
              transform: scale — đảm bảo text shrink/grow cùng layout trên cả
              iOS Safari (CSS `zoom` không scale font ổn định ở 1 số browser).
              Width = 100/z% để nội dung scale-down vẫn lấp đầy chiều ngang.
              min-w-[600px] mobile (chế độ Thoáng) đã BỎ: bảng lịch phải fit
              chiều ngang màn hình, 7 cột chia đều — text dài đã có
              truncate/break-words trong MonthDayCell. */}
          <div
            ref={monthGridZoomRef}
            style={{
              transform: `scale(${zoomLevel})`,
              transformOrigin: "0 0",
              width: `${100 / zoomLevel}%`,
              // Bù phần chiều cao layout dư ra do scale (xem monthGridZoomRef).
              marginBottom: monthGridNaturalH != null
                ? -(monthGridNaturalH * (1 - zoomLevel))
                : undefined,
            }}
          >
            {/* Day-of-week headers (sticky top — luôn nhìn thấy thứ khi cuộn) */}
            <div className="grid grid-cols-7 border-b border-border/50 sticky top-0 bg-card z-10">
              {["T2", "T3", "T4", "T5", "T6", "T7", "CN"].map((d, i) => (
                <div key={d} className={`text-center text-xs font-bold py-2 border-r border-border/50 last:border-r-0 ${i === 5 ? "text-blue-600" : i === 6 ? "text-red-500" : "text-muted-foreground"}`}>{d}</div>
              ))}
            </div>

            <div className="grid grid-cols-7">
              {/* Leading days from prev month */}
              {Array.from({ length: firstDayOfMonth }).map((_, i) => {
                const d = new Date(monthStart); d.setDate(d.getDate() - (firstDayOfMonth - i));
                return <MonthDayCell key={`p${i}`} date={d} bookings={getBookingsForDay(d)} leaves={getLeavesForDay(d)} warnings={getWarningsForDay(d)} isSelected={false} isOtherMonth onDayClick={handleDayClick} onBookingClick={handleBookingClickFromMonth} onLeaveClick={setViewingLeave} onWarningClick={handleWarningClick} allStaff={allStaff} pkgGroupMap={pkgGroupMap} />;
              })}
              {/* Current month days */}
              {daysInMonth.map(day => (
                <MonthDayCell key={day.toISOString()} date={day} bookings={getBookingsForDay(day)}
                  leaves={getLeavesForDay(day)}
                  warnings={getWarningsForDay(day)}
                  onWarningClick={handleWarningClick}
                  isSelected={isSameDay(day, selectedDate)}
                  onDayClick={handleDayClick}
                  onBookingClick={handleBookingClickFromMonth}
                  onLeaveClick={setViewingLeave}
                  allStaff={allStaff}
                  pkgGroupMap={pkgGroupMap}
                />
              ))}
              {/* Trailing days from next month */}
              {Array.from({ length: (7 - ((firstDayOfMonth + daysInMonth.length) % 7)) % 7 }).map((_, i) => {
                const d = new Date(monthEnd); d.setDate(d.getDate() + i + 1);
                return <MonthDayCell key={`n${i}`} date={d} bookings={getBookingsForDay(d)} leaves={getLeavesForDay(d)} warnings={getWarningsForDay(d)} isSelected={false} isOtherMonth onDayClick={handleDayClick} onBookingClick={handleBookingClickFromMonth} onLeaveClick={setViewingLeave} onWarningClick={handleWarningClick} allStaff={allStaff} pkgGroupMap={pkgGroupMap} />;
              })}
            </div>
          </div>
        </div>

        {/* Footer legend */}
        <div className="px-4 py-2 border-t bg-muted/20 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
          {showLunar && (
            <>
              <span className="flex items-center gap-1"><Moon className="w-3 h-3 text-indigo-400" /> Âm lịch</span>
              <span className="flex items-center gap-1">✦ Tiết khí</span>
              <span className="flex items-center gap-1 text-red-500">● Ngày lễ</span>
            </>
          )}
          {/* Staff color legend — staff có booking trong tháng (via getStaffPaletteEntry) */}
          {(() => {
            const staffIds = new Set<number>();
            for (const b of monthBookings) {
              const s = getStaffPaletteEntry(b, allStaff);
              if (s) staffIds.add(s.id);
            }
            const legendStaff = allStaff.filter(s => staffIds.has(s.id));
            if (legendStaff.length === 0) return (
              <span className="flex items-center gap-1 ml-auto text-primary font-medium">Bấm ngày → xem lịch 24h · Bấm giờ → tạo show</span>
            );
            return (
              <div className="flex flex-wrap items-center gap-2 ml-auto">
                {legendStaff.map(s => {
                  const pal = s.color
                    ? (STAFF_PALETTE.find(p => p.key === s.color) ?? STAFF_PALETTE[s.id % STAFF_PALETTE.length])
                    : STAFF_PALETTE[s.id % STAFF_PALETTE.length];
                  return (
                    <span key={s.id} className="flex items-center gap-1 font-medium">
                      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: pal.dot }} />
                      {s.name}
                    </span>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Leave overlay dialogs — state RIÊNG, không dùng setViewingBooking */}
      <LeaveFormDialog
        open={leaveFormOpen}
        onOpenChange={setLeaveFormOpen}
        isAdmin={isAdmin}
        viewerId={viewer?.id}
        allStaff={allStaff}
        onSubmitted={refreshLeaves}
      />
      <LeaveDetailDialog
        leave={viewingLeave}
        onClose={() => setViewingLeave(null)}
        isAdmin={isAdmin}
        canDelete={rawIsAdmin || viewer?.role === "owner" || viewer?.role === "admin"}
        viewerId={viewer?.id}
        viewerName={viewer?.name}
        onChanged={refreshLeaves}
      />
    </div>
  );
}

export default function CalendarPage() {
  const [resetKey, setResetKey] = useState(0);
  return (
    <CalendarErrorBoundary onReset={() => setResetKey(k => k + 1)}>
      <CalendarPageInner key={resetKey} />
    </CalendarErrorBoundary>
  );
}
