import { useEffect, useMemo, useRef, useState } from "react";
import {
  Share2, RefreshCw, Plus, Trash2, CheckCircle2, AlertTriangle, ExternalLink,
  Sparkles, Clock, History, Settings as SettingsIcon, Facebook, Loader2, X, Image as ImageIcon, Eye, EyeOff, Folder,
  BookOpen, Wand2, Pencil, ArrowUp, ArrowDown, GripVertical, Scissors, Search, ListTree,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  usePool, useSchedules, usePosts, useSettings,
  useSyncPool, useUploadPoolItem, useUpdatePoolItem, useDeletePoolItem,
  useGenerate, useApprove, useSkipPost, useRetryPost, usePublishNow,
  useSaveSchedule, useToggleSchedule, useDeleteSchedule, useSaveSettings, useTestFacebook,
  useSyncDrive, useTestDrive, useDriveStatus,
  useStyleSamples, useSaveStyleSample, useDeleteStyleSample, useRegeneratePost, useOcrStyleImage,
  useSignatures, useSaveSignature, useDeleteSignature, useDefaultSignature,
  type PoolItem, type Post, type Schedule, type Slot, type FbTestResult, type AutoPostSettings, type DriveTestResult,
  type StyleSample, type Signature,
} from "@/lib/autopost-api";
import { getImageSrc } from "@/lib/imageUtils";
import { apiUrl } from "@/lib/api-base";
import {
  ContentTree, useContentTree, filterPoolBySelection, buildBreadcrumb, SOURCES,
  type TreeSelection,
} from "./autopost-content-tree";

/**
 * AutoPost Facebook — trang quản trị 7 tab (Task 8). Chỉ admin (AdminRoute).
 * Mọi bài đăng đều đi qua DRY_RUN ở backend (mặc định BẬT) cho tới khi tắt env.
 */

// ─────────────────────────────── Helpers ─────────────────────────────────────

const CONTENT_TYPES: { value: string; label: string }[] = [
  { value: "vay_cuoi", label: "Váy cưới" },
  { value: "ao_dai_cuoi", label: "Áo dài cưới" },
  { value: "viet_phuc", label: "Việt phục" },
  { value: "beauty", label: "Beauty" },
  { value: "album_cuoi", label: "Album cưới" },
  { value: "photo_idea", label: "Ý tưởng chụp" },
  { value: "makeup", label: "Makeup" },
  { value: "hau_truong", label: "Hậu trường" },
  { value: "product_real", label: "Chụp SP thật" },
  { value: "new_arrival", label: "Váy mới về" },
  { value: "reels", label: "Video Reel" },
  { value: "feedback", label: "Feedback" },
  { value: "bill", label: "Bill chốt đơn" },
  { value: "service", label: "Dịch vụ" },
  { value: "other", label: "Khác" },
];
// Phong cách viết caption (khớp preset backend: natural|emotional|elegant|fun|short).
const STYLE_PRESETS: { value: string; label: string }[] = [
  { value: "natural", label: "Tự nhiên" },
  { value: "emotional", label: "Tình cảm" },
  { value: "elegant", label: "Sang nhẹ" },
  { value: "fun", label: "Vui" },
  { value: "short", label: "Ngắn gọn" },
];

function ctLabel(v: string | null): string {
  return CONTENT_TYPES.find((c) => c.value === v)?.label ?? v ?? "—";
}

// CHỦ ĐỀ VĂN PHONG (14) — dùng cho Văn phong mẫu. Quyết định AI lấy mẫu cho loại bài nào.
const STYLE_TOPICS: { value: string; label: string }[] = [
  { value: "all", label: "Tất cả / Dùng chung" },
  { value: "beauty", label: "Chụp Beauty" },
  { value: "album_cuoi", label: "Chụp Album cưới / Prewedding / Cổng cưới / Cưới studio" },
  { value: "cuoi_ngoai_canh", label: "Chụp cưới ngoại cảnh" },
  { value: "tiec_cuoi", label: "Tiệc cưới / Phóng sự cưới" },
  { value: "ao_dai_co_trang", label: "Áo dài / Việt phục / Yếm / Sườn xám / Cổ trang" },
  { value: "gia_dinh", label: "Chụp Gia đình" },
  { value: "bau", label: "Chụp Bầu / Mẹ bầu" },
  { value: "vay_cuoi", label: "Váy cưới / Váy mới" },
  { value: "trang_phuc_beauty_moi", label: "Trang phục beauty mới" },
  { value: "makeup", label: "Makeup / Khoe makeup / Layout makeup" },
  { value: "hau_truong", label: "Hậu trường" },
  { value: "feedback", label: "Feedback khách hàng" },
  { value: "bill", label: "Bill chốt đơn" },
];
function topicLabel(v?: string | null): string {
  return STYLE_TOPICS.find((t) => t.value === v)?.label ?? "Tất cả / Dùng chung";
}

function fmtVnd(v: string | number | null): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toLocaleString("vi-VN") + "₫";
}

