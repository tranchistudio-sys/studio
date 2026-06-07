import { useState } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, Button, Input, Dialog, Label, Textarea, Select, Badge } from "@/components/ui-elements";
import { useRentals, useCreateRentalMutation, useUpdateRentalMutation } from "@/hooks/use-rentals";
import { useCustomers } from "@/hooks/use-customers";
import { useDresses } from "@/hooks/use-dresses";
import { formatVND, formatDate } from "@/lib/formatters";
import { CurrencyInput } from "@/components/ui/currency-input";
import { DateInput } from "@/components/ui/date-input";
import { Plus, CalendarRange, CheckCircle2, AlertCircle } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useToast } from "@/hooks/use-toast";
import type { RentalStatus } from "@workspace/api-client-react/src/generated/api.schemas";

const statusMap: Record<RentalStatus, { label: string, color: any }> = {
  rented: { label: "Đang thuê", color: "warning" },
  returned: { label: "Đã trả", color: "success" },
  overdue: { label: "Quá hạn", color: "destructive" },
};

const createRentalSchema = z.object({
  customerId: z.coerce.number().min(1, "Chọn khách hàng"),
  dressId: z.coerce.number().min(1, "Chọn váy"),
  rentalDate: z.string().min(1, "Chọn ngày thuê"),
  returnDate: z.string().min(1, "Chọn ngày trả dự kiến"),
  rentalPrice: z.coerce.number().min(0, "Giá không hợp lệ"),
  depositPaid: z.coerce.number().min(0, "Cọc không hợp lệ"),
  notes: z.string().optional(),
});

type CreateRentalFormValues = z.infer<typeof createRentalSchema>;

