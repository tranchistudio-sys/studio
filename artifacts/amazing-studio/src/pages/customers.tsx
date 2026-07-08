import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatVND, formatDate } from "@/lib/utils";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { Button, Input, Select, Textarea, Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui";
import {
  Search, Plus, Phone, MapPin, Edit, Trash2, Users, Facebook,
  TrendingUp, Calendar, Camera, X, ChevronRight, AlertCircle, CheckCircle, Crown,
} from "lucide-react";
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

// ─── Image compression (canvas) — resize avatar to max 320x320, quality 0.75 ──
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX = 320;
        let { width, height } = img;
        if (width > height) { if (width > MAX) { height = Math.round((height * MAX) / width); width = MAX; } }
        else { if (height > MAX) { width = Math.round((width * MAX) / height); height = MAX; } }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d")?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

const SOURCE_LABELS: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", referral: "Giới thiệu",
  google: "Google", tiktok: "TikTok", walk_in: "Tự đến", other: "Khác",
};

const SOURCE_COLORS: Record<string, string> = {
  facebook: "bg-blue-100 text-blue-700", instagram: "bg-pink-100 text-pink-700",
  referral: "bg-green-100 text-green-700", google: "bg-red-100 text-red-700",
  tiktok: "bg-gray-100 text-gray-700", walk_in: "bg-yellow-100 text-yellow-700",
  other: "bg-muted text-muted-foreground",
};

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

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  draft:           { label: "Lịch tạm",          color: "text-slate-500" },
  pending_service: { label: "Chưa chốt DV",       color: "text-orange-500" },
  pending:         { label: "Chờ xác nhận",       color: "text-yellow-600" },
  confirmed:       { label: "Đã xác nhận",        color: "text-blue-600" },
  in_progress:     { label: "Đang chụp",          color: "text-purple-600" },
  completed:       { label: "Hoàn thành",         color: "text-green-600" },
  cancelled:       { label: "Đã hủy",             color: "text-gray-400" },
};

type Customer = {
  id: number; customCode: string; name: string; phone: string | null; email?: string;
  address?: string; gender?: string; facebook?: string; zalo?: string;
  source?: string; tags?: string; notes?: string; createdAt: string;
  avatar?: string; totalBookings?: number; totalOwed?: number; totalPaid?: number; totalDebt?: number;
  customerRank?: string;
};

type CustomerDetail = Customer & {
  bookings: { id: number; orderCode: string; packageType: string; shootDate: string; totalAmount: number; paidAmount: number; status: string }[];
};

const EMPTY_FORM = {
  name: "", phone: "", email: "", address: "", gender: "", facebook: "", zalo: "",
  source: "facebook", tags: "", notes: "", avatar: "", customerRank: "new",
};

