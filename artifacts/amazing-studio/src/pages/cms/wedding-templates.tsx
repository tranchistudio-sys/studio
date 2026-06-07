import { useEffect, useState } from "react";
import { Heart, Loader2, Pencil, Plus, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { CmsImageField } from "@/components/cms/CmsImageField";
import { getImageSrc } from "@/lib/imageUtils";
import { weddingTemplatePlaceholder } from "@/lib/cms-placeholders";
import {
  useAdminWeddingTemplates,
  useCreateWeddingTemplate,
  useDeleteWeddingTemplate,
  useRestoreWeddingTemplate,
  useUpdateWeddingTemplate,
  WEDDING_TEMPLATE_CATEGORIES,
  type AdminWeddingTemplate,
  type WeddingTemplateInput,
} from "@/hooks/use-wedding-templates-admin";
import { getPublicPageUrl } from "@/lib/public-site-url";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const inputClass =
  "w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-300";

function slugify(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

const emptyForm: WeddingTemplateInput = {
  name: "",
  slug: "",
  category: "Hàn Quốc",
  description: "",
  thumbnailUrl: null,
  previewImageUrl: null,
  mockupImageUrl: null,
  defaultBackgroundUrl: null,
  themeColor: "#8B2942",
  themeKey: "classic",
  sortOrder: 0,
  isActive: true,
};

export default function CmsWeddingTemplatesPage() {
  const [showTrash, setShowTrash] = useState(false);
  const {
    data: templates = [],
    isLoading,
    isError,
    error,
    refetch,
    isFetched,
  } = useAdminWeddingTemplates(showTrash);
  const create = useCreateWeddingTemplate();
  const update = useUpdateWeddingTemplate();
  const remove = useDeleteWeddingTemplate();
  const restore = useRestoreWeddingTemplate();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AdminWeddingTemplate | null>(null);
  const [form, setForm] = useState<WeddingTemplateInput>(emptyForm);
  const [slugTouched, setSlugTouched] = useState(false);

  const openNew = () => {
    setEditing(null);
    setForm(emptyForm);
    setSlugTouched(false);
    setOpen(true);
  };

  const openEdit = (t: AdminWeddingTemplate) => {
    setEditing(t);
    setForm({
      name: t.name,
      slug: t.slug,
      category: (WEDDING_TEMPLATE_CATEGORIES.includes(t.category as never)
        ? t.category
        : "Hàn Quốc") as WeddingTemplateInput["category"],
      description: t.description,
      thumbnailUrl: t.thumbnailUrl,
      previewImageUrl: t.previewImageUrl,
      mockupImageUrl: t.mockupImageUrl,
      defaultBackgroundUrl: t.defaultBackgroundUrl,
      themeColor: t.themeColor ?? "#8B2942",
      themeKey: t.themeKey,
      sortOrder: t.sortOrder,
      isActive: t.isActive,
    });
    setSlugTouched(true);
    setOpen(true);
  };

  useEffect(() => {
    if (!slugTouched && form.name && !editing) {
      setForm((f) => ({ ...f, slug: slugify(f.name) }));
    }
  }, [form.name, slugTouched, editing]);

  const set = <K extends keyof WeddingTemplateInput>(key: K, value: WeddingTemplateInput[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const onSubmit = async () => {
    const name = form.name.trim();
    let slug = slugify(form.slug || form.name);
    if (!slug) slug = `mau-${Date.now().toString(36)}`;
    if (!name) {
      toast({ title: "Nhập tên mẫu thiệp", variant: "destructive" });
      return;
    }
    const payload: WeddingTemplateInput = {
      ...form,
      name,
      slug,
      themeKey: (form.themeKey?.trim() || slug).slice(0, 64),
    };
    try {
      if (editing) {
        await update.mutateAsync({ id: editing.id, body: payload });
        toast({ title: "Đã cập nhật mẫu thiệp" });
      } else {
        await create.mutateAsync(payload);
        toast({ title: "Đã thêm mẫu thiệp" });
      }
      setOpen(false);
    } catch (e) {
      toast({
        title: "Lỗi",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const previewSrc =
    getImageSrc(form.mockupImageUrl) ??
    getImageSrc(form.previewImageUrl) ??
    getImageSrc(form.thumbnailUrl) ??
    weddingTemplatePlaceholder(form.category);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#faf8f5]">
      <header className="shrink-0 border-b bg-white/90 backdrop-blur px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-rose-900 flex items-center justify-center">
            <Heart className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Cài đặt Thiệp cưới</h1>
            <p className="text-xs text-muted-foreground">Mẫu hiển thị tại /thiep-cuoi-online</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={getPublicPageUrl("/thiep-cuoi-online")}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Xem trang mẫu
          </a>
          <button
            type="button"
            onClick={() => setShowTrash((v) => !v)}
            className="text-xs rounded-lg border px-3 py-2 hover:bg-muted/50"
          >
            {showTrash ? "Danh sách đang dùng" : "Thùng rác"}
          </button>
          {!showTrash && (
            <button
              type="button"
              onClick={openNew}
              className="inline-flex items-center gap-2 rounded-xl bg-neutral-900 text-white px-4 py-2.5 text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              Thêm mẫu
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {!isFetched && isLoading ? (
          <div className="flex justify-center py-20 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : isFetched && isError ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-4">
            <p className="text-sm text-destructive font-medium">Không tải được danh sách mẫu</p>
            <p className="text-xs text-muted-foreground max-w-md">
              {error instanceof Error ? error.message : "Kiểm tra đăng nhập admin và API server."}
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-medium hover:bg-muted/60"
            >
              <RefreshCw className="w-4 h-4" />
              Tải lại
            </button>
          </div>
        ) : templates.length === 0 ? (
          <p className="text-center text-muted-foreground py-16">
            {showTrash ? "Thùng rác trống" : "Chưa có mẫu — bấm Thêm mẫu"}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 max-w-6xl mx-auto">
            {templates.map((t) => {
              const img =
                getImageSrc(t.mockupImageUrl) ??
                getImageSrc(t.previewImageUrl) ??
                getImageSrc(t.thumbnailUrl) ??
                weddingTemplatePlaceholder(t.category);
              return (
                <article
                  key={t.id}
                  className="rounded-2xl border border-border/80 bg-white overflow-hidden shadow-sm"
                >
                  <div className="aspect-[9/16] max-h-64 relative bg-neutral-100">
                    <img src={img} alt="" className="w-full h-full object-cover" />
                    {!t.isActive && (
                      <span className="absolute top-2 right-2 text-[10px] bg-neutral-800/80 text-white px-2 py-0.5 rounded-full">
                        Tắt
                      </span>
                    )}
                  </div>
                  <div className="p-4 space-y-1">
                    <p className="font-medium text-sm">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.category} · /{t.slug}
                    </p>
                    <div className="flex gap-2 pt-2">
                      {showTrash ? (
                        <button
                          type="button"
                          onClick={() =>
                            restore.mutate(t.id, {
                              onSuccess: () => toast({ title: "Đã khôi phục" }),
                            })
                          }
                          className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border py-2 text-xs"
                        >
                          <Undo2 className="w-3.5 h-3.5" />
                          Khôi phục
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => openEdit(t)}
                            className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg border py-2 text-xs hover:bg-muted/40"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            Sửa
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!confirm(`Xoá mềm mẫu "${t.name}"?`)) return;
                              remove.mutate(t.id, {
                                onSuccess: () => toast({ title: "Đã chuyển vào thùng rác" }),
                              });
                            }}
                            className="inline-flex items-center justify-center rounded-lg border border-destructive/30 text-destructive px-3 py-2 text-xs"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4">
          <div className="bg-[#faf8f5] w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border shadow-xl">
            <div className="sticky top-0 bg-white/95 border-b px-5 py-4 flex justify-between items-center z-10">
              <h2 className="font-semibold">{editing ? "Sửa mẫu thiệp" : "Thêm mẫu thiệp"}</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-sm text-muted-foreground">
                Đóng
              </button>
            </div>
            <div className="p-5 space-y-5">
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-muted-foreground">Tên mẫu *</label>
                  <input
                    className={inputClass + " mt-1"}
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Slug *</label>
                  <input
                    className={inputClass + " mt-1 font-mono text-xs"}
                    value={form.slug}
                    onChange={(e) => {
                      setSlugTouched(true);
                      set("slug", e.target.value);
                    }}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Danh mục</label>
                  <select
                    className={inputClass + " mt-1"}
                    value={form.category}
                    onChange={(e) =>
                      set("category", e.target.value as WeddingTemplateInput["category"])
                    }
                  >
                    {WEDDING_TEMPLATE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Màu chủ đạo</label>
                  <input
                    type="color"
                    className="mt-1 h-10 w-full rounded-xl border cursor-pointer"
                    value={form.themeColor ?? "#8B2942"}
                    onChange={(e) => set("themeColor", e.target.value)}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs text-muted-foreground">Mô tả ngắn</label>
                  <textarea
                    className={inputClass + " mt-1 resize-none min-h-[72px]"}
                    value={form.description ?? ""}
                    onChange={(e) => set("description", e.target.value || null)}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Theme key (layout)</label>
                  <input
                    className={inputClass + " mt-1 font-mono text-xs"}
                    value={form.themeKey ?? form.slug}
                    onChange={(e) => set("themeKey", e.target.value)}
                    placeholder="classic / modern / romantic"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Thứ tự</label>
                  <input
                    type="number"
                    className={inputClass + " mt-1"}
                    value={form.sortOrder ?? 0}
                    onChange={(e) => set("sortOrder", Number(e.target.value) || 0)}
                  />
                </div>
                <label className="sm:col-span-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.isActive !== false}
                    onChange={(e) => set("isActive", e.target.checked)}
                  />
                  Hiển thị trên trang public (bật)
                </label>
              </div>

              <div className="rounded-2xl border bg-white p-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Preview trong admin
                </p>
                <div
                  className="mx-auto max-w-[200px] aspect-[9/16] rounded-xl overflow-hidden border shadow-inner"
                  style={{ boxShadow: `0 0 0 3px ${form.themeColor ?? "#8B2942"}22` }}
                >
                  <img src={previewSrc} alt="" className="w-full h-full object-cover" />
                </div>
              </div>

              <CmsImageField
                label="Thumbnail mẫu"
                value={form.thumbnailUrl ?? null}
                onChange={(v) => set("thumbnailUrl", v)}
                aspect="portrait"
                placeholderSrc={weddingTemplatePlaceholder(form.category)}
              />
              <CmsImageField
                label="Ảnh preview mockup"
                value={form.mockupImageUrl ?? null}
                onChange={(v) => set("mockupImageUrl", v)}
                aspect="portrait"
                placeholderSrc={weddingTemplatePlaceholder(form.category)}
              />
              <CmsImageField
                label="Ảnh nền mặc định (editor)"
                hint="Dùng khi khách chưa upload ảnh bìa"
                value={form.defaultBackgroundUrl ?? null}
                onChange={(v) => set("defaultBackgroundUrl", v)}
                aspect="portrait"
                placeholderSrc={weddingTemplatePlaceholder(form.category)}
              />
              <CmsImageField
                label="Ảnh preview (legacy)"
                value={form.previewImageUrl ?? null}
                onChange={(v) => set("previewImageUrl", v)}
                aspect="portrait"
              />

              <button
                type="button"
                onClick={() => void onSubmit()}
                disabled={create.isPending || update.isPending}
                className={cn(
                  "w-full py-3.5 rounded-xl bg-neutral-900 text-white font-medium text-sm",
                  "hover:bg-neutral-800 disabled:opacity-60",
                )}
              >
                {(create.isPending || update.isPending) && (
                  <Loader2 className="inline w-4 h-4 animate-spin mr-2" />
                )}
                {editing ? "Lưu thay đổi" : "Tạo mẫu"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
