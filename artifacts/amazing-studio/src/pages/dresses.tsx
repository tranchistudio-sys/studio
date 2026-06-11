import { useState } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, Button, Input, Dialog, Label, Textarea, Select, Badge } from "@/components/ui-elements";
import { useDresses, useCreateDressMutation, useUpdateDressMutation, useDeleteDressMutation } from "@/hooks/use-dresses";
import { useOutfitStats } from "@/hooks/use-outfit-schedule";
import { formatVND } from "@/lib/formatters";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Plus, Edit, Trash2, Tag, Image as ImageIcon, Calendar, BarChart3, Shirt } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useToast } from "@/hooks/use-toast";
import { format, parseISO } from "date-fns";
import { vi } from "date-fns/locale";

const conditionOptions = {
  excellent: "Rất tốt",
  good: "Tốt",
  fair: "Khá",
  needs_repair: "Cần sửa"
};

const dressSchema = z.object({
  code: z.string().min(2, "Mã váy bắt buộc"),
  name: z.string().min(2, "Tên váy bắt buộc"),
  color: z.string().min(1, "Màu sắc bắt buộc"),
  size: z.string().min(1, "Kích thước bắt buộc"),
  style: z.string().optional(),
  rentalPrice: z.coerce.number().min(0, "Giá thuê không hợp lệ"),
  depositRequired: z.coerce.number().min(0, "Tiền cọc không hợp lệ"),
  condition: z.enum(["excellent", "good", "fair", "needs_repair"]),
  notes: z.string().optional(),
  imageUrl: z.string().url("URL ảnh không hợp lệ").optional().or(z.literal('')),
});

type DressFormValues = z.infer<typeof dressSchema>;

