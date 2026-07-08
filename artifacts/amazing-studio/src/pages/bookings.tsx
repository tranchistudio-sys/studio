import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useSearch, useLocation } from "wouter";
import { paymentFeedback } from "@/lib/feedback";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatVND, formatDate } from "@/lib/utils";
import { getImageSrc } from "@/lib/imageUtils";
import { OpenCalendarButton } from "@/components/OpenCalendarButton";
import { ConceptImage } from "@/components/ConceptImage";
import { Button, Input, Select, Textarea, Badge, Card, CardContent, Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui";
import { DateInput } from "@/components/ui/date-input";
import {
  Plus, Search, Phone, MapPin, Clock, Package2, ChevronRight, X, CheckCircle2,
  CreditCard, AlertCircle, FileText, Users, DollarSign, Receipt, ListChecks,
  Trash2, Edit2, Printer, Download, ShoppingCart, CalendarDays, History,
  ArrowUpCircle, ListFilter, Crown
} from "lucide-react";
import { ServiceSearchBox, type ServiceOption } from "@/components/service-search-box";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { SurchargeEditor, type SurchargeItem } from "@/components/surcharge-editor";
import { DeductionEditor, type DeductionItem } from "@/components/deduction-editor";
import { ServiceBreakdownCard } from "@/components/ServiceBreakdownCard";
import { computeServiceGroupStats } from "@/lib/service-group-stats";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const fetchJson = (url: string, opts?: RequestInit) =>
  fetch(`${BASE}${url}`, { headers: { "Content-Type": "application/json" }, ...opts }).then(async r => {
    const text = await r.text();
    let d: unknown;
    try { d = JSON.parse(text); } catch {
      throw new Error(r.status === 404 ? "API chưa sẵn sàng — hãy restart server (port 3000)" : `Lỗi server (${r.status})`);
    }
    if (!r.ok) throw new Error((d as { error?: string })?.error || "Lỗi kết nối");
    return d;
  });

const STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "Chờ xác nhận", color: "text-yellow-700", bg: "bg-yellow-100 border-yellow-200" },
  confirmed: { label: "Đã xác nhận", color: "text-blue-700", bg: "bg-blue-100 border-blue-200" },
  in_progress: { label: "Đang thực hiện", color: "text-purple-700", bg: "bg-purple-100 border-purple-200" },
  completed: { label: "Hoàn thành", color: "text-green-700", bg: "bg-green-100 border-green-200" },
  cancelled: { label: "Đã hủy", color: "text-red-700", bg: "bg-red-100 border-red-200" },
};

const SERVICE_CAT: Record<string, string> = {
  wedding: "Chụp cưới", beauty: "Chụp beauty", family: "Chụp gia đình",
  fashion: "Chụp thời trang", event: "Sự kiện", other: "Khác",
};

const PAYMENT_METHOD: Record<string, string> = {
  cash: "Tiền mặt", transfer: "Chuyển khoản", other: "Khác",
};

const PAYMENT_TYPE: Record<string, string> = {
  deposit: "Tiền cọc", partial: "Thanh toán một phần", payment: "Thanh toán", full: "Thanh toán đủ",
};

type Booking = {
  id: number; orderCode: string; customerId: number; customerName: string; customerPhone: string | null;
  shootDate: string; shootTime?: string; serviceCategory: string; packageType: string; location?: string;
  status: string; items: { name?: string; qty?: number; unitPrice?: number; total?: number; serviceName?: string; serviceLabel?: string; packageType?: string; price?: number; notes?: string; conceptImages?: string[]; [key: string]: unknown }[];
  totalAmount: number; depositAmount: number; paidAmount: number; discountAmount: number; remainingAmount: number;
  totalExpenses: number; grossProfit: number; internalNotes?: string; notes?: string;
  surcharges: { name: string; amount: number }[];
  deductions: DeductionItem[];
  payments: Payment[]; expenses: Expense[]; tasks: Task[];
  assignedStaff: number[]; createdAt: string;
  createdByStaffId?: number | null; createdByStaffName?: string | null;
};

type Payment = {
  id: number; amount: number; paymentMethod: string; paymentType: string; notes?: string; paidAt: string; collectorName?: string;
};

type Expense = {
  id: number; category: string; amount: number; description: string; type: string; expenseDate: string; paymentMethod: string;
};

type Task = {
  id: number; title: string; status: string; priority: string; dueDate?: string; assigneeName?: string; category: string;
};

type SimpleBooking = {
  id: number; orderCode: string; customerName: string; customerPhone: string | null; shootDate: string; shootTime?: string;
  serviceCategory: string; packageType: string; serviceLabel?: string | null; servicePackageId?: number | null;
  parentId?: number | null; isParentContract?: boolean | null;
  // items: backend VẪN gửi trong list — khai báo để card hiện tên dịch vụ + search theo dịch vụ
  items?: { serviceName?: string; serviceLabel?: string; name?: string; [key: string]: unknown }[] | null;
  status: string; totalAmount: number; paidAmount: number; remainingAmount: number; createdAt: string;
};

// Tên các dịch vụ trong đơn (từ items, bỏ trùng/rỗng) — fallback packageType.
function bookingServiceNames(b: SimpleBooking): string[] {
  const names = [...new Set(
    (b.items ?? [])
      .map(it => String(it.serviceName || it.serviceLabel || it.name || "").trim())
      .filter(Boolean),
  )];
  if (names.length > 0) return names;
  return b.packageType ? [b.packageType] : [];
}