export default function Rentals() {
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined);
  const { data: rentals, isLoading } = useRentals(filterStatus);
  const { data: customers } = useCustomers();
  const { data: availableDresses } = useDresses(true); // Only available
  
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [returnId, setReturnId] = useState<number | null>(null);
  
  const createMutation = useCreateRentalMutation();
  const updateMutation = useUpdateRentalMutation();
  const { toast } = useToast();

  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<CreateRentalFormValues>({
    resolver: zodResolver(createRentalSchema),
    defaultValues: { rentalPrice: 0, depositPaid: 0 }
  });

  const selectedDressId = watch("dressId");

  const openCreate = () => {
    reset({ customerId: 0, dressId: 0, rentalDate: new Date().toISOString().split('T')[0], returnDate: "", rentalPrice: 0, depositPaid: 0, notes: "" });
    setIsFormOpen(true);
  };

  const handleDressSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = parseInt(e.target.value);
    setValue("dressId", id);
    const dress = availableDresses?.find(d => d.id === id);
    if (dress) {
      setValue("rentalPrice", dress.rentalPrice);
      setValue("depositPaid", dress.depositRequired);
    }
  };

  const onSubmitCreate = (data: CreateRentalFormValues) => {
    createMutation.mutate({
      ...data,
      notes: data.notes || null
    }, {
      onSuccess: () => {
        setIsFormOpen(false);
        toast({ title: "Thành công", description: "Đã tạo phiếu thuê váy." });
      }
    });
  };

  const markAsReturned = (id: number) => {
    updateMutation.mutate({
      id,
      data: { status: "returned", actualReturnDate: new Date().toISOString().split('T')[0] }
    }, {
      onSuccess: () => toast({ title: "Thành công", description: "Đã ghi nhận trả váy." })
    });
  };

  return (
    <Layout>
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground">Cho thuê váy</h1>
          <p className="text-muted-foreground mt-2">Theo dõi tình trạng mượn trả váy cưới</p>
        </div>
        <div className="flex gap-3">
          <Select 
            className="w-40 bg-card" 
            value={filterStatus || ""}
            onChange={(e) => setFilterStatus(e.target.value || undefined)}
          >
            <option value="">Tất cả trạng thái</option>
            <option value="rented">Đang thuê</option>
            <option value="returned">Đã trả</option>
            <option value="overdue">Quá hạn</option>
          </Select>
          <Button onClick={openCreate} className="gap-2">
            <Plus className="w-5 h-5" /> Tạo phiếu thuê
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {isLoading ? (
          <div className="col-span-full text-center py-20">Đang tải...</div>
        ) : rentals?.length === 0 ? (
          <div className="col-span-full text-center py-20 text-muted-foreground">Không có phiếu thuê nào.</div>
        ) : (
          rentals?.map((rental) => (
            <Card key={rental.id} className={`border-l-4 ${rental.status === 'overdue' ? 'border-l-destructive' : rental.status === 'rented' ? 'border-l-warning' : 'border-l-success'}`}>
              <CardContent className="p-6">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-serif text-lg font-bold">{rental.customerName}</h3>
                    <p className="text-sm text-muted-foreground">{rental.customerPhone}</p>
                  </div>
                  <Badge variant={statusMap[rental.status].color}>{statusMap[rental.status].label}</Badge>
                </div>
                
                <div className="bg-muted/50 p-4 rounded-xl mb-4">
                  <p className="font-medium text-primary mb-1">{rental.dressName}</p>
                  <p className="text-xs text-muted-foreground">Mã: {rental.dressCode}</p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                  <div>
                    <p className="text-muted-foreground mb-1">Ngày thuê</p>
                    <p className="font-medium">{formatDate(rental.rentalDate)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">Hạn trả</p>
                    <p className={`font-medium ${rental.status === 'overdue' ? 'text-destructive' : ''}`}>{formatDate(rental.returnDate)}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-border">
                  <div className="text-sm">
                    <span className="text-muted-foreground">Cọc: </span> 
                    <span className="font-medium">{formatVND(rental.depositPaid)}</span>
                  </div>
                  
                  {rental.status !== 'returned' && (
                    <Button size="sm" variant="outline" onClick={() => markAsReturned(rental.id)} className="gap-2 border-primary text-primary hover:bg-primary/10">
                      <CheckCircle2 className="w-4 h-4" /> Nhận lại váy
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <Dialog isOpen={isFormOpen} onClose={() => setIsFormOpen(false)} title="Tạo phiếu thuê váy">
        <form onSubmit={handleSubmit(onSubmitCreate)} className="space-y-4">
          <div className="space-y-2">
            <Label>Khách hàng <span className="text-destructive">*</span></Label>
            <Select {...register("customerId")}>
              <option value={0} disabled>Chọn khách hàng...</option>
              {customers?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Váy cưới (Chỉ hiển thị váy có sẵn) <span className="text-destructive">*</span></Label>
            <Select {...register("dressId")} onChange={handleDressSelect}>
              <option value={0} disabled>Chọn váy...</option>
              {availableDresses?.map(d => <option key={d.id} value={d.id}>[{d.code}] {d.name} - {formatVND(d.rentalPrice)}</option>)}
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Ngày bắt đầu thuê <span className="text-destructive">*</span></Label>
              <DateInput value={watch("rentalDate") || ""} onChange={v => setValue("rentalDate", v, { shouldValidate: true })} />
            </div>
            <div className="space-y-2">
              <Label>Ngày trả dự kiến <span className="text-destructive">*</span></Label>
              <DateInput value={watch("returnDate") || ""} onChange={v => setValue("returnDate", v, { shouldValidate: true })} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 p-4 bg-muted/30 rounded-xl">
            <div className="space-y-2">
              <Label>Giá thuê (VNĐ)</Label>
              <CurrencyInput value={String(watch("rentalPrice") || "")} onChange={raw => setValue("rentalPrice", parseFloat(raw) || 0, { shouldValidate: true })} />
            </div>
            <div className="space-y-2">
              <Label>Tiền cọc nhận (VNĐ)</Label>
              <CurrencyInput value={String(watch("depositPaid") || "")} onChange={raw => setValue("depositPaid", parseFloat(raw) || 0, { shouldValidate: true })} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Ghi chú tình trạng lúc giao</Label>
            <Textarea {...register("notes")} placeholder="VD: Váy hoàn hảo, có kèm lúp..." />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={() => setIsFormOpen(false)}>Hủy</Button>
            <Button type="submit" disabled={createMutation.isPending}>Tạo phiếu</Button>
          </div>
        </form>
      </Dialog>
    </Layout>
  );
}
