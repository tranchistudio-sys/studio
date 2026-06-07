import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Briefcase, Plus, Pencil, ChevronDown, ChevronUp, Save } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchJson(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fmtVND(n: number) {
  return n.toLocaleString("vi-VN") + "đ";
}

// ─── Types ────────────────────────────────────────────────────────────────────
interface ServiceSplit {
  role: string;
  amount: number;
  rateType: "fixed" | "percent";
  notes?: string | null;
}
interface Service {
  id: number;
  name: string;
  code?: string;
  category: string;
  description?: string;
  price: number;
  costPrice?: number;
  sortOrder: number;
  isActive: boolean;
  splits: ServiceSplit[];
}

// ─── Role config ──────────────────────────────────────────────────────────────
const SPLIT_ROLES = [
  { key: "photographer", label: "Nhiếp ảnh",  icon: "📷", color: "bg-blue-50 text-blue-700 border-blue-200" },
  { key: "makeup",       label: "Trang điểm", icon: "💄", color: "bg-pink-50 text-pink-700 border-pink-200" },
  { key: "sale",         label: "Kinh doanh",  icon: "💼", color: "bg-green-50 text-green-700 border-green-200" },
  { key: "photoshop",    label: "Chỉnh sửa",  icon: "🖥️", color: "bg-purple-50 text-purple-700 border-purple-200" },
  { key: "assistant",    label: "Hỗ trợ",     icon: "🤝", color: "bg-gray-50 text-gray-700 border-gray-200" },
];

// ─── Service Form Sheet ────────────────────────────────────────────────────────
interface ServiceFormProps {
  open: boolean;
  onClose: () => void;
  editService?: Service | null;
}
function ServiceForm({ open, onClose, editService }: ServiceFormProps) {
  const qc = useQueryClient();
  const isEdit = !!editService;

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [splits, setSplits] = useState<Record<string, { amount: string; rateType: "fixed" | "percent" }>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    if (editService) {
      setName(editService.name);
      setPrice(editService.price > 0 ? String(editService.price) : "");
      setDescription(editService.description || "");
      const splitMap: Record<string, { amount: string; rateType: "fixed" | "percent" }> = {};
      for (const sp of editService.splits || []) {
        splitMap[sp.role] = { amount: String(sp.amount), rateType: (sp.rateType || "fixed") as "fixed" | "percent" };
      }
      setSplits(splitMap);
    } else {
      setName(""); setPrice(""); setDescription("");
      setSplits({});
    }
    setErr("");
  }, [open, editService?.id]);

  function setSplit(role: string, amount: string, rateType: "fixed" | "percent") {
    setSplits(prev => ({ ...prev, [role]: { amount, rateType } }));
  }

  async function handleSave() {
    if (!name.trim()) { setErr("Vui lòng nhập tên dịch vụ"); return; }
    if (!price || parseFloat(price) <= 0) { setErr("Vui lòng nhập giá bán"); return; }
    setSaving(true); setErr("");
    try {
      const splitsArr = SPLIT_ROLES
        .filter(r => splits[r.key]?.amount && parseFloat(splits[r.key]!.amount) > 0)
        .map(r => ({
          role: r.key,
          amount: parseFloat(splits[r.key]!.amount),
          rateType: splits[r.key]!.rateType || "fixed",
        }));

      const body = { name: name.trim(), price: parseFloat(price), description: description.trim(), splits: splitsArr };
      if (isEdit) {
        await fetchJson(`${BASE}/api/services/${editService!.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      } else {
        await fetchJson(`${BASE}/api/services`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
      }
      await qc.invalidateQueries({ queryKey: ["services"] });
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Lỗi lưu dịch vụ");
    } finally {
      setSaving(false);
    }
  }

  // Tính tổng chia và phần studio giữ lại
  const priceNum = parseFloat(price) || 0;
  const totalSplit = SPLIT_ROLES.reduce((s, r) => {
    const sp = splits[r.key];
    if (!sp?.amount) return s;
    const am = parseFloat(sp.amount) || 0;
    if (sp.rateType === "percent") return s + (priceNum * am / 100);
    return s + am;
  }, 0);
  const studioKeep = priceNum - totalSplit;

  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle>{isEdit ? "Sửa dịch vụ" : "Thêm dịch vụ mới"}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Basic info */}
          <div className="space-y-3">
            <div>
              <Label>Tên dịch vụ <span className="text-destructive">*</span></Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="vd: Chụp album cưới" className="mt-1" />
            </div>
            <div>
              <Label>Giá bán (đ) <span className="text-destructive">*</span></Label>
              <CurrencyInput value={price} onChange={setPrice} placeholder="vd: 5.000.000" className="mt-1" />
              {priceNum > 0 && <p className="text-xs text-muted-foreground mt-1">{fmtVND(priceNum)}</p>}
            </div>
            <div>
              <Label>Mô tả (tuỳ chọn)</Label>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} className="mt-1" placeholder="Bao gồm những gì..." />
            </div>
          </div>

          <Separator />

          {/* Split per role */}
          <div>
            <h3 className="font-semibold text-sm mb-1">💰 Chia lương theo vai trò</h3>
            <p className="text-xs text-muted-foreground mb-3">Nhập số tiền hoặc % mỗi role nhận được cho dịch vụ này. Bỏ trống = không tính.</p>

            <div className="space-y-2">
              {SPLIT_ROLES.map(r => {
                const sp = splits[r.key] || { amount: "", rateType: "fixed" as const };
                return (
                  <div key={r.key} className={`border rounded-lg p-3 ${r.color}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-base">{r.icon}</span>
                      <span className="font-medium text-sm">{r.label}</span>
                    </div>
                    <div className="flex gap-2">
                      <div className="flex rounded-md border border-inherit overflow-hidden text-xs shrink-0">
                        <button
                          type="button"
                          onClick={() => setSplit(r.key, sp.amount, "fixed")}
                          className={`px-2 py-1.5 ${sp.rateType === "fixed" ? "bg-white/70 font-semibold" : "opacity-60"}`}
                        >đ</button>
                        <button
                          type="button"
                          onClick={() => setSplit(r.key, sp.amount, "percent")}
                          className={`px-2 py-1.5 border-l border-inherit ${sp.rateType === "percent" ? "bg-white/70 font-semibold" : "opacity-60"}`}
                        >%</button>
                      </div>
                      <Input
                        type="number"
                        value={sp.amount}
                        onChange={e => setSplit(r.key, e.target.value, sp.rateType)}
                        placeholder={sp.rateType === "percent" ? "vd: 10" : "vd: 500000"}
                        className="flex-1 bg-white/60 border-inherit h-8 text-sm"
                      />
                      {sp.amount && parseFloat(sp.amount) > 0 && priceNum > 0 && (
                        <div className="text-xs self-center shrink-0 font-medium">
                          = {fmtVND(sp.rateType === "percent" ? priceNum * parseFloat(sp.amount) / 100 : parseFloat(sp.amount))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Summary */}
            {priceNum > 0 && (
              <div className="mt-3 p-3 bg-muted/50 rounded-lg text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tổng chia cho nhân sự:</span>
                  <span className="font-medium text-orange-600">{fmtVND(totalSplit)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Studio giữ lại:</span>
                  <span className={`font-semibold ${studioKeep >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtVND(studioKeep)}</span>
                </div>
              </div>
            )}
          </div>

          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>

        <div className="px-6 py-4 border-t flex gap-3 shrink-0">
          <Button variant="outline" className="flex-1" onClick={onClose}>Đóng</Button>
          <Button className="flex-1 gap-1.5" onClick={handleSave} disabled={saving}>
            <Save className="w-4 h-4" /> {saving ? "Đang lưu..." : "Lưu dịch vụ"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Service Card ─────────────────────────────────────────────────────────────
function ServiceCard({ service, onEdit }: { service: Service; onEdit: (s: Service) => void }) {
  const [showSplits, setShowSplits] = useState(false);

  const totalSplit = (service.splits || []).reduce((s, sp) => {
    if (sp.rateType === "percent") return s + (service.price * sp.amount / 100);
    return s + sp.amount;
  }, 0);
  const studioKeep = service.price - totalSplit;

  return (
    <div className="border rounded-xl bg-card overflow-hidden hover:shadow-sm transition-shadow">
      {/* Header */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold truncate">{service.name}</h3>
            {service.description && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{service.description}</p>
            )}
          </div>
          <Button size="sm" variant="ghost" className="shrink-0 h-7 w-7 p-0" onClick={() => onEdit(service)}>
            <Pencil className="w-3.5 h-3.5" />
          </Button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="bg-primary/5 rounded-lg p-2">
            <div className="text-xs text-muted-foreground">Giá bán</div>
            <div className="font-bold text-sm text-primary">{fmtVND(service.price)}</div>
          </div>
          <div className="bg-orange-50 rounded-lg p-2">
            <div className="text-xs text-muted-foreground">Chia nhân sự</div>
            <div className="font-bold text-sm text-orange-600">{fmtVND(totalSplit)}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-2">
            <div className="text-xs text-muted-foreground">Studio giữ</div>
            <div className={`font-bold text-sm ${studioKeep >= 0 ? "text-green-600" : "text-red-600"}`}>{fmtVND(studioKeep)}</div>
          </div>
        </div>
      </div>

      {/* Splits toggle */}
      <div className="border-t">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-muted-foreground hover:bg-muted/40 transition-colors"
          onClick={() => setShowSplits(v => !v)}
        >
          <span className="font-medium">Chi tiết chia lương ({(service.splits || []).length} vai trò)</span>
          {showSplits ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {showSplits && (
          <div className="px-4 pb-3 space-y-1.5 bg-muted/20">
            {(service.splits || []).length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">Chưa cấu hình chia lương. Bấm ✏️ để thiết lập.</p>
            ) : service.splits.map(sp => {
              const rd = SPLIT_ROLES.find(r => r.key === sp.role);
              const earned = sp.rateType === "percent" ? service.price * sp.amount / 100 : sp.amount;
              return (
                <div key={sp.role} className="flex items-center justify-between text-sm py-1">
                  <span className="text-muted-foreground">{rd?.icon} {rd?.label || sp.role}</span>
                  <span className="font-medium">
                    {fmtVND(earned)}
                    {sp.rateType === "percent" && <span className="text-xs text-muted-foreground ml-1">({sp.amount}%)</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ServicesPage() {
  const [showForm, setShowForm] = useState(false);
  const [editService, setEditService] = useState<Service | null>(null);
  const [search, setSearch] = useState("");

  const { data: services = [], isLoading } = useQuery<Service[]>({
    queryKey: ["services"],
    queryFn: () => fetchJson(`${BASE}/api/services`),
  });

  const filtered = services.filter(s =>
    !search || s.name.toLowerCase().includes(search.toLowerCase())
  );

  // Stats
  const totalRevenue = services.reduce((s, sv) => s + sv.price, 0) / services.length || 0;
  const avgSplit = services.reduce((s, sv) => {
    const split = (sv.splits || []).reduce((ss, sp) => ss + (sp.rateType === "percent" ? sv.price * sp.amount / 100 : sp.amount), 0);
    return s + split;
  }, 0) / services.length || 0;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Briefcase className="w-6 h-6" /> Dịch vụ & Chia lương
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Bảng giá dịch vụ + tự động tính tiền cho từng vai trò khi hoàn thành job
          </p>
        </div>
        <Button onClick={() => { setEditService(null); setShowForm(true); }} className="gap-1.5">
          <Plus className="w-4 h-4" /> Thêm dịch vụ
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="border rounded-lg p-3 text-center">
          <div className="text-2xl font-bold">{services.length}</div>
          <div className="text-xs text-muted-foreground">Dịch vụ</div>
        </div>
        <div className="border rounded-lg p-3 text-center">
          <div className="text-sm font-bold text-primary">{fmtVND(Math.round(totalRevenue))}</div>
          <div className="text-xs text-muted-foreground">Giá trung bình</div>
        </div>
        <div className="border rounded-lg p-3 text-center">
          <div className="text-sm font-bold text-orange-600">{fmtVND(Math.round(avgSplit))}</div>
          <div className="text-xs text-muted-foreground">Chia nhân sự TB</div>
        </div>
      </div>

      {/* Search */}
      <Input
        placeholder="Tìm dịch vụ..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        className="mb-4 max-w-xs"
      />

      {/* Service grid */}
      {isLoading ? (
        <div className="text-center py-16 text-muted-foreground">Đang tải...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Briefcase className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">Chưa có dịch vụ nào</p>
          <p className="text-sm mt-1">Bấm "Thêm dịch vụ" để bắt đầu</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(s => (
            <ServiceCard
              key={s.id}
              service={s}
              onEdit={s => { setEditService(s); setShowForm(true); }}
            />
          ))}
        </div>
      )}

      <ServiceForm
        open={showForm}
        onClose={() => { setShowForm(false); setEditService(null); }}
        editService={editService}
      />
    </div>
  );
}

// ─── Compat export for service-detail.tsx ────────────────────────────────────
export function ServiceFormModal({ service, onClose }: {
  service: Service;
  onClose: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSave?: (data: any) => void;
  saving?: boolean;
  error?: string;
}) {
  return <ServiceForm open={true} onClose={onClose} editService={service} />;
}