// ─── Avatar component ──────────────────────────────────────────────────────────
function AvatarCircle({ name, avatar, size = "md" }: { name: string; avatar?: string; size?: "sm" | "md" | "lg" | "xl" }) {
  const sizes = { sm: "w-8 h-8 text-xs", md: "w-10 h-10 text-sm", lg: "w-14 h-14 text-lg", xl: "w-20 h-20 text-2xl" };
  const cls = `${sizes[size]} rounded-full flex-shrink-0`;
  if (avatar) return <img src={avatar} alt={name} className={`${cls} object-cover`} />;
  return (
    <div className={`${cls} bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center text-primary font-bold overflow-hidden`}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export default function CustomersPage() {
  const qc = useQueryClient();
  const { effectiveIsAdmin } = useStaffAuth();
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [rankFilter, setRankFilter] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const phoneDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phoneDuplicate, setPhoneDuplicate] = useState<{ id: number; name: string; customCode?: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Customer | null>(null);
  const [deleteNeedsForce, setDeleteNeedsForce] = useState(false);

  // ── Queries ──────────────────────────────────────────────────────────────────
  const { data: customers = [], isLoading } = useQuery<Customer[]>({
    queryKey: ["customers", search, sourceFilter, rankFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search.length > 1) params.set("search", search);
      if (rankFilter) params.set("rank", rankFilter);
      return fetchJson<Customer[]>(`/api/customers?${params}`);
    },
    retry: 1,
  });

  const { data: customerDetail } = useQuery<CustomerDetail>({
    queryKey: ["customer-detail", selectedId],
    queryFn: () => fetchJson<CustomerDetail>(`/api/customers/${selectedId}`),
    enabled: !!selectedId,
  });

  // Deep-link từ Lịch chụp: /customers?customerId=N → tự động mở hồ sơ khách
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cid = params.get("customerId");
    if (!cid) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("customerId");
      window.history.replaceState({}, "", url.toString());
    } catch { /* ignore */ }
    const id = Number(cid);
    if (Number.isFinite(id) && id > 0) setSelectedId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mutations ─────────────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: typeof form) =>
      fetchJson<Customer>("/api/customers", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: (newCustomer) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      setFormSuccess(`Đã thêm khách hàng "${newCustomer.name}" thành công!`);
      setTimeout(() => { setIsOpen(false); setForm({ ...EMPTY_FORM }); setFormSuccess(""); }, 1200);
    },
    onError: (err: Error) => {
      setFormError(err.message || "Lưu thất bại. Vui lòng thử lại.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: typeof form }) =>
      fetchJson<Customer>(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer-detail", editingId] });
      setFormSuccess(`Đã cập nhật "${updated.name}" thành công!`);
      setTimeout(() => { setIsOpen(false); setFormSuccess(""); }, 1200);
    },
    onError: (err: Error) => {
      setFormError(err.message || "Cập nhật thất bại. Vui lòng thử lại.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetchJson<void>(`/api/customers/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      qc.setQueryData(["customers", search, sourceFilter, rankFilter], (old: Customer[] | undefined) =>
        old?.filter(c => c.id !== id) ?? []
      );
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["bookings"] });
      setSelectedId(null);
      setDeleteTarget(null);
      toast.success("Đã xóa khách hàng");
    },
    onError: (error: Error) => {
      // FK constraint (409) → escalate to force-delete warning inside existing dialog
      if (error.message.includes("liên kết") || error.message.includes("409")) {
        setDeleteNeedsForce(true);
      } else {
        setDeleteTarget(null);
        toast.error(error.message || "Không thể xóa khách hàng");
      }
    },
  });

  const forceDeleteMutation = useMutation({
    mutationFn: (id: number) =>
      fetchJson<void>(`/api/customers/${id}?force=true`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      qc.setQueryData(["customers", search, sourceFilter, rankFilter], (old: Customer[] | undefined) =>
        old?.filter(c => c.id !== id) ?? []
      );
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["bookings"] });
      setSelectedId(null);
      setDeleteTarget(null);
      setDeleteNeedsForce(false);
      toast.success("Đã xóa khách hàng và toàn bộ dữ liệu liên kết");
    },
    onError: (error: Error) => {
      setDeleteTarget(null);
      setDeleteNeedsForce(false);
      toast.error(error.message || "Không thể xóa khách hàng");
    },
  });

  // ── Form helpers ─────────────────────────────────────────────────────────────
  const openCreate = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setFormError("");
    setFormSuccess("");
    setPhoneDuplicate(null);
    setIsOpen(true);
  };

  const openEdit = (c: Customer) => {
    setForm({
      name: c.name, phone: c.phone ?? "", email: c.email || "", address: c.address || "",
      gender: c.gender || "", facebook: c.facebook || "", zalo: c.zalo || "",
      source: c.source || "other",
      tags: Array.isArray(c.tags) ? (c.tags as string[]).join(", ") : (c.tags || ""),
      notes: c.notes || "", avatar: c.avatar || "",
      customerRank: c.customerRank || "new",
    });
    setEditingId(c.id);
    setFormError("");
    setFormSuccess("");
    setPhoneDuplicate(null);
    setIsOpen(true);
  };

  const checkPhoneDuplicate = (phone: string) => {
    const trimmed = phone.replace(/[\s\-\(\)\+\.]/g, "");
    if (trimmed.length < 10) { setPhoneDuplicate(null); return; }
    if (phoneDebounceRef.current) clearTimeout(phoneDebounceRef.current);
    phoneDebounceRef.current = setTimeout(async () => {
      try {
        const res = await authFetch(`/api/customers/by-phone?phone=${encodeURIComponent(trimmed)}`);
        if (res.ok) {
          const found = await res.json() as { id: number; name: string; customCode?: string };
          if (found.id !== editingId) {
            setPhoneDuplicate(found);
          } else {
            setPhoneDuplicate(null);
          }
        } else {
          setPhoneDuplicate(null);
        }
      } catch {
        setPhoneDuplicate(null);
      }
    }, 400);
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressImage(file);
      setForm(f => ({ ...f, avatar: compressed }));
    } catch {
      setFormError("Không thể đọc ảnh. Vui lòng thử ảnh khác.");
    }
  };

  const handleSubmit = async () => {
    setFormError("");
    if (!form.name.trim()) { setFormError("Vui lòng nhập họ và tên khách hàng"); return; }
    if (form.phone.trim() && phoneDuplicate) {
      setFormError(`Số điện thoại này đã thuộc về "${phoneDuplicate.name}"${phoneDuplicate.customCode ? ` (${phoneDuplicate.customCode})` : ""}. Không thể tạo trùng.`);
      return;
    }

    const payload = {
      ...form,
      tags: form.tags.trim(),
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const filtered = customers.filter(c =>
    (!sourceFilter || c.source === sourceFilter) &&
    (!rankFilter || (c.customerRank || "new") === rankFilter)
  );

  // Auto-suggest customer rank from totals
  const suggestedRank = (() => {
    const editing = editingId ? customers.find(c => c.id === editingId) : null;
    const bookings = editing?.totalBookings ?? 0;
    const paid = editing?.totalPaid ?? 0;
    if (paid >= 50_000_000 || bookings >= 5) return "super_vip";
    if (paid >= 20_000_000 || bookings >= 3) return "vip";
    if (bookings >= 1) return "potential";
    return "new";
  })();

  const stats = {
    total: customers.length,
    bySource: Object.entries(SOURCE_LABELS)
      .map(([k, v]) => ({ key: k, label: v, count: customers.filter(c => c.source === k).length }))
      .filter(x => x.count > 0)
      .slice(0, 3),
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold">Khách hàng</h1>
          <p className="text-sm text-muted-foreground mt-0.5">CRM quản lý và chăm sóc khách hàng toàn diện</p>
        </div>
        <Button onClick={openCreate} className="gap-2"><Plus className="w-4 h-4" />Thêm khách hàng</Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border bg-card p-3">
          <p className="text-xs text-muted-foreground">Tổng khách</p>
          <p className="text-2xl font-bold text-primary">{stats.total}</p>
        </div>
        {stats.bySource.map(s => (
          <div key={s.key} className="rounded-xl border bg-card p-3">
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="text-xl font-bold">{s.count}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-4">
        {/* ─── Customer List ───────────────────────────────────────────────── */}
        <div className={`flex-1 min-w-0 ${selectedId ? "hidden lg:block" : ""}`}>
          <div className="flex gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Tên, SĐT, email..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <Select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className="w-36">
              <option value="">Tất cả nguồn</option>
              {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Select value={rankFilter} onChange={e => setRankFilter(e.target.value)} className="w-40">
              <option value="">Tất cả phân hạng</option>
              {Object.entries(RANK_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </div>

          {isLoading ? (
            <div className="py-20 text-center text-muted-foreground">Đang tải...</div>
          ) : (
            <div className="space-y-2">
              {filtered.map(c => (
                <div
                  key={c.id}
                  onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                  className={`rounded-xl border p-3.5 cursor-pointer transition-all hover:shadow-md ${selectedId === c.id ? "border-primary bg-primary/5" : "bg-card hover:border-primary/40"}`}
                >
                  <div className="flex items-center gap-3">
                    <AvatarCircle name={c.name} avatar={c.avatar} size="md" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{c.name}</span>
                        <span className="text-xs text-muted-foreground">{c.customCode}</span>
                        {c.source && <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${SOURCE_COLORS[c.source] ?? "bg-muted text-muted-foreground"}`}>{SOURCE_LABELS[c.source]}</span>}
                        {c.customerRank && c.customerRank !== "new" && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold inline-flex items-center gap-0.5 ${RANK_COLORS[c.customerRank] ?? "bg-muted text-muted-foreground"}`}>
                            {(c.customerRank === "vip" || c.customerRank === "super_vip") && <Crown className="w-2.5 h-2.5" />}
                            {RANK_LABELS[c.customerRank] ?? c.customerRank}
                          </span>
                        )}
                        {c.tags && typeof c.tags === "string" && c.tags.split(",").slice(0, 2).map(t => t.trim()).filter(Boolean).map(t => (
                          <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground">{t}</span>
                        ))}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                        {c.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</span>}
                        {(c.totalBookings ?? 0) > 0 && <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{c.totalBookings} show</span>}
                        {c.address && <span className="flex items-center gap-1 truncate max-w-[150px]"><MapPin className="w-3 h-3 flex-shrink-0" />{c.address}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {(c.totalDebt ?? 0) > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-600 rounded-full font-semibold hidden sm:block">
                          Nợ {formatVND(c.totalDebt!)}
                        </span>
                      )}
                      <button onClick={e => { e.stopPropagation(); openEdit(c); }} className="p-1.5 hover:bg-muted rounded-lg text-muted-foreground hover:text-primary transition-colors">
                        <Edit className="w-3.5 h-3.5" />
                      </button>
                      {effectiveIsAdmin && (
                        <button onClick={e => { e.stopPropagation(); setDeleteTarget(c); }} className="p-1.5 hover:bg-destructive/10 rounded-lg text-muted-foreground hover:text-destructive transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 hidden sm:block" />
                    </div>
                  </div>
                </div>
              ))}
              {filtered.length === 0 && !isLoading && (
                <div className="py-16 text-center text-muted-foreground">
                  <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p>Không tìm thấy khách hàng</p>
                  <button onClick={openCreate} className="mt-2 text-sm text-primary hover:underline">+ Thêm khách hàng mới</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ─── Detail Panel ────────────────────────────────────────────────── */}
        {selectedId && customerDetail && (
          <div className="w-full lg:w-80 xl:w-96 flex-shrink-0">
            <div className="bg-card rounded-2xl border shadow-sm overflow-hidden sticky top-4">
              <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-card p-5 border-b">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <AvatarCircle name={customerDetail.name} avatar={customerDetail.avatar} size="lg" />
                    <div>
                      <h3 className="font-bold text-base">{customerDetail.name}</h3>
                      <p className="text-xs text-muted-foreground">{customerDetail.customCode}</p>
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        {customerDetail.source && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium inline-block ${SOURCE_COLORS[customerDetail.source] ?? "bg-muted text-muted-foreground"}`}>
                            {SOURCE_LABELS[customerDetail.source]}
                          </span>
                        )}
                        {customerDetail.customerRank && customerDetail.customerRank !== "new" && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold inline-flex items-center gap-0.5 ${RANK_COLORS[customerDetail.customerRank] ?? "bg-muted text-muted-foreground"}`}>
                            {(customerDetail.customerRank === "vip" || customerDetail.customerRank === "super_vip") && <Crown className="w-2.5 h-2.5" />}
                            {RANK_LABELS[customerDetail.customerRank] ?? customerDetail.customerRank}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(customerDetail)} className="p-1.5 hover:bg-white/60 rounded-lg text-muted-foreground hover:text-primary transition-colors">
                      <Edit className="w-4 h-4" />
                    </button>
                    <button onClick={() => setSelectedId(null)} className="p-1.5 hover:bg-white/60 rounded-lg text-muted-foreground transition-colors lg:hidden">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 mt-4">
                  <div className="bg-white/60 dark:bg-black/10 rounded-xl p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Số show</p>
                    <p className="font-bold text-sm">{customerDetail.bookings?.length ?? 0}</p>
                  </div>
                  <div className="bg-white/60 dark:bg-black/10 rounded-xl p-2 text-center">
                    {/* Tổng phải thu = tổng giá trị các show còn hiệu lực (đơn con + đơn lẻ, KHÔNG
                        gồm đơn cha tổng để tránh cộng trùng). Để đối chiếu: Tổng phải thu − Đã trả = Còn nợ. */}
                    <p className="text-[10px] text-muted-foreground">Tổng phải thu</p>
                    <p className="font-bold text-sm">{formatVND(customerDetail.totalOwed ?? 0)}</p>
                  </div>
                  <div className="bg-white/60 dark:bg-black/10 rounded-xl p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Đã trả</p>
                    <p className="font-bold text-sm text-green-600">
                      {/* Dùng totalPaid từ BE (nguồn phiếu thu chuẩn): đơn cha tổng — nơi ghi
                          tiền cọc/thu của hợp đồng nhiều dịch vụ — đã bị loại khỏi mảng bookings. */}
                      {formatVND(customerDetail.totalPaid ?? 0)}
                    </p>
                  </div>
                  <div className="bg-white/60 dark:bg-black/10 rounded-xl p-2 text-center">
                    <p className="text-[10px] text-muted-foreground">Còn nợ</p>
                    <p className={`font-bold text-sm ${(customerDetail.totalDebt ?? 0) > 0 ? "text-red-500" : "text-muted-foreground"}`}>
                      {formatVND(customerDetail.totalDebt ?? 0)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
                <div className="space-y-2">
                  {([
                    { label: "Số điện thoại", value: customerDetail.phone ?? undefined, icon: Phone },
                    { label: "Email", value: customerDetail.email, icon: TrendingUp },
                    { label: "Địa chỉ", value: customerDetail.address, icon: MapPin },
                    { label: "Facebook", value: customerDetail.facebook, icon: Facebook },
                    { label: "Zalo", value: customerDetail.zalo, icon: Phone },
                    { label: "Giới tính", value: customerDetail.gender === "male" ? "Nam" : customerDetail.gender === "female" ? "Nữ" : undefined, icon: Users },
                  ] as { label: string; value?: string; icon: React.ElementType }[]).filter(f => f.value).map(f => (
                    <div key={f.label} className="flex items-center gap-2 text-sm">
                      <f.icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="text-muted-foreground text-xs w-24 flex-shrink-0">{f.label}:</span>
                      <span className="font-medium text-xs truncate">{f.value}</span>
                    </div>
                  ))}
                </div>

                {customerDetail.tags && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Tags</p>
                    <div className="flex flex-wrap gap-1">
                      {(typeof customerDetail.tags === "string" ? customerDetail.tags : (customerDetail.tags as unknown as string[]).join(", "))
                        .split(",").map(t => t.trim()).filter(Boolean).map(t => (
                          <span key={t} className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-full">{t}</span>
                        ))}
                    </div>
                  </div>
                )}

                {customerDetail.notes && (
                  <div className="p-3 bg-muted/30 rounded-xl">
                    <p className="font-semibold text-xs text-muted-foreground mb-1">Ghi chú</p>
                    <p className="text-sm">{customerDetail.notes}</p>
                  </div>
                )}

                {customerDetail.bookings && customerDetail.bookings.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-xs text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-2">
                      <Calendar className="w-3.5 h-3.5" /> Lịch sử show ({customerDetail.bookings.length})
                    </h4>
                    <div className="space-y-1.5">
                      {customerDetail.bookings.map(b => {
                        const st = STATUS_LABELS[b.status] ?? { label: b.status, color: "text-muted-foreground" };
                        return (
                          <div key={b.id} className="p-2.5 rounded-xl border bg-muted/20">
                            <div className="flex justify-between items-start">
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-xs truncate">{b.packageType || "Chưa chốt dịch vụ"}</p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">{formatDate(b.shootDate)}</p>
                              </div>
                              <div className="flex flex-col items-end gap-0.5 ml-2">
                                <span className="font-bold text-xs text-primary">{formatVND(b.totalAmount)}</span>
                                <span className={`text-[9px] font-medium ${st.color}`}>{st.label}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <p className="text-xs text-muted-foreground pt-1 border-t">
                  Tham gia: {formatDate(customerDetail.createdAt)}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── Create / Edit Dialog ─────────────────────────────────────────────── */}
      <Dialog open={isOpen} onOpenChange={open => { if (!isSaving) { setIsOpen(open); if (!open) { setFormError(""); setFormSuccess(""); } } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? "Chỉnh sửa khách hàng" : "Thêm khách hàng mới"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
            {/* Error / Success banners */}
            {formError && (
              <div className="flex items-start gap-2 p-3 bg-destructive/10 text-destructive rounded-xl text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{formError}</span>
              </div>
            )}
            {formSuccess && (
              <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/30 text-green-700 rounded-xl text-sm">
                <CheckCircle className="w-4 h-4 flex-shrink-0" />
                <span>{formSuccess}</span>
              </div>
            )}

            {/* Avatar upload */}
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="relative w-16 h-16 rounded-full border-2 border-dashed border-border hover:border-primary overflow-hidden flex items-center justify-center bg-muted/40 transition-colors flex-shrink-0 group"
              >
                {form.avatar ? (
                  <img src={form.avatar} alt="avatar" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center text-primary font-bold text-xl">
                    {form.name ? form.name.charAt(0).toUpperCase() : <Camera className="w-5 h-5 text-muted-foreground" />}
                  </div>
                )}
                <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <Camera className="w-5 h-5 text-white" />
                </div>
              </button>
              <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
              <div className="flex-1">
                <p className="text-sm font-medium">Ảnh đại diện</p>
                <p className="text-xs text-muted-foreground mt-0.5">Bấm để chọn ảnh từ thiết bị (tự nén)</p>
                {form.avatar && (
                  <button type="button" onClick={() => setForm(f => ({ ...f, avatar: "" }))} className="text-xs text-destructive hover:underline mt-1">
                    Xoá ảnh
                  </button>
                )}
              </div>
            </div>

            {/* Fields */}
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground">Họ và tên *</label>
                <Input
                  placeholder="Nguyễn Thị Hoa"
                  value={form.name}
                  onChange={e => { setForm(f => ({ ...f, name: e.target.value })); setFormError(""); }}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Số điện thoại *</label>
                <Input
                  placeholder="0912 345 678"
                  value={form.phone}
                  onChange={e => {
                    const v = e.target.value;
                    setForm(f => ({ ...f, phone: v }));
                    setFormError("");
                    checkPhoneDuplicate(v);
                  }}
                />
                {phoneDuplicate && (
                  <div className="mt-1.5 flex items-center justify-between gap-2 p-2.5 bg-orange-50 border border-orange-300 rounded-xl text-xs">
                    <div className="flex items-center gap-2 text-orange-800">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 text-orange-500" />
                      <span>
                        Khách này đã có: <strong>{phoneDuplicate.name}</strong>
                        {phoneDuplicate.customCode && <> – {phoneDuplicate.customCode}</>}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setIsOpen(false);
                        setSelectedId(phoneDuplicate.id);
                        setPhoneDuplicate(null);
                      }}
                      className="shrink-0 text-orange-700 font-semibold underline hover:text-orange-900"
                    >
                      Xem hồ sơ
                    </button>
                  </div>
                )}
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Giới tính</label>
                <Select value={form.gender} onChange={e => setForm(f => ({ ...f, gender: e.target.value }))}>
                  <option value="">Không chọn</option>
                  <option value="female">Nữ</option>
                  <option value="male">Nam</option>
                </Select>
              </div>
              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground">Email</label>
                <Input placeholder="email@gmail.com" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground">Địa chỉ</label>
                <Input placeholder="TP. Hồ Chí Minh" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Facebook</label>
                <Input placeholder="facebook.com/..." value={form.facebook} onChange={e => setForm(f => ({ ...f, facebook: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Zalo</label>
                <Input placeholder="SĐT Zalo" value={form.zalo} onChange={e => setForm(f => ({ ...f, zalo: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Nguồn khách hàng</label>
                <Select value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))}>
                  {Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Tags (phẩy cách nhau)</label>
                <Input placeholder="Cô dâu, Tái ký" value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground flex items-center justify-between">
                  <span>Phân hạng khách hàng</span>
                  {editingId && suggestedRank !== form.customerRank && suggestedRank !== "new" && (
                    <button
                      type="button"
                      onClick={() => setForm(f => ({ ...f, customerRank: suggestedRank }))}
                      className="text-[10px] text-primary hover:underline font-semibold"
                    >
                      Gợi ý: {RANK_LABELS[suggestedRank]} →
                    </button>
                  )}
                </label>
                <Select value={form.customerRank} onChange={e => setForm(f => ({ ...f, customerRank: e.target.value }))}>
                  {Object.entries(RANK_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </div>
              <div className="col-span-2">
                <label className="text-xs font-medium text-muted-foreground">Ghi chú</label>
                <Textarea rows={2} placeholder="Sở thích, ghi chú đặc biệt..." value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button onClick={handleSubmit} disabled={isSaving} className="flex-1 gap-2">
                {isSaving ? (
                  <><span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Đang lưu...</>
                ) : (
                  editingId ? "Cập nhật" : "Thêm khách hàng"
                )}
              </Button>
              <Button variant="outline" onClick={() => { if (!isSaving) { setIsOpen(false); setFormError(""); setFormSuccess(""); } }}>
                Hủy
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation dialog ────────────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) { setDeleteTarget(null); setDeleteNeedsForce(false); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center gap-2">
              <Trash2 className="w-5 h-5" /> Xóa khách hàng
            </DialogTitle>
          </DialogHeader>
          {deleteTarget && (() => {
            const hasLinked = (deleteTarget.totalBookings ?? 0) > 0 || deleteNeedsForce;
            const isPending = forceDeleteMutation.isPending || deleteMutation.isPending;
            return (
              <div className="space-y-4">
                {hasLinked ? (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 space-y-1">
                    <p className="font-semibold">Cảnh báo: không thể hoàn tác!</p>
                    <p>
                      Khách hàng <span className="font-semibold">{deleteTarget.name}</span>
                      {(deleteTarget.totalBookings ?? 0) > 0
                        ? <> có <span className="font-semibold">{deleteTarget.totalBookings} đơn chụp</span> liên kết.</>
                        : <> có dữ liệu liên kết.</>}
                    </p>
                    <p>Xóa sẽ xóa toàn bộ đơn chụp, hợp đồng, thanh toán và lịch sử liên quan.</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Bạn có chắc muốn xóa khách hàng <span className="font-semibold">{deleteTarget.name}</span>?
                  </p>
                )}
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" size="sm" disabled={isPending} onClick={() => { setDeleteTarget(null); setDeleteNeedsForce(false); }}>
                    Hủy
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={isPending}
                    onClick={() => {
                      if (hasLinked) {
                        forceDeleteMutation.mutate(deleteTarget.id);
                      } else {
                        deleteMutation.mutate(deleteTarget.id);
                      }
                    }}
                  >
                    {isPending ? "Đang xóa..." : hasLinked ? "Xóa tất cả" : "Xóa"}
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