function pad(x: number): string {
  return String(x).padStart(2, "0");
}
/** Date → "YYYY-MM-DDTHH:MM" (giờ local, cho input datetime-local). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function defaultScheduleValue(): string {
  return toLocalInput(new Date(Date.now() + 15 * 60 * 1000));
}
function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}
function hasPriceWarning(text: string, flags?: { suspiciousPrice?: boolean }): boolean {
  return !!flags?.suspiciousPrice || text.includes("⚠️") || text.includes("KIỂM TRA GIÁ");
}

type Notify = (ok: boolean, msg: string) => void;

// ─────────────────────────────── Page ────────────────────────────────────────

export default function AutoPostFacebookPage() {
  const [tab, setTab] = useState("pending");
  const [flash, setFlash] = useState<{ ok: boolean; msg: string } | null>(null);
  const notify: Notify = (ok, msg) => setFlash({ ok, msg });
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center text-blue-600">
          <Share2 className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-xl font-bold">AutoPost Facebook</h1>
          <p className="text-sm text-muted-foreground">
            Lulu viết caption · admin duyệt · scheduler tự đăng theo giờ.{" "}
            <span className="font-medium text-amber-600">Chế độ an toàn (DRY_RUN) bật mặc định.</span>
          </p>
        </div>
      </div>

      {flash && (
        <div
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm border ${
            flash.ok
              ? "bg-emerald-50 border-emerald-200 text-emerald-700"
              : "bg-red-50 border-red-200 text-red-700"
          }`}
        >
          {flash.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          <span className="flex-1">{flash.msg}</span>
          <button onClick={() => setFlash(null)}><X className="w-4 h-4 opacity-60" /></button>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="pending"><Sparkles className="w-4 h-4 mr-1" /> Bài chờ duyệt</TabsTrigger>
          <TabsTrigger value="pool"><ImageIcon className="w-4 h-4 mr-1" /> Kho nội dung</TabsTrigger>
          <TabsTrigger value="schedules"><Clock className="w-4 h-4 mr-1" /> Lịch đăng bài</TabsTrigger>
          <TabsTrigger value="scheduled"><CheckCircle2 className="w-4 h-4 mr-1" /> Đã lên lịch</TabsTrigger>
          <TabsTrigger value="history"><History className="w-4 h-4 mr-1" /> Lịch sử đăng</TabsTrigger>
          <TabsTrigger value="facebook"><Facebook className="w-4 h-4 mr-1" /> Facebook Page</TabsTrigger>
          <TabsTrigger value="style"><BookOpen className="w-4 h-4 mr-1" /> Văn phong mẫu</TabsTrigger>
          <TabsTrigger value="signature"><Pencil className="w-4 h-4 mr-1" /> Chữ ký tiệm</TabsTrigger>
          <TabsTrigger value="config"><SettingsIcon className="w-4 h-4 mr-1" /> Cấu hình Lulu</TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-4"><PendingTab notify={notify} /></TabsContent>
        <TabsContent value="pool" className="mt-4"><PoolTab notify={notify} goPending={() => setTab("pending")} /></TabsContent>
        <TabsContent value="schedules" className="mt-4"><SchedulesTab notify={notify} /></TabsContent>
        <TabsContent value="scheduled" className="mt-4"><ScheduledTab notify={notify} /></TabsContent>
        <TabsContent value="history" className="mt-4"><HistoryTab notify={notify} /></TabsContent>
        <TabsContent value="facebook" className="mt-4"><FacebookTab notify={notify} /></TabsContent>
        <TabsContent value="style" className="mt-4"><StyleTab notify={notify} /></TabsContent>
        <TabsContent value="signature" className="mt-4"><SignatureTab notify={notify} /></TabsContent>
        <TabsContent value="config" className="mt-4"><ConfigTab notify={notify} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────────────────── Common bits ─────────────────────────────────

function Thumb({ url, className }: { url?: string; className?: string }) {
  const [err, setErr] = useState(false);
  // Dùng helper chuẩn của app: /objects/... → /api/storage/objects/... (Vite proxy /api).
  const src = getImageSrc(url);
  // Reset trạng thái lỗi khi đổi ảnh (Thumb có thể bị tái dùng cho item khác sau refetch).
  useEffect(() => { setErr(false); }, [src]);
  if (!src || err) {
    return (
      <div className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? ""}`}>
        <ImageIcon className="w-6 h-6 opacity-40" />
      </div>
    );
  }
  return <img src={src} alt="" onError={() => setErr(true)} className={`object-cover ${className ?? ""}`} />;
}

function Empty({ text }: { text: string }) {
  return <div className="py-12 text-center text-sm text-muted-foreground">{text}</div>;
}

function Spin() {
  return <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
}

// ─────────────────────────────── Tab: Bài chờ duyệt ──────────────────────────

function PendingTab({ notify }: { notify: Notify }) {
  const { data: posts, isLoading } = usePosts("pending_review");
  if (isLoading) return <Spin />;
  // Chỉ hiện bài có caption hợp lệ (phòng dữ liệu hỏng/sửa tay DB).
  const valid = (posts ?? []).filter((p) => Array.isArray(p.captionOptions) && p.captionOptions.length > 0);
  if (!valid.length) return <Empty text="Chưa có bài nào chờ duyệt. Vào 'Kho nội dung' → 'Tạo bài' để Lulu viết caption." />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {valid.map((p) => <PendingCard key={p.id} post={p} notify={notify} />)}
    </div>
  );
}

function PendingCard({ post, notify }: { post: Post; notify: Notify }) {
  const options = post.captionOptions ?? [];
  const initIdx = post.captionRecommendedIndex != null && options[post.captionRecommendedIndex] ? post.captionRecommendedIndex : 0;
  const [idx, setIdx] = useState(initIdx);
  const [text, setText] = useState(options[initIdx]?.text ?? post.captionFinal ?? "");
  const [when, setWhen] = useState(defaultScheduleValue());
  const [style, setStyle] = useState("natural");
  const { data: sigDefault } = useDefaultSignature();
  const [footerOn, setFooterOn] = useState(post.footerEnabled ?? true);
  const approve = useApprove();
  const skip = useSkipPost();
  const regen = useRegeneratePost();

  const pickOption = (i: number) => {
    setIdx(i);
    if (options[i]) setText(options[i].text);
  };

  // Viết lại caption theo phong cách/mood; cập nhật ngay ô caption từ kết quả trả về.
  const onRegenerate = async (s: string) => {
    setStyle(s);
    try {
      const updated = await regen.mutateAsync({ id: post.id, style: s });
      const opts = updated.captionOptions ?? [];
      const ri = updated.captionRecommendedIndex != null && opts[updated.captionRecommendedIndex] ? updated.captionRecommendedIndex : 0;
      setIdx(ri);
      setText(opts[ri]?.text ?? "");
      notify(true, "Đã viết lại caption ✨");
    } catch (e) { notify(false, `Viết lại lỗi: ${String((e as Error).message)}`); }
  };

  const onApprove = async () => {
    if (!text.trim()) { notify(false, "Caption không được rỗng"); return; }
    try {
      await approve.mutateAsync({ id: post.id, captionFinal: text, scheduledAt: new Date(when).toISOString(), footerEnabled: footerOn });
      notify(true, `Đã duyệt bài #${post.id} — sẽ đăng lúc ${fmtDateTime(new Date(when).toISOString())}`);
    } catch (e) { notify(false, `Duyệt lỗi: ${String((e as Error).message)}`); }
  };
  const onSkip = async () => {
    try { await skip.mutateAsync(post.id); notify(true, `Đã bỏ qua bài #${post.id}`); }
    catch (e) { notify(false, String((e as Error).message)); }
  };

  const warn = hasPriceWarning(text, options[idx]?.flags);

  return (
    <div className="rounded-2xl border bg-card p-4 space-y-3">
      <div className="flex gap-3">
        <Thumb url={post.images?.[0]} className="w-24 h-24 rounded-xl flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate">{post.poolTitle ?? `Bài #${post.id}`}</span>
            <Badge variant="secondary">{ctLabel(post.contentType)}</Badge>
            {(post.images?.length ?? 0) >= 1 && <Badge variant="outline">{post.images!.length} ảnh</Badge>}
          </div>
          <p className="text-xs text-muted-foreground mt-1">Chọn 1 trong {options.length} caption, sửa nếu cần rồi đặt giờ đăng.</p>
          {warn && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600 bg-red-50 px-2 py-1 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5" /> Caption có cảnh báo giá — kiểm tra số tiền trước khi duyệt.
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground mr-0.5 inline-flex items-center gap-1"><Wand2 className="w-3.5 h-3.5" /> Phong cách</span>
        <Select value={style} onValueChange={setStyle}>
          <SelectTrigger className="h-8 w-[116px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{STYLE_PRESETS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={regen.isPending} onClick={() => onRegenerate(style)}>
          {regen.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />} Tạo lại
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={regen.isPending} onClick={() => onRegenerate("short")}>Ngắn hơn</Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={regen.isPending} onClick={() => onRegenerate("emotional")}>Tình hơn</Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={regen.isPending} onClick={() => onRegenerate("fun")}>Vui hơn</Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={regen.isPending} onClick={() => onRegenerate("elegant")}>Sang hơn</Button>
      </div>

      {(post.visionImageCount != null || post.aiModel || (post.usedSampleIds?.length ?? 0) > 0) && (
        <p className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
          {post.visionImageCount != null && <span>AI đọc {post.visionImageCount} ảnh</span>}
          {(post.usedSampleIds?.length ?? 0) > 0 && <span>· học {post.usedSampleIds!.length} bài mẫu</span>}
          {post.aiModel && <span>· model {post.aiModel}</span>}
        </p>
      )}

      <RadioGroup value={String(idx)} onValueChange={(v) => pickOption(Number(v))} className="space-y-1.5">
        {options.map((o, i) => (
          <label key={i} className={`flex gap-2 items-start text-sm rounded-lg border p-2 cursor-pointer ${idx === i ? "border-primary bg-primary/5" : "border-border"}`}>
            <RadioGroupItem value={String(i)} className="mt-0.5" />
            <span className="flex-1 whitespace-pre-wrap">
              {hasPriceWarning(o.text, o.flags) && <AlertTriangle className="inline w-3.5 h-3.5 text-red-500 mr-1" />}
              {o.text}
            </span>
          </label>
        ))}
      </RadioGroup>

      <div>
        <Label className="text-xs">Nội dung AI viết (sửa tay được — chữ ký gắn tự động)</Label>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className="mt-1" />
      </div>

      {sigDefault?.content && (
        <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1.5">
          <label className="flex items-center gap-2 cursor-pointer">
            <Switch checked={footerOn} onCheckedChange={setFooterOn} />
            <span className="text-xs font-medium">Gắn chữ ký cuối bài (Amazing Studio)</span>
          </label>
          {footerOn && <p className="text-[11px] text-muted-foreground whitespace-pre-wrap border-t pt-1.5">{sigDefault.content}</p>}
        </div>
      )}

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[180px]">
          <Label className="text-xs">Giờ đăng (giờ VN)</Label>
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="mt-1" />
        </div>
        <Button onClick={onApprove} disabled={approve.isPending}>
          {approve.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-1" />}
          Duyệt đăng
        </Button>
        <Button variant="outline" onClick={onSkip} disabled={skip.isPending}>Bỏ qua</Button>
      </div>
    </div>
  );
}

// ─────────────────────────────── Tab: Kho nội dung ───────────────────────────

function PoolTab({ notify, goPending }: { notify: Notify; goPending: () => void }) {
  // Nạp TOÀN BỘ item kho (gồm cả item đang ẩn) để cây danh mục đếm đúng + cho ẩn/hiện.
  const { data: items, isLoading } = usePool({ eligible: "all" });
  const { cats, maps, isLoading: treeLoading } = useContentTree();
  const sync = useSyncPool();
  const syncDrive = useSyncDrive();
  const generate = useGenerate();
  const del = useDeletePoolItem();
  const update = useUpdatePoolItem();
  const [showUpload, setShowUpload] = useState(false);
  const [selection, setSelection] = useState<TreeSelection>({ sourceKey: "gallery", categoryId: null });
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);

  const allItems = items ?? [];
  // Bên phải chỉ hiện item thuộc danh mục đang chọn; search lọc TRONG danh mục đó.
  const inCategory = useMemo(() => filterPoolBySelection(allItems, selection, maps, cats), [allItems, selection, maps, cats]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? inCategory.filter((it) => (it.title ?? "").toLowerCase().includes(q)) : inCategory;
  }, [inCategory, search]);

  const srcLabel = selection.sourceKey === "other" ? "Tải lên / Google Drive" : (SOURCES.find((s) => s.key === selection.sourceKey)?.label ?? "");
  const srcCats = selection.sourceKey === "other" ? [] : cats[selection.sourceKey];
  const catLabel = selection.sourceKey === "other" ? "" : selection.uncategorized ? "Chưa phân loại" : selection.categoryId != null ? buildBreadcrumb(srcCats, selection.categoryId) : "Tất cả";

  const onSync = async () => {
    try {
      const r = await sync.mutateAsync();
      notify(true, `Đồng bộ xong: ${r.dresses} váy/đồ · ${r.albums} album · ${r.ideas} ý tưởng.`);
    } catch (e) { notify(false, `Sync lỗi: ${String((e as Error).message)}`); }
  };
  const onSyncDrive = async () => {
    try {
      const r = await syncDrive.mutateAsync();
      if (!r.ok) { notify(false, `Google Drive: ${r.error ?? "lỗi"}`); return; }
      const types = Object.entries(r.byType).map(([k, v]) => `${k}:${v}`).join(" · ");
      notify(true, `Drive: nhập ${r.imported} · bỏ qua ${r.skipped}${r.capped ? " (đạt trần, chạy lại để lấy tiếp)" : ""}${types ? " — " + types : ""}`);
    } catch (e) { notify(false, `Drive sync lỗi: ${String((e as Error).message)}`); }
  };
  const onGenerate = async (it: PoolItem) => {
    try {
      await generate.mutateAsync({ poolId: it.id });
      notify(true, `Đã tạo bài chờ duyệt từ "${it.title}". Mở tab 'Bài chờ duyệt' để xem.`);
      goPending();
    } catch (e) { notify(false, `Tạo bài lỗi: ${String((e as Error).message)}`); }
  };
  const pick = (s: TreeSelection) => { setSelection(s); setDrawerOpen(false); };

  const tree = <ContentTree items={allItems} cats={cats} maps={maps} selection={selection} onSelect={pick} />;

  return (
    <div className="space-y-3">
      {/* Thanh công cụ: nút mở cây (mobile) + tìm kiếm + đồng bộ + thêm thủ công */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" className="md:hidden h-9" onClick={() => setDrawerOpen(true)}>
          <ListTree className="w-4 h-4 mr-1" /> Danh mục
        </Button>
        <div className="relative flex-1 min-w-[150px]">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tìm trong danh mục đang chọn..." className="h-9 pl-8" />
        </div>
        <Button variant="outline" className="h-9" onClick={onSync} disabled={sync.isPending} title="Đồng bộ app/web">
          {sync.isPending ? <Loader2 className="w-4 h-4 sm:mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 sm:mr-1" />}
          <span className="hidden sm:inline">Đồng bộ app/web</span>
        </Button>
        <Button variant="outline" className="h-9" onClick={onSyncDrive} disabled={syncDrive.isPending} title="Đồng bộ Google Drive">
          {syncDrive.isPending ? <Loader2 className="w-4 h-4 sm:mr-1 animate-spin" /> : <Folder className="w-4 h-4 sm:mr-1" />}
          <span className="hidden sm:inline">Google Drive</span>
        </Button>
        <Button className="h-9" onClick={() => setShowUpload(true)}>
          <Plus className="w-4 h-4 sm:mr-1" /><span className="hidden sm:inline">Thêm thủ công</span>
        </Button>
      </div>

      <div className="flex gap-3 items-start">
        {/* Cây nguồn + danh mục (desktop) */}
        <aside className="hidden md:block w-64 shrink-0 border rounded-xl p-2 self-start sticky top-2 max-h-[calc(100vh-170px)] overflow-auto">
          <p className="px-2 py-1 text-[11px] font-semibold text-neutral-500 uppercase tracking-wide">Nguồn nội dung</p>
          {treeLoading ? <Spin /> : tree}
        </aside>

        {/* Nội dung của danh mục đang chọn */}
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center gap-1.5 text-sm flex-wrap">
            <span className="font-semibold text-neutral-800">{srcLabel || "—"}</span>
            {catLabel && <><span className="text-neutral-400">›</span><span className="text-neutral-700">{catLabel}</span></>}
            <span className="ml-1 text-xs text-neutral-400">({visible.length})</span>
          </div>

          {(isLoading || treeLoading) ? <Spin /> : !visible.length ? (
            <Empty text={search ? "Không có nội dung khớp tìm kiếm trong danh mục này." : "Danh mục này chưa có nội dung. Bấm 'Đồng bộ app/web' để lấy về."} />
          ) : (
            <div className="rental-product-grid grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5 gap-2 sm:gap-3">
              {visible.map((it) => {
                const price = fmtVnd(it.salePrice) || fmtVnd(it.price);
                return (
                  <div key={it.id} className="gallery-card rental-dress-card concept-card group flex flex-col">
                    <div className="relative aspect-[3/4] bg-neutral-100 overflow-hidden">
                      <Thumb url={it.images?.[0]} className="concept-card-image absolute inset-0 w-full h-full" />
                      <span className="absolute top-1.5 left-1.5 z-10 text-[9px] sm:text-[10px] bg-white/85 text-neutral-700 px-1.5 py-0.5 rounded-full backdrop-blur-sm">
                        {ctLabel(it.contentType)}
                      </span>
                      {it.images?.length > 0 && (
                        <span className="absolute top-1.5 right-1.5 z-10 text-[9px] sm:text-[10px] bg-black/55 text-white px-1.5 py-0.5 rounded-full backdrop-blur-sm">
                          {it.images.length} ảnh
                        </span>
                      )}
                      {!it.isEligible && (
                        <span className="absolute bottom-1.5 left-1.5 z-10 text-[10px] bg-black/60 text-white px-2 py-0.5 rounded-full backdrop-blur-sm">
                          Đang ẩn
                        </span>
                      )}
                    </div>
                    <div className="px-2 py-2 flex flex-col gap-1 flex-1 border-t border-neutral-100/80 bg-white">
                      <p className="font-medium text-xs sm:text-sm leading-snug line-clamp-2" title={it.title}>{it.title}</p>
                      {price ? <p className="text-[11px] sm:text-xs font-semibold text-rose-600 leading-tight">{price}</p> : null}
                      <div className="flex-1" />
                      <div className="flex items-center gap-1">
                        <Button size="sm" className="flex-1 h-9 px-2 text-xs" onClick={() => onGenerate(it)} disabled={!it.isEligible || generate.isPending}>
                          <Sparkles className="w-3.5 h-3.5 mr-1" /> Tạo bài
                        </Button>
                        <Button
                          size="icon" variant="outline" className="h-9 w-9 shrink-0"
                          title={it.isEligible ? "Ẩn khỏi chọn đăng" : "Cho phép đăng"}
                          onClick={() => update.mutate({ id: it.id, patch: { isEligible: !it.isEligible } })}
                        >
                          {it.isEligible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </Button>
                        <Button
                          size="icon" variant="ghost" className="h-9 w-9 shrink-0 text-destructive"
                          title="Xoá khỏi kho"
                          onClick={() => { if (confirm("Xoá item khỏi kho?")) del.mutate(it.id); }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Drawer cây danh mục (mobile) */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-label="Cây danh mục">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-[82%] max-w-[320px] bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-3 py-2.5 border-b">
              <p className="text-sm font-semibold">Nguồn nội dung</p>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setDrawerOpen(false)}><X className="w-4 h-4" /></Button>
            </div>
            <div className="flex-1 overflow-auto p-2">{treeLoading ? <Spin /> : tree}</div>
          </div>
        </div>
      )}

      <UploadDialog open={showUpload} onClose={() => setShowUpload(false)} notify={notify} />
    </div>
  );
}

function UploadDialog({ open, onClose, notify }: { open: boolean; onClose: () => void; notify: Notify }) {
  const upload = useUploadPoolItem();
  const [title, setTitle] = useState("");
  const [contentType, setContentType] = useState("vay_cuoi");
  const [imagesText, setImagesText] = useState("");
  const [price, setPrice] = useState("");
  const [badge, setBadge] = useState("");
  const [publicLink, setPublicLink] = useState("");

  const reset = () => { setTitle(""); setImagesText(""); setPrice(""); setBadge(""); setPublicLink(""); };

  const onSubmit = async () => {
    const images = imagesText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!title.trim()) { notify(false, "Cần nhập tiêu đề"); return; }
    if (!images.length) { notify(false, "Cần ít nhất 1 URL ảnh"); return; }
    try {
      await upload.mutateAsync({
        title, contentType, images,
        price: price ? Number(price) : null,
        badge: badge || null,
        publicLink: publicLink || null,
      });
      notify(true, "Đã thêm vào kho nội dung");
      reset(); onClose();
    } catch (e) { notify(false, `Thêm lỗi: ${String((e as Error).message)}`); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Thêm nội dung thủ công</DialogTitle>
          <DialogDescription>Dán URL ảnh (mỗi dòng / cách nhau dấu phẩy). Ảnh phải truy cập công khai được khi đăng thật.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div><Label>Tiêu đề</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" /></div>
          <div>
            <Label>Loại nội dung</Label>
            <Select value={contentType} onValueChange={setContentType}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>{CONTENT_TYPES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>URL ảnh</Label><Textarea value={imagesText} onChange={(e) => setImagesText(e.target.value)} rows={3} className="mt-1" placeholder="https://...jpg" /></div>
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Giá (tuỳ chọn)</Label><Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" className="mt-1" /></div>
            <div><Label>Nhãn (tuỳ chọn)</Label><Input value={badge} onChange={(e) => setBadge(e.target.value)} className="mt-1" /></div>
          </div>
          <div><Label>Link công khai (tuỳ chọn)</Label><Input value={publicLink} onChange={(e) => setPublicLink(e.target.value)} className="mt-1" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Huỷ</Button>
          <Button onClick={onSubmit} disabled={upload.isPending}>
            {upload.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Thêm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────── Tab: Lịch đăng bài ──────────────────────────

const PRESET_7 = ["08:00", "10:30", "12:00", "15:00", "18:00", "20:00", "21:30"];
const PRESET_10 = ["07:30", "09:00", "10:30", "12:00", "14:00", "16:00", "18:00", "20:00", "21:00", "22:00"];
const ROTATION = ["vay_cuoi", "ao_dai_cuoi", "album_cuoi", "beauty", "photo_idea", "viet_phuc"];

function makeSlots(times: string[]): Slot[] {
  return times.map((t, i) => ({
    postTime: t,
    contentType: ROTATION[i % ROTATION.length],
    imageCount: 10, // giữ nhiều ảnh/bài (2–10); trước đây = 1 nên bài rớt còn ảnh bìa
    sourcePriority: "app_web",
    enabled: true,
    sortOrder: i,
  }));
}

function SchedulesTab({ notify }: { notify: Notify }) {
  const { data: schedules, isLoading } = useSchedules();
  const toggle = useToggleSchedule();
  const del = useDeleteSchedule();
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <p className="text-sm text-muted-foreground flex-1">Mỗi lịch gồm nhiều khung giờ (slot). Scheduler tự sinh bài chờ duyệt cho slot sắp tới (24h).</p>
        <Button onClick={() => setCreating(true)}><Plus className="w-4 h-4 mr-1" /> Tạo lịch</Button>
      </div>

      {isLoading ? <Spin /> : !schedules?.length ? (
        <Empty text="Chưa có lịch nào. Bấm 'Tạo lịch' và chọn preset 7 hoặc 10 bài/ngày." />
      ) : (
        <div className="space-y-3">
          {schedules.map((s) => (
            <div key={s.id} className="rounded-2xl border bg-card p-4">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{s.name}</span>
                <Badge variant={s.enabled ? "default" : "secondary"}>{s.enabled ? "Đang bật" : "Tắt"}</Badge>
                <span className="text-xs text-muted-foreground">{s.slots.length} khung giờ · {s.timezone}</span>
                <div className="flex-1" />
                <Switch checked={s.enabled} onCheckedChange={() => toggle.mutate(s.id)} />
                <Button size="sm" variant="outline" onClick={() => setEditing(s)}>Sửa</Button>
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("Xoá lịch này?")) del.mutate(s.id); }}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.slots.map((sl, i) => (
                  <span key={i} className={`text-xs px-2 py-0.5 rounded-full border ${sl.enabled ? "bg-muted" : "opacity-50 line-through"}`}>
                    {sl.postTime} · {ctLabel(sl.contentType)}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <ScheduleDialog
          schedule={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          notify={notify}
        />
      )}
    </div>
  );
}

function ScheduleDialog({ schedule, onClose, notify }: { schedule: Schedule | null; onClose: () => void; notify: Notify }) {
  const save = useSaveSchedule();
  const [name, setName] = useState(schedule?.name ?? "Lịch đăng hàng ngày");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [pageId, setPageId] = useState(schedule?.pageId ?? "");
  const [slots, setSlots] = useState<Slot[]>(schedule?.slots ?? makeSlots(PRESET_7));

  const updateSlot = (i: number, patch: Partial<Slot>) =>
    setSlots((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const removeSlot = (i: number) => setSlots((arr) => arr.filter((_, idx) => idx !== i));
  const addSlot = () => setSlots((arr) => [...arr, { postTime: "12:00", contentType: "vay_cuoi", imageCount: 10, sourcePriority: "app_web", enabled: true, sortOrder: arr.length }]);

  const onSave = async () => {
    try {
      await save.mutateAsync({
        id: schedule?.id,
        body: { name, enabled, pageId: pageId || null, timezone: "Asia/Ho_Chi_Minh", slots },
      });
      notify(true, schedule ? "Đã cập nhật lịch" : "Đã tạo lịch");
      onClose();
    } catch (e) { notify(false, `Lưu lỗi: ${String((e as Error).message)}`); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{schedule ? "Sửa lịch" : "Tạo lịch đăng"}</DialogTitle>
          <DialogDescription>Giờ theo Asia/Ho_Chi_Minh. Bật lịch để scheduler tự sinh bài chờ duyệt.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div><Label>Tên lịch</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" /></div>
            <div><Label>Page ID (tuỳ chọn)</Label><Input value={pageId} onChange={(e) => setPageId(e.target.value)} className="mt-1" placeholder="mặc định theo cấu hình" /></div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} /> <span className="text-sm">Bật lịch này</span>
            <div className="flex-1" />
            <Button size="sm" variant="outline" onClick={() => setSlots(makeSlots(PRESET_7))}>Preset 7 bài/ngày</Button>
            <Button size="sm" variant="outline" onClick={() => setSlots(makeSlots(PRESET_10))}>Preset 10 bài/ngày</Button>
          </div>

          <div className="space-y-1.5">
            <Label>Khung giờ ({slots.length})</Label>
            {slots.map((s, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input type="time" value={s.postTime} onChange={(e) => updateSlot(i, { postTime: e.target.value })} className="w-[110px]" />
                <Select value={s.contentType} onValueChange={(v) => updateSlot(i, { contentType: v })}>
                  <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                  <SelectContent>{CONTENT_TYPES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
                <Input type="number" min={2} max={10} value={s.imageCount} onChange={(e) => updateSlot(i, { imageCount: Number(e.target.value) || 10 })} className="w-[64px]" title="Số ảnh mỗi bài (2–10)" />
                <Switch checked={s.enabled} onCheckedChange={(v) => updateSlot(i, { enabled: v })} />
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => removeSlot(i)}><X className="w-3.5 h-3.5" /></Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={addSlot}><Plus className="w-3.5 h-3.5 mr-1" /> Thêm khung giờ</Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Huỷ</Button>
          <Button onClick={onSave} disabled={save.isPending}>{save.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Lưu</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────── Tab: Đã lên lịch ────────────────────────────

function ScheduledTab({ notify }: { notify: Notify }) {
  const approved = usePosts("approved");
  const scheduled = usePosts("scheduled");
  const skip = useSkipPost();
  const approve = useApprove();
  const publishNow = usePublishNow();
  const isLoading = approved.isLoading || scheduled.isLoading;
  const posts = useMemo(
    () => [...(approved.data ?? []), ...(scheduled.data ?? [])].sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? "")),
    [approved.data, scheduled.data],
  );

  const onPublishNow = async (p: Post) => {
    if (!confirm(`Đăng NGAY bài #${p.id} lên Facebook? (bỏ qua giờ đã hẹn)`)) return;
    try {
      const r = await publishNow.mutateAsync(p.id);
      if (r.ok) {
        notify(true, r.dryRun
          ? `Đã chạy thử bài #${p.id} ✅ (DRY_RUN — CHƯA đăng thật lên Facebook). Tắt AUTOPOST_DRY_RUN để đăng thật.`
          : `Đã đăng bài #${p.id} lên Facebook 🎉`);
      } else {
        notify(false, `Không đăng được bài #${p.id}: ${r.error ?? r.status}`);
      }
    } catch (e) { notify(false, `Đăng ngay lỗi: ${String((e as Error).message)}`); }
  };

  const reschedule = async (p: Post) => {
    const cur = p.scheduledAt ? toLocalInput(new Date(p.scheduledAt)) : defaultScheduleValue();
    const v = prompt("Đổi giờ đăng (định dạng YYYY-MM-DDTHH:MM, giờ VN):", cur);
    if (!v) return;
    const d = new Date(v);
    if (isNaN(d.getTime())) { notify(false, "Giờ không hợp lệ"); return; }
    try {
      await approve.mutateAsync({ id: p.id, captionFinal: p.captionFinal ?? "", scheduledAt: d.toISOString() });
      notify(true, `Đã đổi giờ bài #${p.id}`);
    } catch (e) { notify(false, String((e as Error).message)); }
  };

  if (isLoading) return <Spin />;
  if (!posts.length) return <Empty text="Chưa có bài nào đã duyệt chờ đăng." />;
  return (
    <div className="space-y-2">
      {posts.map((p) => (
        <div key={p.id} className="rounded-xl border bg-card p-3 flex gap-3 items-start">
          <Thumb url={p.images?.[0]} className="w-16 h-16 rounded-lg flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{ctLabel(p.contentType)}</Badge>
              {(p.images?.length ?? 0) >= 1 && <Badge variant="outline">{p.images!.length} ảnh</Badge>}
              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDateTime(p.scheduledAt)}</span>
            </div>
            <p className="text-sm mt-1 line-clamp-2 whitespace-pre-wrap">{p.captionFinal}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Button size="sm" onClick={() => onPublishNow(p)} disabled={publishNow.isPending} title="Đăng ngay lên Facebook, bỏ qua giờ hẹn">
              {publishNow.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Share2 className="w-3.5 h-3.5 mr-1" />} Đăng ngay
            </Button>
            <Button size="sm" variant="outline" onClick={() => reschedule(p)}>Đổi giờ</Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => skip.mutate(p.id, { onSuccess: () => notify(true, `Đã huỷ bài #${p.id}`) })}>Huỷ</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────── Tab: Lịch sử đăng ───────────────────────────

function HistoryTab({ notify }: { notify: Notify }) {
  const posted = usePosts("posted");
  const failed = usePosts("failed");
  const retry = useRetryPost();
  const isLoading = posted.isLoading || failed.isLoading;
  if (isLoading) return <Spin />;

  return (
    <div className="space-y-5">
      <section>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 text-red-500" /> Đăng lỗi ({failed.data?.length ?? 0})</h3>
        {!failed.data?.length ? <p className="text-sm text-muted-foreground">Không có bài lỗi.</p> : (
          <div className="space-y-2">
            {failed.data.map((p) => (
              <div key={p.id} className="rounded-xl border border-red-200 bg-red-50/50 p-3 flex gap-3 items-start">
                <Thumb url={p.images?.[0]} className="w-14 h-14 rounded-lg flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm line-clamp-1 whitespace-pre-wrap">{p.captionFinal}</p>
                  <p className="text-xs text-red-600 mt-0.5">{p.errorMessage ?? "lỗi không rõ"} · thử lại {p.retryCount} lần</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => retry.mutate(p.id, { onSuccess: () => notify(true, `Bài #${p.id} sẽ đăng lại`), onError: (e) => notify(false, String((e as Error).message)) })}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1" /> Đăng lại
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-emerald-500" /> Đã đăng ({posted.data?.length ?? 0})</h3>
        {!posted.data?.length ? <p className="text-sm text-muted-foreground">Chưa có bài nào đã đăng.</p> : (
          <div className="space-y-2">
            {posted.data.map((p) => (
              <div key={p.id} className="rounded-xl border bg-card p-3 flex gap-3 items-start">
                <Thumb url={p.images?.[0]} className="w-14 h-14 rounded-lg flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm line-clamp-2 whitespace-pre-wrap">{p.captionFinal}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{fmtDateTime(p.postedAt)}{p.facebookPostId?.startsWith("dryrun_") ? " · (DRY_RUN)" : ""}</p>
                </div>
                {p.facebookPostLink && (
                  <a href={p.facebookPostLink} target="_blank" rel="noreferrer" className="text-xs text-blue-600 inline-flex items-center gap-1 hover:underline">
                    Xem <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ─────────────────────────────── Tab: Facebook Page ──────────────────────────

function FacebookTab({ notify }: { notify: Notify }) {
  const test = useTestFacebook();
  const { data: settings } = useSettings();
  const saveSettings = useSaveSettings();
  const [result, setResult] = useState<FbTestResult | null>(null);
  const [defaultPageId, setDefaultPageId] = useState("");
  useEffect(() => { if (settings?.defaultPageId) setDefaultPageId(settings.defaultPageId); }, [settings?.defaultPageId]);

  const onTest = async () => {
    try { const r = await test.mutateAsync(); setResult(r); notify(r.ok, r.ok ? `Kết nối OK: ${r.pageName}` : `Lỗi: ${r.error ?? "không rõ"}`); }
    catch (e) { notify(false, String((e as Error).message)); }
  };
  const onSavePage = async () => {
    try { await saveSettings.mutateAsync({ ...(settings ?? {}), defaultPageId: defaultPageId || undefined }); notify(true, "Đã lưu Page mặc định"); }
    catch (e) { notify(false, String((e as Error).message)); }
  };

  return (
    <div className="max-w-xl space-y-4">
      <div className="rounded-2xl border bg-card p-4 space-y-3">
        <h3 className="font-semibold flex items-center gap-1.5"><Facebook className="w-4 h-4 text-blue-600" /> Kết nối Facebook Page</h3>
        <p className="text-sm text-muted-foreground">
          Token Page đọc từ cấu hình hệ thống (settings <code className="text-xs">fb_page_access_token</code> / biến môi trường).
          Bấm Test để kiểm tra token + quyền đăng bài.
        </p>
        <Button onClick={onTest} disabled={test.isPending}>
          {test.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Facebook className="w-4 h-4 mr-1" />} Test kết nối
        </Button>
        {result && (
          <div className={`text-sm rounded-lg p-3 ${result.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
            {result.ok ? (
              <>Page: <b>{result.pageName}</b> · Quyền đăng: {result.canPost ? "có" : "không"}</>
            ) : (
              <>Không kết nối được: {result.error}</>
            )}
          </div>
        )}
      </div>

      <div className="rounded-2xl border bg-card p-4 space-y-3">
        <h3 className="font-semibold">Page mặc định</h3>
        <p className="text-sm text-muted-foreground">Page ID dùng khi bài/lịch không chỉ định riêng.</p>
        <div className="flex gap-2">
          <Input value={defaultPageId} onChange={(e) => setDefaultPageId(e.target.value)} placeholder="VD: 1029384756" />
          <Button onClick={onSavePage} disabled={saveSettings.isPending}>Lưu</Button>
        </div>
      </div>

      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3 flex gap-2">
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        <span>Chế độ DRY_RUN đang bật mặc định — bài "đăng" chỉ ghi log thử, chưa lên Facebook thật. Tắt bằng biến môi trường <code>AUTOPOST_DRY_RUN=false</code> khi đã sẵn sàng.</span>
      </div>
    </div>
  );
}

// ─────────────────────────────── Tab: Văn phong mẫu ──────────────────────────

function StyleTab({ notify }: { notify: Notify }) {
  const { data: samples, isLoading } = useStyleSamples();
  const del = useDeleteStyleSample();
  const save = useSaveStyleSample();
  const [editing, setEditing] = useState<StyleSample | null>(null);
  const [creating, setCreating] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);

  const toggleActive = (s: StyleSample) =>
    save.mutate({
      id: s.id,
      body: { title: s.title, content: s.content, tags: s.tags, contentType: s.contentType, tone: s.tone, isActive: !s.isActive, priority: s.priority, images: s.images ?? [], styleTopicKey: s.styleTopicKey ?? "all", styleTopicLabel: s.styleTopicLabel ?? topicLabel(s.styleTopicKey) },
    });

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground flex-1 min-w-[200px]">
          Dán bài viết <b>hay</b> (hoặc <b>ném ảnh chụp màn hình</b> để AI đọc chữ) — Lulu học <b>giọng văn</b> khi viết caption, <b>không chép</b> nguyên văn. Gắn đúng nhóm dịch vụ / tag để chọn mẫu phù hợp.
        </p>
        <Button variant="outline" onClick={() => setOcrOpen(true)} className="shrink-0"><ImageIcon className="w-4 h-4 mr-1" /> Đọc từ ảnh</Button>
        <Button onClick={() => setCreating(true)} className="shrink-0"><Plus className="w-4 h-4 mr-1" /> Thêm bài mẫu</Button>
      </div>

      {isLoading ? <Spin /> : !samples?.length ? (
        <Empty text="Chưa có bài mẫu nào. Bấm 'Thêm bài mẫu' và dán 1 caption hay của Amazing Studio để AI học gu." />
      ) : (
        <div className="space-y-2">
          {samples.map((s) => (
            <div key={s.id} className={`rounded-xl border bg-card p-3 ${!s.isActive ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold">{s.title}</span>
                <Badge variant="secondary">{topicLabel(s.styleTopicKey)} · ưu tiên {s.priority}</Badge>
                {s.tags.map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
                <div className="flex-1" />
                <Switch checked={s.isActive} onCheckedChange={() => toggleActive(s)} />
                <Button size="icon" variant="outline" className="h-8 w-8" title="Sửa" onClick={() => setEditing(s)}><Pencil className="w-3.5 h-3.5" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" title="Xoá" onClick={() => { if (confirm("Xoá bài mẫu này?")) del.mutate(s.id); }}><Trash2 className="w-3.5 h-3.5" /></Button>
              </div>
              <p className="text-sm mt-1.5 whitespace-pre-wrap line-clamp-3 text-muted-foreground">{s.content}</p>
              {(s.images?.length ?? 0) > 0 && (
                <div className="flex gap-1.5 mt-2">
                  {s.images!.slice(0, 5).map((u, i) => <Thumb key={i} url={u} className="w-12 h-12 rounded-md" />)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <StyleDialog sample={editing} onClose={() => { setCreating(false); setEditing(null); }} notify={notify} />
      )}
      {ocrOpen && <OcrDialog onClose={() => setOcrOpen(false)} notify={notify} />}
    </div>
  );
}

function StyleDialog({ sample, onClose, notify }: { sample: StyleSample | null; onClose: () => void; notify: Notify }) {
  const save = useSaveStyleSample();
  const [title, setTitle] = useState(sample?.title ?? "");
  const [content, setContent] = useState(sample?.content ?? "");
  const [topicKey, setTopicKey] = useState(sample?.styleTopicKey ?? "all");
  const [tags, setTags] = useState((sample?.tags ?? []).join(", "));
  const [tone, setTone] = useState(sample?.tone ?? "");
  const [priority, setPriority] = useState(String(sample?.priority ?? 0));
  const [isActive, setIsActive] = useState(sample?.isActive ?? true);

  const onSave = async () => {
    if (!title.trim()) { notify(false, "Cần nhập tiêu đề"); return; }
    if (!content.trim()) { notify(false, "Cần nhập nội dung bài mẫu"); return; }
    try {
      await save.mutateAsync({
        id: sample?.id,
        body: {
          title,
          content,
          styleTopicKey: topicKey,
          styleTopicLabel: topicLabel(topicKey),
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          tone: tone || null,
          priority: Number(priority) || 0,
          isActive,
        },
      });
      notify(true, sample ? "Đã cập nhật bài mẫu" : "Đã thêm bài mẫu");
      onClose();
    } catch (e) { notify(false, `Lưu lỗi: ${String((e as Error).message)}`); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{sample ? "Sửa bài mẫu" : "Thêm bài mẫu"}</DialogTitle>
          <DialogDescription>Dán nguyên 1 caption hay. AI học GIỌNG, tuyệt đối không chép lại.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div><Label>Tiêu đề</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" placeholder="VD: Mẫu cưới ngọt ngào" /></div>
          <div><Label>Nội dung bài mẫu</Label><Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} className="mt-1" placeholder="Dán caption hay vào đây..." /></div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Chủ đề văn phong</Label>
              <Select value={topicKey} onValueChange={setTopicKey}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STYLE_TOPICS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Ưu tiên</Label><Input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} className="mt-1" /></div>
          </div>
          <div><Label>Tag phong cách (cách nhau dấu phẩy)</Label><Input value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1" placeholder="cưới, beauty, bầu, áo dài, váy mới, hậu trường, bill, feedback" /></div>
          <div><Label>Giọng (tuỳ chọn)</Label><Input value={tone} onChange={(e) => setTone(e.target.value)} className="mt-1" placeholder="VD: ngọt ngào, dí dỏm" /></div>
          <div className="flex items-center gap-2"><Switch checked={isActive} onCheckedChange={setIsActive} /> <span className="text-sm">Cho AI dùng mẫu này</span></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Huỷ</Button>
          <Button onClick={onSave} disabled={save.isPending}>{save.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Lưu</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────── Tab: Chữ ký tiệm ────────────────────────────
// Quản lý chữ ký cố định gắn cuối bài (bảng autopost_signatures). Chọn 1 mặc định.
// AI KHÔNG viết lại chữ ký — hệ thống nối nguyên văn lúc đăng (giữ Unicode/số/web).

function SignatureTab({ notify }: { notify: Notify }) {
  const { data: sigs, isLoading } = useSignatures();
  const del = useDeleteSignature();
  const save = useSaveSignature();
  const [editing, setEditing] = useState<Signature | null>(null);
  const [creating, setCreating] = useState(false);

  const toggleActive = (s: Signature) =>
    save.mutate({ id: s.id, body: { name: s.name, content: s.content, isActive: !s.isActive, isDefault: s.isDefault } });
  const makeDefault = (s: Signature) =>
    save.mutate({ id: s.id, body: { name: s.name, content: s.content, isActive: true, isDefault: true } });

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground flex-1 min-w-[200px]">
          Chữ ký cố định gắn vào <b>cuối mỗi bài</b> khi bật "Gắn chữ ký cuối bài". AI <b>không</b> viết lại — hệ thống nối <b>nguyên văn</b> (giữ Unicode, số điện thoại, website, địa chỉ). Chọn <b>1 chữ ký mặc định</b>.
        </p>
        <Button onClick={() => setCreating(true)} className="shrink-0"><Plus className="w-4 h-4 mr-1" /> Thêm chữ ký</Button>
      </div>

      {isLoading ? <Spin /> : !sigs?.length ? (
        <Empty text="Chưa có chữ ký nào. Bấm 'Thêm chữ ký' để tạo." />
      ) : (
        <div className="space-y-2">
          {sigs.map((s) => (
            <div key={s.id} className={`rounded-xl border bg-card p-3 ${!s.isActive ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold">{s.name}</span>
                {s.isDefault && <Badge>Mặc định</Badge>}
                <Badge variant={s.isActive ? "secondary" : "outline"}>{s.isActive ? "Đang bật" : "Tắt"}</Badge>
                <div className="flex-1" />
                {!s.isDefault && <Button size="sm" variant="outline" className="h-8" onClick={() => makeDefault(s)}>Đặt mặc định</Button>}
                <Switch checked={s.isActive} onCheckedChange={() => toggleActive(s)} />
                <Button size="icon" variant="outline" className="h-8 w-8" title="Sửa" onClick={() => setEditing(s)}><Pencil className="w-3.5 h-3.5" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" title="Xoá" onClick={() => { if (confirm("Xoá chữ ký này?")) del.mutate(s.id); }}><Trash2 className="w-3.5 h-3.5" /></Button>
              </div>
              <p className="text-sm mt-1.5 whitespace-pre-wrap text-muted-foreground">{s.content}</p>
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <SignatureDialog signature={editing} onClose={() => { setCreating(false); setEditing(null); }} notify={notify} />
      )}
    </div>
  );
}

function SignatureDialog({ signature, onClose, notify }: { signature: Signature | null; onClose: () => void; notify: Notify }) {
  const save = useSaveSignature();
  const [name, setName] = useState(signature?.name ?? "");
  const [content, setContent] = useState(signature?.content ?? "");
  const [isActive, setIsActive] = useState(signature?.isActive ?? true);
  const [isDefault, setIsDefault] = useState(signature?.isDefault ?? false);
  const [preview, setPreview] = useState(false);

  const onSave = async () => {
    if (!name.trim()) { notify(false, "Cần nhập tên chữ ký"); return; }
    if (!content.trim()) { notify(false, "Cần nhập nội dung chữ ký"); return; }
    try {
      await save.mutateAsync({ id: signature?.id, body: { name, content, isActive, isDefault } });
      notify(true, signature ? "Đã cập nhật chữ ký" : "Đã thêm chữ ký");
      onClose();
    } catch (e) { notify(false, `Lưu lỗi: ${String((e as Error).message)}`); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{signature ? "Sửa chữ ký" : "Thêm chữ ký"}</DialogTitle>
          <DialogDescription>Chữ ký gắn nguyên văn vào cuối bài. Giữ đúng xuống dòng, emoji, ký tự Unicode in đậm.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div><Label>Tên chữ ký</Label><Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" placeholder="VD: Amazing Studio (mặc định)" /></div>
          <div><Label>Nội dung chữ ký</Label><Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={9} className="mt-1 font-mono text-xs" placeholder="Dán chữ ký (giữ nguyên Unicode, xuống dòng)..." /></div>
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer"><Switch checked={isActive} onCheckedChange={setIsActive} /> <span className="text-sm">Bật</span></label>
            <label className="flex items-center gap-2 cursor-pointer"><Switch checked={isDefault} onCheckedChange={setIsDefault} /> <span className="text-sm">Đặt làm mặc định</span></label>
            <Button type="button" variant="outline" size="sm" onClick={() => setPreview((p) => !p)}><Eye className="w-4 h-4 mr-1" /> Xem trước</Button>
          </div>
          {preview && (
            <div className="rounded-lg border bg-muted/30 p-2.5">
              <p className="text-[11px] text-muted-foreground mb-1">Xem trước (gắn ở cuối bài):</p>
              <p className="text-sm whitespace-pre-wrap">{content || "(trống)"}</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Huỷ</Button>
          <Button onClick={onSave} disabled={save.isPending}>{save.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Lưu</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── "Đọc bài mẫu từ ảnh" ─────────────────────────────────────────────────────
// WORKFLOW ĐÚNG CỦA STUDIO: 1 bài viết dài thường phải chụp thành NHIỀU ảnh. Vì vậy
// MẶC ĐỊNH: chọn nhiều ảnh cùng lúc = 1 BÀI MẪU DUY NHẤT. OCR từng ảnh THEO THỨ TỰ
// rồi GHÉP text lại thành 1 nội dung → admin sửa → lưu 1 bài mẫu (kèm tất cả ảnh gốc).
// TUYỆT ĐỐI KHÔNG tự biến mỗi ảnh thành 1 mẫu riêng. "Tách thành nhiều mẫu" chỉ là
// nút phụ, admin chủ động bấm khi thật sự cần.
type OcrImage = {
  key: string; objectUrl: string; dataBase64: string; mediaType: string;
  url: string | null; text: string;
  status: "pending" | "reading" | "ok" | "error"; error?: string;
};

function fileToBase64(file: File): Promise<{ dataBase64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const res = String(fr.result || "");
      resolve({ dataBase64: res.split(",")[1] ?? "", mediaType: file.type || "image/jpeg" });
    };
    fr.onerror = () => reject(new Error("đọc file lỗi"));
    fr.readAsDataURL(file);
  });
}

// Ghép text các ảnh (theo đúng thứ tự mảng) thành 1 nội dung bài mẫu.
function joinOcrTexts(imgs: OcrImage[]): string {
  return imgs.map((i) => i.text.trim()).filter(Boolean).join("\n");
}

function OcrDialog({ onClose, notify }: { onClose: () => void; notify: Notify }) {
  const ocr = useOcrStyleImage();
  const save = useSaveStyleSample();
  const [images, setImages] = useState<OcrImage[]>([]);
  // Nội dung bài mẫu đã ghép từ tất cả ảnh — đây là "nguồn sự thật" khi lưu.
  const [mergedText, setMergedText] = useState("");
  // Admin đã tự sửa ô nội dung? Nếu rồi thì KHÔNG tự ghép đè khi sắp xếp/đọc lại.
  const [mergedEdited, setMergedEdited] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);

  // Trường mô tả của BÀI MẪU (1 mẫu duy nhất).
  const [title, setTitle] = useState("");
  const [contentType, setContentType] = useState("all");
  const [tags, setTags] = useState("");
  const [tone, setTone] = useState("");
  const [priority, setPriority] = useState("0");
  const [isActive, setIsActive] = useState(true);

  const MAX_IMAGES = 10;
  // Ref giữ danh sách ảnh hiện tại để handler 'paste' (gắn 1 lần khi mở modal) luôn
  // đọc được SỐ LƯỢNG mới nhất mà không bị "stale closure".
  const imagesRef = useRef<OcrImage[]>([]);
  useEffect(() => { imagesRef.current = images; }, [images]);

  // Ghép lại nội dung từ mảng ảnh MỚI (chỉ khi admin chưa tự sửa tay).
  const applyMerge = (imgs: OcrImage[]) => {
    if (!mergedEdited) setMergedText(joinOcrTexts(imgs));
  };

  // Thêm 1 loạt File vào kho ảnh — dùng CHUNG cho nút "Chọn ảnh" và dán Ctrl+V.
  // Tôn trọng giới hạn 10 ảnh; nếu dư thì chỉ lấy đủ chỗ + báo nhẹ.
  const addFiles = async (files: File[], fromPicker: boolean) => {
    const room = MAX_IMAGES - imagesRef.current.length;
    if (room <= 0) { notify(false, "Tối đa 10 ảnh cho một bài mẫu"); return; }
    const accept = files.slice(0, room);
    const next: OcrImage[] = [];
    for (const f of accept) {
      try {
        const { dataBase64, mediaType } = await fileToBase64(f);
        next.push({
          key: `${f.name || "anh"}-${f.size}-${Math.random().toString(36).slice(2)}`,
          objectUrl: URL.createObjectURL(f), dataBase64, mediaType, url: null,
          text: "", status: "pending",
        });
      } catch { /* bỏ file lỗi */ }
    }
    if (!next.length) return;
    // Gợi ý tiêu đề từ tên ảnh đầu (chỉ khi chọn file thật — ảnh dán có tên 'image.png' vô nghĩa).
    if (fromPicker && accept[0]?.name) {
      const t = accept[0].name.replace(/\.[^.]+$/, "").slice(0, 60);
      setTitle((prev) => (prev.trim() ? prev : t));
    }
    setImages((d) => [...d, ...next].slice(0, MAX_IMAGES));
    if (files.length > room) notify(false, "Tối đa 10 ảnh cho một bài mẫu");
  };

  const onPick = (files: FileList | null) => {
    if (!files?.length) return;
    void addFiles(Array.from(files), true);
  };

  // Dán ảnh bằng Ctrl+V khi modal đang mở. Gắn ở cấp document để bắt được dù focus
  // ở textarea hay bất kỳ đâu trong popup. Tự gỡ khi modal đóng (component unmount)
  // → KHÔNG ảnh hưởng Ctrl+V ở các màn khác. Nếu clipboard không có ảnh thì bỏ qua
  // (để dán chữ vào textarea chạy bình thường).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgs: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) imgs.push(f);
        }
      }
      if (!imgs.length) return; // không có ảnh → để paste mặc định chạy
      e.preventDefault();
      void addFiles(imgs, false);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeImage = (key: string) => {
    const next = images.filter((x) => x.key !== key);
    setImages(next);
    applyMerge(next);
  };

  // Đổi vị trí ảnh from→to (giữ thứ tự đọc). Ghép lại nội dung theo thứ tự mới.
  const reorder = (from: number, to: number) => {
    if (to < 0 || to >= images.length || from === to) return;
    const next = images.slice();
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    setImages(next);
    applyMerge(next);
  };

  const onDropOn = (targetKey: string) => {
    if (!dragKey || dragKey === targetKey) { setDragKey(null); return; }
    const from = images.findIndex((i) => i.key === dragKey);
    const to = images.findIndex((i) => i.key === targetKey);
    setDragKey(null);
    if (from >= 0 && to >= 0) reorder(from, to);
  };

  // OCR từng ảnh THEO THỨ TỰ → cập nhật trạng thái từng ảnh → ghép text khi xong.
  const onRead = async () => {
    if (!images.length) return;
    setReading(true);
    const order = images; // snapshot thứ tự hiện tại
    const results: Record<string, { url: string | null; text: string }> = {};
    for (const img of order) {
      if (img.status === "ok") { results[img.key] = { url: img.url, text: img.text }; continue; }
      setImages((arr) => arr.map((x) => (x.key === img.key ? { ...x, status: "reading" } : x)));
      try {
        const r = await ocr.mutateAsync({ dataBase64: img.dataBase64, mediaType: img.mediaType });
        results[img.key] = { url: r.url, text: r.text };
        setImages((arr) => arr.map((x) => (x.key === img.key ? { ...x, status: "ok", url: r.url, text: r.text } : x)));
      } catch (e) {
        setImages((arr) => arr.map((x) => (x.key === img.key ? { ...x, status: "error", error: String((e as Error).message) } : x)));
      }
    }
    setReading(false);
    // Ghép theo đúng thứ tự ảnh (trừ khi admin đã tự sửa tay nội dung).
    if (!mergedEdited) {
      const joined = order.map((i) => (results[i.key]?.text ?? i.text).trim()).filter(Boolean).join("\n");
      setMergedText(joined);
    }
    const okCount = order.filter((i) => (results[i.key]?.text ?? "").trim()).length;
    notify(okCount > 0, okCount > 0 ? "Đã đọc & ghép xong. Sửa lại nội dung nếu cần rồi bấm Lưu." : "Không đọc được chữ — gõ tay hoặc thử lại ảnh khác.");
  };

  // LƯU MẶC ĐỊNH: tạo ĐÚNG 1 bài mẫu = nội dung đã ghép + tất cả ảnh gốc (theo thứ tự).
  const onSave = async () => {
    const content = mergedText.trim();
    if (!content) { notify(false, "Chưa có nội dung. Hãy bấm 'Đọc chữ từ ảnh' hoặc gõ tay vào ô nội dung."); return; }
    const finalTitle = title.trim() || (images.length > 1 ? `Mẫu từ ${images.length} ảnh` : "Mẫu từ ảnh");
    const urls = images.map((i) => i.url).filter((u): u is string => !!u);
    setSaving(true);
    try {
      await save.mutateAsync({
        body: {
          title: finalTitle,
          content,
          styleTopicKey: contentType,
          styleTopicLabel: topicLabel(contentType),
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          tone: tone || null,
          priority: Number(priority) || 0,
          isActive,
          images: urls,
        },
      });
      notify(true, "Đã lưu 1 bài mẫu vào kho");
      onClose();
    } catch (e) {
      notify(false, `Lưu lỗi: ${String((e as Error).message)}`);
    } finally {
      setSaving(false);
    }
  };

  // TUỲ CHỌN PHỤ: tách mỗi ảnh (đã đọc chữ) thành 1 bài mẫu riêng. KHÔNG phải mặc định.
  const onSplit = async () => {
    const ready = images.filter((d) => d.text.trim());
    if (ready.length < 2) { notify(false, "Cần ≥ 2 ảnh đã đọc được chữ để tách"); return; }
    if (!confirm(`Tách thành ${ready.length} bài mẫu riêng (mỗi ảnh = 1 mẫu)?`)) return;
    setSaving(true);
    const tagArr = tags.split(",").map((t) => t.trim()).filter(Boolean);
    const base = title.trim() || "Mẫu ảnh";
    let ok = 0;
    for (let i = 0; i < ready.length; i++) {
      const d = ready[i];
      try {
        await save.mutateAsync({
          body: {
            title: `${base} ${i + 1}`,
            content: d.text.trim(),
            styleTopicKey: contentType,
          styleTopicLabel: topicLabel(contentType),
            tags: tagArr,
            tone: tone || null,
            priority: Number(priority) || 0,
            isActive,
            images: d.url ? [d.url] : [],
          },
        });
        ok++;
      } catch { /* tiếp tục mẫu khác */ }
    }
    setSaving(false);
    notify(ok > 0, ok > 0 ? `Đã tách & lưu ${ok} bài mẫu` : "Lưu lỗi");
    if (ok > 0) onClose();
  };

  const readCount = images.filter((d) => d.status === "ok").length;
  const splittable = images.filter((d) => d.text.trim()).length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Đọc bài mẫu từ ảnh</DialogTitle>
          <DialogDescription>
            Một bài viết dài có thể chụp thành nhiều ảnh. Chọn <b>tất cả ảnh của CÙNG một bài</b> — AI đọc chữ từng ảnh theo thứ tự rồi <b>ghép thành 1 bài mẫu</b>. Kéo–thả để sắp thứ tự, sửa nội dung nếu đọc sai, rồi Lưu. (AI học từ phần CHỮ; ảnh chỉ lưu kèm để xem lại.)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <label className={`inline-flex items-center gap-1.5 text-sm border rounded-lg px-3 h-9 ${images.length >= 10 ? "opacity-50" : "cursor-pointer hover:bg-muted"}`}>
              <Plus className="w-4 h-4" /> Chọn ảnh ({images.length}/10)
              <input type="file" accept="image/*" multiple className="hidden" disabled={images.length >= 10}
                onChange={(e) => { onPick(e.target.files); e.currentTarget.value = ""; }} />
            </label>
            <Button size="sm" onClick={onRead} disabled={!images.length || reading}>
              {reading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Sparkles className="w-4 h-4 mr-1" />} Đọc chữ từ ảnh
            </Button>
            {readCount > 0 && <span className="text-xs text-muted-foreground">đã đọc {readCount}/{images.length}</span>}
          </div>
          <p className="text-[11px] text-muted-foreground -mt-1">
            💡 Mẹo: chụp màn hình bài viết rồi nhấn <b>Ctrl + V</b> để dán thẳng ảnh vào đây — không cần bấm "Chọn ảnh". Dán nhiều lần để thêm nhiều ảnh.
          </p>

          {/* Danh sách ảnh — thumbnail theo thứ tự, kéo–thả / nút ↑↓ để sắp lại, xoá từng ảnh. */}
          {images.length > 0 && (
            <div className="space-y-2">
              {images.map((d, idx) => (
                <div
                  key={d.key}
                  draggable
                  onDragStart={() => setDragKey(d.key)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDropOn(d.key)}
                  className={`flex items-start gap-2 rounded-xl border p-2 bg-card ${dragKey === d.key ? "opacity-50" : ""}`}
                >
                  <div className="flex flex-col items-center gap-0.5 pt-1 text-muted-foreground">
                    <GripVertical className="w-4 h-4 cursor-grab shrink-0" />
                    <span className="text-[11px] font-semibold">{idx + 1}</span>
                  </div>
                  <img src={d.objectUrl} alt="" className="w-16 h-16 object-cover rounded-md flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    {d.status === "error" ? (
                      // Lỗi đọc: hiện ĐẦY ĐỦ (xuống dòng + cuộn nếu dài) — KHÔNG cắt cụt. Kèm
                      // tooltip hover (title) + nút sao chép để admin gửi/đối chiếu lỗi dễ dàng.
                      <div className="min-h-[2rem]">
                        <p
                          className="text-xs text-red-600 whitespace-pre-wrap break-words max-h-24 overflow-y-auto"
                          title={`Đọc lỗi: ${d.error ?? "không rõ"}`}
                        >
                          Đọc lỗi: {d.error ?? "không rõ"}
                        </p>
                        <button
                          type="button"
                          className="mt-0.5 text-[11px] underline text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            const msg = `Đọc lỗi: ${d.error ?? "không rõ"}`;
                            navigator.clipboard?.writeText(msg).then(
                              () => notify(true, "Đã sao chép lỗi"),
                              () => notify(false, "Không sao chép được"),
                            );
                          }}
                        >
                          Sao chép lỗi
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap min-h-[2rem]">
                        {d.status === "reading" ? "Đang đọc…" :
                         d.text.trim() ? d.text.trim() : "Chưa đọc chữ"}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {d.status === "reading" && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                    {d.status === "ok" && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                    {d.status === "error" && <AlertTriangle className="w-4 h-4 text-red-500" />}
                    <Button size="icon" variant="ghost" className="h-7 w-7" title="Lên" disabled={idx === 0} onClick={() => reorder(idx, idx - 1)}><ArrowUp className="w-3.5 h-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" title="Xuống" disabled={idx === images.length - 1} onClick={() => reorder(idx, idx + 1)}><ArrowDown className="w-3.5 h-3.5" /></Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Xoá ảnh" onClick={() => removeImage(d.key)}><X className="w-3.5 h-3.5" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Nội dung bài mẫu đã ghép — ô lớn, admin sửa được. */}
          <div>
            <Label>Nội dung bài mẫu đã đọc</Label>
            <Textarea
              value={mergedText}
              onChange={(e) => { setMergedText(e.target.value); setMergedEdited(true); }}
              rows={8}
              className="mt-1 text-sm"
              placeholder="Bấm 'Đọc chữ từ ảnh' để AI đọc & ghép nội dung tất cả ảnh vào đây — hoặc gõ tay. Admin có thể sửa lại nếu đọc sai."
            />
            <p className="text-[11px] text-muted-foreground mt-1">Đây là phần AI sẽ học giọng. Tất cả ảnh ở trên được gộp thành <b>1 bài mẫu duy nhất</b>.</p>
          </div>

          {/* Trường mô tả của bài mẫu (1 mẫu). */}
          <div className="rounded-xl border p-3 space-y-2 bg-muted/30">
            <div><Label className="text-xs">Tiêu đề</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-9 mt-1" placeholder="VD: Mẫu cưới ngọt ngào" /></div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Chủ đề văn phong</Label>
                <Select value={contentType} onValueChange={setContentType}>
                  <SelectTrigger className="h-9 mt-1"><SelectValue placeholder="Chủ đề văn phong" /></SelectTrigger>
                  <SelectContent>
                    {STYLE_TOPICS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div><Label className="text-xs">Ưu tiên</Label><Input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} className="h-9 mt-1" placeholder="0" /></div>
            </div>
            <div><Label className="text-xs">Tag phong cách (cách nhau dấu phẩy)</Label><Input value={tags} onChange={(e) => setTags(e.target.value)} className="h-9 mt-1" placeholder="cưới, áo dài, beauty..." /></div>
            <div><Label className="text-xs">Giọng (tuỳ chọn)</Label><Input value={tone} onChange={(e) => setTone(e.target.value)} className="h-9 mt-1" placeholder="VD: ngọt ngào, dí dỏm" /></div>
            <div className="flex items-center gap-2 pt-1"><Switch checked={isActive} onCheckedChange={setIsActive} /> <span className="text-sm">Cho AI dùng mẫu này</span></div>
          </div>
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={onSplit}
            disabled={saving || splittable < 2}
            title="Tuỳ chọn phụ: lưu mỗi ảnh thành 1 bài mẫu riêng"
          >
            <Scissors className="w-3.5 h-3.5 mr-1" /> Tách thành nhiều mẫu{splittable >= 2 ? ` (${splittable})` : ""}
          </Button>
          <div className="flex items-center gap-2 sm:ml-auto">
            <Button variant="outline" onClick={onClose}>Huỷ</Button>
            <Button onClick={onSave} disabled={saving || !mergedText.trim()}>
              {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Lưu 1 bài mẫu
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────── Tab: Cấu hình Lulu ──────────────────────────

function ConfigTab({ notify }: { notify: Notify }) {
  const { data: settings, isLoading } = useSettings();
  const save = useSaveSettings();
  const [tone, setTone] = useState("");
  const [banned, setBanned] = useState("");
  useEffect(() => {
    if (settings) {
      setTone(typeof settings.tone === "string" ? settings.tone : "");
      setBanned(Array.isArray(settings.bannedWords) ? settings.bannedWords.join(", ") : "");
    }
  }, [settings]);

  const onSave = async () => {
    const bannedWords = banned.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      await save.mutateAsync({ ...(settings ?? {}), tone: tone || undefined, bannedWords });
      notify(true, "Đã lưu cấu hình Lulu");
    } catch (e) { notify(false, String((e as Error).message)); }
  };

  if (isLoading) return <Spin />;
  return (
    <div className="max-w-xl space-y-4">
      <div className="rounded-2xl border bg-card p-4 space-y-3">
        <h3 className="font-semibold flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-violet-500" /> Giọng viết caption</h3>
        <Textarea value={tone} onChange={(e) => setTone(e.target.value)} rows={3} placeholder="VD: ấm áp, tự nhiên, sang trọng, không sáo rỗng" />
        <div>
          <Label>Từ cấm (cách nhau dấu phẩy)</Label>
          <Input value={banned} onChange={(e) => setBanned(e.target.value)} className="mt-1" placeholder="VD: rẻ nhất, bao đậu" />
        </div>
        <Button onClick={onSave} disabled={save.isPending}>{save.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />} Lưu cấu hình</Button>
      </div>

      <DriveConfigSection notify={notify} />
    </div>
  );
}

/** Tách Folder ID từ link Drive đã dán (folders/<id>, /d/<id>, ?id=<id>) hoặc trả lại ID thuần. */
function extractDriveFolderId(input: string): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const folders = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folders) return folders[1];
  const dShare = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (dShare) return dShare[1];
  const idParam = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParam) return idParam[1];
  if (/^https?:\/\//i.test(s)) return "";
  return s.replace(/[^a-zA-Z0-9_-]/g, "");
}

function DriveConfigSection({ notify }: { notify: Notify }) {
  const { data: settings } = useSettings();
  const { data: status } = useDriveStatus();
  const save = useSaveSettings();
  const test = useTestDrive();
  const [folderInput, setFolderInput] = useState("");
  const [result, setResult] = useState<DriveTestResult | null>(null);
  useEffect(() => { setFolderInput(settings?.drive?.folderId ?? ""); }, [settings?.drive?.folderId]);

  // Cho dán nguyên link Drive → tự tách Folder ID.
  const extractedId = extractDriveFolderId(folderInput);
  const looksLikeLink = /^https?:\/\//i.test(folderInput.trim());

  const onSaveFolder = async () => {
    const id = extractDriveFolderId(folderInput);
    if (folderInput.trim() && !id) { notify(false, "Không tách được Folder ID từ link — kiểm tra lại link Drive."); return; }
    try {
      await save.mutateAsync({ ...(settings ?? {}), drive: { ...(settings?.drive ?? {}), folderId: id || undefined } });
      setFolderInput(id);
      notify(true, id ? `Đã lưu Folder ID: ${id}` : "Đã xoá Folder ID (sẽ dùng GOOGLE_DRIVE_FOLDER_ID)");
    } catch (e) { notify(false, String((e as Error).message)); }
  };
  const onTest = async () => {
    try {
      const r = await test.mutateAsync();
      setResult(r);
      notify(r.ok, r.ok ? `Kết nối Drive OK: ${r.folderName}` : `Drive: ${r.missing?.length ? "thiếu " + r.missing.join(", ") : (r.error ?? "lỗi")}`);
    } catch (e) { notify(false, String((e as Error).message)); }
  };
  // Ưu tiên trạng thái thật từ /status; fallback cờ connected trong settings.
  const connected = status?.connected ?? !!settings?.drive?.connected;
  const hasClient = status?.hasClient ?? true;
  const callbackUri = typeof window !== "undefined" ? `${window.location.origin}/api/autopost/drive/callback` : "";
  const onConnect = () => {
    const token = localStorage.getItem("amazingStudioToken_v2") || "";
    if (!token) { notify(false, "Chưa đăng nhập"); return; }
    const url = `${apiUrl("/api/autopost/drive/connect")}?token=${encodeURIComponent(token)}&redirectUri=${encodeURIComponent(callbackUri)}`;
    window.location.href = url;
  };

  return (
    <div className="rounded-2xl border bg-card p-4 space-y-3">
      <h3 className="font-semibold flex items-center gap-1.5"><Folder className="w-4 h-4 text-amber-500" /> Google Drive (Phase 2)</h3>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Dùng <code>GOOGLE_DRIVE_CLIENT_ID/SECRET</code>, <b>tự fallback</b> sang <code>GOOGLE_CLIENT_ID/SECRET</code> nếu chưa đặt riêng — <b>không cần tạo lại</b>. Bấm <b>Kết nối Google Drive</b> để cấp quyền <b>chỉ đọc</b> (<code>drive.readonly</code>); refresh token lưu an toàn, không hiển thị.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={onConnect} disabled={!hasClient} title={hasClient ? "" : "Chưa có Client ID/Secret trong môi trường"}>
          <Folder className="w-4 h-4 mr-1" /> Kết nối Google Drive
        </Button>
        {connected ? (
          <span className="text-xs text-emerald-600 font-medium inline-flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Đã kết nối</span>
        ) : (
          <span className="text-xs text-muted-foreground">Chưa kết nối</span>
        )}
        {status?.clientIdSource && (
          <span className="text-[11px] text-muted-foreground">· client từ <code>{status.clientIdSource}</code></span>
        )}
      </div>
      {!hasClient && (
        <p className="text-[11px] text-red-600">Chưa có Client ID/Secret: đặt <code>GOOGLE_DRIVE_CLIENT_ID/SECRET</code> hoặc <code>GOOGLE_CLIENT_ID/SECRET</code> trong môi trường.</p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Thêm URL này vào <b>Authorized redirect URIs</b> của OAuth client (Google Cloud Console): <code className="break-all">{callbackUri}</code>
      </p>
      <div>
        <Label>Link folder hoặc Folder ID cha — "Amazing Studio AutoPost"</Label>
        <div className="flex gap-2 mt-1">
          <Input value={folderInput} onChange={(e) => setFolderInput(e.target.value)} placeholder="Dán link Drive (…/folders/1AbC…) hoặc Folder ID 1AbC…" />
          <Button variant="outline" onClick={onSaveFolder} disabled={save.isPending}>Lưu</Button>
        </div>
        {looksLikeLink && (
          <p className="text-[11px] mt-1 text-muted-foreground">
            {extractedId ? <>Tách được Folder ID: <code>{extractedId}</code></> : <span className="text-red-600">Không tách được Folder ID từ link này.</span>}
          </p>
        )}
      </div>
      <Button onClick={onTest} disabled={test.isPending}>
        {test.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Folder className="w-4 h-4 mr-1" />} Test kết nối Drive
      </Button>
      {result && (
        <div className={`text-sm rounded-lg p-3 ${result.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
          {result.ok ? (
            <>
              <p>Folder cha: <b>{result.folderName}</b> · {result.subfolders?.length ?? 0} folder con</p>
              <ul className="mt-1 space-y-0.5 max-h-48 overflow-auto">
                {(result.subfolders ?? []).map((s, i) => (
                  <li key={i} className="text-xs">• {s.name} → <b>{ctLabel(s.mappedType)}</b> ({s.files} file)</li>
                ))}
              </ul>
            </>
          ) : result.missing?.length ? (
            <p>Thiếu biến môi trường: {result.missing.join(", ")}</p>
          ) : (
            <p>Lỗi: {result.error}</p>
          )}
        </div>
      )}
      <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
        Video Reel được nhập kèm thumbnail; <b>đăng video lên Facebook hoãn Phase 2.1</b> (hiện chỉ đăng ảnh).
      </div>
    </div>
  );
}
