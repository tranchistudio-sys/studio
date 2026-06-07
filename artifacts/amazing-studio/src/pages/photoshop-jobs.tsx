import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, CheckCircle2, AlertTriangle, UserCheck, Camera,
  Clock, User, X, ChevronRight, Loader2, ImageIcon, BarChart3,
  PauseCircle, PlayCircle, Filter, Package, Users,
  Palette, ChevronDown, ChevronUp, Calendar,
  Printer, Link2, Pencil, Plus, Minus
} from "lucide-react";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { getImageSrc } from "@/lib/imageUtils";
import { ConceptImage } from "@/components/ConceptImage";
import { DateInput } from "@/components/ui/date-input";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const token = () => localStorage.getItem("amazingStudioToken_v2");
const authHeaders = () => ({
  "Content-Type": "application/json",
  ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
});
const authFetch = (url: string, opts?: RequestInit) =>
  fetch(`${BASE}${url}`, { headers: authHeaders(), ...opts });

type BookingItem = {
  id?: string;
  label?: string;
  name?: string;
  serviceName?: string;
  serviceLabel?: string;
  packageName?: string;
  quantity?: number;
  unitPrice?: number;
  price?: number;
  totalPrice?: number;
  includedRetouchedPhotos?: number;
  albumName?: string | null;
  rawFilesIncluded?: boolean | null;
  conceptImages?: string[] | null;
  notes?: string | null;
  deductions?: { label: string; amount: number }[];
  packageType?: string;
};

function getChildBookingServiceName(item: BookingItem): string {
  const direct = [item.serviceName, item.serviceLabel, item.packageName, item.packageType, item.label, item.name]
    .map(v => (v ?? "").trim())
    .find(v => v && !/^Dịch vụ\s*\d+\s*$/i.test(v));
  return direct || item.packageName?.trim() || item.serviceName?.trim() || item.serviceLabel?.trim() || item.packageType?.trim() || item.label?.trim() || item.name?.trim() || "";
}

function getServiceLabelText(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "Dịch vụ 1";
  if (/^Dịch vụ\s*\d+\s*$/i.test(v)) return v;
  return v;
}

// Trả về tên dịch vụ thật của 1 booking row trên trang Hậu kỳ.
// Ưu tiên: tên gói thật từ service_packages → tên thật trong booking_items
// → service_label (nếu không phải "Dịch vụ N") → package_type → "—"
function getRowServiceName(row: {
  package_name?: string | null;
  service_label?: string | null;
  package_type?: string | null;
  booking_items?: unknown;
}): string {
  const pkg = (row.package_name ?? "").trim();
  if (pkg) return pkg;
  const items = Array.isArray(row.booking_items) ? (row.booking_items as BookingItem[]) : [];
  for (const it of items) {
    const real = getChildBookingServiceName(it);
    if (real) return real;
  }
  const label = (row.service_label ?? "").trim();
  if (label && !/^Dịch vụ\s*\d+\s*$/i.test(label)) return label;
  const pkgType = (row.package_type ?? "").trim();
  if (pkgType) return pkgType;
  return label || "—";
}

function getOrderDisplay(row: {
  order_code?: string | null;
  service_label?: string | null;
  package_name?: string | null;
  package_type?: string | null;
  booking_items?: unknown;
}): { code: string; service: string; title: string } {
  const code = (row.order_code ?? "").trim() || "—";
  const service = (row.package_name ?? "").trim() || getRowServiceName(row);
  const title = service !== "—" ? `${code} · ${service}` : code;
  return { code, service, title };
}

type BookingSurcharge = {
  id?: string;
  label?: string;
  amount?: number;
  quantity?: number;
  note?: string | null;
};

type AssignedStaffItem = {
  role?: string;
  name?: string;
  staffName?: string;
  staffId?: string | number;
};

type BookingEditRow = {
  booking_id: number;
  order_code: string;
  shoot_date: string;
  booking_created_at: string;
  package_type: string;
  service_label: string;
  package_name?: string | null;
  package_code?: string | null;
  package_price?: number | null;
  package_print_cost?: number | null;
  package_operating_cost?: number | null;
  package_requires_post_production?: boolean | null;
  // Bước 3: nhóm dịch vụ của gói (lấy từ service_groups qua sp.group_id)
  package_group_id?: number | null;
  package_group_name?: string | null;
  customer_id: number | null;
  customer_name: string;
  customer_phone: string;
  customer_avatar: string | null;
  job_id: number | null;
  job_code: string | null;
  status: string | null;
  assigned_staff_id: number | null;
  assigned_staff_name: string | null;
  received_file_date: string | null;
  internal_deadline: string | null;
  customer_deadline: string | null;
  total_photos: number | null;
  done_photos: number | null;
  progress_percent: number | null;
  notes: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  booking_notes: string | null;
  booking_items: unknown;
  booking_surcharges: unknown;
  booking_assigned_staff: unknown;
  booking_concept_images?: string[];
  booking_payments?: Array<{ id: number; amount: number; paidAt: string; paymentType: string; notes: string | null }>;
  included_retouched_photos_snapshot: number | null;
  photoshop_note: string | null;
  extra_retouch_price: number | null;
  extra_photos_requested: number | null;
  deadline_system?: string | null;
  deadlineCode?: "fire" | "red" | "yellow" | "green" | "done" | "paused";
  isOverdue?: boolean;
  progressStatus?: string;
  package_description?: string | null;
  package_notes?: string | null;
  package_items_list?: Array<{
    id: number; name: string; quantity: string; unit?: string | null; notes?: string | null;
  }> | null;
  drive_link?: string | null;
  print_notes?: string | null;
  da_xuat_in?: boolean | null;
  chi_phi_phat_sinh?: number | null;
  mo_ta_phat_sinh?: string | null;
  detail_photos_count?: number | null;
  detail_photos_rate?: number | null;
  party_photos_count?: number | null;
  party_photos_rate?: number | null;
  parent_id?: number | null;
  is_parent_contract?: boolean | null;
  list_section?: "month" | "backlog" | "all" | null;
};

type Stats = { myActive: number; myDoneThisMonth: number; backlog: number; priorBacklog?: number };
type StaffItem = { id: number; name: string; role: string };

type DetailForm = {
  status: string;
  totalPhotos: string;
  donePhotos: string;
  receivedFileDate: string;
  internalDeadline: string;
  customerDeadline: string;
  notes: string;
  assignedStaffId: string;
  assignedStaffName: string;
  photoshopNote: string;
  extraRetouchPrice: string;
  extraPhotosRequested: string;
  driveLink: string;
  printNotes: string;
  daXuatIn: boolean;
  chiPhiPhatSinh: string;
  moTaPhatSinh: string;
  detailPhotosCount: string;
  partyPhotosCount: string;
};

// ── Shared helper: "Chưa nhận" dùng thống nhất ở 3 nơi ─────────────────────
function isUnassigned(row: BookingEditRow): boolean {
  return !row.job_id || !row.assigned_staff_id || row.status === "chua_nhan";
}

// ── Sort priority dựa trên deadlineCode từ backend ────────────────────────────
const DEADLINE_CODE_PRIORITY: Record<string, number> = {
  fire: 10, red: 20, yellow: 30, green: 50, paused: 80, done: 99,
};
function sortPriority(row: BookingEditRow): number {
  const st = row.status ?? "";
  const code = row.deadlineCode ?? (DONE_FE.includes(st) ? "done" : st === "tam_hoan" ? "paused" : "green");
  return DEADLINE_CODE_PRIORITY[code] ?? 50;
}

// ── Urgency dựa trên deadlineCode ─────────────────────────────────────────────
function getCardUrgency(row: BookingEditRow): "fire" | "red" | "yellow" | "done" | "paused" | "normal" {
  const code = row.deadlineCode;
  const st = row.status ?? "";
  if (code === "fire") return "fire";
  if (code === "red") return "red";
  if (code === "yellow") return "yellow";
  if (code === "done" || DONE_FE.includes(st)) return "done";
  if (code === "paused" || st === "tam_hoan") return "paused";
  return "normal";
}

const URGENCY_STYLE: Record<string, string> = {
  fire:   "border-l-4 border-l-orange-500 bg-orange-50/50 dark:bg-orange-900/15",
  red:    "border-l-4 border-l-red-400 bg-red-50/40 dark:bg-red-900/10",
  yellow: "border-l-4 border-l-amber-400 bg-amber-50/40 dark:bg-amber-900/10",
  done:   "border-l-4 border-l-emerald-400 bg-emerald-50/40 dark:bg-emerald-900/10",
  paused: "border-l-4 border-l-purple-300 bg-purple-50/40 dark:bg-purple-900/10",
  normal: "border-l-4 border-l-slate-200 dark:border-l-slate-700 bg-card",
};


const STATUS_LABEL: Record<string, string> = {
  chua_nhan:  "Chưa nhận",
  dang_pts:   "Đang PTS",
  da_pts:     "Đã PTS",
  da_fix:     "Đã fix",
  da_gui_in:  "Đã gửi in",
  xong_show:  "Xong show",
  tam_hoan:   "Tạm hoãn",
  // backward compat
  dang_xu_ly: "Đang làm",
  cho_duyet:  "Chờ duyệt",
  hoan_thanh: "Hoàn thành",
};

const IN_PROGRESS_FE = ["dang_pts", "da_pts", "da_fix", "da_gui_in", "dang_xu_ly", "cho_duyet"];
const DONE_FE = ["xong_show", "hoan_thanh"];

