import { useState, useMemo, useEffect } from "react";
import type React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useListTasks, useUpdateTask, TaskStatus, type Task } from "@workspace/api-client-react";
import { Select } from "@/components/ui";
import {
  Clock, AlertCircle, CheckCircle2, User, Calendar,
  List, LayoutGrid, Search, X, Loader2, Briefcase, Save,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { StaffAssignmentEditor, type StaffAssignment } from "@/components/staff-assignment-editor";
import { useToast } from "@/hooks/use-toast";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const TOKEN_KEY = "amazingStudioToken_v2";
function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  return fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────
type TaskAssignment = {
  task_id: number;
  title: string;
  assignee_id: number | null;
  assignee_name: string | null;
  role: string | null;
  task_type: string | null;
  task_status: string;
  cost: number;
  notes: string | null;
};

type BookingWithTasks = {
  booking_id: number;
  order_code: string;
  shoot_date: string | null;
  booking_created_at: string;
  package_type: string;
  service_label: string | null;
  booking_status: string;
  location: string | null;
  customer_name: string;
  customer_phone: string;
  assigned_staff: StaffAssignment[];
  tasks: TaskAssignment[];
  required_roles?: string[];
  coveredRoles?: string[];
  staffStatus?: "unassigned" | "understaffed" | "ready";
  daysToShoot?: number | null;
  service_package_id?: number | null;
};

type StaffRate = { staffId: number; role: string; taskKey: string; rate: number | null };
type CastRatePkg = { staffId: number; role: string; packageId: number; amount: number | null };
type StaffOption = { id: number; name: string; roles: string[] };

// ── Kanban/List constants ─────────────────────────────────────────────────────
const PRIO_CONFIG = {
  high:   { label: "Cao",        color: "text-red-700",    bg: "bg-red-100 border-red-200" },
  medium: { label: "Trung bình", color: "text-yellow-700", bg: "bg-yellow-100 border-yellow-200" },
  low:    { label: "Thấp",       color: "text-green-700",  bg: "bg-green-100 border-green-200" },
};

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; iconColor: string; bg: string; border: string }> = {
  todo:        { label: "Chờ xử lý",      icon: Clock,        iconColor: "text-slate-500",   bg: "bg-slate-50 dark:bg-slate-900/20",     border: "border-slate-200" },
  in_progress: { label: "Đang thực hiện", icon: AlertCircle,  iconColor: "text-blue-500",    bg: "bg-blue-50 dark:bg-blue-900/20",       border: "border-blue-200" },
  done:        { label: "Hoàn thành",     icon: CheckCircle2, iconColor: "text-emerald-500", bg: "bg-emerald-50 dark:bg-emerald-900/20", border: "border-emerald-200" },
};
const columns = (Object.entries(STATUS_CONFIG) as [TaskStatus, typeof STATUS_CONFIG[string]][])
  .map(([id, cfg]) => ({ id, ...cfg }));

const CATEGORY_LABELS: Record<string, string> = {
  photo: "Chụp ảnh", editing: "Chỉnh sửa", delivery: "Bàn giao", admin: "Hành chính",
  design: "Thiết kế", meeting: "Họp", other: "Khác",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtShootDate(d: string | null | undefined) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch { return d; }
}

function isFullyStaffed(b: BookingWithTasks): boolean {
  return (b.assigned_staff ?? []).length > 0;
}

function daysUntil(d: string | null | undefined): { days: number; label: string; color: string } | null {
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dt = new Date(d); dt.setHours(0, 0, 0, 0);
  const diff = Math.round((dt.getTime() - today.getTime()) / 86400000);
  if (diff < 0)   return { days: diff, label: `${Math.abs(diff)} ngày trước`, color: "text-slate-400" };
  if (diff === 0) return { days: 0,    label: "Hôm nay!",                    color: "text-orange-600 font-bold" };
  if (diff <= 3)  return { days: diff, label: `Còn ${diff} ngày`,            color: "text-red-600 font-semibold" };
  if (diff <= 7)  return { days: diff, label: `Còn ${diff} ngày`,            color: "text-amber-600" };
  return { days: diff, label: `Còn ${diff} ngày`, color: "text-muted-foreground" };
}

