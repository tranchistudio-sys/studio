import { useState, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ArrowLeft, Phone, Mail, Calendar, Briefcase, Star,
  CheckCircle2, Clock, XCircle, PlayCircle, Banknote, TrendingUp,
  FileText, Plus, ChevronRight, Lock, Pencil, AlertCircle,
  CalendarOff, ClipboardList, Shield, Camera, ImageUp, Trash2, X,
} from "lucide-react";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { cn } from "@/lib/utils";
import { compressStaffAvatar } from "@/components/StaffAvatar";
import { StaffSalaryPanel } from "@/components/StaffSalaryPanel";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const getAuthHeaders = (): Record<string, string> => {
  const token = localStorage.getItem("amazingStudioToken_v2");
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const fetchJson = (url: string, opts?: RequestInit) => {
  const merged: RequestInit = {
    ...opts,
    headers: { ...getAuthHeaders(), ...(opts?.headers as Record<string, string> || {}) },
  };
  return fetch(`${BASE}${url}`, merged).then(r => { if (!r.ok) throw new Error("Lỗi"); return r.json(); });
};

const fmtVND = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v);

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" });

// ─── Types ───────────────────────────────────────────────────────────────────

interface StaffData {
  id: number; name: string; phone: string; email?: string;
  joinDate?: string; isActive: boolean; staffType: string;
  role: string; roles: string[]; baseSalaryAmount: number;
  commissionRate: number; notes?: string;
}

interface JobEntry {
  id: number; shootDate: string; packageType?: string; serviceLabel?: string;
  status: string; totalAmount: number;
  customerName: string; customerPhone?: string;
  roles: string[]; roleTasks: Record<string, string>;
}

interface EarningsRecord {
  id: number; bookingId: number; role: string; serviceName: string;
  rate: number; earnedDate: string;
}

interface RateEntry {
  id: number; role: string; taskKey: string; taskName: string;
  rate: number | null; rateType: string; notes?: string | null;
}

interface CastRate {
  id: number; staffId: number; role: string; packageId: number; amount: number | null;
}

interface ServicePackageBrief {
  id: number; code: string; name: string; price: number; serviceType?: string | null;
}

interface LeaveRequest {
  id: number; staffId: number; startDate: string; endDate: string;
  reason: string; status: string; approvedByName?: string;
  reviewedAt?: string; notes?: string; createdAt: string;
}

interface InternalNotes {
  id: number; staffId: number; skillsStrong?: string;
  workNotes?: string; internalRating?: number; generalNotes?: string;
}

interface ProfileData {
  staff: StaffData;
  monthStats: { total: number; completed: number; pending: number; inProgress: number; cancelled: number };
  monthJobs: JobEntry[];
  todayJobs: JobEntry[];
  jobHistory: JobEntry[];
  earnings: {
    thisMonth: number;
    today: number;
    total: number;
    records: EarningsRecord[];
    estimate?: {
      baseSalary: number;
      daysInMonth: number;
      daysAccrued: number;
      baseSalaryAccrued: number;
      showEarnings: number;
      overtimePay?: number;
      bonus: number;
      penalty: number;
      leaveDeduction: number;
      advance: number;
      total: number;
      source: "paid_payroll" | "draft_payroll" | "realtime";
      payrollId?: number;
      showItems: Array<{
        bookingId: number;
        shootDate: string;
        role: string;
        taskKey: string;
        serviceName: string;
        rate: number;
        rateType?: string;
        fromCastAmount: boolean;
        earningId?: number;
        allowanceType?: string;
        allowanceNote?: string | null;
        percentRate?: number;
        percentBase?: number;
        // Task #499: Sale commission tách "Đã thu" vs "Còn treo" (preview only)
        collectedBase?: number;
        remainingBase?: number;
        collectedAmount?: number;
        remainingAmount?: number;
      }>;
      leaveDaysUsed: number;
      leaveDaysCap: number;
      forecastShowEarnings?: number;
      forecastBaseSalary?: number;
      forecastTotal?: number;
      forecastShowCount?: number;
      forecastPastCount?: number;
      forecastFutureCount?: number;
    } | null;
  };
  rates: RateEntry[];
  leaveRequests: LeaveRequest[];
  internalNotes: InternalNotes | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  admin: "Quản lý", photographer: "Nhiếp ảnh", photo: "Nhiếp ảnh",
  makeup: "Trang điểm", sale: "Kinh doanh",
  photoshop: "Chỉnh sửa", assistant: "Hỗ trợ", marketing: "Marketing",
  unknown: "Tham gia",
};

const TASK_TEMPLATES: Record<string, Array<{ key: string; name: string; rateType: string }>> = {
  photographer: [
    { key: "chup_album_co", name: "Chụp album cổng", rateType: "fixed" },
    { key: "chup_album_ngoai_canh", name: "Chụp album ngoại cảnh", rateType: "fixed" },
    { key: "chup_tiec", name: "Chụp tiệc / phóng sự", rateType: "fixed" },
    { key: "chup_beauty", name: "Chụp beauty", rateType: "fixed" },
    { key: "chup_gia_dinh", name: "Chụp gia đình", rateType: "fixed" },
    { key: "chup_khac", name: "Chụp khác", rateType: "fixed" },
  ],
  makeup: [
    { key: "makeup_album", name: "Makeup chụp album", rateType: "fixed" },
    { key: "makeup_tiec", name: "Makeup tiệc cưới", rateType: "fixed" },
    { key: "makeup_beauty", name: "Makeup beauty", rateType: "fixed" },
    { key: "makeup_ba_sui", name: "Makeup bà sui", rateType: "fixed" },
    { key: "makeup_khac", name: "Makeup khác", rateType: "fixed" },
  ],
  photoshop: [
    { key: "pts_album", name: "PTS album", rateType: "per_photo" },
    { key: "pts_tiec", name: "PTS tiệc", rateType: "per_photo" },
    { key: "pts_beauty", name: "PTS beauty", rateType: "per_photo" },
    { key: "pts_khac", name: "PTS khác", rateType: "per_photo" },
  ],
};

const ROLE_ICONS: Record<string, string> = {
  admin: "👑", photographer: "📷", photo: "📷",
  makeup: "💄", sale: "💼", photoshop: "🖥️", assistant: "🤝", marketing: "📣",
};

const STATUS_LABELS: Record<string, string> = {
  completed: "Hoàn thành", hoan_thanh: "Hoàn thành",
  pending: "Chờ xử lý", confirmed: "Đã xác nhận",
  in_progress: "Đang thực hiện", cancelled: "Đã hủy", huy: "Đã hủy",
};

const STATUS_COLORS: Record<string, string> = {
  completed: "text-emerald-700 bg-emerald-50 border-emerald-200",
  hoan_thanh: "text-emerald-700 bg-emerald-50 border-emerald-200",
  pending: "text-amber-700 bg-amber-50 border-amber-200",
  confirmed: "text-blue-700 bg-blue-50 border-blue-200",
  in_progress: "text-violet-700 bg-violet-50 border-violet-200",
  cancelled: "text-red-700 bg-red-50 border-red-200",
  huy: "text-red-700 bg-red-50 border-red-200",
};

const LEAVE_STATUS_LABELS: Record<string, string> = {
  pending: "Chờ duyệt", approved: "Đã duyệt", rejected: "Từ chối",
};

const LEAVE_STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
};

const COVER_GRADIENT: Record<string, string> = {
  admin:        "from-violet-500 via-purple-400 to-violet-200",
  photographer: "from-blue-500 via-indigo-400 to-blue-200",
  photo:        "from-blue-500 via-indigo-400 to-blue-200",
  makeup:       "from-pink-500 via-rose-400 to-pink-200",
  sale:         "from-orange-400 via-amber-300 to-orange-100",
  photoshop:    "from-teal-500 via-cyan-400 to-teal-200",
  assistant:    "from-slate-500 via-gray-400 to-slate-200",
  marketing:    "from-green-500 via-emerald-400 to-green-200",
};

const AVATAR_GRADIENT: Record<string, string> = {
  admin:        "from-violet-500 to-purple-600",
  photographer: "from-blue-500 to-indigo-600",
  photo:        "from-blue-500 to-indigo-600",
  makeup:       "from-pink-500 to-rose-600",
  sale:         "from-orange-400 to-amber-500",
  photoshop:    "from-teal-500 to-cyan-600",
  assistant:    "from-slate-400 to-gray-500",
  marketing:    "from-green-500 to-emerald-600",
};

const STATUS_DOT_CLS: Record<string, string> = {
  active:    "bg-emerald-500 ring-emerald-100",
  probation: "bg-amber-400 ring-amber-100",
  inactive:  "bg-red-500 ring-red-100",
};

// ─── Main Component ────────────────────────────────────────────────────────────

