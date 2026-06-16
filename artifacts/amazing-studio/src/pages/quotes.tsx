import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useListQuotes,
  useCreateQuote,
  useUpdateQuote,
  useDeleteQuote,
  useConvertQuoteToBooking,
  useListServices,
} from "@workspace/api-client-react";
import type { Quote, Service, Customer } from "@workspace/api-client-react";
import { formatVND, formatDate } from "@/lib/utils";
import { DateInput } from "@/components/ui/date-input";
import {
  Card, CardContent, Badge, Button, Input, Textarea, Select,
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui";
import { Plus, FileText, Pencil, Trash2, ArrowRightCircle, X, Phone, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem("amazingStudioToken_v2");
  const headers = new Headers(opts.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...opts, headers });
}

type ChargeRow = { label: string; amount: number };
type ItemRow = { name: string; quantity: number; unitPrice: number; total: number };

const STATUS_LABEL: Record<
  string,
  { label: string; variant: "default" | "secondary" | "success" | "destructive" }
> = {
  draft:        { label: "Nháp",          variant: "secondary" },
  sent:         { label: "Đã gửi",        variant: "default"   },
  considering:  { label: "Đang cân nhắc", variant: "default"   },
  converted:    { label: "Đã chuyển BK",  variant: "success"   },
  cancelled:    { label: "Đã huỷ",        variant: "destructive" },
};

const Label = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <label className={`block text-xs font-medium text-muted-foreground mb-1 ${className}`}>{children}</label>
);

const DialogFooter = ({ children }: { children: React.ReactNode }) => (
  <div className="flex justify-end gap-2 mt-4 pt-4 border-t">{children}</div>
);

const emptyForm = () => ({
  id: undefined as number | undefined,
  customerId: null as number | null,
  customerName: "",
  phone: "",
  title: "",
  items: [] as ItemRow[],
  surcharges: [] as ChargeRow[],
  deductions: [] as ChargeRow[],
  discount: 0,
  depositAmount: 0,
  expectedDate: "",
  expectedTime: "",
  notes: "",
  status: "draft" as string,
});

type FormState = ReturnType<typeof emptyForm>;

function isAdminRole(): boolean {
  try {
    const raw = localStorage.getItem("amazingStudioUser_v2");
    if (!raw) return false;
    const u = JSON.parse(raw);
    return u?.role === "admin" || u?.isAdmin === true;
  } catch { return false; }
}

