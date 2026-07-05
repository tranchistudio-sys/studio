import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Plus, Search, Edit2, Trash2, ChevronDown, ChevronRight,
  Package, Tag, Layers, X, Check, AlertCircle,
  ShoppingCart, Eye, EyeOff, GripVertical,
  Camera, BookOpen, MapPin, Star, Sparkles, Palette,
  Film, Heart, Printer, Zap, Pencil, Save, ChevronUp, ArrowUp, ArrowDown
} from "lucide-react";
import { formatVND } from "@/lib/utils";
import {
  previewFinalPrice, discountWindowStatus, statusLabel, discountBadgeText, discountSourceLabel,
  type DiscountResult, type DiscountWindowStatus,
} from "@/lib/discount";
import { parseDescriptionBlocks } from "@/lib/package-description";

// ─── Hiển thị mô tả/ghi chú gói theo block dễ đọc — GIỮ NGUYÊN từng chữ ──────
// Tiêu đề (dòng kết thúc ":") đậm, bullet (*/•) thẳng hàng, dòng kẻ "———" thành
// đường phân cách gọn, dòng giá luôn đứng riêng. Thuần trình bày, không đổi nội dung.
function DescriptionBlocksView({ text, size = "sm", tone = "default" }: { text: string; size?: "xs" | "sm"; tone?: "default" | "amber" }) {
  const base = size === "xs" ? "text-[10px]" : "text-sm";
  const bodyColor = tone === "amber" ? (size === "xs" ? "text-amber-700" : "text-amber-800 dark:text-amber-300") : "";
  const headColor = tone === "amber" ? (size === "xs" ? "text-amber-900" : "text-amber-900 dark:text-amber-200") : "text-foreground";
  const dividerColor = tone === "amber" ? "border-amber-300/60" : "border-border/60";
  return (
    <div className="space-y-0.5">
      {parseDescriptionBlocks(text).map((b, i) =>
        b.type === "divider" ? (
          <div key={i} className={`border-t ${dividerColor} my-1.5`} aria-hidden />
        ) : b.type === "heading" ? (
          <p key={i} className={`${base} ${headColor} font-bold pt-1 first:pt-0`}>{b.text}</p>
        ) : b.type === "bullet" ? (
          <p key={i} className={`${base} ${bodyColor} leading-relaxed pl-3 -indent-3`}>{b.text}</p>
        ) : (
          <p key={i} className={`${base} ${bodyColor} leading-relaxed pt-0.5 first:pt-0`}>{b.text}</p>
        ),
      )}
    </div>
  );
}
import { Button, Input, Badge } from "@/components/ui";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import { MultiImageUploader } from "@/components/cms-shared";
import { getImageSrc } from "@/lib/imageUtils";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type GroupMeta = { Icon: React.ElementType; iconCls: string; bgCls: string; ringCls: string };
const GROUP_META: Record<string, GroupMeta> = {
  "CHỤP CỔNG TẠI STUDIO":  { Icon: Camera,   iconCls: "text-rose-600",    bgCls: "bg-rose-50 dark:bg-rose-950/30",    ringCls: "ring-rose-200 dark:ring-rose-800" },
  "ALBUM TẠI STUDIO":       { Icon: BookOpen,  iconCls: "text-violet-600",  bgCls: "bg-violet-50 dark:bg-violet-950/30", ringCls: "ring-violet-200 dark:ring-violet-800" },
  "ALBUM NGOẠI CẢNH":       { Icon: MapPin,    iconCls: "text-sky-600",     bgCls: "bg-sky-50 dark:bg-sky-950/30",       ringCls: "ring-sky-200 dark:ring-sky-800" },
  "CHỤP TIỆC CƯỚI":         { Icon: Star,      iconCls: "text-amber-600",   bgCls: "bg-amber-50 dark:bg-amber-950/30",   ringCls: "ring-amber-200 dark:ring-amber-800" },
  "BEAUTY / THỜI TRANG":    { Icon: Sparkles,  iconCls: "text-pink-600",    bgCls: "bg-pink-50 dark:bg-pink-950/30",     ringCls: "ring-pink-200 dark:ring-pink-800" },
  "COMBO CÓ MAKEUP":        { Icon: Palette,   iconCls: "text-purple-600",  bgCls: "bg-purple-50 dark:bg-purple-950/30", ringCls: "ring-purple-200 dark:ring-purple-800" },
  "COMBO KHÔNG MAKEUP":     { Icon: Layers,    iconCls: "text-indigo-600",  bgCls: "bg-indigo-50 dark:bg-indigo-950/30", ringCls: "ring-indigo-200 dark:ring-indigo-800" },
  "QUAY PHIM":              { Icon: Film,      iconCls: "text-red-600",     bgCls: "bg-red-50 dark:bg-red-950/30",       ringCls: "ring-red-200 dark:ring-red-800" },
  "CHỤP GIA ĐÌNH":          { Icon: Heart,     iconCls: "text-green-600",   bgCls: "bg-green-50 dark:bg-green-950/30",   ringCls: "ring-green-200 dark:ring-green-800" },
  "MAKEUP LẺ":              { Icon: Zap,       iconCls: "text-fuchsia-600", bgCls: "bg-fuchsia-50 dark:bg-fuchsia-950/30", ringCls: "ring-fuchsia-200 dark:ring-fuchsia-800" },
  "IN ẢNH":                 { Icon: Printer,   iconCls: "text-slate-600",   bgCls: "bg-slate-50 dark:bg-slate-950/30",   ringCls: "ring-slate-200 dark:ring-slate-800" },
};
const DEFAULT_META: GroupMeta = { Icon: Package, iconCls: "text-primary", bgCls: "bg-primary/10", ringCls: "ring-primary/20" };
function getGroupMeta(name: string): GroupMeta { return GROUP_META[name] ?? DEFAULT_META; }

function groupAllRequirePostProduction(pkgs: ServicePackage[]): boolean {
  return pkgs.length > 0 && pkgs.every(p => p.requiresPostProduction !== false);
}

function groupAllRequirePrinting(pkgs: ServicePackage[]): boolean {
  return pkgs.length > 0 && pkgs.every(p => p.requiresPrinting === true);
}

function defaultRequiresPostProductionByGroupName(groupName: string | null | undefined): boolean {
  if (!groupName) return false;
  const n = groupName.trim().toUpperCase();
  const falseGroups = ["MAKEUP LẺ", "IN ẢNH", "COMBO KHÔNG MAKEUP", "COMBO CÓ MAKEUP", "COMBO TRANG PHỤC CƯỚI - CÓ MAKEUP", "COMBO TRANG PHỤC CƯỚI - KHÔNG MAKEUP"];
  if (falseGroups.includes(n) || n.includes("COMBO")) return false;
  const trueGroups = ["CHỤP CỔNG TẠI STUDIO", "ALBUM TẠI STUDIO", "ALBUM NGOẠI CẢNH", "CHỤP TIỆC CƯỚI", "BEAUTY / THỜI TRANG", "CHỤP GIA ĐÌNH", "QUAY PHIM"];
  return trueGroups.includes(n);
}

function defaultRequiresPrintingByGroupName(groupName: string | null | undefined): boolean {
  if (!groupName) return false;
  const n = groupName.trim().toUpperCase();
  return ["ALBUM TẠI STUDIO", "ALBUM NGOẠI CẢNH", "IN ẢNH"].includes(n);
}


type PackageItem = { id?: number; name: string; quantity: string; unit: string; notes: string; sortOrder: number };
type ServicePackage = {
  id: number; groupId: number | null; code: string; name: string;
  price: number;
  printCost: number;         // in ấn
  operatingCost: number;     // vận hành
  salePercent: number;
  description: string; notes: string;
  isActive: boolean; sortOrder: number; items: PackageItem[];
  serviceType?: string | null; photoCount?: number | null;
  addons?: { key: string; name: string; price: number }[];
  products?: string[];
  // Task #383 Bước 2: số ngày hậu kỳ mặc định cho gói (null = chưa cấu hình)
  defaultEditingDays?: number | null;
  requiresPostProduction?: boolean;
  requiresPrinting?: boolean;
  // Chương trình giảm giá riêng gói (field thô để sửa) + kết quả backend tính sẵn.
  discountEnabled?: boolean;
  discountType?: "percent" | "fixed" | null;
  discountValue?: number | null;
  discountStartDate?: string | null;
  discountEndDate?: string | null;
  discountName?: string | null;
  discountDescription?: string | null;
  discount?: DiscountResult; // backend tính sẵn (ưu tiên gói > nhóm) — card chỉ hiển thị
  pkgDiscountStatus?: DiscountWindowStatus;
  groupDiscountStatus?: DiscountWindowStatus;
};
type DiscountFields = {
  discountEnabled?: boolean; discountType?: "percent" | "fixed" | null; discountValue?: number | null;
  discountStartDate?: string | null; discountEndDate?: string | null;
  discountName?: string | null; discountDescription?: string | null;
};
type ServiceGroup = {
  id: number; name: string; description: string; isActive: boolean; sortOrder: number;
  aiImageUrl?: string | null; publicForCustomer?: boolean;
  discountStatus?: DiscountWindowStatus;
} & DiscountFields;
type Surcharge = { id: number; name: string; category: string; price: number; unit: string; description: string; isActive: boolean; sortOrder: number };

const UNIT_OPTIONS = ["lần", "buổi", "bàn", "tấm", "km", "người", "bộ", "cuốn", "trang", "ảnh", "clip", "ngày"];

