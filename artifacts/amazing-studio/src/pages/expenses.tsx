import { useState, useRef, useEffect, useMemo } from "react";
import { paymentFeedback } from "@/lib/feedback";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  TrendingDown, Plus, X, Banknote, CreditCard, ChevronDown,
  Calendar, User, Tag, FileText, Receipt, CheckCircle2,
  AlertCircle, Trash2, Edit2, Camera, Building2, Clock,
} from "lucide-react";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { OpenCalendarButton } from "@/components/OpenCalendarButton";
import { getImageSrc } from "@/lib/imageUtils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const vnd = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(n);

// Phiếu chi datetime helpers ────────────────────────────────────────────────
// Hiển thị "DD/MM/YYYY • HH:mm" theo Asia/Ho_Chi_Minh, fallback sang ngày
// thuần khi phiếu cũ chưa có expenseAt.
const fmtDateTime = (iso?: string | null, fallbackDate?: string | null) => {
  const src = iso || fallbackDate;
  if (!src) return "";
  const d = new Date(src);
  if (isNaN(d.getTime())) return String(src);
  const date = d.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" });
  if (!iso) return date;
  const time = d.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date} • ${time}`;
};
// Lấy "YYYY-MM-DDTHH:mm" theo VN tz cho input datetime / time mặc định.
const nowVnLocalParts = (d: Date = new Date()) => {
  const date = d.toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
  const time = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });
  return { date, time };
};

const DEFAULT_CATEGORIES = [
  "Mua bàn ghế",
  "Thiết bị",
  "Phụ kiện",
  "In ấn",
  "Trang phục",
  "Ăn uống ekip",
  "Vận chuyển / xăng xe",
  "Sửa chữa",
  "Văn phòng phẩm",
  "Chi khác",
];

const CATEGORY_COLORS: Record<string, string> = {
  "Mua bàn ghế": "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
  "Thiết bị": "bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
  "Phụ kiện": "bg-violet-100 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300",
  "In ấn": "bg-sky-100 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300",
  "Trang phục": "bg-pink-100 text-pink-700 dark:bg-pink-950/30 dark:text-pink-300",
  "Ăn uống ekip": "bg-orange-100 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300",
  "Vận chuyển / xăng xe": "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
  "Sửa chữa": "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-300",
  "Văn phòng phẩm": "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  "Chi khác": "bg-muted text-muted-foreground",
};

type Expense = {
  id: number;
  expenseCode: string | null;
  type: string;
  category: string;
  costClass?: string | null;
  amount: number;
  description: string;
  bookingId: number | null;
  paymentMethod: string;
  expenseDate: string;
  expenseAt: string | null;
  receiptUrl: string | null;
  receiptUrls?: string[] | null;
  receiptCount?: number;
  bankName: string | null;
  bankAccount: string | null;
  createdBy: string | null;
  notes: string | null;
  createdAt: string;
  status?: string | null;
  createdByStaffId?: number | null;
  bookingOrderCode?: string | null;
  bookingCustomerName?: string | null;
  bookingServiceLabel?: string | null;
  bookingShootDate?: string | null;
};

const COST_CLASS_OPTIONS = [
  { value: "direct", label: "Trực tiếp", short: "Trực tiếp", desc: "Chi gắn show, trừ vào lợi nhuận của show", color: "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-300" },
  { value: "operating", label: "Vận hành", short: "Vận hành", desc: "Mặt bằng, lương cố định, marketing…", color: "bg-rose-100 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300" },
  { value: "depreciation", label: "Khấu hao", short: "Khấu hao", desc: "Phân bổ giá trị tài sản theo tháng", color: "bg-violet-100 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300" },
  { value: "interest", label: "Lãi vay", short: "Lãi vay", desc: "Tiền lãi khoản vay (KHÔNG gồm trả gốc)", color: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/30 dark:text-fuchsia-300" },
  { value: "loan_principal", label: "Trả gốc khoản vay", short: "Trả gốc vay", desc: "KHÔNG ảnh hưởng lợi nhuận, chỉ là dòng tiền", color: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  { value: "personal", label: "Cá nhân 🔒", short: "Cá nhân 🔒", desc: "Chi tiêu cá nhân/riêng tư — chỉ admin thấy, vẫn tính vào tổng chi & lợi nhuận", color: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
];
const costClassMeta = (v?: string | null) => COST_CLASS_OPTIONS.find(o => o.value === v);
// "Cá nhân" là loại chi phí RIÊNG TƯ: chỉ admin thấy option/filter/dòng. Đây chỉ là lớp
// ẩn UI — quyền THẬT do backend enforce (api-server: lib/expense-permissions + routes/expenses).
const ADMIN_ONLY_COST_CLASSES = new Set(["personal"]);
const visibleCostClassOptions = (isAdmin: boolean) =>
  COST_CLASS_OPTIONS.filter(o => isAdmin || !ADMIN_ONLY_COST_CLASSES.has(o.value));

type Stats = {
  today: number; todayCount: number;
  week: number; weekCount: number;
  month: number; monthCount: number;
  total: number; totalCount: number;
};

type MonthlySummary = {
  month: number; year: number;
  total: number; count: number;
  costClass: string | null;
  byCostClass: { costClass: string; amount: number; count: number }[];
  byCategory: { category: string; amount: number; count: number }[];
  topExpenses: { id: number; description: string; category: string; amount: number; expenseDate: string; costClass: string }[];
};

const EMPTY_FORM = {
  category: "Chi khác",
  costClass: "operating",
  amount: "",
  description: "",
  paymentMethod: "cash",
  expenseDate: nowVnLocalParts().date,
  expenseTime: nowVnLocalParts().time,
  expenseAtTouched: false,
  bankName: "",
  bankAccount: "",
  createdBy: "",
  notes: "",
  receiptUrl: "",
  receiptUrls: [] as string[],
  bookingId: null as number | null,
};

type LinkedBooking = { id: number; orderCode: string | null; customerName: string | null; customerPhone: string | null };

export default function ExpensesPage() {
  const qc = useQueryClient();
  const { effectiveIsAdmin, viewer } = useStaffAuth();

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [dateRange, setDateRange] = useState("");
  const [filterCostClass, setFilterCostClass] = useState("");
  // Tổng kết chi tiêu theo tháng — mặc định tháng hiện tại (YYYY-MM theo VN tz).
  const [summaryMonth, setSummaryMonth] = useState(() => nowVnLocalParts().date.slice(0, 7));
  const [customCategory, setCustomCategory] = useState("");
  const [showCustomCat, setShowCustomCat] = useState(false);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  const [viewDetail, setViewDetail] = useState<Expense | null>(null);
  const [viewMine, setViewMine] = useState(false);
  const [payDialog, setPayDialog] = useState<number | null>(null);
  const [paidFromValue, setPaidFromValue] = useState<string>("company");
  const receiptInputRef = useRef<HTMLInputElement>(null);
  const token = localStorage.getItem("amazingStudioToken_v2");
  const authHeaders = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };

  const { data: expenses = [], isLoading } = useQuery<Expense[]>({
    queryKey: ["expenses", dateRange, viewMine],
    queryFn: () => {
      const p = new URLSearchParams();
      if (dateRange) p.set("dateRange", dateRange);
      if (viewMine) p.set("mine", "1");
      return fetch(`${BASE}/api/expenses?${p}`, { headers: authHeaders }).then(r => r.json());
    },
    select: (rows: Expense[]) => {
      // Lớp ẩn phòng thủ ở FE: nhân viên không thấy dòng Cá nhân (backend đã loại sẵn).
      const base = effectiveIsAdmin ? rows : rows.filter(e => e.costClass !== "personal");
      return filterCostClass
        ? base.filter(e => (e.costClass || (e.bookingId ? "direct" : "operating")) === filterCostClass)
        : base;
    },
    refetchInterval: 30000,
  });

  const bookingIdsForLookup = useMemo(
    () => [
      ...new Set(
        expenses
          .map((e) => (e.bookingId != null ? Number(e.bookingId) : null))
          .filter((id): id is number => id != null && !Number.isNaN(id)),
      ),
    ],
    [expenses],
  );

  type BookingLookup = {
    orderCode: string | null;
    customerName: string | null;
    serviceLabel: string | null;
    shootDate: string | null;
  };

  const { data: bookingLookup = {} } = useQuery<Record<number, BookingLookup>>({
    queryKey: ["expense-booking-lookup", bookingIdsForLookup.join(",")],
    queryFn: async () => {
      const map: Record<number, BookingLookup> = {};
      await Promise.all(
        bookingIdsForLookup.map(async (id) => {
          try {
            const r = await fetch(`${BASE}/api/bookings/${id}`, { headers: authHeaders });
            if (!r.ok) return;
            const b = await r.json();
            map[id] = {
              orderCode: b.orderCode ?? null,
              customerName: b.customerName ?? null,
              serviceLabel: b.serviceLabel ?? b.packageType ?? null,
              shootDate: b.shootDate ?? null,
            };
          } catch {
            /* ignore */
          }
        }),
      );
      return map;
    },
    enabled: bookingIdsForLookup.length > 0,
    staleTime: 60_000,
  });

  const resolveBookingInfo = (e: Expense) => {
    const bid = e.bookingId != null ? Number(e.bookingId) : null;
    if (bid == null || Number.isNaN(bid)) return null;
    const fromApi = {
      orderCode: e.bookingOrderCode ?? null,
      customerName: e.bookingCustomerName ?? null,
      serviceLabel: e.bookingServiceLabel ?? null,
      shootDate: e.bookingShootDate ?? null,
    };
    const fromLookup = bookingLookup[bid];
    return {
      orderCode: fromApi.orderCode || fromLookup?.orderCode || null,
      customerName: fromApi.customerName || fromLookup?.customerName || null,
      serviceLabel: fromApi.serviceLabel || fromLookup?.serviceLabel || null,
      shootDate: fromApi.shootDate || fromLookup?.shootDate || null,
    };
  };

  const { data: stats } = useQuery<Stats>({
    queryKey: ["expense-stats"],
    queryFn: () => fetch(`${BASE}/api/expenses/stats`, { headers: authHeaders }).then(r => r.json()),
    refetchInterval: 30000,
  });

  // Tổng kết theo tháng — aggregate TOÀN BỘ phiếu trong tháng (không phải data page).
  // Đổi theo tháng đang chọn + bộ lọc "loại CP" hiện tại (filterCostClass).
  const [sumYear, sumMonth] = summaryMonth.split("-").map(Number);
  const { data: monthly } = useQuery<MonthlySummary>({
    queryKey: ["expense-monthly-summary", summaryMonth, filterCostClass],
    queryFn: () => {
      const p = new URLSearchParams({ month: String(sumMonth), year: String(sumYear) });
      if (filterCostClass) p.set("costClass", filterCostClass);
      return fetch(`${BASE}/api/expenses/monthly-summary?${p}`, { headers: authHeaders }).then(r => r.json());
    },
    enabled: !!sumYear && !!sumMonth,
    refetchInterval: 30000,
  });

  const createExpense = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      fetch(`${BASE}/api/expenses`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(data),
      }).then(r => r.json()),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["expense-stats"] });
      const bid = variables.bookingId as number | null | undefined;
      if (bid) qc.invalidateQueries({ queryKey: ["booking-full", bid] });
      paymentFeedback("out");
      resetForm();
    },
  });

  const updateExpense = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      fetch(`${BASE}/api/expenses/${id}`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify(data),
      }).then(r => r.json()),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["expense-stats"] });
      const bid = variables.data?.bookingId as number | null | undefined;
      if (bid) qc.invalidateQueries({ queryKey: ["booking-full", bid] });
      resetForm();
    },
  });

  const deleteExpense = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/expenses/${id}`, { method: "DELETE", headers: authHeaders }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["expense-stats"] });
      setViewDetail(null);
    },
  });

  const approveExpense = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/expenses/${id}/approve`, { method: "PATCH", headers: authHeaders }).then(r => r.json()),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      setViewDetail(prev => prev ? { ...prev, status: data.status } : null);
    },
  });

  const rejectExpense = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/expenses/${id}/reject`, { method: "PATCH", headers: authHeaders }).then(r => r.json()),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      setViewDetail(prev => prev ? { ...prev, status: data.status } : null);
    },
  });

  const payExpense = useMutation({
    mutationFn: ({ id, paidFrom }: { id: number; paidFrom: string }) =>
      fetch(`${BASE}/api/expenses/${id}/pay`, {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ paidFrom }),
      }).then(r => r.json()),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["expense-stats"] });
      setViewDetail(prev => prev ? { ...prev, status: data.status } : null);
      setPayDialog(null);
      paymentFeedback("out");
    },
  });

  function resetForm() {
    setForm({ ...EMPTY_FORM, createdBy: viewer?.name ?? "" });
    setEditingId(null);
    setShowForm(false);
    setShowCustomCat(false);
    setCustomCategory("");
  }

  function openCreate(prefillBookingId?: number | null) {
    // Phiếu chi datetime: mỗi lần mở form tạo mới luôn refresh về thời điểm hiện tại,
    // KHÔNG suy theo bookingId/ngày chụp.
    const { date, time } = nowVnLocalParts();
    setForm({
      ...EMPTY_FORM,
      expenseDate: date,
      expenseTime: time,
      expenseAtTouched: false,
      createdBy: viewer?.name ?? "",
      bookingId: prefillBookingId ?? null,
      costClass: prefillBookingId ? "direct" : "operating",
    });
    setEditingId(null);
    setShowForm(true);
  }

  function openEdit(e: Expense) {
    const receiptUrls = e.receiptUrls?.length ? e.receiptUrls : (e.receiptUrl ? [e.receiptUrl] : []);
    // Phiếu chi datetime: nạp lại đúng datetime đã lưu. Nếu phiếu cũ chưa có
    // expenseAt thì hiển thị theo expenseDate + 00:00.
    const src = e.expenseAt ? new Date(e.expenseAt) : new Date(`${e.expenseDate}T00:00:00`);
    const { date, time } = nowVnLocalParts(src);
    setForm({
      category: e.category,
      costClass: e.costClass || (e.bookingId ? "direct" : "operating"),
      amount: String(e.amount),
      description: e.description,
      paymentMethod: e.paymentMethod,
      expenseDate: date,
      expenseTime: time,
      expenseAtTouched: false,
      bankName: e.bankName ?? "",
      bankAccount: e.bankAccount ?? "",
      createdBy: e.createdBy ?? "",
      notes: e.notes ?? "",
      receiptUrl: receiptUrls[0] ?? "",
      receiptUrls,
      bookingId: e.bookingId ?? null,
    });
    setEditingId(e.id);
    setShowForm(true);
    setViewDetail(null);
  }

  function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    const cat = showCustomCat && customCategory.trim() ? customCategory.trim() : form.category;
    // Phiếu chi datetime: build expenseAt từ ngày + giờ (VN tz). Khi tạo MỚI
    // luôn gửi expenseAt = thời điểm hiện tại (nếu user chưa đổi gì) hoặc
    // datetime user chọn. Khi SỬA chỉ gửi expenseAt khi user thật sự chỉnh
    // ngày/giờ — nếu không gửi, server giữ nguyên giá trị cũ.
    const time = form.expenseTime || "00:00";
    const expenseAtIso = new Date(`${form.expenseDate}T${time}:00`).toISOString();
    const sendExpenseAt = !editingId || form.expenseAtTouched;
    const { expenseTime: _t, expenseAtTouched: _tt, ...rest } = form;
    const payload: Record<string, unknown> = {
      ...rest,
      category: cat,
      costClass: form.costClass || (form.bookingId ? "direct" : "operating"),
      amount: parseFloat(form.amount) || 0,
      bankName: form.paymentMethod === "bank" ? form.bankName : null,
      bankAccount: form.paymentMethod === "bank" ? form.bankAccount : null,
      bookingId: form.bookingId ?? null,
    };
    if (sendExpenseAt) payload.expenseAt = expenseAtIso;
    else delete payload.expenseDate;
    if (editingId) {
      updateExpense.mutate({ id: editingId, data: payload });
    } else {
      createExpense.mutate(payload);
    }
  }

  // ── Auto-open create form when arriving from another module via ?bookingId=&new=1 ──
  const [location, setLocation] = useLocation();
  const [autoOpenedFor, setAutoOpenedFor] = useState<string | null>(null);
  useEffect(() => {
    const qs = location.includes("?") ? location.slice(location.indexOf("?")) : window.location.search;
    const params = new URLSearchParams(qs);
    const newFlag = params.get("new");
    const bid = params.get("bookingId");
    if (newFlag === "1" && bid && autoOpenedFor !== `${bid}:${newFlag}`) {
      const parsed = parseInt(bid, 10);
      if (!Number.isNaN(parsed)) {
        openCreate(parsed);
        setAutoOpenedFor(`${bid}:${newFlag}`);
        // Clean URL to avoid re-opening on subsequent renders
        const cleanPath = location.includes("?") ? location.slice(0, location.indexOf("?")) : location;
        setLocation(cleanPath, { replace: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // ── Deep-link từ "Bằng chứng số liệu" (màn Doanh thu): /expenses?expenseId=N →
  //    tự mở modal chi tiết phiếu chi đó (fetch thẳng /api/expenses/:id, không phụ
  //    thuộc filter tháng của trang). Cùng pattern với /payments?bookingId=N. ──
  const expenseDeepLinkHandled = useRef(false);
  useEffect(() => {
    if (expenseDeepLinkHandled.current) return;
    const qs = location.includes("?") ? location.slice(location.indexOf("?")) : window.location.search;
    const params = new URLSearchParams(qs);
    const eid = params.get("expenseId");
    if (!eid) return;
    expenseDeepLinkHandled.current = true;
    // Xoá query param khỏi URL ngay để khỏi mở lại lúc back / refresh
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("expenseId");
      window.history.replaceState({}, "", url.toString());
    } catch { /* ignore */ }
    const id = Number(eid);
    if (!Number.isFinite(id) || id <= 0) return;
    fetch(`${BASE}/api/expenses/${id}`, { headers: authHeaders })
      .then(r => (r.ok ? r.json() : null))
      .then((raw: unknown) => {
        if (raw && typeof raw === "object" && "id" in (raw as object)) {
          setViewDetail(raw as Expense);
        }
      })
      .catch(() => { /* phiếu không tồn tại / mất mạng — bỏ qua, trang vẫn dùng bình thường */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // ── Look up linked booking info to display in form / list ──
  const { data: linkedBooking } = useQuery<LinkedBooking | null>({
    queryKey: ["expense-linked-booking", form.bookingId],
    queryFn: async () => {
      if (!form.bookingId) return null;
      const r = await fetch(`${BASE}/api/bookings/${form.bookingId}`, { headers: authHeaders });
      if (!r.ok) return null;
      const b = await r.json();
      return { id: b.id, orderCode: b.orderCode ?? null, customerName: b.customerName ?? null, customerPhone: b.customerPhone ?? null };
    },
    enabled: !!form.bookingId && showForm,
    staleTime: 60_000,
  });

  async function uploadReceipt(file: File) {
    setUploadingReceipt(true);
    try {
      const res = await fetch(`${BASE}/api/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Upload URL request failed", res.status, err);
        return;
      }
      const { uploadURL, objectPath } = await res.json();
      const putRes = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) {
        console.error("PUT to storage failed", putRes.status);
        return;
      }
      setForm(f => ({
        ...f,
        receiptUrl: f.receiptUrl || objectPath,
        receiptUrls: Array.from(new Set([...(f.receiptUrls || []), objectPath])),
      }));
    } catch (err) {
      console.error("Upload failed", err);
    } finally {
      setUploadingReceipt(false);
    }
  }

  const allCategories = Array.from(new Set([...DEFAULT_CATEGORIES, ...expenses.map(e => e.category)]));
  const catColor = (cat: string) => CATEGORY_COLORS[cat] ?? "bg-muted text-muted-foreground";
  const receiptList = form.receiptUrls ?? [];

  const DATE_RANGES = [
    { key: "today", label: "Hôm nay" },
    { key: "7days", label: "7 ngày" },
    { key: "month", label: "Tháng này" },
    { key: "", label: "Tất cả" },
  ];

  return (
    <div className="min-h-full bg-background">
      {/* Header */}
      <div className="px-4 sm:px-6 py-4 sm:py-5 border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
              <TrendingDown className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Chi tiền</h1>
              <p className="text-xs text-muted-foreground">Quản lý các khoản chi phí của studio</p>
            </div>
          </div>
          <button onClick={() => openCreate()}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl font-semibold text-sm transition-colors shadow-sm">
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">{effectiveIsAdmin ? "Tạo phiếu chi" : "Đề nghị chi"}</span>
            <span className="sm:hidden">Thêm</span>
          </button>
        </div>

        {/* Stats dashboard */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          {[
            { label: "Hôm nay", amount: stats?.today ?? 0, count: stats?.todayCount ?? 0, color: "text-red-600" },
            { label: "7 ngày", amount: stats?.week ?? 0, count: stats?.weekCount ?? 0, color: "text-orange-600" },
            { label: "Tháng này", amount: stats?.month ?? 0, count: stats?.monthCount ?? 0, color: "text-amber-600" },
            { label: "Tổng cộng", amount: stats?.total ?? 0, count: stats?.totalCount ?? 0, color: "text-muted-foreground" },
          ].map(s => (
            <div key={s.label} className="rounded-xl bg-card border border-border p-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={`text-base sm:text-lg font-bold ${s.color} mt-0.5`}>{vnd(s.amount)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{s.count} phiếu</p>
            </div>
          ))}
        </div>
      </div>

      {/* Filters */}
      <div className="px-4 sm:px-6 py-3 border-b border-border flex flex-wrap gap-2 items-center">
        <div className="flex gap-1">
          {DATE_RANGES.map(r => (
            <button key={r.key} onClick={() => setDateRange(r.key)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${dateRange === r.key ? "bg-red-600 text-white" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
              {r.label}
            </button>
          ))}
        </div>

        <select
          value={filterCostClass}
          onChange={e => setFilterCostClass(e.target.value)}
          className="text-xs border border-border rounded-xl px-3 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-red-300"
          title="Lọc theo loại chi phí (mô hình tài chính)">
          <option value="">Tất cả loại CP</option>
          {visibleCostClassOptions(effectiveIsAdmin).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>

        <button
          onClick={() => setViewMine(m => !m)}
          className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors border ${viewMine ? "bg-red-600 text-white border-red-600" : "bg-background border-border text-muted-foreground hover:text-foreground"}`}>
          {viewMine ? "✓ Của tôi" : "Của tôi"}
        </button>
      </div>

      {/* ── Tổng kết chi tiêu theo tháng ─────────────────────────────────── */}
      <div className="px-4 sm:px-6 pt-4">
        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          {/* Header: tiêu đề + chọn tháng */}
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-xl bg-red-100 dark:bg-red-900/20 flex items-center justify-center flex-shrink-0">
                <TrendingDown className="w-4 h-4 text-red-500" />
              </div>
              <h2 className="font-bold text-sm sm:text-base truncate">Tổng kết chi tiêu theo tháng</h2>
            </div>
            <input
              type="month"
              value={summaryMonth}
              onChange={e => setSummaryMonth(e.target.value)}
              className="text-xs sm:text-sm border border-border rounded-xl px-3 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-red-300"
              title="Chọn tháng để xem tổng kết"
            />
          </div>

          {(() => {
            const monthLabel = `${String(sumMonth).padStart(2, "0")}/${sumYear}`;
            const activeMeta = filterCostClass ? costClassMeta(filterCostClass) : null;
            const total = monthly?.total ?? 0;
            const count = monthly?.count ?? 0;

            // Câu tổng lớn: đổi theo bộ lọc loại CP
            const headline = activeMeta
              ? `${activeMeta.label} tháng ${monthLabel}`
              : `Tổng chi tháng ${monthLabel}`;

            const byCat = monthly?.byCategory ?? [];
            const maxCat = byCat.reduce((m, c) => Math.max(m, c.amount), 0) || 1;

            return (
              <div className="space-y-4">
                {/* Câu tổng */}
                <div className="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/40 px-4 py-3">
                  <p className="text-xs text-muted-foreground">{headline}</p>
                  <p className="text-2xl font-black text-red-600 mt-0.5">{vnd(total)}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{count} phiếu chi</p>
                </div>

                {/* Chế độ "Tất cả loại CP": breakdown theo TỪNG loại CP */}
                {!filterCostClass ? (
                  (monthly?.byCostClass?.length ?? 0) === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-2">Tháng này chưa có phiếu chi nào.</p>
                  ) : (
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Theo loại chi phí</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {monthly!.byCostClass.map(c => {
                          const meta = costClassMeta(c.costClass);
                          return (
                            <button
                              key={c.costClass}
                              type="button"
                              onClick={() => setFilterCostClass(c.costClass)}
                              className="text-left rounded-xl border border-border bg-background hover:border-red-300 transition-colors p-2.5"
                              title={`Bấm để lọc riêng ${meta?.label ?? c.costClass}`}
                            >
                              <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full ${meta?.color ?? "bg-muted text-muted-foreground"}`}>
                                {meta?.short ?? c.costClass}
                              </span>
                              <p className="text-sm font-bold text-foreground mt-1.5">{vnd(c.amount)}</p>
                              <p className="text-[10px] text-muted-foreground">{c.count} phiếu</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )
                ) : (
                  /* Chế độ 1 loại CP: breakdown theo nhóm + top khoản chi */
                  <div className="space-y-4">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Theo nhóm / danh mục</p>
                      {byCat.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-1">Không có phiếu chi loại này trong tháng.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {byCat.map(c => (
                            <div key={c.category} className="space-y-0.5">
                              <div className="flex items-baseline justify-between gap-2 text-sm">
                                <span className="truncate">
                                  <span className={`inline-block text-[10px] font-bold px-2 py-0.5 rounded-full mr-1.5 ${catColor(c.category)}`}>{c.category}</span>
                                  <span className="text-[10px] text-muted-foreground">{c.count} phiếu</span>
                                </span>
                                <span className="font-bold text-foreground flex-shrink-0">{vnd(c.amount)}</span>
                              </div>
                              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                                <div className="h-full rounded-full bg-red-400" style={{ width: `${Math.max(4, (c.amount / maxCat) * 100)}%` }} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {(monthly?.topExpenses?.length ?? 0) > 0 && (
                      <div>
                        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Top khoản chi lớn nhất</p>
                        <div className="space-y-1.5">
                          {monthly!.topExpenses.map((t, i) => (
                            <div key={t.id} className="flex items-center gap-2 text-sm">
                              <span className="w-5 h-5 rounded-full bg-muted text-muted-foreground text-[10px] font-bold flex items-center justify-center flex-shrink-0">{i + 1}</span>
                              <span className="flex-1 min-w-0 truncate">{t.description || t.category || "—"}</span>
                              <span className="font-bold text-red-600 flex-shrink-0">{vnd(t.amount)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Expense list */}
      <div className="p-4 sm:p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            <div className="animate-spin w-5 h-5 border-2 border-red-300 border-t-red-600 rounded-full mr-2" />
            Đang tải...
          </div>
        ) : expenses.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
            <Receipt className="w-12 h-12 mb-3 opacity-20" />
            <p className="font-medium">Chưa có phiếu chi nào</p>
            <p className="text-sm mt-1">Bấm "+ Tạo phiếu chi" để ghi chi phí</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {expenses.map(e => {
              const thumbs = (e.receiptUrls && e.receiptUrls.length ? e.receiptUrls : (e.receiptUrl ? [e.receiptUrl] : [])).slice(0, 3);
              return (
              <div key={e.id}
                className="rounded-2xl border border-border bg-card hover:shadow-sm transition-shadow cursor-pointer"
                onClick={() => setViewDetail(e)}>
                <div className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-xl bg-red-100 dark:bg-red-900/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                      {e.paymentMethod === "bank" ? <CreditCard className="w-4 h-4 text-red-500" /> : <Banknote className="w-4 h-4 text-red-500" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      {(() => {
                        const bk = resolveBookingInfo(e);
                        const shootLabel = bk?.shootDate
                          ? new Date(bk.shootDate + "T00:00:00").toLocaleDateString("vi-VN")
                          : null;
                        return (
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm text-foreground leading-snug">{e.description || "—"}</p>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              <span className="font-medium text-foreground/70">Lý do chi:</span> {e.description}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="font-black text-red-600 text-lg leading-none">-{vnd(e.amount)}</p>
                            <p className="text-[10px] text-muted-foreground mt-1">{fmtDateTime(e.expenseAt, e.expenseDate)}</p>
                          </div>
                        </div>

                        {bk ? (
                          <div className="rounded-xl border border-amber-300/80 bg-amber-50 px-3 py-2.5 dark:bg-amber-950/25 dark:border-amber-800/70 space-y-1">
                            <div className="flex items-center gap-1.5 text-sm font-bold text-foreground">
                              <User className="w-4 h-4 text-amber-700 flex-shrink-0" />
                              <span className="truncate">{bk.customerName || "Khách chưa rõ tên"}</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-900 dark:text-amber-200">
                              <Receipt className="w-3.5 h-3.5 flex-shrink-0" />
                              <span className="truncate">
                                Đơn: {bk.orderCode || `#${e.bookingId}`}
                                {bk.serviceLabel ? ` · ${bk.serviceLabel}` : ""}
                              </span>
                            </div>
                            {shootLabel && (
                              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
                                <span>Ngày show: {shootLabel}</span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="rounded-xl border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground flex items-center gap-2">
                            <Building2 className="w-4 h-4 flex-shrink-0" />
                            <span>Chi vận hành studio — không gắn khách / đơn hàng</span>
                          </div>
                        )}

                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${catColor(e.category)}`}>{e.category}</span>
                          {(() => {
                            const meta = costClassMeta(e.costClass || (e.bookingId ? "direct" : "operating"));
                            return meta ? (
                              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${meta.color}`} title={meta.desc}>{meta.short}</span>
                            ) : null;
                          })()}
                          {e.status && (
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              e.status === "submitted" ? "bg-yellow-100 text-yellow-700" :
                              e.status === "paid" ? "bg-blue-100 text-blue-700" :
                              e.status === "rejected" ? "bg-red-100 text-red-700" :
                              "bg-green-100 text-green-700"
                            }`}>
                              {e.status === "submitted" ? "⏳ Chờ duyệt" : e.status === "paid" ? "✓ Đã thanh toán" : e.status === "rejected" ? "✗ Từ chối" : "✓ Đã duyệt"}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground font-mono">{e.expenseCode}</span>
                          {e.createdBy && (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                              <User className="w-2.5 h-2.5" />{e.createdBy}
                            </span>
                          )}
                        </div>
                      </div>
                        );
                      })()}
                      {e.notes && (
                        <p className="text-xs text-muted-foreground mt-1.5 line-clamp-1">{e.notes}</p>
                      )}
                      {thumbs.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-2">
                          {thumbs.map((url, i) => (
                            <img
                              key={i}
                              src={getImageSrc(url) || url}
                              alt=""
                              className="w-12 h-12 rounded-lg object-cover border border-border"
                              loading="lazy"
                            />
                          ))}
                          {((e.receiptUrls?.length || (e.receiptUrl ? 1 : 0)) > 3) && (
                            <span className="text-[10px] text-muted-foreground font-semibold">
                              +{(e.receiptUrls?.length || 0) - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create/Edit Form modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-background w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0 bg-background">
              <h2 className="font-bold text-base">{editingId ? "Sửa phiếu chi" : "Tạo phiếu chi mới"}</h2>
              <button onClick={resetForm} className="p-1.5 rounded-xl hover:bg-muted">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {/* Linked booking banner */}
              {form.bookingId && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
                  <div className="flex items-center gap-2 min-w-0">
                    <Receipt className="w-4 h-4 text-amber-600 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[11px] text-amber-700 dark:text-amber-400 font-semibold uppercase tracking-wide">Chi cho show</div>
                      <div className="text-sm font-bold truncate">
                        {linkedBooking?.orderCode || `#${form.bookingId}`}
                        {linkedBooking?.customerName && <span className="text-muted-foreground font-normal"> · {linkedBooking.customerName}</span>}
                      </div>
                      <div className="text-[11px] text-muted-foreground">Khoản chi này sẽ trừ vào lợi nhuận của show</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {/* Mở đúng show trên lịch chụp (bổ sung #70: modal tạo/sửa phiếu chi) — gate theo id, calendar tự nhảy ngày */}
                    <OpenCalendarButton bookingId={form.bookingId} className="px-2 py-1" />
                    <button
                      type="button"
                      onClick={() => setForm(f => ({ ...f, bookingId: null, costClass: f.costClass === "direct" ? "operating" : f.costClass }))}
                      className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30 flex-shrink-0"
                      title="Bỏ liên kết với show"
                    >
                      Bỏ
                    </button>
                  </div>
                </div>
              )}

              {/* Amount */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Số tiền chi <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm font-bold">₫</span>
                  <CurrencyInput
                    value={form.amount}
                    onChange={raw => setForm(f => ({ ...f, amount: raw }))}
                    placeholder="0"
                    required
                    className="w-full pl-7 pr-3 py-2.5 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-lg font-bold"
                  />
                </div>
                {/* Quick amounts */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {[50000, 100000, 200000, 500000, 1000000].map(v => (
                    <button type="button" key={v}
                      onClick={() => setForm(f => ({ ...f, amount: String(v) }))}
                      className="px-2.5 py-1 text-xs rounded-lg border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                      {v >= 1000000 ? `${v / 1000000}M` : `${v / 1000}k`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Nội dung chi <span className="text-red-500">*</span>
                </label>
                <input
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Mô tả khoản chi..."
                  required
                  className="w-full px-3 py-2.5 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-sm"
                />
              </div>

              {/* Category */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Nhóm chi phí
                </label>
                {!showCustomCat ? (
                  <div className="flex gap-2">
                    <select
                      value={form.category}
                      onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                      className="flex-1 px-3 py-2.5 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-sm">
                      {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button type="button"
                      onClick={() => setShowCustomCat(true)}
                      className="px-3 py-2 border border-dashed border-border rounded-xl text-xs text-muted-foreground hover:text-foreground hover:border-foreground transition-colors">
                      + Mới
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      value={customCategory}
                      onChange={e => setCustomCategory(e.target.value)}
                      placeholder="Tên nhóm mới..."
                      className="flex-1 px-3 py-2.5 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-sm"
                      autoFocus
                    />
                    <button type="button" onClick={() => { setShowCustomCat(false); setCustomCategory(""); }}
                      className="px-3 py-2 border border-border rounded-xl text-xs text-muted-foreground">Hủy</button>
                  </div>
                )}
              </div>

              {/* Loại chi phí (financial cost class) */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
                  Loại chi phí <span className="text-red-500">*</span>
                </label>
                <select
                  value={form.costClass}
                  onChange={e => setForm(f => ({ ...f, costClass: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-sm">
                  {visibleCostClassOptions(effectiveIsAdmin).map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {costClassMeta(form.costClass)?.desc}
                </p>
              </div>

              {/* Date + Who */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Ngày chi</label>
                  <div className="flex items-center gap-2">
                    <DateInput value={form.expenseDate}
                      onChange={v => setForm(f => ({ ...f, expenseDate: v, expenseAtTouched: true }))}
                      className="flex-1 py-2.5 rounded-xl text-sm" />
                    <input
                      type="time"
                      value={form.expenseTime}
                      onChange={e => setForm(f => ({ ...f, expenseTime: e.target.value, expenseAtTouched: true }))}
                      className="w-[110px] px-2 py-2.5 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Người chi</label>
                  <input value={form.createdBy}
                    onChange={e => setForm(f => ({ ...f, createdBy: e.target.value }))}
                    placeholder="Tên người chi..."
                    className="w-full px-3 py-2.5 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-sm" />
                </div>
              </div>

              {/* Payment method */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Hình thức thanh toán</label>
                <div className="flex gap-2">
                  {[
                    { key: "cash", label: "Tiền mặt", icon: Banknote },
                    { key: "bank", label: "Chuyển khoản", icon: CreditCard },
                  ].map(({ key, label, icon: Icon }) => (
                    <button type="button" key={key}
                      onClick={() => setForm(f => ({ ...f, paymentMethod: key }))}
                      className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-colors ${form.paymentMethod === key ? "bg-red-600 text-white border-red-600" : "border-border text-muted-foreground hover:bg-muted"}`}>
                      <Icon className="w-4 h-4" />{label}
                    </button>
                  ))}
                </div>
                {form.paymentMethod === "bank" && (
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Ngân hàng</label>
                      <input value={form.bankName}
                        onChange={e => setForm(f => ({ ...f, bankName: e.target.value }))}
                        placeholder="VD: Vietcombank"
                        className="w-full px-3 py-2 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-sm" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">Số TK / ghi chú CK</label>
                      <input value={form.bankAccount}
                        onChange={e => setForm(f => ({ ...f, bankAccount: e.target.value }))}
                        placeholder="Số tài khoản..."
                        className="w-full px-3 py-2 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-sm" />
                    </div>
                  </div>
                )}
              </div>

              {/* Notes */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Ghi chú</label>
                <textarea value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Ghi chú thêm..."
                  rows={2}
                  className="w-full px-3 py-2.5 border border-border rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-red-300 text-sm resize-none" />
              </div>

              {/* Receipt upload */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">Ảnh bằng chứng / hóa đơn</label>
                <input type="file" ref={receiptInputRef} accept="image/*" multiple className="hidden"
                  onChange={async e => {
                    const files = Array.from(e.target.files || []);
                    const remaining = Math.max(0, 20 - receiptList.length);
                    const slice = files.slice(0, remaining);
                    for (const f of slice) await uploadReceipt(f);
                    e.target.value = "";
                  }} />
                {receiptList.length > 0 ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      {receiptList.map((url, idx) => (
                        <div key={`${url}-${idx}`} className="relative w-full h-28 rounded-xl overflow-hidden border border-border">
                          <img src={getImageSrc(url) ?? undefined} alt={`receipt-${idx + 1}`} className="w-full h-full object-cover" />
                          <div className="absolute top-2 right-2 flex gap-1">
                            <button type="button" onClick={() => receiptInputRef.current?.click()}
                              className="p-1.5 rounded-lg bg-black/50 text-white hover:bg-black/70">
                              <Camera className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" onClick={() => setForm(f => ({
                              ...f,
                              receiptUrls: (f.receiptUrls || []).filter((_, i) => i !== idx),
                              receiptUrl: (f.receiptUrls || []).filter((_, i) => i !== idx)[0] || "",
                            }))}
                              className="p-1.5 rounded-lg bg-black/50 text-white hover:bg-black/70">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Đã chọn {receiptList.length}/20 ảnh
                    </p>
                    <button type="button"
                      onClick={() => receiptInputRef.current?.click()}
                      disabled={uploadingReceipt || receiptList.length >= 20}
                      className="w-full h-12 rounded-xl border-2 border-dashed border-border hover:border-red-300 transition-colors flex items-center justify-center gap-2 text-muted-foreground hover:text-red-500">
                      {uploadingReceipt ? (
                        <div className="animate-spin w-5 h-5 border-2 border-red-300 border-t-red-600 rounded-full" />
                      ) : (
                        <>
                          <Camera className="w-4 h-4" />
                          <span className="text-xs">Thêm ảnh bằng chứng</span>
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <button type="button"
                    onClick={() => receiptInputRef.current?.click()}
                    disabled={uploadingReceipt}
                    className="w-full h-24 rounded-xl border-2 border-dashed border-border hover:border-red-300 transition-colors flex flex-col items-center justify-center text-muted-foreground hover:text-red-500">
                    {uploadingReceipt ? (
                      <div className="animate-spin w-5 h-5 border-2 border-red-300 border-t-red-600 rounded-full" />
                    ) : (
                      <>
                        <Camera className="w-6 h-6 mb-1" />
                        <span className="text-xs">Chụp / chọn ảnh bằng chứng</span>
                      </>
                    )}
                  </button>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={resetForm}
                  className="flex-1 py-2.5 border border-border rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted transition-colors">
                  Hủy
                </button>
                <button type="submit"
                  disabled={createExpense.isPending || updateExpense.isPending || !form.amount || !form.description}
                  className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-colors">
                  {createExpense.isPending || updateExpense.isPending ? "Đang lưu..." : editingId ? "Cập nhật" : "Lưu phiếu chi"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Pay from dialog */}
      {payDialog !== null && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4">
          <div className="bg-background w-full max-w-sm rounded-2xl shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-base">Xác nhận thanh toán</h3>
              <button onClick={() => setPayDialog(null)} className="p-1.5 rounded-xl hover:bg-muted"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-sm text-muted-foreground">Chọn nguồn tiền thanh toán phiếu chi này:</p>
            <div className="space-y-2">
              {[
                { value: "company", label: "🏢 Quỹ công ty" },
                { value: "owner", label: "👤 Chủ studio (cá nhân)" },
                { value: "mom", label: "👩 Mẹ / người nhà" },
              ].map(opt => (
                <button key={opt.value} type="button"
                  onClick={() => setPaidFromValue(opt.value)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium transition-colors ${paidFromValue === opt.value ? "bg-blue-600 text-white border-blue-600" : "border-border hover:bg-muted"}`}>
                  <span>{opt.label}</span>
                  {paidFromValue === opt.value && <CheckCircle2 className="w-4 h-4 ml-auto" />}
                </button>
              ))}
            </div>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setPayDialog(null)}
                className="flex-1 py-2.5 border border-border rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted transition-colors">
                Hủy
              </button>
              <button
                onClick={() => payExpense.mutate({ id: payDialog, paidFrom: paidFromValue })}
                disabled={payExpense.isPending}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-sm font-semibold transition-colors">
                {payExpense.isPending ? "Đang lưu..." : "Xác nhận"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      {viewDetail && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-background w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div>
                <h2 className="font-bold text-base">Chi tiết phiếu chi</h2>
                <p className="text-xs text-muted-foreground font-mono">{viewDetail.expenseCode}</p>
              </div>
              <button onClick={() => setViewDetail(null)} className="p-1.5 rounded-xl hover:bg-muted">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {/* Amount */}
              {viewDetail.bookingId ? (() => {
                const bk = resolveBookingInfo(viewDetail);
                const shootLabel = bk?.shootDate ? new Date(bk.shootDate + "T00:00:00").toLocaleDateString("vi-VN") : null;
                return (
                <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 mb-2 px-3 py-2.5 space-y-1.5">
                  <div className="text-[11px] text-amber-700 dark:text-amber-400 font-semibold uppercase">Chi cho khách / đơn hàng</div>
                  <div className="flex items-center gap-2 text-base font-bold text-foreground">
                    <User className="w-4 h-4 text-amber-700" />
                    {bk?.customerName || "Khách chưa rõ tên"}
                  </div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-200">
                    <Receipt className="w-4 h-4" />
                    Đơn: {bk?.orderCode || `#${viewDetail.bookingId}`}
                    {bk?.serviceLabel ? ` · ${bk.serviceLabel}` : ""}
                  </div>
                  {shootLabel && (
                    <div className="text-[11px] text-muted-foreground">Ngày show: {shootLabel}</div>
                  )}
                  <div className="text-[11px] text-muted-foreground">
                    <span className="font-medium">Lý do chi:</span> {viewDetail.description}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {/* Mở đúng show trên lịch chụp — bk null (đơn xóa cứng) ⇒ disable "Không còn lịch chụp" */}
                    <OpenCalendarButton bookingId={viewDetail.bookingId} shootDate={bk?.shootDate} requireShootDate />
                    <button
                      type="button"
                      onClick={() => { setViewDetail(null); setLocation(`/bookings?bookingId=${viewDetail.bookingId}`); }}
                      className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 px-2 py-1 rounded-lg hover:bg-amber-100 dark:hover:bg-amber-900/30 flex-shrink-0"
                    >
                      Xem đơn
                    </button>
                  </div>
                </div>
                );
              })() : (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-muted/30 mb-2 text-sm text-muted-foreground">
                  <Building2 className="w-4 h-4" /> Chi vận hành studio (không gắn đơn)
                </div>
              )}

              <div className="text-center py-4">
                <p className="text-3xl font-black text-red-600">-{vnd(viewDetail.amount)}</p>
                <div className="flex flex-wrap items-center justify-center gap-1.5 mt-2">
                  <span className={`inline-block text-xs font-bold px-3 py-1 rounded-full ${catColor(viewDetail.category)}`}>
                    {viewDetail.category}
                  </span>
                  {(() => {
                    const meta = costClassMeta(viewDetail.costClass || (viewDetail.bookingId ? "direct" : "operating"));
                    return meta ? (
                      <span className={`inline-block text-xs font-bold px-3 py-1 rounded-full ${meta.color}`} title={meta.desc}>
                        {meta.label}
                      </span>
                    ) : null;
                  })()}
                </div>
              </div>
              <div className="border-t border-border/40" />
              <div className="space-y-2.5 text-sm">
                <div className="flex gap-3">
                  <FileText className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <span>{viewDetail.description}</span>
                </div>
                <div className="flex gap-3">
                  <Calendar className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <span>{fmtDateTime(viewDetail.expenseAt, viewDetail.expenseDate)}</span>
                </div>
                {viewDetail.createdBy && (
                  <div className="flex gap-3">
                    <User className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span>{viewDetail.createdBy}</span>
                  </div>
                )}
                <div className="flex gap-3">
                  {viewDetail.paymentMethod === "bank" ? <CreditCard className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <Banknote className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                  <span>{viewDetail.paymentMethod === "bank" ? "Chuyển khoản" : "Tiền mặt"}
                    {viewDetail.bankName && ` · ${viewDetail.bankName}`}
                    {viewDetail.bankAccount && ` · ${viewDetail.bankAccount}`}
                  </span>
                </div>
                {viewDetail.notes && (
                  <div className="flex gap-3">
                    <Tag className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-muted-foreground">{viewDetail.notes}</span>
                  </div>
                )}
              </div>
              {(() => {
                const detailUrls = viewDetail.receiptUrls?.length
                  ? viewDetail.receiptUrls
                  : (viewDetail.receiptUrl ? [viewDetail.receiptUrl] : []);
                return detailUrls.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {detailUrls.map((url, idx) => (
                      <div key={`${url}-${idx}`} className="rounded-xl overflow-hidden border border-border">
                        <img src={getImageSrc(url) ?? undefined} alt={`receipt-${idx + 1}`} className="w-full object-cover max-h-48" />
                      </div>
                    ))}
                  </div>
                );
              })()}
              {/* Status badge in detail */}
              {viewDetail.status && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium ${
                  viewDetail.status === "submitted" ? "bg-yellow-50 border border-yellow-200 text-yellow-800" :
                  viewDetail.status === "approved" ? "bg-green-50 border border-green-200 text-green-800" :
                  viewDetail.status === "paid" ? "bg-blue-50 border border-blue-200 text-blue-800" :
                  "bg-red-50 border border-red-200 text-red-800"
                }`}>
                  {viewDetail.status === "submitted" ? "⏳ Đang chờ duyệt" :
                   viewDetail.status === "approved" ? "✓ Đã duyệt" :
                   viewDetail.status === "paid" ? "💰 Đã thanh toán" : "✗ Đã từ chối"}
                </div>
              )}

              {effectiveIsAdmin && viewDetail.status === "submitted" && (
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => approveExpense.mutate(viewDetail.id)}
                    disabled={approveExpense.isPending}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-50">
                    <CheckCircle2 className="w-4 h-4" /> Duyệt
                  </button>
                  <button
                    onClick={() => rejectExpense.mutate(viewDetail.id)}
                    disabled={rejectExpense.isPending}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 border border-red-300 text-red-600 rounded-xl text-sm hover:bg-red-50 transition-colors disabled:opacity-50">
                    <X className="w-4 h-4" /> Từ chối
                  </button>
                </div>
              )}

              {effectiveIsAdmin && viewDetail.status === "approved" && (
                <div className="pt-1">
                  <button
                    onClick={() => { setPaidFromValue("company"); setPayDialog(viewDetail.id); }}
                    className="w-full flex items-center justify-center gap-1.5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition-colors">
                    <Banknote className="w-4 h-4" /> Xác nhận đã thanh toán
                  </button>
                </div>
              )}

              {effectiveIsAdmin && (
                <div className="flex gap-2 pt-1">
                  <button onClick={() => openEdit(viewDetail)}
                    className="flex-1 flex items-center justify-center gap-2 py-2 border border-border rounded-xl text-sm hover:bg-muted transition-colors">
                    <Edit2 className="w-4 h-4" /> Sửa
                  </button>
                  <button
                    onClick={() => { if (confirm("Xóa phiếu chi này?")) deleteExpense.mutate(viewDetail.id); }}
                    className="flex-1 flex items-center justify-center gap-2 py-2 border border-destructive/30 text-destructive rounded-xl text-sm hover:bg-destructive/10 transition-colors">
                    <Trash2 className="w-4 h-4" /> Xóa
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
