import { useEffect, useMemo, useState } from "react";
import {
  Share2, RefreshCw, Plus, Trash2, CheckCircle2, AlertTriangle, ExternalLink,
  Sparkles, Clock, History, Settings as SettingsIcon, Facebook, Loader2, X, Image as ImageIcon,
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
  useGenerate, useApprove, useSkipPost, useRetryPost,
  useSaveSchedule, useToggleSchedule, useDeleteSchedule, useSaveSettings, useTestFacebook,
  type PoolItem, type Post, type Schedule, type Slot, type FbTestResult, type AutoPostSettings,
} from "@/lib/autopost-api";

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
  { value: "service", label: "Dịch vụ" },
  { value: "other", label: "Khác" },
];
const SOURCE_PRIORITIES = [
  { value: "app_web", label: "App / Web" },
  { value: "upload", label: "Upload thủ công" },
];

function ctLabel(v: string | null): string {
  return CONTENT_TYPES.find((c) => c.value === v)?.label ?? v ?? "—";
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
            Claude viết caption · admin duyệt · scheduler tự đăng theo giờ.{" "}
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
          <TabsTrigger value="config"><SettingsIcon className="w-4 h-4 mr-1" /> Cấu hình Claude</TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="mt-4"><PendingTab notify={notify} /></TabsContent>
        <TabsContent value="pool" className="mt-4"><PoolTab notify={notify} goPending={() => setTab("pending")} /></TabsContent>
        <TabsContent value="schedules" className="mt-4"><SchedulesTab notify={notify} /></TabsContent>
        <TabsContent value="scheduled" className="mt-4"><ScheduledTab notify={notify} /></TabsContent>
        <TabsContent value="history" className="mt-4"><HistoryTab notify={notify} /></TabsContent>
        <TabsContent value="facebook" className="mt-4"><FacebookTab notify={notify} /></TabsContent>
        <TabsContent value="config" className="mt-4"><ConfigTab notify={notify} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─────────────────────────────── Common bits ─────────────────────────────────

function Thumb({ url, className }: { url?: string; className?: string }) {
  const [err, setErr] = useState(false);
  if (!url || err) {
    return (
      <div className={`flex items-center justify-center bg-muted text-muted-foreground ${className ?? ""}`}>
        <ImageIcon className="w-6 h-6 opacity-40" />
      </div>
    );
  }
  return <img src={url} alt="" onError={() => setErr(true)} className={`object-cover ${className ?? ""}`} />;
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
  if (!valid.length) return <Empty text="Chưa có bài nào chờ duyệt. Vào 'Kho nội dung' → 'Tạo bài' để Claude viết caption." />;
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
  const approve = useApprove();
  const skip = useSkipPost();

  const pickOption = (i: number) => {
    setIdx(i);
    if (options[i]) setText(options[i].text);
  };

  const onApprove = async () => {
    if (!text.trim()) { notify(false, "Caption không được rỗng"); return; }
    try {
      await approve.mutateAsync({ id: post.id, captionFinal: text, scheduledAt: new Date(when).toISOString() });
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
            {post.images?.length > 1 && <Badge variant="outline">{post.images.length} ảnh</Badge>}
          </div>
          <p className="text-xs text-muted-foreground mt-1">Chọn 1 trong {options.length} caption, sửa nếu cần rồi đặt giờ đăng.</p>
          {warn && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600 bg-red-50 px-2 py-1 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5" /> Caption có cảnh báo giá — kiểm tra số tiền trước khi duyệt.
            </div>
          )}
        </div>
      </div>

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
        <Label className="text-xs">Caption sẽ đăng (sửa tay được)</Label>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className="mt-1" />
      </div>

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
  const [contentType, setContentType] = useState("all");
  const [sourceType, setSourceType] = useState("all");
  const filters = useMemo(
    () => ({
      contentType: contentType === "all" ? undefined : contentType,
      sourceType: sourceType === "all" ? undefined : sourceType,
    }),
    [contentType, sourceType],
  );
  const { data: items, isLoading } = usePool(filters);
  const sync = useSyncPool();
  const generate = useGenerate();
  const del = useDeletePoolItem();
  const update = useUpdatePoolItem();
  const [showUpload, setShowUpload] = useState(false);

  const onSync = async () => {
    try {
      const r = await sync.mutateAsync();
      notify(true, `Đồng bộ xong: ${r.dresses} váy/đồ · ${r.albums} album · ${r.ideas} ý tưởng.`);
    } catch (e) { notify(false, `Sync lỗi: ${String((e as Error).message)}`); }
  };
  const onGenerate = async (it: PoolItem) => {
    try {
      await generate.mutateAsync({ poolId: it.id });
      notify(true, `Đã tạo bài chờ duyệt từ "${it.title}". Mở tab 'Bài chờ duyệt' để xem.`);
      goPending();
    } catch (e) { notify(false, `Tạo bài lỗi: ${String((e as Error).message)}`); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={contentType} onValueChange={setContentType}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="Loại nội dung" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả loại</SelectItem>
            {CONTENT_TYPES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sourceType} onValueChange={setSourceType}>
          <SelectTrigger className="w-[160px]"><SelectValue placeholder="Nguồn" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tất cả nguồn</SelectItem>
            {SOURCE_PRIORITIES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button variant="outline" onClick={onSync} disabled={sync.isPending}>
          {sync.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
          Đồng bộ app/web
        </Button>
        <Button onClick={() => setShowUpload(true)}><Plus className="w-4 h-4 mr-1" /> Thêm thủ công</Button>
      </div>

      {isLoading ? <Spin /> : !items?.length ? (
        <Empty text="Kho trống. Bấm 'Đồng bộ app/web' để lấy váy cưới / album / ý tưởng đang public." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <div key={it.id} className="rounded-2xl border bg-card overflow-hidden flex flex-col">
              <Thumb url={it.images?.[0]} className="w-full h-40" />
              <div className="p-3 space-y-2 flex-1 flex flex-col">
                <div className="flex items-start gap-2">
                  <span className="font-medium text-sm leading-snug line-clamp-2 flex-1">{it.title}</span>
                  {!it.isEligible && <Badge variant="destructive" className="shrink-0">Ẩn</Badge>}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap text-xs">
                  <Badge variant="secondary">{ctLabel(it.contentType)}</Badge>
                  {it.badge && <Badge variant="outline">{it.badge}</Badge>}
                  {fmtVnd(it.salePrice) ? (
                    <span className="text-rose-600 font-medium">{fmtVnd(it.salePrice)}</span>
                  ) : fmtVnd(it.price) ? (
                    <span className="text-muted-foreground">{fmtVnd(it.price)}</span>
                  ) : null}
                  {it.images?.length > 1 && <span className="text-muted-foreground">· {it.images.length} ảnh</span>}
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-1.5">
                  <Button size="sm" className="flex-1" onClick={() => onGenerate(it)} disabled={!it.isEligible || generate.isPending}>
                    <Sparkles className="w-3.5 h-3.5 mr-1" /> Tạo bài
                  </Button>
                  <Button
                    size="sm" variant="outline" title={it.isEligible ? "Ẩn khỏi chọn đăng" : "Cho phép đăng"}
                    onClick={() => update.mutate({ id: it.id, patch: { isEligible: !it.isEligible } })}
                  >
                    {it.isEligible ? "Ẩn" : "Hiện"}
                  </Button>
                  <Button
                    size="sm" variant="ghost" className="text-destructive"
                    onClick={() => { if (confirm("Xoá item khỏi kho?")) del.mutate(it.id); }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
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
    imageCount: 1,
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
  const addSlot = () => setSlots((arr) => [...arr, { postTime: "12:00", contentType: "vay_cuoi", imageCount: 1, sourcePriority: "app_web", enabled: true, sortOrder: arr.length }]);

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
                <Input type="number" min={1} max={10} value={s.imageCount} onChange={(e) => updateSlot(i, { imageCount: Number(e.target.value) || 1 })} className="w-[64px]" title="Số ảnh" />
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
  const isLoading = approved.isLoading || scheduled.isLoading;
  const posts = useMemo(
    () => [...(approved.data ?? []), ...(scheduled.data ?? [])].sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? "")),
    [approved.data, scheduled.data],
  );

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
              <span className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" /> {fmtDateTime(p.scheduledAt)}</span>
            </div>
            <p className="text-sm mt-1 line-clamp-2 whitespace-pre-wrap">{p.captionFinal}</p>
          </div>
          <div className="flex flex-col gap-1.5">
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

// ─────────────────────────────── Tab: Cấu hình Claude ────────────────────────

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
      notify(true, "Đã lưu cấu hình Claude");
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

      <div className="rounded-2xl border bg-card p-4 opacity-70">
        <h3 className="font-semibold">Google Drive (Phase 2)</h3>
        <p className="text-sm text-muted-foreground mt-1">Nguồn hậu trường / makeup / feedback / bill từ Drive sẽ bổ sung ở giai đoạn 2.</p>
      </div>
    </div>
  );
}