function formatVNDShort(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}tr`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

function getAuthToken(token: string | null): string | null {
  return token ?? (typeof localStorage !== "undefined" ? localStorage.getItem("amazingStudioToken_v2") : null);
}

function normalizeServicePackage(p: ServicePackage & { requires_printing?: boolean | null }): ServicePackage {
  const rawPrint = p.requiresPrinting ?? p.requires_printing;
  return {
    ...p,
    requiresPrinting: rawPrint === true || rawPrint === 1 || rawPrint === "1",
    requiresPostProduction: p.requiresPostProduction !== false && p.requiresPostProduction !== 0,
  };
}

function mergePackagesIntoCache(
  qc: ReturnType<typeof useQueryClient>,
  updatedList: ServicePackage[],
) {
  const map = new Map(updatedList.map(p => [p.id, normalizeServicePackage(p)]));
  qc.setQueryData<ServicePackage[]>(["service-packages"], (old) =>
    (old ?? []).map(p => {
      const u = map.get(p.id);
      return u ? { ...p, ...u } : p;
    }),
  );
}

export default function PricingPage() {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  // Module Dịch vụ & Bảng giá: mở toàn quyền cho mọi nhân viên — luôn coi như admin
  // ở trang này để hiển thị tất cả nút Tạo / Sửa / Xoá / inline edit.
  const { token } = useStaffAuth();
  const effectiveIsAdmin = true;
  const authHeaders = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const [tab, setTab] = useState<"packages" | "surcharges" | "groups">("packages");
  const [search, setSearch] = useState("");
  const [filterGroup, setFilterGroup] = useState<number | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const [selectedPkg, setSelectedPkg] = useState<ServicePackage | null>(null);

  const [showPkgModal, setShowPkgModal] = useState(false);
  const [editingPkg, setEditingPkg] = useState<ServicePackage | null>(null);
  const [showSurchargeModal, setShowSurchargeModal] = useState(false);
  const [editingSurcharge, setEditingSurcharge] = useState<Surcharge | null>(null);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ServiceGroup | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<ServiceGroup | null>(null);
  const [showAllFilterGroups, setShowAllFilterGroups] = useState(false);

  // ── Inline edit state ──────────────────────────────────────────────────────
  const [inlineEdit, setInlineEdit] = useState<"description" | "notes" | "items" | null>(null);
  const [draftDesc, setDraftDesc] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [draftItems, setDraftItems] = useState<PackageItem[]>([]);

  // Sync drafts when selectedPkg changes
  useEffect(() => {
    if (selectedPkg) {
      setDraftDesc(selectedPkg.description ?? "");
      setDraftNotes(selectedPkg.notes ?? "");
      setDraftItems(selectedPkg.items?.map(i => ({ ...i })) ?? []);
    }
    setInlineEdit(null);
  }, [selectedPkg?.id]);

  const { data: groups = [] } = useQuery<ServiceGroup[]>({
    queryKey: ["service-groups"],
    queryFn: () => fetch(`${BASE}/api/service-groups`, { headers: authHeaders }).then(r => r.json()),
  });
  const { data: packages = [], isLoading: pkgLoading } = useQuery<ServicePackage[]>({
    queryKey: ["service-packages"],
    queryFn: () => fetch(`${BASE}/api/service-packages`, { headers: authHeaders })
      .then(r => r.json())
      .then((rows: ServicePackage[]) => Array.isArray(rows) ? rows.map(normalizeServicePackage) : []),
  });
  const { data: surcharges = [] } = useQuery<Surcharge[]>({
    queryKey: ["surcharges"],
    queryFn: () => fetch(`${BASE}/api/surcharges`, { headers: authHeaders }).then(r => r.json()),
  });

  const allExpanded = useMemo(() => {
    if (expandedGroups.size === 0 && packages.length > 0) {
      const ids = new Set<number>();
      packages.forEach(p => { if (p.groupId) ids.add(p.groupId); });
      return ids;
    }
    return expandedGroups;
  }, [expandedGroups, packages]);

  const toggleGroup = (id: number) => {
    setExpandedGroups(prev => {
      const s = new Set(prev.size === 0 ? allExpanded : prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  };

  const isGroupExpanded = (id: number) => allExpanded.has(id);

  const filteredPackages = useMemo(() => {
    return packages.filter(p => {
      if (filterGroup !== null && p.groupId !== filterGroup) return false;
      if (search) {
        const q = search.toLowerCase();
        return p.name.toLowerCase().includes(q) || (p.code ?? "").toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q);
      }
      return true;
    });
  }, [packages, filterGroup, search]);

  const groupedPackages = useMemo(() => {
    const map = new Map<number, ServicePackage[]>();
    filteredPackages.forEach(p => {
      const gid = p.groupId ?? 0;
      if (!map.has(gid)) map.set(gid, []);
      map.get(gid)!.push(p);
    });
    return map;
  }, [filteredPackages]);

  const deletePkg = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/service-packages/${id}`, { method: "DELETE", headers: authHeaders }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["service-packages"] }); setSelectedPkg(null); },
  });
  const togglePkgActive = useMutation({
    mutationFn: (pkg: ServicePackage) => fetch(`${BASE}/api/service-packages/${pkg.id}`, {
      method: "PUT", headers: authHeaders,
      body: JSON.stringify({ isActive: !pkg.isActive }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["service-packages"] }),
  });
  const updatePkgInline = useMutation({
    mutationFn: (payload: { id: number; [key: string]: unknown }) => {
      const { id, ...data } = payload;
      const tok = getAuthToken(token);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tok) headers.Authorization = `Bearer ${tok}`;
      return fetch(`${BASE}/api/service-packages/${id}`, {
        method: "PUT", headers,
        body: JSON.stringify(data),
      }).then(async r => {
        if (!r.ok) {
          const ct = r.headers.get("content-type") ?? "";
          if (ct.includes("application/json")) {
            const body = await r.json().catch(() => ({})) as Record<string, unknown>;
            throw new Error((body.error as string) ?? "Lỗi lưu gói");
          }
          throw new Error(`Lỗi lưu gói (${r.status})`);
        }
        return r.json() as Promise<ServicePackage>;
      });
    },
    onMutate: async (payload) => {
      const { id, ...data } = payload;
      await qc.cancelQueries({ queryKey: ["service-packages"] });
      const prev = qc.getQueryData<ServicePackage[]>(["service-packages"]);
      qc.setQueryData<ServicePackage[]>(["service-packages"], (old) =>
        (old ?? []).map(p => p.id === id ? { ...p, ...data } : p),
      );
      if (selectedPkg?.id === id) setSelectedPkg(sp => sp ? { ...sp, ...data } : sp);
      return { prev };
    },
    onSuccess: (updated: ServicePackage) => {
      mergePackagesIntoCache(qc, [normalizeServicePackage(updated)]);
      setSelectedPkg(normalizeServicePackage(updated));
      setInlineEdit(null);
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["service-packages"], ctx.prev);
      alert("Lưu thất bại: " + err.message);
    },
  });

  const toggleGroupPrinting = useMutation({
    mutationFn: async ({ packageIds, enable }: { packageIds: number[]; enable: boolean }) => {
      const tok = getAuthToken(token);
      if (!tok) throw new Error("Chưa đăng nhập — vui lòng đăng nhập lại");
      if (packageIds.length === 0) throw new Error("Nhóm không có gói dịch vụ");
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tok}` };
      return Promise.all(packageIds.map(id =>
        fetch(`${BASE}/api/service-packages/${id}`, {
          method: "PUT", headers,
          body: JSON.stringify({ requiresPrinting: enable }),
        }).then(async r => {
          if (!r.ok) {
            const ct = r.headers.get("content-type") ?? "";
            if (ct.includes("application/json")) {
              const body = await r.json().catch(() => ({})) as Record<string, unknown>;
              throw new Error(String(body.error ?? "Lỗi lưu gói"));
            }
            throw new Error(`Lỗi lưu gói (${r.status})`);
          }
          return r.json() as Promise<ServicePackage>;
        }),
      ));
    },
    onMutate: async ({ packageIds, enable }) => {
      await qc.cancelQueries({ queryKey: ["service-packages"] });
      const prev = qc.getQueryData<ServicePackage[]>(["service-packages"]);
      qc.setQueryData<ServicePackage[]>(["service-packages"], (old) =>
        (old ?? []).map(p => packageIds.includes(p.id) ? { ...p, requiresPrinting: enable } : p),
      );
      if (selectedPkg && packageIds.includes(selectedPkg.id)) {
        setSelectedPkg(sp => sp ? { ...sp, requiresPrinting: enable } : sp);
      }
      return { prev };
    },
    onSuccess: (results: ServicePackage[]) => {
      mergePackagesIntoCache(qc, results.map(normalizeServicePackage));
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["service-packages"], ctx.prev);
      alert("Lưu thất bại: " + err.message);
    },
  });

  const toggleGroupPostProduction = useMutation({
    mutationFn: async ({ packageIds, groupId, enable }: { packageIds: number[]; groupId: number; enable: boolean }) => {
      const tok = getAuthToken(token);
      if (!tok) throw new Error("Chưa đăng nhập — vui lòng đăng nhập lại");
      if (packageIds.length === 0) throw new Error("Nhóm không có gói dịch vụ");
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tok}` };
      const results = await Promise.all(packageIds.map(id =>
        fetch(`${BASE}/api/service-packages/${id}`, {
          method: "PUT", headers,
          body: JSON.stringify({ requiresPostProduction: enable }),
        }).then(async r => {
          if (!r.ok) {
            const ct = r.headers.get("content-type") ?? "";
            if (ct.includes("application/json")) {
              const body = await r.json().catch(() => ({})) as Record<string, unknown>;
              throw new Error((body.error as string) ?? "Lỗi lưu gói");
            }
            throw new Error(`Lỗi lưu gói (${r.status})`);
          }
          return r.json() as Promise<ServicePackage>;
        })
      ));
      return { groupId, enable, results };
    },
    onMutate: async ({ packageIds, enable }) => {
      await qc.cancelQueries({ queryKey: ["service-packages"] });
      const prev = qc.getQueryData<ServicePackage[]>(["service-packages"]);
      if (prev) {
        const idSet = new Set(packageIds);
        qc.setQueryData<ServicePackage[]>(["service-packages"], prev.map(p =>
          idSet.has(p.id) ? { ...p, requiresPostProduction: enable } : p
        ));
      }
      return { prev };
    },
    onSuccess: ({ groupId, enable, results }) => {
      mergePackagesIntoCache(qc, (results as ServicePackage[]).map(normalizeServicePackage));
      setSelectedPkg(prev => prev && prev.groupId === groupId ? { ...prev, requiresPostProduction: enable } : prev);
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["service-packages"], ctx.prev);
      alert("Lưu thất bại: " + err.message);
    },
  });
  const deleteSurcharge = useMutation({
    mutationFn: (id: number) => fetch(`${BASE}/api/surcharges/${id}`, { method: "DELETE", headers: authHeaders }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["surcharges"] }),
  });
  const toggleSurchargeActive = useMutation({
    mutationFn: (s: Surcharge) => fetch(`${BASE}/api/surcharges/${s.id}`, {
      method: "PUT", headers: authHeaders,
      body: JSON.stringify({ isActive: !s.isActive }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["surcharges"] }),
  });
  const surchargesByCategory = useMemo(() => {
    const map = new Map<string, Surcharge[]>();
    surcharges.forEach(s => {
      const cat = s.category ?? "Khác";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(s);
    });
    return map;
  }, [surcharges]);

  return (
    <div className="flex h-full gap-6 -mx-4 sm:-mx-6 lg:-mx-8 -my-4 sm:-my-6 lg:-my-8 overflow-hidden">
      {/* Left Panel */}
      <div className={`flex flex-col ${selectedPkg ? "hidden lg:flex lg:w-[calc(100%-440px)]" : "w-full"} overflow-hidden`}>
        {/* Header */}
        <div className="px-4 sm:px-6 lg:px-8 pt-4 sm:pt-6 lg:pt-8 pb-4 flex-shrink-0">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Danh mục bảng giá</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Quản lý gói dịch vụ, phụ phí và nhóm dịch vụ</p>
            </div>
            <div className="flex items-center gap-2">
              {!effectiveIsAdmin && (
                <Badge variant="outline" className="text-xs text-muted-foreground border-muted-foreground/40 px-2 py-1">
                  Chỉ xem
                </Badge>
              )}
              {effectiveIsAdmin && tab === "packages" && (
                <Button onClick={() => { setEditingPkg(null); setShowPkgModal(true); }} className="gap-1.5 text-sm">
                  <Plus className="w-4 h-4" /> Tạo gói mới
                </Button>
              )}
              {effectiveIsAdmin && tab === "surcharges" && (
                <Button onClick={() => { setEditingSurcharge(null); setShowSurchargeModal(true); }} className="gap-1.5 text-sm">
                  <Plus className="w-4 h-4" /> Thêm phụ phí
                </Button>
              )}
              {effectiveIsAdmin && tab === "groups" && (
                <Button onClick={() => { setEditingGroup(null); setShowGroupModal(true); }} className="gap-1.5 text-sm">
                  <Plus className="w-4 h-4" /> Thêm nhóm
                </Button>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit mb-4">
            {[
              { key: "packages", icon: Package, label: "Gói dịch vụ", count: packages.length },
              { key: "surcharges", icon: Tag, label: "Phụ phí", count: surcharges.length },
              { key: "groups", icon: Layers, label: "Nhóm dịch vụ", count: groups.length },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => { setTab(t.key as typeof tab); setSelectedPkg(null); }}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t.key ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                <t.icon className="w-4 h-4" />
                <span>{t.label}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === t.key ? "bg-primary/10 text-primary" : "bg-muted"}`}>{t.count}</span>
              </button>
            ))}
          </div>

          {/* Search + Filter */}
          {tab === "packages" && (
            <div className="flex flex-col gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  className="pl-9 h-9 text-sm"
                  placeholder="Tìm tên gói, mã gói..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="flex gap-1.5 flex-wrap items-center">
                <button
                  onClick={() => setFilterGroup(null)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${filterGroup === null ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"}`}
                >
                  <Package className="w-3 h-3" /> Tất cả
                </button>
                {(showAllFilterGroups ? groups : groups.slice(0, 8)).map(g => {
                  const meta = getGroupMeta(g.name);
                  const active = filterGroup === g.id;
                  return (
                    <button
                      key={g.id}
                      onClick={() => setFilterGroup(g.id === filterGroup ? null : g.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                        active ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <meta.Icon className="w-3 h-3" /> {g.name}
                    </button>
                  );
                })}
                {groups.length > 8 && (
                  <button
                    onClick={() => setShowAllFilterGroups(v => !v)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-muted/50 hover:bg-muted transition-colors text-muted-foreground border border-dashed border-border"
                  >
                    {showAllFilterGroups ? "Thu gọn" : `+${groups.length - 8} nhóm`}
                    <ChevronDown className={`w-3 h-3 transition-transform ${showAllFilterGroups ? "rotate-180" : ""}`} />
                  </button>
                )}
              </div>
            </div>
          )}
          {tab === "surcharges" && (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input className="pl-9 h-9 text-sm" placeholder="Tìm phụ phí..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 pb-8">
          {tab === "packages" && (
            <div className="space-y-4">
              {pkgLoading ? (
                <div className="text-center py-12 text-muted-foreground">Đang tải...</div>
              ) : groups.map(group => {
                const pkgsInGroup = groupedPackages.get(group.id) ?? [];
                if (pkgsInGroup.length === 0 && (filterGroup !== null || search)) return null;
                if (pkgsInGroup.length === 0 && !filterGroup && !search) return null;
                const expanded = isGroupExpanded(group.id);
                const meta = getGroupMeta(group.name);
                const allPkgsInGroup = packages.filter(p => p.groupId === group.id);
                const groupHasPostProduction = groupAllRequirePostProduction(allPkgsInGroup);
                const groupPostMixed = allPkgsInGroup.some(p => p.requiresPostProduction === false) && allPkgsInGroup.some(p => p.requiresPostProduction !== false);
                const groupHasPrinting = groupAllRequirePrinting(allPkgsInGroup);
                const groupPrintMixed = allPkgsInGroup.some(p => p.requiresPrinting !== true) && allPkgsInGroup.some(p => p.requiresPrinting === true);
                return (
                  <div key={group.id} className="border border-border rounded-xl overflow-hidden bg-card">
                    <div className="flex items-center justify-between px-4 py-3 bg-muted/20 hover:bg-muted/40 transition-colors gap-3">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.id)}
                        className="flex flex-1 items-center justify-between min-w-0"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-8 h-8 rounded-lg ${meta.bgCls} ring-1 ${meta.ringCls} flex items-center justify-center flex-shrink-0`}>
                            <meta.Icon className={`w-4 h-4 ${meta.iconCls}`} />
                          </div>
                          <div className="text-left min-w-0">
                            <p className="font-semibold text-sm truncate">{group.name}</p>
                            <p className="text-xs text-muted-foreground">{pkgsInGroup.length} gói</p>
                          </div>
                        </div>
                        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                      </button>
                      {effectiveIsAdmin && pkgsInGroup.length > 0 && (
                        <div className="relative z-10 flex items-center gap-2 flex-shrink-0 pl-2 border-l border-border/60">
                          {/* Gắn ảnh bảng giá cho nhóm (Sale AI gửi khách) — bấm mở modal upload */}
                          <button
                            type="button"
                            title={group.aiImageUrl ? "Đổi / xoá ảnh bảng giá nhóm" : "Gắn ảnh bảng giá cho nhóm (Sale AI gửi khách)"}
                            aria-label={`Gắn ảnh bảng giá cho nhóm ${group.name}`}
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); setEditingGroup(group); setShowGroupModal(true); }}
                            className="flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-muted transition-colors"
                          >
                            {group.aiImageUrl ? (
                              <img src={getImageSrc(group.aiImageUrl) ?? ""} alt="" className="w-7 h-7 rounded object-cover ring-1 ring-border" />
                            ) : (
                              <span className="flex items-center gap-1 text-[10px] font-medium text-sky-600">
                                <Camera className="w-4 h-4" /><span className="hidden lg:inline">Gắn hình</span>
                              </span>
                            )}
                          </button>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium hidden sm:inline ${
                            groupPostMixed ? "bg-amber-100 text-amber-800" : groupHasPostProduction ? "bg-sky-100 text-sky-700" : "bg-muted text-muted-foreground"
                          }`}>
                            {groupPostMixed ? "HK lẫn" : groupHasPostProduction ? "Hậu kỳ" : "Không HK"}
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={groupHasPostProduction}
                            aria-label={`Bật tắt hậu kỳ cho nhóm ${group.name}`}
                            disabled={toggleGroupPostProduction.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              toggleGroupPostProduction.mutate({
                                groupId: group.id,
                                packageIds: allPkgsInGroup.map(p => p.id),
                                enable: !groupHasPostProduction,
                              });
                            }}
                            className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                              groupHasPostProduction ? "bg-primary" : "bg-muted-foreground/30"
                            }`}
                          >
                            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-1 ${
                              groupHasPostProduction ? "translate-x-6" : "translate-x-1"
                            }`} />
                          </button>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium hidden md:inline ${
                            groupPrintMixed ? "bg-amber-100 text-amber-800" : groupHasPrinting ? "bg-rose-100 text-rose-700" : "bg-muted text-muted-foreground"
                          }`} title="Có in hình / chỉ chỉnh ảnh">
                            {groupPrintMixed ? "In lẫn" : groupHasPrinting ? "Có in" : "Không in"}
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={groupHasPrinting}
                            aria-label={`Bật tắt in hình cho nhóm ${group.name}`}
                            disabled={toggleGroupPrinting.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                              toggleGroupPrinting.mutate({
                                packageIds: allPkgsInGroup.map(p => p.id),
                                enable: !groupHasPrinting,
                              });
                            }}
                            className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                              groupHasPrinting ? "bg-rose-400" : "bg-muted-foreground/30"
                            }`}
                          >
                            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-1 ${
                              groupHasPrinting ? "translate-x-6" : "translate-x-1"
                            }`} />
                          </button>
                          {/* Ưu đãi nhóm (mở GroupModal — có section giảm giá nhóm) */}
                          <button
                            type="button"
                            title="Chương trình giảm giá cho cả nhóm"
                            aria-label={`Chương trình giảm giá nhóm ${group.name}`}
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); setEditingGroup(group); setShowGroupModal(true); }}
                            className={`flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-muted transition-colors ${group.discountStatus === "active" ? "text-rose-600" : "text-muted-foreground"}`}
                          >
                            <Tag className="w-4 h-4" />
                            {group.discountStatus === "active" && <span className="hidden lg:inline text-[10px] font-medium">Đang giảm</span>}
                          </button>
                          {/* Xoá / ẩn nhóm (an toàn — không xoá thẳng nhóm còn gói) */}
                          <button
                            type="button"
                            title="Xoá / ẩn nhóm"
                            aria-label={`Xoá hoặc ẩn nhóm ${group.name}`}
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); setDeletingGroup(group); }}
                            className="flex items-center rounded-lg px-1.5 py-1 hover:bg-destructive/10 text-destructive/70 hover:text-destructive transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    {expanded && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 p-3">
                        {pkgsInGroup.map(pkg => (
                          <button
                            key={pkg.id}
                            onClick={() => setSelectedPkg(selectedPkg?.id === pkg.id ? null : pkg)}
                            className={`text-left p-4 rounded-xl border transition-all hover:shadow-md ${
                              selectedPkg?.id === pkg.id
                                ? "border-primary bg-primary/5 shadow-md"
                                : "border-border bg-background hover:border-primary/30"
                            } ${!pkg.isActive ? "opacity-60" : ""}`}
                          >
                            <div className="flex items-start justify-between mb-2">
                              <div>
                                <p className="font-semibold text-sm flex items-center gap-1.5 flex-wrap">{pkg.name}{pkg.requiresPostProduction === false ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">Không HK</span> : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 font-medium">Hậu kỳ</span>}</p>
                                {pkg.code && <p className="text-xs text-muted-foreground">{pkg.code}</p>}
                                {/* Badge loại dịch vụ & số photo */}
                                {pkg.serviceType && (() => {
                                  const typeLabel: Record<string, string> = {
                                    tiec: "🎊 Tiệc cưới", tiec_le: "🎊 Tiệc + Lễ",
                                    phong_su: "📸 Phóng sự", phong_su_luxury: "📸 Phóng sự luxury",
                                    combo_co_makeup: "💄 Có makeup", combo_khong_makeup: "👗 Không makeup",
                                    quay_phim: "🎬 Quay phim", beauty: "✨ Beauty",
                                    gia_dinh: "👨‍👩‍👧 Gia đình", makeup_le: "💋 Makeup lẻ",
                                    in_anh: "🖨️ In ảnh",
                                  };
                                  const isCombo = pkg.serviceType?.startsWith("combo");
                                  const isNoPhoto = ["makeup_le", "in_anh"].includes(pkg.serviceType ?? "");
                                  return (
                                    <div className="flex flex-wrap gap-1 mt-1">
                                      <span className="text-[9px] px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded-full font-semibold">{typeLabel[pkg.serviceType!] ?? pkg.serviceType}</span>
                                      {!isCombo && !isNoPhoto && (pkg.photoCount ?? 0) > 0 && <span className="text-[9px] px-1.5 py-0.5 bg-sky-100 text-sky-700 rounded-full font-semibold">📷 {pkg.photoCount ?? 1} photographer</span>}
                                    </div>
                                  );
                                })()}
                              </div>
                              {!pkg.isActive && <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded text-muted-foreground">Ẩn</span>}
                            </div>
                            {pkg.discount?.discountApplied ? (
                              <div className="mb-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="text-xl font-bold text-rose-600">{formatVND(pkg.discount.finalPrice)}</p>
                                  <p className="text-sm line-through text-muted-foreground">{formatVND(pkg.price)}</p>
                                </div>
                                <span className="inline-flex items-center gap-1 mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200">
                                  🏷️ {discountBadgeText(pkg.discount)} · {discountSourceLabel(pkg.discount)}
                                </span>
                                {pkg.discount.discountName && (
                                  <p className="text-[10px] text-rose-600 mt-0.5">
                                    {pkg.discount.discountName}{pkg.discount.discountEndDate ? ` · đến ${new Date(pkg.discount.discountEndDate).toLocaleDateString("vi-VN")}` : ""}
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p className="text-xl font-bold text-primary mb-1">{formatVND(pkg.price)}</p>
                            )}
                            {!pkg.discount?.discountApplied && (pkg.pkgDiscountStatus === "scheduled" || pkg.pkgDiscountStatus === "expired") && (
                              <span className={`inline-block mb-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${pkg.pkgDiscountStatus === "scheduled" ? "bg-amber-100 text-amber-700" : "bg-neutral-200 text-neutral-600"}`}>
                                {pkg.pkgDiscountStatus === "scheduled" ? "🏷️ Ưu đãi sắp áp dụng" : "🏷️ Ưu đãi đã hết hạn"}
                              </span>
                            )}
                            {/* Chi phí sản xuất */}
                            {(pkg.printCost > 0 || pkg.operatingCost > 0 || pkg.salePercent > 0) && (
                              <div className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
                                {pkg.printCost > 0 && <p>🖨️ In ấn: {formatVNDShort(pkg.printCost)}</p>}
                                {pkg.operatingCost > 0 && <p>⚡ Vận hành: {formatVNDShort(pkg.operatingCost)}</p>}
                                {pkg.salePercent > 0 && <p>💼 Sale: {pkg.salePercent}%</p>}
                                <p className="text-[10px] text-sky-600">👤 Cast theo nhân sự</p>
                              </div>
                            )}
                            {pkg.description && (
                              <div className="mt-2 bg-amber-50 rounded-lg px-2 py-1.5">
                                <p className="text-[10px] font-semibold text-amber-800 mb-0.5">📋 Mô tả</p>
                                <DescriptionBlocksView text={pkg.description} size="xs" tone="amber" />
                                {pkg.notes && (
                                  <div className="flex gap-1 mt-1 text-orange-700 font-medium">
                                    <span className="text-[10px] flex-shrink-0">⚠️</span>
                                    <DescriptionBlocksView text={pkg.notes} size="xs" tone="amber" />
                                  </div>
                                )}
                              </div>
                            )}
                            {!pkg.description && pkg.items.length > 0 && (
                              <p className="text-xs text-muted-foreground mt-1.5">{pkg.items.length} hạng mục</p>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {filteredPackages.length === 0 && !pkgLoading && (
                <div className="text-center py-16 text-muted-foreground">
                  <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>Không tìm thấy gói dịch vụ</p>
                </div>
              )}
            </div>
          )}

          {tab === "surcharges" && (
            <div className="space-y-4">
              {Array.from(surchargesByCategory.entries()).map(([cat, list]) => {
                const filtered = search ? list.filter(s => s.name.toLowerCase().includes(search.toLowerCase())) : list;
                if (!filtered.length) return null;
                return (
                  <div key={cat} className="border border-border rounded-xl overflow-hidden bg-card">
                    <div className="px-4 py-2.5 bg-muted/30 border-b border-border">
                      <p className="font-semibold text-sm">{cat}</p>
                    </div>
                    <div className="divide-y divide-border">
                      {filtered.map(s => (
                        <div key={s.id} className={`flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors ${!s.isActive ? "opacity-60" : ""}`}>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{s.name}</p>
                            {s.description && <p className="text-xs text-muted-foreground truncate">{s.description}</p>}
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="font-bold text-primary text-sm">+{formatVND(s.price)}</p>
                            <p className="text-xs text-muted-foreground">/ {s.unit}</p>
                          </div>
                          {effectiveIsAdmin && (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => toggleSurchargeActive.mutate(s)}
                                className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
                                title={s.isActive ? "Ẩn" : "Hiện"}
                              >
                                {s.isActive ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                              </button>
                              <button
                                onClick={() => { setEditingSurcharge(s); setShowSurchargeModal(true); }}
                                className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => { if (confirm("Xoá phụ phí này?")) deleteSurcharge.mutate(s.id); }}
                                className="p-1.5 rounded-lg hover:bg-destructive/10 transition-colors text-destructive/70 hover:text-destructive"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {surcharges.length === 0 && (
                <div className="text-center py-16 text-muted-foreground">
                  <Tag className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>Chưa có phụ phí nào</p>
                </div>
              )}
            </div>
          )}

          {tab === "groups" && (
            <div className="space-y-2">
              {groups.map(g => {
                const count = packages.filter(p => p.groupId === g.id).length;
                const meta = getGroupMeta(g.name);
                return (
                  <div key={g.id} className={`flex items-center gap-3 p-4 rounded-xl border border-border bg-card hover:border-primary/20 transition-colors ${!g.isActive ? "opacity-60" : ""}`}>
                    {g.aiImageUrl ? (
                      <img
                        src={getImageSrc(g.aiImageUrl) ?? ""}
                        alt={g.name}
                        className="w-10 h-10 rounded-xl object-cover flex-shrink-0 ring-1 ring-border"
                      />
                    ) : (
                      <div className={`w-10 h-10 rounded-xl ${meta.bgCls} ring-1 ${meta.ringCls} flex items-center justify-center flex-shrink-0`}>
                        <meta.Icon className={`w-5 h-5 ${meta.iconCls}`} />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold">{g.name}</p>
                        {!g.isActive && <Badge variant="outline" className="text-[10px] px-1.5 py-0">Ẩn</Badge>}
                        {g.discountStatus === "active" && <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-rose-600 border-rose-300">🏷️ Đang giảm</Badge>}
                        {g.discountStatus === "scheduled" && <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-600 border-amber-300">🏷️ Sắp áp dụng</Badge>}
                        {g.discountStatus === "expired" && <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-neutral-500">🏷️ Hết hạn</Badge>}
                        {g.aiImageUrl && (
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 gap-1 ${g.publicForCustomer === false ? "text-muted-foreground" : "text-emerald-600 border-emerald-300"}`}>
                            🖼️ {g.publicForCustomer === false ? "Ảnh (tắt gửi)" : "Ảnh AI"}
                          </Badge>
                        )}
                      </div>
                      {g.description && <p className="text-sm text-muted-foreground truncate">{g.description}</p>}
                      <p className="text-xs text-muted-foreground mt-0.5">{count} gói dịch vụ · thứ tự {g.sortOrder}</p>
                    </div>
                    {effectiveIsAdmin && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => { setEditingGroup(g); setShowGroupModal(true); }}
                          className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setDeletingGroup(g)}
                          title="Xoá / ẩn nhóm"
                          className="p-2 rounded-lg hover:bg-destructive/10 transition-colors text-destructive/70 hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right Detail Panel */}
      {selectedPkg && (
        <div className="w-full lg:w-[420px] flex-shrink-0 border-l border-border bg-card flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
            <div>
              <p className="font-bold text-base">{selectedPkg.name}</p>
              <p className="text-xs text-muted-foreground">{selectedPkg.code} · {groups.find(g => g.id === selectedPkg.groupId)?.name}</p>
            </div>
            <div className="flex items-center gap-1">
              {effectiveIsAdmin && (
                <>
                  <button
                    onClick={() => { setEditingPkg(selectedPkg); setShowPkgModal(true); }}
                    className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => { if (confirm("Xoá gói này?")) deletePkg.mutate(selectedPkg.id); }}
                    className="p-2 rounded-lg hover:bg-destructive/10 transition-colors text-destructive/70 hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
              <button onClick={() => setSelectedPkg(null)} className="p-2 rounded-lg hover:bg-muted transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* Price info + cost breakdown */}
            <div className="p-4 bg-primary/5 rounded-xl border border-primary/10">
              <p className="text-xs text-muted-foreground mb-1">Giá bán</p>
              <p className="text-2xl font-bold text-primary">{formatVND(selectedPkg.price)}</p>
            </div>
            {/* Chi phí sản xuất chuẩn */}
            <div className="p-4 bg-muted/30 rounded-xl border border-border space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">📦 Chi phí sản xuất chuẩn</p>
              <div className="space-y-1.5 text-sm">
                {[
                  { icon: "🖨️", label: "In ấn", val: selectedPkg.printCost },
                  { icon: "⚡", label: "Vận hành", val: selectedPkg.operatingCost },
                ].map(({ icon, label, val }) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-muted-foreground">{icon} {label}</span>
                    <span className={val > 0 ? "" : "text-muted-foreground/40"}>{val > 0 ? formatVND(val) : "—"}</span>
                  </div>
                ))}
                {selectedPkg.salePercent > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">💼 Sale ({selectedPkg.salePercent}%)</span>
                    <span>≈ {formatVND(Math.round(selectedPkg.price * selectedPkg.salePercent / 100))}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-sky-600">👤 Cast nhân sự</span>
                  <span className="text-sky-600 italic">Xem bảng lương nhân viên</span>
                </div>
              </div>
            </div>

            {/* Tiến độ hậu kỳ — bật/tắt nhanh tại panel chi tiết */}
            <div className="flex items-center justify-between p-4 bg-muted/30 rounded-xl border border-border">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">🎨 Tiến độ hậu kỳ</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {selectedPkg.requiresPostProduction !== false
                    ? "Có đưa vào Tiến độ hậu kỳ"
                    : "Không đưa vào Tiến độ hậu kỳ"}
                </p>
                <p className="text-[10px] text-muted-foreground/80 mt-1">Booking mới từ gói này {selectedPkg.requiresPostProduction !== false ? "sẽ" : "không"} tạo job hậu kỳ</p>
              </div>
              {effectiveIsAdmin ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={selectedPkg.requiresPostProduction !== false}
                  disabled={updatePkgInline.isPending}
                  onClick={() => updatePkgInline.mutate({
                    id: selectedPkg.id,
                    requiresPostProduction: selectedPkg.requiresPostProduction === false,
                  })}
                  className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                    selectedPkg.requiresPostProduction !== false ? "bg-primary" : "bg-muted-foreground/30"
                  }`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-1 ${
                    selectedPkg.requiresPostProduction !== false ? "translate-x-6" : "translate-x-1"
                  }`} />
                </button>
              ) : (
                <span className={`text-[10px] px-2 py-1 rounded-full font-medium ${
                  selectedPkg.requiresPostProduction !== false ? "bg-sky-100 text-sky-700" : "bg-muted text-muted-foreground"
                }`}>
                  {selectedPkg.requiresPostProduction !== false ? "Hậu kỳ" : "Không HK"}
                </span>
              )}
            </div>

            {/* Có in hình — bật/tắt nhanh tại panel chi tiết */}
            <div className="flex items-center justify-between p-4 bg-muted/30 rounded-xl border border-border">
              <div>
                <p className="text-xs font-semibold text-muted-foreground">🖨️ Có in hình</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {selectedPkg.requiresPrinting === true
                    ? "Đơn cần theo dõi xuất in"
                    : "Chỉ chỉnh ảnh — không cần in"}
                </p>
                <p className="text-[10px] text-muted-foreground/80 mt-1">
                  Tiến độ HK {selectedPkg.requiresPrinting === true ? "hiện" : "ẩn"} mục「Đã xuất in / hoàn thành」
                </p>
              </div>
              {effectiveIsAdmin ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={selectedPkg.requiresPrinting === true}
                  disabled={updatePkgInline.isPending}
                  onClick={() => updatePkgInline.mutate({
                    id: selectedPkg.id,
                    requiresPrinting: selectedPkg.requiresPrinting !== true,
                  })}
                  className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                    selectedPkg.requiresPrinting === true ? "bg-rose-400" : "bg-muted-foreground/30"
                  }`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-1 ${
                    selectedPkg.requiresPrinting === true ? "translate-x-6" : "translate-x-1"
                  }`} />
                </button>
              ) : (
                <span className={`text-[10px] px-2 py-1 rounded-full font-medium ${
                  selectedPkg.requiresPrinting === true ? "bg-rose-100 text-rose-700" : "bg-muted text-muted-foreground"
                }`}>
                  {selectedPkg.requiresPrinting === true ? "Có in" : "Không in"}
                </span>
              )}
            </div>

            {/* Mô tả — inline edit */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Mô tả</p>
                {effectiveIsAdmin && inlineEdit !== "description" ? (
                  <button onClick={() => { setDraftDesc(selectedPkg.description ?? ""); setInlineEdit("description"); }}
                    className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-primary" title="Sửa mô tả">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                ) : inlineEdit === "description" ? (
                  <div className="flex gap-1">
                    <button onClick={() => updatePkgInline.mutate({ id: selectedPkg.id, description: draftDesc })}
                      disabled={updatePkgInline.isPending}
                      className="p-1 rounded bg-emerald-100 hover:bg-emerald-200 text-emerald-700 transition-colors" title="Lưu">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setInlineEdit(null)}
                      className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors" title="Hủy">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>
              {inlineEdit === "description" ? (
                <textarea
                  value={draftDesc}
                  onChange={e => setDraftDesc(e.target.value)}
                  rows={3}
                  className="w-full text-sm border border-primary/30 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none bg-background"
                  placeholder="Nhập mô tả gói..."
                  autoFocus
                />
              ) : (
                selectedPkg.description
                  ? <DescriptionBlocksView text={selectedPkg.description} />
                  : <p className="text-sm text-muted-foreground italic">Chưa có mô tả</p>
              )}
            </div>

            {/* Items — inline edit */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Chi tiết hạng mục</p>
                {effectiveIsAdmin && inlineEdit !== "items" ? (
                  <button onClick={() => { setDraftItems(selectedPkg.items?.map(i => ({ ...i })) ?? []); setInlineEdit("items"); }}
                    className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-primary" title="Sửa hạng mục">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                ) : inlineEdit === "items" ? (
                  <div className="flex gap-1">
                    <button
                      onClick={() => updatePkgInline.mutate({ id: selectedPkg.id, items: draftItems.map((it, i) => ({ ...it, sortOrder: i + 1 })) })}
                      disabled={updatePkgInline.isPending}
                      className="px-2 py-1 rounded bg-emerald-100 hover:bg-emerald-200 text-emerald-700 text-xs font-medium transition-colors flex items-center gap-1">
                      <Check className="w-3 h-3" /> Lưu
                    </button>
                    <button onClick={() => setInlineEdit(null)}
                      className="px-2 py-1 rounded hover:bg-muted text-muted-foreground text-xs transition-colors">Hủy</button>
                  </div>
                ) : null}
              </div>

              {inlineEdit === "items" ? (
                <div className="space-y-2">
                  {draftItems.map((item, idx) => (
                    <div key={idx} className="flex items-start gap-1.5 p-2 bg-muted/20 rounded-lg border border-border/50">
                      <div className="flex flex-col gap-0.5 flex-shrink-0 mt-1">
                        <button onClick={() => { if (idx === 0) return; const arr = [...draftItems]; [arr[idx-1], arr[idx]] = [arr[idx], arr[idx-1]]; setDraftItems(arr); }}
                          disabled={idx === 0} className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-30">
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button onClick={() => { if (idx === draftItems.length-1) return; const arr = [...draftItems]; [arr[idx+1], arr[idx]] = [arr[idx], arr[idx+1]]; setDraftItems(arr); }}
                          disabled={idx === draftItems.length-1} className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-30">
                          <ArrowDown className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <input value={item.name} onChange={e => { const arr = [...draftItems]; arr[idx] = { ...arr[idx], name: e.target.value }; setDraftItems(arr); }}
                          className="w-full text-sm border border-border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
                          placeholder="Tên hạng mục" />
                        <div className="flex gap-1.5">
                          <input value={item.quantity} onChange={e => { const arr = [...draftItems]; arr[idx] = { ...arr[idx], quantity: e.target.value }; setDraftItems(arr); }}
                            className="w-16 text-xs border border-border rounded px-2 py-1 bg-background focus:outline-none"
                            placeholder="SL" />
                          <input value={item.unit} onChange={e => { const arr = [...draftItems]; arr[idx] = { ...arr[idx], unit: e.target.value }; setDraftItems(arr); }}
                            className="w-20 text-xs border border-border rounded px-2 py-1 bg-background focus:outline-none"
                            placeholder="Đơn vị" />
                          <input value={item.notes} onChange={e => { const arr = [...draftItems]; arr[idx] = { ...arr[idx], notes: e.target.value }; setDraftItems(arr); }}
                            className="flex-1 text-xs border border-border rounded px-2 py-1 bg-background focus:outline-none"
                            placeholder="Ghi chú" />
                        </div>
                      </div>
                      <button onClick={() => setDraftItems(draftItems.filter((_, i) => i !== idx))}
                        className="p-1 rounded hover:bg-destructive/10 text-destructive/60 hover:text-destructive flex-shrink-0 mt-1">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => setDraftItems([...draftItems, { name: "", quantity: "1", unit: "lần", notes: "", sortOrder: draftItems.length + 1 }])}
                    className="w-full py-1.5 border border-dashed border-border rounded-lg text-xs text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1">
                    <Plus className="w-3 h-3" /> Thêm hạng mục
                  </button>
                </div>
              ) : (
                selectedPkg.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">Chưa có hạng mục chi tiết</p>
                ) : (
                  <div className="space-y-1.5">
                    {selectedPkg.items.map((item, idx) => (
                      <div key={item.id ?? idx} className="flex items-start gap-2 p-2.5 bg-muted/30 rounded-lg">
                        <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium">{item.name}</span>
                          {item.quantity && item.unit && (
                            <span className="text-xs text-muted-foreground ml-1.5">× {item.quantity} {item.unit}</span>
                          )}
                          {item.notes && <p className="text-xs text-muted-foreground italic">{item.notes}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>

            {/* Ghi chú — inline edit */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wide">Ghi chú</p>
                {effectiveIsAdmin && inlineEdit !== "notes" ? (
                  <button onClick={() => { setDraftNotes(selectedPkg.notes ?? ""); setInlineEdit("notes"); }}
                    className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-primary" title="Sửa ghi chú">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                ) : inlineEdit === "notes" ? (
                  <div className="flex gap-1">
                    <button onClick={() => updatePkgInline.mutate({ id: selectedPkg.id, notes: draftNotes })}
                      disabled={updatePkgInline.isPending}
                      className="p-1 rounded bg-emerald-100 hover:bg-emerald-200 text-emerald-700 transition-colors" title="Lưu">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setInlineEdit(null)}
                      className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors" title="Hủy">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>
              {inlineEdit === "notes" ? (
                <textarea
                  value={draftNotes}
                  onChange={e => setDraftNotes(e.target.value)}
                  rows={3}
                  className="w-full text-sm border border-amber-300/50 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-amber-200 resize-none bg-background"
                  placeholder="Nhập ghi chú..."
                  autoFocus
                />
              ) : (
                selectedPkg.notes
                  ? <div className="p-3 bg-amber-50 dark:bg-amber-950/20 rounded-xl border border-amber-200/50">
                      <DescriptionBlocksView text={selectedPkg.notes} tone="amber" />
                    </div>
                  : <p className="text-sm text-muted-foreground italic">Chưa có ghi chú</p>
              )}
            </div>
          </div>

          <div className="p-4 border-t border-border space-y-2 flex-shrink-0">
            <Button
              onClick={() => navigate("/bookings")}
              className="w-full gap-2"
            >
              <ShoppingCart className="w-4 h-4" /> Tạo đơn hàng từ gói này
            </Button>
            {effectiveIsAdmin && (
              <button
                onClick={() => togglePkgActive.mutate(selectedPkg)}
                className={`w-full text-sm font-medium py-2 px-4 rounded-xl transition-colors border ${
                  selectedPkg.isActive
                    ? "border-muted text-muted-foreground hover:bg-muted/50"
                    : "border-emerald-200 text-emerald-600 bg-emerald-50 hover:bg-emerald-100"
                }`}
              >
                {selectedPkg.isActive ? (
                  <span className="flex items-center justify-center gap-2"><EyeOff className="w-4 h-4" /> Ẩn gói này</span>
                ) : (
                  <span className="flex items-center justify-center gap-2"><Eye className="w-4 h-4" /> Hiển thị gói này</span>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {showPkgModal && (
        <PackageModal
          pkg={editingPkg}
          groups={groups}
          onClose={() => setShowPkgModal(false)}
          onSaved={(saved) => {
            qc.invalidateQueries({ queryKey: ["service-packages"] });
            setShowPkgModal(false);
            setSelectedPkg(saved);
          }}
        />
      )}

      {showSurchargeModal && (
        <SurchargeModal
          surcharge={editingSurcharge}
          onClose={() => setShowSurchargeModal(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["surcharges"] }); setShowSurchargeModal(false); }}
        />
      )}

      {showGroupModal && (
        <GroupModal
          group={editingGroup}
          onClose={() => setShowGroupModal(false)}
          onSaved={() => {
            // Giảm giá nhóm ảnh hưởng giá hiển thị của các gói trong nhóm → refetch cả 2.
            qc.invalidateQueries({ queryKey: ["service-groups"] });
            qc.invalidateQueries({ queryKey: ["service-packages"] });
            setShowGroupModal(false);
          }}
        />
      )}

      {deletingGroup && (
        <GroupDeleteDialog
          group={deletingGroup}
          packageCount={packages.filter(p => p.groupId === deletingGroup.id).length}
          groups={groups}
          onClose={() => setDeletingGroup(null)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ["service-groups"] });
            qc.invalidateQueries({ queryKey: ["service-packages"] });
            setDeletingGroup(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Chương trình giảm giá (dùng chung cho PackageModal + GroupModal) ─────────
type DiscountForm = {
  discountEnabled: boolean; discountName: string; discountType: "percent" | "fixed";
  discountValue: string; discountStartDate: string; discountEndDate: string; discountDescription: string;
};

/** ISO → giá trị cho <input type="datetime-local">. */
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initDiscountForm(o?: DiscountFields | null): DiscountForm {
  return {
    discountEnabled: o?.discountEnabled ?? false,
    discountName: o?.discountName ?? "",
    discountType: o?.discountType === "fixed" ? "fixed" : "percent",
    discountValue: o?.discountValue != null ? String(o.discountValue) : "",
    discountStartDate: toLocalInput(o?.discountStartDate ?? null),
    discountEndDate: toLocalInput(o?.discountEndDate ?? null),
    discountDescription: o?.discountDescription ?? "",
  };
}

function discountFormToPayload(d: DiscountForm) {
  return {
    discountEnabled: d.discountEnabled,
    discountName: d.discountName.trim() || null,
    discountType: d.discountType,
    discountValue: d.discountValue.trim() === "" ? null : parseFloat(d.discountValue),
    discountStartDate: d.discountStartDate ? new Date(d.discountStartDate).toISOString() : null,
    discountEndDate: d.discountEndDate ? new Date(d.discountEndDate).toISOString() : null,
    discountDescription: d.discountDescription.trim() || null,
  };
}

function DiscountSection({ value, onChange, basePrice, scope }: {
  value: DiscountForm;
  onChange: (patch: Partial<DiscountForm>) => void;
  basePrice?: number;
  scope: "package" | "group";
}) {
  const cfg = {
    enabled: value.discountEnabled, type: value.discountType, value: value.discountValue,
    startDate: value.discountStartDate ? new Date(value.discountStartDate) : null,
    endDate: value.discountEndDate ? new Date(value.discountEndDate) : null,
  };
  const status = discountWindowStatus(cfg);
  const base = basePrice ?? 0;
  const finalPrice = previewFinalPrice(base, cfg);
  const statusCls = status === "active" ? "bg-emerald-100 text-emerald-700"
    : status === "scheduled" ? "bg-amber-100 text-amber-700"
    : status === "expired" ? "bg-neutral-200 text-neutral-600" : "bg-muted text-muted-foreground";
  return (
    <div className="p-3 rounded-xl border border-rose-200 bg-rose-50/40 space-y-3">
      <label className="flex items-center justify-between cursor-pointer">
        <span className="text-xs font-semibold text-rose-700 uppercase tracking-wide">
          🏷️ Chương trình giảm giá {scope === "group" ? "(cấp nhóm)" : "(riêng gói)"}
        </span>
        <input type="checkbox" checked={value.discountEnabled} onChange={e => onChange({ discountEnabled: e.target.checked })} className="w-4 h-4 rounded" />
      </label>
      {value.discountEnabled && (
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Tên chương trình</label>
            <Input value={value.discountName} onChange={e => onChange({ discountName: e.target.value })} placeholder="VD: Ưu đãi mùa cưới" className="h-8 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Loại giảm</label>
              <div className="flex gap-1">
                <button type="button" onClick={() => onChange({ discountType: "percent" })}
                  className={`flex-1 h-8 rounded-lg text-xs border ${value.discountType === "percent" ? "bg-rose-500 text-white border-rose-500" : "border-input"}`}>Giảm %</button>
                <button type="button" onClick={() => onChange({ discountType: "fixed" })}
                  className={`flex-1 h-8 rounded-lg text-xs border ${value.discountType === "fixed" ? "bg-rose-500 text-white border-rose-500" : "border-input"}`}>Giảm tiền</button>
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">{value.discountType === "percent" ? "Giá trị (%)" : "Giá trị (đ)"}</label>
              <Input type="number" value={value.discountValue} onChange={e => onChange({ discountValue: e.target.value })}
                placeholder={value.discountType === "percent" ? "VD: 10" : "VD: 100000"} className="h-8 text-sm" />
            </div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {(value.discountType === "percent" ? [10, 20, 30, 50] : [100000, 200000, 300000, 500000]).map(v => (
              <button key={v} type="button" onClick={() => onChange({ discountValue: String(v) })}
                className="px-2 py-0.5 rounded-md text-[11px] border border-input hover:bg-rose-100">
                {value.discountType === "percent" ? `${v}%` : formatVNDShort(v)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Ngày bắt đầu</label>
              <input type="datetime-local" value={value.discountStartDate} onChange={e => onChange({ discountStartDate: e.target.value })}
                className="w-full h-8 border border-input rounded-lg px-2 text-xs bg-background" />
            </div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Ngày kết thúc</label>
              <input type="datetime-local" value={value.discountEndDate} onChange={e => onChange({ discountEndDate: e.target.value })}
                className="w-full h-8 border border-input rounded-lg px-2 text-xs bg-background" />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">Để trống ngày = áp dụng đến khi admin tắt. Quá hạn tự ngừng giảm.</p>
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Lời tư vấn cho Lulu (tuỳ chọn)</label>
            <textarea value={value.discountDescription} onChange={e => onChange({ discountDescription: e.target.value })} rows={2}
              placeholder={'VD: "Dạ bên em đang có ưu đãi mùa cưới, chốt hôm nay giảm 10% gói này ạ."'}
              className="w-full border border-input rounded-lg px-2 py-1.5 text-xs bg-background" />
          </div>
          <div className="text-xs bg-background rounded-lg px-3 py-2 border border-border flex items-center justify-between gap-2 flex-wrap">
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${statusCls}`}>{statusLabel(status)}</span>
            {scope === "package" && base > 0 ? (
              status === "active"
                ? <span>Giá sau giảm: <b className="text-rose-600">{formatVND(finalPrice)}</b> <span className="line-through text-muted-foreground ml-1">{formatVND(base)}</span></span>
                : <span className="text-muted-foreground">Giá gốc {formatVND(base)}</span>
            ) : (
              <span className="text-muted-foreground text-[11px]">Áp cho mọi gói active trong nhóm chưa có giảm riêng</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Dialog xử lý xoá/ẩn/chuyển nhóm an toàn (không hard-delete nhóm còn gói).
function GroupDeleteDialog({ group, packageCount, groups, onClose, onDone }: {
  group: ServiceGroup; packageCount: number; groups: ServiceGroup[];
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const others = groups.filter(g => g.id !== group.id);
  const hdrs = () => {
    const t = localStorage.getItem("amazingStudioToken_v2");
    return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) } as Record<string, string>;
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Có lỗi xảy ra"); } finally { setBusy(false); } };

  const hardDelete = () => run(async () => {
    const r = await fetch(`${BASE}/api/service-groups/${group.id}`, { method: "DELETE", headers: hdrs() });
    if (r.status === 409) { const b = await r.json().catch(() => ({})); throw new Error(`Nhóm còn ${b.packageCount ?? "?"} gói — hãy chuyển gói hoặc ẩn nhóm.`); }
    if (!r.ok && r.status !== 204) throw new Error("Xoá nhóm thất bại");
    onDone("Đã xoá nhóm");
  });
  const hideGroup = () => run(async () => {
    const r = await fetch(`${BASE}/api/service-groups/${group.id}`, { method: "PUT", headers: hdrs(), body: JSON.stringify({ isActive: false }) });
    if (!r.ok) throw new Error("Ẩn nhóm thất bại");
    onDone("Đã ẩn nhóm — Lulu & website sẽ không dùng nhóm này nữa");
  });
  const moveAndDelete = () => run(async () => {
    if (!targetId) { setError("Vui lòng chọn nhóm đích"); return; }
    const m = await fetch(`${BASE}/api/service-groups/${group.id}/move-packages`, { method: "POST", headers: hdrs(), body: JSON.stringify({ targetGroupId: parseInt(targetId) }) });
    if (!m.ok) { const b = await m.json().catch(() => ({})); throw new Error(b.error ?? "Chuyển gói thất bại"); }
    const r = await fetch(`${BASE}/api/service-groups/${group.id}`, { method: "DELETE", headers: hdrs() });
    if (!r.ok && r.status !== 204) throw new Error("Đã chuyển gói nhưng xoá nhóm thất bại");
    onDone("Đã chuyển gói sang nhóm khác và xoá nhóm cũ");
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-background rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-bold">Xử lý nhóm “{group.name}”</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {error && <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-lg text-destructive text-sm"><AlertCircle className="w-4 h-4 flex-shrink-0" />{error}</div>}
          {packageCount === 0 ? (
            <>
              <p className="text-sm text-muted-foreground">Nhóm này chưa có gói dịch vụ nào. Bạn có chắc muốn xoá nhóm? Hành động này không thể hoàn tác.</p>
              <div className="flex gap-3 pt-1">
                <Button variant="outline" onClick={onClose} className="flex-1">Huỷ</Button>
                <Button onClick={hardDelete} disabled={busy} className="flex-1 bg-destructive hover:bg-destructive/90">{busy ? "Đang xoá..." : "Xoá nhóm"}</Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm">Nhóm này đang có <b>{packageCount} gói dịch vụ</b>. Không thể xoá thẳng — chọn cách xử lý:</p>
              <div className="space-y-3">
                <div className="p-3 rounded-xl border border-border space-y-2">
                  <p className="text-sm font-medium">1. Chuyển toàn bộ gói sang nhóm khác rồi xoá nhóm này</p>
                  <select value={targetId} onChange={e => setTargetId(e.target.value)} className="w-full h-9 border border-input rounded-lg px-3 text-sm bg-background">
                    <option value="">-- Chọn nhóm đích --</option>
                    {others.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  <Button onClick={moveAndDelete} disabled={busy || !targetId} className="w-full">{busy ? "Đang xử lý..." : "Chuyển gói & xoá nhóm"}</Button>
                </div>
                <div className="p-3 rounded-xl border border-border space-y-2">
                  <p className="text-sm font-medium">2. Ẩn nhóm (giữ nguyên gói + dữ liệu)</p>
                  <p className="text-[11px] text-muted-foreground">Nhóm ẩn sẽ không hiện trên website và Lulu không tư vấn nhóm này. Có thể bật lại sau.</p>
                  <Button variant="outline" onClick={hideGroup} disabled={busy} className="w-full">{busy ? "Đang ẩn..." : "Ẩn nhóm"}</Button>
                </div>
              </div>
              <Button variant="outline" onClick={onClose} className="w-full">Huỷ</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PackageModal({
  pkg, groups, onClose, onSaved,
}: {
  pkg: ServicePackage | null;
  groups: ServiceGroup[];
  onClose: () => void;
  onSaved: (p: ServicePackage) => void;
}) {
  const [form, setForm] = useState({
    groupId: pkg?.groupId?.toString() ?? "",
    code: pkg?.code ?? "",
    name: pkg?.name ?? "",
    price: pkg?.price?.toString() ?? "",
    printCost: pkg?.printCost?.toString() ?? "",
    operatingCost: pkg?.operatingCost?.toString() ?? "",
    salePercent: pkg?.salePercent?.toString() ?? "",
    description: pkg?.description ?? "",
    notes: pkg?.notes ?? "",
    isActive: pkg?.isActive ?? true,
    includedRetouchedPhotos: (pkg as ServicePackage & { includedRetouchedPhotos?: number })?.includedRetouchedPhotos?.toString() ?? "0",
    // Task #383 Bước 2: rỗng → fallback theo logic cũ (10/15 ngày theo tên)
    defaultEditingDays: pkg?.defaultEditingDays != null ? String(pkg.defaultEditingDays) : "",
    requiresPostProduction: pkg?.requiresPostProduction !== false,
    requiresPrinting: pkg?.requiresPrinting === true,
  });
  const [items, setItems] = useState<PackageItem[]>(
    pkg?.items.length ? pkg.items : []
  );
  const [discount, setDiscount] = useState<DiscountForm>(() => initDiscountForm(pkg));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const addItem = () => setItems(prev => [...prev, { name: "", quantity: "1", unit: "bộ", notes: "", sortOrder: prev.length }]);
  const removeItem = (idx: number) => setItems(prev => prev.filter((_, i) => i !== idx));
  const updateItem = (idx: number, field: keyof PackageItem, val: string) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: val } : it));
  };

  const save = async () => {
    if (!form.name.trim()) { setError("Vui lòng nhập tên gói"); return; }
    setSaving(true);
    setError("");
    try {
      const tok = localStorage.getItem("amazingStudioToken_v2");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tok) headers["Authorization"] = `Bearer ${tok}`;
      const body = {
        ...form,
        groupId: form.groupId ? parseInt(form.groupId) : null,
        price: parseFloat(form.price) || 0,
        printCost: parseFloat(form.printCost) || 0,
        operatingCost: parseFloat(form.operatingCost) || 0,
        salePercent: parseFloat(form.salePercent) || 0,
        includedRetouchedPhotos: parseInt(form.includedRetouchedPhotos) || 0,
        // Rỗng → null = về fallback logic cũ; số hợp lệ → áp deadline mới
        defaultEditingDays: form.defaultEditingDays.trim() === ""
          ? null
          : (Number.isFinite(parseInt(form.defaultEditingDays)) && parseInt(form.defaultEditingDays) >= 0
            ? parseInt(form.defaultEditingDays)
            : null),
        requiresPostProduction: form.requiresPostProduction,
        requiresPrinting: form.requiresPrinting,
        ...discountFormToPayload(discount),
        items: items.filter(it => it.name.trim()).map((it, i) => ({ ...it, sortOrder: i })),
      };
      const url = pkg ? `/api/service-packages/${pkg.id}` : `/api/service-packages`;
      const resp = await fetch(`${BASE}${url}`, {
        method: pkg ? "PUT" : "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const ct = resp.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body2 = await resp.json().catch(() => ({})) as Record<string, unknown>;
          throw new Error((body2.error as string) ?? "Lỗi lưu gói");
        }
        throw new Error(`Lỗi lưu gói (${resp.status})`);
      }
      const saved = await resp.json();
      onSaved(saved);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Có lỗi xảy ra");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-background rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-lg font-bold">{pkg ? "Chỉnh sửa gói dịch vụ" : "Tạo gói dịch vụ mới"}</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-lg text-destructive text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Nhóm dịch vụ</label>
              <select
                className="w-full h-9 border border-input rounded-lg px-3 text-sm bg-background"
                value={form.groupId}
                onChange={e => {
                  const gid = e.target.value;
                  const g = groups.find(x => String(x.id) === gid);
                  const defPts = g ? defaultRequiresPostProductionByGroupName(g.name) : false;
                  const defPrint = g ? defaultRequiresPrintingByGroupName(g.name) : false;
                  setForm(f => ({
                    ...f,
                    groupId: gid,
                    requiresPostProduction: pkg ? f.requiresPostProduction : defPts,
                    requiresPrinting: pkg ? f.requiresPrinting : defPrint,
                  }));
                }}
              >
                <option value="">-- Chọn nhóm --</option>
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Mã gói</label>
              <Input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} placeholder="VD: AS-BASIC" className="h-9 text-sm" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Tên gói <span className="text-destructive">*</span></label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Nhập tên gói dịch vụ" className="h-9 text-sm" />
          </div>

          {/* Giá bán */}
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">💰 Giá bán (đ) <span className="text-destructive">*</span></label>
            <Input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="0" className="h-9 text-sm" />
          </div>

          {/* Chi phí sản xuất */}
          <div className="p-3 bg-muted/30 rounded-xl border border-border space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">📦 Chi phí sản xuất chuẩn</p>
              <span className="text-[10px] text-sky-600 bg-sky-50 px-2 py-0.5 rounded-full">👤 Cast cấu hình theo nhân viên</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">🖨️ In ấn (đ)</label>
                <Input type="number" value={form.printCost} onChange={e => setForm(f => ({ ...f, printCost: e.target.value }))} placeholder="0" className="h-8 text-sm" />
              </div>
              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">⚡ Vận hành (đ)</label>
                <Input type="number" value={form.operatingCost} onChange={e => setForm(f => ({ ...f, operatingCost: e.target.value }))} placeholder="0" className="h-8 text-sm" />
              </div>
              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">💼 Sale (%)</label>
                <Input type="number" value={form.salePercent} onChange={e => setForm(f => ({ ...f, salePercent: e.target.value }))} placeholder="0" className="h-8 text-sm" />
              </div>
            </div>
            {/* Live preview chi phí cố định */}
            {(() => {
              const p = parseFloat(form.price) || 0;
              const pc = parseFloat(form.printCost) || 0;
              const oc = parseFloat(form.operatingCost) || 0;
              const sp = parseFloat(form.salePercent) || 0;
              const saleAmt = Math.round(p * sp / 100);
              const fixedCost = pc + oc + saleAmt;
              if (p <= 0) return null;
              return (
                <div className="text-xs bg-background rounded-lg px-3 py-2.5 space-y-1 border border-border">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Chi phí cố định gói</span><span className="font-medium text-foreground">{fixedCost.toLocaleString("vi-VN")}đ</span>
                  </div>
                  <div className="flex justify-between font-bold border-t border-border pt-1 mt-1">
                    <span>Doanh thu trước cast</span>
                    <span className={(p - fixedCost) >= 0 ? "text-green-600" : "text-destructive"}>{(p - fixedCost).toLocaleString("vi-VN")}đ</span>
                  </div>
                  {p > 0 && fixedCost > 0 && (
                    <p className="text-[10px] text-muted-foreground text-right">Chi phí cố định chiếm: {Math.round(fixedCost / p * 100)}%</p>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Chương trình giảm giá riêng cho gói */}
          <DiscountSection
            scope="package"
            value={discount}
            basePrice={parseFloat(form.price) || 0}
            onChange={patch => setDiscount(d => ({ ...d, ...patch }))}
          />

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">📸 Số ảnh hậu kỳ bao gồm trong gói</label>
            <Input
              type="number"
              value={form.includedRetouchedPhotos}
              onChange={e => setForm(f => ({ ...f, includedRetouchedPhotos: e.target.value }))}
              placeholder="0"
              className="h-9 text-sm"
            />
            <p className="text-[11px] text-muted-foreground mt-1">Số ảnh retouch/hậu kỳ giao khách theo gói. Nếu donePhotos vượt số này, phần dư sẽ tính thêm phí.</p>
          </div>

          {/* Task #383 Bước 2: deadline hậu kỳ mặc định theo gói */}
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">⏰ Số ngày hậu kỳ mặc định</label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                value={form.defaultEditingDays}
                onChange={e => setForm(f => ({ ...f, defaultEditingDays: e.target.value }))}
                placeholder="VD: 10"
                className="h-9 text-sm flex-1"
              />
              <span className="text-sm text-muted-foreground">ngày</span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Booking mới của gói này sẽ tự sinh deadline = ngày chụp + số ngày này.
              Để trống = dùng quy tắc mặc định (album/ngoại cảnh 15 ngày, còn lại 10 ngày).
              Booking cũ và deadline đã chỉnh tay không bị thay đổi.
            </p>
          </div>


          <div className="flex items-center justify-between p-3 bg-muted/30 rounded-xl border border-border">
            <div>
              <p className="text-xs font-semibold text-muted-foreground">🎨 Tiến độ hậu kỳ</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {form.requiresPostProduction ? "Có đưa vào Tiến độ hậu kỳ" : "Không đưa vào Tiến độ hậu kỳ"}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.requiresPostProduction}
              onClick={() => setForm(f => ({ ...f, requiresPostProduction: !f.requiresPostProduction }))}
              className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full transition-colors ${form.requiresPostProduction ? "bg-primary" : "bg-muted-foreground/30"}`}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-1 ${form.requiresPostProduction ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          <div className="flex items-center justify-between p-3 bg-muted/30 rounded-xl border border-border">
            <div>
              <p className="text-xs font-semibold text-muted-foreground">🖨️ Có in hình</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {form.requiresPrinting ? "Theo dõi xuất in trên Tiến độ HK" : "Chỉ chỉnh ảnh — không cần in"}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={form.requiresPrinting}
              onClick={() => setForm(f => ({ ...f, requiresPrinting: !f.requiresPrinting }))}
              className={`relative inline-flex h-7 w-12 flex-shrink-0 rounded-full transition-colors ${form.requiresPrinting ? "bg-rose-400" : "bg-muted-foreground/30"}`}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-1 ${form.requiresPrinting ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Mô tả ngắn</label>
            <textarea
              className="w-full border border-input rounded-lg px-3 py-2 text-sm bg-background resize-none"
              rows={2}
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Mô tả gói dịch vụ..."
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-muted-foreground">Chi tiết hạng mục</label>
              <button onClick={addItem} className="flex items-center gap-1 text-xs text-primary hover:underline">
                <Plus className="w-3 h-3" /> Thêm hạng mục
              </button>
            </div>
            <div className="space-y-2">
              {items.map((item, idx) => (
                <div key={idx} className="flex items-center gap-2 p-2 bg-muted/30 rounded-lg">
                  <GripVertical className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <Input
                    value={item.name}
                    onChange={e => updateItem(idx, "name", e.target.value)}
                    placeholder="Tên hạng mục"
                    className="h-8 text-sm flex-1"
                  />
                  <Input
                    value={item.quantity}
                    onChange={e => updateItem(idx, "quantity", e.target.value)}
                    placeholder="SL"
                    className="h-8 text-sm w-14"
                  />
                  <select
                    className="h-8 border border-input rounded-md px-2 text-sm bg-background w-20"
                    value={item.unit}
                    onChange={e => updateItem(idx, "unit", e.target.value)}
                  >
                    {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <Input
                    value={item.notes}
                    onChange={e => updateItem(idx, "notes", e.target.value)}
                    placeholder="Ghi chú"
                    className="h-8 text-sm flex-1"
                  />
                  <button onClick={() => removeItem(idx)} className="text-destructive/60 hover:text-destructive p-1">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {items.length === 0 && (
                <div className="text-center py-4 text-sm text-muted-foreground border border-dashed border-border rounded-lg">
                  Nhấn "Thêm hạng mục" để bắt đầu
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Ghi chú nội bộ</label>
            <textarea
              className="w-full border border-input rounded-lg px-3 py-2 text-sm bg-background resize-none"
              rows={2}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Ghi chú dành cho nhân viên..."
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))}
              className="w-4 h-4 rounded border-input"
            />
            <span className="text-sm">Gói đang hoạt động (hiển thị khi chọn)</span>
          </label>
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-border flex-shrink-0">
          <Button variant="outline" onClick={onClose} className="flex-1">Huỷ</Button>
          <Button onClick={save} disabled={saving} className="flex-1">
            {saving ? "Đang lưu..." : pkg ? "Cập nhật gói" : "Tạo gói dịch vụ"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SurchargeModal({ surcharge, onClose, onSaved }: {
  surcharge: Surcharge | null; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: surcharge?.name ?? "",
    category: surcharge?.category ?? "",
    price: surcharge?.price?.toString() ?? "",
    unit: surcharge?.unit ?? "lần",
    description: surcharge?.description ?? "",
    isActive: surcharge?.isActive ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!form.name.trim()) { setError("Vui lòng nhập tên phụ phí"); return; }
    setSaving(true); setError("");
    try {
      const tok = localStorage.getItem("amazingStudioToken_v2");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tok) headers["Authorization"] = `Bearer ${tok}`;
      const url = surcharge ? `/api/surcharges/${surcharge.id}` : `/api/surcharges`;
      const resp = await fetch(`${BASE}${url}`, {
        method: surcharge ? "PUT" : "POST",
        headers,
        body: JSON.stringify({ ...form, price: parseFloat(form.price) || 0 }),
      });
      if (!resp.ok) {
        const ct2 = resp.headers.get("content-type") ?? "";
        if (ct2.includes("application/json")) {
          const errBody = await resp.json().catch(() => ({})) as Record<string, unknown>;
          throw new Error((errBody.error as string) ?? "Lỗi lưu phụ phí");
        }
        throw new Error(`Lỗi lưu phụ phí (${resp.status})`);
      }
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Có lỗi xảy ra");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-background rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-bold">{surcharge ? "Sửa phụ phí" : "Thêm phụ phí mới"}</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {error && <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-lg text-destructive text-sm"><AlertCircle className="w-4 h-4" />{error}</div>}
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Tên phụ phí *</label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="VD: Makeup chú rể" className="h-9 text-sm" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Nhóm phụ phí</label>
              <Input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="VD: Nâng cấp makeup" className="h-9 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Đơn vị tính</label>
              <select className="w-full h-9 border border-input rounded-lg px-3 text-sm bg-background" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}>
                {UNIT_OPTIONS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Giá (đ)</label>
            <Input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="0" className="h-9 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Mô tả</label>
            <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Mô tả phụ phí..." className="h-9 text-sm" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 rounded" />
            <span className="text-sm">Đang hoạt động</span>
          </label>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={onClose} className="flex-1">Huỷ</Button>
          <Button onClick={save} disabled={saving} className="flex-1">{saving ? "Đang lưu..." : surcharge ? "Cập nhật" : "Thêm phụ phí"}</Button>
        </div>
      </div>
    </div>
  );
}

function GroupModal({ group, onClose, onSaved }: {
  group: ServiceGroup | null; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: group?.name ?? "",
    description: group?.description ?? "",
    isActive: group?.isActive ?? true,
    sortOrder: group?.sortOrder?.toString() ?? "0",
    aiImageUrl: group?.aiImageUrl ?? "",
    publicForCustomer: group?.publicForCustomer ?? true,
  });
  const [discount, setDiscount] = useState<DiscountForm>(() => initDiscountForm(group));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!form.name.trim()) { setError("Vui lòng nhập tên nhóm"); return; }
    setSaving(true); setError("");
    try {
      const tok = localStorage.getItem("amazingStudioToken_v2");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tok) headers["Authorization"] = `Bearer ${tok}`;
      const url = group ? `/api/service-groups/${group.id}` : `/api/service-groups`;
      const resp = await fetch(`${BASE}${url}`, {
        method: group ? "PUT" : "POST",
        headers,
        body: JSON.stringify({ ...form, sortOrder: parseInt(form.sortOrder) || 0, ...discountFormToPayload(discount) }),
      });
      if (resp.status === 409) {
        const body = await resp.json();
        setError(body.error ?? `Nhóm "${form.name.trim()}" đã tồn tại trong hệ thống`);
        return;
      }
      if (!resp.ok) throw new Error("Lỗi lưu nhóm — vui lòng thử lại");
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Có lỗi xảy ra");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-background rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-lg font-bold">{group ? "Sửa nhóm dịch vụ" : "Thêm nhóm dịch vụ"}</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-muted"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-4 space-y-4 flex-1 overflow-y-auto">
          {error && <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-lg text-destructive text-sm"><AlertCircle className="w-4 h-4" />{error}</div>}
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Tên nhóm *</label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="VD: Album studio" className="h-9 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Mô tả</label>
            <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Mô tả nhóm..." className="h-9 text-sm" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">Thứ tự hiển thị</label>
            <Input type="number" value={form.sortOrder} onChange={e => setForm(f => ({ ...f, sortOrder: e.target.value }))} className="h-9 text-sm" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} className="w-4 h-4 rounded" />
            <span className="text-sm">Đang hoạt động</span>
          </label>

          {/* Chương trình giảm giá cấp nhóm */}
          <DiscountSection
            scope="group"
            value={discount}
            onChange={patch => setDiscount(d => ({ ...d, ...patch }))}
          />

          {/* ─── Ảnh bảng giá cho Sale AI ─────────────────────────────── */}
          <div className="pt-3 border-t border-border">
            <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
              🖼️ Ảnh bảng giá (Sale AI gửi cho khách)
            </label>
            {form.aiImageUrl ? (
              <div className="space-y-2">
                <div className="relative w-full rounded-xl overflow-hidden border border-border bg-muted">
                  <img
                    src={getImageSrc(form.aiImageUrl) ?? ""}
                    alt="Ảnh bảng giá nhóm"
                    className="w-full max-h-56 object-contain bg-muted"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <MultiImageUploader
                      multiple={false}
                      useQueue={false}
                      label="Đổi ảnh khác"
                      onUploaded={imgs => { if (imgs[0]) setForm(f => ({ ...f, aiImageUrl: imgs[0].objectPath })); }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setForm(f => ({ ...f, aiImageUrl: "" }))}
                    className="shrink-0 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4 mr-1" /> Xoá ảnh
                  </Button>
                </div>
              </div>
            ) : (
              <MultiImageUploader
                multiple={false}
                useQueue={false}
                label="Tải ảnh bảng giá lên (kéo thả / dán / chọn)"
                onUploaded={imgs => { if (imgs[0]) setForm(f => ({ ...f, aiImageUrl: imgs[0].objectPath })); }}
              />
            )}
            <label className="flex items-center gap-2 cursor-pointer mt-3">
              <input
                type="checkbox"
                checked={form.publicForCustomer}
                onChange={e => setForm(f => ({ ...f, publicForCustomer: e.target.checked }))}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm">Cho phép Sale AI gửi ảnh này cho khách</span>
            </label>
            <p className="text-[11px] text-muted-foreground mt-1">
              Sale AI chỉ gửi ảnh khi có ảnh và ô này được bật. Ảnh lưu trên object storage.
            </p>
          </div>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-border flex-shrink-0">
          <Button variant="outline" onClick={onClose} className="flex-1">Huỷ</Button>
          <Button onClick={save} disabled={saving} className="flex-1">{saving ? "Đang lưu..." : group ? "Cập nhật" : "Thêm nhóm"}</Button>
        </div>
      </div>
    </div>
  );
}