// ── Booking Card ──────────────────────────────────────────────────────────────
function BookingCard({
  booking, staffOptions, allStaffRates, allCastRates, onSaved,
}: {
  booking: BookingWithTasks;
  staffOptions: StaffOption[];
  allStaffRates: StaffRate[];
  allCastRates: CastRatePkg[];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { effectiveIsAdmin } = useStaffAuth();
  const serverStaff = booking.assigned_staff ?? [];
  const [localStaff, setLocalStaff] = useState<StaffAssignment[]>(() => serverStaff);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");

  const serverKey = JSON.stringify(serverStaff);
  useEffect(() => {
    setLocalStaff(serverStaff);
    setSaveErr("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);

  const isDirty = JSON.stringify(localStaff) !== serverKey;
  const staffStatus = booking.staffStatus ?? (serverStaff.length > 0 ? "ready" : "unassigned");
  const du = daysUntil(booking.shoot_date);
  const daysToShoot = booking.daysToShoot;
  const isUpcoming = daysToShoot != null && daysToShoot >= 0 && daysToShoot <= 7;
  const borderColor = staffStatus === "ready" ? "border-l-emerald-400" : staffStatus === "understaffed" ? "border-l-amber-400" : "border-l-red-400";

  const handleSave = async () => {
    setSaving(true); setSaveErr("");
    try {
      const fullRes = await authFetch(`${BASE}/api/bookings/${booking.booking_id}`);
      if (!fullRes.ok) throw new Error("Không tải được đơn hàng");
      const full = await fullRes.json() as { items?: Array<Record<string, unknown>> };
      const payload: Record<string, unknown> = { assignedStaff: localStaff };
      if (Array.isArray(full.items) && full.items.length > 0) {
        const items = full.items.map(it => ({ ...it }));
        items[0] = { ...items[0], assignedStaff: localStaff };
        payload.items = items;
      }
      const res = await authFetch(`${BASE}/api/bookings/${booking.booking_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        const errMsg = e.error || "Lỗi lưu nhân sự";
        setSaveErr(errMsg);
        toast({ title: `❌ Lỗi: ${errMsg}`, variant: "destructive" });
        return;
      }
      toast({ title: `✅ Đã lưu nhân sự cho ${booking.customer_name}` });
      onSaved();
    } catch (e) {
      const errMsg = String(e instanceof Error ? e.message : e);
      setSaveErr(errMsg);
      toast({ title: `❌ Lỗi: ${errMsg}`, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`rounded-xl border border-border border-l-4 ${borderColor} bg-card shadow-sm p-3 transition-all hover:shadow-md`}>
      {/* Header */}
      <div className="mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm">{booking.customer_name}</span>
          <span className="text-xs text-muted-foreground font-mono">{booking.order_code}</span>
          {staffStatus === "unassigned" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 dark:bg-orange-900/30 font-medium">
              Chưa giao việc
            </span>
          )}
          {staffStatus === "understaffed" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 font-bold">
              ⚠ Thiếu người
            </span>
          )}
          {isUpcoming && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 font-medium">
              📅 Sắp chụp ({daysToShoot === 0 ? "Hôm nay!" : `${daysToShoot} ngày`})
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5 text-xs text-muted-foreground">
          <span>{booking.customer_phone}</span>
          <span>{booking.service_label || booking.package_type || "—"}</span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5 text-xs">
          <span className="flex items-center gap-1 text-muted-foreground">
            <Calendar size={10} />Chụp: {fmtShootDate(booking.shoot_date)}
          </span>
          {du && <span className={du.color}>{du.label}</span>}
          {booking.location && <span className="text-muted-foreground">📍 {booking.location}</span>}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground/60">
          Tạo: {fmtShootDate(booking.booking_created_at)}
        </div>
      </div>

      {/* Inline staff editor */}
      <div className="border-t border-border/40 pt-2.5">
        <StaffAssignmentEditor
          value={localStaff}
          onChange={setLocalStaff}
          staffOptions={staffOptions}
          allStaffRates={allStaffRates}
          allCastRates={allCastRates}
          packageId={booking.service_package_id ?? null}
          baseJobType="mac_dinh"
          bookingId={booking.booking_id}
          canManualPrice={effectiveIsAdmin}
        />
      </div>

      {/* Error */}
      {saveErr && (
        <div className="mt-1.5 text-xs text-red-500 bg-red-50 dark:bg-red-900/20 rounded-lg px-2 py-1">
          {saveErr}
        </div>
      )}

      {/* Save button (only when dirty) */}
      {isDirty && (
        <button
          onClick={handleSave}
          disabled={saving}
          className="mt-2 w-full py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {saving ? "Đang lưu..." : "Lưu thay đổi nhân sự"}
        </button>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function TasksPage() {
  const qc = useQueryClient();
  const { data: tasks = [], isLoading: tasksLoading } = useListTasks({});
  const updateTask = useUpdateTask();

  // Load all active staff via authFetch so auth token is always sent.
  // Uses /api/staff/assignable which is available to any authenticated user (not admin-only).
  const { data: staff = [] } = useQuery<StaffOption[]>({
    queryKey: ["staff-assignable"],
    queryFn: () =>
      authFetch(`${BASE}/api/staff/assignable`)
        .then(r => r.ok ? r.json() : [])
        .then((d: unknown) => (Array.isArray(d) ? (d as StaffOption[]) : [])),
    staleTime: 5 * 60 * 1000,
  });

  const [viewMode, setViewMode] = useState<"booking" | "kanban" | "list">("booking");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "unassigned" | "understaffed" | "ready">("all");
  // ── Deep-link: ?bookingId=N → mở view "booking", clear filter, scroll & highlight card ──
  const [pendingBookingId, setPendingBookingId] = useState<number | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [filterAssignee, setFilterAssignee] = useState("");
  const [filterPrio, setFilterPrio] = useState("");
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [shootMonth, setShootMonth] = useState(defaultMonth);
  const [useShootMonthFilter, setUseShootMonthFilter] = useState(true);

  // ── Shoot-month filter ────────────────────────────────────────────────────
  const nowYM = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
  const [shootPreset, setShootPreset] = useState<"all" | "this" | "prev" | "next">("this");
  const [shootMonthFilter, setShootMonthFilter] = useState<string>(nowYM);

  function applyShootPreset(p: "all" | "this" | "prev" | "next") {
    setShootPreset(p);
    if (p === "all") return;
    const d = new Date();
    if (p === "prev") d.setMonth(d.getMonth() - 1);
    if (p === "next") d.setMonth(d.getMonth() + 1);
    setShootMonthFilter(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  function formatMonth(ym: string) {
    const [y, m] = ym.split("-");
    return `Tháng ${parseInt(m)}/${y}`;
  }

  // Booking-view data
  const { data: bookingViewData = [], isLoading: bvLoading } = useQuery<BookingWithTasks[]>({
    queryKey: ["tasks-booking-view", useShootMonthFilter ? shootMonth : "all"],
    queryFn: async () => {
      const url = useShootMonthFilter
        ? `${BASE}/api/tasks/booking-view?shootMonth=${shootMonth}`
        : `${BASE}/api/tasks/booking-view`;
      const res = await authFetch(url);
      return res.ok ? res.json() : [];
    },
    enabled: viewMode === "booking",
    staleTime: 0,
  });

  const availableMonths = useMemo(() => {
    const set = new Set<string>();
    bookingViewData.forEach(b => {
      if (b.shoot_date) {
        const d = new Date(b.shoot_date);
        if (!isNaN(d.getTime())) set.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      }
    });
    return Array.from(set).sort();
  }, [bookingViewData]);

  // Staff rates fallback; cast-by-package preferred in editor when packageId set
  const { data: allStaffRates = [] } = useQuery<StaffRate[]>({
    queryKey: ["staff-rates"],
    queryFn: () =>
      authFetch(`${BASE}/api/staff-rates`)
        .then(r => r.ok ? r.json() : [])
        .then((d: unknown) => (Array.isArray(d) ? d : [])),
  });

  const { data: allCastRates = [] } = useQuery<CastRatePkg[]>({
    queryKey: ["staff-cast-all"],
    queryFn: () =>
      authFetch(`${BASE}/api/staff-cast`)
        .then(r => r.ok ? r.json() : [])
        .then((d: unknown) => (Array.isArray(d) ? d as CastRatePkg[] : [])),
    staleTime: 60_000,
  });

  const staffOptions: StaffOption[] = staff;

  // Filter booking-view data
  const filteredBookings = useMemo(() => {
    let data = [...bookingViewData];
    // filter by shoot month
    if (shootPreset !== "all") {
      data = data.filter(b => {
        if (!b.shoot_date) return false;
        const d = new Date(b.shoot_date);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        return ym === shootMonthFilter;
      });
    }
    if (tab === "unassigned")  data = data.filter(b => b.staffStatus === "unassigned");
    if (tab === "understaffed") data = data.filter(b => b.staffStatus === "understaffed");
    if (tab === "ready") data = data.filter(b => b.staffStatus === "ready");
    if (search.trim()) {
      const q = search.toLowerCase();
      data = data.filter(b =>
        b.customer_name.toLowerCase().includes(q) ||
        b.customer_phone.toLowerCase().includes(q) ||
        b.order_code.toLowerCase().includes(q) ||
        (b.shoot_date && b.shoot_date.includes(q))
      );
    }
    return data;
  }, [bookingViewData, tab, search, shootPreset, shootMonthFilter]);

  const handleStatusChange = (taskId: number, newStatus: TaskStatus) => {
    updateTask.mutate({ id: taskId, data: { status: newStatus } }, {
      onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/tasks"] }),
    });
  };

  const handleSaved = (bookingId?: number) => {
    qc.invalidateQueries({ queryKey: ["tasks-booking-view"] });
    qc.invalidateQueries({ queryKey: ["bookings"] });
    qc.invalidateQueries({ queryKey: ["staff-cast"] });
    qc.invalidateQueries({ queryKey: ["staff-cast-all"] });
    qc.invalidateQueries({ queryKey: ["photoshop-booking-view"] });
    qc.invalidateQueries({ queryKey: ["photoshop-stats"] });
    qc.invalidateQueries({ queryKey: ["dashboard-simple"] });
    qc.invalidateQueries({ queryKey: ["dashboard-v2"] });
    qc.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    if (bookingId != null) {
      qc.invalidateQueries({ queryKey: ["booking", bookingId] });
      qc.invalidateQueries({ queryKey: ["booking-full", bookingId] });
    }
  };

  // Deep-link: ?bookingId=N → mở view "booking", clear filter, đợi data, scroll & highlight
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const bid = params.get("bookingId");
    if (!bid) return;
    const id = Number(bid);
    if (!Number.isFinite(id) || id <= 0) return;
    setPendingBookingId(id);
    setDeepLinkError(null);
    setViewMode("booking");
    setShootPreset("all");
    setUseShootMonthFilter(false);
    setTab("all");
    setSearch("");
    // Clean URL
    const cleanPath = window.location.pathname + window.location.hash;
    window.history.replaceState({}, "", cleanPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Khi data về, tìm booking khớp → scroll & highlight, hoặc báo không tìm thấy
  useEffect(() => {
    if (pendingBookingId == null) return;
    if (bvLoading) return;
    const found = bookingViewData.find(b => b.booking_id === pendingBookingId);
    if (!found) {
      setDeepLinkError(`Không tìm thấy đơn #${pendingBookingId} trong danh sách giao việc`);
      setPendingBookingId(null);
      return;
    }
    // Đợi 1 tick cho DOM render xong
    const t = window.setTimeout(() => {
      const el = document.getElementById(`task-booking-${pendingBookingId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setHighlightId(pendingBookingId);
      setPendingBookingId(null);
      // Tắt highlight sau 2.5s
      window.setTimeout(() => setHighlightId(null), 2500);
    }, 80);
    return () => window.clearTimeout(t);
  }, [pendingBookingId, bvLoading, bookingViewData]);

  const filteredTasks = tasks.filter(t => {
    const matchAssignee = !filterAssignee || String(t.assigneeId) === filterAssignee;
    const matchPrio = !filterPrio || t.priority === filterPrio;
    return matchAssignee && matchPrio;
  });
  const tasksByStatus = {
    todo:        filteredTasks.filter(t => t.status === "todo"),
    in_progress: filteredTasks.filter(t => t.status === "in_progress"),
    done:        filteredTasks.filter(t => t.status === "done"),
  };

  const monthFiltered = useMemo(() => {
    if (shootPreset === "all") return bookingViewData;
    return bookingViewData.filter(b => {
      if (!b.shoot_date) return false;
      const d = new Date(b.shoot_date);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      return ym === shootMonthFilter;
    });
  }, [bookingViewData, shootPreset, shootMonthFilter]);

  const counts = {
    all:         monthFiltered.length,
    unassigned:  monthFiltered.filter(b => b.staffStatus === "unassigned").length,
    understaffed: monthFiltered.filter(b => b.staffStatus === "understaffed").length,
    ready:       monthFiltered.filter(b => b.staffStatus === "ready").length,
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Giao việc</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {viewMode === "booking"
              ? `${filteredBookings.length} đơn hàng`
              : `${tasksByStatus.todo.length} chờ · ${tasksByStatus.in_progress.length} đang làm · ${tasksByStatus.done.length} xong`}
          </p>
        </div>
        <div className="flex rounded-lg border overflow-hidden">
          <button onClick={() => setViewMode("booking")}
            className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${viewMode === "booking" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
            <Briefcase className="w-3.5 h-3.5" /> Theo đơn
          </button>
          <button onClick={() => setViewMode("kanban")}
            className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${viewMode === "kanban" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
            <LayoutGrid className="w-3.5 h-3.5" /> Kanban
          </button>
          <button onClick={() => setViewMode("list")}
            className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
            <List className="w-3.5 h-3.5" /> Danh sách
          </button>
        </div>
      </div>

      {/* Deep-link banner */}
      {pendingBookingId != null && (
        <div className="mb-3 rounded-lg border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
          <span>Đang mở giao việc của đơn #{pendingBookingId}…</span>
        </div>
      )}
      {deepLinkError && (
        <div className="mb-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{deepLinkError}</span>
          </div>
          <button onClick={() => setDeepLinkError(null)} className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ─── BOOKING VIEW (default) ──────────────────────────────────────────── */}
      {viewMode === "booking" && (
        <div className="flex flex-col flex-1 min-h-0 gap-3">
          {/* Month/year filter by shoot date */}
          <div className="rounded-xl border border-border bg-card p-3 space-y-2.5">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Lọc theo tháng chụp</p>
            <div className="flex flex-wrap gap-2">
              {(["all", "this", "prev", "next"] as const).map(p => (
                <button key={p} type="button" onClick={() => applyShootPreset(p)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${shootPreset === p ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
                  {p === "all" ? "Tất cả" : p === "this" ? "Tháng này" : p === "prev" ? "Tháng trước" : "Tháng sau"}
                </button>
              ))}
            </div>
            <div className="flex gap-2 items-center">
              <select
                className="flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm"
                value={shootMonthFilter}
                onChange={e => { setShootMonthFilter(e.target.value); setShootPreset("this"); }}>
                {availableMonths.length > 0
                  ? availableMonths.map(m => <option key={m} value={m}>{formatMonth(m)}</option>)
                  : Array.from({ length: 12 }, (_, i) => {
                      const d = new Date(); d.setMonth(d.getMonth() - 5 + i);
                      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                      return <option key={ym} value={ym}>{formatMonth(ym)}</option>;
                    })
                }
              </select>
              {shootPreset !== "all" && (
                <span className="text-xs text-primary font-medium whitespace-nowrap">
                  {filteredBookings.length} đơn
                </span>
              )}
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              className="w-full pl-9 pr-9 py-2 rounded-xl border border-border bg-background text-sm placeholder:text-muted-foreground"
              placeholder="Tìm tên khách, SĐT, mã đơn..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground">
                <X size={14} />
              </button>
            )}
          </div>

          {/* Month filter row */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-muted-foreground font-medium">Tháng chụp:</label>
            <button
              onClick={() => setUseShootMonthFilter(v => !v)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${useShootMonthFilter ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border text-muted-foreground"}`}
            >
              {useShootMonthFilter ? "Đang lọc theo tháng" : "Tất cả"}
            </button>
            {useShootMonthFilter && (
              <select
                value={shootMonth}
                onChange={e => setShootMonth(e.target.value)}
                className="border rounded px-2 py-1 text-xs bg-background"
              >
                {Array.from({ length: 13 }, (_, i) => {
                  const d = new Date(now.getFullYear(), now.getMonth() - 6 + i, 1);
                  const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
                  const lbl = d.toLocaleDateString("vi-VN", { month: "long", year: "numeric" });
                  return <option key={v} value={v}>{lbl}</option>;
                })}
              </select>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 flex-wrap">
            {([
              { key: "all",          label: `Tất cả (${counts.all})`,                 color: "" },
              { key: "unassigned",   label: `Chưa giao (${counts.unassigned})`,       color: "text-orange-700" },
              { key: "understaffed", label: `Thiếu người (${counts.understaffed})`,   color: "text-red-700" },
              { key: "ready",        label: `Đủ người (${counts.ready})`,             color: "text-emerald-700" },
            ] as { key: typeof tab; label: string; color: string }[]).map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${tab === t.key ? "bg-primary text-primary-foreground" : `bg-muted ${t.color || "text-muted-foreground"} hover:bg-muted/80`}`}>
                {t.label}
              </button>
            ))}
          </div>
          {useShootMonthFilter && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Calendar className="w-3.5 h-3.5" />
              <span>Đang lọc theo tháng chụp: {shootMonth.slice(5, 7)}/{shootMonth.slice(0, 4)}</span>
            </div>
          )}

          {/* Cards */}
          <div className="flex-1 overflow-y-auto">
            {bvLoading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
                <Loader2 size={20} className="animate-spin" /><span>Đang tải...</span>
              </div>
            ) : filteredBookings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-2">
                <Briefcase size={36} className="opacity-30" />
                <span className="text-sm">Không có đơn hàng nào</span>
                {search && <span className="text-xs opacity-60">Thử xóa tìm kiếm</span>}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground px-1">{filteredBookings.length} đơn</div>
                {filteredBookings.map(b => (
                  <div
                    key={b.booking_id}
                    id={`task-booking-${b.booking_id}`}
                    className={highlightId === b.booking_id ? "rounded-xl ring-2 ring-rose-400 dark:ring-rose-500 ring-offset-2 ring-offset-background transition-all" : "transition-all"}
                  >
                    <BookingCard
                      booking={b}
                      staffOptions={staffOptions}
                      allStaffRates={allStaffRates}
                      allCastRates={allCastRates}
                      onSaved={handleSaved}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── KANBAN VIEW ─────────────────────────────────────────────────────── */}
      {viewMode === "kanban" && (
        <>
          <div className="flex gap-2 mb-4">
            <Select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)} className="text-sm">
              <option value="">Tất cả nhân viên</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select value={filterPrio} onChange={e => setFilterPrio(e.target.value)} className="text-sm">
              <option value="">Tất cả độ ưu tiên</option>
              <option value="high">🔴 Cao</option>
              <option value="medium">🟡 Trung bình</option>
              <option value="low">🟢 Thấp</option>
            </Select>
          </div>
          {tasksLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="animate-spin mr-2" />Đang tải...</div>
          ) : (
            <div className="flex gap-3 flex-1 overflow-x-auto min-h-0">
              {columns.map(col => {
                const ColTasks = tasksByStatus[col.id as keyof typeof tasksByStatus] ?? [];
                return (
                  <div key={col.id}
                    className={`flex flex-col flex-1 min-w-[240px] max-w-sm rounded-xl border ${col.border} ${col.bg} min-h-0`}
                    onDragOver={e => e.preventDefault()}
                    onDrop={() => { if (dragId !== null) handleStatusChange(dragId, col.id); setDragId(null); }}>
                    <div className={`px-4 py-3 flex items-center justify-between border-b ${col.border}`}>
                      <div className="flex items-center gap-2">
                        <col.icon className={`w-4 h-4 ${col.iconColor}`} />
                        <span className="font-semibold text-sm">{col.label}</span>
                      </div>
                      <span className="text-xs font-bold bg-background border rounded-full px-2 py-0.5">{ColTasks.length}</span>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2 space-y-2">
                      {ColTasks.map(task => {
                        const prio = PRIO_CONFIG[task.priority as keyof typeof PRIO_CONFIG] ?? PRIO_CONFIG.medium;
                        const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && task.status !== "done";
                        return (
                          <div key={task.id} draggable onDragStart={() => setDragId(task.id)}
                            className="bg-background rounded-xl border shadow-sm p-3 cursor-grab active:cursor-grabbing hover:shadow-md transition-all group">
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <p className="font-medium text-sm leading-snug flex-1">{task.title}</p>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium flex-shrink-0 ${prio.bg} ${prio.color}`}>{prio.label}</span>
                            </div>
                            {task.description && <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{task.description}</p>}
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <div className="flex items-center gap-2">
                                {task.assigneeName && <span className="flex items-center gap-1"><User className="w-3 h-3" />{task.assigneeName}</span>}
                                {(task as Task & { category?: string }).category && (task as Task & { category?: string }).category !== "other" && <span className="bg-muted px-1.5 py-0.5 rounded text-[10px]">{CATEGORY_LABELS[(task as Task & { category?: string }).category!] ?? (task as Task & { category?: string }).category}</span>}
                              </div>
                              {task.dueDate && (
                                <span className={`flex items-center gap-1 ${isOverdue ? "text-red-600 font-medium" : ""}`}>
                                  <Calendar className="w-3 h-3" />{formatDate(task.dueDate)}
                                </span>
                              )}
                            </div>
                            <div className="flex gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              {columns.filter(c => c.id !== col.id).map(c => (
                                <button key={c.id} onClick={() => handleStatusChange(task.id, c.id)}
                                  className={`text-[10px] px-2 py-1 rounded border ${c.bg} ${c.iconColor} font-medium hover:opacity-80 transition`}>
                                  → {c.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ─── LIST VIEW ───────────────────────────────────────────────────────── */}
      {viewMode === "list" && (
        <>
          <div className="flex gap-2 mb-4">
            <Select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)} className="text-sm">
              <option value="">Tất cả nhân viên</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Select value={filterPrio} onChange={e => setFilterPrio(e.target.value)} className="text-sm">
              <option value="">Tất cả độ ưu tiên</option>
              <option value="high">🔴 Cao</option>
              <option value="medium">🟡 Trung bình</option>
              <option value="low">🟢 Thấp</option>
            </Select>
          </div>
          {tasksLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">Đang tải...</div>
          ) : filteredTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <CheckCircle2 className="w-10 h-10 opacity-30" />
              <p>Không có công việc nào</p>
            </div>
          ) : (
            <div className="overflow-x-auto flex-1">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground text-xs">Công việc</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground text-xs">Người thực hiện</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground text-xs">Trạng thái</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground text-xs">Hạn</th>
                    <th className="text-left py-2 px-3 font-medium text-muted-foreground text-xs">Ưu tiên</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.map(task => {
                    const prio = PRIO_CONFIG[task.priority as keyof typeof PRIO_CONFIG] ?? PRIO_CONFIG.medium;
                    const st = STATUS_CONFIG[task.status as TaskStatus] ?? STATUS_CONFIG.todo;
                    const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && task.status !== "done";
                    return (
                      <tr key={task.id} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="py-2 px-3">
                          <p className="font-medium truncate max-w-xs">{task.title}</p>
                          {task.description && <p className="text-xs text-muted-foreground truncate max-w-xs">{task.description}</p>}
                        </td>
                        <td className="py-2 px-3">
                          {task.assigneeName
                            ? <span className="flex items-center gap-1"><User className="w-3 h-3 text-muted-foreground" />{task.assigneeName}</span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 px-3">
                          <Select value={task.status} onChange={e => handleStatusChange(task.id, e.target.value as TaskStatus)} className="text-xs h-7 py-0 w-36">
                            {columns.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                          </Select>
                        </td>
                        <td className="py-2 px-3">
                          {task.dueDate
                            ? <span className={`text-xs flex items-center gap-1 ${isOverdue ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
                                <Calendar className="w-3 h-3" />{formatDate(task.dueDate)}
                              </span>
                            : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="py-2 px-3">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${prio.bg} ${prio.color}`}>{prio.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