export default function QuotesPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = isAdminRole();

  const { data: quotes = [], isLoading, queryKey: quotesKey } = useListQuotes({});
  const { data: services = [] } = useListServices();

  const createMut = useCreateQuote();
  const updateMut = useUpdateQuote();
  const deleteMut = useDeleteQuote();
  const convertMut = useConvertQuoteToBooking();

  const [form, setForm] = useState<FormState>(emptyForm());
  const [editorOpen, setEditorOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertTarget, setConvertTarget] = useState<Quote | null>(null);
  const [convertForm, setConvertForm] = useState({ shootDate: "", shootTime: "08:00", location: "", depositAmount: 0 });

  const packageServices = useMemo(
    () => (services as Service[]).filter((s) => s.isActive && s.type === "package"),
    [services],
  );

  const totals = useMemo(() => {
    const items = form.items;
    const itemsTotal = items.reduce((s, i) => s + (i.total || 0), 0);
    const surchargeTotal = form.surcharges.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const deductionTotal = form.deductions.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const totalAmount = itemsTotal + surchargeTotal;
    const finalAmount = Math.max(0, totalAmount - deductionTotal - (Number(form.discount) || 0));
    const remaining = Math.max(0, finalAmount - (Number(form.depositAmount) || 0));
    return { items, itemsTotal, surchargeTotal, deductionTotal, totalAmount, finalAmount, remaining };
  }, [form]);

  const openCreate = () => { setForm(emptyForm()); setEditorOpen(true); };
  const openEdit = (q: Quote) => {
    setForm({
      id: q.id,
      customerId: q.customerId ?? null,
      customerName: q.customerName ?? "",
      phone: q.customerPhone ?? "",
      title: q.title,
      items: (q.items as ItemRow[]) ?? [],
      surcharges: (q.surcharges as ChargeRow[]) ?? [],
      deductions: (q.deductions as ChargeRow[]) ?? [],
      discount: q.discount ?? 0,
      depositAmount: q.depositAmount ?? 0,
      expectedDate: q.expectedDate ?? "",
      expectedTime: q.expectedTime ?? "",
      notes: q.notes ?? "",
      status: q.status,
    });
    setEditorOpen(true);
  };

  const refreshQuotes = () => qc.invalidateQueries({ queryKey: quotesKey });

  const handleSave = async () => {
    if (!form.title.trim()) {
      toast({ title: "Thiếu tiêu đề", description: "Vui lòng nhập tên báo giá.", variant: "destructive" });
      return;
    }
    if (!form.customerId && !form.phone.trim() && !form.customerName.trim()) {
      toast({ title: "Thiếu khách hàng", description: "Cần chọn khách hoặc nhập SĐT/tên khách mới.", variant: "destructive" });
      return;
    }
    const cleanItems = totals.items
      .map(it => ({ ...it, name: (it.name || "").trim() }))
      .filter(it => it.name && (Number(it.quantity) || 0) > 0 && (Number(it.unitPrice) || 0) >= 0);
    const payload = {
      customerId: form.customerId ?? undefined,
      customerName: form.customerName.trim() || undefined,
      phone: form.phone.trim() || undefined,
      title: form.title.trim(),
      items: cleanItems,
      surcharges: form.surcharges.filter(r => r.label || r.amount),
      deductions: form.deductions.filter(r => r.label || r.amount),
      discount: Number(form.discount) || 0,
      depositAmount: Number(form.depositAmount) || 0,
      expectedDate: form.expectedDate || null,
      expectedTime: form.expectedTime || null,
      notes: form.notes || null,
      status: form.status as "draft" | "sent" | "considering" | "cancelled",
    };
    try {
      if (form.id) {
        await updateMut.mutateAsync({ id: form.id, data: payload });
        toast({ title: "Đã cập nhật", description: "Báo giá đã được lưu." });
      } else {
        await createMut.mutateAsync({ data: payload });
        toast({ title: "Đã tạo báo giá", description: "Báo giá tạm tính mới đã sẵn sàng." });
      }
      setEditorOpen(false);
      refreshQuotes();
    } catch (e) {
      toast({ title: "Lỗi", description: (e as Error).message || "Không thể lưu", variant: "destructive" });
    }
  };

  const handleDelete = async (q: Quote) => {
    if (q.status === "converted") {
      toast({ title: "Không thể xoá", description: "Báo giá đã chuyển booking.", variant: "destructive" });
      return;
    }
    if (!confirm(`Xoá báo giá "${q.title}"?`)) return;
    await deleteMut.mutateAsync({ id: q.id });
    refreshQuotes();
  };

  const openConvert = (q: Quote) => {
    setConvertTarget(q);
    setConvertForm({
      shootDate: q.expectedDate ?? "",
      shootTime: q.expectedTime ?? "08:00",
      location: "",
      depositAmount: q.depositAmount ?? 0,
    });
    setConvertOpen(true);
  };

  const handleConvert = async () => {
    if (!convertTarget) return;
    if (!convertForm.shootDate) {
      toast({ title: "Thiếu ngày chụp", description: "Cần chọn ngày chụp thực tế.", variant: "destructive" });
      return;
    }
    try {
      const r = await convertMut.mutateAsync({
        id: convertTarget.id,
        data: {
          shootDate: convertForm.shootDate,
          shootTime: convertForm.shootTime || null,
          location: convertForm.location || null,
          depositAmount: Number(convertForm.depositAmount) || 0,
        },
      });
      toast({
        title: "Đã chuyển thành booking",
        description: `Mã đơn: ${r.orderCode ?? `#${r.bookingId}`}.`,
      });
      setConvertOpen(false);
      refreshQuotes();
      navigate(`/calendar?bookingId=${r.bookingId}`);
    } catch (e) {
      // ApiError shape: status ở top-level, payload server trả ở `data`.
      const errObj = e as { status?: number; data?: { bookingId?: number } | null } | null;
      if (errObj?.status === 409) {
        const existingBookingId = errObj.data?.bookingId;
        toast({
          title: "Báo giá đã được chuyển trước đó",
          description: existingBookingId
            ? `Booking #${existingBookingId} đã tồn tại. Đang mở...`
            : "Quote này đã ở trạng thái converted. Đang làm mới danh sách...",
        });
        setConvertOpen(false);
        refreshQuotes();
        if (existingBookingId) navigate(`/calendar?bookingId=${existingBookingId}`);
      } else {
        toast({
          title: "Lỗi chuyển booking",
          description: (e as Error)?.message || "Thất bại",
          variant: "destructive",
        });
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Báo giá tạm tính</h1>
          <p className="text-muted-foreground mt-1">
            Báo giá nháp dùng để tham khảo. Khi khách đồng ý, bấm "Chuyển qua booking" để khoá lịch chính thức.
          </p>
        </div>
        <Button className="gap-2" onClick={openCreate}>
          <Plus className="w-4 h-4"/> Tạo báo giá mới
        </Button>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-muted/50 text-muted-foreground uppercase text-xs font-semibold">
              <tr>
                <th className="px-6 py-4">Khách hàng</th>
                <th className="px-6 py-4">Tên báo giá</th>
                <th className="px-6 py-4">Ngày tạo</th>
                <th className="px-6 py-4 text-right">Tổng cuối</th>
                <th className="px-6 py-4 text-center">Trạng thái</th>
                <th className="px-6 py-4 text-center">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-muted-foreground">Đang tải...</td></tr>
              ) : quotes.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-12">
                  <div className="flex flex-col items-center">
                    <FileText className="w-12 h-12 text-muted-foreground/30 mb-4" />
                    <p className="text-muted-foreground">Chưa có báo giá nào</p>
                  </div>
                </td></tr>
              ) : (
                quotes.map(q => {
                  const st = STATUS_LABEL[q.status] ?? STATUS_LABEL.draft;
                  const canConvert = q.status !== "converted" && q.status !== "cancelled";
                  return (
                    <tr key={q.id} className="hover:bg-muted/30">
                      <td className="px-6 py-4">
                        <p className="font-semibold">{q.customerName || <span className="italic text-muted-foreground">— chưa có —</span>}</p>
                        <p className="text-xs text-muted-foreground">{q.customerPhone || ""}</p>
                      </td>
                      <td className="px-6 py-4 font-medium">{q.title}</td>
                      <td className="px-6 py-4 text-muted-foreground">{formatDate(q.createdAt)}</td>
                      <td className="px-6 py-4 text-right font-bold text-primary">{formatVND(q.finalAmount)}</td>
                      <td className="px-6 py-4 text-center">
                        <Badge variant={st.variant}>{st.label}</Badge>
                        {q.convertedBookingId && (
                          <button
                            className="block text-xs text-blue-500 hover:underline mt-1 mx-auto"
                            onClick={() => navigate(`/calendar?bookingId=${q.convertedBookingId}`)}
                          >
                            → Booking #{q.convertedBookingId}
                          </button>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(q)} title="Sửa">
                          <Pencil className="w-4 h-4"/>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-emerald-600 disabled:opacity-30"
                          disabled={!canConvert}
                          onClick={() => openConvert(q)}
                          title="Chuyển qua booking"
                        >
                          <ArrowRightCircle className="w-4 h-4"/>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive disabled:opacity-30"
                          disabled={q.status === "converted"}
                          onClick={() => handleDelete(q)}
                          title="Xoá"
                        >
                          <Trash2 className="w-4 h-4"/>
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ───── Editor Dialog ───── */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? "Sửa báo giá tạm tính" : "Tạo báo giá tạm tính"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            {/* Khách hàng */}
            <Card><CardContent className="p-4 space-y-3">
              <div className="text-base font-semibold">Khách hàng</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Số điện thoại</Label>
                  <PhoneAutocomplete
                    value={form.phone}
                    onChange={(v) => setForm(f => ({ ...f, phone: v, customerId: null }))}
                    onSelect={(c) => setForm(f => ({
                      ...f,
                      customerId: c.id,
                      customerName: c.name ?? f.customerName,
                      phone: c.phone ?? f.phone,
                    }))}
                  />
                </div>
                <div>
                  <Label>Tên khách</Label>
                  <Input
                    value={form.customerName}
                    onChange={(e) => setForm(f => ({ ...f, customerName: e.target.value }))}
                    placeholder="VD: Anh Tuấn"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label>Tên báo giá *</Label>
                  <Input
                    value={form.title}
                    onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))}
                    placeholder="VD: Báo giá chụp cưới"
                  />
                </div>
              </div>
            </CardContent></Card>

            {/* Dịch vụ */}
            <ItemListEditor
              rows={form.items}
              setRows={(rows) => setForm(f => ({ ...f, items: rows }))}
              packageServices={packageServices}
            />

            {/* Phụ thu */}
            <ChargeListEditor
              title="Phụ thu (cộng vào tổng)"
              rows={form.surcharges}
              setRows={(rows) => setForm(f => ({ ...f, surcharges: rows }))}
            />

            {/* Giảm trừ — admin only */}
            {isAdmin && (
              <ChargeListEditor
                title="Giảm trừ (chỉ admin)"
                rows={form.deductions}
                setRows={(rows) => setForm(f => ({ ...f, deductions: rows }))}
              />
            )}

            {/* Khác */}
            <Card><CardContent className="p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Ngày dự kiến (tham khảo)</Label>
                  <DateInput value={form.expectedDate} onChange={v => setForm(f => ({ ...f, expectedDate: v }))}/>
                </div>
                <div>
                  <Label>Giờ dự kiến</Label>
                  <Input type="time" value={form.expectedTime} onChange={(e) => setForm(f => ({ ...f, expectedTime: e.target.value }))}/>
                </div>
                <div>
                  <Label>Tiền cọc tham khảo (VND)</Label>
                  <Input
                    type="number" min={0}
                    value={form.depositAmount}
                    onChange={(e) => setForm(f => ({ ...f, depositAmount: Number(e.target.value) || 0 }))}
                  />
                </div>
                <div>
                  <Label>Giảm giá (VND)</Label>
                  <Input
                    type="number" min={0}
                    value={form.discount}
                    onChange={(e) => setForm(f => ({ ...f, discount: Number(e.target.value) || 0 }))}
                  />
                </div>
                <div>
                  <Label>Trạng thái</Label>
                  <Select value={form.status} onChange={(e) => setForm(f => ({ ...f, status: e.target.value }))}>
                    <option value="draft">Nháp</option>
                    <option value="sent">Đã gửi</option>
                    <option value="considering">Đang cân nhắc</option>
                    <option value="cancelled">Huỷ</option>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Ghi chú</Label>
                <Textarea rows={2} value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}/>
              </div>
            </CardContent></Card>

            {/* Tổng tiền tự động */}
            <Card className="bg-muted/40"><CardContent className="p-4 space-y-1 text-sm">
              <div className="flex justify-between"><span>Giá dịch vụ</span><span>{formatVND(totals.itemsTotal)}</span></div>
              <div className="flex justify-between"><span>+ Phụ thu</span><span>{formatVND(totals.surchargeTotal)}</span></div>
              {isAdmin && <div className="flex justify-between text-amber-700"><span>− Giảm trừ</span><span>{formatVND(totals.deductionTotal)}</span></div>}
              <div className="flex justify-between"><span>− Giảm giá</span><span>{formatVND(Number(form.discount) || 0)}</span></div>
              <div className="flex justify-between font-bold border-t pt-2 mt-2 text-base"><span>Tổng cuối</span><span className="text-primary">{formatVND(totals.finalAmount)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>Cọc tham khảo</span><span>{formatVND(Number(form.depositAmount) || 0)}</span></div>
              <div className="flex justify-between font-semibold"><span>Còn lại</span><span>{formatVND(totals.remaining)}</span></div>
            </CardContent></Card>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>Huỷ</Button>
            <Button onClick={handleSave} disabled={createMut.isPending || updateMut.isPending}>
              {form.id ? "Lưu thay đổi" : "Tạo báo giá"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ───── Convert Dialog ───── */}
      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Chuyển báo giá thành booking</DialogTitle>
          </DialogHeader>
          {convertTarget && (
            <div className="space-y-3">
              <div className="text-sm text-muted-foreground">
                Báo giá: <span className="font-semibold text-foreground">{convertTarget.title}</span>
                <br/>
                Khách: <span className="font-semibold text-foreground">{convertTarget.customerName} {convertTarget.customerPhone ? `· ${convertTarget.customerPhone}` : ""}</span>
                <br/>
                Tổng: <span className="font-bold text-primary">{formatVND(convertTarget.finalAmount)}</span>
              </div>
              <div>
                <Label>Ngày chụp thực tế *</Label>
                <DateInput value={convertForm.shootDate} onChange={v => setConvertForm(f => ({ ...f, shootDate: v }))}/>
              </div>
              <div>
                <Label>Giờ chụp</Label>
                <Input type="time" value={convertForm.shootTime} onChange={(e) => setConvertForm(f => ({ ...f, shootTime: e.target.value }))}/>
              </div>
              <div>
                <Label>Địa điểm</Label>
                <Input value={convertForm.location} onChange={(e) => setConvertForm(f => ({ ...f, location: e.target.value }))}/>
              </div>
              <div>
                <Label>Cọc đã thu (VND)</Label>
                <Input
                  type="number" min={0}
                  value={convertForm.depositAmount}
                  onChange={(e) => setConvertForm(f => ({ ...f, depositAmount: Number(e.target.value) || 0 }))}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertOpen(false)}>Huỷ</Button>
            <Button onClick={handleConvert} disabled={convertMut.isPending} className="gap-2">
              <ArrowRightCircle className="w-4 h-4"/> Chuyển booking
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PhoneAutocomplete({ value, onChange, onSelect }: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (c: Customer) => void;
}) {
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 250);
    return () => clearTimeout(t);
  }, [value]);
  const { data: results = [] } = useQuery<Customer[]>({
    queryKey: ["customer-search", debounced],
    queryFn: () => authFetch(`${BASE}/api/customers?search=${encodeURIComponent(debounced)}`)
      .then(r => r.ok ? r.json() : [])
      .then((d: unknown) => Array.isArray(d) ? d : []),
    enabled: debounced.length >= 1,
    staleTime: 5_000,
  });
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="VD: 0912345678"
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => value.length >= 1 && setOpen(true)}
        />
      </div>
      {open && value.trim().length >= 1 && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 bg-background border border-border rounded-xl shadow-lg mt-1 max-h-56 overflow-y-auto">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-3 pt-2 pb-1">Khách cũ gợi ý</p>
          {results.slice(0, 8).map((c) => (
            <button
              key={c.id}
              type="button"
              className="w-full text-left px-3 py-2 hover:bg-muted/60 flex items-center gap-2"
              onMouseDown={() => { onSelect(c); setOpen(false); }}
            >
              <Check className="w-3 h-3 text-emerald-600" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm truncate">{c.name}</p>
                <p className="text-xs text-muted-foreground">{c.phone || "—"}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemListEditor({ rows, setRows, packageServices }: {
  rows: ItemRow[];
  setRows: (r: ItemRow[]) => void;
  packageServices: Service[];
}) {
  const update = (idx: number, patch: Partial<ItemRow>) => {
    const next = [...rows];
    const merged = { ...next[idx], ...patch };
    merged.total = (Number(merged.quantity) || 0) * (Number(merged.unitPrice) || 0);
    next[idx] = merged;
    setRows(next);
  };
  return (
    <Card><CardContent className="p-4 space-y-2">
      <div className="flex justify-between items-center">
        <div className="text-base font-semibold">Dịch vụ</div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRows([...rows, { name: "", quantity: 1, unitPrice: 0, total: 0 }])}
        >
          <Plus className="w-3 h-3 mr-1"/> Thêm dịch vụ
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">Chưa có dịch vụ nào — bấm "Thêm dịch vụ".</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-start border rounded-lg p-2">
              <div className="col-span-12 sm:col-span-6">
                <Label>Tên dịch vụ</Label>
                <Select
                  value={row.name && packageServices.some(p => p.name === row.name) ? row.name : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    const s = packageServices.find(p => p.name === v);
                    if (s) update(idx, { name: s.name, unitPrice: s.price });
                  }}
                >
                  <option value="">-- Chọn gói có sẵn --</option>
                  {packageServices.map(s => (
                    <option key={s.id} value={s.name}>{s.name} · {formatVND(s.price)}</option>
                  ))}
                </Select>
                <Input
                  className="mt-1"
                  placeholder="Hoặc nhập tên dịch vụ tuỳ chỉnh"
                  value={row.name}
                  onChange={(e) => update(idx, { name: e.target.value })}
                />
              </div>
              <div className="col-span-3 sm:col-span-2">
                <Label>SL</Label>
                <Input
                  type="number" min={1}
                  value={row.quantity}
                  onChange={(e) => update(idx, { quantity: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="col-span-6 sm:col-span-3">
                <Label>Đơn giá (VND)</Label>
                <Input
                  type="number" min={0}
                  value={row.unitPrice}
                  onChange={(e) => update(idx, { unitPrice: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="col-span-3 sm:col-span-1 flex flex-col items-end">
                <Label>&nbsp;</Label>
                <Button variant="ghost" size="icon" onClick={() => setRows(rows.filter((_, i) => i !== idx))}>
                  <X className="w-4 h-4"/>
                </Button>
              </div>
              <div className="col-span-12 text-right text-xs text-muted-foreground -mt-1">
                Thành tiền: <span className="font-semibold text-foreground">{formatVND(row.total)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </CardContent></Card>
  );
}

function ChargeListEditor({ title, rows, setRows }: { title: string; rows: ChargeRow[]; setRows: (r: ChargeRow[]) => void }) {
  return (
    <Card><CardContent className="p-4 space-y-2">
      <div className="flex justify-between items-center">
        <div className="text-base font-semibold">{title}</div>
        <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { label: "", amount: 0 }])}>
          <Plus className="w-3 h-3 mr-1"/> Thêm dòng
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">Chưa có dòng nào.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, idx) => (
            <div key={idx} className="flex gap-2">
              <Input
                placeholder="Mô tả"
                value={row.label}
                onChange={(e) => {
                  const next = [...rows]; next[idx] = { ...next[idx], label: e.target.value }; setRows(next);
                }}
              />
              <Input
                type="number" min={0}
                placeholder="Số tiền"
                className="w-40"
                value={row.amount}
                onChange={(e) => {
                  const next = [...rows]; next[idx] = { ...next[idx], amount: Number(e.target.value) || 0 }; setRows(next);
                }}
              />
              <Button variant="ghost" size="icon" onClick={() => setRows(rows.filter((_, i) => i !== idx))}>
                <X className="w-4 h-4"/>
              </Button>
            </div>
          ))}
        </div>
      )}
    </CardContent></Card>
  );
}