export default function Dresses() {
  const [filterAvailable, setFilterAvailable] = useState<boolean | undefined>(undefined);
  const { data: dresses, isLoading } = useDresses(filterAvailable);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  
  const createMutation = useCreateDressMutation();
  const updateMutation = useUpdateDressMutation();
  const deleteMutation = useDeleteDressMutation();
  const { toast } = useToast();

  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<DressFormValues>({
    resolver: zodResolver(dressSchema),
    defaultValues: {
      condition: "excellent",
      rentalPrice: 0,
      depositRequired: 0
    }
  });

  const openCreate = () => {
    setEditingId(null);
    reset({ code: "", name: "", color: "Trắng", size: "M", style: "", rentalPrice: 2000000, depositRequired: 1000000, condition: "excellent", notes: "", imageUrl: "" });
    setIsFormOpen(true);
  };

  const openEdit = (dress: any) => {
    setEditingId(dress.id);
    reset({
      ...dress,
      imageUrl: dress.imageUrl || "",
      style: dress.style || "",
      notes: dress.notes || ""
    });
    setIsFormOpen(true);
  };

  const onSubmit = (data: DressFormValues) => {
    const payload = {
      ...data,
      style: data.style || null,
      notes: data.notes || null,
      imageUrl: data.imageUrl || null,
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, data: payload }, {
        onSuccess: () => {
          setIsFormOpen(false);
          toast({ title: "Thành công", description: "Đã cập nhật váy cưới." });
        }
      });
    } else {
      createMutation.mutate(payload, {
        onSuccess: () => {
          setIsFormOpen(false);
          toast({ title: "Thành công", description: "Đã thêm váy cưới mới." });
        }
      });
    }
  };

  return (
    <Layout>
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground">Bộ sưu tập Váy cưới</h1>
          <p className="text-muted-foreground mt-2">Quản lý kho váy và tình trạng cho thuê</p>
        </div>
        <div className="flex gap-3">
          <Select 
            className="w-40 bg-card" 
            value={filterAvailable === undefined ? "" : filterAvailable.toString()}
            onChange={(e) => {
              const val = e.target.value;
              setFilterAvailable(val === "" ? undefined : val === "true");
            }}
          >
            <option value="">Tất cả trạng thái</option>
            <option value="true">Sẵn sàng</option>
            <option value="false">Đang cho thuê</option>
          </Select>
          <Button onClick={openCreate} className="gap-2">
            <Plus className="w-5 h-5" /> Thêm váy cưới
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><span className="animate-pulse">Đang tải dữ liệu...</span></div>
      ) : dresses?.length === 0 ? (
        <Card className="py-20 text-center text-muted-foreground">
          <Shirt className="w-16 h-16 mx-auto opacity-20 mb-4" />
          <p className="text-lg">Không có váy cưới nào trong kho.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-6">
          {dresses?.map((dress) => (
            <Card key={dress.id} className="overflow-hidden group hover:shadow-xl transition-all duration-300 border-border/50">
              <div className="relative h-64 bg-muted overflow-hidden">
                {dress.imageUrl ? (
                  <img src={dress.imageUrl} alt={dress.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-muted-foreground/30 bg-secondary/30">
                    <ImageIcon className="w-16 h-16" />
                  </div>
                )}
                <div className="absolute top-3 right-3">
                  {dress.isAvailable ? (
                    <Badge variant="success" className="bg-white/90 backdrop-blur-sm border-0 text-green-700 shadow-sm">Sẵn sàng</Badge>
                  ) : (
                    <Badge variant="warning" className="bg-white/90 backdrop-blur-sm border-0 text-amber-700 shadow-sm">Đang thuê</Badge>
                  )}
                </div>
              </div>
              <CardContent className="p-5">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h3 className="font-serif text-xl font-bold text-foreground line-clamp-1">{dress.name}</h3>
                    <p className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                      <Tag className="w-3 h-3" /> {dress.code}
                    </p>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-y-2 mt-4 text-sm">
                  <div className="text-muted-foreground">Màu sắc: <span className="text-foreground font-medium">{dress.color}</span></div>
                  <div className="text-muted-foreground">Size: <span className="text-foreground font-medium">{dress.size}</span></div>
                  <div className="text-muted-foreground col-span-2">Tình trạng: <span className="text-foreground font-medium">{conditionOptions[dress.condition as keyof typeof conditionOptions]}</span></div>
                </div>

                <div className="mt-5 pt-4 border-t border-border/50 flex items-end justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Giá thuê</p>
                    <p className="text-lg font-bold text-primary">{formatVND(dress.rentalPrice)}</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => openEdit(dress)} className="p-2 text-muted-foreground hover:text-primary bg-muted rounded-lg transition-colors">
                      <Edit className="w-4 h-4" />
                    </button>
                    <button onClick={() => {
                      if(confirm("Xóa váy cưới này?")) deleteMutation.mutate(dress.id);
                    }} className="p-2 text-muted-foreground hover:text-destructive bg-muted rounded-lg transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} title={editingId ? "Sửa thông tin váy" : "Thêm váy cưới mới"}>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Mã váy <span className="text-destructive">*</span></Label>
              <Input {...register("code")} placeholder="VD: VD-001" />
              {errors.code && <p className="text-xs text-destructive">{errors.code.message}</p>}
            </div>
            <div className="space-y-2">
              <Label>Tên váy <span className="text-destructive">*</span></Label>
              <Input {...register("name")} placeholder="Váy đuôi cá cúp ngực" />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
          </div>
          
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Màu sắc</Label>
              <Input {...register("color")} />
            </div>
            <div className="space-y-2">
              <Label>Size</Label>
              <Input {...register("size")} />
            </div>
            <div className="space-y-2">
              <Label>Kiểu dáng</Label>
              <Input {...register("style")} placeholder="Đuôi cá, chữ A..." />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Giá thuê (VNĐ) <span className="text-destructive">*</span></Label>
              <CurrencyInput value={String(watch("rentalPrice") || "")} onChange={raw => setValue("rentalPrice", parseFloat(raw) || 0, { shouldValidate: true })} />
            </div>
            <div className="space-y-2">
              <Label>Yêu cầu cọc (VNĐ) <span className="text-destructive">*</span></Label>
              <CurrencyInput value={String(watch("depositRequired") || "")} onChange={raw => setValue("depositRequired", parseFloat(raw) || 0, { shouldValidate: true })} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Tình trạng</Label>
              <Select {...register("condition")}>
                {Object.entries(conditionOptions).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Link ảnh (URL)</Label>
              {/* using stock images for dresses as a prompt requirement demonstration */}
              {/* elegant wedding dress isolated */}
              <Input {...register("imageUrl")} placeholder="https://..." />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Ghi chú</Label>
            <Textarea {...register("notes")} />
          </div>

          {editingId && <DressStatsPanel dressId={editingId} />}

          <div className="flex justify-end gap-3 pt-4 border-t border-border mt-6">
            <Button type="button" variant="ghost" onClick={() => setIsFormOpen(false)}>Hủy</Button>
            <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
              {createMutation.isPending || updateMutation.isPending ? "Đang lưu..." : "Lưu váy cưới"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Layout>
  );
}

// ─── Wardrobe detail stats panel (Task #458) ──────────────────────────────────────
function DressStatsPanel({ dressId }: { dressId: number }) {
  const { data: stats, isLoading } = useOutfitStats(dressId);
  const fmtDM = (d: string) => { try { return format(parseISO(d), "dd/MM", { locale: vi }); } catch { return d; } };
  if (isLoading) return <div className="py-4 text-xs text-muted-foreground flex items-center gap-2"><Calendar className="w-3.5 h-3.5 animate-spin" /> Đang tải thống kê...</div>;
  if (!stats) return null;
  return (
    <div className="border border-border rounded-xl p-3 space-y-3 bg-muted/20">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <BarChart3 className="w-4 h-4 text-primary" />
        Thống kê sử dụng
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-background rounded-lg p-2 border border-border/50">
          <p className="text-lg font-bold text-primary">{stats.totalUses}</p>
          <p className="text-[10px] text-muted-foreground">Tổng lượt dùng</p>
        </div>
        <div className="bg-background rounded-lg p-2 border border-border/50">
          <p className="text-lg font-bold text-primary">{stats.last30Days}</p>
          <p className="text-[10px] text-muted-foreground">30 ngày qua</p>
        </div>
        <div className="bg-background rounded-lg p-2 border border-border/50">
          <p className="text-lg font-bold text-primary">{stats.upcoming?.length ?? 0}</p>
          <p className="text-[10px] text-muted-foreground">Lịch sắp tới</p>
        </div>
      </div>
      {stats.upcoming && stats.upcoming.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-muted-foreground">
            Lịch sắp tới ({stats.upcoming.length})
          </p>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {stats.upcoming.map((row: any) => (
              <div key={row.id} className="flex items-center justify-between text-xs bg-background rounded-lg px-2 py-1.5 border border-border/50">
                <span className="text-muted-foreground">{fmtDM(row.pickup_date)} → {fmtDM(row.return_date)}</span>
                <span className="font-medium truncate max-w-[100px]">{row.order_code || "BK"} · {row.customer_name || ""}</span>
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${row.status === "returned" ? "bg-emerald-100 text-emerald-700" : row.status === "picked_up" ? "bg-blue-100 text-blue-700" : "bg-orange-100 text-orange-700"}`}>
                  {row.status === "returned" ? "Đã trả" : row.status === "picked_up" ? "Đã lấy" : "Đã giữ"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {stats.history && stats.history.length > 0 && (
        <details className="group">
          <summary className="text-[11px] font-semibold text-muted-foreground cursor-pointer list-none flex items-center gap-1">
            <Calendar className="w-3 h-3" /> Lịch sử quá khứ ({stats.history.length})
          </summary>
          <div className="max-h-40 overflow-y-auto space-y-1 mt-1">
            {stats.history.slice(0, 20).map((row: any) => (
              <div key={row.id} className="flex items-center justify-between text-xs bg-background rounded-lg px-2 py-1.5 border border-border/50">
                <span className="text-muted-foreground">{fmtDM(row.pickup_date)} → {fmtDM(row.return_date)}</span>
                <span className="font-medium truncate max-w-[120px]">{row.order_code || "BK"} · {row.customer_name || ""}</span>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-700">Đã trả</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
