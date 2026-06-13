import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Users, Plus, Pencil, Banknote, DollarSign, Briefcase, ClipboardList, ChevronDown, ChevronUp, AlertCircle, UserCircle, LogOut, ChevronRight, KeyRound, Eye, EyeOff, ShieldCheck, BarChart2, Camera } from "lucide-react";
import { useStaffAuth, type ViewerUser } from "@/contexts/StaffAuthContext";
import StaffAvatar from "@/components/StaffAvatar";
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
    let msg = `Lỗi ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      msg = j.error ?? j.message ?? msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ─── Role definitions ─────────────────────────────────────────────────────────
const ROLES = [
  { key: "admin",        label: "Quản lý",    icon: "👑" },
  { key: "photographer", label: "Nhiếp ảnh",  icon: "📷" },
  { key: "makeup",       label: "Trang điểm", icon: "💄" },
  { key: "sale",         label: "Kinh doanh",  icon: "💼" },
  { key: "photoshop",    label: "Chỉnh sửa",  icon: "🖥️" },
  { key: "assistant",    label: "Hỗ trợ",     icon: "🤝" },
  { key: "marketing",    label: "Marketing",  icon: "📣" },
];

// ─── Base job types (same for all roles) ───────────────────────────────────────
export const BASE_TASKS: Array<{ key: string; label: string }> = [
  { key: "chup_cong",              label: "Chụp cổng" },
  { key: "chup_album",             label: "Chụp album" },
  { key: "chup_tiec_truyen_thong", label: "Chụp tiệc truyền thống" },
  { key: "chup_tiec_phong_su",     label: "Chụp tiệc phóng sự" },
  { key: "chup_beauty",            label: "Chụp beauty" },
  { key: "chup_nang_tho",          label: "Chụp nàng thơ" },
  { key: "chup_gia_dinh",          label: "Chụp gia đình" },
  { key: "chup_em_be",             label: "Chụp em bé" },
  { key: "chup_ngoai_canh",        label: "Chụp ngoại cảnh" },
  { key: "chup_prewedding",        label: "Chụp prewedding" },
  { key: "chup_concept",           label: "Chụp concept" },
  { key: "chup_san_pham",          label: "Chụp sản phẩm" },
  { key: "ho_tro_chup",            label: "Hỗ trợ chụp / phụ chụp" },
  { key: "mac_dinh",               label: "Mặc định" },
];

// Legacy: kept for backward compatibility if needed
export const ROLE_TASKS: Record<string, Array<{ key: string; label: string }>> = {
  photographer: BASE_TASKS,
  makeup: BASE_TASKS,
  sale: BASE_TASKS,
  photoshop: BASE_TASKS,
  marketing: BASE_TASKS,
  assistant: BASE_TASKS,
  videographer: BASE_TASKS,
  admin: BASE_TASKS,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getRoles(s: { roles?: unknown; role?: unknown }): string[] {
  if (Array.isArray(s.roles) && s.roles.length > 0) return s.roles as string[];
  if (s.role) return [String(s.role)];
  return [];
}

function fmt(n: number) {
  return n.toLocaleString("vi-VN") + "đ";
}

const STATUS_MAP: Record<string, string> = {
  active: "Đang làm",
  inactive: "Nghỉ",
  probation: "Tạm nghỉ",
};

type PriceEntry = { rate: string; rateType: "fixed" | "percent" };
type RolePriceMap = Record<string, Record<string, PriceEntry>>;

interface SvcPkg { id: number; groupId: number | null; code: string; name: string; price: number; isActive: boolean }
interface SvcGroup { id: number; name: string; isActive: boolean }
type CastEdits = Record<number, string>;

function CastPriceBlock({ role, packages, groups, edits, onChange, readOnly = false }: {
  role: string;
  packages: SvcPkg[];
  groups: SvcGroup[];
  edits: CastEdits;
  onChange: (pkgId: number, val: string) => void;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<number, boolean>>({});
  const roleDef = ROLES.find(r => r.key === role);

  const grouped = useMemo(() => {
    const map = new Map<number, { group: SvcGroup | null; pkgs: SvcPkg[] }>();
    for (const pkg of packages) {
      const gid = pkg.groupId ?? 0;
      if (!map.has(gid)) {
        const g = groups.find(gr => gr.id === gid) ?? null;
        map.set(gid, { group: g, pkgs: [] });
      }
      map.get(gid)!.pkgs.push(pkg);
    }
    return Array.from(map.values());
  }, [packages, groups]);

  const filledCount = Object.values(edits).filter(v => v !== undefined && v !== null && String(v).trim() !== "").length;
  const toggleGroup = (gid: number) => setOpenGroups(prev => ({ ...prev, [gid]: !(prev[gid] ?? true) }));

  return (
    <div className="border rounded-lg overflow-hidden mb-3">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/50 hover:bg-muted text-left"
        onClick={() => setOpen(o => !o)}
      >
        <span className="font-medium text-sm">
          {roleDef?.icon} Cast {roleDef?.label}
          {filledCount > 0 && <span className="ml-2 text-xs text-primary font-normal">({filledCount} gói)</span>}
        </span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {open && (
        <div className="divide-y divide-border/50">
          {grouped.map(({ group, pkgs }) => {
            const gid = group?.id ?? 0;
            const isOpen = openGroups[gid] ?? true;
            return (
              <div key={gid}>
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-4 py-2 bg-muted/20 hover:bg-muted/40 text-left"
                  onClick={() => toggleGroup(gid)}
                >
                  <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    {group?.name ?? "Khác"}
                  </span>
                  {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                {isOpen && (
                  <div className="px-3 py-2 space-y-1.5">
                    {pkgs.map(pkg => {
                      // Task: Sale (Kinh doanh) nhập % hoa hồng thay vì VND.
                      const isPercent = role === "sale";
                      return (
                        <div key={pkg.id} className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <span className="text-sm text-foreground truncate block">{pkg.name}</span>
                            <span className="text-[10px] text-muted-foreground">{fmt(pkg.price)}</span>
                          </div>
                          {readOnly ? (
                            <span className="w-32 text-right shrink-0 text-sm font-medium">
                              {edits[pkg.id]
                                ? (isPercent ? `${edits[pkg.id]}%` : fmt(Number(edits[pkg.id])))
                                : "—"}
                            </span>
                          ) : isPercent ? (
                            <div className="relative w-32 shrink-0">
                              <Input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                max="100"
                                step="0.1"
                                placeholder="5"
                                className="w-full text-right h-8 text-sm pr-7"
                                value={edits[pkg.id] ?? ""}
                                onChange={e => {
                                  const v = e.target.value;
                                  if (v === "") return onChange(pkg.id, "");
                                  const n = Math.max(0, Math.min(100, Number(v)));
                                  onChange(pkg.id, String(n));
                                }}
                              />
                              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">%</span>
                            </div>
                          ) : (
                            <Input
                              type="text"
                              inputMode="numeric"
                              placeholder="Cast"
                              className="w-32 text-right shrink-0 h-8 text-sm"
                              value={edits[pkg.id] ? Number(edits[pkg.id]).toLocaleString("vi-VN") : ""}
                              onChange={e => {
                                const raw = e.target.value.replace(/\D/g, "");
                                onChange(pkg.id, raw);
                              }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!open && filledCount > 0 && (
        <p className="text-xs text-muted-foreground px-3 py-2">Đã có {filledCount} gói được thiết lập cast</p>
      )}
    </div>
  );
}

// ─── Staff Info Form (Add / Edit) ─────────────────────────────────────────────
type StaffFormData = {
  name: string; phone: string; email: string; address: string;
  status: string; staffType: string; joinDate: string; notes: string;
  baseSalaryAmount: string; allowance: string; salaryNotes: string;
  avatar?: string | null; banner?: string | null;
  attendanceEnabled: boolean;
};
const EMPTY_FORM: StaffFormData = {
  name: "", phone: "", email: "", address: "",
  status: "active", staffType: "official", joinDate: "", notes: "",
  baseSalaryAmount: "", allowance: "", salaryNotes: "",
  avatar: null, banner: null,
  attendanceEnabled: true,
};

interface StaffFormSheetProps {
  open: boolean;
  onClose: () => void;
  editStaff?: Record<string, unknown> | null;
}
function StaffFormSheet({ open, onClose, editStaff }: StaffFormSheetProps) {
  const qc = useQueryClient();
  const isEdit = !!editStaff;

  const [form, setForm] = useState<StaffFormData>(EMPTY_FORM);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [castEdits, setCastEdits] = useState<Record<string, CastEdits>>({});
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [customRoles, setCustomRoles] = useState<Array<{ key: string; label: string; icon: string }>>([]);
  const [newRoleName, setNewRoleName] = useState("");
  const [showAddRoleDialog, setShowAddRoleDialog] = useState(false);

  const { data: allPackages = [] } = useQuery<SvcPkg[]>({
    queryKey: ["service-packages"],
    queryFn: () => fetchJson(`/api/service-packages`),
    staleTime: 60_000,
  });
  const { data: allGroups = [] } = useQuery<SvcGroup[]>({
    queryKey: ["service-groups"],
    queryFn: () => fetchJson(`/api/service-groups`),
    staleTime: 60_000,
  });
  const activePackages = useMemo(() => allPackages.filter(p => p.isActive), [allPackages]);

  useEffect(() => {
    if (!open) return;
    if (editStaff) {
      setForm({
        name: String(editStaff.name || ""),
        phone: String(editStaff.phone || ""),
        email: String(editStaff.email || ""),
        address: String(editStaff.address || ""),
        status: String(editStaff.status || "active"),
        staffType: String(editStaff.staffType || "official"),
        joinDate: String(editStaff.joinDate || ""),
        notes: String(editStaff.notes || ""),
        baseSalaryAmount: editStaff.baseSalaryAmount ? String(editStaff.baseSalaryAmount) : "",
        allowance: editStaff.allowance ? String(editStaff.allowance) : "",
        salaryNotes: String(editStaff.salaryNotes || ""),
        avatar: (editStaff.avatar as string | null) || null,
        banner: (editStaff.banner as string | null) || null,
        attendanceEnabled: editStaff.attendanceEnabled !== false,
      });
      setSelectedRoles(getRoles(editStaff as { roles?: unknown; role?: unknown }));
    } else {
      setForm(EMPTY_FORM);
      setSelectedRoles([]);
      setCastEdits({});
    }
    setErr("");
  }, [open, editStaff?.id]);

  const { data: existingCast } = useQuery<Array<{ id: number; staffId: number; role: string; packageId: number; amount: number | null }>>({
    queryKey: ["staff-cast", editStaff?.id],
    queryFn: () => fetchJson(`/api/staff-cast?staffId=${editStaff!.id}`),
    enabled: isEdit && open && !!editStaff?.id,
  });

  useEffect(() => {
    if (!existingCast) return;
    const map: Record<string, CastEdits> = {};
    for (const c of existingCast) {
      if (!map[c.role]) map[c.role] = {};
      map[c.role][c.packageId] = c.amount !== null ? String(c.amount) : "";
    }
    setCastEdits(map);
  }, [existingCast]);

  function setField(k: keyof StaffFormData, v: string) {
    setForm(f => ({ ...f, [k]: v }));
  }

  function toggleRole(role: string) {
    setSelectedRoles(prev =>
      prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]
    );
  }

  function handleAddRole() {
    if (!newRoleName.trim()) return;
    const newKey = newRoleName.toLowerCase().replace(/\s+/g, "_");
    const newRole = { key: newKey, label: newRoleName, icon: "👤" };
    setCustomRoles(prev => [...prev, newRole]);
    setSelectedRoles(prev => [...prev, newKey]);
    setNewRoleName("");
    setShowAddRoleDialog(false);
  }

  function handleCastChange(role: string, pkgId: number, val: string) {
    setCastEdits(prev => ({
      ...prev,
      [role]: { ...(prev[role] || {}), [pkgId]: val },
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setErr("Vui lòng nhập họ tên"); return; }
    setSaving(true); setErr("");
    try {
      const body = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        address: form.address.trim(),
        status: form.status,
        staffType: form.staffType || "official",
        joinDate: form.joinDate || null,
        notes: form.notes.trim(),
        baseSalaryAmount: form.baseSalaryAmount ? parseFloat(form.baseSalaryAmount) : null,
        allowance: form.allowance ? parseFloat(form.allowance) : null,
        salaryNotes: form.salaryNotes.trim(),
        avatar: form.avatar || null,
        banner: form.banner || null,
        roles: selectedRoles,
        role: selectedRoles[0] || null,
        attendanceEnabled: form.attendanceEnabled,
      };

      let staffId: number;
      if (isEdit) {
        await fetchJson(`/api/staff/${editStaff!.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        staffId = editStaff!.id as number;
      } else {
        const created = await fetchJson<{ id: number }>(`/api/staff`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        staffId = created.id;
      }

      for (const role of selectedRoles) {
        const roleEdits = castEdits[role];
        if (!roleEdits || Object.keys(roleEdits).length === 0) continue;
        const rates = Object.entries(roleEdits).map(([pkgId, amt]) => ({
          packageId: parseInt(pkgId),
          amount: amt.trim() === "" ? null : parseFloat(amt),
        }));
        await fetchJson(`/api/staff-cast/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ staffId, role, rates }),
        });
      }

      await qc.invalidateQueries({ queryKey: ["staff"] });
      await qc.invalidateQueries({ queryKey: ["staff-cast"] });
      await qc.invalidateQueries({ queryKey: ["job-earnings-dashboard"] });
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Lỗi lưu dữ liệu");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto p-0">
        <form onSubmit={handleSubmit} className="flex flex-col h-full">
          <SheetHeader className="px-6 pt-6 pb-4 border-b shrink-0">
            <SheetTitle>{isEdit ? "Sửa thông tin nhân viên" : "Thêm nhân viên mới"}</SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
            {err && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" /> {err}
              </div>
            )}

            {/* A. Thông tin cơ bản */}
            <section>
              <h3 className="font-semibold text-sm mb-3 flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
                <Users className="w-4 h-4" /> A. Thông tin cơ bản
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <Label>Họ tên <span className="text-destructive">*</span></Label>
                  <Input value={form.name} onChange={e => setField("name", e.target.value)}
                    placeholder="Nguyễn Thị Hoa" className="mt-1" />
                </div>
                <div>
                  <Label>Số điện thoại</Label>
                  <Input value={form.phone} onChange={e => setField("phone", e.target.value)}
                    placeholder="0901234567" className="mt-1" />
                  {!isEdit && form.phone && (
                    <p className="text-xs text-muted-foreground mt-1">
                      🔑 Tài khoản đăng nhập: <span className="font-mono font-medium">{form.phone}</span> / mật khẩu mặc định: <span className="font-mono font-medium">{form.phone}</span>
                    </p>
                  )}
                  {!isEdit && !form.phone && (
                    <p className="text-xs text-muted-foreground mt-1">💡 Số điện thoại sẽ là tên đăng nhập</p>
                  )}
                </div>
                <div>
                  <Label>Email</Label>
                  <Input value={form.email} onChange={e => setField("email", e.target.value)}
                    placeholder="hoa@studio.vn" className="mt-1" />
                </div>
                <div>
                  <Label>Ngày vào làm</Label>
                  <DateInput value={form.joinDate} onChange={v => setField("joinDate", v)} className="mt-1" />
                </div>
                <div>
                  <Label>Trạng thái</Label>
                  <Select value={form.status} onValueChange={v => setField("status", v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Đang làm</SelectItem>
                      <SelectItem value="inactive">Nghỉ</SelectItem>
                      <SelectItem value="probation">Tạm nghỉ</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Loại nhân viên</Label>
                  <Select value={form.staffType} onValueChange={v => setField("staffType", v)}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="official">Chính thức</SelectItem>
                      <SelectItem value="freelancer">Cộng tác viên (CTV)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-2 flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <Label>Tính chấm công</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {form.staffType !== "official"
                        ? "CTV / Freelancer không được tính chấm công (mặc định tắt)."
                        : form.attendanceEnabled
                          ? "Đang BẬT — nhân viên xuất hiện trong lịch chấm công, tính trễ/vắng/phạt."
                          : "Đang TẮT — không hiện trong lịch chấm công, không tính trễ/vắng/phạt (vd: nghỉ đi học). Lịch sử cũ vẫn giữ nguyên."}
                    </p>
                  </div>
                  <Switch
                    checked={form.staffType === "official" && form.attendanceEnabled}
                    disabled={form.staffType !== "official"}
                    onCheckedChange={v => setForm(f => ({ ...f, attendanceEnabled: v }))}
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label>Địa chỉ</Label>
                  <Input value={form.address} onChange={e => setField("address", e.target.value)}
                    placeholder="Số nhà, đường, quận..." className="mt-1" />
                </div>
                <div className="sm:col-span-2">
                  <Label>Ghi chú</Label>
                  <Textarea value={form.notes} onChange={e => setField("notes", e.target.value)}
                    placeholder="Ghi chú thêm..." rows={2} className="mt-1" />
                </div>
                <div className="sm:col-span-2">
                  <Label>Ảnh đại diện</Label>
                  <input type="file" accept="image/*" onChange={async (e) => {
                    const file = e.currentTarget.files?.[0]; if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => setField("avatar", String(reader.result));
                    reader.readAsDataURL(file);
                  }} className="block w-full text-sm border border-border rounded-lg p-2 mt-1 cursor-pointer" />
                  {form.avatar && <div className="mt-2 text-xs text-muted-foreground">✓ Ảnh đã chọn (sẽ lưu khi nhấn "Thêm nhân viên")</div>}
                </div>
                <div className="sm:col-span-2">
                  <Label>Ảnh bìa</Label>
                  <input type="file" accept="image/*" onChange={async (e) => {
                    const file = e.currentTarget.files?.[0]; if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => setField("banner", String(reader.result));
                    reader.readAsDataURL(file);
                  }} className="block w-full text-sm border border-border rounded-lg p-2 mt-1 cursor-pointer" />
                  {form.banner && <div className="mt-2 text-xs text-muted-foreground">✓ Ảnh đã chọn (sẽ lưu khi nhấn "Thêm nhân viên")</div>}
                </div>
              </div>
            </section>

            <Separator />

            {/* B. Lương cơ bản */}
            <section>
              <h3 className="font-semibold text-sm mb-3 flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
                <Banknote className="w-4 h-4" /> B. Lương cơ bản
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Lương cứng (đ/tháng)</Label>
                  <CurrencyInput value={form.baseSalaryAmount}
                    onChange={raw => setField("baseSalaryAmount", raw)}
                    placeholder="vd: 5.000.000" className="mt-1" />
                </div>
                <div>
                  <Label>Phụ cấp (đ/tháng)</Label>
                  <CurrencyInput value={form.allowance}
                    onChange={raw => setField("allowance", raw)}
                    placeholder="vd: 500.000" className="mt-1" />
                </div>
                <div className="sm:col-span-2">
                  <Label>Ghi chú lương</Label>
                  <Input value={form.salaryNotes} onChange={e => setField("salaryNotes", e.target.value)}
                    placeholder="Ghi chú về lương..." className="mt-1" />
                </div>
              </div>
            </section>

            <Separator />

            {/* C. Chức vụ */}
            <section>
              <h3 className="font-semibold text-sm mb-1 flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
                <Briefcase className="w-4 h-4" /> C. Chức vụ
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                Chọn một hoặc nhiều chức vụ. Hệ thống sẽ tạo bảng nhập giá riêng cho từng chức vụ bên dưới.
              </p>
              <div className="flex flex-wrap gap-2">
                {[...ROLES, ...customRoles].map(r => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => toggleRole(r.key)}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      selectedRoles.includes(r.key)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-border hover:bg-muted"
                    }`}
                  >
                    <span>{r.icon}</span> {r.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setShowAddRoleDialog(true)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border-2 border-dashed border-border text-sm font-medium text-muted-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors"
                >
                  <Plus className="w-4 h-4" /> Thêm chức vụ
                </button>
              </div>

              {/* Dialog: Add new role */}
              <Dialog open={showAddRoleDialog} onOpenChange={setShowAddRoleDialog}>
                <DialogContent className="max-w-sm">
                  <DialogHeader>
                    <DialogTitle>Thêm chức vụ mới</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div>
                      <Label className="text-sm">Tên chức vụ (vd: Quay phim, Trang phục, ...)</Label>
                      <Input
                        className="mt-1"
                        placeholder="Nhập tên chức vụ"
                        value={newRoleName}
                        onChange={e => setNewRoleName(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") handleAddRole(); }}
                        autoFocus
                      />
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button type="button" variant="outline" onClick={() => setShowAddRoleDialog(false)}>
                        Hủy
                      </Button>
                      <Button type="button" onClick={handleAddRole} disabled={!newRoleName.trim()}>
                        Thêm
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </section>

            {selectedRoles.length > 0 && activePackages.length > 0 && (
              <>
                <Separator />
                <section>
                  <h3 className="font-semibold text-sm mb-1 flex items-center gap-1.5 text-muted-foreground uppercase tracking-wide">
                    <ClipboardList className="w-4 h-4" /> D. Cast theo gói dịch vụ
                  </h3>
                  <p className="text-xs text-muted-foreground mb-3">
                    Nhập chi phí cast cho từng gói chụp. Mỗi nhân viên có mức cast riêng theo từng gói.
                  </p>
                  {selectedRoles.map(role => (
                    <CastPriceBlock
                      key={role}
                      role={role}
                      packages={activePackages}
                      groups={allGroups}
                      edits={castEdits[role] || {}}
                      onChange={(pkgId, val) => handleCastChange(role, pkgId, val)}
                    />
                  ))}
                </section>
              </>
            )}
          </div>

          <div className="px-6 py-4 border-t shrink-0 flex gap-3">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>Huỷ</Button>
            <Button type="submit" className="flex-1" disabled={saving}>
              {saving ? "Đang lưu..." : isEdit ? "Lưu thay đổi" : "Thêm nhân viên"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

// ─── Cast Edit Dialog (per-staff, package-based) ─────────────────────────────
interface PriceEditDialogProps {
  staff: Record<string, unknown> | null;
  onClose: () => void;
  isAdmin?: boolean;
}
function PriceEditDialog({ staff, onClose, isAdmin = false }: PriceEditDialogProps) {
  const qc = useQueryClient();
  const [castEditsLocal, setCastEditsLocal] = useState<Record<string, CastEdits>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState(false);

  const roles = staff ? getRoles(staff) : [];

  const { data: allPackages = [] } = useQuery<SvcPkg[]>({
    queryKey: ["service-packages"],
    queryFn: () => fetchJson(`/api/service-packages`),
    staleTime: 60_000,
  });
  const { data: allGroups = [] } = useQuery<SvcGroup[]>({
    queryKey: ["service-groups"],
    queryFn: () => fetchJson(`/api/service-groups`),
    staleTime: 60_000,
  });
  const activePackages = useMemo(() => allPackages.filter(p => p.isActive), [allPackages]);

  const { data: existingCast, isLoading } = useQuery<Array<{ id: number; staffId: number; role: string; packageId: number; amount: number | null }>>({
    queryKey: ["staff-cast", staff?.id],
    queryFn: () => fetchJson(`/api/staff-cast?staffId=${staff!.id}`),
    enabled: !!staff,
  });

  useEffect(() => {
    if (!existingCast) return;
    const map: Record<string, CastEdits> = {};
    for (const c of existingCast) {
      if (!map[c.role]) map[c.role] = {};
      map[c.role][c.packageId] = c.amount !== null ? String(c.amount) : "";
    }
    setCastEditsLocal(map);
    setSuccess(false); setErr("");
  }, [existingCast]);

  function handleChange(role: string, pkgId: number, val: string) {
    setCastEditsLocal(prev => ({
      ...prev,
      [role]: { ...(prev[role] || {}), [pkgId]: val },
    }));
  }

  async function handleSave() {
    if (!staff) return;
    setSaving(true); setErr(""); setSuccess(false);
    try {
      for (const role of roles) {
        const roleEdits = castEditsLocal[role];
        if (!roleEdits || Object.keys(roleEdits).length === 0) continue;
        const rates = Object.entries(roleEdits).map(([pkgId, amt]) => ({
          packageId: parseInt(pkgId),
          amount: amt.trim() === "" ? null : parseFloat(amt),
        }));
        await fetchJson(`/api/staff-cast/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ staffId: staff.id, role, rates }),
        });
      }
      await qc.invalidateQueries({ queryKey: ["staff-cast", staff.id] });
      setSuccess(true);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Lỗi lưu cast");
    } finally {
      setSaving(false);
    }
  }

  if (!staff) return null;

  return (
    <Dialog open={!!staff} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isAdmin ? "Sửa cast theo gói" : "Cast của bạn"} — {String(staff.name)}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground">Đang tải...</div>
        ) : roles.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground space-y-2">
            <AlertCircle className="w-8 h-8 mx-auto opacity-40" />
            <p>Nhân viên này chưa có chức vụ.</p>
            <p className="text-sm">Hãy sửa thông tin để chọn chức vụ trước, sau đó mới nhập cast.</p>
          </div>
        ) : activePackages.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">Chưa có gói dịch vụ nào trong bảng giá.</div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Nhập chi phí cast của <strong>{String(staff.name)}</strong> cho từng gói chụp.
              Để trống = chưa có cast.
            </p>
            {err && (
              <div className="flex items-center gap-2 p-3 rounded bg-destructive/10 text-destructive text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" /> {err}
              </div>
            )}
            {success && (
              <div className="p-3 rounded bg-green-50 text-green-700 text-sm border border-green-200">
                ✓ Đã lưu cast thành công!
              </div>
            )}
            {roles.map(role => (
              <CastPriceBlock
                key={role}
                role={role}
                packages={activePackages}
                groups={allGroups}
                edits={castEditsLocal[role] || {}}
                onChange={(pkgId, val) => handleChange(role, pkgId, val)}
                readOnly={!isAdmin}
              />
            ))}
            <div className="flex gap-3 pt-2">
              <Button variant="outline" className="flex-1" onClick={onClose}>Đóng</Button>
              {isAdmin && (
                <Button className="flex-1" onClick={handleSave} disabled={saving}>
                  {saving ? "Đang lưu..." : "Lưu cast"}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Staff Card ───────────────────────────────────────────────────────────────
type StaffEarningSummary = { todayTotal: number; monthTotal: number; jobCount: number };

interface StaffCardProps {
  staff: Record<string, unknown>;
  earningSummary?: StaffEarningSummary;
  onEdit: (s: Record<string, unknown>) => void;
  onEditPrice: (s: Record<string, unknown>) => void;
  onSetPassword: (s: Record<string, unknown>) => void;
  isAdmin: boolean;
}
function StaffCard({ staff, earningSummary, onEdit, onEditPrice, onSetPassword, isAdmin }: StaffCardProps) {
  const [, navigate] = useLocation();
  const roles = getRoles(staff);
  const isFreelancer = staff.staffType === "freelancer";

  const todayTotal = earningSummary?.todayTotal ?? 0;
  const monthTotal = earningSummary?.monthTotal ?? 0;
  const jobCount = earningSummary?.jobCount ?? 0;

  const statusClass = ({
    active: "bg-green-100 text-green-700",
    inactive: "bg-red-100 text-red-700",
    probation: "bg-yellow-100 text-yellow-700",
  } as Record<string, string>)[String(staff.status || "active")] || "bg-gray-100 text-gray-700";

  return (
    <div className={`border rounded-xl p-4 bg-card hover:shadow-sm transition-shadow flex flex-col gap-3 ${isFreelancer ? "border-purple-200 bg-purple-50/30" : ""}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <StaffAvatar
            name={String(staff.name || "?")}
            avatar={(staff as Record<string, unknown>).avatar as string | undefined}
            role={String(roles[0] || "assistant")}
            status={String(staff.status || "active")}
            isActive={Boolean(staff.isActive)}
            size="lg"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold truncate">{String(staff.name)}</span>
              {isFreelancer && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 font-medium shrink-0">CTV</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">{String(staff.phone || "—")}</div>
          </div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${statusClass}`}>
          {STATUS_MAP[String(staff.status || "active")] || "Đang làm"}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {roles.length === 0 ? (
          <span className="text-xs text-muted-foreground">Chưa có chức vụ</span>
        ) : roles.map(r => {
          const rd = ROLES.find(x => x.key === r);
          return (
            <Badge key={r} variant="secondary" className="text-xs">
              {rd?.icon} {rd?.label || r}
            </Badge>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-muted/50 rounded-lg p-2">
          <div className="text-xs text-muted-foreground leading-tight">Hôm nay</div>
          <div className="font-semibold text-sm text-green-600">{fmt(todayTotal)}</div>
        </div>
        <div className="bg-muted/50 rounded-lg p-2">
          <div className="text-xs text-muted-foreground leading-tight">Tháng này</div>
          <div className="font-semibold text-sm text-blue-600">{fmt(monthTotal)}</div>
        </div>
        <div className="bg-muted/50 rounded-lg p-2">
          <div className="text-xs text-muted-foreground leading-tight">Số job</div>
          <div className="font-semibold text-sm">{jobCount}</div>
        </div>
      </div>

      {(staff.baseSalaryAmount != null && staff.baseSalaryAmount !== "" || staff.allowance != null && staff.allowance !== "") && (
        <div className="text-xs text-muted-foreground">
          {staff.baseSalaryAmount != null && staff.baseSalaryAmount !== "" && <>Lương cứng: <span className="font-medium text-foreground">{fmt(parseFloat(String(staff.baseSalaryAmount)))}</span></>}
          {staff.allowance != null && staff.allowance !== "" && <> · Phụ cấp: <span className="font-medium text-foreground">{fmt(parseFloat(String(staff.allowance)))}</span></>}
        </div>
      )}

      <button
        onClick={() => navigate(`/staff/${String(staff.id)}`)}
        className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-primary/5 border border-primary/20 text-primary text-sm font-medium hover:bg-primary/10 transition-colors"
      >
        <UserCircle className="w-4 h-4" /> Xem hồ sơ chi tiết <ChevronRight className="w-3.5 h-3.5" />
      </button>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" className="flex-1 gap-1" onClick={() => onEdit(staff)}>
          <Pencil className="w-3.5 h-3.5" /> Sửa thông tin
        </Button>
        <Button size="sm" variant="outline" className="flex-1 gap-1" onClick={() => onEditPrice(staff)}>
          <DollarSign className="w-3.5 h-3.5" /> {isAdmin ? "Sửa bảng giá" : "Xem cast"}
        </Button>
      </div>
      {isAdmin && (
        <Button size="sm" variant="ghost" className="w-full gap-1.5 text-muted-foreground hover:text-foreground border border-dashed" onClick={() => onSetPassword(staff)}>
          <KeyRound className="w-3.5 h-3.5" /> Quản lý tài khoản đăng nhập
        </Button>
      )}
    </div>
  );
}

// ─── Account Management Dialog ────────────────────────────────────────────────
function SetPasswordDialog({ staff, onClose }: { staff: Record<string, unknown> | null; onClose: () => void }) {
  const { token } = useStaffAuth();
  const [username, setUsername] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const staffName = String(staff?.name || "");
  const staffPhone = String(staff?.phone || "");

  useEffect(() => {
    if (!staff) return;
    setUsername((staff.username as string) || "");
    setNewPw(""); setConfirm(""); setErr(""); setDone(false);
  }, [staff?.id]);

  async function handleSave() {
    if (!staff) return;
    if (newPw && newPw.length < 4) { setErr("Mật khẩu phải có ít nhất 4 ký tự"); return; }
    if (newPw && newPw !== confirm) { setErr("Mật khẩu xác nhận không khớp"); return; }
    if (!username.trim() && !staffPhone) { setErr("Cần có tên đăng nhập hoặc số điện thoại"); return; }
    setSaving(true); setErr("");
    try {
      const body: Record<string, unknown> = { targetId: staff.id, username: username.trim() };
      if (newPw) body.newPassword = newPw;
      const res = await fetch(`/api/auth/update-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
        body: JSON.stringify(body),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok) { setErr(data.error ?? "Lỗi cập nhật tài khoản"); return; }
      setDone(true);
    } catch { setErr("Lỗi kết nối máy chủ"); }
    finally { setSaving(false); }
  }

  const effectiveLogin = username.trim() || staffPhone || "—";

  return (
    <Dialog open={!!staff} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" /> Quản lý tài khoản
          </DialogTitle>
        </DialogHeader>

        {done ? (
          <div className="py-6 text-center space-y-3">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-100 mx-auto">
              <ShieldCheck className="w-7 h-7 text-emerald-600" />
            </div>
            <p className="font-semibold text-emerald-700">Cập nhật thành công!</p>
            <p className="text-sm text-muted-foreground">
              Tài khoản <strong>{staffName}</strong> đã được cập nhật.
            </p>
            <div className="bg-muted/50 rounded-lg px-4 py-2 text-sm text-left space-y-1">
              <p><span className="text-muted-foreground">Đăng nhập bằng:</span> <span className="font-mono font-semibold">{effectiveLogin}</span></p>
              {newPw && <p className="text-muted-foreground">Mật khẩu đã được đổi</p>}
            </div>
            <Button className="w-full mt-1" onClick={onClose}>Đóng</Button>
          </div>
        ) : (
          <div className="space-y-4 py-1">
            <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm space-y-0.5">
              <p className="font-medium text-blue-800">{staffName}</p>
              {staffPhone && <p className="text-blue-600 text-xs">SĐT: {staffPhone}</p>}
              <p className="text-blue-600 text-xs">Đăng nhập hiện tại: <span className="font-mono font-semibold">{effectiveLogin}</span></p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Tên đăng nhập</Label>
              <Input
                placeholder={staffPhone || "Nhập tên đăng nhập tùy chọn"}
                value={username}
                onChange={e => setUsername(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {username.trim()
                  ? <>Đăng nhập bằng: <span className="font-mono font-medium">{username.trim()}</span></>
                  : staffPhone
                    ? <>Để trống → dùng SĐT <span className="font-mono font-medium">{staffPhone}</span></>
                    : "Cần nhập tên đăng nhập hoặc thêm SĐT"}
              </p>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Mật khẩu mới <span className="text-muted-foreground font-normal">(để trống = không đổi)</span></Label>
              <div className="relative">
                <Input
                  type={showPw ? "text" : "password"}
                  placeholder="Ít nhất 4 ký tự"
                  value={newPw}
                  onChange={e => setNewPw(e.target.value)}
                  className="pr-10"
                />
                <button type="button" onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {newPw && (
              <div className="space-y-1.5">
                <Label className="text-sm">Xác nhận mật khẩu</Label>
                <Input
                  type="password"
                  placeholder="Nhập lại mật khẩu"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                />
              </div>
            )}

            {err && <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg">{err}</p>}

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={onClose}>Hủy</Button>
              <Button className="flex-1 gap-1.5" onClick={handleSave} disabled={saving}>
                {saving ? "Đang lưu..." : <><ShieldCheck className="w-4 h-4" /> Lưu tài khoản</>}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Post-Production Tab ───────────────────────────────────────────────────────
type ProductivityRow = {
  month: string; staffId: number | null; staffName: string;
  jobCount: number; detailPhotos: number; detailAmount: number;
  partyPhotos: number; partyAmount: number; grandTotal: number;
};

type JobDetailRow = {
  id: number; jobCode: string; shootDate: string; customerName: string;
  detailPhotos: number; detailRate: number; partyPhotos: number; partyRate: number;
  totalEarnings: number;
};

type SelectedCell = { staffId: number | null; staffName: string; month: string };

function StaffMonthDetailDialog({ cell, onClose }: { cell: SelectedCell | null; onClose: () => void }) {
  const { data: jobs = [], isLoading, isError } = useQuery<JobDetailRow[]>({
    queryKey: ["staff-month-detail", cell?.staffId, cell?.month],
    queryFn: () => fetchJson(
      `/api/photoshop-jobs/staff-month-detail?staffId=${encodeURIComponent(String(cell!.staffId))}&month=${encodeURIComponent(cell!.month)}`
    ),
    enabled: !!cell,
  });

  const totalDetail = jobs.reduce((s, j) => s + j.detailPhotos, 0);
  const totalParty = jobs.reduce((s, j) => s + j.partyPhotos, 0);
  const totalEarnings = jobs.reduce((s, j) => s + j.totalEarnings, 0);

  return (
    <Dialog open={!!cell} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl w-full">
        <DialogHeader>
          <DialogTitle>
            Chi tiết job hậu kỳ — {cell?.staffName} — {cell ? monthLabel(cell.month) : ""}
          </DialogTitle>
        </DialogHeader>
        {isLoading && (
          <div className="text-center py-8 text-muted-foreground text-sm">Đang tải...</div>
        )}
        {!isLoading && isError && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" /> Không thể tải dữ liệu. Vui lòng thử lại.
          </div>
        )}
        {!isLoading && !isError && jobs.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-sm">Không có job nào.</div>
        )}
        {!isLoading && jobs.length > 0 && (
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm min-w-[520px]">
              <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left">Mã job</th>
                  <th className="px-3 py-2 text-left">Khách hàng</th>
                  <th className="px-3 py-2 text-left">Ngày chụp</th>
                  <th className="px-3 py-2 text-right">Ảnh chỉnh kỹ</th>
                  <th className="px-3 py-2 text-right">Ảnh tiệc</th>
                  <th className="px-3 py-2 text-right">Tổng công</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jobs.map(j => (
                  <tr key={j.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{j.jobCode || "—"}</td>
                    <td className="px-3 py-2 font-medium">{j.customerName || "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {j.shootDate ? j.shootDate.slice(0, 10) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {j.detailPhotos > 0 ? (
                        <span>{j.detailPhotos.toLocaleString("vi-VN")} <span className="text-muted-foreground text-[10px]">ảnh</span></span>
                      ) : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {j.partyPhotos > 0 ? (
                        <span>{j.partyPhotos.toLocaleString("vi-VN")} <span className="text-muted-foreground text-[10px]">ảnh</span></span>
                      ) : <span className="text-muted-foreground/40">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-emerald-700">
                      {j.totalEarnings > 0 ? fmtVND(j.totalEarnings) : <span className="text-muted-foreground/40">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-muted/30 border-t-2 font-bold text-xs">
                <tr>
                  <td className="px-3 py-2 text-muted-foreground uppercase" colSpan={3}>Tổng cộng</td>
                  <td className="px-3 py-2 text-right">{totalDetail.toLocaleString("vi-VN")} ảnh</td>
                  <td className="px-3 py-2 text-right">{totalParty.toLocaleString("vi-VN")} ảnh</td>
                  <td className="px-3 py-2 text-right text-emerald-700">{fmtVND(totalEarnings)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function fmtVND(n: number) {
  if (n === 0) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "tr";
  return n.toLocaleString("vi-VN") + "đ";
}

function buildMonthRange(numMonths: number): string[] {
  const now = new Date();
  return Array.from({ length: numMonths }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (numMonths - 1 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

function monthLabel(m: string) {
  const [y, mo] = m.split("-");
  return `T${parseInt(mo)}/${y}`;
}

function PostProductionTab({ enabled }: { enabled: boolean }) {
  const { effectiveIsAdmin } = useStaffAuth();
  const [numMonths, setNumMonths] = useState(6);
  const [viewMode, setViewMode] = useState<"table" | "chart">("table");
  const [staffFilter, setStaffFilter] = useState("all");
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);

  const months = useMemo(() => buildMonthRange(numMonths), [numMonths]);
  const monthsParam = months.join(",");

  const { data: rows = [], isLoading } = useQuery<ProductivityRow[]>({
    queryKey: ["productivity-history", monthsParam],
    queryFn: () => fetchJson(`/api/photoshop-jobs/productivity-history?months=${encodeURIComponent(monthsParam)}`),
    enabled: effectiveIsAdmin && enabled,
  });

  const staffNames = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ id: number | null; name: string }> = [];
    for (const r of rows) {
      const key = String(r.staffId ?? "null");
      if (!seen.has(key)) { seen.add(key); list.push({ id: r.staffId, name: r.staffName }); }
    }
    return list;
  }, [rows]);

  const filteredStaff = staffFilter === "all" ? staffNames : staffNames.filter(s => String(s.id) === staffFilter);

  function getCell(staffId: number | null, month: string): ProductivityRow | undefined {
    return rows.find(r => r.month === month && String(r.staffId) === String(staffId));
  }

  function staffTotal(staffId: number | null) {
    return rows.filter(r => String(r.staffId) === String(staffId)).reduce((s, r) => s + r.grandTotal, 0);
  }

  function monthTotal(month: string) {
    return rows.filter(r => r.month === month).reduce((s, r) => s + r.grandTotal, 0);
  }

  const maxMonthTotal = Math.max(...months.map(m => monthTotal(m)), 1);

  if (!effectiveIsAdmin) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <BarChart2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="font-medium">Chỉ dành cho quản lý</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={String(numMonths)} onValueChange={v => setNumMonths(Number(v))}>
            <SelectTrigger className="w-36 h-9 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="3">3 tháng gần đây</SelectItem>
              <SelectItem value="6">6 tháng gần đây</SelectItem>
              <SelectItem value="9">9 tháng gần đây</SelectItem>
              <SelectItem value="12">12 tháng gần đây</SelectItem>
            </SelectContent>
          </Select>
          <Select value={staffFilter} onValueChange={setStaffFilter}>
            <SelectTrigger className="w-48 h-9 text-sm"><SelectValue placeholder="Tất cả nhân viên" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả nhân viên</SelectItem>
              {staffNames.map(s => (
                <SelectItem key={String(s.id)} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          <button
            onClick={() => setViewMode("table")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1 ${viewMode === "table" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <ClipboardList className="w-3.5 h-3.5" /> Bảng
          </button>
          <button
            onClick={() => setViewMode("chart")}
            className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1 ${viewMode === "chart" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <BarChart2 className="w-3.5 h-3.5" /> Biểu đồ
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="text-center py-16 text-muted-foreground">Đang tải dữ liệu...</div>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <Camera className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">Chưa có dữ liệu sản lượng hậu kỳ</p>
          <p className="text-sm mt-1">Dữ liệu sẽ xuất hiện khi có job hậu kỳ hoàn thành trong kỳ này</p>
        </div>
      )}

      {!isLoading && rows.length > 0 && viewMode === "table" && (
        <div className="rounded-xl border overflow-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase font-semibold sticky top-0">
              <tr>
                <th className="px-4 py-3 text-left">Nhân viên</th>
                {months.map(m => (
                  <th key={m} className="px-3 py-3 text-right whitespace-nowrap">{monthLabel(m)}</th>
                ))}
                <th className="px-4 py-3 text-right font-bold">Tổng cộng</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredStaff.map(s => (
                <tr key={String(s.id)} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                        {s.name.charAt(0)}
                      </div>
                      <span className="font-medium whitespace-nowrap">{s.name}</span>
                    </div>
                  </td>
                  {months.map(m => {
                    const cell = getCell(s.id, m);
                    const hasData = !!(cell && cell.grandTotal > 0);
                    return (
                      <td key={m} className="px-3 py-3 text-right">
                        {hasData ? (
                          <button
                            type="button"
                            onClick={() => setSelectedCell({ staffId: s.id, staffName: s.name, month: m })}
                            className="text-right w-full hover:bg-emerald-50 rounded-md px-1 py-0.5 transition-colors cursor-pointer group"
                            title="Xem chi tiết từng job"
                          >
                            <div className="font-semibold text-emerald-700 group-hover:underline">{fmtVND(cell!.grandTotal)}</div>
                            <div className="text-[10px] text-muted-foreground leading-tight">
                              {cell!.jobCount} job · {(cell!.detailPhotos + cell!.partyPhotos).toLocaleString("vi-VN")} ảnh
                            </div>
                          </button>
                        ) : (
                          <span className="text-muted-foreground/40">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-4 py-3 text-right font-bold text-emerald-700">
                    {fmtVND(staffTotal(s.id))}
                  </td>
                </tr>
              ))}
              {/* Totals row */}
              <tr className="bg-muted/30 font-bold border-t-2">
                <td className="px-4 py-3 text-muted-foreground uppercase text-xs">Tổng tháng</td>
                {months.map(m => {
                  const t = monthTotal(m);
                  return (
                    <td key={m} className="px-3 py-3 text-right text-emerald-700">
                      {t > 0 ? fmtVND(t) : <span className="text-muted-foreground/40">—</span>}
                    </td>
                  );
                })}
                <td className="px-4 py-3 text-right text-emerald-700">
                  {fmtVND(rows.reduce((s, r) => s + r.grandTotal, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && rows.length > 0 && viewMode === "chart" && (
        <div className="space-y-5">
          {/* Monthly bar chart */}
          <div className="rounded-xl border p-4">
            <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wide">Tổng sản lượng theo tháng</h3>
            <div className="flex items-end gap-2 h-40">
              {months.map(m => {
                const total = monthTotal(m);
                const heightPct = maxMonthTotal > 0 ? (total / maxMonthTotal) * 100 : 0;
                return (
                  <div key={m} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                    <div className="text-[10px] font-semibold text-emerald-700 truncate max-w-full">
                      {total > 0 ? fmtVND(total) : ""}
                    </div>
                    <div className="w-full flex flex-col justify-end" style={{ height: "100px" }}>
                      <div
                        className="w-full bg-emerald-400 rounded-t-md transition-all"
                        style={{ height: `${heightPct}%`, minHeight: total > 0 ? "4px" : "0" }}
                      />
                    </div>
                    <div className="text-[10px] text-muted-foreground whitespace-nowrap">{monthLabel(m)}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Per-staff bars for selected month or total */}
          {filteredStaff.length > 0 && (
            <div className="rounded-xl border p-4">
              <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wide">
                So sánh nhân viên — {numMonths} tháng gần đây
              </h3>
              {(() => {
                const maxStaffTotal = Math.max(...filteredStaff.map(s => staffTotal(s.id)), 1);
                return (
                  <div className="space-y-3">
                    {filteredStaff
                      .map(s => ({ ...s, total: staffTotal(s.id) }))
                      .sort((a, b) => b.total - a.total)
                      .map(s => {
                        const pct = maxStaffTotal > 0 ? (s.total / maxStaffTotal) * 100 : 0;
                        return (
                          <div key={String(s.id)} className="flex items-center gap-3">
                            <div className="w-28 text-sm truncate font-medium shrink-0">{s.name}</div>
                            <div className="flex-1 bg-muted rounded-full h-5 overflow-hidden">
                              <div
                                className="h-full bg-emerald-400 rounded-full transition-all flex items-center justify-end pr-2"
                                style={{ width: `${pct}%`, minWidth: s.total > 0 ? "24px" : "0" }}
                              >
                                {pct > 20 && (
                                  <span className="text-[10px] text-white font-semibold">{fmtVND(s.total)}</span>
                                )}
                              </div>
                            </div>
                            <div className="w-16 text-right text-sm font-semibold text-emerald-700 shrink-0">
                              {s.total > 0 ? fmtVND(s.total) : "—"}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      <StaffMonthDetailDialog cell={selectedCell} onClose={() => setSelectedCell(null)} />
    </div>
  );
}

// ─── Earnings Tab ─────────────────────────────────────────────────────────────
function EarningsTab({ staffList }: { staffList: Array<Record<string, unknown>> }) {
  const now = new Date();
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [year, setYear] = useState(String(now.getFullYear()));
  const [staffId, setStaffId] = useState("all");
  const qc = useQueryClient();

  const { data: earnings = [] } = useQuery<Array<{
    id: number; staffId: number; staffName: string; role: string;
    serviceName: string; rate: number; earnedDate: string;
    month: number; year: number; status: string; bookingCode: string;
  }>>({
    queryKey: ["job-earnings", month, year, staffId],
    queryFn: () => {
      const params = new URLSearchParams({ month, year });
      if (staffId !== "all") params.set("staffId", staffId);
      return fetchJson(`/api/job-earnings?${params}`);
    },
  });

  const markPaid = useMutation({
    mutationFn: (id: number) => fetchJson(`/api/job-earnings/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paid" }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["job-earnings"] });
      qc.invalidateQueries({ queryKey: ["job-earnings-dashboard"] });
    },
  });

  const total = earnings.reduce((s, e) => s + e.rate, 0);
  const paid  = earnings.filter(e => e.status === "paid").reduce((s, e) => s + e.rate, 0);

  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-4">
        <Select value={staffId} onValueChange={setStaffId}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Tất cả nhân viên" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả nhân viên</SelectItem>
            {staffList.map(s => (
              <SelectItem key={String(s.id)} value={String(s.id)}>{String(s.name)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Array.from({ length: 12 }, (_, i) => (
              <SelectItem key={i + 1} value={String(i + 1)}>Tháng {i + 1}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={year} onValueChange={setYear}>
          <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[2024, 2025, 2026, 2027].map(y => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {earnings.length > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="border rounded-lg p-3 text-center">
            <div className="text-xs text-muted-foreground">Tổng thu nhập</div>
            <div className="font-bold">{fmt(total)}</div>
          </div>
          <div className="border rounded-lg p-3 text-center">
            <div className="text-xs text-muted-foreground">Đã thanh toán</div>
            <div className="font-bold text-green-600">{fmt(paid)}</div>
          </div>
          <div className="border rounded-lg p-3 text-center">
            <div className="text-xs text-muted-foreground">Chưa thanh toán</div>
            <div className="font-bold text-orange-600">{fmt(total - paid)}</div>
          </div>
        </div>
      )}

      {earnings.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <DollarSign className="w-12 h-12 mx-auto mb-2 opacity-30" />
          <p>Chưa có thu nhập trong kỳ này</p>
          <p className="text-xs mt-1">Thu nhập tự động ghi nhận khi job chuyển sang "Hoàn thành"</p>
        </div>
      ) : (
        <div className="space-y-2">
          {earnings.map(e => {
            const rd = ROLES.find(r => r.key === e.role);
            return (
              <div key={e.id} className="border rounded-lg p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{e.staffName}</div>
                  <div className="text-xs text-muted-foreground">
                    {rd?.icon} {rd?.label || e.role} · {e.serviceName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {e.earnedDate.slice(0, 10)}{e.bookingCode ? ` · ${e.bookingCode}` : ""}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-semibold text-green-600">{fmt(e.rate)}</div>
                  {e.status === "paid" ? (
                    <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full">Đã trả</span>
                  ) : (
                    <button
                      className="text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full hover:bg-orange-100 transition-colors"
                      onClick={() => markPaid.mutate(e.id)}
                    >
                      Đánh dấu đã trả
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function StaffPage() {
  const [showForm, setShowForm] = useState(false);
  const [editStaff, setEditStaff] = useState<Record<string, unknown> | null>(null);
  const [priceStaff, setPriceStaff] = useState<Record<string, unknown> | null>(null);
  const [passwordStaff, setPasswordStaff] = useState<Record<string, unknown> | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "official" | "freelancer">("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [viewerSheet, setViewerSheet] = useState(false);
  const [activeTab, setActiveTab] = useState("staff");
  const { viewer, setViewer, logout, isAdmin, effectiveIsAdmin } = useStaffAuth();

  const { data: staffList = [], isLoading: staffListLoading } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ["staff"],
    queryFn: () => fetchJson(`/api/staff`),
    staleTime: 60_000,
  });

  const { data: earningsDashboard } = useQuery<{
    todayTotal: number;
    monthTotal: number;
    byStaff: Array<{ staffId: number; todayTotal: number; monthTotal: number; jobCount: number }>;
  }>({
    queryKey: ["job-earnings-dashboard"],
    queryFn: () => fetchJson(`/api/job-earnings/dashboard`),
    enabled: effectiveIsAdmin,
    staleTime: 60_000,
  });

  const earningsByStaffId = useMemo(() => {
    const map = new Map<number, StaffEarningSummary>();
    for (const row of earningsDashboard?.byStaff ?? []) {
      map.set(row.staffId, {
        todayTotal: row.todayTotal,
        monthTotal: row.monthTotal,
        jobCount: row.jobCount,
      });
    }
    return map;
  }, [earningsDashboard]);

  const filtered = staffList.filter(s => {
    if (typeFilter === "official" && s.staffType !== "official" && s.staffType !== null && s.staffType !== undefined && s.staffType !== "") return false;
    if (typeFilter === "freelancer" && s.staffType !== "freelancer") return false;
    if (roleFilter !== "all" && !getRoles(s).includes(roleFilter)) return false;
    if (search && !String(s.name || "").toLowerCase().includes(search.toLowerCase()) && !String(s.phone || "").includes(search)) return false;
    return true;
  });

  const officialCount = staffList.filter(s => s.staffType !== "freelancer").length;
  const freelancerCount = staffList.filter(s => s.staffType === "freelancer").length;
  const todayTotal = earningsDashboard?.todayTotal ?? 0;
  const monthTotal = earningsDashboard?.monthTotal ?? 0;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6" /> Nhân sự & Lương
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Mỗi nhân viên có bảng giá cá nhân riêng</p>
        </div>
        {effectiveIsAdmin && (
          <Button onClick={() => { setEditStaff(null); setShowForm(true); }} className="gap-1.5">
            <Plus className="w-4 h-4" /> Thêm nhân viên
          </Button>
        )}
      </div>

      {/* ── Viewer selector ─────────────────────────────────────── */}
      <div className={`flex items-center gap-3 p-3 rounded-xl border mb-5 ${viewer ? "bg-emerald-50/50 border-emerald-200" : "bg-amber-50 border-amber-200"}`}>
        {viewer ? (() => {
          const vs = staffList.find(s => s.id === viewer.id);
          return (
            <StaffAvatar
              name={viewer.name}
              avatar={(vs as Record<string, unknown> | undefined)?.avatar as string | undefined}
              role={viewer.role}
              status="active"
              size="md"
            />
          );
        })() : (
          <UserCircle className="w-8 h-8 flex-shrink-0 text-amber-500" />
        )}
        <div className="flex-1 min-w-0">
          {viewer ? (
            <>
              <p className="text-sm font-semibold truncate">{viewer.name}</p>
              <p className="text-xs text-muted-foreground">{viewer.isAdmin ? "👑 Quản lý — xem được tất cả hồ sơ" : "Đang xem hồ sơ của chính mình"}</p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-amber-700">Bạn là ai?</p>
              <p className="text-xs text-muted-foreground">Chọn tài khoản để xem hồ sơ cá nhân</p>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => setViewerSheet(true)} className="text-xs px-3 py-1.5 rounded-lg bg-white border border-border font-medium hover:bg-muted transition-colors">
            {viewer ? "Đổi" : "Chọn tài khoản"}
          </button>
          {viewer && (
            <button onClick={logout} className="p-1.5 rounded-lg hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors" title="Đăng xuất">
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Stats row — admin only (chứa tổng thu nhập toàn studio) */}
      {effectiveIsAdmin && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <div className="border rounded-lg p-3 text-center">
            <div className="text-2xl font-bold">{officialCount}</div>
            <div className="text-xs text-muted-foreground">Nhân viên chính thức</div>
          </div>
          <div className="border rounded-lg p-3 text-center">
            <div className="text-2xl font-bold text-purple-600">{freelancerCount}</div>
            <div className="text-xs text-muted-foreground">Cộng tác viên (CTV)</div>
          </div>
          <div className="border rounded-lg p-3 text-center">
            <div className="text-sm font-bold text-blue-600">{fmt(monthTotal)}</div>
            <div className="text-xs text-muted-foreground">Thu nhập tháng này</div>
          </div>
          <div className="border rounded-lg p-3 text-center">
            <div className="text-sm font-bold text-orange-600">{fmt(todayTotal)}</div>
            <div className="text-xs text-muted-foreground">Thu nhập hôm nay</div>
          </div>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="staff">{effectiveIsAdmin ? "Danh sách nhân viên" : "Hồ sơ của tôi"}</TabsTrigger>
          {effectiveIsAdmin && (
            <TabsTrigger value="earnings">Thu nhập theo tháng</TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="postproduction" className="flex items-center gap-1.5">
              <BarChart2 className="w-3.5 h-3.5" /> Sản lượng hậu kỳ
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="staff">
          {/* Filters */}
          <div className="flex flex-wrap gap-2 mb-4">
            <Input
              placeholder="Tìm theo tên, số điện thoại..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="max-w-xs"
            />
            <div className="flex gap-1 bg-muted rounded-lg p-1">
              {(["all","official","freelancer"] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${typeFilter === t ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {t === "all" ? "Tất cả" : t === "official" ? "Chính thức" : "CTV"}
                </button>
              ))}
            </div>
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-44 h-9 text-sm">
                <SelectValue placeholder="Lọc theo vai trò" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả vai trò</SelectItem>
                {ROLES.map(r => (
                  <SelectItem key={r.key} value={r.key}>{r.icon} {r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {staffListLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">Không tìm thấy nhân viên</p>
              <p className="text-sm mt-1">Thử thay đổi bộ lọc hoặc bấm "Thêm nhân viên"</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map(s => (
                <StaffCard
                  key={String(s.id)}
                  staff={s}
                  earningSummary={earningsByStaffId.get(s.id as number)}
                  onEdit={s => { setEditStaff(s); setShowForm(true); }}
                  onEditPrice={setPriceStaff}
                  onSetPassword={setPasswordStaff}
                  isAdmin={!!effectiveIsAdmin}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="earnings">
          <EarningsTab staffList={staffList} />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="postproduction">
            <PostProductionTab enabled={activeTab === "postproduction"} />
          </TabsContent>
        )}
      </Tabs>

      <StaffFormSheet
        open={showForm}
        onClose={() => { setShowForm(false); setEditStaff(null); }}
        editStaff={editStaff}
      />

      <PriceEditDialog
        staff={priceStaff}
        onClose={() => setPriceStaff(null)}
        isAdmin={!!isAdmin}
      />

      <SetPasswordDialog
        staff={passwordStaff}
        onClose={() => setPasswordStaff(null)}
      />

      {/* ── Chọn tài khoản ─────────────────────────────────────── */}
      <Sheet open={viewerSheet} onOpenChange={setViewerSheet}>
        <SheetContent side="bottom" className="rounded-t-3xl max-h-[80vh] overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle className="flex items-center gap-2">
              <UserCircle className="w-5 h-5 text-primary" /> Chọn tài khoản của bạn
            </SheetTitle>
          </SheetHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Chọn tên của bạn để đăng nhập và xem hồ sơ cá nhân. Admin có thể xem tất cả hồ sơ.
          </p>
          <div className="space-y-2">
            {staffList.map(s => {
              const roles = getRoles(s);
              const isAdm = roles.includes("admin");
              const isMe = viewer?.id === (s.id as number);
              return (
                <button
                  key={String(s.id)}
                  onClick={() => {
                    const v: ViewerUser = {
                      id: s.id as number,
                      name: String(s.name),
                      role: String(s.role || "assistant"),
                      roles: getRoles(s),
                      isAdmin: isAdm,
                    };
                    setViewer(v);
                    setViewerSheet(false);
                  }}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${isMe ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"}`}
                >
                  <StaffAvatar
                    name={String(s.name || "?")}
                    avatar={(s as Record<string, unknown>).avatar as string | undefined}
                    role={String(s.role || "assistant")}
                    status={String(s.status || "active")}
                    isActive={Boolean(s.isActive)}
                    size="md"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{String(s.name)}</p>
                    <p className="text-xs text-muted-foreground">
                      {roles.map(r => ({ admin: "Quản lý", photographer: "Nhiếp ảnh", makeup: "Trang điểm", sale: "Kinh doanh", photoshop: "Chỉnh sửa", assistant: "Hỗ trợ", marketing: "Marketing" }[r] || r)).join(", ")}
                    </p>
                  </div>
                  {isMe && <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded-full">Đang dùng</span>}
                  {isAdm && !isMe && <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Admin</span>}
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
