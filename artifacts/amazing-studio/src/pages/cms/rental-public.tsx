import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Shirt, Eye, EyeOff, FileText, Search, Upload, Loader2 } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { authHeaders, CMS_BASE, MultiImageUploader, LazyImage, type UploadedImage } from "@/components/cms-shared";
import { formatVND } from "@/lib/utils";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

interface PublicRental {
  id: number; code: string; name: string; category: string; color: string; size: string;
  rentalPrice: number; imageUrl: string | null; publicImageUrl: string | null;
  isPublic: boolean; cmsStatus: "draft" | "visible" | "hidden";
}

export default function CmsRentalPublicPage() {
  const qc = useQueryClient();
  const { effectiveIsAdmin } = useStaffAuth();
  const [search, setSearch] = useState("");
  const [uploadingId, setUploadingId] = useState<number | null>(null);

  const { data: rentals = [], isLoading } = useQuery<PublicRental[]>({
    queryKey: ["cms-rentals"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/rentals`, { headers: authHeaders() }).then(r => r.json()),
  });

  const update = useMutation({
    mutationFn: (p: { id: number; [k: string]: unknown }) => {
      const { id, ...body } = p;
      return fetch(`${CMS_BASE}/api/cms/rentals/${id}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify(body),
      }).then(async r => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi lưu");
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cms-rentals"] }),
    onError: (e: Error) => alert(e.message),
  });

  const filtered = useMemo(() => {
    if (!search) return rentals;
    const q = search.toLowerCase();
    return rentals.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.code.toLowerCase().includes(q) ||
      (r.category ?? "").toLowerCase().includes(q) ||
      (r.color ?? "").toLowerCase().includes(q)
    );
  }, [rentals, search]);

  const grouped = useMemo(() => {
    const m = new Map<string, PublicRental[]>();
    filtered.forEach(r => {
      const k = r.category || "Chưa phân loại";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    });
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const publicCount = rentals.filter(r => r.isPublic).length;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Shirt className="w-6 h-6 text-primary" /> Hiển thị website
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Chọn trang phục hiển thị trên trang Cho thuê đồ công khai. Đang hiển thị: <strong>{publicCount}/{rentals.length}</strong> món.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Tìm tên, mã, màu, loại..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Đang tải...</div>
      ) : (
        <div className="space-y-5">
          {grouped.map(([cat, items]) => (
            <div key={cat} className="border border-border rounded-2xl overflow-hidden bg-card">
              <div className="px-4 py-3 bg-muted/30 border-b flex items-center justify-between">
                <p className="font-semibold text-sm">{cat}</p>
                <span className="text-xs text-muted-foreground">{items.filter(i => i.isPublic).length}/{items.length} public</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-border">
                {items.map(item => (
                  <div key={item.id} className="bg-card p-3 space-y-2">
                    <div className="flex gap-3">
                      {/* Ảnh public */}
                      <div className="relative flex-shrink-0">
                        <LazyImage
                          src={item.publicImageUrl || item.imageUrl}
                          className="w-16 h-20 rounded-lg"
                        />
                        <button
                          onClick={() => setUploadingId(uploadingId === item.id ? null : item.id)}
                          className="absolute -bottom-1 -right-1 bg-primary text-primary-foreground rounded-full p-0.5 shadow-sm"
                          title="Đổi ảnh public"
                        >
                          <Upload className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">{item.name}</p>
                        <p className="text-[10px] text-muted-foreground">{item.code}</p>
                        <p className="text-[11px] text-muted-foreground">{item.color} · {item.size}</p>
                        <p className="font-bold text-primary text-sm mt-1">{formatVND(item.rentalPrice)}</p>
                      </div>
                    </div>

                    {uploadingId === item.id && (
                      <div className="mt-2">
                        <MultiImageUploader
                          multiple={false}
                          label="Chọn hoặc dán ảnh public"
                          onUploaded={(imgs: UploadedImage[]) => {
                            update.mutate({ id: item.id, publicImageUrl: imgs[0]?.objectPath });
                            setUploadingId(null);
                          }}
                        />
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 flex-wrap pt-1">
                      <StatusPill status={item.cmsStatus} />
                      <select
                        value={item.cmsStatus}
                        onChange={e => update.mutate({ id: item.id, cmsStatus: e.target.value })}
                        className="text-xs px-1.5 py-1 border border-input rounded bg-background"
                      >
                        <option value="draft">Nháp</option>
                        {effectiveIsAdmin && <option value="visible">Hiện</option>}
                        {effectiveIsAdmin && <option value="hidden">Ẩn</option>}
                      </select>
                      {effectiveIsAdmin && (
                        <button
                          onClick={() => update.mutate({ id: item.id, isPublic: !item.isPublic })}
                          className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-full font-medium transition-colors ${
                            item.isPublic ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-slate-200 text-slate-700 hover:bg-slate-300"
                          }`}
                        >
                          {item.isPublic ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                          {item.isPublic ? "Public" : "Ẩn"}
                        </button>
                      )}
                      {update.isPending && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const m: Record<string, { label: string; cls: string; Icon: typeof Eye }> = {
    visible: { label: "Hiện", cls: "bg-emerald-100 text-emerald-700", Icon: Eye },
    hidden: { label: "Ẩn", cls: "bg-slate-200 text-slate-700", Icon: EyeOff },
    draft: { label: "Nháp", cls: "bg-amber-100 text-amber-700", Icon: FileText },
  };
  const v = m[status] ?? m.draft;
  return <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${v.cls}`}><v.Icon className="w-3 h-3" />{v.label}</span>;
}