export default function StaffProfilePage() {
  const { id } = useParams<{ id: string }>();
  const staffId = parseInt(id ?? "0");
  const [, navigate] = useLocation();
  const { viewer, isAdmin, canViewProfile } = useStaffAuth();
  const qc = useQueryClient();

  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const [leaveSheet, setLeaveSheet] = useState(false);
  const [approveDialog, setApproveDialog] = useState<LeaveRequest | null>(null);
  const [notesSheet, setNotesSheet] = useState(false);
  const [notesForm, setNotesForm] = useState<Partial<InternalNotes>>({});
  const [jobDetailId, setJobDetailId] = useState<number | null>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [coverUploading, setCoverUploading] = useState(false);
  const [coverError, setCoverError] = useState("");
  const [castSheet, setCastSheet] = useState(false);
  const [castNewRole, setCastNewRole] = useState("photographer");
  const [castPkgEdits, setCastPkgEdits] = useState<Record<number, string>>({}); // packageId → amount string
  const [castSaving, setCastSaving] = useState(false);
  // Task #476: editor cho "Đơn giá hậu kỳ / tấm" (staff_rate_prices role=photoshop, taskKey=mac_dinh, rateType=per_photo)
  const [psPerPhotoEdit, setPsPerPhotoEdit] = useState<string | null>(null);
  // Task #496: collapse từng role section trong "Bảng cast chính thức" (default ẩn cho gọn)
  const [castOpenRoles, setCastOpenRoles] = useState<Set<string>>(new Set());
  const toggleCastRole = (r: string) => setCastOpenRoles(prev => {
    const next = new Set(prev);
    if (next.has(r)) next.delete(r); else next.add(r);
    return next;
  });
  const [psPerPhotoSaving, setPsPerPhotoSaving] = useState(false);
  // Task #477: state riêng cho ô nhập đơn giá hậu kỳ / tấm bên trong castSheet
  const [psSheetEdit, setPsSheetEdit] = useState<string>("");
  const [psSheetEditing, setPsSheetEditing] = useState(false);

  // Avatar lightbox & menu
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const coverFileInputRef = useRef<HTMLInputElement>(null);

  // Leave form
  const [leaveForm, setLeaveForm] = useState({ startDate: "", endDate: "", reason: "", notes: "" });
  const vnNow = () => { const d = new Date(); return { month: d.getMonth() + 1, year: d.getFullYear() }; };
  const [salaryMonth, setSalaryMonth] = useState(vnNow().month);
  const [salaryYear, setSalaryYear] = useState(vnNow().year);

  const { data: profile, isLoading, error } = useQuery<ProfileData>({
    queryKey: ["staff-profile", staffId, salaryMonth, salaryYear],
    queryFn: () => fetchJson(`/api/staff/${staffId}/profile?month=${salaryMonth}&year=${salaryYear}`),
    enabled: !!staffId,
  });

  const createLeave = useMutation({
    mutationFn: (data: typeof leaveForm) =>
      fetchJson(`/api/staff/${staffId}/leave-requests`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      setLeaveSheet(false);
      setLeaveForm({ startDate: "", endDate: "", reason: "", notes: "" });
    },
  });

  const updateLeave = useMutation({
    mutationFn: ({ leaveId, status, approvedByName }: { leaveId: number; status: string; approvedByName?: string }) =>
      fetchJson(`/api/leave-requests/${leaveId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, approvedByName }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      setApproveDialog(null);
    },
  });

  const saveNotes = useMutation({
    mutationFn: (data: Partial<InternalNotes>) =>
      fetchJson(`/api/staff/${staffId}/internal-notes`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      setNotesSheet(false);
    },
  });

  // ─── Cast rates (new packageId-based system) ────────────────────────────────
  const { data: allPackages = [] } = useQuery<ServicePackageBrief[]>({
    queryKey: ["service-packages-brief"],
    queryFn: () => fetchJson("/api/service-packages"),
    staleTime: 60_000,
  });

  const { data: castRates = [], refetch: refetchCast } = useQuery<CastRate[]>({
    queryKey: ["staff-cast", staffId],
    queryFn: () => fetchJson(`/api/staff-cast?staffId=${staffId}`),
    enabled: !!staffId,
  });

  const saveCastBulk = async (role: string, edits: Record<number, string>) => {
    setCastSaving(true);
    try {
      const rates = Object.entries(edits).map(([pkgId, amt]) => ({
        packageId: parseInt(pkgId),
        amount: amt.trim() === "" ? null : parseFloat(amt),
      }));
      await fetchJson("/api/staff-cast/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffId, role, rates }),
      });
      await refetchCast();
      qc.invalidateQueries({ queryKey: ["staff-cast", staffId] });
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      setCastPkgEdits({});
    } finally {
      setCastSaving(false);
    }
  };

  // Task #476: lưu đơn giá hậu kỳ per-photo cho staff
  const savePsPerPhoto = async (raw: string) => {
    setPsPerPhotoSaving(true);
    try {
      const trimmed = raw.trim();
      const rate = trimmed === "" ? null : parseFloat(trimmed);
      await fetchJson("/api/staff-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId,
          role: "photoshop",
          taskKey: "mac_dinh",
          taskName: "Đơn giá ảnh hậu kỳ",
          rate,
          rateType: "per_photo",
        }),
      });
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      setPsPerPhotoEdit(null);
    } finally {
      setPsPerPhotoSaving(false);
    }
  };

  const deleteCastRate = useMutation({
    mutationFn: (rateId: number) =>
      fetchJson(`/api/staff-cast/${rateId}`, { method: "DELETE" }),
    onSuccess: () => {
      refetchCast();
      qc.invalidateQueries({ queryKey: ["staff-cast", staffId] });
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
    },
  });

  const handleAvatarUpload = async (base64: string) => {
    setAvatarUploading(true);
    setAvatarError("");
    try {
      if (!base64.startsWith("data:image")) {
        setAvatarError("Định dạng ảnh không hợp lệ");
        setAvatarUploading(false);
        return;
      }
      if (base64.length > 2097152) {
        setAvatarError("Ảnh quá lớn (>2MB)");
        setAvatarUploading(false);
        return;
      }
      await fetchJson(`/api/staff/${staffId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar: base64 }),
      });
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      qc.invalidateQueries({ queryKey: ["staff"] });
    } catch (err: unknown) {
      const msg = (err as Error)?.message || "Lỗi upload ảnh đại diện";
      setAvatarError(msg);
      console.error("Avatar upload error:", err);
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleAvatarDelete = async () => {
    setAvatarUploading(true);
    try {
      await fetchJson(`/api/staff/${staffId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar: null }),
      });
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      qc.invalidateQueries({ queryKey: ["staff"] });
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleCoverUpload = async (base64: string) => {
    setCoverUploading(true);
    setCoverError("");
    try {
      if (!base64.startsWith("data:image")) {
        setCoverError("Định dạng ảnh không hợp lệ");
        setCoverUploading(false);
        return;
      }
      if (base64.length > 2097152) {
        setCoverError("Ảnh quá lớn (>2MB)");
        setCoverUploading(false);
        return;
      }
      await fetchJson(`/api/staff/${staffId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coverImageUrl: base64 }),
      });
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      qc.invalidateQueries({ queryKey: ["staff"] });
    } catch (err: unknown) {
      const msg = (err as Error)?.message || "Lỗi upload ảnh bìa";
      setCoverError(msg);
      console.error("Cover upload error:", err);
    } finally {
      setCoverUploading(false);
    }
  };

  const handleCoverFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setCoverError("");
    if (!file.type.startsWith("image/")) {
      setCoverError("Vui lòng chọn file ảnh");
      return;
    }
    if (file.size > 2097152) {
      setCoverError("Ảnh quá lớn (>2MB)");
      return;
    }
    try {
      const reader = new FileReader();
      reader.onerror = () => {
        setCoverError("Lỗi đọc file");
      };
      reader.onload = async (evt) => {
        const base64 = evt.target?.result as string;
        await handleCoverUpload(base64);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      setCoverError("Lỗi upload ảnh bìa");
      console.error("Cover upload error:", err);
    }
  };

  const handleCoverDelete = async () => {
    setCoverUploading(true);
    try {
      await fetchJson(`/api/staff/${staffId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coverImageUrl: null }),
      });
      qc.invalidateQueries({ queryKey: ["staff-profile", staffId] });
      qc.invalidateQueries({ queryKey: ["staff"] });
    } finally {
      setCoverUploading(false);
    }
  };

  // ── Access control ─────────────────────────────────────────────────────────
  if (!viewer) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <Lock className="w-12 h-12 text-muted-foreground/40" />
        <h2 className="text-lg font-semibold">Chưa đăng nhập</h2>
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          Vui lòng chọn tài khoản của bạn từ trang Nhân sự trước khi xem hồ sơ
        </p>
        <Button onClick={() => navigate("/staff")} variant="outline" className="gap-2">
          <ArrowLeft className="w-4 h-4" /> Về trang Nhân sự
        </Button>
      </div>
    );
  }

  if (!canViewProfile(staffId)) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <Shield className="w-12 h-12 text-destructive/40" />
        <h2 className="text-lg font-semibold">Không có quyền truy cập</h2>
        <p className="text-sm text-muted-foreground text-center max-w-xs">
          Bạn chỉ được xem hồ sơ của chính mình
        </p>
        <Button onClick={() => navigate("/staff")} variant="outline" className="gap-2">
          <ArrowLeft className="w-4 h-4" /> Quay lại
        </Button>
      </div>
    );
  }

  if (isLoading) return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="w-8 h-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  );

  if (error || !profile) return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] gap-3">
      <AlertCircle className="w-10 h-10 text-destructive/50" />
      <p className="text-muted-foreground">Không tải được hồ sơ</p>
      <Button variant="outline" onClick={() => navigate("/staff")}>Quay lại</Button>
    </div>
  );

  const { staff, monthStats, monthJobs, todayJobs, jobHistory, earnings, rates, leaveRequests, internalNotes } = profile;
  const leaveThisMonth = (profile as any).leaveThisMonth as { used: number; cap: number } | undefined;
  // Task #477: đơn giá hậu kỳ / tấm tại component level (dùng trong castSheet)
  const psPerPhotoRow = rates.find(r => r.role === "photoshop" && r.taskKey === "mac_dinh" && r.rateType === "per_photo");
  const psPerPhotoRate = psPerPhotoRow?.rate ?? null;

  // ── Avatar helpers ─────────────────────────────────────────────────────────
  const avatarRaw = (staff as unknown as Record<string, unknown>).avatar as string | undefined;
  const avatarUrl = !imgError ? avatarRaw : undefined;
  const coverImageUrl = (staff as unknown as Record<string, unknown>).coverImageUrl as string | undefined;

  const handleAvatarClick = () => {
    if (canEdit) {
      setProfileMenuOpen(v => !v);
    } else if (avatarUrl) {
      setLightboxOpen(true);
    }
  };

  const handleCoverClick = () => {
    if (canEdit) coverFileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setProfileMenuOpen(false);
    setAvatarError("");
    if (!file.type.startsWith("image/")) {
      setAvatarError("Vui lòng chọn file ảnh");
      return;
    }
    if (file.size > 2097152) {
      setAvatarError("Ảnh quá lớn (>2MB)");
      return;
    }
    try {
      const compressed = await compressStaffAvatar(file);
      await handleAvatarUpload(compressed);
    } catch (err: unknown) {
      const msg = (err as Error)?.message || "Lỗi xử lý ảnh";
      setAvatarError(msg);
      console.error("Avatar compress error:", err);
    }
  };

  // ── Filter jobs for active stat card ──────────────────────────────────────
  const filteredJobs = activeFilter ? monthJobs.filter(j => {
    const s = (j.status || "").toLowerCase();
    if (activeFilter === "completed") return s === "completed" || s === "hoan_thanh";
    if (activeFilter === "pending") return s === "pending" || s === "confirmed";
    if (activeFilter === "in_progress") return s === "in_progress";
    if (activeFilter === "cancelled") return s === "cancelled" || s === "huy";
    return true;
  }) : [];

  const jobDetail = jobDetailId != null ? jobHistory.find(j => j.id === jobDetailId) : null;

  const rolesDisplay = [staff.role, ...(staff.roles || [])].filter((r, i, a) => a.indexOf(r) === i).filter(Boolean);

  const staffStatus = (staff as unknown as Record<string, unknown>).status as string | undefined;
  const canEdit = isAdmin || viewer?.id === staffId;

  // Status config
  const statusCfg = {
    active:    { label: "Đang làm",  cls: "bg-emerald-100 text-emerald-700" },
    probation: { label: "Thử việc",  cls: "bg-amber-100 text-amber-700" },
    inactive:  { label: "Nghỉ việc", cls: "bg-red-100 text-red-700" },
  }[staffStatus || (staff.isActive ? "active" : "inactive")] ?? { label: "Đang làm", cls: "bg-emerald-100 text-emerald-700" };

  return (
    <div className="space-y-4 pb-10">
      {/* ── Back button ─────────────────────────────────────────────────── */}
      <button
        onClick={() => navigate("/staff")}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Về danh sách nhân sự
      </button>

      {/* ── A. IDENTITY CARD ─────────────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-2xl shadow-md overflow-hidden">
        {/* Cover image – rounded top corners only */}
        <button
          type="button"
          onClick={handleCoverClick}
          disabled={!canEdit}
          className={cn(
            "block relative w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
            canEdit ? "cursor-pointer" : "cursor-default"
          )}
          aria-label={canEdit ? "Chỉnh sửa ảnh bìa" : "Ảnh bìa"}
        >
          <div
            className={cn(
              "h-[280px] sm:h-[320px] rounded-t-2xl bg-gradient-to-br overflow-hidden relative",
              COVER_GRADIENT[rolesDisplay[0]] ?? "from-primary/60 via-primary/30 to-primary/10"
            )}
          >
            {coverImageUrl && (
              <img
                src={coverImageUrl}
                alt="Cover"
                className="w-full h-full object-cover"
              />
            )}
            
            {/* Gradient overlay for text contrast */}
            {coverImageUrl && (
              <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/10" />
            )}
            
            {/* Uploading overlay */}
            {coverUploading && (
              <div className="absolute inset-0 bg-black/45 flex items-center justify-center z-20">
                <div className="w-6 h-6 border-[3px] border-white border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            
            {/* Hover edit overlay */}
            {!coverUploading && canEdit && (
              <div className="absolute inset-0 bg-black/0 hover:bg-black/25 transition-colors flex items-center justify-center group z-10">
                <Camera size={24} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            )}
          </div>
        </button>

        {/* Body */}
        <div className="px-4 sm:px-5 pb-5">
          <div className="flex items-start gap-3 sm:gap-5">

            {/* ── Avatar column ─────────────────────────────────────────── */}
            <div className="relative flex-shrink-0 -mt-20 sm:-mt-24">
              {/* Circle */}
              <button
                type="button"
                onClick={handleAvatarClick}
                disabled={!canEdit && !avatarUrl}
                className={cn(
                  "block relative focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full",
                  (canEdit || avatarUrl) ? "cursor-pointer" : "cursor-default"
                )}
                aria-label={canEdit ? "Chỉnh sửa ảnh đại diện" : "Xem ảnh đại diện"}
              >
                <div
                  className={cn(
                    "w-40 h-40 sm:w-48 sm:h-48 rounded-full overflow-hidden",
                    "ring-[4px] ring-white shadow-[0_12px_48px_rgba(0,0,0,0.25)]",
                    "border-4 border-white",
                    `bg-gradient-to-br ${AVATAR_GRADIENT[rolesDisplay[0]] ?? "from-slate-400 to-gray-500"}`
                  )}
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={staff.name}
                      className="w-full h-full object-cover"
                      onError={() => setImgError(true)}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="text-4xl sm:text-5xl font-bold text-white select-none leading-none">
                        {(staff.name || "?").trim().charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}

                  {/* Uploading overlay */}
                  {avatarUploading && (
                    <div className="absolute inset-0 bg-black/45 flex items-center justify-center">
                      <div className="w-7 h-7 border-[3px] border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}

                  {/* Hover edit/view overlay */}
                  {!avatarUploading && (canEdit || avatarUrl) && (
                    <div className="absolute inset-0 bg-black/0 hover:bg-black/25 transition-colors flex items-center justify-center group">
                      {canEdit
                        ? <Camera size={26} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                        : <X size={0} className="hidden" />
                      }
                    </div>
                  )}
                </div>

                {/* Status dot – large & prominent */}
                <span
                  className={cn(
                    "absolute bottom-1.5 right-1.5 sm:bottom-2 sm:right-2",
                    "w-5 h-5 sm:w-6 sm:h-6 rounded-full",
                    "ring-[3px] ring-white shadow-sm",
                    STATUS_DOT_CLS[staffStatus || (staff.isActive ? "active" : "inactive")] ?? STATUS_DOT_CLS.active
                  )}
                />
              </button>

              {/* Context menu */}
              {canEdit && profileMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setProfileMenuOpen(false)} />
                  <div className="absolute left-full ml-3 top-0 z-50 bg-popover border border-border rounded-xl shadow-xl p-1 min-w-[160px] animate-in fade-in-0 zoom-in-95 duration-100">
                    {avatarUrl && (
                      <button
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg hover:bg-muted transition-colors text-left"
                        onClick={() => { setLightboxOpen(true); setProfileMenuOpen(false); }}
                      >
                        <Camera size={14} className="text-primary flex-shrink-0" />
                        Xem ảnh lớn
                      </button>
                    )}
                    <button
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg hover:bg-muted transition-colors text-left"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <ImageUp size={14} className="text-primary flex-shrink-0" />
                      {avatarUrl ? "Đổi ảnh" : "Tải ảnh lên"}
                    </button>
                    {avatarUrl && (
                      <button
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg hover:bg-red-50 text-red-600 transition-colors text-left"
                        onClick={() => { handleAvatarDelete(); setProfileMenuOpen(false); }}
                      >
                        <Trash2 size={14} className="flex-shrink-0" />
                        Xóa ảnh
                      </button>
                    )}
                  </div>
                </>
              )}

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            {/* Hidden cover file input */}
            <input
              ref={coverFileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleCoverFileChange}
            />

            {/* ── Info column ───────────────────────────────────────────── */}
            <div className="flex-1 min-w-0 pt-3 sm:pt-4">
              {/* Error messages */}
              {(avatarError || coverError) && (
                <div className="mb-3 p-2.5 bg-red-50 border border-red-200 rounded-lg">
                  {avatarError && <p className="text-xs text-red-700 font-medium">{avatarError}</p>}
                  {coverError && <p className="text-xs text-red-700 font-medium">{coverError}</p>}
                </div>
              )}
              
              {/* Name + status badge */}
              <div className="flex items-start justify-between gap-2">
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight leading-tight">{staff.name}</h1>
                <span className={cn("text-xs px-2.5 py-1 rounded-full font-semibold shrink-0 mt-0.5", statusCfg.cls)}>
                  {statusCfg.label}
                </span>
              </div>

              {/* Role badges */}
              <div className="flex flex-wrap gap-1.5 mt-2">
                {rolesDisplay.map(r => (
                  <span key={r} className="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary font-medium">
                    {ROLE_ICONS[r] || "•"} {ROLE_LABELS[r] || r}
                  </span>
                ))}
              </div>

              {/* Contact info */}
              <div className="space-y-1.5 mt-3">
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{staff.phone || "—"}</span>
                </div>
                {staff.email && (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">{staff.email}</span>
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Briefcase className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{staff.staffType === "official" ? "Nhân viên chính thức" : "Freelancer / CTV"}</span>
                </div>
                {staff.joinDate && (
                  <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>Vào làm {fmtDate(staff.joinDate)}</span>
                  </div>
                )}
              </div>

              {/* Upload hint */}
              {canEdit && (
                <p className="text-[10px] text-muted-foreground mt-3 flex items-center gap-1">
                  <Camera size={10} />
                  {avatarUrl ? "Bấm ảnh để đổi hoặc xem" : "Bấm ảnh để thêm avatar"}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── D. THU NHẬP HÔM NAY ─────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-3">
        <div className="bg-gradient-to-br from-violet-500 to-violet-600 rounded-2xl p-4 text-white">
          <p className="text-xs font-medium opacity-80 mb-1">Job hôm nay</p>
          <p className="text-3xl font-bold">{todayJobs.length}</p>
          <p className="text-xs opacity-70 mt-1">lịch chụp</p>
        </div>
        <div className="bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-2xl p-4 text-white">
          <p className="text-xs font-medium opacity-80 mb-1">Thu nhập hôm nay</p>
          <p className="text-xl font-bold">{fmtVND(earnings.today)}</p>
          <p className="text-xs opacity-70 mt-1">từ job hoàn thành</p>
        </div>
      </section>

      {/* ── B. CÔNG VIỆC THÁNG NÀY ─────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <ClipboardList className="w-3.5 h-3.5" /> Công việc tháng này
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard
            label="Tổng job" value={monthStats.total} icon={<ClipboardList className="w-4 h-4" />}
            color="blue" active={activeFilter === "all"}
            onClick={() => setActiveFilter(activeFilter === "all" ? null : "all")}
          />
          <StatCard
            label="Hoàn thành" value={monthStats.completed} icon={<CheckCircle2 className="w-4 h-4" />}
            color="green" active={activeFilter === "completed"}
            onClick={() => setActiveFilter(activeFilter === "completed" ? null : "completed")}
          />
          <StatCard
            label="Chờ xử lý" value={monthStats.pending} icon={<Clock className="w-4 h-4" />}
            color="amber" active={activeFilter === "pending"}
            onClick={() => setActiveFilter(activeFilter === "pending" ? null : "pending")}
          />
          {monthStats.inProgress > 0 && (
            <StatCard
              label="Đang làm" value={monthStats.inProgress} icon={<PlayCircle className="w-4 h-4" />}
              color="violet" active={activeFilter === "in_progress"}
              onClick={() => setActiveFilter(activeFilter === "in_progress" ? null : "in_progress")}
            />
          )}
          {monthStats.cancelled > 0 && (
            <StatCard
              label="Đã hủy" value={monthStats.cancelled} icon={<XCircle className="w-4 h-4" />}
              color="red" active={activeFilter === "cancelled"}
              onClick={() => setActiveFilter(activeFilter === "cancelled" ? null : "cancelled")}
            />
          )}
        </div>

        {/* Filtered job list */}
        {activeFilter && (
          <div className="space-y-2 mt-2">
            <p className="text-xs font-medium text-muted-foreground">
              {filteredJobs.length} job {activeFilter === "all" ? "" : `– ${activeFilter === "completed" ? "Hoàn thành" : activeFilter === "pending" ? "Chờ xử lý" : activeFilter === "in_progress" ? "Đang làm" : "Đã hủy"}`}
            </p>
            {filteredJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Không có job nào</p>
            ) : filteredJobs.map(job => (
              <JobRow key={job.id} job={job} onClick={() => setJobDetailId(job.id)} />
            ))}
          </div>
        )}
      </section>

      <StaffSalaryPanel
        staffId={staffId}
        isAdmin={isAdmin}
        estimate={earnings.estimate ?? undefined}
        showCount={monthStats.total}
        selectedMonth={salaryMonth}
        selectedYear={salaryYear}
        onMonthChange={(m, y) => { setSalaryMonth(m); setSalaryYear(y); }}
      />

      {/* ── C. TIỀN LƯƠNG THÁNG NÀY ────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Banknote className="w-3.5 h-3.5" /> Chi tiết lương tháng {String(salaryMonth).padStart(2, "0")}/{salaryYear}
          </p>
          {earnings.estimate && (
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
              earnings.estimate.source === "paid_payroll"
                ? "bg-emerald-100 text-emerald-700"
                : earnings.estimate.source === "draft_payroll"
                  ? "bg-amber-100 text-amber-700"
                  : "bg-blue-100 text-blue-700"
            }`}>
              {earnings.estimate.source === "paid_payroll" ? "Đã chốt" : "Tạm tính"}
            </span>
          )}
        </div>

        {earnings.estimate ? (
          <>
            <div className="bg-gradient-to-r from-primary/5 to-primary/10 rounded-xl p-4 border border-primary/20 space-y-2">
              <div className="flex justify-between text-sm">
                <div>
                  <span className="text-muted-foreground">Lương cứng tạm tính</span>
                  {earnings.estimate.source !== "paid_payroll" && earnings.estimate.daysInMonth > 0 && (
                    <span className="text-xs text-muted-foreground ml-1">
                      ({earnings.estimate.daysAccrued}/{earnings.estimate.daysInMonth} ngày)
                    </span>
                  )}
                </div>
                <span className="font-medium">{fmtVND(earnings.estimate.baseSalaryAccrued)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <div>
                  <span className="text-muted-foreground">Tiền show</span>
                  {earnings.estimate.showItems.length > 0 && (
                    <span className="text-xs text-muted-foreground ml-1">({earnings.estimate.showItems.length} show)</span>
                  )}
                </div>
                <span className="font-medium text-emerald-700">+{fmtVND(earnings.estimate.showEarnings)}</span>
              </div>
              {(earnings.estimate.overtimePay ?? 0) > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tăng ca</span>
                  <span className="font-medium text-purple-700">+{fmtVND(earnings.estimate.overtimePay ?? 0)}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Thưởng</span>
                <span className="font-medium text-emerald-700">+{fmtVND(earnings.estimate.bonus)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Phạt</span>
                <span className="font-medium text-red-600">−{fmtVND(earnings.estimate.penalty)}</span>
              </div>
              {earnings.estimate.leaveDeduction > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Trừ nghỉ vượt phép</span>
                  <span className="font-medium text-red-600">−{fmtVND(earnings.estimate.leaveDeduction)}</span>
                </div>
              )}
              {earnings.estimate.advance > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Ứng lương</span>
                  <span className="font-medium text-red-600">−{fmtVND(earnings.estimate.advance)}</span>
                </div>
              )}
              <div className="pt-2 mt-2 border-t border-primary/20 flex justify-between items-baseline">
                <span className="text-sm font-semibold">Tổng tạm tính</span>
                <span className="text-2xl font-bold text-primary">{fmtVND(earnings.estimate.total)}</span>
              </div>
            </div>

            {earnings.estimate.showItems.length > 0 && (() => {
              const ALLOWANCE_LABELS: Record<string, string> = {
                di_xa: "Đi xa", tang_ca: "Tăng ca", xang_xe: "Xăng xe",
                gui_xe: "Gửi xe", an_uong: "Ăn uống", khac: "Phụ cấp khác",
              };
              // Task #496: nhóm theo role cho dễ đọc — Kinh doanh / Nhiếp ảnh / PTS / Makeup / Phụ cấp riêng từng khối.
              const groupKeyOf = (s: typeof earnings.estimate.showItems[number]): string => {
                if (s.rateType === "allowance") return "allowance";
                return s.role;
              };
              const GROUP_ORDER = ["sale", "photographer", "photoshop", "makeup", "other", "allowance"];
              const GROUP_META: Record<string, { label: string; icon: string; color: string }> = {
                sale: { label: "Kinh doanh", icon: "💼", color: "text-violet-700" },
                photographer: { label: "Nhiếp ảnh", icon: "📸", color: "text-blue-700" },
                photoshop: { label: "Hậu kỳ (PTS)", icon: "🖥️", color: "text-sky-700" },
                makeup: { label: "Makeup", icon: "💄", color: "text-pink-700" },
                other: { label: "Khác", icon: "•", color: "text-foreground" },
                allowance: { label: "Phụ cấp", icon: "🎁", color: "text-amber-700" },
              };
              const groups = new Map<string, typeof earnings.estimate.showItems>();
              for (const s of earnings.estimate.showItems) {
                const k = GROUP_META[groupKeyOf(s)] ? groupKeyOf(s) : "other";
                if (!groups.has(k)) groups.set(k, []);
                groups.get(k)!.push(s);
              }
              return (
                <div className="space-y-4">
                  <p className="text-xs text-muted-foreground font-medium">Chi tiết tiền show:</p>
                  {GROUP_ORDER.filter(k => groups.has(k)).map(k => {
                    const items = groups.get(k)!;
                    const meta = GROUP_META[k];
                    const subtotal = items.reduce((s, it) => s + (it.rate || 0), 0);
                    const isAllowanceGroup = k === "allowance";
                    const isSaleGroup = k === "sale";
                    // Task #499: tổng "Còn treo" cho group Kinh doanh (preview, không cộng vào lương).
                    const saleRemainingTotal = isSaleGroup
                      ? items.reduce((s, it) => s + (it.remainingAmount ?? 0), 0)
                      : 0;
                    return (
                      <div key={k} className="space-y-1">
                        <div className={`flex items-start justify-between text-xs font-bold ${meta.color}`}>
                          <span className="flex items-center gap-1.5">
                            <span>{meta.icon}</span>
                            <span>{meta.label}</span>
                            <span className="text-[10px] font-normal text-muted-foreground">({items.length})</span>
                          </span>
                          {isSaleGroup ? (
                            <div className="text-right space-y-0.5">
                              <div className="tabular-nums">Đã thu: {fmtVND(subtotal)}</div>
                              {saleRemainingTotal > 0 && (
                                <div className="text-[11px] font-normal text-muted-foreground tabular-nums">
                                  Còn treo: {fmtVND(saleRemainingTotal)}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="tabular-nums">{fmtVND(subtotal)}</span>
                          )}
                        </div>
                        <div className="pl-4 border-l-2 border-muted/60">
                          {items.map((s, idx) => {
                            const isAllowance = s.rateType === "allowance";
                            const isSalePercent = s.role === "sale" && s.rateType === "percent"
                              && typeof s.percentRate === "number" && typeof s.collectedBase === "number";
                            const hasRemaining = isSalePercent
                              && typeof s.remainingAmount === "number" && s.remainingAmount > 0
                              && typeof s.remainingBase === "number";
                            return (
                              <div key={`${s.bookingId}-${s.role}-${s.taskKey}-${idx}`}
                                   className={`py-1.5 border-b border-border/30 last:border-0 ${isAllowanceGroup ? "bg-amber-50/40 rounded px-1.5" : ""}`}>
                                <div className="flex items-center justify-between text-sm">
                                  <div className="min-w-0">
                                    <span className="font-medium">{s.serviceName}</span>
                                    <span className="text-xs text-muted-foreground ml-2">
                                      {isAllowance
                                        ? `Phụ cấp ${ALLOWANCE_LABELS[s.allowanceType ?? ""] || s.allowanceType}`
                                        : s.shootDate
                                      }
                                    </span>
                                    {isAllowance && s.allowanceNote && (
                                      <span className="text-xs text-amber-700 ml-1">— {s.allowanceNote}</span>
                                    )}
                                  </div>
                                  <span className={`font-semibold tabular-nums ${isAllowance ? "text-amber-700" : "text-primary"}`}>{fmtVND(s.rate)}</span>
                                </div>
                                {isSalePercent && (
                                  <div className="mt-1 space-y-0.5 text-[11px] leading-tight">
                                    <div className="flex items-center justify-between text-violet-700">
                                      <span>Đã thu: {s.percentRate}% × {fmtVND(s.collectedBase!)}</span>
                                      <span className="tabular-nums font-medium">{fmtVND(s.collectedAmount ?? s.rate)}</span>
                                    </div>
                                    {hasRemaining && (
                                      <div className="flex items-center justify-between text-muted-foreground">
                                        <span>Còn treo: {s.percentRate}% × {fmtVND(s.remainingBase!)}</span>
                                        <span className="tabular-nums">{fmtVND(s.remainingAmount!)}</span>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {earnings.estimate.source !== "paid_payroll" && earnings.estimate.showItems.length === 0 && earnings.estimate.baseSalaryAccrued === 0 && (
              <p className="text-sm text-muted-foreground text-center py-2">Chưa có lương phát sinh tháng này</p>
            )}

            {/* Dự kiến lương cuối tháng — admin-only forecast (không ghi payroll) */}
            {isAdmin && earnings.estimate.forecastTotal != null && (
              <div className={`rounded-xl p-4 border-2 space-y-2 ${
                earnings.estimate.forecastTotal > 20_000_000
                  ? "bg-red-50 border-red-300"
                  : earnings.estimate.forecastTotal > 15_000_000
                    ? "bg-orange-50 border-orange-300"
                    : "bg-slate-50 border-slate-200"
              }`}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Dự kiến lương cuối tháng (admin)
                  </p>
                  {earnings.estimate.forecastTotal > 20_000_000 ? (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-600 text-white">
                      Cần cân đối lại lịch giao show
                    </span>
                  ) : earnings.estimate.forecastTotal > 15_000_000 ? (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-500 text-white">
                      Lương dự kiến cao
                    </span>
                  ) : null}
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Lương cứng cả tháng</span>
                  <span className="font-medium">{fmtVND(earnings.estimate.forecastBaseSalary ?? 0)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <div>
                    <span className="text-muted-foreground">Tiền show cả tháng</span>
                    {(earnings.estimate.forecastShowCount ?? 0) > 0 && (
                      <span className="text-xs text-muted-foreground ml-1">
                        ({earnings.estimate.forecastPastCount ?? 0} đã/{earnings.estimate.forecastFutureCount ?? 0} sắp)
                      </span>
                    )}
                  </div>
                  <span className="font-medium text-emerald-700">+{fmtVND(earnings.estimate.forecastShowEarnings ?? 0)}</span>
                </div>
                {earnings.estimate.bonus > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Thưởng</span>
                    <span className="font-medium text-emerald-700">+{fmtVND(earnings.estimate.bonus)}</span>
                  </div>
                )}
                {earnings.estimate.penalty > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Phạt</span>
                    <span className="font-medium text-red-600">−{fmtVND(earnings.estimate.penalty)}</span>
                  </div>
                )}
                {earnings.estimate.leaveDeduction > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Trừ nghỉ vượt phép</span>
                    <span className="font-medium text-red-600">−{fmtVND(earnings.estimate.leaveDeduction)}</span>
                  </div>
                )}
                <div className="pt-2 mt-2 border-t border-slate-300 flex justify-between items-baseline">
                  <span className="text-sm font-semibold">Tổng dự kiến cuối tháng</span>
                  <span className={`text-2xl font-bold ${
                    earnings.estimate.forecastTotal > 20_000_000 ? "text-red-700"
                      : earnings.estimate.forecastTotal > 15_000_000 ? "text-orange-700"
                      : "text-slate-800"
                  }`}>
                    {fmtVND(earnings.estimate.forecastTotal)}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground italic">
                  Dự báo nội bộ — không ghi payroll. Bao gồm cả show đã giao trong tương lai.
                </p>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-2">Không tính được tạm tính</p>
        )}

        {/* Lịch sử earnings đã ghi nhận (cho payroll/audit) */}
        {earnings.records.length > 0 && (
          <div className="space-y-1.5 pt-3 border-t border-border">
            <p className="text-xs text-muted-foreground font-medium">Lương đã ghi nhận theo job (payroll):</p>
            {earnings.records.map(e => (
              <div key={e.id} className="flex items-center justify-between text-sm py-1.5 border-b border-border/40 last:border-0">
                <div>
                  <span className="font-medium">{e.serviceName || "Job"}</span>
                  <span className="text-xs text-muted-foreground ml-2">{ROLE_LABELS[e.role] || e.role}</span>
                </div>
                <span className="font-semibold text-primary">{fmtVND(e.rate)}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── D. CHẤM CÔNG THÁNG NÀY ─────────────────────────────────────── */}
      <StaffAttendanceBlock staffId={staffId} isAdmin={isAdmin} />

      {/* ── E. LỊCH SỬ CÔNG VIỆC ────────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" /> Lịch sử công việc
          </p>
          <span className="text-xs text-muted-foreground">{jobHistory.length} job</span>
        </div>
        {jobHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">Chưa có job nào</p>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {jobHistory.map(job => (
              <JobRow key={job.id} job={job} onClick={() => setJobDetailId(job.id)} />
            ))}
          </div>
        )}
      </section>

      {/* ── F. ĐƠN XIN NGHỈ ─────────────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-2xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <CalendarOff className="w-3.5 h-3.5" /> Đơn xin nghỉ
          </p>
          <button
            onClick={() => setLeaveSheet(true)}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-primary/10 text-primary font-medium hover:bg-primary/20 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Tạo đơn
          </button>
        </div>
        {leaveThisMonth && (
          <div className="rounded-xl border bg-amber-50 border-amber-200 p-3 text-sm">
            Nghỉ phép tháng này: <strong>{leaveThisMonth.used}/{leaveThisMonth.cap} ngày</strong>
            {leaveThisMonth.used > leaveThisMonth.cap && (
              <span className="text-red-600 ml-2">(vượt {leaveThisMonth.used - leaveThisMonth.cap} ngày — sẽ trừ lương theo công thức lương ngày)</span>
            )}
          </div>
        )}
        {leaveRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">Chưa có đơn xin nghỉ nào</p>
        ) : (
          <div className="space-y-2.5">
            {leaveRequests.map(lr => (
              <div key={lr.id} className="border border-border rounded-xl p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{fmtDate(lr.startDate)} → {fmtDate(lr.endDate)}</p>
                    <p className="text-xs text-muted-foreground">{lr.reason}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className={cn("text-[10px] px-2 py-0.5 rounded-full font-semibold", LEAVE_STATUS_COLORS[lr.status])}>
                      {LEAVE_STATUS_LABELS[lr.status] ?? lr.status}
                    </span>
                    {isAdmin && lr.status === "pending" && (
                      <button
                        onClick={() => setApproveDialog(lr)}
                        className="text-[10px] text-primary underline"
                      >
                        Xét duyệt
                      </button>
                    )}
                  </div>
                </div>
                {lr.approvedByName && (
                  <p className="text-[10px] text-muted-foreground">
                    {lr.status === "approved" ? "✅ Duyệt bởi: " : "❌ Từ chối bởi: "}{lr.approvedByName}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── G. BẢNG GIÁ CÁ NHÂN ────────────────────────────────────────── */}
      <section className="bg-card border border-border rounded-2xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5" /> Bảng cast chính thức
          </p>
          <button
            onClick={() => setCastSheet(true)}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 font-medium hover:bg-emerald-100 transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" /> {isAdmin ? "Chỉnh sửa" : "Xem chi tiết"}
          </button>
        </div>
        {(() => {
          // Cast rates per-package (new system: staff_cast_rates × service_packages)
          const castByRole = castRates.reduce((acc, c) => {
            if (!acc[c.role]) acc[c.role] = new Map();
            acc[c.role].set(c.packageId, c);
            return acc;
          }, {} as Record<string, Map<number, CastRate>>);

          // Sale rows still come from staff_rate_prices (KPI/hoa hồng)
          const saleRows = rates.filter(r => r.role === "sale");
          // psPerPhotoRow / psPerPhotoRate computed at component level (Task #477)
          const hasAnyCast = castRates.some(c => c.amount !== null && c.amount !== undefined && Number(c.amount) > 0);
          const hasAnySale = saleRows.length > 0;

          if (!hasAnyCast && !hasAnySale && psPerPhotoRate === null && !isAdmin) {
            return <p className="text-sm text-muted-foreground text-center py-4">Chưa có bảng cast nào</p>;
          }

          const renderPkgRow = (pkg: ServicePackageBrief, c: CastRate | undefined) => {
            const amt = c?.amount !== null && c?.amount !== undefined ? Number(c.amount) : null;
            return (
              <div key={pkg.id} className="py-1.5 border-b border-border/30 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-sm text-foreground/85 truncate">{pkg.name}</span>
                    <span className="text-[11px] text-muted-foreground ml-1.5">({pkg.code})</span>
                  </div>
                  <span className={`text-sm font-semibold tabular-nums flex-shrink-0 ${
                    amt !== null && amt > 0 ? "text-emerald-700" : "text-muted-foreground/50"
                  }`}>{amt !== null && amt > 0 ? fmtVND(amt) : "—"}</span>
                </div>
              </div>
            );
          };

          return (
            <div className="space-y-5">
              {/* Task #476: Đơn giá hậu kỳ / ảnh (staff_rate_prices, per_photo) */}
              {(psPerPhotoRate !== null || isAdmin) && (
                <div>
                  <p className="text-xs font-bold text-muted-foreground mb-2 flex items-center gap-1.5">
                    <span>🖥️</span>
                    <span>Đơn giá hậu kỳ / ảnh</span>
                  </p>
                  <div className="py-1.5 border-b border-border/30">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-foreground/85">Mặc định / tấm</span>
                      {isAdmin && psPerPhotoEdit !== null ? (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <input
                            type="text"
                            inputMode="numeric"
                            autoFocus
                            placeholder="VD: 12000"
                            className="w-32 h-8 text-sm border border-input rounded-lg px-2 text-right bg-background"
                            value={psPerPhotoEdit ? Number(psPerPhotoEdit).toLocaleString("vi-VN") : ""}
                            onChange={e => setPsPerPhotoEdit(e.target.value.replace(/\D/g, ""))}
                          />
                          <button
                            onClick={() => savePsPerPhoto(psPerPhotoEdit ?? "")}
                            disabled={psPerPhotoSaving}
                            className="text-xs px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold disabled:opacity-50"
                          >✓</button>
                          <button
                            onClick={() => setPsPerPhotoEdit(null)}
                            className="text-xs px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground"
                          >✕</button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`text-sm font-semibold tabular-nums ${psPerPhotoRate !== null ? "text-sky-600" : "text-muted-foreground/50"}`}>
                            {psPerPhotoRate !== null ? `${fmtVND(psPerPhotoRate)} / tấm` : "— (fallback rate trên job)"}
                          </span>
                          {isAdmin && (
                            <button
                              onClick={() => setPsPerPhotoEdit(psPerPhotoRate !== null ? String(psPerPhotoRate) : "")}
                              className="p-1.5 rounded-lg hover:bg-muted"
                            ><Pencil className="w-3.5 h-3.5 text-muted-foreground" /></button>
                          )}
                        </div>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">
                      Dùng khi job hậu kỳ chuyển "Xong show". Để trống → dùng rate snapshot trên job.
                    </p>
                  </div>
                </div>
              )}

              {/* Nhiếp ảnh / PTS / Makeup — per-package cast (staff_cast_rates).
                  Task #496: collapse/expand per role để gọn (mỗi role có thể tới 56 gói). */}
              {(["photographer", "photoshop", "makeup"] as const).map(role => {
                const pkgMap = castByRole[role];
                const configured = allPackages.filter(p => {
                  const c = pkgMap?.get(p.id);
                  return c && c.amount !== null && c.amount !== undefined && Number(c.amount) > 0;
                });
                if (configured.length === 0) return null;
                const isOpen = castOpenRoles.has(role);
                return (
                  <div key={role}>
                    <button
                      type="button"
                      onClick={() => toggleCastRole(role)}
                      className="w-full text-xs font-bold text-muted-foreground mb-2 flex items-center gap-1.5 hover:text-foreground transition-colors"
                      aria-expanded={isOpen}
                    >
                      <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                      <span>{ROLE_ICONS[role] || "•"}</span>
                      <span>{ROLE_LABELS[role] || role}</span>
                      <span className="ml-1 text-[10px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded font-semibold">
                        {configured.length}/{allPackages.length} gói
                      </span>
                      {!isOpen && (
                        <span className="ml-auto text-[10px] text-muted-foreground/70 font-normal">Bấm để xem</span>
                      )}
                    </button>
                    {isOpen && (
                      <div>{configured.map(pkg => renderPkgRow(pkg, pkgMap?.get(pkg.id)))}</div>
                    )}
                  </div>
                );
              })}

              {/* Sale per-package commission %: collapse luôn để gọn */}
              {(() => {
                const role = "sale" as const;
                const pkgMap = castByRole[role];
                const configured = allPackages.filter(p => {
                  const c = pkgMap?.get(p.id);
                  return c && c.amount !== null && c.amount !== undefined && Number(c.amount) > 0;
                });
                if (configured.length === 0) return null;
                const isOpen = castOpenRoles.has(role);
                return (
                  <div>
                    <button
                      type="button"
                      onClick={() => toggleCastRole(role)}
                      className="w-full text-xs font-bold text-muted-foreground mb-2 flex items-center gap-1.5 hover:text-foreground transition-colors"
                      aria-expanded={isOpen}
                    >
                      <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                      <span>{ROLE_ICONS.sale || "💼"}</span>
                      <span>Hoa hồng sale theo gói</span>
                      <span className="ml-1 text-[10px] text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded font-semibold">
                        {configured.length}/{allPackages.length} gói · %
                      </span>
                      {!isOpen && (
                        <span className="ml-auto text-[10px] text-muted-foreground/70 font-normal">Bấm để xem</span>
                      )}
                    </button>
                    {isOpen && (
                      <div>
                        {configured.map(pkg => {
                          const c = pkgMap?.get(pkg.id);
                          const amt = c?.amount !== null && c?.amount !== undefined ? Number(c.amount) : null;
                          return (
                            <div key={pkg.id} className="py-1.5 border-b border-border/30 last:border-0">
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <span className="text-sm text-foreground/85 truncate">{pkg.name}</span>
                                  <span className="text-[11px] text-muted-foreground ml-1.5">({pkg.code})</span>
                                </div>
                                <span className="text-sm font-semibold tabular-nums flex-shrink-0 text-violet-600">
                                  {amt !== null && amt > 0 ? `${amt}%` : "—"}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Sale: KPI thưởng + Hoa hồng (vẫn từ staff_rate_prices) */}
              {saleRows.length > 0 && (() => {
                const renderRateRow = (r: RateEntry) => (
                  <div key={r.id} className="py-1.5 border-b border-border/30 last:border-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm text-foreground/85">{r.taskName}</span>
                      <span className={`text-sm font-semibold tabular-nums flex-shrink-0 ${
                        r.rateType === "percent" ? "text-violet-600" :
                        r.rateType === "per_photo" ? "text-sky-600" :
                        "text-emerald-700"
                      }`}>{
                        r.rate === null || r.rate === undefined ? "—" :
                        r.rateType === "percent" ? `${r.rate}%` :
                        r.rateType === "per_photo" ? `${fmtVND(r.rate)} / tấm` :
                        fmtVND(r.rate)
                      }</span>
                    </div>
                    {r.notes && (
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{r.notes}</p>
                    )}
                  </div>
                );
                const kpiRows = saleRows.filter(r => r.taskKey.startsWith("kpi_"));
                const commRows = saleRows.filter(r => r.taskKey.startsWith("hoa_hong_"));
                const otherSale = saleRows.filter(r => !r.taskKey.startsWith("kpi_") && !r.taskKey.startsWith("hoa_hong_"));
                return (
                  <div className="space-y-4">
                    {otherSale.length > 0 && (
                      <div>
                        <p className="text-xs font-bold text-muted-foreground mb-2">{ROLE_ICONS.sale} {ROLE_LABELS.sale}</p>
                        <div>{otherSale.map(renderRateRow)}</div>
                      </div>
                    )}
                    {kpiRows.length > 0 && (
                      <div>
                        <p className="text-xs font-bold text-amber-600 mb-2 flex items-center gap-1.5">
                          🏆 Thưởng KPI doanh số
                        </p>
                        <div className="bg-amber-50 dark:bg-amber-950/20 rounded-xl px-3">
                          {kpiRows.map(r => (
                            <div key={r.id} className="py-2 border-b border-amber-100 dark:border-amber-900 last:border-0">
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">{r.taskName}</p>
                                  {r.notes && <p className="text-[11px] text-amber-600/80">{r.notes}</p>}
                                </div>
                                <span className="text-sm font-bold text-amber-700 dark:text-amber-300 tabular-nums">{fmtVND(r.rate ?? 0)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {commRows.length > 0 && (
                      <div>
                        <p className="text-xs font-bold text-violet-600 mb-2 flex items-center gap-1.5">
                          💼 Hoa hồng sale
                        </p>
                        <div className="bg-violet-50 dark:bg-violet-950/20 rounded-xl px-3">
                          {commRows.map(r => (
                            <div key={r.id} className="py-2 border-b border-violet-100 dark:border-violet-900 last:border-0">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex-1">
                                  <p className="text-sm font-medium text-violet-800 dark:text-violet-200">{r.taskName}</p>
                                  {r.notes && <p className="text-[11px] text-violet-500/80 leading-tight">{r.notes}</p>}
                                </div>
                                <span className="text-sm font-bold text-violet-700 dark:text-violet-300 tabular-nums flex-shrink-0">{r.rate}%</span>
                              </div>
                            </div>
                          ))}
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-2">
                          ⚠️ Beauty không tính %. Không tính trùng nhiều loại % trên cùng 1 đơn.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })()}
      </section>

      {/* ── H. GHI CHÚ NỘI BỘ (Admin only) ────────────────────────────── */}
      {isAdmin && (
        <section className="bg-card border border-border rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-violet-500" />
              <span className="text-violet-600">Ghi chú nội bộ</span>
              <span className="text-[9px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded font-bold">ADMIN</span>
            </p>
            <button
              onClick={() => {
                setNotesForm(internalNotes ?? {});
                setNotesSheet(true);
              }}
              className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-violet-50 text-violet-700 font-medium hover:bg-violet-100 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" /> Chỉnh sửa
            </button>
          </div>
          {internalNotes ? (
            <div className="space-y-3">
              {internalNotes.skillsStrong && (
                <NoteBlock label="Kỹ năng mạnh" value={internalNotes.skillsStrong} />
              )}
              {internalNotes.workNotes && (
                <NoteBlock label="Lưu ý làm việc" value={internalNotes.workNotes} />
              )}
              {internalNotes.internalRating && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Đánh giá nội bộ</p>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map(s => (
                      <Star key={s} className={cn("w-5 h-5", s <= internalNotes.internalRating! ? "text-amber-400 fill-amber-400" : "text-muted-foreground/30")} />
                    ))}
                  </div>
                </div>
              )}
              {internalNotes.generalNotes && (
                <NoteBlock label="Ghi chú chung" value={internalNotes.generalNotes} />
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">Chưa có ghi chú nội bộ nào</p>
          )}
        </section>
      )}

      {/* ══ Sheets & Dialogs ══════════════════════════════════════════════════ */}

      {/* Tạo đơn xin nghỉ */}
      <Sheet open={leaveSheet} onOpenChange={setLeaveSheet}>
        <SheetContent side="bottom" className="rounded-t-3xl max-h-[90vh] overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle>Tạo đơn xin nghỉ</SheetTitle>
          </SheetHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Ngày bắt đầu</Label>
                <DateInput value={leaveForm.startDate} onChange={v => setLeaveForm(f => ({ ...f, startDate: v }))} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Ngày kết thúc</Label>
                <DateInput value={leaveForm.endDate} onChange={v => setLeaveForm(f => ({ ...f, endDate: v }))} className="mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-xs">Lý do xin nghỉ *</Label>
              <Textarea rows={3} placeholder="Nhập lý do..." value={leaveForm.reason} onChange={e => setLeaveForm(f => ({ ...f, reason: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Ghi chú thêm</Label>
              <Textarea rows={2} placeholder="(tuỳ chọn)" value={leaveForm.notes} onChange={e => setLeaveForm(f => ({ ...f, notes: e.target.value }))} className="mt-1" />
            </div>
            <Button
              className="w-full"
              disabled={!leaveForm.startDate || !leaveForm.endDate || !leaveForm.reason.trim() || createLeave.isPending}
              onClick={() => createLeave.mutate(leaveForm)}
            >
              {createLeave.isPending ? "Đang gửi..." : "Gửi đơn xin nghỉ"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Xét duyệt đơn (Admin) */}
      <Dialog open={!!approveDialog} onOpenChange={() => setApproveDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Xét duyệt đơn xin nghỉ</DialogTitle>
          </DialogHeader>
          {approveDialog && (
            <div className="space-y-4">
              <div className="bg-muted/30 rounded-xl p-3 space-y-1">
                <p className="text-sm font-medium">{fmtDate(approveDialog.startDate)} → {fmtDate(approveDialog.endDate)}</p>
                <p className="text-sm text-muted-foreground">{approveDialog.reason}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline" className="flex-1 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                  disabled={updateLeave.isPending}
                  onClick={() => updateLeave.mutate({ leaveId: approveDialog.id, status: "approved", approvedByName: viewer?.name })}
                >
                  ✅ Duyệt
                </Button>
                <Button
                  variant="outline" className="flex-1 text-red-700 border-red-200 hover:bg-red-50"
                  disabled={updateLeave.isPending}
                  onClick={() => updateLeave.mutate({ leaveId: approveDialog.id, status: "rejected", approvedByName: viewer?.name })}
                >
                  ❌ Từ chối
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Ghi chú nội bộ (Admin) */}
      <Sheet open={notesSheet} onOpenChange={setNotesSheet}>
        <SheetContent side="bottom" className="rounded-t-3xl max-h-[90vh] overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle>Ghi chú nội bộ — {staff.name}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Kỹ năng mạnh</Label>
              <Textarea rows={2} placeholder="Ví dụ: Chụp phóng sự đám cưới, makeup tân cô dâu..." value={notesForm.skillsStrong ?? ""} onChange={e => setNotesForm(f => ({ ...f, skillsStrong: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Lưu ý làm việc</Label>
              <Textarea rows={2} placeholder="Ví dụ: Cần nhắc nhở đúng giờ, không làm việc nhóm tốt..." value={notesForm.workNotes ?? ""} onChange={e => setNotesForm(f => ({ ...f, workNotes: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Đánh giá nội bộ (1–5 sao)</Label>
              <div className="flex gap-2 mt-2">
                {[1, 2, 3, 4, 5].map(s => (
                  <button key={s} type="button" onClick={() => setNotesForm(f => ({ ...f, internalRating: s }))}>
                    <Star className={cn("w-7 h-7 transition-colors", s <= (notesForm.internalRating ?? 0) ? "text-amber-400 fill-amber-400" : "text-muted-foreground/30 hover:text-amber-300")} />
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs">Ghi chú chung</Label>
              <Textarea rows={3} placeholder="Ghi chú khác..." value={notesForm.generalNotes ?? ""} onChange={e => setNotesForm(f => ({ ...f, generalNotes: e.target.value }))} className="mt-1" />
            </div>
            <Button
              className="w-full"
              disabled={saveNotes.isPending}
              onClick={() => saveNotes.mutate(notesForm)}
            >
              {saveNotes.isPending ? "Đang lưu..." : "Lưu ghi chú"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Cast Sheet (Admin) ─────────────────────────────────────────── */}
      <Sheet open={castSheet} onOpenChange={open => { setCastSheet(open); if (!open) setCastPkgEdits({}); }}>
        <SheetContent side="bottom" className="rounded-t-3xl max-h-[94vh] overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle>Bảng Cast theo Gói — {staff.name}</SheetTitle>
          </SheetHeader>

          {/* Role tabs */}
          <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
            {[
              { value: "photographer", label: "📷 Nhiếp ảnh" },
              { value: "makeup", label: "💄 Makeup" },
              { value: "photoshop", label: "🖥️ PTS" },
            ].map(r => (
              <button
                key={r.value}
                onClick={() => { setCastNewRole(r.value); setCastPkgEdits({}); }}
                className={cn(
                  "shrink-0 text-sm px-4 py-1.5 rounded-full border font-medium transition-colors",
                  castNewRole === r.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted/40 text-muted-foreground border-transparent hover:border-border"
                )}
              >{r.label}</button>
            ))}
          </div>

          {/* Task #477: Đơn giá hậu kỳ / tấm — chỉ hiện khi tab PTS */}
          {castNewRole === "photoshop" && isAdmin && (
            <div className="mb-4 bg-sky-50 border border-sky-200 rounded-xl px-4 py-3">
              <p className="text-xs font-bold text-sky-700 mb-2 flex items-center gap-1.5">
                <span>🖥️</span> Đơn giá hậu kỳ / tấm (mặc định)
              </p>
              <div className="flex items-center gap-2">
                {psSheetEditing ? (
                  <>
                    <input
                      type="text"
                      inputMode="numeric"
                      autoFocus
                      placeholder="VD: 12000"
                      className="flex-1 h-9 text-sm border border-input rounded-lg px-3 text-right bg-background"
                      value={psSheetEdit ? Number(psSheetEdit).toLocaleString("vi-VN") : ""}
                      onChange={e => setPsSheetEdit(e.target.value.replace(/\D/g, ""))}
                      onKeyDown={async e => {
                        if (e.key === "Enter") {
                          await savePsPerPhoto(psSheetEdit);
                          setPsSheetEditing(false);
                        }
                        if (e.key === "Escape") setPsSheetEditing(false);
                      }}
                    />
                    <button
                      onClick={async () => { await savePsPerPhoto(psSheetEdit); setPsSheetEditing(false); }}
                      disabled={psPerPhotoSaving}
                      className="h-9 text-sm px-3 rounded-lg bg-primary text-primary-foreground font-semibold disabled:opacity-50"
                    >✓ Lưu</button>
                    <button
                      onClick={() => setPsSheetEditing(false)}
                      className="h-9 text-sm px-3 rounded-lg bg-muted text-muted-foreground"
                    >Huỷ</button>
                  </>
                ) : (
                  <>
                    <span className={`flex-1 text-sm font-semibold tabular-nums ${psPerPhotoRate !== null ? "text-sky-700" : "text-muted-foreground/60"}`}>
                      {psPerPhotoRate !== null ? `${psPerPhotoRate.toLocaleString("vi-VN")}đ / tấm` : "Chưa đặt — dùng fallback 12.000đ"}
                    </span>
                    <button
                      onClick={() => { setPsSheetEdit(psPerPhotoRate !== null ? String(psPerPhotoRate) : ""); setPsSheetEditing(true); }}
                      className="h-9 text-sm px-3 rounded-lg border border-sky-300 bg-white text-sky-700 font-medium hover:bg-sky-50 flex items-center gap-1.5"
                    >
                      <Pencil className="w-3.5 h-3.5" /> Đặt đơn giá
                    </button>
                  </>
                )}
              </div>
              <p className="text-[11px] text-sky-600/70 mt-1.5 leading-tight">
                Dùng khi chốt "Xong show" cho job hậu kỳ. Để trống → fallback về đơn giá trên job (hoặc 12.000đ).
              </p>
            </div>
          )}

          {/* Package list */}
          <div className="space-y-2 pb-24">
            {allPackages.length === 0 && (
              <p className="text-sm text-muted-foreground italic text-center py-8">Chưa có gói dịch vụ nào</p>
            )}
            {allPackages.map(pkg => {
              const saved = castRates.find(c => c.role === castNewRole && c.packageId === pkg.id);
              const editing = pkg.id in castPkgEdits;
              const editVal = castPkgEdits[pkg.id] ?? "";
              const displayAmt = saved?.amount !== null && saved?.amount !== undefined ? saved.amount : null;

              return (
                <div key={pkg.id} className="flex items-center gap-3 bg-muted/30 rounded-xl px-4 py-2.5">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{pkg.name}</p>
                    <p className="text-[11px] text-muted-foreground">{pkg.code} · {pkg.price.toLocaleString("vi-VN")}đ</p>
                  </div>
                  {isAdmin && editing ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <input
                        type="text"
                        inputMode="numeric"
                        autoFocus
                        placeholder="Số tiền..."
                        className="w-28 h-8 text-sm border border-input rounded-lg px-2 text-right bg-background"
                        value={editVal ? Number(editVal).toLocaleString("vi-VN") : ""}
                        onChange={e => {
                          const raw = e.target.value.replace(/\D/g, "");
                          setCastPkgEdits(prev => ({ ...prev, [pkg.id]: raw }));
                        }}
                      />
                      <button
                        onClick={() => saveCastBulk(castNewRole, { [pkg.id]: editVal })}
                        disabled={castSaving}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold disabled:opacity-50"
                      >✓</button>
                      <button
                        onClick={() => setCastPkgEdits(prev => { const n = { ...prev }; delete n[pkg.id]; return n; })}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground"
                      >✕</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={cn(
                        "text-sm font-semibold tabular-nums min-w-[4.5rem] text-right",
                        displayAmt !== null ? "text-emerald-700" : "text-muted-foreground/50"
                      )}>
                        {displayAmt !== null ? displayAmt.toLocaleString("vi-VN") + "đ" : "—"}
                      </span>
                      {isAdmin && (
                        <>
                          <button
                            onClick={() => setCastPkgEdits(prev => ({ ...prev, [pkg.id]: displayAmt !== null ? String(displayAmt) : "" }))}
                            className="p-1.5 rounded-lg hover:bg-muted"
                          ><Pencil className="w-3.5 h-3.5 text-muted-foreground" /></button>
                          {saved && (
                            <button
                              onClick={() => { if (confirm("Xoá cast này?")) deleteCastRate.mutate(saved.id); }}
                              className="p-1.5 rounded-lg hover:bg-destructive/10"
                            ><Trash2 className="w-3.5 h-3.5 text-destructive/60" /></button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Summary footer */}
          <div className="fixed bottom-0 left-0 right-0 bg-background border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground text-center">
              Đã thiết lập: <span className="font-semibold text-foreground">
                {castRates.filter(c => c.role === castNewRole && c.amount !== null).length}
              </span> / {allPackages.length} gói
            </p>
          </div>
        </SheetContent>
      </Sheet>

      {/* Chi tiết job */}
      <Sheet open={!!jobDetailId} onOpenChange={v => !v && setJobDetailId(null)}>
        <SheetContent side="bottom" className="rounded-t-3xl">
          <SheetHeader className="mb-4">
            <SheetTitle>Chi tiết job</SheetTitle>
          </SheetHeader>
          {jobDetail && (
            <div className="space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-semibold">{jobDetail.customerName}</p>
                  {jobDetail.customerPhone && <p className="text-sm text-muted-foreground">{jobDetail.customerPhone}</p>}
                </div>
                <span className={cn("text-xs px-2.5 py-1 rounded-full border font-medium", STATUS_COLORS[jobDetail.status] ?? "bg-muted text-muted-foreground")}>
                  {STATUS_LABELS[jobDetail.status] ?? jobDetail.status}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Ngày chụp</p>
                  <p className="font-medium">{fmtDate(jobDetail.shootDate)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Dịch vụ</p>
                  <p className="font-medium">{jobDetail.serviceLabel || jobDetail.packageType || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Vai trò</p>
                  <p className="font-medium">{jobDetail.roles.map(r => ROLE_LABELS[r] || r).join(", ") || "—"}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Tổng đơn</p>
                  <p className="font-medium">{fmtVND(jobDetail.totalAmount)}</p>
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Lightbox (xem ảnh đại diện) ─────────────────────────────────── */}
      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="max-w-xs sm:max-w-sm p-3 gap-0">
          <div className="relative">
            {avatarUrl && (
              <img
                src={avatarUrl}
                alt={staff.name}
                className="w-full rounded-2xl object-cover shadow-lg"
              />
            )}
            <div className="absolute top-2 right-2">
              <button
                onClick={() => setLightboxOpen(false)}
                className="bg-black/50 text-white rounded-full p-1 hover:bg-black/70 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="absolute bottom-0 left-0 right-0 rounded-b-2xl bg-gradient-to-t from-black/60 to-transparent px-4 py-3">
              <p className="text-white font-semibold text-sm">{staff.name}</p>
              <p className="text-white/70 text-xs">{rolesDisplay.map(r => ROLE_LABELS[r] || r).join(" · ")}</p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground flex items-center gap-1">{icon} {label}</p>
      <p className="text-sm font-medium truncate">{value || "—"}</p>
    </div>
  );
}

function StatCard({
  label, value, icon, color, active, onClick,
}: {
  label: string; value: number; icon: React.ReactNode;
  color: "blue" | "green" | "amber" | "violet" | "red";
  active: boolean; onClick: () => void;
}) {
  const colors = {
    blue: "bg-blue-50 border-blue-200 text-blue-700",
    green: "bg-emerald-50 border-emerald-200 text-emerald-700",
    amber: "bg-amber-50 border-amber-200 text-amber-700",
    violet: "bg-violet-50 border-violet-200 text-violet-700",
    red: "bg-red-50 border-red-200 text-red-700",
  };
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col gap-1.5 p-3 rounded-xl border transition-all text-left",
        colors[color],
        active ? "ring-2 ring-current ring-offset-1 shadow-sm" : "hover:opacity-90"
      )}
    >
      <div className="flex items-center justify-between">
        {icon}
        <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", active ? "rotate-90" : "")} />
      </div>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-[10px] font-medium opacity-80">{label}</p>
    </button>
  );
}

function JobRow({ job, onClick }: { job: JobEntry; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:bg-muted/30 transition-colors text-left"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{job.customerName}</p>
          <span className={cn("text-[10px] px-2 py-0.5 rounded-full border font-medium flex-shrink-0", STATUS_COLORS[job.status] ?? "bg-muted text-muted-foreground border-border")}>
            {STATUS_LABELS[job.status] ?? job.status}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">{fmtDate(job.shootDate)}</span>
          <span className="text-xs text-muted-foreground">•</span>
          <span className="text-xs text-muted-foreground truncate">{job.serviceLabel || job.packageType || "—"}</span>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <p className="text-xs text-muted-foreground">{job.roles.map(r => ROLE_LABELS[r] || r).join(", ")}</p>
        <ChevronRight className="w-4 h-4 text-muted-foreground mt-1 ml-auto" />
      </div>
    </button>
  );
}

function NoteBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-sm bg-muted/30 rounded-lg p-2.5">{value}</p>
    </div>
  );
}

const fmtVNDLocal = (n: number) => new Intl.NumberFormat("vi-VN").format(Math.round(n)) + "đ";

type StaffAttSummary = {
  month: string;
  totalDays: number;
  lateCount: number;
  missedCheckout: number;
  showCount: number;
  onTimeRate: number;
  totalPenalty: number;
  totalBonus: number;
  net?: number;
  adjustments?: { id: number; type: string; category?: string | null; amount: number; reason: string | null; date: string; createdByName?: string | null }[];
};

function StaffAttendanceBlock({ staffId, isAdmin }: { staffId: number; isAdmin?: boolean }) {
  const month = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);
  const { data, isLoading } = useQuery<StaffAttSummary>({
    queryKey: ["staff-att-summary", staffId, month],
    queryFn: () => fetchJson(`/api/attendance/staff-summary?staffId=${staffId}&month=${month}`),
    enabled: !!staffId,
  });
  return (
    <section className="bg-card border border-border rounded-2xl p-4 space-y-3">
      <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
        <Clock className="w-3.5 h-3.5" /> Chấm công tháng này ({month})
      </p>
      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground text-center py-4">Đang tải…</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-blue-50 dark:bg-blue-950/30 p-3 text-center">
              <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">{data.totalDays}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Số ngày công</p>
            </div>
            <div className="rounded-xl bg-red-50 dark:bg-red-950/30 p-3 text-center">
              <p className="text-2xl font-bold text-red-700 dark:text-red-300">{data.lateCount}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Lần đi trễ</p>
            </div>
            <div className="rounded-xl bg-orange-50 dark:bg-orange-950/30 p-3 text-center">
              <p className="text-2xl font-bold text-orange-700 dark:text-orange-300">{data.missedCheckout}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Quên check-out</p>
            </div>
            <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 text-center">
              <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{data.showCount}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Đi show / ngoài</p>
            </div>
            <div className="rounded-xl bg-green-50 dark:bg-green-950/30 p-3 text-center col-span-2">
              <p className="text-2xl font-bold text-green-700 dark:text-green-300">{data.onTimeRate}%</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Tỉ lệ đúng giờ</p>
            </div>
          </div>
          {(data.totalPenalty > 0 || data.totalBonus > 0) && (
            <div className="flex justify-between items-center text-sm pt-2 border-t border-border flex-wrap gap-2">
              {data.totalBonus > 0 && (
                <span className="text-green-600 font-semibold">Thưởng: +{fmtVNDLocal(data.totalBonus)}</span>
              )}
              {data.totalPenalty > 0 && (
                <span className="text-red-600 font-semibold">Phạt: -{fmtVNDLocal(data.totalPenalty)}</span>
              )}
              {typeof data.net === "number" && (
                <span className={`ml-auto font-bold ${data.net >= 0 ? "text-green-700" : "text-red-700"}`}>
                  Net: {data.net >= 0 ? "+" : ""}{fmtVNDLocal(data.net)}
                </span>
              )}
            </div>
          )}
          {isAdmin && data.adjustments && data.adjustments.length > 0 && (
            <div className="pt-2 border-t border-border">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                Điều chỉnh tháng này ({data.adjustments.length}) <span className="text-[9px] text-violet-600">[admin]</span>
              </p>
              <ul className="space-y-1 max-h-40 overflow-y-auto">
                {data.adjustments.map(adj => {
                  const isBonus = adj.type === "bonus";
                  const isWaiver = adj.category === "waiver";
                  return (
                    <li key={adj.id} className="flex items-start justify-between gap-2 text-xs bg-muted/20 rounded px-2 py-1.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-muted-foreground">{adj.date.slice(5)}</span>
                          {isWaiver && <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 font-semibold">GỠ PHẠT</span>}
                        </div>
                        {adj.reason && <p className="text-foreground truncate">{adj.reason}</p>}
                        {adj.createdByName && <p className="text-[10px] text-muted-foreground">— {adj.createdByName}</p>}
                      </div>
                      <span className={`shrink-0 font-bold ${isBonus ? "text-green-600" : "text-red-600"}`}>
                        {isBonus ? "+" : "-"}{fmtVNDLocal(adj.amount)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
