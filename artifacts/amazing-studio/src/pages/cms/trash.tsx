import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, RotateCcw, Flame, AlertTriangle, Images, Tag, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { authHeaders, CMS_BASE, LazyImage } from "@/components/cms-shared";
import { useStaffAuth } from "@/contexts/StaffAuthContext";

interface TrashAlbum { id: number; title: string; deletedAt: string }
interface TrashPhoto { id: number; imageUrl: string; albumId: number; deletedAt: string }
interface TrashCategory { id: number; title: string; type: string; deletedAt: string }
interface TrashData {
  albums: TrashAlbum[];
  photos: TrashPhoto[];
  categories: TrashCategory[];
}

function fmtDate(s: string) {
  try { return new Date(s).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }); } catch { return s; }
}

export default function CmsTrashPage() {
  const qc = useQueryClient();
  const { effectiveIsAdmin } = useStaffAuth();
  const [tab, setTab] = useState<"albums" | "photos" | "categories">("albums");

  const { data, isLoading, refetch } = useQuery<TrashData>({
    queryKey: ["cms-trash"],
    queryFn: () => fetch(`${CMS_BASE}/api/cms/trash`, { headers: authHeaders() }).then(r => r.json()),
  });

  const restore = useMutation({
    mutationFn: ({ type, id }: { type: string; id: number }) =>
      fetch(`${CMS_BASE}/api/cms/${type}/${id}/restore`, { method: "POST", headers: authHeaders() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-trash"] }); qc.invalidateQueries({ queryKey: ["cms-albums"] }); qc.invalidateQueries({ queryKey: ["cms-categories"] }); },
  });

  const purge = useMutation({
    mutationFn: ({ type, id }: { type: string; id: number }) =>
      fetch(`${CMS_BASE}/api/cms/${type}/${id}/purge`, { method: "DELETE", headers: authHeaders() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-trash"] }); },
  });

  const confirmPurge = (type: string, id: number, name: string) => {
    if (confirm(`Xoá vĩnh viễn "${name}"? Không thể hoàn tác!`)) purge.mutate({ type, id });
  };

  const albums = data?.albums ?? [];
  const photos = data?.photos ?? [];
  const cats = data?.categories ?? [];
  const totalCount = albums.length + photos.length + cats.length;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Trash2 className="w-6 h-6 text-destructive" /> Thùng rác CMS
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Các mục đã xoá mềm. Khôi phục hoặc xoá vĩnh viễn. Tổng: <strong>{totalCount}</strong> mục.
        </p>
      </div>

      {!effectiveIsAdmin && (
        <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          Chỉ admin mới có thể thao tác với thùng rác.
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit">
        {([
          { key: "albums", label: "Album", count: albums.length, Icon: Images },
          { key: "photos", label: "Ảnh lẻ", count: photos.length, Icon: Images },
          { key: "categories", label: "Danh mục", count: cats.length, Icon: Tag },
        ] as const).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.key ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}>
            <t.Icon className="w-4 h-4" />
            {t.label}
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === t.key ? "bg-destructive/10 text-destructive" : "bg-muted"}`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground"><Loader2 className="w-8 h-8 animate-spin mx-auto" /></div>
      ) : (
        <>
          {tab === "albums" && (
            albums.length === 0 ? <EmptyTrash /> : (
              <div className="space-y-2">
                {albums.map(a => (
                  <TrashRow
                    key={a.id} name={a.title} date={a.deletedAt}
                    onRestore={effectiveIsAdmin ? () => restore.mutate({ type: "albums", id: a.id }) : undefined}
                    onPurge={effectiveIsAdmin ? () => confirmPurge("albums", a.id, a.title) : undefined}
                    isPending={restore.isPending || purge.isPending}
                  />
                ))}
              </div>
            )
          )}

          {tab === "photos" && (
            photos.length === 0 ? <EmptyTrash /> : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {photos.map(p => (
                  <div key={p.id} className="relative rounded-xl overflow-hidden border border-border bg-card group">
                    <LazyImage src={p.imageUrl} className="aspect-square w-full" />
                    <div className="p-2 text-xs text-muted-foreground">{fmtDate(p.deletedAt)}</div>
                    {effectiveIsAdmin && (
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-2 p-2">
                        <Button size="sm" variant="outline" className="bg-white/90 text-black w-full text-xs"
                          onClick={() => restore.mutate({ type: "photos", id: p.id })}>
                          <RotateCcw className="w-3.5 h-3.5" /> Khôi phục
                        </Button>
                        <Button size="sm" variant="destructive" className="w-full text-xs"
                          onClick={() => confirmPurge("photos", p.id, `Ảnh #${p.id}`)}>
                          <Flame className="w-3.5 h-3.5" /> Xoá vĩnh viễn
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {tab === "categories" && (
            cats.length === 0 ? <EmptyTrash /> : (
              <div className="space-y-2">
                {cats.map(c => (
                  <TrashRow
                    key={c.id} name={`${c.title} (${c.type})`} date={c.deletedAt}
                    onRestore={effectiveIsAdmin ? () => restore.mutate({ type: "categories", id: c.id }) : undefined}
                    onPurge={effectiveIsAdmin ? () => confirmPurge("categories", c.id, c.title) : undefined}
                    isPending={restore.isPending || purge.isPending}
                  />
                ))}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

function TrashRow({
  name, date, onRestore, onPurge, isPending,
}: { name: string; date: string; onRestore?: () => void; onPurge?: () => void; isPending: boolean }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card hover:bg-muted/10">
      <Trash2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{name}</p>
        <p className="text-xs text-muted-foreground">Xoá ngày {fmtDate(date)}</p>
      </div>
      <div className="flex gap-1.5 flex-shrink-0">
        {onRestore && (
          <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={onRestore} disabled={isPending}>
            <RotateCcw className="w-3.5 h-3.5" /> Khôi phục
          </Button>
        )}
        {onPurge && (
          <Button size="sm" variant="destructive" className="gap-1 text-xs" onClick={onPurge} disabled={isPending}>
            <Flame className="w-3.5 h-3.5" /> Xoá hẳn
          </Button>
        )}
      </div>
    </div>
  );
}

function EmptyTrash() {
  return (
    <div className="text-center py-12 border-2 border-dashed border-border rounded-2xl text-muted-foreground">
      <Trash2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
      <p>Thùng rác trống.</p>
    </div>
  );
}