const TABS = [
  { key: "all",       label: "Chưa xong" },
  { key: "mine",      label: "Của tôi" },
  { key: "chua_nhan", label: "Chưa nhận" },
  { key: "dang_pts",  label: "Đang PTS" },
  { key: "da_pts",    label: "Đã PTS" },
  { key: "tam_hoan",  label: "Tạm hoãn" },
  { key: "xong_show", label: "Xong show" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch { return d; }
}

function formatMonth(ym: string): string {
  const [y, m] = ym.split("-");
  return `Tháng ${m}/${y}`;
}

function shortShootMonth(ym: string): string {
  const m = ym.split("-")[1];
  return m ? `T${parseInt(m, 10)}` : ym;
}

function formatVND(n: number | null | undefined): string {
  if (n == null) return "—";
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);
}

function formatVNDShort(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}tr`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

function daysLeft(deadline: string | null | undefined): string {
  if (!deadline) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dl = new Date(deadline);
  const days = Math.ceil((dl.getTime() - today.getTime()) / 86400000);
  if (days < 0) return `Trễ ${Math.abs(days)} ngày`;
  if (days === 0) return "Hôm nay";
  return `Còn ${days} ngày`;
}

// ── Date / service helpers (mirrors backend logic) ────────────────────────────
// Normalize Vietnamese diacritics → lowercase to match service names reliably
function normalizeVietFE(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
function daysForServiceFE(serviceName: string): number {
  const n = normalizeVietFE(serviceName);
  return (n.includes("album") || n.includes("ngoai canh")) ? 15 : 10;
}
// Safe date add: parses YYYY-MM-DD as LOCAL date to avoid UTC midnight drift
function addDaysToStrFE(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// Compute deadline_system from shoot_date (NOT received_file_date — informational only)
function calcSystemDeadlineFE(shootDate: string | null | undefined, serviceName: string): string | null {
  if (!shootDate || shootDate === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shootDate)) return null;
  return addDaysToStrFE(shootDate, daysForServiceFE(serviceName));
}

// ── Deadline bar helpers ───────────────────────────────────────────────────────
// effectiveDeadline: customer_deadline wins when set (it's the agreed-upon date);
// falls back to deadline_system when no customer deadline is entered.
function getEffectiveDeadline(
  deadlineSystem: string | null | undefined,
  customerDeadline: string | null | undefined
): string | null {
  if (customerDeadline && customerDeadline !== "") return customerDeadline;
  return deadlineSystem ?? null;
}

function calcDeadlineBar(
  effectiveDeadline: string | null,
  serviceName: string
): { percent: number; daysRemaining: number } | null {
  if (!effectiveDeadline) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dl = new Date(effectiveDeadline);
  const daysRemaining = Math.ceil((dl.getTime() - today.getTime()) / 86400000);
  const totalDays = daysForServiceFE(serviceName);
  const percent = Math.max(0, Math.min(100, Math.round((daysRemaining / totalDays) * 100)));
  return { percent, daysRemaining };
}

function deadlineBarColor(daysRemaining: number): string {
  if (daysRemaining > 5) return "bg-emerald-500";
  if (daysRemaining >= 4) return "bg-amber-400";
  if (daysRemaining >= 2) return "bg-red-500";
  return "bg-orange-500";
}

function deadlineBarText(daysRemaining: number): string {
  if (daysRemaining > 1) return `Còn ${daysRemaining} ngày`;
  if (daysRemaining >= 0) return "Ngày cuối";
  return `Trễ ${Math.abs(daysRemaining)} ngày`;
}

// Mirror backend calcDeadlineCode — used to update cache immediately after PUT
// Uses effective deadline: customer_deadline wins when set, else deadline_system
function computeDeadlineCodeFE(
  status: string | null,
  deadlineSystem: string | null | undefined,
  customerDeadline: string | null | undefined,
): "fire" | "red" | "yellow" | "green" | "done" | "paused" {
  const today = new Date().toISOString().slice(0, 10);
  if (status && DONE_FE.includes(status)) return "done";
  if (status === "tam_hoan") return "paused";
  const effectiveDl = (customerDeadline && customerDeadline !== "") ? customerDeadline
    : (deadlineSystem || null);
  if (!effectiveDl) return "green";
  if (effectiveDl < today) return "fire";
  const daysToEffective = Math.ceil((new Date(effectiveDl).getTime() - new Date(today).getTime()) / 86400000);
  if (daysToEffective <= 2) return "yellow";
  return "green";
}

function deadlineStatusBadge(daysRemaining: number): { label: string; cls: string } {
  if (daysRemaining > 5) return { label: "🟢 Đúng hạn", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" };
  if (daysRemaining >= 4) return { label: "🟡 Sắp hạn", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400" };
  if (daysRemaining >= 2) return { label: "🔴 Cận hạn", cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" };
  return { label: "🔥 Cháy deadline", cls: "bg-orange-600 text-white" };
}

function parseJson<T>(val: unknown): T | null {
  if (!val) return null;
  if (typeof val === "object") return val as T;
  if (typeof val === "string") {
    try { return JSON.parse(val) as T; } catch { return null; }
  }
  return null;
}

function isPlaceholderServiceLabel(value: unknown): boolean {
  const v = String(value ?? "").trim();
  return !v || /^Dịch vụ\s*\d+\s*$/i.test(v);
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon: Icon, color, sub }: {
  label: string; value: number; icon: React.ElementType; color: "blue" | "green" | "red"; sub?: string;
}) {
  const colors = {
    blue:  "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400",
    green: "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400",
    red:   "bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400",
  };
  return (
    <div className="rounded-xl border border-border bg-card p-3 flex flex-col gap-1 shadow-sm">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colors[color]}`}>
        <Icon size={16} />
      </div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground leading-tight">{label}</div>
      {sub && <div className="text-[10px] text-red-500 font-semibold leading-tight">{sub}</div>}
    </div>
  );
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function ProgressBar({ percent }: { percent: number }) {
  const pct = Math.min(100, Math.max(0, percent || 0));
  const color = pct >= 100 ? "bg-emerald-500" : pct >= 70 ? "bg-blue-500" : pct >= 40 ? "bg-amber-500" : "bg-slate-400";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-medium text-muted-foreground w-8 text-right">{Math.round(pct)}%</span>
    </div>
  );
}

// ── Deadline health bar (thanh máu) ─────────────────────────────────────────
function DeadlineHealthBar({ bar, deadlineLabel }: {
  bar: { percent: number; daysRemaining: number };
  deadlineLabel?: string | null;
}) {
  const badge = deadlineStatusBadge(bar.daysRemaining);
  return (
    <div className="space-y-1.5">
      <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${deadlineBarColor(bar.daysRemaining)}`}
          style={{ width: `${bar.percent}%` }}
        />
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <p className={`text-sm font-bold leading-tight ${
            bar.daysRemaining <= 1 ? "text-orange-600 dark:text-orange-400"
            : bar.daysRemaining <= 3 ? "text-red-600 dark:text-red-400"
            : bar.daysRemaining <= 5 ? "text-amber-600 dark:text-amber-400"
            : "text-emerald-600 dark:text-emerald-400"
          }`}>
            {deadlineBarText(bar.daysRemaining)}
          </p>
          {deadlineLabel && (
            <p className="text-[11px] text-muted-foreground">Hạn: {deadlineLabel}</p>
          )}
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${badge.cls}`}>{badge.label}</span>
      </div>
    </div>
  );
}

// ── Collapsible section ───────────────────────────────────────────────────────
function Section({ icon: Icon, title, children, open, onToggle, summary }: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  summary?: string;
}) {
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
      >
        <div className={`w-6 h-6 rounded-md border border-border/80 bg-background flex items-center justify-center shrink-0 transition-transform ${open ? "" : ""}`}>
          {open ? <ChevronUp size={16} className="text-foreground/70" /> : <ChevronDown size={16} className="text-foreground/70" />}
        </div>
        <div className="flex items-center gap-2 text-sm font-semibold min-w-0 flex-1">
          <Icon size={14} className="text-muted-foreground shrink-0" />
          <span className="truncate">{title}</span>
        </div>
        {!open && summary && (
          <span className="text-[11px] text-muted-foreground truncate max-w-[42%] shrink-0">{summary}</span>
        )}
      </button>
      {open && <div className="px-3 py-3 space-y-2 border-t border-border/60">{children}</div>}
    </div>
  );
}

const DETAIL_SECTION_KEYS = [
  "staff",
] as const;
type DetailSectionKey = typeof DETAIL_SECTION_KEYS[number];

function buildDetailSectionOpen(only?: DetailSectionKey): Record<DetailSectionKey, boolean> {
  return Object.fromEntries(DETAIL_SECTION_KEYS.map(k => [k, k === only])) as Record<DetailSectionKey, boolean>;
}

// ── Concept image gallery ─────────────────────────────────────────────────────
function ConceptGallery({ images }: { images: string[] }) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {images.map((src, i) => {
          const displaySrc = getImageSrc(src);
          if (!displaySrc) return null;
          return (
            <button key={displaySrc} type="button" onClick={() => setLightbox(displaySrc)}
              className="w-16 h-16 rounded-lg overflow-hidden border border-border bg-muted flex-shrink-0 hover:opacity-90 transition-opacity">
              <ConceptImage src={displaySrc} alt={`concept-${i}`} />
            </button>
          );
        })}
      </div>
      {lightbox && (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="concept" className="max-w-full max-h-full rounded-xl shadow-2xl" />
        </div>
      )}
    </>
  );
}