export default function BookingsPage() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation(); // nút "Mở lịch chụp" → /calendar?bookingId=N
  const urlSearch = useSearch(); // query string hiện tại (reactive) — để deep-link ?bookingId mở đơn kể cả khi đang ở trang này
  const detailPanelRef = useRef<HTMLDivElement>(null); // cuộn tới ô chi tiết khi mở đơn từ deep-link
  const scrollPendingRef = useRef(false); // true = lần mở đơn này tới từ deep-link → cần cuộn tới ô chi tiết
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const today = new Date();
  const [monthFilter, setMonthFilter] = useState(String(today.getMonth() + 1).padStart(2, "0"));
  const [yearFilter, setYearFilter] = useState(String(today.getFullYear()));
  const [periodPreset, setPeriodPreset] = useState<"this" | "prev" | "next" | "all">("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showPayForm, setShowPayForm] = useState(false);
  const [activeTab, setActiveTab] = useState<"info" | "payment" | "expense" | "task" | "items">("info");
  const [payForm, setPayForm] = useState({ amount: "", paymentMethod: "transfer", paymentType: "payment", notes: "" });
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [showAddItem, setShowAddItem] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [itemForm, setItemForm] = useState({ title: "", qty: "1", unitPrice: "", notes: "" });
  const [upgradeForm, setUpgradeForm] = useState({ newPackageName: "", newPrice: "", notes: "" });
  const [showReschedule, setShowReschedule] = useState(false);
  const [rescheduleForm, setRescheduleForm] = useState({ newDate: "", newTime: "", reason: "" });
  const [showEditBooking, setShowEditBooking] = useState(false);
  const token = localStorage.getItem("amazingStudioToken_v2");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [filterStaffStatus, setFilterStaffStatus] = useState("");
  const [filterPaymentStatus, setFilterPaymentStatus] = useState("");
  const [filterProgressStatus, setFilterProgressStatus] = useState("");
  const [filterServiceCategory, setFilterServiceCategory] = useState("");

  const advancedParams = useMemo(() => {
    const p = new URLSearchParams();
    if (periodPreset !== "all") p.set("shootMonth", `${yearFilter}-${monthFilter}`);
    if (filterStaffStatus) p.set("staffStatus", filterStaffStatus);
    if (filterPaymentStatus) p.set("paymentStatus", filterPaymentStatus);
    if (filterProgressStatus) p.set("progressStatus", filterProgressStatus);
    if (filterServiceCategory) p.set("serviceCategory", filterServiceCategory);
    return p.toString();
  }, [periodPreset, yearFilter, monthFilter, filterStaffStatus, filterPaymentStatus, filterProgressStatus, filterServiceCategory]);

  const hasAdvancedFilter = !!(filterStaffStatus || filterPaymentStatus || filterProgressStatus || filterServiceCategory);

  const { data: bookings = [], isLoading } = useQuery<SimpleBooking[]>({
    queryKey: ["bookings", advancedParams],
    queryFn: () => fetchJson(`/api/bookings${advancedParams ? `?${advancedParams}` : ""}`),
  });

  const { data: customers = [] } = useQuery<{ id: number; name: string; phone: string | null; customCode?: string; customerRank?: string; totalDebt?: number }[]>({
    queryKey: ["customers-light"],
    queryFn: () => fetchJson("/api/customers"),
  });

  const { data: servicePackages = [] } = useQuery<{ id: number; name: string; groupId: number | null }[]>({
    queryKey: ["service-packages"],
    queryFn: () => fetchJson("/api/service-packages"),
    staleTime: 60_000,
  });
  const { data: serviceGroups = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["service-groups"],
    queryFn: () => fetchJson("/api/service-groups"),
    staleTime: 60_000,
  });

  const { data: detail, isLoading: detailLoading } = useQuery<Booking>({
    queryKey: ["booking", selectedId],
    queryFn: () => fetchJson(`/api/bookings/${selectedId}`),
    enabled: !!selectedId,
  });

  // Deep-link từ Lịch chụp / ô Tìm kiếm thông minh: /bookings?bookingId=N → tự động mở chi tiết đơn.
  // Phản ứng theo query string (urlSearch) nên hoạt động kể cả khi ĐANG ở trang Đơn hàng mà bấm
  // 1 kết quả tìm kiếm khác (component không remount). Mở rộng filter sang "Tất cả" để chắc chắn
  // đơn nằm trong danh sách (kể cả khi shootDate khác tháng đang xem).
  useEffect(() => {
    const params = new URLSearchParams(urlSearch || window.location.search);
    const bid = params.get("bookingId");
    if (!bid) return;
    const id = Number(bid);
    if (Number.isFinite(id) && id > 0) {
      setPeriodPreset("all");
      setSelectedId(id);
      scrollPendingRef.current = true; // cuộn tới ô chi tiết khi panel mount xong (đỡ phải tự kéo trang)
    }
    // Xoá bookingId khỏi URL sau khi đã mở (tránh mở lại khi reload / cho phép bấm lại cùng 1 đơn).
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("bookingId");
      window.history.replaceState({}, "", url.toString());
    } catch { /* ignore */ }
  }, [urlSearch]);

  // Mở đơn từ deep-link → cuộn ô chi tiết vào tầm nhìn. Key theo selectedId (ỔN ĐỊNH, set 1 lần) chứ
  // KHÔNG theo `detail` (react-query đổi tham chiếu liên tục làm cleanup hủy interval trước khi cuộn).
  // Re-assert cuộn nhiều lần vì panel tải bất đồng bộ + khối "Tổng hợp dịch vụ" phía trên xê dịch layout.
  useEffect(() => {
    if (!scrollPendingRef.current || !selectedId) return;
    scrollPendingRef.current = false;
    let n = 0;
    const timer = setInterval(() => {
      const el = detailPanelRef.current;
      if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
      if (++n >= 12) clearInterval(timer); // ~1.8s, đủ chờ chi tiết tải xong & layout ổn định
    }, 150);
    return () => clearInterval(timer);
  }, [selectedId]);

  const addPayment = useMutation({
    mutationFn: (data: Record<string, unknown>) => fetchJson("/api/payments", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { paymentFeedback(); qc.invalidateQueries({ queryKey: ["booking", selectedId] }); qc.invalidateQueries({ queryKey: ["bookings"] }); setShowPayForm(false); setPayForm({ amount: "", paymentMethod: "transfer", paymentType: "payment", notes: "" }); },
  });

  const deletePayment = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/payments/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["booking", selectedId] }); qc.invalidateQueries({ queryKey: ["bookings"] }); },
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => fetchJson(`/api/bookings/${id}`, { method: "PUT", body: JSON.stringify({ status }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["booking", selectedId] }); qc.invalidateQueries({ queryKey: ["bookings"] }); },
  });

  const [trashDialog, setTrashDialog] = useState<number | null>(null);
  const [trashReason, setTrashReason] = useState("");
  const deleteBooking = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason?: string }) =>
      fetch(`${BASE}/api/bookings/${id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason || null }) }),
    onSuccess: () => { setSelectedId(null); setTrashDialog(null); setTrashReason(""); qc.invalidateQueries({ queryKey: ["bookings"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); },
  });

  // ── Task #10: Booking items ──────────────────────────────────────────────
  const authHeaders = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const fetchJsonAuth = (url: string, opts?: RequestInit) =>
    fetch(`${BASE}${url}`, { headers: authHeaders, ...opts }).then(r => r.json());

  type BookingItem = { id: number; type: string; title: string; qty: number; unitPrice: number; totalPrice: number; notes?: string; isActive: number; };
  const { data: bookingItems = [] } = useQuery<BookingItem[]>({
    queryKey: ["booking-items", selectedId],
    queryFn: () => fetchJsonAuth(`/api/bookings/${selectedId}/items`),
    enabled: !!selectedId && activeTab === "items",
  });

  const addItem = useMutation({
    mutationFn: (data: Record<string, unknown>) => fetchJsonAuth(`/api/bookings/${selectedId}/items`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["booking-items", selectedId] }); setShowAddItem(false); setItemForm({ title: "", qty: "1", unitPrice: "", notes: "" }); },
  });

  const deleteItem = useMutation({
    mutationFn: (itemId: number) => fetchJsonAuth(`/api/bookings/${selectedId}/items/${itemId}`, { method: "PUT", body: JSON.stringify({ isActive: 0 }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["booking-items", selectedId] }),
  });

  const upgradePackage = useMutation({
    mutationFn: (data: Record<string, unknown>) => fetchJsonAuth(`/api/bookings/${selectedId}/upgrade`, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["booking-items", selectedId] });
      qc.invalidateQueries({ queryKey: ["booking", selectedId] });
      qc.invalidateQueries({ queryKey: ["bookings"] });
      setShowUpgrade(false);
      setUpgradeForm({ newPackageName: "", newPrice: "", notes: "" });
    },
  });

  // ── Task #11: Reschedule ─────────────────────────────────────────────────
  const reschedule = useMutation({
    mutationFn: (data: Record<string, unknown>) => fetchJsonAuth(`/api/bookings/${selectedId}/reschedule`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["booking", selectedId] });
      qc.invalidateQueries({ queryKey: ["bookings"] });
      setShowReschedule(false);
      setRescheduleForm({ newDate: "", newTime: "", reason: "" });
    },
    onError: (err: unknown) => {
      const msg = (err as { message?: string })?.message || "Lỗi đổi lịch";
      alert(msg);
    },
  });

  const filtered = useMemo(() => {
    const safeBookings = Array.isArray(bookings) ? bookings : [];
    return safeBookings.filter(b => {
      // Tìm theo: tên khách / mã đơn / SĐT / tên dịch vụ (packageType + serviceLabel + items[].serviceName)
      const q = search.trim().toLowerCase();
      const matchSearch = !q
        || b.customerName.toLowerCase().includes(q)
        || b.orderCode?.toLowerCase().includes(q)
        || (b.customerPhone ?? "").includes(search.trim())
        || (b.packageType ?? "").toLowerCase().includes(q)
        || (b.serviceLabel ?? "").toLowerCase().includes(q)
        || bookingServiceNames(b).some(n => n.toLowerCase().includes(q));
      const matchStatus = !statusFilter || b.status === statusFilter;
      if (!matchSearch || !matchStatus) return false;
      if (periodPreset === "all") return true;
      const d = new Date(b.shootDate);
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const y = String(d.getFullYear());
      return m === monthFilter && y === yearFilter;
    });
  }, [bookings, monthFilter, periodPreset, search, statusFilter, yearFilter]);

  const totals = useMemo(() => ({
    total: filtered.reduce((s, b) => s + b.totalAmount, 0),
    paid: filtered.reduce((s, b) => s + b.paidAmount, 0),
    remaining: filtered.reduce((s, b) => s + b.remainingAmount, 0),
    count: filtered.length,
  }), [filtered]);

  const serviceGroupStats = useMemo(
    () => computeServiceGroupStats(filtered, servicePackages, serviceGroups),
    [filtered, servicePackages, serviceGroups],
  );

  // Thu gọn/mở rộng khối "Tổng hợp dịch vụ đã chốt" — nhớ lựa chọn qua localStorage
  const [svcStatsOpen, setSvcStatsOpen] = useState(() => localStorage.getItem("bookings.svcStatsOpen") !== "0");

  const serviceGroupTotal = useMemo(
    () => serviceGroupStats.reduce((s, x) => s + x.count, 0),
    [serviceGroupStats],
  );

  const periodLabelForStats = periodPreset === "all"
    ? "Tất cả đơn đang lọc"
    : `Tháng ${monthFilter}/${yearFilter}`;

  const presetLabel = periodPreset === "this" ? "Tháng này" : periodPreset === "prev" ? "Tháng trước" : periodPreset === "next" ? "Tháng sau" : "Tất cả";

  const applyPreset = (preset: "this" | "prev" | "next" | "all") => {
    setPeriodPreset(preset);
    const base = new Date();
    if (preset === "all") return;
    if (preset === "prev") base.setMonth(base.getMonth() - 1);
    if (preset === "next") base.setMonth(base.getMonth() + 1);
    setMonthFilter(String(base.getMonth() + 1).padStart(2, "0"));
    setYearFilter(String(base.getFullYear()));
  };

  // totalAmount is already the final amount (base + surcharges − deductions), do NOT re-add surcharges
  const effectiveTotal = detail ? detail.totalAmount : 0;
  const effectiveRemaining = detail
    ? Math.max(0, effectiveTotal - (detail.discountAmount ?? 0) - (detail.paidAmount ?? 0))
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Quản lý Đơn hàng</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Tạo đơn, theo dõi tiến độ và thu tiền tất cả trong một màn hình</p>
          <p className="text-xs text-muted-foreground mt-1">Đang xem: {presetLabel}{periodPreset !== "all" ? ` • ${monthFilter}/${yearFilter}` : ""}</p>
        </div>
        <Button onClick={() => setShowCreateForm(true)} className="gap-2">
          <Plus className="w-4 h-4" /> Tạo đơn mới
        </Button>
      </div>

      <div className="rounded-xl border bg-card p-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          {[
            ["this", "Tháng này"],
            ["prev", "Tháng trước"],
            ["next", "Tháng sau"],
            ["all", "Tất cả"],
          ].map(([key, label]) => (
            <Button key={key} type="button" variant={periodPreset === key ? "default" : "outline"} size="sm" onClick={() => applyPreset(key as "this" | "prev" | "next" | "all")}>
              {label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:max-w-md">
          <Select value={monthFilter} onChange={e => { setMonthFilter(e.target.value); setPeriodPreset("this"); }}>
            {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map(m => <option key={m} value={m}>Tháng {m}</option>)}
          </Select>
          <Select value={yearFilter} onChange={e => { setYearFilter(e.target.value); setPeriodPreset("this"); }}>
            {Array.from({ length: 5 }, (_, i) => String(today.getFullYear() - 2 + i)).map(y => <option key={y} value={y}>Năm {y}</option>)}
          </Select>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Tổng đơn", value: totals.count, sub: "đơn hàng", color: "text-blue-600", bg: "bg-blue-50" },
          { label: "Tổng doanh thu", value: formatVND(totals.total), sub: "dự kiến", color: "text-green-600", bg: "bg-green-50" },
          { label: "Đã thu", value: formatVND(totals.paid), sub: "thực tế", color: "text-primary", bg: "bg-primary/5" },
          { label: "Còn công nợ", value: formatVND(totals.remaining), sub: "chưa thu", color: "text-red-600", bg: "bg-red-50" },
        ].map(c => (
          <div key={c.label} className={`rounded-xl border p-3 ${c.bg}`}>
            <p className="text-xs text-muted-foreground">{c.label}</p>
            <p className={`text-lg font-bold ${c.color}`}>{c.value}</p>
            <p className="text-xs text-muted-foreground">{c.sub}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-card p-4">
        {/* Header bấm được để thu gọn/mở rộng — trạng thái nhớ qua localStorage */}
        <button
          type="button"
          onClick={() => setSvcStatsOpen(o => {
            const v = !o;
            localStorage.setItem("bookings.svcStatsOpen", v ? "1" : "0");
            return v;
          })}
          className="w-full flex items-center justify-between gap-2 text-left"
          title={svcStatsOpen ? "Thu gọn tổng hợp dịch vụ" : "Mở rộng tổng hợp dịch vụ"}
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-wide">Tổng hợp dịch vụ đã chốt</p>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {periodLabelForStats} · {serviceGroupTotal} đơn · theo nhóm dịch vụ (không tính gói giá)
            </p>
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${svcStatsOpen ? "rotate-90" : ""}`} />
        </button>
        {svcStatsOpen && (
          serviceGroupStats.length === 0 ? (
            <p className="text-sm text-muted-foreground mt-3">Chưa có đơn trong kỳ đang xem</p>
          ) : (
            <div className="space-y-3 mt-3">
              {serviceGroupStats.map((row, idx) => (
                <div key={row.label}>
                  <div className="flex items-center justify-between gap-3 text-sm mb-1">
                    <span className="font-medium truncate">
                      {idx < 3 && <span className="text-muted-foreground mr-1.5">#{idx + 1}</span>}
                      {row.label}
                    </span>
                    <span className="font-semibold tabular-nums flex-shrink-0">{row.count} đơn</span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary/80 rounded-full transition-all"
                      style={{ width: `${Math.max(row.pct, row.count > 0 ? 8 : 0)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      <div className="flex gap-4">
        {/* List */}
        <div className={`flex-1 ${selectedId ? "hidden lg:flex lg:flex-col" : "flex flex-col"} min-w-0`}>
          {/* Filters */}
          <div className="space-y-2 mb-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input className="pl-9" placeholder="Tìm khách, mã đơn, SĐT, dịch vụ..." value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <Select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="w-36">
                <option value="">Tất cả trạng thái</option>
                {Object.entries(STATUS_MAP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
              <button
                onClick={() => setShowAdvanced(v => !v)}
                className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border transition-colors ${(showAdvanced || hasAdvancedFilter) ? "border-primary bg-primary/5 text-primary" : "border-border bg-background text-muted-foreground hover:text-foreground"}`}
                title="Bộ lọc nâng cao"
              >
                <ListFilter className="w-3.5 h-3.5" />
                {hasAdvancedFilter && <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />}
              </button>
            </div>
            {showAdvanced && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-3 rounded-xl border bg-muted/30">
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground mb-1">Nhân sự</p>
                  <Select value={filterStaffStatus} onChange={e => setFilterStaffStatus(e.target.value)}>
                    <option value="">Tất cả</option>
                    <option value="unassigned">Chưa giao việc</option>
                    <option value="understaffed">Thiếu người</option>
                    <option value="ready">Đủ nhân sự</option>
                  </Select>
                </div>
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground mb-1">Thanh toán</p>
                  <Select value={filterPaymentStatus} onChange={e => setFilterPaymentStatus(e.target.value)}>
                    <option value="">Tất cả</option>
                    <option value="debt">Còn nợ</option>
                    <option value="paid">Đã thanh toán</option>
                  </Select>
                </div>
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground mb-1">Tiến độ hậu kỳ</p>
                  <Select value={filterProgressStatus} onChange={e => setFilterProgressStatus(e.target.value)}>
                    <option value="">Tất cả</option>
                    <option value="pending">Chờ xử lý</option>
                    <option value="in_progress">Đang làm</option>
                    <option value="overdue">Quá hạn</option>
                    <option value="done">Hoàn thành</option>
                  </Select>
                </div>
                <div>
                  <p className="text-[10px] font-medium text-muted-foreground mb-1">Loại dịch vụ</p>
                  <Select value={filterServiceCategory} onChange={e => setFilterServiceCategory(e.target.value)}>
                    <option value="">Tất cả</option>
                    {Object.entries(SERVICE_CAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </div>
                {hasAdvancedFilter && (
                  <div className="col-span-full flex justify-end">
                    <button
                      onClick={() => { setFilterStaffStatus(""); setFilterPaymentStatus(""); setFilterProgressStatus(""); setFilterServiceCategory(""); }}
                      className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                    >
                      <X className="w-3 h-3" /> Xóa bộ lọc
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {isLoading ? (
            <div className="flex-1 flex items-center justify-center py-20 text-muted-foreground">Đang tải...</div>
          ) : filtered.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-20 text-muted-foreground gap-2">
              <p>Không có đơn hàng{periodPreset !== "all" ? ` trong ${monthFilter}/${yearFilter}` : ""}</p>
              {periodPreset !== "all" && (
                <Button type="button" variant="outline" size="sm" onClick={() => applyPreset("all")}>
                  Xem tất cả đơn
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-2 overflow-y-auto">
              {filtered.map(b => {
                const s = STATUS_MAP[b.status] ?? STATUS_MAP.pending;
                const pct = b.totalAmount > 0 ? (b.paidAmount / b.totalAmount) * 100 : 0;
                const paidFull = b.remainingAmount === 0 && b.totalAmount > 0;
                // Tối đa 2 dịch vụ chính, còn lại gom "+N dịch vụ khác"
                const svcNames = bookingServiceNames(b);
                const svcShown = svcNames.slice(0, 2);
                const svcMore = svcNames.length - svcShown.length;
                return (
                  <div
                    key={b.id}
                    onClick={() => { setSelectedId(b.id); setActiveTab("info"); }}
                    className={`rounded-xl border cursor-pointer transition-all hover:shadow-md ${selectedId === b.id ? "border-primary bg-primary/5 shadow-sm" : "bg-card hover:border-primary/40"}`}
                  >
                    {/* Vùng 1: Khách + mã đơn + trạng thái | Tổng đơn + còn nợ */}
                    <div className="flex items-start justify-between gap-3 px-4 pt-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm truncate max-w-[180px] sm:max-w-none">{b.customerName}</span>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border flex-shrink-0 ${s.bg}`}>{s.label}</span>
                        </div>
                        <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{b.orderCode}</p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="font-bold text-base text-primary leading-tight">{formatVND(b.totalAmount)}</p>
                        {b.remainingAmount > 0 && <p className="text-[11px] text-red-600 font-semibold mt-0.5">Còn nợ: {formatVND(b.remainingAmount)}</p>}
                        {paidFull && <p className="text-[11px] text-green-600 font-semibold mt-0.5">✓ Đã thanh toán đủ</p>}
                      </div>
                    </div>

                    {/* Vùng 2: SĐT + ngày giờ chụp */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground px-4 mt-2">
                      {b.customerPhone && (
                        <span className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5 flex-shrink-0" />{b.customerPhone}</span>
                      )}
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                        {b.shootDate ? <>{formatDate(b.shootDate)}{b.shootTime ? ` · ${b.shootTime.slice(0, 5)}` : ""}</> : "Chưa có ngày chụp"}
                      </span>
                    </div>

                    {/* Vùng 3: Dịch vụ (tối đa 2 + "+N dịch vụ khác") */}
                    {svcNames.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 px-4 mt-2">
                        <Package2 className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        {svcShown.map(n => (
                          <span key={n} className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-foreground/80 max-w-[200px] truncate">{n}</span>
                        ))}
                        {svcMore > 0 && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-primary/10 text-primary">+{svcMore} dịch vụ khác</span>
                        )}
                      </div>
                    )}

                    {/* Vùng 4: Đã thu + tiến độ + nút mở lịch */}
                    <div className="flex items-end gap-3 px-4 pb-3 mt-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between text-[10px] mb-0.5">
                          <span className="text-emerald-600 font-semibold">Đã thu: {formatVND(b.paidAmount)}</span>
                          <span className="text-muted-foreground">{Math.round(pct)}%</span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${paidFull ? "bg-green-500" : "bg-primary"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                      </div>
                      <OpenCalendarButton bookingId={b.id} shootDate={b.shootDate} requireShootDate />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Detail Panel */}
        {selectedId && (
          <div ref={detailPanelRef} className="w-full lg:w-[55%] xl:w-[60%] flex-shrink-0">
            <div className="bg-card rounded-2xl border shadow-sm overflow-hidden h-full">
              {detailLoading || !detail ? (
                <div className="flex items-center justify-center h-64 text-muted-foreground">Đang tải chi tiết...</div>
              ) : (
                <>
                  {/* Order Header */}
                  <div className="px-5 py-4 border-b bg-gradient-to-r from-primary/5 to-card">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="font-bold text-lg">{detail.customerName}</h2>
                          <span className="text-sm text-muted-foreground">{detail.orderCode}</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1 flex-wrap">
                          {detail.customerPhone && <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" />{detail.customerPhone}</span>}
                          <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{formatDate(detail.shootDate)} {detail.shootTime?.slice(0, 5)}</span>
                          {detail.location && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{detail.location}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Select value={detail.status} onChange={e => updateStatus.mutate({ id: detail.id, status: e.target.value })} className="text-xs h-8 py-1">
                          {Object.entries(STATUS_MAP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </Select>
                        <button onClick={() => setShowEditBooking(true)} className="p-1.5 hover:bg-muted rounded-lg text-muted-foreground hover:text-primary" title="Sửa đơn hàng">
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button onClick={() => setSelectedId(null)} className="lg:hidden p-1.5 hover:bg-muted rounded-lg">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Financial Summary */}
                    <div className="grid grid-cols-3 gap-2 mt-3">
                      {[
                        { label: "Tổng đơn", value: formatVND(effectiveTotal), color: "text-foreground" },
                        { label: "Đã thu", value: formatVND(detail.paidAmount), color: "text-green-600" },
                        { label: "Còn nợ", value: formatVND(effectiveRemaining), color: effectiveRemaining > 0 ? "text-red-600" : "text-green-600" },
                      ].map(f => (
                        <div key={f.label} className="bg-background rounded-lg p-2 text-center border">
                          <p className="text-[10px] text-muted-foreground">{f.label}</p>
                          <p className={`text-sm font-bold ${f.color}`}>{f.value}</p>
                        </div>
                      ))}
                    </div>

                    {/* Progress bar */}
                    <div className="mt-2">
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full" style={{ width: `${effectiveTotal > 0 ? Math.min((detail.paidAmount / effectiveTotal) * 100, 100) : 0}%` }} />
                      </div>
                    </div>
                  </div>

                  {/* Tabs */}
                  <div className="flex border-b text-sm overflow-x-auto">
                    {(["info", "items", "payment", "expense", "task"] as const).map(tab => (
                      <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`px-3 py-2.5 font-medium whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5
                          ${activeTab === tab ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                      >
                        {tab === "info" && <><FileText className="w-3.5 h-3.5" />Thông tin</>}
                        {tab === "items" && <><ShoppingCart className="w-3.5 h-3.5" />Hạng mục</>}
                        {tab === "payment" && <><CreditCard className="w-3.5 h-3.5" />Thu tiền{detail.payments.length > 0 && <span className="text-[10px] bg-primary/15 text-primary rounded-full px-1.5">{detail.payments.length}</span>}</>}
                        {tab === "expense" && <><Receipt className="w-3.5 h-3.5" />Chi phí</>}
                        {tab === "task" && <><ListChecks className="w-3.5 h-3.5" />Công việc{detail.tasks.length > 0 && <span className="text-[10px] bg-muted text-muted-foreground rounded-full px-1.5">{detail.tasks.length}</span>}</>}
                      </button>
                    ))}
                  </div>

                  {/* Tab Content */}
                  <div className="overflow-y-auto max-h-[calc(100vh-420px)] p-4 space-y-4">
                    {/* INFO TAB */}
                    {activeTab === "info" && (
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div><p className="text-muted-foreground text-xs">Loại dịch vụ</p><p className="font-medium">{SERVICE_CAT[detail.serviceCategory] ?? detail.serviceCategory}</p></div>
                          <div><p className="text-muted-foreground text-xs">Gói</p><p className="font-medium">{detail.packageType}</p></div>
                          {detail.createdByStaffName && <div><p className="text-muted-foreground text-xs">Người tạo</p><p className="font-medium">{detail.createdByStaffName}</p></div>}
                          {detail.discountAmount > 0 && <div><p className="text-muted-foreground text-xs">Giảm giá</p><p className="font-medium text-green-600">-{formatVND(detail.discountAmount)}</p></div>}
                          <div><p className="text-muted-foreground text-xs">Chi phí show</p><p className="font-medium text-red-600">{formatVND(detail.totalExpenses)}</p></div>
                          <div><p className="text-muted-foreground text-xs">Lợi nhuận gộp</p><p className={`font-bold ${detail.grossProfit >= 0 ? "text-green-600" : "text-red-600"}`}>{formatVND(detail.grossProfit)}</p></div>
                        </div>

                        {detail.items.length > 0 && (
                          <div className="space-y-3">
                            <h4 className="font-semibold text-sm">Danh sách dịch vụ</h4>
                            {detail.items.map((item, i) => {
                              const displayName = item.serviceName || item.name || `Dịch vụ ${i + 1}`;
                              const displayPrice = item.price ?? item.total ?? 0;
                              const qty = item.qty;
                              const unitPrice = item.unitPrice;
                              return (
                                <div key={i} className="rounded-xl border border-border/50 overflow-hidden">
                                  <div className="flex items-center justify-between px-3 py-2.5 bg-muted/30 gap-2">
                                    <span className="font-semibold text-sm flex-1 min-w-0">{displayName}</span>
                                    <div className="flex items-center gap-2 shrink-0">
                                      {qty != null && qty > 1 && (
                                        <span className="text-xs text-muted-foreground">x{qty}</span>
                                      )}
                                      {unitPrice != null && qty != null && qty > 1 && (
                                        <span className="text-xs text-muted-foreground">{formatVND(unitPrice)}</span>
                                      )}
                                      {displayPrice > 0 && (
                                        <span className="text-sm font-bold text-primary">{formatVND(displayPrice)}</span>
                                      )}
                                    </div>
                                  </div>
                                  {item.notes && (
                                    <div className="px-3 py-2 bg-amber-50/40 border-t border-border/30">
                                      <p className="text-[10px] font-bold text-amber-700 mb-1">📝 Ghi chú dịch vụ</p>
                                      <p className="text-xs text-amber-800 leading-relaxed whitespace-pre-line">{item.notes}</p>
                                    </div>
                                  )}
                                  {item.conceptImages && item.conceptImages.length > 0 && (
                                    <div className="px-3 py-2 border-t border-border/30">
                                      <p className="text-[10px] font-bold text-muted-foreground mb-2">🖼️ Ảnh concept ({item.conceptImages.length})</p>
                                      <div className="grid grid-cols-4 gap-1.5">
                                        {item.conceptImages.map((imgUrl, ci) => {
                                          const src = getImageSrc(imgUrl);
                                          return src ? (
                                            <button
                                              key={src}
                                              onClick={() => setPreviewImg(src)}
                                              className="aspect-square rounded-lg overflow-hidden bg-muted hover:ring-2 hover:ring-primary transition-all"
                                            >
                                              <ConceptImage src={src} alt={`concept ${ci + 1}`} />
                                            </button>
                                          ) : null;
                                        })}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {detail.notes && (
                          <div className="p-3 bg-muted/30 rounded-xl text-sm">
                            <p className="font-semibold text-xs text-muted-foreground mb-1">Ghi chú khách hàng</p>
                            <p>{detail.notes}</p>
                          </div>
                        )}
                        {detail.internalNotes && (
                          <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-xl text-sm">
                            <p className="font-semibold text-xs text-yellow-700 mb-1">⚠ Ghi chú nội bộ</p>
                            <p className="text-yellow-800">{detail.internalNotes}</p>
                          </div>
                        )}

                        <div className="flex gap-2 pt-2 border-t flex-wrap">
                          {/* Nhảy sang lịch chụp đúng show này (deep-link ?bookingId sẵn có của calendar) */}
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5 border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={!detail.shootDate}
                            title={detail.shootDate ? "Mở show này trên lịch chụp để sửa lịch / giao việc / giờ chụp" : "Chưa có ngày chụp"}
                            onClick={() => { if (detail.shootDate) setLocation(`/calendar?bookingId=${detail.id}`); }}
                          >
                            <CalendarDays className="w-3.5 h-3.5" /> Mở lịch chụp
                          </Button>
                          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setShowReschedule(true); setRescheduleForm({ newDate: detail.shootDate, newTime: detail.shootTime || "", reason: "" }); }}>
                            <CalendarDays className="w-3.5 h-3.5" /> Đổi lịch
                          </Button>
                          <Button variant="destructive" size="sm" className="gap-1.5" onClick={() => { setTrashReason(""); setTrashDialog(detail.id); }}>
                            <Trash2 className="w-3.5 h-3.5" /> Xóa đơn
                          </Button>
                        </div>
                        {trashDialog === detail.id && (
                          <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4" onClick={() => setTrashDialog(null)}>
                            <div className="bg-background w-full max-w-md rounded-2xl shadow-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
                              <h3 className="font-bold text-base flex items-center gap-2 text-destructive"><Trash2 className="w-5 h-5" /> Chuyển vào Thùng rác</h3>
                              <p className="text-sm text-muted-foreground">Booking sẽ được chuyển vào <b>Thùng rác</b>. Các dữ liệu liên quan như giao việc, lương, thu chi sẽ <b>không còn được tính</b> trong hệ thống hoạt động. Có thể phục hồi sau trong "Thùng rác Booking".</p>
                              <div>
                                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Lý do xóa (không bắt buộc)</label>
                                <textarea value={trashReason} onChange={e => setTrashReason(e.target.value)} rows={2} placeholder="VD: khách hủy, nhập nhầm..." className="w-full px-3 py-2 border border-border rounded-xl bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-300" />
                              </div>
                              <div className="flex gap-3 pt-1">
                                <button onClick={() => setTrashDialog(null)} className="flex-1 py-2.5 border border-border rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted">Hủy</button>
                                <button onClick={() => deleteBooking.mutate({ id: detail.id, reason: trashReason })} disabled={deleteBooking.isPending}
                                  className="flex-1 py-2.5 bg-destructive text-white rounded-xl text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                                  {deleteBooking.isPending ? "Đang xử lý..." : "Chuyển vào thùng rác"}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ITEMS TAB */}
                    {activeTab === "items" && (
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <Button size="sm" className="gap-1.5 flex-1" onClick={() => setShowAddItem(true)}>
                            <Plus className="w-3.5 h-3.5" /> Thêm hạng mục
                          </Button>
                          <Button size="sm" variant="outline" className="gap-1.5 flex-1" onClick={() => setShowUpgrade(true)}>
                            <ArrowUpCircle className="w-3.5 h-3.5" /> Nâng gói
                          </Button>
                        </div>

                        {showAddItem && (
                          <div className="rounded-xl border bg-muted/20 p-3 space-y-2">
                            <h4 className="font-semibold text-sm">Thêm hạng mục</h4>
                            <Input placeholder="Tên hạng mục *" value={itemForm.title} onChange={e => setItemForm(f => ({ ...f, title: e.target.value }))} />
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-xs text-muted-foreground">Số lượng</label>
                                <Input type="number" placeholder="1" value={itemForm.qty} onChange={e => setItemForm(f => ({ ...f, qty: e.target.value }))} />
                              </div>
                              <div>
                                <label className="text-xs text-muted-foreground">Đơn giá (VNĐ)</label>
                                <Input type="number" placeholder="0" value={itemForm.unitPrice} onChange={e => setItemForm(f => ({ ...f, unitPrice: e.target.value }))} />
                              </div>
                            </div>
                            <Input placeholder="Ghi chú..." value={itemForm.notes} onChange={e => setItemForm(f => ({ ...f, notes: e.target.value }))} />
                            <div className="flex gap-2">
                              <Button size="sm" onClick={() => addItem.mutate({ title: itemForm.title, qty: itemForm.qty, unitPrice: itemForm.unitPrice, notes: itemForm.notes })} disabled={!itemForm.title || addItem.isPending}>
                                {addItem.isPending ? "Đang lưu..." : "Lưu"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setShowAddItem(false)}>Hủy</Button>
                            </div>
                          </div>
                        )}

                        {showUpgrade && (
                          <div className="rounded-xl border bg-blue-50 border-blue-200 p-3 space-y-2">
                            <h4 className="font-semibold text-sm text-blue-900">Nâng gói dịch vụ</h4>
                            <Input placeholder="Tên gói mới *" value={upgradeForm.newPackageName} onChange={e => setUpgradeForm(f => ({ ...f, newPackageName: e.target.value }))} />
                            <Input type="number" placeholder="Giá gói mới (VNĐ) *" value={upgradeForm.newPrice} onChange={e => setUpgradeForm(f => ({ ...f, newPrice: e.target.value }))} />
                            <Input placeholder="Ghi chú lý do nâng..." value={upgradeForm.notes} onChange={e => setUpgradeForm(f => ({ ...f, notes: e.target.value }))} />
                            <div className="flex gap-2">
                              <Button size="sm" onClick={() => upgradePackage.mutate({ newPackageName: upgradeForm.newPackageName, newPrice: parseFloat(upgradeForm.newPrice), notes: upgradeForm.notes })} disabled={!upgradeForm.newPackageName || !upgradeForm.newPrice || upgradePackage.isPending}>
                                {upgradePackage.isPending ? "Đang lưu..." : "Xác nhận nâng gói"}
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => setShowUpgrade(false)}>Hủy</Button>
                            </div>
                          </div>
                        )}

                        {bookingItems.filter(i => i.isActive).length === 0 ? (
                          <div className="text-center py-6 text-muted-foreground text-sm">Chưa có hạng mục nào</div>
                        ) : (
                          <div className="space-y-2">
                            {bookingItems.filter(i => i.isActive).map(item => (
                              <div key={item.id} className="flex items-center justify-between p-3 rounded-xl border bg-card">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                      item.type === "base_package" ? "bg-blue-100 text-blue-700" :
                                      item.type === "upgrade_delta" ? "bg-purple-100 text-purple-700" :
                                      item.type === "discount" ? "bg-green-100 text-green-700" :
                                      "bg-gray-100 text-gray-700"
                                    }`}>
                                      {item.type === "base_package" ? "Gói gốc" : item.type === "upgrade_delta" ? "Nâng gói" : item.type === "discount" ? "Giảm giá" : "Addon"}
                                    </span>
                                    <span className="font-medium text-sm">{item.title}</span>
                                  </div>
                                  {item.qty > 1 && <p className="text-xs text-muted-foreground mt-0.5 ml-0">x{item.qty} × {formatVND(item.unitPrice)}</p>}
                                  {item.notes && <p className="text-xs text-muted-foreground">{item.notes}</p>}
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className={`font-bold text-sm ${item.totalPrice >= 0 ? "text-primary" : "text-green-600"}`}>{formatVND(item.totalPrice)}</span>
                                  <button onClick={() => deleteItem.mutate(item.id)} className="p-1 text-muted-foreground hover:text-destructive rounded-lg transition-colors">
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="rounded-xl border p-3 bg-muted/20 text-sm">
                          <div className="flex justify-between font-bold">
                            <span>Tổng hạng mục</span>
                            <span className="text-primary">{formatVND(bookingItems.filter(i => i.isActive).reduce((s, i) => s + i.totalPrice, 0))}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* PAYMENT TAB */}
                    {activeTab === "payment" && (
                      <div className="space-y-4">
                        {/* Add payment button */}
                        {!showPayForm ? (
                          <Button onClick={() => setShowPayForm(true)} className="w-full gap-2">
                            <Plus className="w-4 h-4" /> Ghi nhận thanh toán
                          </Button>
                        ) : (
                          <div className="rounded-xl border bg-muted/20 p-4 space-y-3">
                            <h4 className="font-semibold text-sm">Ghi nhận thanh toán mới</h4>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">Số tiền</label>
                                <Input type="number" placeholder="0" value={payForm.amount} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))} />
                              </div>
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">Loại thanh toán</label>
                                <Select value={payForm.paymentType} onChange={e => setPayForm(f => ({ ...f, paymentType: e.target.value }))}>
                                  {Object.entries(PAYMENT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </Select>
                              </div>
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">Phương thức</label>
                                <Select value={payForm.paymentMethod} onChange={e => setPayForm(f => ({ ...f, paymentMethod: e.target.value }))}>
                                  {Object.entries(PAYMENT_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </Select>
                              </div>
                              <div>
                                <label className="text-xs font-medium text-muted-foreground">Ghi chú</label>
                                <Input placeholder="Ghi chú..." value={payForm.notes} onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))} />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Button onClick={() => addPayment.mutate({ bookingId: detail.id, amount: parseFloat(payForm.amount), paymentMethod: payForm.paymentMethod, paymentType: payForm.paymentType, notes: payForm.notes })} disabled={!payForm.amount || addPayment.isPending}>
                                {addPayment.isPending ? "Đang lưu..." : "Xác nhận thu tiền"}
                              </Button>
                              <Button variant="outline" onClick={() => setShowPayForm(false)}>Hủy</Button>
                            </div>
                          </div>
                        )}

                        {/* Payment history */}
                        <div>
                          <h4 className="font-semibold text-sm mb-2">Lịch sử thanh toán ({detail.payments.length})</h4>
                          {detail.payments.length === 0 ? (
                            <div className="text-center py-6 text-muted-foreground text-sm">Chưa có khoản thanh toán nào</div>
                          ) : (
                            <div className="space-y-2">
                              {detail.payments.map(p => (
                                <div key={p.id} className="flex items-center justify-between p-3 rounded-xl border bg-card">
                                  <div>
                                    <div className="flex items-center gap-2">
                                      <CheckCircle2 className="w-4 h-4 text-green-500" />
                                      <span className="font-bold text-green-700">{formatVND(p.amount)}</span>
                                      <span className="text-xs text-muted-foreground">{PAYMENT_TYPE[p.paymentType] ?? p.paymentType}</span>
                                    </div>
                                    <div className="text-xs text-muted-foreground mt-0.5 ml-6">
                                      {PAYMENT_METHOD[p.paymentMethod] ?? p.paymentMethod} · {new Date(p.paidAt).toLocaleString("vi-VN")}
                                      {p.collectorName ? ` · Người thu: ${p.collectorName}` : ""}
                                      {p.notes && ` · ${p.notes}`}
                                    </div>
                                  </div>
                                  <button onClick={() => { if (confirm("Xóa khoản thanh toán này?")) deletePayment.mutate(p.id); }} className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Debt summary — per-service breakdown */}
                        <div className="rounded-xl border overflow-hidden bg-white dark:bg-card">
                          <div className="px-3 py-2 border-b border-border/40 bg-gray-50 dark:bg-muted/20">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-foreground/70">💰 Thanh toán</p>
                          </div>
                          <div className="divide-y divide-border/30">
                            {detail.items.length > 0 && detail.items.map((item, idx) => {
                              const itemRealName = item.serviceName || item.serviceLabel || item.packageType || item.name || "";
                              const itemTitle = `DỊCH VỤ ${idx + 1}${itemRealName ? `: ${itemRealName}` : ""}`;
                              const itemPrice = item.price ?? item.total ?? 0;
                              const itemSurcharges = ((item as Record<string, unknown>).surcharges as { name?: string; label?: string; amount: number }[] | undefined) || [];
                              const itemDeductions = ((item as Record<string, unknown>).deductions as { label: string; amount: number }[] | undefined) || [];
                              const itemSurTotal = itemSurcharges.reduce((s, sc) => s + (sc.amount || 0), 0);
                              const itemDeductTotal = itemDeductions.reduce((s, d) => s + (d.amount || 0), 0);
                              const itemFinal = itemPrice + itemSurTotal - itemDeductTotal;
                              return (
                                <ServiceBreakdownCard
                                  key={idx}
                                  title={itemTitle}
                                  description={item.notes}
                                  basePrice={itemPrice}
                                  surcharges={itemSurcharges}
                                  deductions={itemDeductions}
                                  finalAmount={itemFinal}
                                  formatVND={formatVND}
                                />
                              );
                            })}
                            {detail.surcharges.length > 0 && (
                              <div className="px-3 py-2.5 space-y-1">
                                <div className="text-xs text-amber-700 dark:text-amber-400 font-medium">Phụ thu đơn hàng:</div>
                                {detail.surcharges.map((sc, i) => (
                                  <div key={i} className="flex justify-between text-[11px] pl-3">
                                    <span className="text-muted-foreground">+ {sc.name}</span>
                                    <span className="text-muted-foreground">{formatVND(sc.amount)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="px-3 py-2.5 space-y-1.5 bg-gray-50/60 dark:bg-muted/10">
                              <div className="flex justify-between text-sm">
                                <span className="font-semibold text-foreground">Tổng tiền</span>
                                <span className="font-bold text-base">{formatVND(detail.totalAmount)}</span>
                              </div>
                              {detail.discountAmount > 0 && (
                                <div className="flex justify-between text-sm">
                                  <span className="text-muted-foreground">Giảm giá chung</span>
                                  <span className="font-semibold text-amber-600">-{formatVND(detail.discountAmount)}</span>
                                </div>
                              )}
                              {detail.discountAmount > 0 && (
                                <>
                                  <div className="border-t border-dashed border-border/40" />
                                  <div className="flex justify-between text-sm">
                                    <span className="font-semibold text-foreground">Tổng sau giảm</span>
                                    <span className="font-bold">{formatVND(Math.max(0, detail.totalAmount - detail.discountAmount))}</span>
                                  </div>
                                </>
                              )}
                              <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Đã cọc / Đã thu</span>
                                <span className="font-semibold text-emerald-600">{formatVND(detail.paidAmount)}</span>
                              </div>
                              <div className="flex justify-between text-sm border-t border-border/40 pt-1.5">
                                <span className="font-semibold text-foreground">Còn lại</span>
                                <span className={`font-bold text-base ${effectiveRemaining > 0 ? "text-red-600" : "text-emerald-600"}`}>{formatVND(effectiveRemaining)}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* EXPENSE TAB */}
                    {activeTab === "expense" && (
                      <div className="space-y-3">
                        <div className="flex justify-between items-center">
                          <h4 className="font-semibold text-sm">Chi phí của show này</h4>
                          <span className="text-sm font-bold text-red-600">{formatVND(detail.totalExpenses)}</span>
                        </div>
                        {detail.expenses.length === 0 ? (
                          <div className="text-center py-6 text-muted-foreground text-sm">Chưa có khoản chi phí nào</div>
                        ) : (
                          <div className="space-y-2">
                            {detail.expenses.map(e => (
                              <div key={e.id} className="flex items-center justify-between p-3 rounded-xl border bg-card">
                                <div>
                                  <p className="font-medium text-sm">{e.description}</p>
                                  <p className="text-xs text-muted-foreground">{e.category} · {formatDate(e.expenseDate)}</p>
                                </div>
                                <span className="font-bold text-red-600">{formatVND(e.amount)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="rounded-xl border p-3 bg-muted/20 text-sm">
                          <div className="flex justify-between mb-1"><span className="text-muted-foreground">Doanh thu show</span><span className="font-semibold">{formatVND(detail.totalAmount)}</span></div>
                          <div className="flex justify-between mb-1"><span className="text-muted-foreground">Chi phí show</span><span className="text-red-600 font-semibold">-{formatVND(detail.totalExpenses)}</span></div>
                          <div className="flex justify-between border-t pt-1"><span className="font-bold">Lợi nhuận gộp</span><span className={`font-bold ${detail.grossProfit >= 0 ? "text-green-600" : "text-red-600"}`}>{formatVND(detail.grossProfit)}</span></div>
                        </div>
                      </div>
                    )}

                    {/* TASK TAB */}
                    {activeTab === "task" && (
                      <div className="space-y-2">
                        {detail.tasks.length === 0 ? (
                          <div className="text-center py-6 text-muted-foreground text-sm">Chưa có công việc nào</div>
                        ) : (
                          detail.tasks.map(t => {
                            const prio = t.priority === "high" ? "bg-red-100 text-red-700" : t.priority === "medium" ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-700";
                            const stat = t.status === "done" ? "text-green-600" : t.status === "in_progress" ? "text-blue-600" : "text-muted-foreground";
                            return (
                              <div key={t.id} className="flex items-center gap-3 p-3 rounded-xl border bg-card">
                                <div className="flex-1 min-w-0">
                                  <p className="font-medium text-sm">{t.title}</p>
                                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
                                    {t.assigneeName && <span className="flex items-center gap-1"><Users className="w-3 h-3" />{t.assigneeName}</span>}
                                    {t.dueDate && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDate(t.dueDate)}</span>}
                                  </div>
                                </div>
                                <div className="flex flex-col items-end gap-1">
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${prio}`}>{t.priority === "high" ? "Cao" : t.priority === "medium" ? "TB" : "Thấp"}</span>
                                  <span className={`text-[10px] font-medium ${stat}`}>{t.status === "done" ? "✓ Xong" : t.status === "in_progress" ? "⬤ Đang làm" : "○ Chưa làm"}</span>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Create Booking Modal */}
      <Dialog open={showCreateForm} onOpenChange={setShowCreateForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Tạo đơn hàng mới</DialogTitle>
          </DialogHeader>
          <CreateBookingForm
            customers={customers}
            onSuccess={() => { setShowCreateForm(false); qc.invalidateQueries({ queryKey: ["bookings"] }); }}
            onCancel={() => setShowCreateForm(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Reschedule Dialog */}
      <Dialog open={showReschedule} onOpenChange={setShowReschedule}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-primary" /> Đổi lịch chụp
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div>
              <label className="text-sm font-medium">Ngày mới *</label>
              <DateInput value={rescheduleForm.newDate} onChange={v => setRescheduleForm(f => ({ ...f, newDate: v }))} className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Giờ mới</label>
              <Input type="time" value={rescheduleForm.newTime} onChange={e => setRescheduleForm(f => ({ ...f, newTime: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Lý do đổi lịch</label>
              <Textarea rows={2} placeholder="Nhập lý do..." value={rescheduleForm.reason} onChange={e => setRescheduleForm(f => ({ ...f, reason: e.target.value }))} className="mt-1" />
            </div>
            <div className="flex gap-2 pt-1">
              <Button onClick={() => reschedule.mutate(rescheduleForm)} disabled={!rescheduleForm.newDate || reschedule.isPending} className="flex-1">
                {reschedule.isPending ? "Đang lưu..." : "Xác nhận đổi lịch"}
              </Button>
              <Button variant="outline" onClick={() => setShowReschedule(false)}>Hủy</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Booking Modal */}
      {detail && (
        <Dialog open={showEditBooking} onOpenChange={setShowEditBooking}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Sửa đơn hàng — {detail.orderCode}</DialogTitle>
            </DialogHeader>
            <EditBookingModal
              booking={detail}
              onSuccess={() => {
                setShowEditBooking(false);
                qc.invalidateQueries({ queryKey: ["booking", selectedId] });
                qc.invalidateQueries({ queryKey: ["bookings"] });
              }}
              onCancel={() => setShowEditBooking(false)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Lightbox — ảnh concept */}
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

function CustomerSearchBox({
  customers,
  onSelect,
  onCreateNew,
}: {
  customers: { id: number; name: string; phone: string | null; customCode?: string }[];
  onSelect: (c: { id: number; name: string; phone: string | null; customCode?: string }) => void;
  onCreateNew: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<{ id: number; name: string; phone: string | null; customCode?: string } | null>(null);

  const filtered = (() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const phoneExact = customers.filter(c => (c.phone ?? "").includes(query));
    const nameMatch  = customers.filter(c => !(c.phone ?? "").includes(query) && c.name.toLowerCase().includes(q));
    return [...phoneExact, ...nameMatch].slice(0, 10);
  })();

  const handleSelect = (c: typeof customers[0]) => {
    setSelected(c);
    setQuery(c.name);
    setOpen(false);
    onSelect(c);
  };

  useEffect(() => {
    const digits = query.replace(/\D/g, "");
    if (digits.length >= 10 && !selected) {
      const exactMatch = customers.find(c => (c.phone ?? "").replace(/\D/g, "") === digits);
      if (exactMatch) {
        handleSelect(exactMatch);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, customers]);

  const handleClear = () => {
    setSelected(null);
    setQuery("");
    setOpen(false);
    onSelect({ id: 0, name: "", phone: "" });
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          className="w-full pl-8 pr-8 py-2 border border-border rounded-lg text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
          placeholder="Tìm theo tên hoặc số điện thoại..."
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); setSelected(null); }}
          onFocus={() => { if (query) setOpen(true); }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          autoComplete="off"
        />
        {query && (
          <button onClick={handleClear} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {selected && (
        <div className="mt-1 flex items-center gap-2 text-xs text-primary bg-primary/5 border border-primary/20 rounded-lg px-3 py-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="font-semibold">{selected.name}</span>
          <span className="text-muted-foreground">—</span>
          {selected.phone && <span>{selected.phone}</span>}
          {selected.customCode && <span className="text-muted-foreground">— {selected.customCode}</span>}
        </div>
      )}

      {open && query.trim() && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-background border border-border rounded-xl shadow-lg overflow-hidden max-h-56 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-3">
              <p className="text-sm text-muted-foreground text-center mb-2">Không tìm thấy khách hàng "{query}"</p>
              <button
                onClick={onCreateNew}
                className="w-full flex items-center justify-center gap-2 text-xs text-primary bg-primary/5 hover:bg-primary/10 border border-primary/20 rounded-lg py-2 font-medium transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Tạo khách hàng mới
              </button>
            </div>
          ) : (
            filtered.map(c => (
              <button
                key={c.id}
                onMouseDown={() => handleSelect(c)}
                className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-muted text-left transition-colors border-b border-border/40 last:border-0"
              >
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold flex-shrink-0">
                  {c.name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{c.name}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Phone className="w-3 h-3" /> {c.phone ?? "—"}
                    {c.customCode && <span className="ml-1 text-primary/60 font-medium">• {c.customCode}</span>}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

type SaleStaff = { id: number; name: string; roles?: string[]; role?: string };

function useSaleStaff() {
  return useQuery<SaleStaff[]>({
    queryKey: ["staff-sale-list"],
    queryFn: async () => {
      const all = (await fetchJson("/api/staff")) as SaleStaff[];
      return (all || []).filter((s: SaleStaff) => {
        const roles = Array.isArray(s.roles) ? s.roles : [];
        return roles.includes("sale") || s.role === "sale";
      });
    },
  });
}

function SaleStaffDropdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: saleStaff = [], isLoading } = useSaleStaff();
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground">Sale (Kinh doanh)</label>
      <Select value={value} onChange={e => onChange(e.target.value)} disabled={isLoading}>
        <option value="">— Chưa chọn —</option>
        {saleStaff.map(s => (
          <option key={s.id} value={String(s.id)}>{s.name}</option>
        ))}
      </Select>
      {!isLoading && saleStaff.length === 0 && (
        <p className="text-[10px] text-muted-foreground mt-1">
          Chưa có nhân viên nào có vai trò Kinh doanh. Vào trang Nhân sự để gán.
        </p>
      )}
    </div>
  );
}

function CreateBookingForm({ customers, onSuccess, onCancel }: {
  customers: { id: number; name: string; phone: string | null; customCode?: string; customerRank?: string; totalDebt?: number }[];
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    customerId: "", shootDate: "", shootTime: "08:00", serviceCategory: "wedding",
    packageType: "", location: "", depositAmount: "", discountAmount: "0", notes: "",
  });
  // Mặc định Sale chính = người đang đăng nhập (nếu họ có vai trò Kinh doanh).
  // Vẫn cho phép đổi qua dropdown.
  const { viewer } = useStaffAuth();
  const defaultSaleId =
    viewer && Array.isArray(viewer.roles) && viewer.roles.includes("sale")
      ? String(viewer.id)
      : "";
  const [saleStaffId, setSaleStaffId] = useState<string>(defaultSaleId);
  const [selectedService, setSelectedService] = useState<ServiceOption | null>(null);
  const [surcharges, setSurcharges] = useState<SurchargeItem[]>([]);
  const [deductions, setDeductions] = useState<DeductionItem[]>([]);
  const [manualTotal, setManualTotal] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [showNewCustomer, setShowNewCustomer] = useState(false);

  // Auto-compute total from service price + surcharges − deductions
  const surchargesTotal = surcharges.reduce((s, i) => s + (i.amount || 0), 0);
  const deductionsTotal = deductions.reduce((s, d) => s + (d.amount || 0), 0);
  const autoTotal = Math.max(0, (selectedService?.price ?? 0) + surchargesTotal - deductionsTotal);
  const displayTotal = manualTotal !== "" ? parseFloat(manualTotal) || 0 : autoTotal;

  // When service changes, clear manual total so auto takes over
  useEffect(() => { setManualTotal(""); }, [selectedService?.key]);

  const handleSubmit = async () => {
    const packageName = selectedService?.name || form.packageType;
    if (!form.customerId || !form.shootDate || !packageName) return alert("Vui lòng chọn khách hàng, ngày chụp và gói dịch vụ");
    if (displayTotal <= 0) return alert("Tổng tiền phải lớn hơn 0");
    setLoading(true);
    try {
      const cleanedSurcharges = surcharges
        .filter(s => s.name.trim() && s.amount > 0)
        .map(({ name, amount }) => ({ name, amount }));
      const cleanedDeductions = deductions
        .filter(d => d.label.trim() && d.amount > 0)
        .map(({ label, amount }) => ({ label, amount }));
      await fetch(`${BASE}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          packageType: packageName,
          customerId: parseInt(form.customerId),
          totalAmount: Math.max(0, displayTotal),
          depositAmount: parseFloat(form.depositAmount || "0"),
          discountAmount: parseFloat(form.discountAmount || "0"),
          surcharges: cleanedSurcharges,
          deductions: cleanedDeductions,
          includedRetouchedPhotosSnapshot: selectedService?.includedRetouchedPhotos ?? 0,
          servicePackageId: selectedService?.key.startsWith("pkg-") ? selectedService.id : undefined,
          assignedStaff: saleStaffId ? { sale: parseInt(saleStaffId) } : {},
        }),
      });
      onSuccess();
    } catch { alert("Lỗi tạo đơn hàng"); } finally { setLoading(false); }
  };

  return (
    <div className="space-y-3.5 max-h-[75vh] overflow-y-auto pr-1">
      {/* Khách hàng */}
      <div>
        <label className="text-xs font-medium text-muted-foreground">Khách hàng *</label>
        <CustomerSearchBox
          customers={customers}
          onSelect={c => setForm(f => ({ ...f, customerId: c.id ? String(c.id) : "" }))}
          onCreateNew={() => setShowNewCustomer(true)}
        />
        {(() => {
          const sel = form.customerId ? customers.find(c => c.id === parseInt(form.customerId)) : null;
          if (!sel) return null;
          const rank = sel.customerRank;
          if (rank === "super_vip" || rank === "vip") {
            return (
              <div className="mt-1.5 flex items-center gap-2 p-2.5 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-800">
                <Crown className="w-4 h-4 flex-shrink-0 text-amber-600" />
                <span>
                  <strong>{rank === "super_vip" ? "Khách Siêu VIP" : "Khách VIP"}</strong> — vui lòng ưu tiên chăm sóc, sắp xếp ekip và lịch chụp tốt nhất.
                </span>
              </div>
            );
          }
          if (rank === "needs_care") {
            return (
              <div className="mt-1.5 flex items-center gap-2 p-2.5 bg-orange-50 border border-orange-300 rounded-lg text-xs text-orange-800">
                <AlertCircle className="w-4 h-4 flex-shrink-0 text-orange-600" />
                <span><strong>Khách cần chăm sóc lại</strong> — kiểm tra lịch sử và lưu ý trước khi chốt đơn.</span>
              </div>
            );
          }
          return null;
        })()}
        {showNewCustomer && (
          <div className="mt-1.5 p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
            💡 Vui lòng vào trang <strong>Khách hàng</strong> để tạo mới, sau đó quay lại tạo đơn.
            <button className="ml-2 underline text-amber-600" onClick={() => setShowNewCustomer(false)}>Đóng</button>
          </div>
        )}
      </div>

      {/* Ngày + Giờ */}
      <div className="grid grid-cols-2 gap-3">
        <div><label className="text-xs font-medium text-muted-foreground">Ngày chụp *</label><DateInput value={form.shootDate} onChange={v => setForm(f => ({ ...f, shootDate: v }))} /></div>
        <div><label className="text-xs font-medium text-muted-foreground">Giờ chụp</label><Input type="time" value={form.shootTime} onChange={e => setForm(f => ({ ...f, shootTime: e.target.value }))} /></div>
      </div>

      {/* Loại dịch vụ */}
      <div>
        <label className="text-xs font-medium text-muted-foreground">Loại dịch vụ *</label>
        <Select value={form.serviceCategory} onChange={e => setForm(f => ({ ...f, serviceCategory: e.target.value }))}>
          {Object.entries(SERVICE_CAT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>

      {/* Gói dịch vụ — ServiceSearchBox */}
      <div>
        <label className="text-xs font-medium text-muted-foreground">Gói dịch vụ *</label>
        <ServiceSearchBox
          value={selectedService}
          onChange={svc => {
            setSelectedService(svc);
            if (svc) setForm(f => ({ ...f, packageType: svc.name }));
            else setForm(f => ({ ...f, packageType: "" }));
          }}
          allowCustom
          onCustom={() => {
            setSelectedService(null);
            setForm(f => ({ ...f, packageType: "" }));
          }}
        />
        {/* Manual package name if no service selected */}
        {!selectedService && (
          <Input
            className="mt-1.5"
            placeholder="Hoặc nhập tên gói tự do..."
            value={form.packageType}
            onChange={e => setForm(f => ({ ...f, packageType: e.target.value }))}
          />
        )}
      </div>

      {/* Phụ thu / phát sinh */}
      <div className="p-3 bg-amber-50/60 border border-amber-200/60 rounded-xl">
        <SurchargeEditor value={surcharges} onChange={setSurcharges} />
      </div>

      {/* Giảm trừ dịch vụ */}
      <div className="p-3 bg-red-50/40 border border-red-200/60 rounded-xl">
        <DeductionEditor deductions={deductions} onChange={setDeductions} />
      </div>

      {/* Địa điểm */}
      <div><label className="text-xs font-medium text-muted-foreground">Địa điểm</label><Input placeholder="Địa điểm chụp..." value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} /></div>

      {/* Tổng tiền tự động */}
      <div className="bg-muted/30 rounded-xl p-3 space-y-2.5 border border-border/50">
        {selectedService && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Giá gói</span>
            <span className="font-medium">{formatVND(selectedService.price)}</span>
          </div>
        )}
        {surchargesTotal > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Phụ thu / phát sinh</span>
            <span className="font-medium text-amber-600">+{formatVND(surchargesTotal)}</span>
          </div>
        )}
        {deductionsTotal > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Giảm trừ dịch vụ</span>
            <span className="font-medium text-red-600">−{formatVND(deductionsTotal)}</span>
          </div>
        )}
        <div className="flex justify-between items-center border-t border-border/50 pt-2">
          <span className="text-sm font-semibold">Tổng tiền *</span>
          <Input
            type="number"
            className="h-8 w-40 text-right text-sm font-bold"
            placeholder={String(autoTotal || "")}
            value={manualTotal !== "" ? manualTotal : autoTotal > 0 ? String(autoTotal) : ""}
            onChange={e => setManualTotal(e.target.value)}
          />
        </div>
        {manualTotal !== "" && autoTotal > 0 && parseFloat(manualTotal) !== autoTotal && (
          <p className="text-[10px] text-amber-600 text-right">
            Tự nhập. Tự động: {formatVND(autoTotal)}
            <button className="ml-1.5 underline" onClick={() => setManualTotal("")}>Khôi phục</button>
          </p>
        )}
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Đặt cọc</span>
          <Input type="number" className="h-8 w-40 text-right text-sm" placeholder="0" value={form.depositAmount} onChange={e => setForm(f => ({ ...f, depositAmount: e.target.value }))} />
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Giảm giá</span>
          <Input type="number" className="h-8 w-40 text-right text-sm" placeholder="0" value={form.discountAmount} onChange={e => setForm(f => ({ ...f, discountAmount: e.target.value }))} />
        </div>
        {displayTotal > 0 && (
          <div className="flex justify-between items-center border-t border-border/50 pt-2">
            <span className="text-sm font-semibold text-destructive">Còn lại</span>
            <span className="text-sm font-bold text-destructive">
              {formatVND(Math.max(0, displayTotal - (parseFloat(form.depositAmount || "0")) - (parseFloat(form.discountAmount || "0"))))}
            </span>
          </div>
        )}
      </div>

      <SaleStaffDropdown value={saleStaffId} onChange={setSaleStaffId} />

      <div><label className="text-xs font-medium text-muted-foreground">Ghi chú</label><Textarea rows={2} placeholder="Ghi chú thêm..." value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>

      <div className="flex gap-2 pt-1">
        <Button onClick={handleSubmit} disabled={loading} className="flex-1">{loading ? "Đang tạo..." : "Tạo đơn hàng"}</Button>
        <Button variant="outline" onClick={onCancel}>Hủy</Button>
      </div>
    </div>
  );
}

// ─── EditBookingModal ─────────────────────────────────────────────────────────
function EditBookingModal({ booking, onSuccess, onCancel }: {
  booking: Booking;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    shootDate: booking.shootDate || "",
    shootTime: booking.shootTime?.slice(0, 5) || "08:00",
    location: booking.location || "",
    packageType: booking.packageType || "",
    totalAmount: String(booking.totalAmount),
    discountAmount: String(booking.discountAmount || 0),
    notes: booking.notes || "",
    internalNotes: booking.internalNotes || "",
  });
  // assignedStaff thực tế là jsonb (object {sale,photo,...} hoặc array/null); type cũ là number[]
  const existingAssignedStaff: Record<string, unknown> =
    booking.assignedStaff && !Array.isArray(booking.assignedStaff) && typeof booking.assignedStaff === "object"
      ? (booking.assignedStaff as unknown as Record<string, unknown>)
      : {};
  const initialSaleId = (() => {
    const v = existingAssignedStaff.sale;
    if (typeof v === "number") return String(v);
    if (typeof v === "string" && /^\d+$/.test(v)) return v;
    return "";
  })();
  const [saleStaffId, setSaleStaffId] = useState<string>(initialSaleId);
  const [surcharges, setSurcharges] = useState<SurchargeItem[]>(
    (booking.surcharges ?? []).map((s, i) => ({ id: String(i), name: s.name, amount: s.amount }))
  );
  const [deductions, setDeductions] = useState<DeductionItem[]>(booking.deductions ?? []);
  const [manualTotalOverride, setManualTotalOverride] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // Calculate base amount: original totalAmount − original surcharges + original deductions
  const originalSurchargesTotal = (booking.surcharges ?? []).reduce((s, i) => s + (i.amount || 0), 0);
  const originalDeductionsTotal = (booking.deductions ?? []).reduce((s, d) => s + (d.amount || 0), 0);
  const baseAmount = booking.totalAmount - originalSurchargesTotal + originalDeductionsTotal;

  // Recalculate total when surcharges or deductions change
  const surchargesTotal = surcharges.reduce((s, i) => s + (i.amount || 0), 0);
  const deductionsTotal = deductions.reduce((s, d) => s + (d.amount || 0), 0);
  const autoTotal = Math.max(0, baseAmount + surchargesTotal - deductionsTotal);
  const displayTotal = manualTotalOverride !== "" ? parseFloat(manualTotalOverride) || 0 : autoTotal;

  const handleSubmit = async () => {
    if (!form.shootDate) return alert("Vui lòng chọn ngày chụp");
    setLoading(true);
    try {
      const cleanedSurcharges = surcharges
        .filter(s => s.name.trim() && s.amount > 0)
        .map(({ name, amount }) => ({ name, amount }));
      const cleanedDeductions = deductions
        .filter(d => d.label.trim() && d.amount > 0)
        .map(({ label, amount }) => ({ label, amount }));
      const totalAmount = Math.max(0, displayTotal);
      // Merge sale lựa chọn vào assignedStaff hiện có (giữ nguyên các vai trò khác)
      const mergedAssignedStaff: Record<string, unknown> = { ...existingAssignedStaff };
      if (saleStaffId) {
        mergedAssignedStaff.sale = parseInt(saleStaffId);
      } else {
        delete mergedAssignedStaff.sale;
      }
      const res = await fetch(`${BASE}/api/bookings/${booking.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          totalAmount,
          discountAmount: parseFloat(form.discountAmount || "0"),
          surcharges: cleanedSurcharges,
          deductions: cleanedDeductions,
          assignedStaff: mergedAssignedStaff,
        }),
      });
      if (!res.ok) {
        const err = res.headers.get("content-type")?.includes("application/json")
          ? (await res.json()).error : "Lỗi cập nhật đơn hàng";
        return alert(err);
      }
      onSuccess();
    } catch { alert("Lỗi cập nhật đơn hàng"); } finally { setLoading(false); }
  };

  return (
    <div className="space-y-3.5 max-h-[75vh] overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Ngày chụp *</label>
          <DateInput value={form.shootDate} onChange={v => setForm(f => ({ ...f, shootDate: v }))} />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Giờ chụp</label>
          <Input type="time" value={form.shootTime} onChange={e => setForm(f => ({ ...f, shootTime: e.target.value }))} />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Gói dịch vụ</label>
        <Input placeholder="Tên gói dịch vụ..." value={form.packageType} onChange={e => setForm(f => ({ ...f, packageType: e.target.value }))} />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Địa điểm</label>
        <Input placeholder="Địa điểm chụp..." value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
      </div>

      <SaleStaffDropdown value={saleStaffId} onChange={setSaleStaffId} />

      {/* Phụ thu */}
      <div className="p-3 bg-amber-50/60 border border-amber-200/60 rounded-xl">
        <SurchargeEditor value={surcharges} onChange={setSurcharges} />
      </div>

      {/* Giảm trừ dịch vụ */}
      <div className="p-3 bg-red-50/40 border border-red-200/60 rounded-xl">
        <DeductionEditor deductions={deductions} onChange={setDeductions} />
      </div>

      {/* Tổng tiền */}
      <div className="bg-muted/30 rounded-xl p-3 space-y-2 border border-border/50">
        {surchargesTotal > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Phụ thu</span>
            <span className="font-medium text-amber-600">+{formatVND(surchargesTotal)}</span>
          </div>
        )}
        {deductionsTotal > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Giảm trừ dịch vụ</span>
            <span className="font-medium text-red-600">−{formatVND(deductionsTotal)}</span>
          </div>
        )}
        <div className="flex justify-between items-center border-t border-border/50 pt-2">
          <span className="text-sm font-semibold">Tổng tiền *</span>
          <Input
            type="number"
            className="h-8 w-40 text-right text-sm font-bold"
            placeholder={String(autoTotal > 0 ? autoTotal : "")}
            value={manualTotalOverride !== "" ? manualTotalOverride : autoTotal > 0 ? String(autoTotal) : ""}
            onChange={e => setManualTotalOverride(e.target.value)}
          />
        </div>
        {manualTotalOverride !== "" && autoTotal > 0 && parseFloat(manualTotalOverride) !== autoTotal && (
          <p className="text-[10px] text-amber-600 text-right">
            Tự nhập. Tự động: {formatVND(autoTotal)}
            <button className="ml-1.5 underline" onClick={() => setManualTotalOverride("")}>Khôi phục</button>
          </p>
        )}
        <div className="flex justify-between items-center">
          <span className="text-sm text-muted-foreground">Giảm giá</span>
          <Input type="number" className="h-8 w-40 text-right text-sm" placeholder="0" value={form.discountAmount} onChange={e => setForm(f => ({ ...f, discountAmount: e.target.value }))} />
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground">Ghi chú khách</label>
        <Textarea rows={2} placeholder="Ghi chú cho khách..." value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">Ghi chú nội bộ</label>
        <Textarea rows={2} placeholder="Ghi chú nội bộ..." value={form.internalNotes} onChange={e => setForm(f => ({ ...f, internalNotes: e.target.value }))} />
      </div>

      <div className="flex gap-2 pt-1">
        <Button onClick={handleSubmit} disabled={loading} className="flex-1">{loading ? "Đang lưu..." : "Lưu thay đổi"}</Button>
        <Button variant="outline" onClick={onCancel}>Hủy</Button>
      </div>
    </div>
  );
}
