import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DollarSign, Eye, EyeOff, FileText, Save, Loader2, Search, Globe } from "lucide-react";
import { getPublicPageUrl } from "@/lib/public-site-url";
import { Button, Input } from "@/components/ui";
import { authHeaders, CMS_BASE } from "@/components/cms-shared";
import { formatVND } from "@/lib/utils";

interface PublicPkg {
  id: number; code: string | null; name: string; price: number;
  groupId: number | null; groupName: string | null;
  shortDescription: string | null;
  isPublic: boolean; cmsStatus: "draft" | "visible" | "hidden";
}

export default function CmsPricingPublicPage() {
  const qc = useQueryClient();
  const effectiveIsAdmin = true; // CMS Website mở toàn quyền cho mọi nhân viên
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftShort, setDraftShort] = useState("");
  const [draftPrice, setDraftPrice] = useState<string>("");

  const { data: packages = [], isLoading } = useQuery<PublicPkg[]>({
    queryKey: ["cms-packages"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/packages`, { headers: authHeaders() }).then(r => r.json()),
  });

  const update = useMutation({
    mutationFn: (p: { id: number; [k: string]: unknown }) => {
      const { id, ...body } = p;
      return fetch(`${CMS_BASE}/api/cms/packages/${id}`, {
        method: "PATCH", headers: authHeaders(), body: JSON.stringify(body),
      }).then(async r => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Lỗi lưu");
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cms-packages"] }),
    onError: (e: Error) => alert(e.message),
  });

  const filtered = useMemo(() => {
    if (!search) return packages;
    const q = search.toLowerCase();
    return packages.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.code ?? "").toLowerCase().includes(q) ||
      (p.groupName ?? "").toLowerCase().includes(q)
    );
  }, [packages, search]);

  const grouped = useMemo(() => {
    const m = new Map<string, PublicPkg[]>();
    filtered.forEach(p => {
      const k = p.groupName ?? "Khác";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    });
    return Array.from(m.entries());
  }, [filtered]);

  const publicCount = packages.filter(p => p.isPublic).length;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-primary" /> Bảng giá public
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Chọn các gói dịch vụ hiển thị trên trang Bảng giá công khai. Đang hiển thị: <strong>{publicCount}/{packages.length}</strong> gói.
          </p>
        </div>
        <a
          href={getPublicPageUrl("/bang-gia")}
          target="_blank"
          rel="noopener noreferrer"
          title="Xem trang Bảng giá trên website"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground border border-border rounded-lg px-3 py-2 hover:bg-muted transition-colors flex-shrink-0"
        >
          <Globe className="w-4 h-4" />
          Xem trang public
        </a>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Tìm gói, nhóm..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Đang tải...</div>
      ) : (
        <div className="space-y-5">
          {grouped.map(([groupName, pkgs]) => (
            <div key={groupName} className="border border-border rounded-2xl overflow-hidden bg-card">
              <div className="px-4 py-3 bg-muted/30 border-b flex items-center justify-between">
                <p className="font-semibold text-sm">{groupName}</p>
                <span className="text-xs text-muted-foreground">{pkgs.filter(p => p.isPublic).length}/{pkgs.length} public</span>
              </div>
              <div className="divide-y divide-border">
                {pkgs.map(p => {
                  const editing = editingId === p.id;
                  return (
                    <div key={p.id} className="px-4 py-3 hover:bg-muted/10">
                      <div className="flex items-start gap-3 flex-wrap">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-semibold text-sm truncate">{p.name}</p>
                            {p.code && <span className="text-[10px] px-1.5 py-0.5 bg-muted rounded">{p.code}</span>}
                            <StatusPill status={p.cmsStatus} />
                          </div>
                          {editing ? (
                            <div className="mt-2 space-y-2">
                              {effectiveIsAdmin && (
                                <div>
                                  <label className="text-xs text-muted-foreground">Giá public (VNĐ)</label>
                                  <Input
                                    type="number" value={draftPrice}
                                    onChange={e => setDraftPrice(e.target.value)}
                                    className="h-8 text-sm w-40"
                                  />
                                </div>
                              )}
                              <div>
                                <label className="text-xs text-muted-foreground">Mô tả ngắn (hiển thị trên web)</label>
                                <textarea
                                  value={draftShort} onChange={e => setDraftShort(e.target.value)}
                                  className="w-full mt-0.5 px-3 py-1.5 text-sm border border-input rounded-md bg-background"
                                  rows={2} placeholder="VD: Trọn gói chụp tiệc cưới với 2 photographer chuyên nghiệp"
                                />
                              </div>
                              <div className="flex gap-2">
                                <Button size="sm" onClick={() => {
                                  const payload: { id: number; shortDescription: string; price?: number } = {
                                    id: p.id, shortDescription: draftShort,
                                  };
                                  if (effectiveIsAdmin && draftPrice) payload.price = Number(draftPrice);
                                  update.mutate(payload, { onSuccess: () => setEditingId(null) });
                                }}>
                                  <Save className="w-3.5 h-3.5" /> Lưu
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>Huỷ</Button>
                              </div>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                              {p.shortDescription || <span className="italic">Chưa có mô tả ngắn</span>}
                            </p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-primary text-sm">{formatVND(p.price)}</p>
                        </div>
                        {!editing && (
                          <div className="flex flex-col gap-1.5 items-end">
                            <Button size="sm" variant="outline" onClick={() => {
                              setEditingId(p.id);
                              setDraftShort(p.shortDescription ?? "");
                              setDraftPrice(String(p.price));
                            }}>
                              Sửa
                            </Button>
                            <select
                              value={p.cmsStatus} disabled={!effectiveIsAdmin && p.cmsStatus !== "draft"}
                              onChange={e => update.mutate({ id: p.id, cmsStatus: e.target.value })}
                              className="text-xs px-2 py-1 border border-input rounded bg-background"
                            >
                              <option value="draft">Nháp</option>
                              {effectiveIsAdmin && <option value="visible">Hiện</option>}
                              {effectiveIsAdmin && <option value="hidden">Ẩn</option>}
                            </select>
                            {effectiveIsAdmin && (
                              <button
                                onClick={() => update.mutate({ id: p.id, isPublic: !p.isPublic })}
                                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full font-medium transition-colors ${
                                  p.isPublic ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200" : "bg-slate-200 text-slate-700 hover:bg-slate-300"
                                }`}
                              >
                                {p.isPublic ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                                {p.isPublic ? "Public" : "Ẩn"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {update.isPending && <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Đang lưu...</p>}
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