// ── Gói dịch vụ (y chang bảng giá) ───────────────────────────────────────────
function PackagePriceSnapshot({ row }: { row: BookingEditRow }) {
  const pkgName = (row.package_name ?? "").trim() || getRowServiceName(row);
  const pkgPrice = Number(row.package_price ?? 0);
  const printCost = Number(row.package_print_cost ?? 0);
  const opCost = Number(row.package_operating_cost ?? 0);
  const desc = (row.package_description ?? "").trim();
  const paid = Number(row.paid_amount ?? 0);
  const total = Number(row.total_amount ?? 0);
  const remaining = Math.max(0, total - paid);
  const listPrice = pkgPrice > 0 ? pkgPrice : total;
  const needsHK = row.package_requires_post_production !== false;

  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-2 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-sm leading-snug text-foreground flex-1">{pkgName}</p>
        {needsHK
          ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300 font-medium shrink-0">Hậu kỳ</span>
          : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium shrink-0">Không HK</span>}
      </div>
      {row.package_code && <p className="text-xs text-muted-foreground">{row.package_code}</p>}
      <p className="text-2xl font-bold text-primary leading-none">{formatVND(listPrice)}</p>
      {(printCost > 0 || opCost > 0) && (
        <div className="space-y-0.5 text-[11px] text-muted-foreground">
          {printCost > 0 && <p>🖨️ In ấn: {formatVNDShort(printCost)}</p>}
          {opCost > 0 && <p>⚡ Vận hành: {formatVNDShort(opCost)}</p>}
          <p className="text-[10px] text-sky-600 dark:text-sky-400">👤 Cast theo nhân sự</p>
        </div>
      )}
      {desc ? (
        <div className="bg-amber-50 dark:bg-amber-950/30 rounded-lg px-2.5 py-2 border border-amber-100 dark:border-amber-900/40">
          <p className="text-[10px] font-semibold text-amber-800 dark:text-amber-200 mb-1">📋 Mô tả</p>
          <div className="space-y-0.5">
            {desc.split("\n").filter(Boolean).map((line, i) => (
              <p key={i} className="text-[10px] text-amber-700 dark:text-amber-300 leading-relaxed">{line}</p>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground italic">Chưa có mô tả gói từ bảng giá</p>
      )}
      {(row.package_notes ?? "").trim() && (
        <p className="text-[10px] text-muted-foreground italic border-t border-border/50 pt-2">{row.package_notes}</p>
      )}
      {total > 0 && total !== listPrice && (
        <p className="text-[11px] text-muted-foreground border-t border-border/60 pt-2">
          Tổng đơn (có phát sinh): <span className="font-semibold text-foreground">{formatVND(total)}</span>
          {remaining > 0 && <> · Còn lại <span className="font-semibold text-red-600">{formatVND(remaining)}</span></>}
        </p>
      )}
      {total > 0 && total === listPrice && remaining > 0 && (
        <p className="text-[11px] text-muted-foreground">Còn lại: <span className="font-semibold text-red-600">{formatVND(remaining)}</span></p>
      )}
    </div>
  );
}

// ── Detail Modal ──────────────────────────────────────────────────────────────
function DetailModal({ row, onClose, staffList, isAdmin, viewerId, viewerName }: {
  row: BookingEditRow; onClose: () => void; staffList: StaffItem[];
  isAdmin: boolean; viewerId: number | null; viewerName: string;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<DetailForm>({
    status: row.status ?? "chua_nhan",
    totalPhotos: String(row.total_photos ?? ""),
    donePhotos: String(row.done_photos ?? ""),
    receivedFileDate: row.received_file_date ?? "",
    internalDeadline: row.internal_deadline ?? "",
    customerDeadline: row.customer_deadline ?? "",
    notes: row.notes ?? "",
    assignedStaffId: row.assigned_staff_id != null ? String(row.assigned_staff_id) : "",
    assignedStaffName: row.assigned_staff_name ?? "",
    photoshopNote: row.photoshop_note ?? "",
    extraRetouchPrice: String(row.extra_retouch_price ?? ""),
    extraPhotosRequested: row.extra_photos_requested != null ? String(row.extra_photos_requested) : "",
    driveLink: row.drive_link ?? "",
    printNotes: row.print_notes ?? "",
    daXuatIn: row.da_xuat_in ?? false,
    chiPhiPhatSinh: row.chi_phi_phat_sinh ? String(row.chi_phi_phat_sinh) : "",
    moTaPhatSinh: row.mo_ta_phat_sinh ?? "",
    detailPhotosCount: row.detail_photos_count != null ? String(row.detail_photos_count) : "0",
    partyPhotosCount: row.party_photos_count != null ? String(row.party_photos_count) : "0",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [sectionsOpen, setSectionsOpen] = useState<Record<DetailSectionKey, boolean>>(() => buildDetailSectionOpen());
  const toggleSection = (key: DetailSectionKey) => setSectionsOpen(s => ({ ...s, [key]: !s[key] }));
  const [xongShowDialog, setXongShowDialog] = useState<{ open: boolean; photoCount: string }>({ open: false, photoCount: "" });
  const [deadlineEditOpen, setDeadlineEditOpen] = useState(false);
  const [extraPhotosEditOpen, setExtraPhotosEditOpen] = useState(false);
  const [heroFlash, setHeroFlash] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["photoshop-booking-view"] });
    qc.invalidateQueries({ queryKey: ["photoshop-stats"] });
  };

  // Parsed booking data
  const bookingItemsRaw = parseJson<unknown>(row.booking_items);
  const bookingItems: BookingItem[] = Array.isArray(bookingItemsRaw) ? bookingItemsRaw as BookingItem[] : [];
  const surchargesRaw = parseJson<unknown>(row.booking_surcharges);
  const surcharges: BookingSurcharge[] = Array.isArray(surchargesRaw) ? surchargesRaw as BookingSurcharge[] : [];
  const assignedStaffRaw = parseJson<unknown>(row.booking_assigned_staff);
  const assignedStaff: AssignedStaffItem[] = Array.isArray(assignedStaffRaw) ? assignedStaffRaw as AssignedStaffItem[] : [];

  const getStaffDisplayName = (s: AssignedStaffItem) => s.staffName || s.name || "";
  const photographer = assignedStaff.find(s => ["photographer", "photo", "Photographer"].includes(s.role ?? ""));
  const makeupArtist = assignedStaff.find(s => ["makeup", "Makeup", "makeup_artist"].includes(s.role ?? ""));

  const allConceptImages = row.booking_concept_images ?? bookingItems.flatMap(item => item.conceptImages ?? []);
  const paidAmount = Number(row.paid_amount ?? 0);
  const totalAmount = Number(row.total_amount ?? 0);
  const remainingAmount = Math.max(0, totalAmount - paidAmount);
  const firstBookingItem = bookingItems[0];

  const included = row.included_retouched_photos_snapshot ?? 0;
  const doneNum = Number(form.donePhotos) || 0;

  // (B) Progress formula: denominator = total_photos + extra_photos_requested
  const totalPhotosNum = Number(form.totalPhotos) || 0;
  const extraPhotosNum = Number(form.extraPhotosRequested) || 0;
  const totalNeeded = totalPhotosNum + extraPhotosNum;
  const pct = totalNeeded > 0 ? Math.round((doneNum / totalNeeded) * 100) : 0;

  const urgency = getCardUrgency(row);
  const headerBg = urgency === "fire" ? "bg-orange-50 dark:bg-orange-900/20"
    : urgency === "red" ? "bg-red-50 dark:bg-red-900/20"
    : urgency === "yellow" ? "bg-amber-50 dark:bg-amber-900/20"
    : urgency === "done" ? "bg-emerald-50 dark:bg-emerald-900/20"
    : urgency === "paused" ? "bg-purple-50 dark:bg-purple-900/20"
    : "bg-muted/30";

  const svcNameForDeadline = getRowServiceName(row);
  // deadline_system is read-only, computed from shoot_date (not receivedFileDate)
  const previewDeadlineSystem = row.deadline_system
    ?? calcSystemDeadlineFE(row.shoot_date, svcNameForDeadline);
  const effectiveDeadline = getEffectiveDeadline(previewDeadlineSystem, form.customerDeadline || row.customer_deadline);
  const deadlineBar = (!DONE_FE.includes(row.status ?? "") && row.status !== "tam_hoan")
    ? calcDeadlineBar(effectiveDeadline, svcNameForDeadline)
    : null;
  const packagePhotoCount = Number(form.totalPhotos) || included || 0;

  const claimJob = async () => {
    setSaving(true); setErr("");
    try {
      if (!row.job_id) {
        const r = await authFetch(`/api/photoshop-jobs`, {
          method: "POST",
          body: JSON.stringify({
            bookingId: row.booking_id,
            customerName: row.customer_name,
            customerPhone: row.customer_phone,
            serviceName: getRowServiceName(row),
            shootDate: row.shoot_date,
            assignedStaffId: viewerId,
            assignedStaffName: viewerName,
            status: "dang_pts",
            receivedFileDate: new Date().toISOString().split("T")[0],
          }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "Lỗi nhận việc"); }
      } else {
        const r = await authFetch(`/api/photoshop-jobs/${row.job_id}`, {
          method: "PUT",
          body: JSON.stringify({
            assignedStaffId: viewerId, assignedStaffName: viewerName,
            status: "dang_pts", receivedFileDate: new Date().toISOString().split("T")[0],
          }),
        });
        if (!r.ok) throw new Error("Lỗi nhận việc");
      }
      invalidate(); onClose();
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setSaving(false); }
  };

  const save = async (extraFields?: Record<string, unknown>, opts: { keepOpen?: boolean; closeDelay?: number } = {}): Promise<boolean> => {
    setSaving(true); setErr("");
    try {
      const done = Number(form.donePhotos) || 0;
      const total = Number(form.totalPhotos) || 0;
      const extra = Number(form.extraPhotosRequested) || 0;
      const progress = (total + extra) > 0 ? Math.round((done / (total + extra)) * 100) : 0;

      let staffId = form.assignedStaffId ? Number(form.assignedStaffId) : null;
      let staffName = form.assignedStaffName;
      if (isAdmin && form.assignedStaffId) {
        const found = staffList.find(s => String(s.id) === form.assignedStaffId);
        if (found) staffName = found.name;
      }

      const payload: Record<string, unknown> = {
        status: form.status,
        totalPhotos: total, donePhotos: done, progressPercent: progress,
        receivedFileDate: form.receivedFileDate,
        internalDeadline: form.internalDeadline,
        customerDeadline: form.customerDeadline,
        notes: form.notes,
        photoshopNote: form.photoshopNote,
        extraRetouchPrice: Number(form.extraRetouchPrice) || 0,
        extraPhotosRequested: form.extraPhotosRequested !== "" ? Number(form.extraPhotosRequested) : null,
        driveLink: form.driveLink,
        printNotes: form.printNotes,
        daXuatIn: form.daXuatIn,
        chiPhiPhatSinh: form.chiPhiPhatSinh !== "" ? Number(form.chiPhiPhatSinh) : 0,
        moTaPhatSinh: form.moTaPhatSinh,
        detailPhotosCount: Number(form.detailPhotosCount) || 0,
        partyPhotosCount: Number(form.partyPhotosCount) || 0,
        // Task #493: KHÔNG gửi detailPhotosRate / partyPhotosRate nữa — đơn giá
        // hậu kỳ lấy từ Bảng cast của staff theo packageId của booking ở backend.
        ...(isAdmin ? { assignedStaffId: staffId, assignedStaffName: staffName } : {}),
        ...extraFields,
      };

      if (row.job_id) {
        const r = await authFetch(`/api/photoshop-jobs/${row.job_id}`, { method: "PUT", body: JSON.stringify(payload) });
        if (!r.ok) throw new Error("Lỗi lưu");
        const updatedJob = await r.json();
        // (A) setQueryData — patch cache ngay, không chờ refetch
        // Prefer PUT response (camelCase from Drizzle), fall back to form/extraFields value
        const newStatus = updatedJob.status ?? (extraFields?.status ?? payload.status) as string;
        const newCustDl = updatedJob.customerDeadline ?? updatedJob.customer_deadline
          ?? (extraFields?.customerDeadline ?? form.customerDeadline) as string | undefined;
        const newDeadlineSys = updatedJob.deadlineSystem ?? updatedJob.deadline_system ?? row.deadline_system;
        const newCode = computeDeadlineCodeFE(newStatus, newDeadlineSys, newCustDl);
        qc.setQueriesData<{ rows: BookingEditRow[]; summary: Stats }>(
          { queryKey: ["photoshop-booking-view"] },
          (old) => {
            if (!old) return old;
            return {
              ...old,
              // NOTE: Drizzle returning() gives camelCase; BookingEditRow (from SQL view) uses snake_case
              rows: old.rows.map(r2 => r2.booking_id === row.booking_id
                ? {
                  ...r2,
                  status: updatedJob.status ?? r2.status,
                  assigned_staff_id: updatedJob.assignedStaffId ?? updatedJob.assigned_staff_id ?? r2.assigned_staff_id,
                  assigned_staff_name: updatedJob.assignedStaffName ?? updatedJob.assigned_staff_name ?? r2.assigned_staff_name,
                  total_photos: updatedJob.totalPhotos ?? updatedJob.total_photos ?? r2.total_photos,
                  done_photos: updatedJob.donePhotos ?? updatedJob.done_photos ?? r2.done_photos,
                  progress_percent: updatedJob.progressPercent ?? updatedJob.progress_percent ?? r2.progress_percent,
                  extra_photos_requested: updatedJob.extraPhotosRequested ?? updatedJob.extra_photos_requested ?? r2.extra_photos_requested,
                  customer_deadline: updatedJob.customerDeadline ?? updatedJob.customer_deadline ?? r2.customer_deadline,
                  drive_link: updatedJob.driveLink ?? updatedJob.drive_link ?? r2.drive_link,
                  print_notes: updatedJob.printNotes ?? updatedJob.print_notes ?? r2.print_notes,
                  da_xuat_in: updatedJob.daXuatIn ?? updatedJob.da_xuat_in ?? r2.da_xuat_in,
                  chi_phi_phat_sinh: updatedJob.chiPhiPhatSinh ?? updatedJob.chi_phi_phat_sinh ?? r2.chi_phi_phat_sinh,
                  mo_ta_phat_sinh: updatedJob.moTaPhatSinh ?? updatedJob.mo_ta_phat_sinh ?? r2.mo_ta_phat_sinh,
                  deadlineCode: newCode,
                }
                : r2
              ),
            };
          }
        );
      } else {
        const r = await authFetch(`/api/photoshop-jobs`, {
          method: "POST",
          body: JSON.stringify({
            bookingId: row.booking_id, customerName: row.customer_name,
            customerPhone: row.customer_phone, serviceName: getRowServiceName(row),
            shootDate: row.shoot_date, ...payload,
          }),
        });
        if (!r.ok) throw new Error("Lỗi tạo job");
      }
      invalidate();
      if (!opts.keepOpen) {
        const delay = opts.closeDelay ?? 0;
        if (delay > 0) {
          setTimeout(() => onClose(), delay);
        } else {
          onClose();
        }
      }
      return true;
    } catch (e) { setErr(String(e instanceof Error ? e.message : e)); return false; }
    finally { setSaving(false); }
  };

  const orderDisplay = getOrderDisplay(row);

  const flashHero = (msg: string) => {
    setHeroFlash(msg);
    window.setTimeout(() => setHeroFlash(""), 2500);
  };

  const saveHeroPhotos = async () => {
    const ok = await save(undefined, { keepOpen: true });
    if (!ok) return;
    flashHero("Đã lưu ảnh làm thêm");
    setExtraPhotosEditOpen(false);
  };

  const saveHeroWork = async () => {
    const ok = await save(undefined, { keepOpen: true });
    if (!ok) return;
    flashHero("Đã lưu");
    setDeadlineEditOpen(false);
  };

  return (
    <>
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="bg-background rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[95vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>

        {/* Header — gói bảng giá + khách */}
        <div className={`px-4 pt-3 pb-3 rounded-t-2xl ${headerBg} shrink-0 border-b border-border/50 space-y-3`}>
          <div className="flex items-start justify-between gap-2">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              Đơn hậu kỳ · <span className="text-foreground font-bold">{orderDisplay.code}</span>
            </p>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/10 shrink-0"><X size={18} /></button>
          </div>

          <PackagePriceSnapshot row={row} />

          <div className="space-y-1">
            <p className="text-sm">
              <span className="font-semibold text-foreground">{row.customer_name}</span>
              {row.customer_phone ? <span className="text-muted-foreground"> · {row.customer_phone}</span> : null}
            </p>
            <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="inline-flex items-center gap-1"><Camera size={11} />Show {formatDate(row.shoot_date)}</span>
              {row.assigned_staff_name && <span className="inline-flex items-center gap-1"><User size={11} />HK: {row.assigned_staff_name}</span>}
              {row.job_code && <span>{row.job_code}</span>}
            </p>
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {row.status && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                  ${DONE_FE.includes(row.status) ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40"
                  : row.status === "tam_hoan" ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40"
                  : IN_PROGRESS_FE.includes(row.status) ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40"
                  : "bg-slate-100 text-slate-600 dark:bg-slate-800"}`}>
                  {STATUS_LABEL[row.status] || row.status}
                </span>
              )}
              {deadlineBar && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${deadlineStatusBadge(deadlineBar.daysRemaining).cls}`}>
                  {deadlineBarText(deadlineBar.daysRemaining)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
        {/* ── Làm việc: deadline · ảnh · concept · in ấn ── */}
        <div className="px-3 pt-3 space-y-3 border-b border-border bg-muted/20">
          {(photographer || makeupArtist) && (
            <p className="text-[11px] text-muted-foreground px-0.5">
              {photographer && <>📷 {getStaffDisplayName(photographer)}</>}
              {photographer && makeupArtist && " · "}
              {makeupArtist && <>💄 {getStaffDisplayName(makeupArtist)}</>}
            </p>
          )}

          {deadlineBar && (
            <div className="rounded-xl border border-border bg-card px-3 py-2.5">
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <DeadlineHealthBar
                    bar={deadlineBar}
                    deadlineLabel={effectiveDeadline ? formatDate(effectiveDeadline) : null}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setDeadlineEditOpen(v => !v)}
                  className="shrink-0 w-9 h-9 rounded-lg border border-border bg-background hover:bg-muted flex items-center justify-center"
                  title="Gia hạn / sửa deadline"
                >
                  <Pencil size={16} className="text-muted-foreground" />
                </button>
              </div>
              {deadlineEditOpen && (
                <div className="mt-3 pt-3 border-t border-border space-y-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Deadline khách (gia hạn)</label>
                    <DateInput className="w-full rounded-lg py-2 text-sm"
                      value={form.customerDeadline}
                      onChange={v => { setForm(f => ({ ...f, customerDeadline: v })); setHeroFlash(""); }} />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Hệ thống (từ ngày chụp): {previewDeadlineSystem ? formatDate(previewDeadlineSystem) : "—"}
                    {previewDeadlineSystem ? ` · ${daysLeft(previewDeadlineSystem)}` : ""}
                  </p>
                  <button type="button" onClick={saveHeroWork} disabled={saving}
                    className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50">
                    Lưu deadline
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-border bg-card px-3 py-2.5 space-y-2">
            <div className="flex items-end gap-2 flex-wrap">
              <div className="min-w-[120px] flex-1">
                <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Ảnh theo gói</label>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <span className="text-xl font-black text-foreground">{packagePhotoCount}</span>
                  <span className="text-xs text-muted-foreground">ảnh</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setExtraPhotosEditOpen(v => !v)}
                className={`w-11 h-11 rounded-xl border-2 flex items-center justify-center font-bold text-lg transition-colors ${
                  extraPhotosEditOpen || extraPhotosNum > 0
                    ? "border-amber-400 bg-amber-50 text-amber-700"
                    : "border-border bg-background hover:bg-muted text-foreground"
                }`}
                title="Ảnh khách muốn thêm"
              >
                <Plus size={20} />
              </button>
              {extraPhotosNum > 0 && !extraPhotosEditOpen && (
                <div className="text-sm font-semibold text-amber-700 dark:text-amber-400">+{extraPhotosNum} thêm</div>
              )}
            </div>
            {(extraPhotosEditOpen || extraPhotosNum > 0) && (
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-amber-700 dark:text-amber-400 block">Ảnh khách làm thêm</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min="0" step="1"
                    className="flex-1 rounded-lg border border-amber-300 dark:border-amber-700 bg-background px-3 py-2 text-sm"
                    value={form.extraPhotosRequested}
                    onChange={e => { setForm(f => ({ ...f, extraPhotosRequested: e.target.value })); setHeroSaveOk(""); }}
                    placeholder="Số ảnh khách cần làm thêm..."
                  />
                  {extraPhotosNum > 0 && (
                    <button type="button" onClick={() => { setForm(f => ({ ...f, extraPhotosRequested: "" })); setHeroSaveOk(""); }}
                      className="w-9 h-9 rounded-lg border border-border flex items-center justify-center hover:bg-muted"
                      title="Xóa ảnh làm thêm">
                      <Minus size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={saveHeroPhotos}
                    disabled={saving}
                    className="shrink-0 px-3 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold disabled:opacity-50 flex items-center gap-1"
                  >
                    {saving ? <Loader2 size={13} className="animate-spin" /> : null}
                    Lưu
                  </button>
                </div>
              </div>
            )}
            <div>
              <label className="text-[11px] font-medium text-muted-foreground mb-1 block">Đã hậu kỳ xong (tiến độ %)</label>
              <div className="flex items-center gap-2">
                <input type="number" min="0" className="w-24 rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold"
                  value={form.donePhotos} onChange={e => { setForm(f => ({ ...f, donePhotos: e.target.value })); setHeroFlash(""); }} />
                {totalNeeded > 0 && (
                  <span className="text-xs text-muted-foreground flex-1">/ {totalNeeded} ảnh cần làm</span>
                )}
                <button type="button" onClick={saveHeroWork} disabled={saving}
                  className="shrink-0 px-3 py-2 rounded-lg border border-border bg-background hover:bg-muted text-xs font-semibold disabled:opacity-50">
                  Lưu
                </button>
              </div>
              {totalNeeded > 0 && <div className="mt-1.5"><ProgressBar percent={pct} /></div>}
              <p className="text-[10px] text-muted-foreground mt-1">Khác số ảnh tính lương khi bấm Xong show bên dưới.</p>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card px-3 py-2.5">
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5">
              <Palette size={13} /> Concept (mở rộng)
            </p>
            {allConceptImages.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Chưa upload concept từ booking</p>
            ) : (
              <ConceptGallery images={allConceptImages} />
            )}
          </div>

          <div className="rounded-xl border border-border bg-card px-3 py-2.5 space-y-2">
            <p className="text-xs font-semibold flex items-center gap-1.5">
              <Printer size={13} /> In ấn — link hoàn thành
            </p>
            <div className="flex items-center gap-2">
              <Link2 size={14} className="text-muted-foreground shrink-0" />
              <input type="url" className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                value={form.driveLink}
                onChange={e => { setForm(f => ({ ...f, driveLink: e.target.value })); setHeroFlash(""); }}
                placeholder="https://drive.google.com/... (link ảnh đã PTS)" />
            </div>
            <button type="button" onClick={saveHeroWork} disabled={saving}
              className="w-full py-2 rounded-lg border border-border bg-background hover:bg-muted text-xs font-semibold disabled:opacity-50">
              Lưu link & tiến độ
            </button>
            <label className={`flex items-center gap-2 select-none ${isAdmin ? "cursor-pointer" : "cursor-not-allowed opacity-80"}`}>
              <input type="checkbox" checked={form.daXuatIn}
                onChange={isAdmin ? (e => { setForm(f => ({ ...f, daXuatIn: e.target.checked })); setHeroFlash(""); }) : undefined}
                disabled={!isAdmin}
                className="w-4 h-4 rounded border-border accent-emerald-600" />
              <span className="text-sm font-medium">Đã xuất in / hoàn thành</span>
              {form.driveLink && !form.daXuatIn && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Chưa đánh dấu</span>
              )}
              {form.daXuatIn && <CheckCircle2 size={14} className="text-emerald-600" />}
            </label>
            {heroFlash && <p className="text-[11px] text-emerald-600 font-medium">{heroFlash}</p>}
          </div>
        </div>

        <div className="p-3 space-y-2 pb-4">

          {/* Nhân sự */}
          <Section icon={Users} title="👥 Nhân sự"
            open={sectionsOpen.staff} onToggle={() => toggleSection("staff")}
            summary={assignedStaff.length > 0 ? `${assignedStaff.length} người` : "Chưa giao"}>
            {assignedStaff.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">Chưa có nhân sự được giao</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {photographer && getStaffDisplayName(photographer) && (
                  <div className="flex items-center gap-1.5 bg-blue-50 dark:bg-blue-900/20 px-2.5 py-1.5 rounded-lg">
                    <Camera size={13} className="text-blue-500" />
                    <span className="text-xs font-medium">📷 {getStaffDisplayName(photographer)}</span>
                  </div>
                )}
                {makeupArtist && getStaffDisplayName(makeupArtist) && (
                  <div className="flex items-center gap-1.5 bg-pink-50 dark:bg-pink-900/20 px-2.5 py-1.5 rounded-lg">
                    <User size={13} className="text-pink-500" />
                    <span className="text-xs font-medium">💄 {getStaffDisplayName(makeupArtist)}</span>
                  </div>
                )}
                {assignedStaff.filter(s => s !== photographer && s !== makeupArtist).map((s, i) => (
                  <div key={i} className="flex items-center gap-1.5 bg-muted px-2.5 py-1.5 rounded-lg">
                    <User size={13} className="text-muted-foreground" />
                    <span className="text-xs font-medium">{getStaffDisplayName(s)} ({s.role})</span>
                  </div>
                ))}
              </div>
            )}
            {isAdmin && (
              <div className="mt-2">
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Giao việc cho nhân viên HK</label>
                <select className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  value={form.assignedStaffId}
                  onChange={e => {
                    const found = staffList.find(s => String(s.id) === e.target.value);
                    setForm(f => ({ ...f, assignedStaffId: e.target.value, assignedStaffName: found?.name ?? "" }));
                  }}>
                  <option value="">— Chưa giao —</option>
                  {staffList.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                </select>
              </div>
            )}
          </Section>


        </div>

        </div>

        {/* Footer cố định — luôn thấy khi làm việc */}
        <div className="shrink-0 border-t border-border bg-background/95 backdrop-blur-sm p-3 space-y-2 rounded-b-2xl">
          {isUnassigned(row) && !saving && (
            <button onClick={claimJob} disabled={saving}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm transition-colors flex items-center justify-center gap-2">
              <UserCheck size={16} />
              {viewerName ? `Tôi nhận việc này (${viewerName})` : "Nhận việc"}
            </button>
          )}
          {err && <div className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{err}</div>}

          <div className="grid grid-cols-2 gap-2">
            {form.status === "tam_hoan" ? (
              <button onClick={() => { setForm(f => ({ ...f, status: "dang_pts" })); }}
                className="py-2.5 rounded-xl bg-blue-100 hover:bg-blue-200 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-semibold text-sm transition-colors flex items-center justify-center gap-1.5">
                <PlayCircle size={15} />
                Tiếp tục
              </button>
            ) : (
              <button onClick={() => { setForm(f => ({ ...f, status: "tam_hoan" })); }}
                className="py-2.5 rounded-xl bg-purple-100 hover:bg-purple-200 text-purple-700 dark:bg-purple-900/30 dark:hover:bg-purple-900/50 dark:text-purple-300 font-semibold text-sm transition-colors flex items-center justify-center gap-1.5">
                <PauseCircle size={15} />
                Tạm hoãn
              </button>
            )}
            {!DONE_FE.includes(form.status) && (
              <button onClick={() => {
                const detailCount = Number(form.detailPhotosCount) || 0;
                const doneCount = Number(form.donePhotos) || 0;
                if (detailCount === 0) {
                  setXongShowDialog({ open: true, photoCount: String(doneCount) });
                } else {
                  save({ status: "xong_show" });
                }
              }} disabled={saving}
                className="py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50">
                <CheckCircle2 size={15} />
                Xong show
              </button>
            )}
            {!DONE_FE.includes(form.status) && (
              <p className="col-span-2 text-[10px] text-center text-muted-foreground">
                Xong show → nhập số ảnh → lương cho <strong>{viewerName || "bạn"}</strong>
              </p>
            )}
            <button onClick={() => save(undefined, { keepOpen: true })} disabled={saving}
              className={`py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-sm transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50
                ${DONE_FE.includes(form.status) ? "col-span-2" : "col-span-2"}`}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : null}
              Lưu tất cả
            </button>
          </div>
        </div>

      </div>
    </div>

    {/* Xong show – confirm photo count dialog */}
    {xongShowDialog.open && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setXongShowDialog({ open: false, photoCount: "" })}>
        <div className="bg-background rounded-2xl shadow-xl p-6 w-80 max-w-full space-y-4" onClick={e => e.stopPropagation()}>
          <h3 className="font-bold text-base">Xác nhận Xong show</h3>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 dark:bg-emerald-950/30 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-100 space-y-1">
            <p className="font-semibold">Quy định lương PTS</p>
            <p>
              Người bấm <strong>Xong show</strong> và nhập số ảnh bên dưới sẽ được <strong>tính tiền cho đơn này</strong>
              {viewerName ? <> — hiện tại: <strong>{viewerName}</strong></> : null}.
            </p>
            <p className="text-emerald-800/80 dark:text-emerald-200/80">Đơn giá lấy từ Bảng cast (theo gói + nhân viên). Không cần báo admin.</p>
          </div>
          <p className="text-sm text-muted-foreground">Nhập đúng số ảnh chỉnh kỹ bạn đã làm xong.</p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Số ảnh chỉnh kỹ</label>
            <input
              type="number"
              min={0}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              value={xongShowDialog.photoCount}
              onChange={e => setXongShowDialog(d => ({ ...d, photoCount: e.target.value }))}
              autoFocus
              onKeyDown={e => {
                if (e.key === "Enter") {
                  const count = Math.max(0, Number(xongShowDialog.photoCount) || 0);
                  setForm(f => ({ ...f, detailPhotosCount: String(count), status: "xong_show" }));
                  setXongShowDialog({ open: false, photoCount: "" });
                  save({ status: "xong_show", detailPhotosCount: count });
                }
                if (e.key === "Escape") setXongShowDialog({ open: false, photoCount: "" });
              }}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setXongShowDialog({ open: false, photoCount: "" })}
              className="px-4 py-2 rounded-xl text-sm font-medium border border-border hover:bg-muted transition-colors">
              Huỷ
            </button>
            <button
              disabled={saving}
              onClick={() => {
                const count = Math.max(0, Number(xongShowDialog.photoCount) || 0);
                setForm(f => ({ ...f, detailPhotosCount: String(count), status: "xong_show" }));
                setXongShowDialog({ open: false, photoCount: "" });
                save({ status: "xong_show", detailPhotosCount: count });
              }}
              className="px-4 py-2 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors flex items-center gap-1.5 disabled:opacity-50">
              <CheckCircle2 size={15} />
              Xác nhận
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// ── Customer avatar ───────────────────────────────────────────────────────────
function CustomerAvatar({ name, avatar, size = 40 }: { name: string; avatar: string | null; size?: number }) {
  const initials = (name || "?")
    .trim()
    .split(/\s+/)
    .slice(-2)
    .map(s => s[0]?.toUpperCase() ?? "")
    .join("") || "?";
  const palette = [
    "bg-rose-500", "bg-amber-500", "bg-emerald-500", "bg-sky-500",
    "bg-indigo-500", "bg-fuchsia-500", "bg-teal-500", "bg-orange-500",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const bg = palette[h % palette.length];
  const style = { width: size, height: size, minWidth: size };
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name}
        style={style}
        className="rounded-full object-cover border-2 border-white dark:border-neutral-800 shadow-sm self-center"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return (
    <div
      style={style}
      className={`${bg} rounded-full flex items-center justify-center text-white font-bold text-sm border-2 border-white dark:border-neutral-800 shadow-sm self-center`}
    >
      {initials}
    </div>
  );
}

// ── Booking card ──────────────────────────────────────────────────────────────
function BookingCard({ row, onClick }: { row: BookingEditRow; onClick: () => void }) {
  const urgency = getCardUrgency(row);
  const isActive = !DONE_FE.includes(row.status ?? "") && row.status !== "tam_hoan";
  const orderDisplay = getOrderDisplay(row);

  // Deadline bar logic
  const effectiveDeadline = getEffectiveDeadline(row.deadline_system, row.customer_deadline);
  const svcName = getRowServiceName(row);
  const bar = isActive ? calcDeadlineBar(effectiveDeadline, svcName) : null;
  const dlBadge = bar ? deadlineStatusBadge(bar.daysRemaining) : null;

  // Photo text — denominator = total_photos + extra_photos_requested (same formula as modal)
  const cardTotalPhotos = (row.total_photos ?? 0) + (row.extra_photos_requested ?? 0);
  const photoText = cardTotalPhotos > 0
    ? `${row.done_photos ?? 0}/${cardTotalPhotos} ảnh`
    : null;

  return (
    <button onClick={onClick}
      className={`w-full text-left rounded-xl border shadow-sm p-3 transition-all hover:shadow-md ${URGENCY_STYLE[urgency]}`}>
      <div className="flex items-start justify-between gap-2">
        {/* Avatar khách */}
        <CustomerAvatar name={row.customer_name} avatar={row.customer_avatar} />
        <div className="flex-1 min-w-0">

          {/* Dòng 1: mã đơn */}
          <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
            <span className="font-black text-sm text-foreground">{orderDisplay.code}</span>
            {row.list_section === "backlog" && row.shoot_date && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 font-bold">
                Nợ {shortShootMonth(String(row.shoot_date).slice(0, 7))}
              </span>
            )}
            {/* Badge nhận việc */}
            {isUnassigned(row) ? (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 dark:bg-red-900/40 font-medium">Chưa nhận</span>
            ) : DONE_FE.includes(row.status ?? "") ? (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 font-medium">
                {STATUS_LABEL[row.status ?? ""] || "Hoàn thành"}
              </span>
            ) : row.status === "tam_hoan" ? (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 font-medium">Tạm hoãn</span>
            ) : (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 font-medium">
                {STATUS_LABEL[row.status ?? ""] || "Đang PTS"}
              </span>
            )}
            {/* Badge trạng thái in ấn — luôn hiển thị */}
            {row.da_xuat_in ? (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 font-medium flex items-center gap-0.5">
                <CheckCircle2 size={8} />Đã in
              </span>
            ) : (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 font-medium flex items-center gap-0.5">
                <AlertTriangle size={8} />Chưa in
              </span>
            )}
            {/* Badge deadline (chỉ khi active) */}
            {dlBadge && (
              <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-bold ${dlBadge.cls}`}>
                {dlBadge.label}
              </span>
            )}
          </div>

          {/* Dòng 2: gói bảng giá + giá */}
          {orderDisplay.service !== "—" && (
            <p className="text-xs font-semibold text-foreground leading-snug line-clamp-2 mb-0.5">{orderDisplay.service}</p>
          )}
          {(() => {
            const p = Number(row.package_price ?? 0) || Number(row.total_amount ?? 0);
            return p > 0 ? (
              <p className="text-sm font-bold text-primary mb-0.5">{formatVND(p)}</p>
            ) : null;
          })()}
          {/* Dòng 3: khách hàng */}
          <div className="text-sm font-medium truncate mb-0.5">{row.customer_name}</div>
          <div className="text-xs text-muted-foreground mb-1">
            {row.customer_phone || "—"}
          </div>

          {/* Dòng 3: ngày chụp | nhân sự */}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground mb-2">
            <span className="flex items-center gap-1"><Camera size={10} />{formatDate(row.shoot_date)}</span>
            {row.assigned_staff_name && (
              <span className="flex items-center gap-1"><User size={10} />{row.assigned_staff_name}</span>
            )}
          </div>

          {/* Dòng 4: thanh deadline + text */}
          {isActive ? (
            bar ? (
              <div className="mb-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${deadlineBarColor(bar.daysRemaining)}`}
                      style={{ width: `${bar.percent}%` }}
                    />
                  </div>
                  <span className={`text-[11px] font-semibold shrink-0 ${
                    bar.daysRemaining <= 1 ? "text-orange-600 dark:text-orange-400" :
                    bar.daysRemaining <= 3 ? "text-red-600 dark:text-red-400" :
                    bar.daysRemaining <= 5 ? "text-amber-600 dark:text-amber-400" :
                    "text-emerald-600 dark:text-emerald-400"
                  }`}>
                    {deadlineBarText(bar.daysRemaining)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mb-1.5 text-xs text-muted-foreground italic">Chưa có deadline</div>
            )
          ) : null}

          {/* Dòng 5: số ảnh — ẩn nếu total = 0 */}
          {photoText && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <ImageIcon size={9} />{photoText}
              {(row.extra_photos_requested ?? 0) > 0 && (
                <span className="ml-1 text-amber-600 dark:text-amber-400">(+{row.extra_photos_requested} thêm)</span>
              )}
            </div>
          )}

        </div>
        <ChevronRight size={16} className="text-muted-foreground shrink-0 mt-1" />
      </div>
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function PhotoshopJobsPage() {
  const { viewer, isAdmin } = useStaffAuth();
  const qc = useQueryClient();
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // ── Deep-link: đọc URL ngay trong lazy initial state để tránh race condition ──
  // Lần fetch đầu tiên phải đã có bookingId & shootMonth=all, không thì bị filter ẩn mất kết quả.
  const initialDeepLink = (() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const bid = params.get("bookingId");
    if (!bid) return null;
    const id = Number(bid);
    if (!Number.isFinite(id) || id <= 0) return null;
    const source = params.get("from") === "calendar" ? "calendar" as const : null;
    return { id, source };
  })();

  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<BookingEditRow | null>(null);
  const [shootMonth, setShootMonth] = useState(initialDeepLink ? "all" : defaultMonth);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterStaff, setFilterStaff] = useState("all");
  // Bước 3: lọc theo nhóm dịch vụ. "all" = tất cả; "ungrouped" = job không gắn nhóm.
  const [filterGroup, setFilterGroup] = useState<"all" | "ungrouped" | number>("all");
  const [showFilters, setShowFilters] = useState(false);
  // Deep-link từ Lịch chụp: nhớ bookingId cần focus để mở DetailModal khi rows về
  const [pendingBookingId, setPendingBookingId] = useState<number | null>(initialDeepLink?.id ?? null);
  const [pendingBookingError, setPendingBookingError] = useState<string | null>(null);
  const [pendingBookingResolved, setPendingBookingResolved] = useState(false);
  const [pendingBookingContext, setPendingBookingContext] = useState<"calendar" | null>(initialDeepLink?.source ?? null);

  // Cleanup URL params sau khi đã đọc — chỉ chạy một lần khi mount
  useEffect(() => {
    if (!initialDeepLink) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("bookingId");
      url.searchParams.delete("from");
      window.history.replaceState({}, "", url.toString());
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep-link: gọi endpoint chuyên dụng để mở DetailModal NGAY, không phụ thuộc list query
  useEffect(() => {
    if (!initialDeepLink) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/photoshop-jobs/deep-link?bookingId=${initialDeepLink.id}`);
        if (cancelled) return;
        if (!r.ok) {
          setPendingBookingError("Không có đơn hậu kỳ cho booking/show này");
          setPendingBookingResolved(true);
          setPendingBookingId(null);
          setPendingBookingContext(null);
          return;
        }
        const data = await r.json() as { rows: BookingEditRow[]; preferred?: BookingEditRow };
        if (cancelled) return;
        const row = data.preferred ?? data.rows?.[0];
        if (row) {
          setSelected(row);
          setPendingBookingResolved(true);
          setPendingBookingId(null);
          setPendingBookingContext(null);
          setPendingBookingError(null);
        } else {
          setPendingBookingError("Không có đơn hậu kỳ cho booking/show này");
          setPendingBookingResolved(true);
          setPendingBookingId(null);
          setPendingBookingContext(null);
        }
      } catch {
        if (cancelled) return;
        setPendingBookingError("Lỗi kết nối khi mở đơn hậu kỳ");
        setPendingBookingResolved(true);
        setPendingBookingId(null);
        setPendingBookingContext(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: bookingView, isLoading } = useQuery<{ rows: BookingEditRow[]; summary: Stats }>({
    queryKey: ["photoshop-booking-view", shootMonth, pendingBookingId],
    queryFn: () => {
      const params = new URLSearchParams({ shootMonth });
      if (pendingBookingId != null) params.set("bookingId", String(pendingBookingId));
      return authFetch(`/api/photoshop-jobs/booking-view?${params.toString()}`).then(r => r.ok ? r.json() : { rows: [], summary: { myActive: 0, myDoneThisMonth: 0, backlog: 0 } });
    },
    staleTime: 0,
  });
  const { data: allMonthsView } = useQuery<{ rows: BookingEditRow[] }>({
    queryKey: ["photoshop-booking-view", "all-groups"],
    queryFn: () => authFetch(`/api/photoshop-jobs/booking-view?shootMonth=all`).then(r => r.ok ? r.json() : { rows: [] }),
    staleTime: 60_000,
  });
  const rows = bookingView?.rows ?? [];
  const stats = bookingView?.summary;
  const pendingBookingRows = useMemo(() => {
    if (pendingBookingId == null) return [];
    const direct = rows.filter(r => r.booking_id === pendingBookingId || r.parent_id === pendingBookingId);
    if (direct.length > 0) return direct;
    return rows.filter(r => {
      const label = String(r.service_label ?? "").trim();
      const packageName = String(r.package_name ?? "").trim();
      const jobCode = String(r.job_code ?? "").trim();
      return r.booking_id === pendingBookingId ||
        String(r.parent_id ?? "") === String(pendingBookingId) ||
        jobCode === `JOB-${pendingBookingId}` ||
        packageName.toLowerCase().includes(String(pendingBookingId)) ||
        (!isPlaceholderServiceLabel(label) && label.toLowerCase().includes(String(pendingBookingId)));
    });
  }, [pendingBookingId, rows]);

  const { data: staffList = [] } = useQuery<StaffItem[]>({
    queryKey: ["staff"],
    queryFn: () => authFetch(`/api/staff`).then(r => r.ok ? r.json() : []).then((d: unknown) => Array.isArray(d) ? d : []),
    enabled: isAdmin,
  });

  const staffsInData = useMemo(() => {
    const map = new Map<number, string>();
    rows.forEach(r => { if (r.assigned_staff_id && r.assigned_staff_name) map.set(r.assigned_staff_id, r.assigned_staff_name); });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [rows]);

  // Bước 3: danh sách nhóm dịch vụ xuất hiện trong rows hiện tại.
  // Lấy từ service_groups qua sp.group_id (BE đã JOIN sẵn). Không hardcode.
  const groupsInData = useMemo(() => {
    const map = new Map<number, string>();
    const sourceRows = allMonthsView?.rows?.length ? allMonthsView.rows : rows;
    sourceRows.forEach(r => {
      const gid = r.package_group_id;
      const gname = (r.package_group_name ?? "").trim();
      if (gid != null && gname) map.set(gid, gname);
    });
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [allMonthsView?.rows, rows]);
  const groupCountsInMonth = useMemo(() => {
    const map = new Map<number, number>();
    rows.forEach(r => {
      if (r.list_section === "backlog") return;
      const gid = r.package_group_id;
      if (gid != null) map.set(gid, (map.get(gid) ?? 0) + 1);
    });
    return map;
  }, [rows]);
  const groupCountsBacklog = useMemo(() => {
    const map = new Map<number, number>();
    if (shootMonth === "all") return map;
    rows.forEach(r => {
      if (r.list_section !== "backlog") return;
      const gid = r.package_group_id;
      if (gid != null) map.set(gid, (map.get(gid) ?? 0) + 1);
    });
    return map;
  }, [rows, shootMonth]);
  // "Khác" = các job không gắn được nhóm (gói chưa nhóm hoặc booking không gắn gói)
  const hasUngrouped = useMemo(
    () => rows.some(r => r.package_group_id == null),
    [rows],
  );

  const filtered = useMemo(() => {
    let data = [...rows];

    if (tab === "all") {
      data = data.filter(r => !DONE_FE.includes(r.status ?? "") && r.status !== "tam_hoan");
    } else if (tab === "mine") {
      data = data.filter(r => r.assigned_staff_id === viewer?.id && !DONE_FE.includes(r.status ?? ""));
    } else if (tab === "chua_nhan") {
      data = data.filter(r => isUnassigned(r));
    } else if (tab === "dang_pts") {
      data = data.filter(r => IN_PROGRESS_FE.includes(r.status ?? ""));
    } else if (tab === "da_pts") {
      data = data.filter(r => r.status === "da_pts");
    } else if (tab === "tam_hoan") {
      data = data.filter(r => r.status === "tam_hoan");
    } else if (tab === "xong_show") {
      data = data.filter(r => DONE_FE.includes(r.status ?? ""));
    }

    // Nợ tháng trước lên trước, rồi sort deadline
    data.sort((a, b) => {
      const aBack = a.list_section === "backlog" ? 0 : 1;
      const bBack = b.list_section === "backlog" ? 0 : 1;
      if (aBack !== bBack) return aBack - bBack;
      return sortPriority(a) - sortPriority(b);
    });
    if (filterStatus !== "all") {
      if (filterStatus === "chua_nhan") {
        data = data.filter(r => isUnassigned(r));
      } else {
        data = data.filter(r => r.status === filterStatus);
      }
    }
    if (filterStaff !== "all") {
      data = data.filter(r => String(r.assigned_staff_id) === filterStaff);
    }
    // Bước 3: lọc theo nhóm dịch vụ (number = id nhóm; "ungrouped" = không gắn)
    if (filterGroup === "ungrouped") {
      data = data.filter(r => r.package_group_id == null);
    } else if (filterGroup !== "all") {
      data = data.filter(r => r.package_group_id === filterGroup);
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      data = data.filter(r =>
        (r.customer_name ?? "").toLowerCase().includes(q) ||
        (r.customer_phone ?? "").toLowerCase().includes(q) ||
        (r.shoot_date ?? "").includes(q) ||
        (r.order_code ?? "").toLowerCase().includes(q)
      );
    }

    return data;
  }, [rows, tab, filterStatus, filterStaff, filterGroup, search, viewer?.id]);

  const activeFilterCount = [filterStatus, filterStaff].filter(f => f !== "all").length
    + (filterGroup !== "all" ? 1 : 0);

  const handleModalClose = () => {
    setSelected(null);
    qc.invalidateQueries({ queryKey: ["photoshop-booking-view", shootMonth] });
  };

  // Khi rows trả về, tìm row khớp pendingBookingId → mở DetailModal & clear pending
  useEffect(() => {
    if (pendingBookingId == null || isLoading) return;
    const row = rows.find(r => r.booking_id === pendingBookingId || r.parent_id === pendingBookingId);
    if (row) {
      setSelected(row);
      setPendingBookingResolved(true);
      setPendingBookingId(null);
      setPendingBookingContext(null);
      setPendingBookingError(null);
    } else if (pendingBookingRows.length > 0) {
      setSelected(pendingBookingRows[0]);
      setPendingBookingResolved(true);
      setPendingBookingId(null);
      setPendingBookingContext(null);
      setPendingBookingError(null);
    } else if (pendingBookingContext === "calendar") {
      setPendingBookingError("Không có đơn hậu kỳ cho booking/show này");
      setPendingBookingResolved(true);
      setPendingBookingId(null);
      setPendingBookingContext(null);
    }
  }, [pendingBookingId, rows, pendingBookingRows, isLoading, pendingBookingContext]);

  return (
    <div className="p-3 sm:p-4 max-w-2xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Tiến độ Hậu kỳ</h1>
          <p className="text-sm text-muted-foreground">Quản lý hậu kỳ theo đơn hàng</p>
        </div>
        <BarChart3 size={22} className="text-muted-foreground" />
      </div>

      {/* Deep-link banner: đang tìm show từ Lịch chụp */}
      {pendingBookingId != null && !pendingBookingResolved && (
        <div className="rounded-xl border border-violet-200 bg-violet-50 dark:bg-violet-900/20 dark:border-violet-800 px-3 py-2 flex items-center gap-2 text-sm text-violet-700 dark:text-violet-300">
          <Loader2 size={14} className="animate-spin flex-shrink-0" />
          <span className="flex-1">Đang mở hồ sơ hậu kỳ của show #{pendingBookingId}…</span>
          <button onClick={() => setPendingBookingId(null)} className="text-xs underline hover:no-underline">Huỷ</button>
        </div>
      )}
      {pendingBookingError && (
        <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-3 py-2 flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle size={14} className="flex-shrink-0" />
          <span className="flex-1">{pendingBookingError}</span>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2.5">
        <StatCard label={isAdmin ? "Đang làm" : "Tôi đang làm"} value={stats?.myActive ?? 0} icon={UserCheck} color="blue" />
        <StatCard label="Xong tháng này" value={stats?.myDoneThisMonth ?? 0} icon={CheckCircle2} color="green" />
        <StatCard label={stats?.priorBacklog ? "Đơn tồn (có nợ)" : "Đơn tồn"} value={stats?.backlog ?? 0} icon={AlertTriangle} color="red" sub={stats?.priorBacklog ? `${stats.priorBacklog} nợ tháng trước` : undefined} />
      </div>

      {/* Month picker - always visible */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
          <Calendar size={13} />
          <span>Tháng chụp:</span>
        </div>
        <select
          value={shootMonth}
          onChange={e => setShootMonth(e.target.value)}
          className="border border-border rounded-lg px-2.5 py-1.5 text-xs bg-background font-medium"
        >
          <option value="all">Tất cả tháng</option>
          {Array.from({ length: 13 }, (_, i) => {
            const d = new Date(now.getFullYear(), now.getMonth() - 6 + i, 1);
            const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const lbl = d.toLocaleDateString("vi-VN", { month: "long", year: "numeric" });
            return <option key={v} value={v}>{lbl}</option>;
          })}
        </select>
        <button
          onClick={() => setShootMonth(defaultMonth)}
          className={`text-xs px-2 py-1.5 rounded-lg border transition-colors ${shootMonth === defaultMonth ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border text-muted-foreground hover:text-foreground"}`}
        >
          Tháng này
        </button>
        {shootMonth !== "all" && (stats?.priorBacklog ?? 0) > 0 && (
          <span className="text-[11px] text-red-600 font-medium">
            +{stats?.priorBacklog} nợ từ tháng trước
          </span>
        )}
      </div>

      {/* Search + Filter toggle */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className="w-full pl-9 pr-3 py-2 rounded-xl border border-border bg-background text-sm placeholder:text-muted-foreground"
            placeholder="Tìm mã đơn, tên khách, SĐT..."
            value={search} onChange={e => setSearch(e.target.value)} />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground">
              <X size={14} />
            </button>
          )}
        </div>
        <button onClick={() => setShowFilters(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${showFilters || activeFilterCount > 0 ? "bg-primary text-primary-foreground border-primary" : "border-border bg-background text-muted-foreground hover:text-foreground"}`}>
          <Filter size={14} />
          {activeFilterCount > 0 ? `Lọc (${activeFilterCount})` : "Lọc"}
        </button>
      </div>

      {/* Dropdown filters */}
      {showFilters && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-muted-foreground font-medium mb-1 block uppercase tracking-wide">Trạng thái</label>
            <select className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
              value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="all">Mọi trạng thái</option>
              <option value="chua_nhan">Chưa nhận</option>
              <option value="dang_pts">Đang PTS</option>
              <option value="da_pts">Đã PTS</option>
              <option value="da_fix">Đã fix</option>
              <option value="da_gui_in">Đã gửi in</option>
              <option value="tam_hoan">Tạm hoãn</option>
              <option value="xong_show">Xong show</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground font-medium mb-1 block uppercase tracking-wide">Nhân viên</label>
            <select className="w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
              value={filterStaff} onChange={e => setFilterStaff(e.target.value)}>
              <option value="all">Mọi nhân viên</option>
              {staffsInData.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${tab === t.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Bước 3: Filter theo nhóm dịch vụ — chips lấy từ service_groups */}
      {(groupsInData.length > 0 || hasUngrouped) && (
        <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-none">
          <button
            key="group-all"
            onClick={() => setFilterGroup("all")}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              filterGroup === "all"
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:text-foreground"
            }`}
          >
            Tất cả nhóm
          </button>
          {groupsInData.map(g => (
            <button
              key={`group-${g.id}`}
              onClick={() => setFilterGroup(g.id)}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                filterGroup === g.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:text-foreground"
              }`}
            >
              {g.name}
              {shootMonth !== "all" && (
                <>
                  <span className="ml-1 opacity-70">({groupCountsInMonth.get(g.id) ?? 0})</span>
                  {(groupCountsBacklog.get(g.id) ?? 0) > 0 && (
                    <span className="ml-0.5 text-red-500 font-semibold">+{groupCountsBacklog.get(g.id)!} nợ</span>
                  )}
                </>
              )}
            </button>
          ))}
          {hasUngrouped && (
            <button
              key="group-ungrouped"
              onClick={() => setFilterGroup("ungrouped")}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                filterGroup === "ungrouped"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:text-foreground"
              }`}
            >
              Khác
            </button>
          )}
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
          <Loader2 size={20} className="animate-spin" /><span>Đang tải...</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <CheckCircle2 size={36} className="mx-auto mb-2 opacity-30" />
          <div className="text-sm">
            {rows.length === 0 && shootMonth !== "all"
              ? "Không có đơn trong tháng này — chọn Tất cả tháng hoặc tháng trước (vd: tháng 5)"
              : filterGroup !== "all"
                ? "Không có đơn nhóm này trong tháng đang chọn — đổi Tháng chụp hoặc chọn Tất cả tháng"
                : "Không có đơn hàng nào"}
          </div>
          {filtered.length === 0 && rows.length > 0 && (search || activeFilterCount > 0) && (
            <div className="text-xs mt-1 opacity-60">Thử xóa bộ lọc</div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-muted-foreground px-1">{filtered.length} đơn hàng</div>
          {(() => {
            const backlogRows = filtered.filter(r => r.list_section === "backlog");
            const monthRows = filtered.filter(r => r.list_section !== "backlog");
            return (
              <>
                {backlogRows.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 px-1 text-xs font-semibold text-red-600">
                      <AlertTriangle size={13} />
                      Nợ từ tháng trước ({backlogRows.length})
                    </div>
                    {backlogRows.map(row => (
                      <BookingCard key={`backlog-${row.booking_id}`} row={row} onClick={() => setSelected(row)} />
                    ))}
                  </div>
                )}
                {monthRows.length > 0 && (
                  <div className="space-y-2">
                    {backlogRows.length > 0 && shootMonth !== "all" && (
                      <div className="text-xs font-semibold text-muted-foreground px-1 pt-1">
                        Chụp {formatMonth(shootMonth)}
                      </div>
                    )}
                    {monthRows.map(row => (
                      <BookingCard key={row.booking_id} row={row} onClick={() => setSelected(row)} />
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <DetailModal row={selected} onClose={handleModalClose}
          staffList={staffList} isAdmin={isAdmin}
          viewerId={viewer?.id ?? null} viewerName={viewer?.name ?? ""} />
      )}
    </div>
  );
}
