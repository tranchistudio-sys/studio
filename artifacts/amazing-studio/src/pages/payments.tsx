import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { successFeedback } from "@/lib/feedback";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search, CreditCard, Banknote, Phone, Clock,
  X, Upload, Eye, AlertCircle, Receipt, ChevronDown,
  Sparkles, ListFilter, History, TrendingUp, ChevronRight,
  CalendarDays, Layers, CheckCircle, Loader2, Download,
  Plus, PackageOpen, Ban,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getImageSrc } from "@/lib/imageUtils";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function fetchJson<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: authHeaders(opts.headers) });
  if (!res.ok) {
    const j = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(j.error ?? `Lỗi ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function authFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...opts, headers: authHeaders(opts.headers) });
}

const fmtVND = (n: number) => (n ?? 0).toLocaleString("vi-VN") + "đ";
const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
};
// Hiển thị "DD/MM/YYYY HH:mm" cho phiếu cọc — phản ánh thời điểm thực tế nhận tiền.
// Pin timeZone Asia/Ho_Chi_Minh để giờ luôn đúng dù device user ở tz khác.
const fmtDateTime = (d: string | Date | null | undefined) => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  });
};
const today = () => new Date().toISOString().split("T")[0];
// Lấy ngày + giờ "HH:mm" theo giờ VN — dùng để default cho phiếu thu lẻ.
const nowVnLocalParts = () => {
  const d = new Date();
  const date = d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }); // YYYY-MM-DD
  const time = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Ho_Chi_Minh" });
  return { date, time };
};
const vnYearMonth = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).slice(0, 7);
const splitYearMonth = (ym: string) => {
  const [y, m] = ym.split("-");
  return { year: y, month: m };
};
const buildMonthOptions = (anchorYm: string) => {
  const [ay] = anchorYm.split("-").map(Number);
  const items: { v: string; label: string }[] = [];
  for (let y = ay - 2; y <= ay + 1; y++) {
    for (let m = 1; m <= 12; m++) {
      const v = `${y}-${String(m).padStart(2, "0")}`;
      items.push({
        v,
        label: new Date(y, m - 1, 1).toLocaleDateString("vi-VN", { month: "long", year: "numeric" }),
      });
    }
  }
  return items;
};
const AD_HOC_CATEGORIES = ["Thuê đồ lẻ", "Phụ kiện", "Mâm quả", "Khác"] as const;

type Booking = {
  id: number;
  orderCode: string;
  customerId: number;
  customerName: string;
  customerPhone: string;
  customerCode?: string;
  packageType: string;
  totalAmount: number;
  discountAmount?: number;
  paidAmount: number;
  remainingAmount: number;
  status: string;
  shootDate: string;
  createdAt?: string;
  latestPaymentAt?: string | null;
  notes?: string;
  isParentContract?: boolean;
  serviceCount?: number;
};

type Payment = {
  id: number;
  bookingId?: number;
  amount: number;
  paymentMethod: string;
  paymentType: string;
  collectorName?: string;
  bankName?: string;
  proofImageUrl?: string;
  proofImageUrls?: string[];
  paidDate?: string;
  notes?: string;
  paidAt: string;
  status?: string | null;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
};

type RecentPaymentItem = {
  id: number;
  bookingId: number | null;
  rentalId: number | null;
  amount: number;
  paymentMethod: string;
  paymentType: string;
  collectorName: string | null;
  bankName: string | null;
  proofImageUrl: string | null;
  proofImageUrls?: string[] | null;
  paidDate: string | null;
  paidAt: string | null;
  notes: string | null;
  payerName?: string | null;
  payerPhone?: string | null;
  description?: string | null;
  adHocCategory?: string | null;
  customerName: string | null;
  customerPhone: string | null;
  orderCode: string | null;
  packageType: string | null;
  shootDate?: string | null;
  totalAmount: number;
  discountAmount: number;
  paidAmount: number;
  remainingAmount: number;
  status: string | null;
  isParentContract: boolean;
  paymentCount: number;
  paymentStatus?: string | null;
  voidedAt?: string | null;
  voidedBy?: string | null;
  voidReason?: string | null;
};

type RecentData = {
  payments: RecentPaymentItem[];
  summary: { count: number; total: number };
};

type Period = "today" | "7days" | "month";
type TimeView = "shoot" | "payment";

const METHOD_LABEL: Record<string, string> = {
  cash: "Tiền mặt",
  bank_transfer: "Chuyển khoản",
};

const STATUS_CFG: Record<string, { label: string; dot: string }> = {
  pending:     { label: "Chờ xác nhận",   dot: "bg-yellow-400" },
  confirmed:   { label: "Đã xác nhận",    dot: "bg-blue-400"   },
  in_progress: { label: "Đang thực hiện", dot: "bg-purple-400" },
  completed:   { label: "Hoàn thành",     dot: "bg-green-400"  },
  cancelled:   { label: "Đã hủy",         dot: "bg-red-400"    },
};

/* ─── BookingRow ──────────────────────────── */
function BookingRow({
  b,
  selected,
  onClick,
  onQuickPay,
  showTag,
}: {
  b: Booking;
  selected: boolean;
  onClick: () => void;
  onQuickPay?: (b: Booking) => void;
  showTag?: "new" | "owed" | "deposited" | "recent";
}) {
  const TAG: Record<string, { label: string; cls: string }> = {
    new:       { label: "Mới tạo",   cls: "bg-blue-100 text-blue-700"   },
    owed:      { label: "Còn nợ",    cls: "bg-red-100 text-red-700"     },
    deposited: { label: "Vừa cọc",   cls: "bg-amber-100 text-amber-700" },
    recent:    { label: "Gần đây",   cls: "bg-gray-100 text-gray-600"   },
  };

  const tag = showTag ? TAG[showTag] : null;
  const statusCfg = STATUS_CFG[b.status];

  const isPaid        = b.remainingAmount <= 0;
  const isPartialPaid = !isPaid && b.paidAmount > 0;
  const isUnpaid      = !isPaid && b.paidAmount <= 0;

  const avatarCls = selected
    ? "bg-primary text-primary-foreground"
    : isPaid
      ? "bg-green-100 text-green-700"
      : isPartialPaid
        ? "bg-amber-100 text-amber-700"
        : "bg-red-100 text-red-600";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left px-3 py-3 transition-all border-b last:border-0",
        selected
          ? "bg-primary/8 border-border/30"
          : isPaid
            ? "border-green-100 hover:bg-green-50/40 active:bg-green-50/60"
            : isPartialPaid
              ? "border-amber-100 hover:bg-amber-50/40 active:bg-amber-50/60"
              : "border-red-100 hover:bg-red-50/30 active:bg-red-50/50"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Avatar + info */}
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={cn(
            "w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0",
            avatarCls
          )}>
            {b.customerName?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div className="min-w-0">
            {/* Dòng 1: Tên + tag */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-semibold text-foreground leading-tight">{b.customerName}</span>
              {tag && (
                <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-semibold", tag.cls)}>
                  {tag.label}
                </span>
              )}
              {isPaid && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-green-100 text-green-700">
                  ✓ Đủ
                </span>
              )}
              {isPartialPaid && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-700">
                  ½ Một phần
                </span>
              )}
              {isUnpaid && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-red-100 text-red-600">
                  ✗ Chưa thu
                </span>
              )}
            </div>
            {/* Dòng 2: SĐT · Mã đơn · Gói */}
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5 flex-wrap">
              <span className="flex items-center gap-0.5">
                <Phone className="w-2.5 h-2.5" />
                {b.customerPhone}
              </span>
              {b.orderCode && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="font-mono font-medium text-primary/70">{b.orderCode}</span>
                </>
              )}
              {b.isParentContract && (b.serviceCount ?? 0) > 0 && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="text-[10px] px-1 py-0.5 rounded bg-violet-100 text-violet-700 font-semibold">
                    {b.serviceCount} dịch vụ
                  </span>
                </>
              )}
              {!b.isParentContract && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="truncate max-w-[120px]">{b.packageType}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Số tiền + ngày + nút thu nhanh */}
        <div className="text-right flex-shrink-0 flex flex-col items-end gap-0.5">
          {isPaid ? (
            <p className="text-sm font-bold text-green-600">{fmtVND(b.totalAmount)}</p>
          ) : (
            <p className="text-sm font-bold text-red-600">−{fmtVND(b.remainingAmount)}</p>
          )}
          <p className="text-[10px] text-muted-foreground">
            {b.latestPaymentAt
              ? fmtDate(b.latestPaymentAt)
              : fmtDate(b.createdAt ?? b.shootDate)}
          </p>
          <div className="flex items-center justify-end gap-1">
            <span className={cn("w-1.5 h-1.5 rounded-full", statusCfg?.dot ?? "bg-gray-300")} />
            <span className="text-[9px] text-muted-foreground">{statusCfg?.label ?? b.status}</span>
          </div>
          {!isPaid && onQuickPay && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onQuickPay(b); }}
              className="mt-1 text-[10px] px-2 py-0.5 rounded-full bg-primary text-primary-foreground font-semibold hover:bg-primary/90 active:scale-95 transition-all"
            >
              Thu thêm ›
            </button>
          )}
        </div>
      </div>
    </button>
  );
}

/* ─── SmartSearchBox ─────────────────────── */
function SmartSearchBox({
  suggestions,
  suggestionsLoading,
  selectedId,
  onSelect,
}: {
  suggestions: Booking[];
  suggestionsLoading: boolean;
  selectedId?: number;
  onSelect: (b: Booking) => void;
}) {
  const [query, setQuery]             = useState("");
  const [focused, setFocused]         = useState(false);
  const [results, setResults]         = useState<Booking[]>([]);
  const [searching, setSearching]     = useState(false);
  const [mode, setMode]               = useState<"suggestions" | "search">("suggestions");
  const timer                         = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef                      = useRef<HTMLInputElement>(null);

  const doSearch = useCallback((q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setResults([]); setMode("suggestions"); return; }
    setMode("search");
    setSearching(true);
    timer.current = setTimeout(async () => {
      try {
        const res = await fetchJson<Booking[]>(`/api/payments/search?q=${encodeURIComponent(q)}`);
        setResults(res);
      } finally { setSearching(false); }
    }, 280);
  }, []);

  const clear = () => {
    setQuery("");
    setResults([]);
    setMode("suggestions");
    inputRef.current?.focus();
  };

  const handleSelect = (b: Booking) => {
    onSelect(b);
    setFocused(false);
    setQuery(`${b.customerName} — ${b.customerPhone}`);
  };

  const showDropdown = focused && (mode === "suggestions" || query.trim().length > 0);
  const listItems: Booking[] = mode === "search" ? results : suggestions;

  // Tag helper for suggestions mode
  const getSuggestionTag = (b: Booking): "new" | "owed" | "deposited" | "recent" => {
    const ageMs = Date.now() - new Date(b.createdAt ?? 0).getTime();
    const isNew = ageMs < 3 * 24 * 3600 * 1000; // < 3 ngày
    if (b.remainingAmount > 0 && b.paidAmount > 0) return "deposited";
    if (b.remainingAmount > 0) return isNew ? "new" : "owed";
    return isNew ? "new" : "recent";
  };

  return (
    <div className="relative">
      {/* Input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          className={cn(
            "w-full pl-9 pr-10 py-3 border rounded-xl text-sm bg-background transition-all",
            "focus:outline-none focus:ring-2 focus:ring-primary/30",
            focused ? "border-primary/60 shadow-sm" : "border-border"
          )}
          placeholder="Nhập tên, số điện thoại hoặc mã đơn hàng..."
          value={query}
          onChange={e => { setQuery(e.target.value); doSearch(e.target.value); }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 160)}
          autoComplete="off"
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {searching && (
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          )}
          {query && !searching && (
            <button onClick={clear} className="text-muted-foreground hover:text-foreground p-0.5">
              <X className="w-4 h-4" />
            </button>
          )}
          {!query && (
            <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", focused && "rotate-180")} />
          )}
        </div>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute z-50 left-0 right-0 mt-1.5 bg-background border border-border rounded-2xl shadow-xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 bg-muted/40 border-b border-border/60">
            {mode === "suggestions" ? (
              <>
                <Sparkles className="w-3.5 h-3.5 text-primary" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Gợi ý nhanh · Đơn hàng ưu tiên
                </span>
                {suggestionsLoading && (
                  <div className="ml-auto w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                )}
              </>
            ) : (
              <>
                <ListFilter className="w-3.5 h-3.5 text-primary" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Kết quả tìm kiếm
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">{results.length} kết quả</span>
              </>
            )}
          </div>

          {/* List */}
          <div className="max-h-72 overflow-y-auto overscroll-contain">
            {listItems.length === 0 ? (
              mode === "search" && !searching ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  <Search className="w-6 h-6 mx-auto mb-1.5 opacity-30" />
                  Không tìm thấy hồ sơ khớp với "{query}"
                </div>
              ) : mode === "suggestions" && !suggestionsLoading ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  Chưa có đơn hàng nào đang hoạt động
                </div>
              ) : null
            ) : (
              listItems.map(b => (
                <BookingRow
                  key={b.id}
                  b={b}
                  selected={selectedId === b.id}
                  onClick={() => handleSelect(b)}
                  onQuickPay={(bk) => handleSelect(bk)}
                  showTag={mode === "suggestions" ? getSuggestionTag(b) : undefined}
                />
              ))
            )}
          </div>

          {mode === "suggestions" && listItems.length > 0 && (
            <div className="px-3 py-2 bg-muted/30 border-t border-border/40 text-[10px] text-muted-foreground text-center">
              Gõ tên, SĐT hoặc mã đơn để tìm kiếm thêm
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── VoidDialog ─────────────────────────── */
function VoidDialog({
  open, reason, loading, error, onReasonChange, onConfirm, onCancel,
}: {
  open: boolean; reason: string; loading: boolean; error: string | null;
  onReasonChange: (v: string) => void; onConfirm: () => void; onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-4 bg-black/50">
      <div className="bg-background rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Ban className="w-5 h-5 text-destructive flex-shrink-0" />
          <h3 className="text-base font-bold text-foreground">Huỷ phiếu thu</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Phiếu thu bị huỷ <span className="font-semibold text-foreground">không được tính vào tài chính</span> và vẫn hiển thị trong lịch sử với trạng thái "Đã huỷ". Thao tác này không thể hoàn tác.
        </p>
        <div>
          <label className="text-xs font-semibold text-foreground mb-1.5 block">
            Lý do huỷ <span className="text-destructive">*</span>
          </label>
          <textarea
            className="w-full border border-border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/40 bg-background"
            rows={3}
            placeholder="Nhập lý do huỷ phiếu..."
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
          />
        </div>
        {error && <p className="text-xs text-destructive font-medium">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="flex-1 px-4 py-2.5 rounded-xl border border-border text-sm font-semibold text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
          >
            Huỷ bỏ
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading || !reason.trim()}
            className="flex-1 px-4 py-2.5 rounded-xl bg-destructive text-destructive-foreground text-sm font-bold hover:bg-destructive/90 transition-colors disabled:opacity-50"
          >
            {loading ? "Đang xử lý..." : "Xác nhận huỷ"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── PaymentRow ─────────────────────────── */
function PaymentRow({
  p,
  newPaymentId,
  onSelect,
  onPreviewImage,
  isAdmin,
  onVoid,
}: {
  p: RecentPaymentItem;
  newPaymentId: number | null;
  onSelect: (p: RecentPaymentItem) => void;
  onPreviewImage: (url: string) => void;
  isAdmin?: boolean;
  onVoid?: (id: number) => void;
}) {
  const isCash     = p.paymentMethod === "cash";
  const isDeposit  = p.paymentType === "deposit";
  const isAdHoc    = p.paymentType === "ad_hoc";
  const isVoided   = p.paymentStatus === "voided";
  const isPaidFull = (p.remainingAmount ?? 0) <= 0;
  const txLabel    = isAdHoc ? "Thu lẻ"
                   : isDeposit ? "Đặt cọc"
                   : isPaidFull ? "Thu đủ"
                   : p.paymentCount <= 1 ? "Thu lần đầu"
                   : "Thu thêm";
  const txCls      = isAdHoc
    ? "bg-fuchsia-100 text-fuchsia-700"
    : isDeposit
    ? "bg-amber-100 text-amber-700"
    : isPaidFull
    ? "bg-green-100 text-green-700"
    : "bg-blue-100 text-blue-700";
  // Phiếu cọc: hiện DD/MM/YYYY HH:mm (thời điểm thực tế nhận tiền).
  // Phiếu thường: giữ format ngày + giờ riêng như cũ.
  const paidWhen   = isDeposit
    ? (p.paidAt ? fmtDateTime(p.paidAt) : (p.paidDate ? fmtDate(p.paidDate) : "—"))
    : (p.paidDate ? fmtDate(p.paidDate) : p.paidAt ? fmtDate(p.paidAt) : "—");
  const paidTime   = !isDeposit && p.paidAt
    ? new Date(p.paidAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <button
      onClick={() => onSelect(p)}
      className={cn(
        "w-full text-left px-4 py-3 hover:bg-muted/30 transition-colors flex items-start gap-3 group",
        p.id === newPaymentId && "bg-emerald-50 dark:bg-emerald-950/20"
      )}
    >
      {/* Phương thức icon */}
      <div className={cn(
        "w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
        isCash ? "bg-emerald-100 text-emerald-600" : "bg-blue-100 text-blue-600"
      )}>
        {isCash ? <Banknote className="w-4 h-4" /> : <CreditCard className="w-4 h-4" />}
      </div>

      {/* Thông tin chính */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-semibold text-foreground truncate">
            {p.customerName ?? "Khách lẻ"}
          </span>
          <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-semibold flex-shrink-0", isVoided ? "bg-red-100 text-red-600 line-through opacity-70" : txCls)}>
            {txLabel}
          </span>
          {isVoided && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-red-500 text-white flex-shrink-0 flex items-center gap-0.5">
              <Ban className="w-2.5 h-2.5" /> Đã huỷ
            </span>
          )}
          {p.isParentContract && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-violet-100 text-violet-700 flex-shrink-0 flex items-center gap-0.5">
              <Layers className="w-2.5 h-2.5" /> Đa DV
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5 flex-wrap">
          {p.customerPhone && (
            <span className="flex items-center gap-0.5">
              <Phone className="w-2.5 h-2.5" />{p.customerPhone}
            </span>
          )}
          {p.orderCode && (
            <>
              <span className="opacity-40">·</span>
              <span className="font-mono font-medium text-primary/70">{p.orderCode}</span>
            </>
          )}
          <span className="opacity-40">·</span>
          <span className="flex items-center gap-0.5">
            <CalendarDays className="w-2.5 h-2.5" />{paidWhen}{paidTime && ` ${paidTime}`}
          </span>
          {p.collectorName && (
            <>
              <span className="opacity-40">·</span>
              <span>{p.collectorName}</span>
            </>
          )}
        </div>
        {isVoided && (p.voidedBy || p.voidReason) && (
          <p className="text-[11px] text-red-500 italic mt-0.5 truncate">
            {p.voidedBy && <span>Huỷ bởi: <strong>{p.voidedBy}</strong></span>}
            {p.voidedBy && p.voidReason && <span className="opacity-60"> · </span>}
            {p.voidReason && <span>{p.voidReason}</span>}
          </p>
        )}
        {!isVoided && p.notes && (
          <p className="text-[11px] text-muted-foreground italic mt-0.5 truncate">"{p.notes}"</p>
        )}
        {isAdHoc && (p.description || p.adHocCategory) && (
          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
            {p.adHocCategory && <span className="font-semibold text-fuchsia-700">{p.adHocCategory}</span>}
            {p.adHocCategory && p.description && <span className="opacity-50"> · </span>}
            {p.description}
          </p>
        )}

        {/* ── Công nợ tổng thể của hồ sơ — không áp dụng cho phiếu thu lẻ ── */}
        {!isAdHoc && (
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          {isPaidFull ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold">
              <CheckCircle className="w-2.5 h-2.5" /> Đã thu đủ
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-bold">
                <AlertCircle className="w-2.5 h-2.5" /> Còn nợ: {fmtVND(p.remainingAmount)}
              </span>
              <span className="text-[10px] text-muted-foreground">
                Đã thu: <span className="font-medium text-foreground">{fmtVND(p.paidAmount)}</span>
                {" "}/ {fmtVND(p.totalAmount - (p.discountAmount ?? 0))}
              </span>
            </>
          )}
        </div>
        )}
      </div>

      {/* Số tiền phiếu thu + ảnh + nút Thu tiền / Huỷ */}
      <div className="text-right flex-shrink-0 flex items-start gap-2 mt-0.5">
        <div className="flex flex-col items-end gap-1">
          <p className={cn("text-sm font-bold", isVoided ? "text-muted-foreground line-through" : isCash ? "text-emerald-600" : "text-blue-600")}>
            +{fmtVND(p.amount)}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}
          </p>
          {isVoided && p.voidReason && (
            <p className="text-[10px] text-red-500 max-w-[110px] text-right line-clamp-2 italic">
              "{p.voidReason}"
            </p>
          )}
          {isAdmin && !isVoided && onVoid && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onVoid(p.id); }}
              className="mt-0.5 text-[10px] px-2 py-0.5 rounded-full border border-red-200 text-red-500 hover:bg-red-50 font-semibold flex items-center gap-0.5 transition-colors"
              title="Huỷ phiếu thu này"
            >
              <Ban className="w-2.5 h-2.5" /> Huỷ
            </button>
          )}
          {/* CTA Thu tiền: chỉ hiện khi còn nợ VÀ phiếu này đã gắn với booking */}
          {!isAdHoc && !isPaidFull && p.bookingId && !isVoided && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSelect(p); }}
              className="mt-0.5 text-[10px] px-2.5 py-1 rounded-full bg-primary text-primary-foreground font-bold hover:bg-primary/90 active:scale-95 transition-all whitespace-nowrap shadow-sm"
            >
              💰 Thu tiền
            </button>
          )}
          {!isAdHoc && !isPaidFull && !p.bookingId && (
            <span className="mt-0.5 text-[9px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium whitespace-nowrap" title="Phiếu này chưa gắn với đơn hàng">
              Không có đơn
            </span>
          )}
        </div>
        {(() => {
          const urls = (p.proofImageUrls && p.proofImageUrls.length)
            ? p.proofImageUrls
            : (p.proofImageUrl ? [p.proofImageUrl] : []);
          if (urls.length === 0) return null;
          const thumbs = urls.slice(0, 3);
          const extra = urls.length - thumbs.length;
          return (
            <div className="flex items-center gap-1 flex-shrink-0">
              {thumbs.map((url, i) => (
                <button
                  key={`${url}-${i}`}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onPreviewImage(getImageSrc(url) || url); }}
                  className="flex-shrink-0"
                >
                  <img
                    src={getImageSrc(url) || url}
                    alt="Biên lai"
                    className="w-11 h-11 rounded-lg object-cover aspect-square border border-border"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                </button>
              ))}
              {extra > 0 && (
                <span className="text-[10px] font-semibold text-muted-foreground">+{extra}</span>
              )}
            </div>
          );
        })()}
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors flex-shrink-0 mt-0.5" />
      </div>
    </button>
  );
}

/* ─── Monthly List Section ───────────────── */
type MonthlyBooking = {
  id: number; orderCode: string; shootDate: string; customerName: string; customerPhone: string;
  packageType: string; serviceLabel: string; totalAmount: number; discountAmount: number;
  paidAmount: number; remainingAmount: number; collectedInPeriod: number; status: string;
  latestPaidAt?: string | null;
  payments: Array<{
    id: number; amount: number; paidAt: string; note: string | null; paymentType: string;
    proofImageUrl?: string | null; proofImageUrls?: string[] | null;
  }>;
};
type MonthlyAdHocPayment = {
  id: number; amount: number; paymentMethod: string; paidAt: string; paidDate?: string | null;
  payerName?: string | null; payerPhone?: string | null;
  description?: string | null; adHocCategory?: string | null;
  collectorName?: string | null; bankName?: string | null; notes?: string | null;
  proofImageUrl?: string | null; proofImageUrls?: string[] | null;
  paymentStatus?: string | null; voidedAt?: string | null; voidedBy?: string | null; voidReason?: string | null;
};
type MonthlyData = {
  viewMode: string; month: string;
  summary: { totalBookings: number; totalAmount: number; totalCollected: number; totalOwed: number; adHocCount?: number; adHocTotal?: number };
  bookings: MonthlyBooking[];
  adHocPayments?: MonthlyAdHocPayment[];
};


function monthlyRowsToRecentItems(data: MonthlyData | undefined): RecentPaymentItem[] {
  if (!data) return [];
  const items: RecentPaymentItem[] = [];
  for (const b of data.bookings ?? []) {
    const pays = b.payments?.length ? b.payments : [{
      id: -b.id,
      amount: b.paidAmount,
      paidAt: b.latestPaidAt ?? b.shootDate,
      note: null,
      paymentType: "payment",
      proofImageUrl: null,
      proofImageUrls: null,
    }];
    for (const p of pays) {
      items.push({
        id: p.id,
        bookingId: b.id,
        rentalId: null,
        amount: p.amount,
        paymentMethod: "cash",
        paymentType: p.paymentType,
        collectorName: null,
        bankName: null,
        proofImageUrl: p.proofImageUrl ?? null,
        proofImageUrls: p.proofImageUrls ?? null,
        paidDate: null,
        paidAt: p.paidAt,
        notes: p.note,
        customerName: b.customerName,
        customerPhone: b.customerPhone,
        orderCode: b.orderCode,
        packageType: b.packageType,
        shootDate: b.shootDate,
        totalAmount: b.totalAmount,
        discountAmount: b.discountAmount,
        paidAmount: b.paidAmount,
        remainingAmount: b.remainingAmount,
        status: b.status,
        isParentContract: false,
        paymentCount: b.payments?.length ?? 0,
      });
    }
  }
  for (const ap of data.adHocPayments ?? []) {
    items.push({
      id: ap.id,
      bookingId: null,
      rentalId: null,
      amount: ap.amount,
      paymentMethod: ap.paymentMethod,
      paymentType: "ad_hoc",
      collectorName: ap.collectorName ?? null,
      bankName: ap.bankName ?? null,
      proofImageUrl: ap.proofImageUrl ?? null,
      proofImageUrls: ap.proofImageUrls ?? null,
      paidDate: ap.paidDate ?? null,
      paidAt: ap.paidAt,
      notes: ap.notes ?? ap.description ?? null,
      payerName: ap.payerName ?? null,
      payerPhone: ap.payerPhone ?? null,
      description: ap.description ?? null,
      adHocCategory: ap.adHocCategory ?? null,
      customerName: ap.payerName ?? null,
      customerPhone: ap.payerPhone ?? null,
      orderCode: null,
      packageType: ap.adHocCategory ?? "Thu lẻ",
      shootDate: null,
      totalAmount: ap.amount,
      discountAmount: 0,
      paidAmount: ap.amount,
      remainingAmount: 0,
      status: "completed",
      isParentContract: false,
      paymentCount: 1,
      paymentStatus: ap.paymentStatus ?? null,
      voidedAt: ap.voidedAt ?? null,
      voidedBy: ap.voidedBy ?? null,
      voidReason: ap.voidReason ?? null,
    });
  }
  return items;
}

function MonthlyListSection({
  effectiveIsAdmin,
  onSelectBooking,
  onVoid,
  defaultMonthKey,
}: {
  effectiveIsAdmin: boolean;
  onSelectBooking: (b: Booking) => void;
  onVoid?: (id: number) => void;
  defaultMonthKey?: string;
}) {
  const [month, setMonth] = useState(defaultMonthKey ?? vnYearMonth());
  const [viewMode, setViewMode] = useState<"shootMonth" | "collectMonth">("collectMonth");
  const [open, setOpen] = useState(true);
  const [exportStatus, setExportStatus] = useState<"all" | "owed" | "paid">("all");
  const [exporting, setExporting] = useState(false);
  const [thumbPreviewUrl, setThumbPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (defaultMonthKey) setMonth(defaultMonthKey);
  }, [defaultMonthKey]);

  const { data, isLoading } = useQuery<MonthlyData>({
    queryKey: ["payments-monthly-list", month, viewMode],
    queryFn: () => fetchJson(`/api/payments/monthly-list?month=${month}&viewMode=${viewMode}`),
    staleTime: 30_000,
  });

  const months = useMemo(() => buildMonthOptions(defaultMonthKey ?? month), [defaultMonthKey, month]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ month, viewMode, status: exportStatus });
      const resp = await authFetch(`/api/payments/export?${params.toString()}`);
      if (!resp.ok) throw new Error("Export failed");
      const blob = await resp.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cong-no-${month}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      alert("Có lỗi khi xuất file. Vui lòng thử lại.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Tổng hợp theo tháng</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-lg overflow-hidden border text-xs">
            <button
              onClick={() => setViewMode("collectMonth")}
              className={`px-2.5 py-1.5 ${viewMode === "collectMonth" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
            >
              Tháng thu tiền
            </button>
            <button
              onClick={() => setViewMode("shootMonth")}
              className={`px-2.5 py-1.5 border-l ${viewMode === "shootMonth" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
            >
              Tháng chụp
            </button>
          </div>
          <select
            value={month}
            onChange={e => setMonth(e.target.value)}
            className="border rounded-lg px-2 py-1.5 text-xs bg-background"
          >
            {months.map(m => <option key={m.v} value={m.v}>{m.label}</option>)}
          </select>

          {/* ── Nút xuất Excel ── */}
          <div className="flex items-center gap-1.5">
            <select
              value={exportStatus}
              onChange={e => setExportStatus(e.target.value as "all" | "owed" | "paid")}
              className="border rounded-lg px-2 py-1.5 text-xs bg-background"
              title="Lọc trạng thái khi xuất"
            >
              <option value="all">Tất cả</option>
              <option value="owed">Còn nợ</option>
              <option value="paid">Đã thu đủ</option>
            </select>
            <button
              onClick={handleExport}
              disabled={exporting}
              title="Xuất danh sách công nợ ra file CSV (mở được bằng Excel)"
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 active:bg-emerald-200 transition-colors disabled:opacity-50 font-semibold"
            >
              {exporting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Download className="w-3.5 h-3.5" />}
              {exporting ? "Đang xuất..." : "Xuất Excel"}
            </button>
          </div>

          <button onClick={() => setOpen(v => !v)} className="text-muted-foreground hover:text-foreground">
            <ChevronDown className={`w-4 h-4 transition-transform ${open ? "" : "-rotate-90"}`} />
          </button>
        </div>
      </div>

      {open && (
        <>
          {effectiveIsAdmin && data?.summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 border-b">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Số đơn</p>
                <p className="text-lg font-bold">{data.summary.totalBookings}</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Tổng HĐ</p>
                <p className="text-lg font-bold text-violet-700">{fmtVND(data.summary.totalAmount)}</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">{viewMode === "collectMonth" ? "Đã thu (kỳ này)" : "Đã thu"}</p>
                <p className="text-lg font-bold text-emerald-700">{fmtVND(data.summary.totalCollected)}</p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Còn nợ</p>
                <p className="text-lg font-bold text-amber-700">{fmtVND(data.summary.totalOwed)}</p>
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Đang tải...</div>
          ) : !data?.bookings?.length && !(data?.adHocPayments?.length) ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              Không có đơn hàng / phiếu thu lẻ nào trong tháng {month.slice(5, 7)}/{month.slice(0, 4)}
            </div>
          ) : (
            <div className="divide-y">
              {viewMode === "collectMonth" && (data?.adHocPayments?.length ?? 0) > 0 && (
                <div className="bg-fuchsia-50/40">
                  <div className="px-4 py-2 border-b bg-fuchsia-100/60 flex items-center gap-2">
                    <PackageOpen className="w-4 h-4 text-fuchsia-700" />
                    <span className="text-xs font-bold text-fuchsia-800">
                      Thu lẻ trong kỳ ({data!.adHocPayments!.length})
                    </span>
                    <span className="ml-auto text-xs font-bold text-fuchsia-800">
                      {fmtVND(data!.summary?.adHocTotal ?? 0)}
                    </span>
                  </div>
                  {data!.adHocPayments!.map(ap => {
                    const urls = (ap.proofImageUrls && ap.proofImageUrls.length)
                      ? ap.proofImageUrls
                      : (ap.proofImageUrl ? [ap.proofImageUrl] : []);
                    const thumbs = urls.slice(0, 3);
                    const extra = urls.length - thumbs.length;
                    const isVoided = ap.paymentStatus === "voided";
                    return (
                      <div key={ap.id} className={cn("px-4 py-3 border-b last:border-b-0 flex items-start gap-3", isVoided && "opacity-60 bg-red-50/30")}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-100 text-fuchsia-700 font-bold">
                              <PackageOpen className="w-2.5 h-2.5" /> Thu lẻ
                            </span>
                            {isVoided && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full bg-red-500 text-white font-bold">
                                <Ban className="w-2.5 h-2.5" /> Đã huỷ
                              </span>
                            )}
                            {ap.adHocCategory && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-200/70 text-fuchsia-800 font-semibold">
                                {ap.adHocCategory}
                              </span>
                            )}
                            <span className="text-xs font-semibold text-foreground">
                              {ap.payerName || "Khách lẻ"}
                            </span>
                            {ap.payerPhone && (
                              <span className="text-[11px] text-muted-foreground">· {ap.payerPhone}</span>
                            )}
                          </div>
                          {ap.description && (
                            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{ap.description}</p>
                          )}
                          {isVoided && ap.voidReason && (
                            <p className="mt-1 text-xs text-red-600 italic">Lý do huỷ: {ap.voidReason}</p>
                          )}
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                            <CalendarDays className="w-3 h-3" />
                            <span>{fmtDateTime(ap.paidAt)}</span>
                            {ap.collectorName && <span>· Thu: {ap.collectorName}</span>}
                          </div>
                          {thumbs.length > 0 && (
                            <div className="mt-2 flex items-center gap-1.5">
                              {thumbs.map((u, i) => (
                                <span
                                  key={`${u}-${i}`}
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => { e.stopPropagation(); setThumbPreviewUrl(getImageSrc(u) || u); }}
                                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setThumbPreviewUrl(getImageSrc(u) || u); } }}
                                  className="block cursor-pointer"
                                >
                                  <img
                                    src={getImageSrc(u) || u}
                                    alt={`Bằng chứng ${i + 1}`}
                                    loading="lazy"
                                    className="w-12 h-12 rounded-lg object-cover border border-border"
                                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                  />
                                </span>
                              ))}
                              {extra > 0 && (
                                <span className="text-[10px] font-semibold text-muted-foreground">+{extra}</span>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="text-right flex-shrink-0 flex flex-col items-end gap-1">
                          <p className={cn("text-sm font-bold", isVoided ? "text-muted-foreground line-through" : ap.paymentMethod === "cash" ? "text-emerald-600" : "text-blue-600")}>
                            +{fmtVND(ap.amount)}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {ap.paymentMethod === "cash" ? "Tiền mặt" : "Chuyển khoản"}
                          </p>
                          {effectiveIsAdmin && !isVoided && onVoid && (
                            <button
                              type="button"
                              onClick={() => onVoid(ap.id)}
                              className="mt-0.5 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition-colors font-semibold"
                            >
                              <Ban className="w-2.5 h-2.5" /> Huỷ
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {data.bookings.map(b => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelectBooking({
                    id: b.id,
                    orderCode: b.orderCode,
                    customerId: 0,
                    customerName: b.customerName,
                    customerPhone: b.customerPhone,
                    packageType: b.packageType,
                    totalAmount: b.totalAmount,
                    discountAmount: b.discountAmount,
                    paidAmount: b.paidAmount,
                    remainingAmount: b.remainingAmount,
                    status: b.status,
                    shootDate: b.shootDate,
                  })}
                  className="w-full text-left px-4 py-3 hover:bg-muted/30 active:bg-muted/50 transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{b.customerName}</span>
                        <span className="text-xs text-muted-foreground font-mono">{b.orderCode}</span>
                        {b.remainingAmount > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Còn nợ</span>
                        )}
                        {b.remainingAmount <= 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">Đã đủ</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {b.customerPhone} • {b.serviceLabel || b.packageType} • Chụp: {fmtDate(b.shootDate)}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {effectiveIsAdmin && (
                        <>
                          <div className="text-xs text-muted-foreground">
                            {viewMode === "collectMonth" ? "Thu kỳ này" : "Đã thu"}:{" "}
                            <span className="font-semibold text-emerald-700">{fmtVND(viewMode === "collectMonth" ? b.collectedInPeriod : b.paidAmount)}</span>
                          </div>
                          {b.remainingAmount > 0 && (
                            <div className="text-xs text-amber-700 font-medium">
                              Còn: {fmtVND(b.remainingAmount)}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {b.payments?.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {b.payments.map(p => (
                        <span key={p.id} className="text-[10px] bg-muted px-2 py-0.5 rounded-full text-muted-foreground">
                          {p.paymentType === "deposit"
                            ? (p.paidAt ? fmtDateTime(p.paidAt) : fmtDate(p.paidAt))
                            : fmtDate(p.paidAt)}: {fmtVND(Number(p.amount))}
                        </span>
                      ))}
                    </div>
                  )}
                  {(() => {
                    const allUrls: string[] = [];
                    for (const p of (b.payments ?? [])) {
                      const urls = (p.proofImageUrls && p.proofImageUrls.length)
                        ? p.proofImageUrls
                        : (p.proofImageUrl ? [p.proofImageUrl] : []);
                      for (const u of urls) {
                        if (u && !allUrls.includes(u)) allUrls.push(u);
                      }
                    }
                    if (allUrls.length === 0) return null;
                    const thumbs = allUrls.slice(0, 3);
                    const extra = allUrls.length - thumbs.length;
                    return (
                      <div className="mt-2 flex items-center gap-1.5">
                        {thumbs.map((u, i) => (
                          <span
                            key={`${u}-${i}`}
                            role="button"
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); setThumbPreviewUrl(getImageSrc(u) || u); }}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setThumbPreviewUrl(getImageSrc(u) || u); } }}
                            className="block cursor-pointer"
                          >
                            <img
                              src={getImageSrc(u) || u}
                              alt={`Bằng chứng ${i + 1}`}
                              loading="lazy"
                              className="w-12 h-12 rounded-lg object-cover border border-border"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                            />
                          </span>
                        ))}
                        {extra > 0 && (
                          <span className="text-[10px] font-semibold text-muted-foreground">+{extra}</span>
                        )}
                      </div>
                    );
                  })()}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {thumbPreviewUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setThumbPreviewUrl(null)}
        >
          <img
            src={thumbPreviewUrl}
            alt="Bằng chứng"
            className="max-w-full max-h-full rounded-xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setThumbPreviewUrl(null)}
            className="absolute top-4 right-4 p-2 bg-white/20 hover:bg-white/30 text-white rounded-full"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Main Page ──────────────────────────── */
export default function PaymentsPage() {
  const qc = useQueryClient();
  const { effectiveIsAdmin, viewer, token: authToken } = useStaffAuth();

  /* Suggestions */
  const { data: suggestions = [], isLoading: suggestionsLoading } = useQuery<Booking[]>({
    queryKey: ["payment-suggestions"],
    queryFn: () => fetchJson("/api/payments/suggestions"),
    staleTime: 0,
  });

  /* Sheet + selected booking */
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);

  const {
    data: paymentHistory = [],
    refetch: refetchHistory,
    isFetched: paymentHistoryFetched,
  } = useQuery<Payment[]>({
    queryKey: ["payments", selectedBooking?.id],
    queryFn: () => fetchJson(`/api/payments?bookingId=${selectedBooking!.id}`),
    enabled: !!selectedBooking,
    staleTime: 0,
  });
  const depositProofImages = (() => {
    const dep = paymentHistory.find(p => p.paymentType === "deposit" && ((p.proofImageUrls && p.proofImageUrls.length) || p.proofImageUrl));
    if (!dep) return [] as string[];
    return (dep.proofImageUrls && dep.proofImageUrls.length) ? dep.proofImageUrls : (dep.proofImageUrl ? [dep.proofImageUrl] : []);
  })();

  const { data: defaultMonthData } = useQuery<{ month: string }>({
    queryKey: ["payments-default-month"],
    queryFn: () => fetchJson("/api/payments/default-month"),
    staleTime: 60_000,
  });
  const defaultMonthKey = defaultMonthData?.month ?? vnYearMonth();
  const defaultParts = splitYearMonth(defaultMonthKey);

  /* Recent payment history section */
  const [period] = useState<Period>("month");
  const [showAll, setShowAll] = useState(false);
  const [timeView, setTimeView] = useState<TimeView>("shoot");
  const [monthFilter, setMonthFilter] = useState(defaultParts.month);
  const [yearFilter, setYearFilter] = useState(defaultParts.year);
  const [preset, setPreset] = useState<"this" | "prev" | "next" | "all">("this");
  const recentLimit = showAll ? 50 : 10;

  useEffect(() => {
    if (!defaultMonthData?.month) return;
    const { year, month } = splitYearMonth(defaultMonthData.month);
    setYearFilter(year);
    setMonthFilter(month);
  }, [defaultMonthData?.month]);

  const selectedMonthKey = preset === "all" ? undefined : `${yearFilter}-${monthFilter}`;
  const overviewViewMode = timeView === "shoot" ? "shootMonth" : "collectMonth";

  const {
    data: overviewData,
    isLoading: overviewLoading,
    isError: overviewError,
    refetch: refetchOverview,
  } = useQuery<MonthlyData>({
    queryKey: ["payments-overview", selectedMonthKey, overviewViewMode],
    queryFn: () => fetchJson(`/api/payments/monthly-list?month=${selectedMonthKey}&viewMode=${overviewViewMode}`),
    enabled: preset !== "all" && !!selectedMonthKey,
    staleTime: 30_000,
  });

  const { data: recentData, refetch: refetchRecent, isFetching: recentFetching } = useQuery<RecentData>({
    queryKey: ["payments-recent", selectedMonthKey, period, recentLimit, preset],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(recentLimit) });
      if (preset === "all") params.set("period", "all");
      else if (selectedMonthKey) params.set("month", selectedMonthKey);
      else params.set("period", period);
      return fetchJson(`/api/payments/recent?${params.toString()}`);
    },
    staleTime: 0,
  });

  const refetchPaymentsSection = useCallback(async () => {
    await Promise.all([refetchRecent(), refetchOverview()]);
  }, [refetchRecent, refetchOverview]);

  const recentPayments  = recentData?.payments  ?? [];
  const recentSummary   = recentData?.summary   ?? { count: 0, total: 0 };

  const applyPreset = (next: "this" | "prev" | "next" | "all") => {
    setPreset(next);
    if (next === "all") return;
    const [y, m] = vnYearMonth().split("-").map(Number);
    const d = new Date(y, m - 1, 1);
    if (next === "prev") d.setMonth(d.getMonth() - 1);
    if (next === "next") d.setMonth(d.getMonth() + 1);
    setMonthFilter(String(d.getMonth() + 1).padStart(2, "0"));
    setYearFilter(String(d.getFullYear()));
  };

  const filteredPayments = useMemo(() => {
    if (preset !== "all" && overviewData) return monthlyRowsToRecentItems(overviewData);
    return recentPayments;
  }, [overviewData, preset, recentPayments]);

  const paymentSummary = useMemo(() => {
    if (preset !== "all" && overviewData?.summary) {
      const s = overviewData.summary;
      const totalNeed = s.totalAmount ?? 0;
      const totalPaid = s.totalCollected ?? 0;
      const totalRemain = s.totalOwed ?? 0;
      const percent = totalNeed > 0 ? Math.round((totalPaid / totalNeed) * 100) : 0;
      return { totalNeed, totalPaid, totalRemain, percent };
    }
    const seen = new Map<number | string, RecentPaymentItem>();
    for (const p of filteredPayments) {
      const key = p.bookingId != null ? p.bookingId : `payment-${p.id}`;
      if (!seen.has(key)) seen.set(key, p);
    }
    const source = Array.from(seen.values());
    const totalNeed   = source.reduce((s, p) => s + Math.max(0, (p.totalAmount ?? 0) - (p.discountAmount ?? 0)), 0);
    const totalPaid   = source.reduce((s, p) => s + (p.paidAmount ?? 0), 0);
    const totalRemain = source.reduce((s, p) => s + (p.remainingAmount ?? 0), 0);
    const percent = totalNeed > 0 ? Math.round((totalPaid / totalNeed) * 100) : 0;
    return { totalNeed, totalPaid, totalRemain, percent };
  }, [filteredPayments, overviewData, preset]);

  const groupedPayments = useMemo(() => {
    // Deduplicate by bookingId để tính header stats chính xác — mỗi hồ sơ chỉ đếm 1 lần
    // (một booking có thể có nhiều phiếu thu, nhưng remainingAmount/paidAmount là của booking)
    const uniqueBookingMap = new Map<number | string, RecentPaymentItem>();
    for (const p of filteredPayments) {
      const key = p.bookingId != null ? p.bookingId : `payment-${p.id}`;
      if (!uniqueBookingMap.has(key)) uniqueBookingMap.set(key, p);
    }
    const uniqueItems = Array.from(uniqueBookingMap.values());

    const owedUnique = uniqueItems.filter(p => (p.remainingAmount ?? 0) > 0);
    const paidUnique = uniqueItems.filter(p => (p.remainingAmount ?? 0) <= 0);

    // Tập hợp key của từng nhóm để phân loại payment rows
    const owedKeys = new Set(owedUnique.map(p => p.bookingId != null ? p.bookingId : `payment-${p.id}`));
    const paidKeys = new Set(paidUnique.map(p => p.bookingId != null ? p.bookingId : `payment-${p.id}`));

    // Sắp xếp payment rows nhóm "còn nợ": ưu tiên nợ nhiều nhất ↓, cùng mức nợ thì ngày chụp sớm ↑
    const owedRows = filteredPayments
      .filter(p => owedKeys.has(p.bookingId != null ? p.bookingId : `payment-${p.id}`))
      .sort((a, b) => {
        const diff = (b.remainingAmount ?? 0) - (a.remainingAmount ?? 0);
        if (diff !== 0) return diff;
        const da = a.shootDate ? new Date(a.shootDate).getTime() : Infinity;
        const db = b.shootDate ? new Date(b.shootDate).getTime() : Infinity;
        return da - db;
      });
    const paidRows = filteredPayments.filter(p => paidKeys.has(p.bookingId != null ? p.bookingId : `payment-${p.id}`));

    // Header stats từ unique bookings — không đếm trùng
    const owedTotalRemain = owedUnique.reduce((s, p) => s + (p.remainingAmount ?? 0), 0);
    const owedTotalPaid   = owedUnique.reduce((s, p) => s + (p.paidAmount ?? 0), 0);
    const paidTotalPaid   = paidUnique.reduce((s, p) => s + (p.paidAmount ?? 0), 0);

    return {
      owed: owedRows, owedCount: owedUnique.length,
      paid: paidRows, paidCount: paidUnique.length,
      owedTotalRemain, owedTotalPaid, paidTotalPaid,
    };
  }, [filteredPayments]);

  /* Form */
  const defaultCollector = viewer ? String(viewer.name || viewer.phone || "Quản Trị Viên") : "Quản Trị Viên";
  const [form, setForm] = useState({
    amount: "",
    paymentMethod: "cash",
    bankName: "",
    collectorName: defaultCollector,
    paidDate: today(),
    notes: "",
  });
  useEffect(() => {
    if (viewer) setForm(f => ({ ...f, collectorName: String(viewer.name || viewer.phone || "Quản Trị Viên") }));
  }, [viewer?.id]);

  const [proofImages, setProofImages] = useState<string[]>([]);
  const [uploadingProof, setUploadingProof] = useState(false);
  const [proofPreview, setProofPreview] = useState(false);
  const [proofPreviewUrl, setProofPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving]           = useState(false);
  const [saveError, setSaveError]     = useState<string | null>(null);
  const [mainSuccess, setMainSuccess] = useState<string | null>(null);
  const [newPaymentId, setNewPaymentId] = useState<number | null>(null);
  const fileRef                       = useRef<HTMLInputElement>(null);

  // Tự động xóa highlight sau 2s, với cleanup để tránh timer race
  useEffect(() => {
    if (newPaymentId === null) return;
    const t = setTimeout(() => setNewPaymentId(null), 2000);
    return () => clearTimeout(t);
  }, [newPaymentId]);

  /* isDirty: có dữ liệu chưa lưu */
  const isDirty = form.amount !== "" || form.notes !== "" || proofImages.length > 0;

  /* Reset toàn bộ form */
  const resetForm = () => {
    setForm(f => ({ ...f, amount: "", notes: "", bankName: "" }));
    setProofImages([]);
    setSaveError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  /* Deep-link từ Lịch chụp: /payments?bookingId=N → tự động mở Sheet thu tiền cho show đó.
     Fetch booking detail từ /api/bookings/:id rồi gọi handleSelectBooking. */
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const bid = params.get("bookingId");
    if (!bid) return;
    deepLinkHandled.current = true;
    // Xoá query param khỏi URL ngay để khỏi mở lại lúc back / refresh
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("bookingId");
      window.history.replaceState({}, "", url.toString());
    } catch { /* ignore */ }
    const id = Number(bid);
    if (!Number.isFinite(id) || id <= 0) return;
    fetchJson(`/api/bookings/${id}`)
      .then((raw: unknown) => {
        if (!raw || typeof raw !== "object" || !("id" in (raw as object))) {
          setSaveError(`Không tìm thấy đơn #${id}.`);
          setTimeout(() => setSaveError(null), 4000);
          return;
        }
        const b = raw as unknown as Booking;
        // Nếu có parentContract (đơn con của hợp đồng) → ưu tiên parent để thu vào ví hợp đồng
        const parent = (raw as { parentContract?: Booking }).parentContract;
        handleSelectBooking(parent && parent.id ? parent : b);
      })
      .catch(() => {
        setSaveError(`Không tải được đơn #${id}.`);
        setTimeout(() => setSaveError(null), 4000);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Khi chọn hồ sơ → mở Sheet, rồi fetch fresh booking để luôn có paidAmount đúng */
  const handleSelectBooking = (b: Booking) => {
    // Guard cứng: không có bookingId thì KHÔNG mở Sheet (sẽ vỡ savePayment).
    // Báo lỗi rõ ràng thay vì silent fail.
    if (!b || !b.id) {
      setMainSuccess(null);
      setSaveError("Không thể mở hồ sơ này — phiếu thu chưa gắn với đơn hàng nào.");
      setTimeout(() => setSaveError(null), 4000);
      return;
    }
    setSelectedBooking(b);
    setSaveError(null);
    setForm(f => ({ ...f, amount: "", notes: "", bankName: "" }));
    setProofImages([]);
    if (fileRef.current) fileRef.current.value = "";
    setSheetOpen(true);
    // Fetch fresh booking ngay sau khi mở Sheet (không block UI)
    if (b.customerPhone) {
      fetchJson(`/api/payments/search?q=${encodeURIComponent(b.customerPhone)}`)
        .then((fresh: Booking[]) => {
          const refreshed = fresh.find(x => x.id === b.id);
          if (refreshed) setSelectedBooking(refreshed);
        })
        .catch(() => {});
    }
  };

  /* Khi click vào phiếu thu gần đây → chọn booking tương ứng */
  const handleSelectFromRecent = (p: RecentPaymentItem) => {
    // Phiếu thu mất link booking (booking đã xoá / payment khách lẻ chưa có đơn)
    // → KHÔNG silent fail nữa, hiện banner báo cho user biết phải làm gì.
    if (!p.bookingId) {
      setSaveError(
        p.rentalId
          ? "Phiếu này thuộc đơn cho thuê đồ — vui lòng vào module Cho thuê để thu tiền."
          : `Phiếu thu của ${p.customerName ?? "khách lẻ"} chưa gắn với đơn hàng. Hãy tạo đơn trước rồi thu lại.`
      );
      setTimeout(() => setSaveError(null), 5000);
      // Cuộn lên đầu để user thấy banner
      try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* */ }
      return;
    }
    // Build initial booking từ cached data để mở Sheet ngay
    // handleSelectBooking sẽ tự fetch fresh booking sau khi mở
    const booking: Booking = {
      id:              p.bookingId,
      orderCode:       p.orderCode ?? "",
      customerId:      0,
      customerName:    p.customerName ?? "",
      customerPhone:   p.customerPhone ?? "",
      packageType:     p.packageType ?? "",
      totalAmount:     p.totalAmount,
      discountAmount:  p.discountAmount,
      paidAmount:      p.paidAmount,
      remainingAmount: p.remainingAmount,
      status:          p.status ?? "",
      shootDate:       "",
      isParentContract: p.isParentContract,
      serviceCount:    0,
    };
    handleSelectBooking(booking);
  };

  /* Đóng Sheet: kiểm tra isDirty */
  const handleSheetOpenChange = (open: boolean) => {
    if (!open) {
      if (isDirty) {
        const confirmed = window.confirm("Bạn có chắc muốn đóng? Dữ liệu chưa lưu sẽ bị mất.");
        if (!confirmed) return;
      }
      setSheetOpen(false);
      setSelectedBooking(null);
      resetForm();
    } else {
      setSheetOpen(true);
    }
  };

  const uploadProof = async (file: File) => {
    setUploadingProof(true);
    try {
      const res = await authFetch(`/api/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!res.ok) {
        console.error("Upload URL request failed", res.status);
        return;
      }
      const { uploadURL, objectPath } = await res.json();
      const putRes = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) {
        console.error("PUT to storage failed", putRes.status);
        return;
      }
      setProofImages(prev => Array.from(new Set([...prev, objectPath])));
    } catch (err) {
      console.error("Upload failed", err);
    } finally {
      setUploadingProof(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = Math.max(0, 20 - proofImages.length);
    const slice = files.slice(0, remaining);
    for (const f of slice) await uploadProof(f);
    e.target.value = "";
  };

  /* Sau khi lưu: refresh dữ liệu booking từ suggestions hoặc search */
  const refreshSelectedBooking = async (current: Booking) => {
    try {
      const updated: Booking[] = await fetchJson(
        `/api/payments/search?q=${encodeURIComponent(current.customerPhone)}`
      );
      const refreshed = updated.find(b => b.id === current.id);
      if (refreshed) {
        setSelectedBooking(refreshed);
        qc.invalidateQueries({ queryKey: ["payment-suggestions"] });
      }
    } catch {}
  };

  const savePayment = async () => {
    if (!selectedBooking) return;
    const amt = parseFloat(form.amount);
    if (!amt || amt <= 0) {
      setSaveError("Vui lòng nhập số tiền thu hợp lệ");
      return;
    }
    setSaveError(null);
    setSaving(true);
    try {
      const created = await fetchJson<{ id?: number }>("/api/payments", {
        method: "POST",
        body: JSON.stringify({
          bookingId:     selectedBooking.id,
          amount:        amt,
          paymentMethod: form.paymentMethod,
          paymentType:   "payment",
          collectorName: form.collectorName,
          bankName:      form.paymentMethod === "bank_transfer" ? form.bankName : null,
          proofImageUrl: proofImages[0] ?? null,
          proofImageUrls: proofImages,
          paidDate:      form.paidDate,
          notes:         form.notes || null,
          paidAt:        form.paidDate ? new Date(form.paidDate).toISOString() : undefined,
        }),
      });
      await refetchHistory();
      await refetchRecent();
      await refreshSelectedBooking(selectedBooking);
      qc.invalidateQueries({ queryKey: ["booking", selectedBooking.id] });
      qc.invalidateQueries({ queryKey: ["booking-full", selectedBooking.id] });
      qc.invalidateQueries({ queryKey: ["bookings"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["payments", selectedBooking.id] });
      qc.invalidateQueries({ queryKey: ["payments-recent"] });
      qc.invalidateQueries({ queryKey: ["dashboard-simple"] });
      qc.invalidateQueries({ queryKey: ["dashboard-v2"] });
      qc.invalidateQueries({ queryKey: ["payment-suggestions"] });
      successFeedback();
      resetForm();
      setSheetOpen(false);
      setSelectedBooking(null);
      setMainSuccess("✅ Đã lưu phiếu thu thành công!");
      setTimeout(() => setMainSuccess(null), 2500);
      // Highlight item mới trong 2 giây
      if (created?.id) {
        setNewPaymentId(Number(created.id));
      }
    } catch {
      setSaveError("Có lỗi khi lưu phiếu thu. Vui lòng thử lại.");
    } finally {
      setSaving(false);
    }
  };

  const deletePayment = useMutation({
    mutationFn: (id: number) => authFetch(`/api/payments/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await refetchHistory();
      await refetchRecent();
      if (selectedBooking) await refreshSelectedBooking(selectedBooking);
    },
  });

  /* ── Void phiếu thu ── */
  const [voidDialogOpen, setVoidDialogOpen] = useState(false);
  const [voidTargetId, setVoidTargetId] = useState<number | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidLoading, setVoidLoading] = useState(false);
  const [voidError, setVoidError] = useState<string | null>(null);

  const openVoidDialog = (paymentId: number) => {
    setVoidTargetId(paymentId);
    setVoidReason("");
    setVoidError(null);
    setVoidDialogOpen(true);
  };

  const closeVoidDialog = () => {
    setVoidDialogOpen(false);
    setVoidTargetId(null);
    setVoidReason("");
    setVoidError(null);
  };

  const confirmVoid = async () => {
    if (!voidTargetId || !voidReason.trim()) {
      setVoidError("Vui lòng nhập lý do huỷ");
      return;
    }
    setVoidLoading(true);
    setVoidError(null);
    try {
      const res = await fetchJson<{ error?: string }>(`/api/payments/${voidTargetId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken ?? ""}` },
        body: JSON.stringify({ reason: voidReason.trim() }),
      });
      if (res?.error) { setVoidError(res.error); return; }
      closeVoidDialog();
      qc.invalidateQueries({ queryKey: ["payments-recent"] });
      qc.invalidateQueries({ queryKey: ["payments-monthly-list"] });
      qc.invalidateQueries({ queryKey: ["payments-overview"] });
      qc.invalidateQueries({ queryKey: ["payments-default-month"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["dashboard-simple"] });
      qc.invalidateQueries({ queryKey: ["dashboard-v2"] });
      qc.invalidateQueries({ queryKey: ["payment-suggestions"] });
      qc.invalidateQueries({ queryKey: ["bookings"] });
      await refetchHistory();
      await refetchRecent();
      if (selectedBooking) await refreshSelectedBooking(selectedBooking);
      successFeedback();
    } catch {
      setVoidError("Lỗi khi huỷ phiếu. Vui lòng thử lại.");
    } finally {
      setVoidLoading(false);
    }
  };

  /* Tính toán số tiền */
  const amtNum = parseFloat(form.amount) || 0;

  // actualPaid: source of truth — tổng từ paymentHistory (đã fetch fresh từ DB)
  // Fallback về selectedBooking.paidAmount chỉ khi query chưa hoàn thành (isFetched = false)
  const actualPaid = paymentHistoryFetched
    ? paymentHistory.filter((p: Payment) => p.status !== "voided").reduce((s: number, p: Payment) => s + p.amount, 0)
    : (selectedBooking?.paidAmount ?? 0);

  // effectiveRemaining: tính từ actualPaid — không dùng cache
  const effectiveTotal    = selectedBooking ? selectedBooking.totalAmount : 0;
  const effectiveDiscount = selectedBooking ? (selectedBooking.discountAmount ?? 0) : 0;
  const effectiveRemaining = Math.max(0, effectiveTotal - effectiveDiscount - actualPaid);

  const isOverpaid = amtNum > effectiveRemaining;
  const afterPay   = Math.max(0, effectiveRemaining - amtNum);

  /* ── Phiếu thu lẻ (ad-hoc) ─────────────────────────
     Không gắn với booking — dùng cho thuê đồ lẻ, phụ kiện, mâm quả… */
  const initAdHocForm = () => {
    const { date, time } = nowVnLocalParts();
    return {
      payerName: "",
      payerPhone: "",
      amount: "",
      paymentMethod: "cash" as "cash" | "bank_transfer",
      bankName: "",
      description: "",
      adHocCategory: "" as string,
      paidDate: date,
      paidTime: time,
      paidAtTouched: false,
      collectorName: viewer ? String(viewer.name || viewer.phone || "") : "",
      notes: "",
    };
  };
  const [adHocOpen, setAdHocOpen] = useState(false);
  const [adHocForm, setAdHocForm] = useState(initAdHocForm);
  const [adHocProofs, setAdHocProofs] = useState<string[]>([]);
  const [adHocUploading, setAdHocUploading] = useState(false);
  const [adHocSaving, setAdHocSaving] = useState(false);
  const [adHocError, setAdHocError] = useState<string | null>(null);
  const adHocFileRef = useRef<HTMLInputElement | null>(null);

  const openAdHoc = () => {
    setAdHocForm(initAdHocForm());
    setAdHocProofs([]);
    setAdHocError(null);
    setAdHocOpen(true);
  };
  const closeAdHoc = () => {
    setAdHocOpen(false);
    setAdHocError(null);
  };

  const uploadAdHocProof = async (file: File) => {
    setAdHocUploading(true);
    try {
      const res = await authFetch(`/api/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!res.ok) return;
      const { uploadURL, objectPath } = await res.json();
      const putRes = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) return;
      setAdHocProofs(prev => Array.from(new Set([...prev, objectPath])));
    } finally {
      setAdHocUploading(false);
    }
  };
  const handleAdHocImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = Math.max(0, 20 - adHocProofs.length);
    for (const f of files.slice(0, remaining)) await uploadAdHocProof(f);
    e.target.value = "";
  };

  const saveAdHoc = async () => {
    const amt = parseFloat(adHocForm.amount);
    if (!amt || amt <= 0) { setAdHocError("Nhập số tiền hợp lệ"); return; }
    if (!adHocForm.description.trim() && !adHocForm.payerName.trim()) {
      setAdHocError("Cần nhập tên người trả hoặc nội dung thu");
      return;
    }
    setAdHocSaving(true);
    setAdHocError(null);
    try {
      const time = adHocForm.paidTime || "00:00";
      const paidAtIso = new Date(`${adHocForm.paidDate}T${time}:00`).toISOString();
      const created = await fetchJson<{ id?: number }>("/api/payments", {
        method: "POST",
        body: JSON.stringify({
          bookingId: null,
          rentalId: null,
          amount: amt,
          paymentMethod: adHocForm.paymentMethod,
          paymentType: "ad_hoc",
          collectorName: adHocForm.collectorName || null,
          bankName: adHocForm.paymentMethod === "bank_transfer" ? (adHocForm.bankName || null) : null,
          proofImageUrl: adHocProofs[0] ?? null,
          proofImageUrls: adHocProofs,
          paidDate: adHocForm.paidDate,
          paidAt: paidAtIso,
          notes: adHocForm.notes || null,
          payerName: adHocForm.payerName.trim() || null,
          payerPhone: adHocForm.payerPhone.trim() || null,
          description: adHocForm.description.trim() || null,
          adHocCategory: null,
        }),
      });
      await refetchRecent();
      qc.invalidateQueries({ queryKey: ["payments-recent"] });
      qc.invalidateQueries({ queryKey: ["payments-monthly-list"] });
      qc.invalidateQueries({ queryKey: ["payments-overview"] });
      qc.invalidateQueries({ queryKey: ["payments-default-month"] });
      qc.invalidateQueries({ queryKey: ["dashboard-simple"] });
      qc.invalidateQueries({ queryKey: ["dashboard-v2"] });
      successFeedback();
      closeAdHoc();
      setMainSuccess("✅ Đã lưu phiếu thu lẻ!");
      setTimeout(() => setMainSuccess(null), 2500);
      if (created?.id) setNewPaymentId(Number(created.id));
    } catch {
      setAdHocError("Có lỗi khi lưu phiếu thu lẻ. Thử lại nhé.");
    } finally {
      setAdHocSaving(false);
    }
  };

  /* Đồng bộ dữ liệu cọc cũ */
  const [syncing, setSyncing] = useState(false);
  const handleSyncDeposits = async () => {
    if (!confirm("Hệ thống sẽ:\n• Tạo phiếu thu cọc cho các đơn chưa có\n• Xóa phiếu cọc bị trùng\n• Cập nhật lại số tiền đã thu\n\nTiếp tục?")) return;
    setSyncing(true);
    try {
      const r = await fetchJson<{ message?: string }>("/api/payments/sync-deposits", { method: "POST" });
      alert(r.message);
      await refetchRecent();
      qc.invalidateQueries({ queryKey: ["payment-suggestions"] });
    } catch {
      alert("Có lỗi khi đồng bộ, thử lại");
    } finally { setSyncing(false); }
  };

  return (
    <div className="space-y-5 pb-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Thu tiền</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {effectiveIsAdmin ? "Chọn hồ sơ → Điền thông tin → Lưu phiếu thu" : `Thu hộ bởi ${viewer?.name ?? "nhân viên"} — chụp ảnh biên nhận khi thu tiền mặt`}
          </p>
        </div>
        <div className="flex-shrink-0 flex items-center gap-2">
          <button
            onClick={openAdHoc}
            title="Tạo phiếu thu lẻ ngoài đơn hàng (thuê đồ, phụ kiện, mâm quả...)"
            className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 active:scale-95 transition-all shadow-sm"
          >
            <Plus className="w-4 h-4" />
            <span>Thu tiền</span>
          </button>
          {effectiveIsAdmin && (
            <button
              onClick={handleSyncDeposits}
              disabled={syncing}
              title="Đồng bộ tiền cọc cũ thành phiếu thu"
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-xl border border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              <History className="w-3.5 h-3.5" />
              {syncing ? "Đang đồng bộ..." : "Đồng bộ cọc cũ"}
            </button>
          )}
        </div>
      </div>

      {!effectiveIsAdmin && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
          <Receipt className="w-4 h-4 shrink-0" />
          <span>Nhớ chụp ảnh biên nhận hoặc ảnh chuyển khoản khi thu tiền để quản lý kiểm tra.</span>
        </div>
      )}

      {/* Banner thành công sau khi lưu */}
      {mainSuccess && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm font-medium">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{mainSuccess}</span>
        </div>
      )}

      {/* ── Search box thông minh ─────────────────── */}
      <div className="bg-card border border-border rounded-2xl p-4 space-y-2">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary" /> Chọn hồ sơ cần thu
        </p>
        <SmartSearchBox
          suggestions={suggestions}
          suggestionsLoading={suggestionsLoading}
          selectedId={selectedBooking?.id}
          onSelect={handleSelectBooking}
        />
      </div>

      {/* ── Danh sách theo tháng ─────────────────── */}
      <MonthlyListSection effectiveIsAdmin={effectiveIsAdmin} onSelectBooking={handleSelectBooking} onVoid={openVoidDialog} defaultMonthKey={defaultMonthKey} />

      {/* ── Lịch sử thu gần đây ──────────────────── */}
      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-border/60">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold">Lịch sử thu gần đây</span>
              {(recentFetching || overviewLoading) && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setTimeView("shoot")} className={cn("px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all", timeView === "shoot" ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border text-muted-foreground hover:text-foreground")}>Xem theo tháng chụp</button>
              <button type="button" onClick={() => setTimeView("payment")} className={cn("px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all", timeView === "payment" ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border text-muted-foreground hover:text-foreground")}>Xem theo tháng thu tiền</button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {(["this", "prev", "next", "all"] as const).map(p => (
              <button key={p} type="button" onClick={() => applyPreset(p)} className={cn("px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all", preset === p ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border text-muted-foreground hover:text-foreground")}>
                {p === "this" ? "Tháng này" : p === "prev" ? "Tháng trước" : p === "next" ? "Tháng sau" : "Tất cả"}
              </button>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:max-w-md">
            <select className="h-10 rounded-xl border bg-background px-3 text-sm" value={monthFilter} onChange={e => { setMonthFilter(e.target.value); setPreset("this"); }}>
              {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map(m => <option key={m} value={m}>Tháng {m}</option>)}
            </select>
            <select className="h-10 rounded-xl border bg-background px-3 text-sm" value={yearFilter} onChange={e => { setYearFilter(e.target.value); setPreset("this"); }}>
              {Array.from({ length: 7 }, (_, i) => String(parseInt(defaultParts.year, 10) - 3 + i)).map(y => <option key={y} value={y}>Năm {y}</option>)}
            </select>
          </div>

          <div className="mt-3 grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: "Tổng cần thu", value: fmtVND(paymentSummary.totalNeed), icon: Receipt, color: "bg-blue-50 text-blue-600" },
              { label: "Đã thu", value: fmtVND(paymentSummary.totalPaid), icon: CheckCircle, color: "bg-emerald-50 text-emerald-600" },
              { label: "Còn nợ", value: fmtVND(paymentSummary.totalRemain), icon: AlertCircle, color: "bg-red-50 text-red-600" },
              { label: "% hoàn thành", value: `${paymentSummary.percent}%`, icon: TrendingUp, color: "bg-blue-50 text-blue-600" },
            ].map(c => (
              <div key={c.label} className="rounded-xl border border-border bg-card p-3 flex flex-col gap-1">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${c.color}`}><c.icon size={14} /></div>
                <div className="text-base font-bold leading-tight">{c.value}</div>
                <div className="text-[11px] text-muted-foreground">{c.label}</div>
              </div>
            ))}
          </div>
          </div>

        {/* List */}
        <div>
          {overviewError ? (
            <div className="py-10 text-center text-red-600">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-60" />
              <p className="text-sm font-medium">Không tải được dữ liệu thu tiền từ máy chủ.</p>
              <button type="button" onClick={() => refetchPaymentsSection()} className="mt-2 text-xs underline">Thử lại</button>
            </div>
          ) : (overviewLoading && preset !== "all") ? (
            <div className="py-10 text-center text-muted-foreground text-sm">Đang tải dữ liệu từ database...</div>
          ) : filteredPayments.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              <History className="w-8 h-8 mx-auto mb-2 opacity-25" />
              <p className="text-sm">
                {preset === "all"
                  ? "Chưa có phiếu thu nào trong hệ thống"
                  : `Chưa có phiếu thu nào trong tháng ${monthFilter}/${yearFilter}`}
              </p>
            </div>
          ) : (
            <>
              {/* ── Nhóm A: Chưa thu / Còn nợ ── */}
              {groupedPayments.owedCount > 0 && (
                <div>
                  <div className="px-4 py-2.5 bg-red-50/60 dark:bg-red-950/20 border-b border-red-100 dark:border-red-900/30 flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                      <span className="text-xs font-bold text-red-700 dark:text-red-400">
                        CHƯA THU / CÒN NỢ — {groupedPayments.owedCount} đơn
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px]">
                      <span className="text-muted-foreground">Đã thu: <span className="font-semibold text-foreground">{fmtVND(groupedPayments.owedTotalPaid)}</span></span>
                      <span className="text-red-600 dark:text-red-400 font-bold">Còn nợ: {fmtVND(groupedPayments.owedTotalRemain)}</span>
                    </div>
                  </div>
                  <div className="divide-y divide-border/40">
                    {groupedPayments.owed.map((p) => (
                      <PaymentRow
                        key={p.id}
                        p={p}
                        newPaymentId={newPaymentId}
                        onSelect={handleSelectFromRecent}
                        onPreviewImage={(url) => { setProofPreviewUrl(url); setProofPreview(true); }}
                        isAdmin={effectiveIsAdmin}
                        onVoid={openVoidDialog}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* ── Nhóm B: Đã thu đủ ── */}
              {groupedPayments.paidCount > 0 && (
                <div className={groupedPayments.owedCount > 0 ? "border-t border-border/60" : ""}>
                  <div className="px-4 py-2.5 bg-emerald-50/60 dark:bg-emerald-950/20 border-b border-emerald-100 dark:border-emerald-900/30 flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                      <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                        ĐÃ THU ĐỦ — {groupedPayments.paidCount} đơn
                      </span>
                    </div>
                    <div className="text-[11px] text-emerald-700 dark:text-emerald-400 font-semibold">
                      Tổng đã thu: {fmtVND(groupedPayments.paidTotalPaid)}
                    </div>
                  </div>
                  <div className="divide-y divide-border/40">
                    {groupedPayments.paid.map((p) => (
                      <PaymentRow
                        key={p.id}
                        p={p}
                        newPaymentId={newPaymentId}
                        onSelect={handleSelectFromRecent}
                        isAdmin={effectiveIsAdmin}
                        onVoid={openVoidDialog}
                        onPreviewImage={(url) => { setProofPreviewUrl(url); setProofPreview(true); }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Xem thêm */}
              {!showAll && recentPayments.length >= 10 && (
                <div className="px-4 py-3 border-t border-border/40 text-center">
                  <button
                    onClick={() => setShowAll(true)}
                    className="text-xs font-semibold text-primary hover:text-primary/80 flex items-center gap-1 mx-auto transition-colors"
                  >
                    <ChevronDown className="w-3.5 h-3.5" /> Xem thêm giao dịch
                  </button>
                </div>
              )}
              {showAll && (
                <div className="px-4 py-3 border-t border-border/40 text-center">
                  <button
                    onClick={() => setShowAll(false)}
                    className="text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1 mx-auto transition-colors"
                  >
                    Thu gọn
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Sheet thu tiền ────────────────────────── */}
      <Sheet open={sheetOpen} onOpenChange={handleSheetOpenChange}>
        <SheetContent
          side="bottom"
          className="!p-0 flex flex-col overflow-hidden"
          style={{ minHeight: "85vh", maxHeight: "95vh" }}
        >
          {/* Sheet header — sticky, đủ rộng tránh nút X mặc định */}
          <div className="shrink-0 px-4 pt-4 pb-3 pr-14 border-b border-border bg-background">
            <SheetTitle className="text-base font-bold text-foreground flex items-center gap-2">
              <Receipt className="w-4 h-4 text-primary shrink-0" />
              <span className="truncate">{selectedBooking?.customerName ?? "Thu tiền"}</span>
            </SheetTitle>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {selectedBooking?.orderCode && (
                <span className="text-xs font-mono font-bold text-primary">{selectedBooking.orderCode}</span>
              )}
              {selectedBooking?.packageType && (
                <span className="text-xs text-muted-foreground truncate">{selectedBooking.packageType}</span>
              )}
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="p-4 space-y-4">

              {/* Error banner */}
              {saveError && (
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span className="flex-1">{saveError}</span>
                  <button onClick={() => setSaveError(null)} className="flex-shrink-0 p-0.5 hover:opacity-70">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Thông tin hồ sơ */}
              {selectedBooking && (
                <div className="bg-muted/40 rounded-xl p-3 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Khách hàng</span>
                    <span className="font-semibold">{selectedBooking.customerName}</span>
                  </div>
                  {selectedBooking.customerPhone && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Số điện thoại</span>
                      <span>{selectedBooking.customerPhone}</span>
                    </div>
                  )}
                  {selectedBooking.orderCode && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Mã đơn</span>
                      <span className="font-mono font-bold text-primary">{selectedBooking.orderCode}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gói dịch vụ</span>
                    <span className="text-right max-w-[180px]">{selectedBooking.packageType}</span>
                  </div>
                  <div className="border-t border-border/50 pt-2 space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tổng đơn</span>
                      <span className="font-bold">{fmtVND(selectedBooking.totalAmount)}</span>
                    </div>
                    {(selectedBooking.discountAmount ?? 0) > 0 && (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Giảm giá</span>
                          <span className="text-orange-600 font-semibold">−{fmtVND(selectedBooking.discountAmount ?? 0)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-muted-foreground">Sau giảm giá</span>
                          <span className="font-semibold text-primary">
                            {fmtVND(selectedBooking.totalAmount - (selectedBooking.discountAmount ?? 0))}
                          </span>
                        </div>
                      </>
                    )}
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Đã thu</span>
                      <span className="text-green-600 font-semibold">{fmtVND(actualPaid)}</span>
                    </div>
                    <div className="flex justify-between text-base">
                      <span className="font-semibold">Còn lại</span>
                      <span className={cn("font-bold", effectiveRemaining > 0 ? "text-red-600" : "text-green-600")}>
                        {effectiveRemaining > 0
                          ? fmtVND(effectiveRemaining)
                          : "✓ Đã thu đủ"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Số tiền thu lần này */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1.5">
                  💰 Số tiền thu lần này *
                </label>
                <CurrencyInput
                  className="w-full px-3 py-3 border border-border rounded-xl text-base font-bold bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                  value={form.amount}
                  onChange={raw => { setForm(f => ({ ...f, amount: raw })); setSaveError(null); }}
                  placeholder="Nhập số tiền cần thu..."
                />

                {/* Quick suggestion buttons */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {[500000, 1000000, 2000000].map(amt => (
                    <button key={amt} type="button"
                      onClick={() => setForm(f => ({ ...f, amount: String(amt) }))}
                      className="text-xs px-2.5 py-1.5 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground border border-border rounded-lg font-medium transition-colors">
                      {(amt / 1000).toFixed(0)}k
                    </button>
                  ))}
                  {effectiveRemaining > 0 && (
                    <button type="button"
                      onClick={() => setForm(f => ({ ...f, amount: String(effectiveRemaining) }))}
                      className="text-xs px-2.5 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/30 rounded-lg font-semibold transition-colors">
                      Thu đủ ({fmtVND(effectiveRemaining)})
                    </button>
                  )}
                </div>

                {!form.amount && (
                  <p className="mt-1.5 text-xs text-muted-foreground italic">
                    Vui lòng nhập số tiền cần thu hoặc chọn gợi ý bên trên
                  </p>
                )}
                {amtNum > 0 && (
                  <div className={cn(
                    "mt-1.5 flex items-center gap-1.5 text-xs font-medium rounded-lg px-3 py-2",
                    isOverpaid ? "bg-orange-50 text-orange-700" : "bg-green-50 text-green-700"
                  )}>
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    {isOverpaid
                      ? "Số thu vượt quá số còn nợ"
                      : `Còn lại sau khi thu: ${fmtVND(afterPay)}`}
                  </div>
                )}
              </div>

              {/* Hình thức */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1.5">
                  💳 Hình thức thanh toán
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { v: "cash",          label: "💵 Tiền mặt"     },
                    { v: "bank_transfer", label: "🏦 Chuyển khoản" },
                  ].map(opt => (
                    <button
                      key={opt.v}
                      onClick={() => setForm(f => ({ ...f, paymentMethod: opt.v }))}
                      className={cn(
                        "py-2.5 rounded-xl text-sm font-medium border transition-all",
                        form.paymentMethod === opt.v
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-muted/30 text-muted-foreground hover:border-primary/40"
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {form.paymentMethod === "bank_transfer" && (
                  <input
                    className="mt-2 w-full px-3 py-2 border border-border rounded-xl text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                    placeholder="Tên ngân hàng / Số tài khoản / Mã giao dịch..."
                    value={form.bankName}
                    onChange={e => setForm(f => ({ ...f, bankName: e.target.value }))}
                  />
                )}
              </div>

              {/* Người thu & Ngày thu */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground block mb-1">👤 Người thu</label>
                  <input
                    className={`w-full px-3 py-2 border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 ${effectiveIsAdmin ? "bg-background" : "bg-muted/40 cursor-default"}`}
                    value={form.collectorName}
                    onChange={e => effectiveIsAdmin && setForm(f => ({ ...f, collectorName: e.target.value }))}
                    readOnly={!effectiveIsAdmin}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground block mb-1">📅 Ngày thu</label>
                  <DateInput
                    className="w-full py-2 rounded-xl text-sm"
                    value={form.paidDate}
                    onChange={v => setForm(f => ({ ...f, paidDate: v }))}
                  />
                </div>
              </div>

              {/* Bằng chứng */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1.5">
                  📷 Bằng chứng thu tiền
                </label>
                {proofImages.length > 0 ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2">
                      {proofImages.map((url, idx) => (
                        <div key={`${url}-${idx}`} className="relative w-full h-24 rounded-xl overflow-hidden border border-border">
                          <img src={getImageSrc(url) ?? undefined} alt={`bằng chứng ${idx + 1}`} className="w-full h-full object-cover" />
                          <div className="absolute top-1 right-1 flex gap-0.5">
                            <button
                              type="button"
                              onClick={() => { setProofPreviewUrl(getImageSrc(url) || url); setProofPreview(true); }}
                              className="p-1 bg-black/60 text-white rounded-md"
                            >
                              <Eye className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setProofImages(prev => prev.filter((_, i) => i !== idx))}
                              className="p-1 bg-black/60 text-white rounded-md"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      disabled={uploadingProof || proofImages.length >= 20}
                      className="w-full border-2 border-dashed border-border rounded-xl py-2.5 text-xs text-muted-foreground hover:border-primary/40 hover:bg-muted/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {uploadingProof ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      Thêm ảnh ({proofImages.length}/20)
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploadingProof}
                    className="w-full border-2 border-dashed border-border rounded-xl py-4 text-xs text-muted-foreground hover:border-primary/40 hover:bg-muted/20 transition-all flex items-center justify-center gap-2"
                  >
                    {uploadingProof ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    Tải ảnh chuyển khoản / biên lai / phiếu thu
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={handleImageUpload}
                />
              </div>

              {/* Ghi chú */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground block mb-1">📝 Ghi chú</label>
                <textarea
                  className="w-full px-3 py-2 border border-border rounded-xl text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                  rows={2}
                  placeholder="Khách đưa thiếu / Thu lần 2 / Giữ cọc / Thu hộ..."
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                />
              </div>

              {/* ── Lịch sử thu của booking này ───── */}
              <div className="pt-2">
                <p className="text-sm font-semibold mb-3 flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-primary" /> Lịch sử thu tiền
                  {paymentHistory.length > 0 && (
                    <span className="ml-1 text-[11px] bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">
                      {paymentHistory.length} phiếu
                    </span>
                  )}
                </p>

                {paymentHistory.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Receipt className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">Chưa có phiếu thu nào</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {paymentHistory.map(p => (
                      <div
                        key={p.id}
                        className={cn("border border-border rounded-xl p-3 bg-muted/20 space-y-2", p.status === "voided" && "opacity-60 border-red-200 bg-red-50/30")}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-2">
                            <div className={cn(
                              "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0",
                              p.status === "voided"
                                ? "bg-red-100 text-red-500"
                                : p.paymentType === "deposit"
                                ? "bg-amber-100 text-amber-700"
                                : p.paymentMethod === "cash"
                                ? "bg-green-100 text-green-700"
                                : "bg-blue-100 text-blue-700"
                            )}>
                              {p.status === "voided"
                                ? <Ban className="w-4 h-4" />
                                : p.paymentMethod === "cash"
                                ? <Banknote className="w-4 h-4" />
                                : <CreditCard className="w-4 h-4" />}
                            </div>
                            <div>
                              <div className="flex items-center gap-1.5">
                                <p className={cn("text-sm font-bold", p.status === "voided" ? "text-muted-foreground line-through" : "text-primary")}>{fmtVND(p.amount)}</p>
                                {p.status === "voided" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500 text-white font-semibold flex items-center gap-0.5">
                                    <Ban className="w-2.5 h-2.5" /> Đã huỷ
                                  </span>
                                )}
                                {p.paymentType === "deposit" && p.status !== "voided" && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">
                                    Cọc
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {METHOD_LABEL[p.paymentMethod] ?? p.paymentMethod}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            {(() => {
                              const urls = (p.proofImageUrls && p.proofImageUrls.length) ? p.proofImageUrls : (p.proofImageUrl ? [p.proofImageUrl] : []);
                              if (urls.length === 0) return null;
                              return (
                                <button
                                  onClick={() => { setProofPreviewUrl(getImageSrc(urls[0]) || urls[0]); setProofPreview(true); }}
                                  className="text-[10px] px-2 py-1 bg-primary/10 text-primary rounded-lg flex items-center gap-0.5 font-medium"
                                >
                                  <Eye className="w-3 h-3" /> {p.paymentType === "deposit" ? "Ảnh cọc" : "Ảnh"}{urls.length > 1 ? ` (${urls.length})` : ""}
                                </button>
                              );
                            })()}
                            {effectiveIsAdmin && p.status !== "voided" && (
                              <button
                                onClick={() => openVoidDialog(p.id)}
                                className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                title="Huỷ phiếu thu"
                              >
                                <Ban className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-0.5 pl-10">
                          {p.status === "voided" && (p.voidedBy || p.voidReason) && (
                            <div className="text-[11px] text-red-500 italic">
                              {p.voidedBy && <span>Huỷ bởi: <strong>{p.voidedBy}</strong></span>}
                              {p.voidedBy && p.voidReason && <span className="opacity-60"> · </span>}
                              {p.voidReason && <span>Lý do: {p.voidReason}</span>}
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <Clock className="w-3 h-3 flex-shrink-0" />
                            <span>{p.paymentType === "deposit"
                              ? (p.paidAt ? fmtDateTime(p.paidAt) : fmtDate(p.paidDate))
                              : (p.paidDate ? fmtDate(p.paidDate) : fmtDate(p.paidAt))}</span>
                            {p.collectorName && (
                              <><span className="opacity-40">·</span><span>{p.collectorName}</span></>
                            )}
                          </div>
                          {p.bankName && (
                            <p className="pl-4">{p.bankName}</p>
                          )}
                          {p.notes && (
                            <p className="pl-4 italic">"{p.notes}"</p>
                          )}
                        {(() => {
                          const own = (p.proofImageUrls && p.proofImageUrls.length) ? p.proofImageUrls : (p.proofImageUrl ? [p.proofImageUrl] : []);
                          const urls = own.length ? own : (p.paymentType === "deposit" ? depositProofImages : []);
                          if (urls.length === 0) return null;
                          return (
                            <div className="pl-4 pt-1 flex gap-1.5 flex-wrap">
                              {urls.map((u, i) => (
                                <div key={`${u}-${i}`} className="inline-flex rounded-xl overflow-hidden border border-border bg-background shadow-sm">
                                  <img
                                    src={getImageSrc(u) || u}
                                    alt={`Ảnh ${i + 1}`}
                                    className="w-28 h-20 object-cover cursor-pointer"
                                    onClick={() => { setProofPreviewUrl(getImageSrc(u) || u); setProofPreview(true); }}
                                  />
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Tổng kết */}
                {selectedBooking && paymentHistory.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-border space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tổng đã thu</span>
                      <span className="font-bold text-green-600">{fmtVND(actualPaid)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Còn lại</span>
                      <span className={cn(
                        "font-bold",
                        effectiveRemaining > 0 ? "text-red-600" : "text-green-600"
                      )}>
                        {effectiveRemaining > 0
                          ? fmtVND(effectiveRemaining)
                          : "✓ Đã thu đủ"}
                      </span>
                    </div>
                  </div>
                )}
              </div>

            </div>
          </div>

          {/* Sticky save button */}
          <div className="shrink-0 p-4 border-t border-border bg-background">
            <button
              onClick={savePayment}
              disabled={saving || !form.amount || amtNum <= 0}
              className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Đang lưu..." : "✅ Lưu phiếu thu"}
            </button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Sheet phiếu thu lẻ (ad-hoc, không gắn booking) ── */}
      <Sheet open={adHocOpen} onOpenChange={(v) => { if (!v) closeAdHoc(); }}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-lg p-0 flex flex-col h-full bg-background"
        >
          <div className="shrink-0 p-4 border-b border-border bg-fuchsia-50/40">
            <SheetTitle className="text-base font-bold text-foreground flex items-center gap-2">
              <PackageOpen className="w-4 h-4 text-fuchsia-700" />
              Thu tiền lẻ (ngoài đơn hàng)
            </SheetTitle>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Dùng cho thuê đồ lẻ, phụ kiện, mâm quả… không ảnh hưởng đến công nợ booking.
            </p>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Người trả */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold text-foreground mb-1 block">Tên người trả</label>
                <input
                  type="text"
                  value={adHocForm.payerName}
                  onChange={(e) => setAdHocForm(f => ({ ...f, payerName: e.target.value }))}
                  placeholder="VD: Chị Lan"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-foreground mb-1 block">SĐT</label>
                <input
                  type="tel"
                  value={adHocForm.payerPhone}
                  onChange={(e) => setAdHocForm(f => ({ ...f, payerPhone: e.target.value }))}
                  placeholder="VD: 09xx…"
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
              </div>
            </div>

            {/* Số tiền */}
            <div>
              <label className="text-xs font-bold text-foreground mb-1 block">Số tiền thu (VNĐ) *</label>
              <CurrencyInput
                value={adHocForm.amount}
                onChange={(v) => setAdHocForm(f => ({ ...f, amount: v }))}
                placeholder="VD: 200.000"
                className="h-12 text-lg font-bold border-2 border-fuchsia-300 bg-white focus-visible:ring-fuchsia-500 focus-visible:border-fuchsia-500"
              />
              {adHocForm.amount && (
                <p className="mt-1 text-xs text-fuchsia-700 font-semibold">
                  = {fmtVND(parseFloat(adHocForm.amount) || 0)}
                </p>
              )}
            </div>

            {/* Phương thức */}
            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">Phương thức</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setAdHocForm(f => ({ ...f, paymentMethod: "cash" }))}
                  className={cn(
                    "py-2 rounded-lg text-xs font-semibold border transition-colors",
                    adHocForm.paymentMethod === "cash"
                      ? "bg-emerald-600 text-white border-emerald-600"
                      : "bg-background border-border hover:bg-muted"
                  )}
                >Tiền mặt</button>
                <button
                  type="button"
                  onClick={() => setAdHocForm(f => ({ ...f, paymentMethod: "bank_transfer" }))}
                  className={cn(
                    "py-2 rounded-lg text-xs font-semibold border transition-colors",
                    adHocForm.paymentMethod === "bank_transfer"
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-background border-border hover:bg-muted"
                  )}
                >Chuyển khoản</button>
              </div>
              {adHocForm.paymentMethod === "bank_transfer" && (
                <input
                  type="text"
                  value={adHocForm.bankName}
                  onChange={(e) => setAdHocForm(f => ({ ...f, bankName: e.target.value }))}
                  placeholder="Tên ngân hàng (tuỳ chọn)"
                  className="mt-2 w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
              )}
            </div>

            {/* Nội dung */}
            <div>
              <label className="text-xs font-semibold text-foreground mb-1 block">Nội dung thu</label>
              <textarea
                value={adHocForm.description}
                onChange={(e) => setAdHocForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
                placeholder="VD: Thuê 1 áo dài cưới ngày 12/05"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none"
              />
            </div>

            {/* Thời điểm thu */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold text-foreground mb-1 block">Ngày thu</label>
                <DateInput
                  value={adHocForm.paidDate}
                  onChange={(v) => setAdHocForm(f => ({ ...f, paidDate: v, paidAtTouched: true }))}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-foreground mb-1 block">Giờ</label>
                <input
                  type="time"
                  value={adHocForm.paidTime}
                  onChange={(e) => setAdHocForm(f => ({ ...f, paidTime: e.target.value, paidAtTouched: true }))}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
              </div>
            </div>

            {/* Người thu */}
            <div>
              <label className="text-xs font-semibold text-foreground mb-1 block">Người thu</label>
              <input
                type="text"
                value={adHocForm.collectorName}
                onChange={(e) => setAdHocForm(f => ({ ...f, collectorName: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              />
            </div>

            {/* Bằng chứng */}
            <div>
              <label className="text-xs font-semibold text-foreground mb-1.5 block">
                Bằng chứng (ảnh, tối đa 20)
              </label>
              <input
                ref={adHocFileRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleAdHocImageUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => adHocFileRef.current?.click()}
                disabled={adHocUploading || adHocProofs.length >= 20}
                className="w-full py-2 rounded-lg border border-dashed border-border bg-muted/40 text-xs font-semibold hover:bg-muted disabled:opacity-50"
              >
                {adHocUploading ? "Đang tải ảnh…" : `+ Thêm ảnh (${adHocProofs.length}/20)`}
              </button>
              {adHocProofs.length > 0 && (
                <div className="mt-2 grid grid-cols-4 gap-1.5">
                  {adHocProofs.map((u, i) => (
                    <div key={`${u}-${i}`} className="relative group">
                      <img
                        src={getImageSrc(u) || u}
                        alt={`bc ${i + 1}`}
                        className="w-full aspect-square object-cover rounded-lg border border-border"
                      />
                      <button
                        type="button"
                        onClick={() => setAdHocProofs(prev => prev.filter((_, idx) => idx !== i))}
                        className="absolute -top-1 -right-1 bg-black/70 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {adHocError && (
              <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {adHocError}
              </div>
            )}
          </div>

          <div className="shrink-0 p-4 border-t border-border bg-background flex gap-2">
            <button
              type="button"
              onClick={closeAdHoc}
              className="flex-1 py-3 rounded-xl border border-border bg-background font-semibold text-sm hover:bg-muted"
            >
              Huỷ
            </button>
            <button
              type="button"
              onClick={saveAdHoc}
              disabled={adHocSaving || !adHocForm.amount}
              className="flex-1 py-3 rounded-xl bg-fuchsia-600 text-white font-semibold text-sm hover:bg-fuchsia-700 disabled:opacity-50"
            >
              {adHocSaving ? "Đang lưu…" : "✅ Lưu phiếu thu lẻ"}
            </button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Proof image lightbox */}
      {proofPreview && proofPreviewUrl && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85"
          onClick={() => { setProofPreview(false); setProofPreviewUrl(null); }}
        >
          <div
            className="relative max-w-lg max-h-[90vh]"
            onClick={e => e.stopPropagation()}
          >
            <img
              src={proofPreviewUrl}
              alt="bằng chứng"
              className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl"
            />
            <button
              onClick={() => { setProofPreview(false); setProofPreviewUrl(null); }}
              className="absolute top-3 right-3 bg-black/60 text-white rounded-full p-1.5"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Void Dialog ───────────────────────── */}
      <VoidDialog
        open={voidDialogOpen}
        reason={voidReason}
        onReasonChange={setVoidReason}
        onCancel={closeVoidDialog}
        onConfirm={() => { void confirmVoid(); }}
        loading={voidLoading}
        error={voidError}
      />
    </div>
  );
}
