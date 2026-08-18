import { useState, useEffect, useCallback, useRef } from "react";
import { apiUrl } from "@/lib/api-base";
import { getImageSrc } from "@/lib/imageUtils";
import { convertToWebP, uploadFileViaPresign } from "@/lib/image-upload";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import {
  Brain, Sparkles, Pencil, FlaskConical, History, Send, Image as ImageIcon, X,
  Check, AlertTriangle, Loader2, RotateCcw, Save, Trash2, Bot, User, ShieldCheck,
  Plus, Eye, Megaphone, GitCompareArrows, ChevronDown, Wand2, MessageSquare,
  Search, Images, Repeat,
} from "lucide-react";

// Ảnh hỏng (URL 404 / không tải được) → thay bằng nền xám "ảnh lỗi" thay cho icon vỡ + log để debug.
// (Backend đã lọc URL rác trước khi trả về; đây là lưới an toàn cho ảnh URL hợp lệ nhưng tải fail.)
const BROKEN_IMG_PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#f1f1f4"/><text x="60" y="62" font-family="sans-serif" font-size="11" fill="#9ca3af" text-anchor="middle">ảnh lỗi</text></svg>',
  );
function onBrokenSampleImg(e: React.SyntheticEvent<HTMLImageElement>) {
  const img = e.currentTarget;
  if (img.dataset.fallback === "1") return; // tránh vòng lặp nếu placeholder cũng lỗi
  img.dataset.fallback = "1";
  console.warn("[SaleBrain] image render url invalid reason=load_error src=" + String(img.src).slice(0, 100));
  img.src = BROKEN_IMG_PLACEHOLDER;
}

/**
 * Lulu Brain Lab — quản lý / sửa / test / lưu version cho "não Sale AI Lulu".
 * Nhân viên: báo lỗi, góp ý, nhờ AI sửa, sửa tay, test bản nháp.
 * Admin: thêm quyền Áp dụng bản nháp + Khôi phục version.
 * AN TOÀN: chỉ đụng não Sale AI (bộ luật), không đụng booking/payment/calendar/DB nghiệp vụ.
 */

// ─── Types ──────────────────────────────────────────────────────────────────
type Status = "draft" | "active" | "archived" | "rejected";
type BrainVersion = {
  id: number; versionNumber: number; title: string; description: string; status: Status;
  promptContent: string; createdBy: number | null; createdByName: string | null; createdAt: string;
  appliedBy: number | null; appliedByName: string | null; appliedAt: string | null;
  basedOnVersionId: number | null; changeSummary: string | null; rollbackNote: string | null; updatedAt: string;
};
type ChangeRequest = {
  id: number; requesterName: string | null; issueTitle: string; issueDescription: string;
  exampleCustomerMessage: string | null; expectedBehavior: string | null; currentWrongBehavior: string | null;
  status: string; linkedVersionId: number | null; createdAt: string; screenshotUrl: string | null;
};
// Kết quả AI phân tích screenshot/chữ (khớp ScreenshotAnalysis ở backend).
type ScreenshotAnalysis = {
  readable: boolean; confidence: number; clarifyQuestion: string;
  issueTitle: string; exampleCustomerMessage: string; currentWrongBehavior: string;
  expectedBehavior: string; affectedRules: string[]; suggestedChangeSummary: string;
};
type TestCase = {
  id: number; title: string; customerMessage: string; expectedIntent: string | null;
  expectedBehavior: string | null; mustNotDo: string | null; serviceGroupExpected: string | null;
  isRequired: boolean; priorContext: Array<{ direction: "incoming" | "outgoing"; text: string }>;
};
type SampleImage = { title: string; imageUrl: string; detailUrl?: string; sourceType: string; serviceIntent?: string };
type SimResult = {
  reply: string[]; raw: string; escalation: string | null; escalated: boolean; escalationReason: string | null;
  holdMessage: string | null; detectedIntent: string | null; priceImages: string[];
  sampleImages: SampleImage[]; sampleNote: string | null; responseTimeMs: number;
  /** Bong bóng có nhịp (human chat pacing): text + delayMs từng bubble. reply = chunks.map(c=>c.text). */
  chunks?: { text: string; delayMs: number }[];
  overrideApplied?: boolean;
  /** Cách lượt này dùng câu sửa tay admin: "exact_reply" = nói y chang; "learn_from_this" = AI học theo. */
  responseMode?: "exact_reply" | "learn_from_this" | null;
};
// Ảnh trong kho (khớp ImageStoreItem ở backend).
type StoreItem = { imageUrl: string; title: string; detailUrl?: string; sourceType: string; kind?: string; serviceIntent: string; albumName?: string; tags?: string; albumId?: number; publicForCustomer?: boolean };
// Debug kho ảnh (khớp ImageStoreDebug ở backend) — cho admin biết vì sao rỗng.
type StoreDebug = { reason: string; message: string; sourceCounts?: Record<string, number>; withImageCount?: number; missingUrlCount?: number; afterFilterBeforeTone?: number; afterToneFilter?: number; toneRelaxed?: boolean; errors?: string[] };
// Tab nguồn ảnh → param kinds.
const SOURCE_TABS: Array<{ key: string; label: string }> = [
  { key: "", label: "Tất cả" },
  { key: "album,rental", label: "Ảnh mẫu" },
  { key: "album", label: "Bộ ảnh" },
  { key: "idea", label: "Ý tưởng chụp ảnh" },
  { key: "price", label: "Bảng giá" },
];
// Ảnh admin chọn để dạy Lulu (khớp OverrideImage ở backend).
type OverrideImage = { imageUrl: string; title: string; detailUrl?: string; sourceType: string; serviceIntent?: string };

// Nhóm dịch vụ / intent cho dropdown khi dạy ảnh.
const INTENT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "beauty", label: "Beauty / chụp cá nhân" },
  { value: "wedding_album", label: "Cưới / album / ngoại cảnh" },
  { value: "wedding_gate", label: "Chụp cổng" },
  { value: "wedding_party", label: "Tiệc cưới / phóng sự" },
  { value: "rental_outfit", label: "Thuê đồ (váy/áo dài/vest)" },
  { value: "maternity", label: "Mẹ bầu" },
  { value: "family", label: "Gia đình" },
  { value: "new_concept_idea", label: "Concept / ý tưởng lạ" },
];
// Tone / gu gợi ý (admin có thể tự gõ thêm). Để trống = áp cho mọi tone của intent.
const TONE_CHIPS = ["nhẹ nhàng", "tự nhiên", "sang trọng", "cổ điển", "hiện đại", "Hàn Quốc", "nàng thơ", "cá tính", "vintage"];

type Tab = "active" | "aifix" | "fixtest" | "history";
type ConvoMsg = { direction: "incoming" | "outgoing"; text: string };
// Map các key tab CŨ (deep-link / bookmark) sang tab mới.
const LEGACY_TAB_MAP: Record<string, Tab> = {
  active: "active", history: "history",
  ai: "aifix", aifix: "aifix",
  draft: "fixtest", test: "fixtest", fixtest: "fixtest",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function token(): string | null { return localStorage.getItem("amazingStudioToken_v2"); }
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
const DRAFT_KEY = "luluBrainLab.draftId";
const QUEUE_KEY = "luluBrainLab.fixQueue"; // giữ hàng đợi sửa lỗi qua refresh (lưu nhẹ, bỏ base64 ảnh)
const CHAT_KEY = "luluBrainLab.testChat"; // giữ lịch sử chat test qua đổi tab + refresh; chỉ reset khi tạo nháp mới / bấm "Xóa hội thoại"

// Khôi phục lịch sử chat test đã lưu (best-effort; ảnh khách đính bị bỏ khi lưu cho nhẹ → text vẫn còn).
function restoreTestChat(): { ownerDraftId: number | null; turns: TestTurn[]; convo: ConvoMsg[] } {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    if (!raw) return { ownerDraftId: null, turns: [], convo: [] };
    const o = JSON.parse(raw) as Partial<{ ownerDraftId: number | null; turns: TestTurn[]; convo: ConvoMsg[] }>;
    return {
      ownerDraftId: typeof o.ownerDraftId === "number" ? o.ownerDraftId : null,
      turns: Array.isArray(o.turns) ? o.turns : [],
      convo: Array.isArray(o.convo) ? o.convo : [],
    };
  } catch { return { ownerDraftId: null, turns: [], convo: [] }; }
}

// Chat "Nhờ AI sửa Lulu": ảnh chấp nhận + ngưỡng tin cậy.
const IMG_ACCEPT = ["image/jpeg", "image/png", "image/webp"];
const IMG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 6; // đoạn chat dài → cho đính nhiều ảnh (khớp ANALYZE_MAX_IMAGES ở backend).
const CONFIDENCE_MIN = 0.6; // < 0.6 hoặc readable=false → hỏi lại, KHÔNG hiện card.
// 5 quick-chip gợi ý (yêu cầu #9) — dùng chung cho cả chat lẫn chế độ nâng cao.
const QUICK_CHIPS = [
  "Lulu gửi sai nhóm ảnh",
  "Lulu nói còn giống AI",
  "Khách hỏi cool boy mà gửi mẫu nữ",
  "Khách hỏi giá mà Lulu báo quá dài",
  "Lulu tự gửi ảnh khi khách chưa xin mẫu",
];
/** Ghép kết quả phân tích thành 1 câu góp ý cho AI viết lại bộ luật (đường ai-draft text-only). */
function analysisToInstruction(a: ScreenshotAnalysis): string {
  return [
    a.issueTitle && `Lỗi: ${a.issueTitle}`,
    a.exampleCustomerMessage && `Câu khách: "${a.exampleCustomerMessage}"`,
    a.currentWrongBehavior && `Lulu đang làm SAI: ${a.currentWrongBehavior}`,
    a.expectedBehavior && `Mong Lulu làm ĐÚNG: ${a.expectedBehavior}`,
    a.affectedRules.length ? `Khối luật liên quan: ${a.affectedRules.join(", ")}` : "",
    a.suggestedChangeSummary && `Gợi ý sửa: ${a.suggestedChangeSummary}`,
  ].filter(Boolean).join("\n");
}

// LƯU Ý: apiUrl() chỉ prepend BASE_URL, KHÔNG tự thêm "/api" — path phải gồm "/api" (xem claude-sale-test.tsx).
async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(`/api${path}`), { headers: authHeaders() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `Lỗi ${r.status}`);
  return data as T;
}
async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(apiUrl(`/api${path}`), { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error || `Lỗi ${r.status}`);
  return data as T;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("read_error"));
    fr.readAsDataURL(file);
  });
}
function fmtDate(s: string | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch { return s; }
}
const STATUS_BADGE: Record<Status, string> = {
  active: "bg-emerald-100 text-emerald-700 border-emerald-200",
  draft: "bg-amber-100 text-amber-700 border-amber-200",
  archived: "bg-gray-100 text-gray-600 border-gray-200",
  rejected: "bg-rose-100 text-rose-600 border-rose-200",
};
const STATUS_LABEL: Record<Status, string> = {
  active: "Đang chạy thật", draft: "Bản nháp", archived: "Đã lưu trữ", rejected: "Đã hủy",
};

/** Diff đơn giản theo dòng (rule text mỗi dòng đặc trưng nên đủ để thấy "AI đổi gì"). */
function lineDiff(oldText: string, newText: string): { added: string[]; removed: string[] } {
  const norm = (t: string) => t.split("\n").map((s) => s.trim()).filter(Boolean);
  const o = new Set(norm(oldText));
  const n = new Set(norm(newText));
  return {
    removed: [...o].filter((l) => !n.has(l)),
    added: [...n].filter((l) => !o.has(l)),
  };
}

// Dấu hiệu kỹ thuật bắt buộc — PHẢI khớp BRAIN_MARKERS ở backend (sale-brain-lab.ts).
// Bản nháp đánh mất marker đang có trong bản chạy thật → khoá nút Áp dụng (backend cũng chặn lại).
const BRAIN_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /<<\s*SAMPLE/i, label: "<<SAMPLE>>" },
  { re: /<<\s*PRICE_IMAGE/i, label: "<<PRICE_IMAGE>>" },
  { re: /<<\s*NAME/i, label: "<<NAME>>" },
  { re: /<<\s*NEEDS_HUMAN/i, label: "<<NEEDS_HUMAN>>" },
];
/** Marker CÓ trong `reference` (bản chạy thật) mà THIẾU trong `candidate` (đang sửa). */
function missingMarkers(candidate: string, reference: string): string[] {
  return BRAIN_MARKERS.filter(({ re }) => re.test(reference) && !re.test(candidate)).map(({ label }) => label);
}

function StatusBadge({ status }: { status: Status }) {
  return <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_BADGE[status]}`}>{STATUS_LABEL[status]}</span>;
}

// ─── Render 1 cột kết quả test ─────────────────────────────────────────────────
function ReplyColumn({ title, accent, result }: { title: string; accent: string; result: SimResult | null }) {
  return (
    <div className="flex-1 min-w-0 border rounded-xl overflow-hidden bg-white">
      <div className={`px-3 py-2 text-sm font-semibold text-white ${accent}`}>{title}</div>
      <div className="p-3 space-y-2 text-sm">
        {!result ? (
          <p className="text-gray-400 italic">Chưa có kết quả.</p>
        ) : (
          <>
            {result.sampleImages.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {result.sampleImages.map((s, i) => (
                  <div key={i} className="w-24">
                    <img src={getImageSrc(s.imageUrl) ?? undefined} alt={s.title} onError={onBrokenSampleImg} className="w-24 h-24 object-cover rounded-lg border" />
                    <p className="text-[10px] text-gray-500 truncate mt-0.5">{s.title}</p>
                  </div>
                ))}
              </div>
            )}
            {result.priceImages.map((p, i) => (
              <img key={`p${i}`} src={getImageSrc(p) ?? undefined} alt="bảng giá" className="max-w-[180px] rounded-lg border" />
            ))}
            {result.reply.map((m, i) => (
              <div key={i} className="bg-gray-50 border rounded-lg px-3 py-2 whitespace-pre-wrap break-words">{m}</div>
            ))}
            {result.sampleNote && <p className="text-[11px] text-amber-600 italic">{result.sampleNote}</p>}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500 pt-1 border-t">
              {result.detectedIntent && <span>intent: <b className="text-violet-600">{result.detectedIntent}</b></span>}
              <span>{result.responseTimeMs}ms</span>
              {result.escalated && <span className="text-rose-600 font-medium">⚠ Sẽ chuyển người thật ({result.escalationReason})</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── KHO ẢNH: modal chọn ảnh đúng (tìm/lọc theo dịch vụ, tone, tên bộ, tag) ───
function ImageStoreModal({ open, onClose, onPick, maxSelect = 4, initialIntent, initialTone }: {
  open: boolean; onClose: () => void; onPick: (imgs: OverrideImage[]) => void;
  maxSelect?: number; initialIntent?: string | null; initialTone?: string | null;
}) {
  const [intent, setIntent] = useState(initialIntent ?? "");
  const [tone, setTone] = useState(initialTone ?? "");
  const [album, setAlbum] = useState("");
  const [tag, setTag] = useState("");
  const [q, setQ] = useState("");
  const [kindKey, setKindKey] = useState(""); // tab nguồn ("" = tất cả)
  const [items, setItems] = useState<StoreItem[]>([]);
  const [total, setTotal] = useState(0);
  const [debug, setDebug] = useState<StoreDebug | null>(null);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState<Record<string, OverrideImage>>({});
  const [drill, setDrill] = useState<{ id: number; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (drill) p.set("albumId", String(drill.id));
      else {
        if (intent) p.set("intent", intent);
        if (tone.trim()) p.set("tone", tone.trim());
        if (album.trim()) p.set("album", album.trim());
        if (tag.trim()) p.set("tag", tag.trim());
        if (q.trim()) p.set("q", q.trim());
        if (kindKey) p.set("kinds", kindKey);
      }
      const d = await apiGet<{ items: StoreItem[]; total: number; debug?: StoreDebug }>(`/lulu-brain/image-store?${p.toString()}`);
      setItems(d.items); setTotal(d.total); setDebug(d.debug ?? null);
    } catch (e) {
      setItems([]); setTotal(0);
      setDebug({ reason: "api_error", message: `API lỗi: ${String((e as Error).message).slice(0, 160)}` });
    } finally { setLoading(false); }
  }, [intent, tone, album, tag, q, kindKey, drill]);

  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => { if (open) { setSel({}); setDrill(null); } }, [open]);

  if (!open) return null;
  const selList = Object.values(sel);
  const toggle = (it: StoreItem) => {
    setSel((prev) => {
      const next = { ...prev };
      if (next[it.imageUrl]) { delete next[it.imageUrl]; return next; }
      if (Object.keys(next).length >= maxSelect) return prev;
      next[it.imageUrl] = { imageUrl: it.imageUrl, title: it.title, detailUrl: it.detailUrl, sourceType: it.sourceType, serviceIntent: it.serviceIntent || undefined };
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2"><Images className="w-4 h-4 text-violet-600" /> Kho ảnh — chọn ảnh đúng để dạy Lulu</h3>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>

        {/* Bộ lọc */}
        <div className="px-4 py-2.5 border-b space-y-2">
          {drill ? (
            <div className="flex items-center gap-2 text-sm">
              <button onClick={() => setDrill(null)} className="flex items-center gap-1 text-violet-600 border border-violet-200 px-2 py-1 rounded-lg hover:bg-violet-50 text-xs"><RotateCcw className="w-3.5 h-3.5" /> Quay lại kho</button>
              <span className="text-gray-600">Ảnh trong bộ: <b>{drill.name}</b></span>
            </div>
          ) : (
            <>
              {/* Tab nguồn ảnh */}
              <div className="flex flex-wrap gap-1.5">
                {SOURCE_TABS.map((t) => (
                  <button key={t.key} onClick={() => setKindKey(t.key)}
                    className={`text-xs px-2.5 py-1 rounded-lg border ${kindKey === t.key ? "bg-violet-600 text-white border-violet-600" : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"}`}>{t.label}</button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <select value={intent} onChange={(e) => setIntent(e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm">
                  <option value="">Mọi dịch vụ</option>
                  {INTENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input value={album} onChange={(e) => setAlbum(e.target.value)} placeholder="Tên bộ ảnh" className="border rounded-lg px-2 py-1.5 text-sm w-32" />
                <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag ảnh" className="border rounded-lg px-2 py-1.5 text-sm w-28" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Từ khóa…" className="border rounded-lg px-2 py-1.5 text-sm w-32" />
                <input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Tone / gu" className="border rounded-lg px-2 py-1.5 text-sm w-28" />
                <button onClick={() => load()} className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-violet-700"><Search className="w-4 h-4" /> Lọc</button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {TONE_CHIPS.map((t) => (
                  <button key={t} onClick={() => { setTone(t); }} className={`text-[11px] px-2 py-0.5 rounded-full border ${tone === t ? "bg-violet-100 border-violet-300 text-violet-700" : "bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100"}`}>{t}</button>
                ))}
                {tone && <button onClick={() => setTone("")} className="text-[11px] text-gray-400 hover:text-rose-500 px-1">× bỏ tone</button>}
              </div>
            </>
          )}
        </div>

        {/* Lưới ảnh */}
        <div className="flex-1 overflow-auto p-3">
          {/* Nới tone: chưa có ảnh đúng tone → hiện ảnh cùng dịch vụ */}
          {!loading && items.length > 0 && debug?.toneRelaxed && (
            <div className="mb-2 text-[11px] bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> Chưa có ảnh đúng tone “{tone}”, đang hiển thị ảnh cùng dịch vụ.
              {tone && <button onClick={() => setTone("")} className="underline hover:text-amber-900">Bỏ tone</button>}
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-400 text-sm gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Đang tải kho ảnh…</div>
          ) : items.length === 0 ? (
            <div className="text-center py-10 space-y-2">
              <p className="text-gray-500 text-sm font-medium">{debug?.message || "Không có ảnh khớp bộ lọc. Thử bỏ bớt điều kiện."}</p>
              {debug && (
                <div className="text-[11px] text-gray-400 space-y-0.5">
                  <p>Lý do: <code className="bg-gray-100 px-1 rounded">{debug.reason}</code></p>
                  {debug.sourceCounts && <p>Nguồn DB: bộ ảnh {debug.sourceCounts.album ?? 0} · đồ thuê {debug.sourceCounts.rental ?? 0} · ý tưởng {debug.sourceCounts.idea ?? 0} · bảng giá {debug.sourceCounts.price ?? 0}</p>}
                  {typeof debug.missingUrlCount === "number" && debug.missingUrlCount > 0 && <p>{debug.missingUrlCount} mục thiếu URL ảnh.</p>}
                  {debug.errors && debug.errors.length > 0 && <p className="text-rose-500">Lỗi: {debug.errors.join("; ")}</p>}
                  {(tone || intent || album || tag || q) && <p className="text-violet-500">Mẹo: bấm “Tất cả”, bỏ tone, hoặc xoá bớt từ khóa để xem nhiều ảnh hơn.</p>}
                </div>
              )}
            </div>
          ) : (
            <>
              <p className="text-[11px] text-gray-400 mb-2">{total} ảnh khớp{total > items.length ? ` (hiện ${items.length})` : ""}. Bấm để chọn (tối đa {maxSelect}).</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                {items.map((it, i) => {
                  const picked = !!sel[it.imageUrl];
                  return (
                    <div key={`${it.imageUrl}-${i}`} className={`relative border rounded-lg overflow-hidden cursor-pointer group ${picked ? "ring-2 ring-violet-500" : "hover:border-violet-300"}`} onClick={() => toggle(it)}>
                      <img src={getImageSrc(it.imageUrl) ?? undefined} alt={it.title} className="w-full h-24 object-cover" />
                      {picked && <div className="absolute top-1 right-1 bg-violet-600 text-white rounded-full w-5 h-5 flex items-center justify-center"><Check className="w-3 h-3" /></div>}
                      {it.kind === "price" && <span className="absolute top-1 left-1 bg-amber-500 text-white text-[8px] px-1 py-0.5 rounded">Bảng giá</span>}
                      {it.kind === "price" && it.publicForCustomer === false && <span className="absolute bottom-7 left-1 bg-rose-500 text-white text-[8px] px-1 py-0.5 rounded">ẩn với khách</span>}
                      <div className="p-1">
                        <p className="text-[10px] text-gray-600 truncate" title={it.title}>{it.title}</p>
                        {it.serviceIntent && <p className="text-[9px] text-violet-500 truncate">{it.serviceIntent}</p>}
                      </div>
                      {!drill && it.albumId && it.sourceType === "gallery" && (
                        <button onClick={(e) => { e.stopPropagation(); setDrill({ id: it.albumId!, name: it.albumName || it.title }); }}
                          className="absolute bottom-1 right-1 bg-white/90 border text-[9px] px-1 py-0.5 rounded opacity-0 group-hover:opacity-100">xem bộ</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Chọn */}
        <div className="px-4 py-3 border-t flex items-center justify-between gap-2">
          <span className="text-sm text-gray-500">Đã chọn <b className="text-violet-600">{selList.length}</b>/{maxSelect}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm border px-3 py-1.5 rounded-lg hover:bg-gray-50">Hủy</button>
            <button disabled={selList.length === 0} onClick={() => onPick(selList)} className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-violet-700 disabled:opacity-50">
              <Check className="w-4 h-4" /> Dùng {selList.length || ""} ảnh này
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Panel "Báo lỗi / Sửa phản hồi này": sửa cả TEXT lẫn ẢNH cho 1 câu Lulu ───
function FixResponsePanel({ turn, onDraftChange, onPreview, markFixed, onClose, showOk, showErr }: {
  turn: Extract<TestTurn, { role: "lulu" }>;
  onDraftChange: (v: BrainVersion) => void;
  /** Sau khi lưu → chèn 1 lượt "Xem trước": gửi lại đúng câu khách (vào bản nháp draftId) để hiện ảnh + lời THẬT. */
  onPreview: (question: string, draftId: number) => void;
  markFixed: () => void; onClose: () => void;
  showOk: (m: string) => void; showErr: (m: string) => void;
}) {
  const sent = turn.result.sampleImages;
  const replyText = turn.result.reply.join("\n\n");
  const [correct, setCorrect] = useState<OverrideImage[]>(
    () => sent.map((s) => ({ imageUrl: s.imageUrl, title: s.title, detailUrl: s.detailUrl, sourceType: s.sourceType, serviceIntent: s.serviceIntent })),
  );
  const [keptFlags, setKeptFlags] = useState<Record<string, boolean>>({});
  const [intent, setIntent] = useState(turn.result.detectedIntent ?? "");
  const [tone, setTone] = useState("");
  const [editedText, setEditedText] = useState(replyText);
  // Cách Lulu dùng câu sửa tay: exact_reply (nói y chang) | learn_from_this (AI học theo). Mặc định
  // "exact_reply" — khi admin có sửa text thì ưu tiên nói đúng câu admin gõ.
  const [responseMode, setResponseMode] = useState<"exact_reply" | "learn_from_this">("exact_reply");
  // admin đã bấm chọn 1 chế độ chưa (để ghim cả khi không sửa text — vd muốn ghim đúng câu Lulu đang nói).
  const [modeTouched, setModeTouched] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [savingImg, setSavingImg] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  const [replaceIdx, setReplaceIdx] = useState<number | null>(null);

  const removeAt = (i: number) => setCorrect((p) => p.filter((_, j) => j !== i));
  const openReplace = (i: number) => { setReplaceIdx(i); setStoreOpen(true); };
  const openAdd = () => { setReplaceIdx(null); setStoreOpen(true); };
  const onPick = (imgs: OverrideImage[]) => {
    setCorrect((prev) => {
      let next = [...prev];
      if (replaceIdx != null && replaceIdx < next.length) {
        next[replaceIdx] = imgs[0];
        for (let k = 1; k < imgs.length; k++) if (next.length < 4 && !next.some((x) => x.imageUrl === imgs[k].imageUrl)) next.push(imgs[k]);
      } else {
        for (const im of imgs) if (next.length < 4 && !next.some((x) => x.imageUrl === im.imageUrl)) next.push(im);
      }
      return next.slice(0, 4);
    });
    setStoreOpen(false); setReplaceIdx(null);
  };

  const saveImages = async () => {
    // GHIM TEXT khi: có text + (đã sửa khác câu gốc HOẶC admin đã bấm chọn 1 chế độ để ghim câu hiện tại).
    const txt = editedText.trim();
    const wantPin = !!txt && (txt !== replyText || modeTouched);
    const pinnedText = wantPin ? txt : null;
    if (correct.length === 0 && !pinnedText) { showErr("Chọn ít nhất 1 ảnh đúng, hoặc sửa lời Lulu bằng tay rồi chọn cách Lulu dùng câu đó."); return; }
    setSavingImg(true);
    try {
      const d = await apiSend<{ draft: BrainVersion; totalOverrides: number }>("POST", "/lulu-brain/image-feedback", {
        customerQuestion: turn.forText,
        intent: intent || null,
        tone: tone.trim() || null,
        wrongImages: sent.map((s) => s.imageUrl),
        correctImages: correct,
        editedText: pinnedText,
        responseMode: pinnedText ? responseMode : null,
      });
      onDraftChange(d.draft); markFixed();
      const modeLabel = pinnedText ? (responseMode === "exact_reply" ? " · Lulu sẽ nói y chang câu này" : " · AI sẽ học theo câu này") : "";
      showOk(`Đã dạy vào Version ${d.draft.versionNumber} — nháp${modeLabel}.`);
      onClose();
      onPreview(turn.forText, d.draft.id); // tự gửi lại đúng câu khách (vào nháp vừa lưu) để XEM TRƯỚC kết quả THẬT
    } catch (e) { showErr(String((e as Error).message)); } finally { setSavingImg(false); }
  };

  const saveAiRule = async () => {
    const want = aiInstruction.trim();
    if (!want) { showErr("Nhập yêu cầu sửa luật bằng lời cho AI."); return; }
    setSavingAi(true);
    const instruction = [
      `Tình huống test: khách nhắn: "${turn.forText}".`,
      `Lulu trả lời (đang bị xem là CHƯA ĐÚNG): "${turn.result.reply.join(" / ") || turn.result.raw}".`,
      `YÊU CẦU SỬA: ${want}`,
      `Hãy sửa bộ luật để lần sau Lulu xử lý ĐÚNG tình huống này và các tình huống tương tự.`,
    ].join("\n");
    try {
      const d = await apiSend<{ draft: BrainVersion }>("POST", "/lulu-brain/ai-draft", { instruction });
      onDraftChange(d.draft); markFixed();
      showOk(`Đã gửi sửa luật vào Version ${d.draft.versionNumber} (nháp). Gửi lại câu khách để test.`);
    } catch (e) { showErr(String((e as Error).message)); } finally { setSavingAi(false); }
  };

  return (
    <div className="border border-violet-200 rounded-lg p-3 bg-violet-50/50 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-violet-700 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Sửa phản hồi này (text &amp; ảnh) — lưu vào bản nháp</p>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
      </div>

      {/* Ảnh Lulu đã gửi */}
      <div>
        <p className="text-[11px] font-semibold text-gray-500 mb-1">ẢNH LULU ĐÃ GỬI {sent.length === 0 && <span className="font-normal text-gray-400">(không gửi ảnh nào)</span>}</p>
        {sent.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {sent.map((s, i) => {
              const stillIn = correct.some((c) => c.imageUrl === s.imageUrl);
              const kept = keptFlags[s.imageUrl];
              return (
                <div key={i} className={`w-28 border rounded-lg overflow-hidden bg-white ${!stillIn ? "opacity-40" : kept ? "ring-2 ring-emerald-400" : ""}`}>
                  <img src={getImageSrc(s.imageUrl) ?? undefined} alt={s.title} onError={onBrokenSampleImg} className="w-full h-20 object-cover" />
                  <p className="text-[10px] text-gray-500 truncate px-1 pt-0.5">{s.title}</p>
                  <div className="flex text-[10px] border-t divide-x">
                    <button onClick={() => { setKeptFlags((p) => ({ ...p, [s.imageUrl]: true })); if (!stillIn) setCorrect((p) => [...p, { imageUrl: s.imageUrl, title: s.title, detailUrl: s.detailUrl, sourceType: s.sourceType, serviceIntent: s.serviceIntent }].slice(0, 4)); }}
                      className="flex-1 py-1 text-emerald-600 hover:bg-emerald-50" title="Giữ ảnh này">Giữ</button>
                    <button onClick={() => { const idx = correct.findIndex((c) => c.imageUrl === s.imageUrl); if (idx >= 0) removeAt(idx); setKeptFlags((p) => ({ ...p, [s.imageUrl]: false })); }}
                      className="flex-1 py-1 text-rose-600 hover:bg-rose-50" title="Bỏ ảnh này">Bỏ</button>
                    <button onClick={() => { const idx = correct.findIndex((c) => c.imageUrl === s.imageUrl); openReplace(idx >= 0 ? idx : 0); }}
                      className="flex-1 py-1 text-violet-600 hover:bg-violet-50" title="Đổi ảnh khác">Đổi</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Ảnh đúng sẽ dạy */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-[11px] font-semibold text-gray-500">ẢNH ĐÚNG SẼ DẠY LULU ({correct.length}/4)</p>
          <button onClick={openAdd} className="flex items-center gap-1 text-[11px] text-violet-600 border border-violet-200 px-2 py-0.5 rounded-lg hover:bg-violet-50"><Plus className="w-3 h-3" /> Thêm ảnh đúng từ kho</button>
        </div>
        {correct.length === 0 ? (
          <p className="text-[11px] text-gray-400 italic">Chưa chọn ảnh đúng. Bấm “Thêm ảnh đúng từ kho”.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {correct.map((c, i) => (
              <div key={`${c.imageUrl}-${i}`} className="w-24 relative border-2 border-emerald-300 rounded-lg overflow-hidden bg-white">
                <img src={getImageSrc(c.imageUrl) ?? undefined} alt={c.title} onError={onBrokenSampleImg} className="w-full h-20 object-cover" />
                <button onClick={() => removeAt(i)} className="absolute top-0.5 right-0.5 bg-rose-500 text-white rounded-full w-4 h-4 flex items-center justify-center"><X className="w-2.5 h-2.5" /></button>
                <button onClick={() => openReplace(i)} className="absolute bottom-0.5 right-0.5 bg-white/90 border rounded p-0.5" title="Đổi ảnh khác"><Repeat className="w-3 h-3 text-violet-600" /></button>
                <p className="text-[9px] text-gray-500 truncate px-1">{c.title}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tình huống: intent + tone */}
      <div className="grid sm:grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-gray-500">Dịch vụ / nhu cầu</label>
          <select value={intent} onChange={(e) => setIntent(e.target.value)} className="w-full border rounded-lg px-2 py-1.5 text-sm">
            <option value="">(tự suy từ câu khách)</option>
            {INTENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[11px] text-gray-500">Tone / gu (để trống = mọi tone)</label>
          <input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="vd: nhẹ nhàng" className="w-full border rounded-lg px-2 py-1.5 text-sm" />
          <div className="flex flex-wrap gap-1 mt-1">
            {TONE_CHIPS.slice(0, 6).map((t) => <button key={t} onClick={() => setTone(t)} className={`text-[10px] px-1.5 py-0.5 rounded-full border ${tone === t ? "bg-violet-100 border-violet-300 text-violet-700" : "bg-white border-gray-200 text-gray-500"}`}>{t}</button>)}
          </div>
        </div>
      </div>

      {/* Sửa lời Lulu bằng tay + CÁCH LULU DÙNG CÂU NÀY */}
      <div className="space-y-1.5">
        <label className="text-[11px] text-gray-500">✍️ Sửa lời Lulu bằng tay (tùy chọn) — gõ đúng câu bạn muốn Lulu nói cho tình huống này.</label>
        <textarea value={editedText} onChange={(e) => setEditedText(e.target.value)} rows={2} className="w-full border rounded-lg px-2 py-1.5 text-sm" />
        {/* CÁCH LULU DÙNG CÂU NÀY — luôn hiện để admin chọn (không ẩn theo điều kiện). */}
        <div className="bg-white border rounded-lg p-2">
          <p className="text-[11px] font-semibold text-gray-600 mb-1">Cách Lulu dùng câu này</p>
          <div className="flex flex-col sm:flex-row gap-1.5">
            <button type="button" onClick={() => { setResponseMode("exact_reply"); setModeTouched(true); }}
              className={`flex-1 text-left text-[11px] px-2 py-1.5 rounded-lg border ${responseMode === "exact_reply" ? "bg-emerald-50 border-emerald-300 text-emerald-700 ring-1 ring-emerald-300" : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
              <span className="font-semibold">🔒 Tao muốn mày nói y chang câu này</span><br />Lulu nói ĐÚNG nguyên văn câu trên, không cho AI viết lại.
            </button>
            <button type="button" onClick={() => { setResponseMode("learn_from_this"); setModeTouched(true); }}
              className={`flex-1 text-left text-[11px] px-2 py-1.5 rounded-lg border ${responseMode === "learn_from_this" ? "bg-sky-50 border-sky-300 text-sky-700 ring-1 ring-sky-300" : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
              <span className="font-semibold">✨ Tao muốn mày học theo</span><br />AI viết lại tự nhiên nhưng giữ đúng ý chính câu trên.
            </button>
          </div>
          <p className="text-[10px] text-gray-400 mt-1">Áp dụng khi bạn có sửa lời Lulu ở trên — hoặc bấm chọn 1 chế độ để ghim đúng câu Lulu đang nói.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button disabled={savingImg} onClick={saveImages} className="flex items-center gap-1.5 bg-emerald-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-emerald-700 disabled:opacity-50">
          {savingImg ? <Loader2 className="w-4 h-4 animate-spin" /> : <Images className="w-4 h-4" />} Lưu &amp; xem trước
        </button>
        <span className="text-[11px] text-gray-400 self-center">Lưu xong → tự gửi lại câu khách, hiện “Xem trước” ảnh + lời Lulu ngay dưới.</span>
      </div>

      {/* Sửa LUẬT bằng lời (đường AI cũ) */}
      <div className="border-t pt-2 space-y-1.5">
        <p className="text-[11px] text-gray-500">Hoặc sửa LUẬT bằng lời (AI viết lại bộ luật — dùng khi lỗi không chỉ là ảnh):</p>
        <textarea value={aiInstruction} onChange={(e) => setAiInstruction(e.target.value)} rows={2}
          placeholder="Vd: Khách hỏi chụp bầu mà gửi ảnh cưới — phải gửi nhóm ảnh bầu và hỏi tháng thai."
          className="w-full border rounded-lg px-2 py-1.5 text-sm" />
        <div className="flex gap-2">
          <button disabled={savingAi} onClick={saveAiRule} className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-violet-700 disabled:opacity-50">
            {savingAi ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Gửi cho AI sửa luật
          </button>
          <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-lg border hover:bg-gray-50">Thôi</button>
        </div>
      </div>

      <ImageStoreModal open={storeOpen} onClose={() => { setStoreOpen(false); setReplaceIdx(null); }} onPick={onPick}
        maxSelect={4} initialIntent={intent || turn.result.detectedIntent || ""} initialTone={tone} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
export default function LuluBrainLabPage() {
  const { effectiveIsAdmin } = useStaffAuth();
  const [tab, setTab] = useState<Tab>("fixtest"); // mặc định mở tab làm việc chính "Sửa & Test Lulu"
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const [active, setActive] = useState<BrainVersion | null>(null);
  const [defaultRules, setDefaultRules] = useState("");
  const [versions, setVersions] = useState<BrainVersion[]>([]);
  const [draft, setDraft] = useState<BrainVersion | null>(null);
  const [changeRequests, setChangeRequests] = useState<ChangeRequest[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [busy, setBusy] = useState(false);
  // Hàng đợi sửa lỗi (state FE) — khôi phục từ localStorage để GIỮ QUA REFRESH (bỏ ảnh base64 cho nhẹ).
  const [fixQueue, setFixQueue] = useState<QueueCard[]>(() => {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as QueueCard[];
      // Card đang xử lý dở lúc refresh → coi như lỗi để chạy lại / bỏ qua.
      return arr.map((c) => (c.status === "analyzing" || c.status === "applying")
        ? { ...c, status: "error" as QueueStatus, error: "Phiên trước bị gián đoạn — bấm Chạy lại / Bỏ qua." } : c);
    } catch { return []; }
  });
  const [newDraftPrompt, setNewDraftPrompt] = useState(false);
  const [testPrefill, setTestPrefill] = useState("");                                  // #2: prefill ô test khi "Test lại câu vừa sửa"
  const [lastApplied, setLastApplied] = useState<{ newVer: number; prevId: number; prevVer: number } | null>(null); // #5: rollback 1 chạm

  // ── Lịch sử CHAT TEST — lift lên parent để GIỮ khi đổi tab; localStorage để GIỮ khi refresh ──
  // Chỉ reset khi: tạo bản nháp MỚI hoặc admin bấm "Xóa hội thoại". KHÔNG reset khi đổi tab / AI sửa rule.
  const [chatTurns, setChatTurns] = useState<TestTurn[]>(() => restoreTestChat().turns);
  const [chatConvo, setChatConvo] = useState<ConvoMsg[]>(() => restoreTestChat().convo);
  const [chatOwnerId, setChatOwnerId] = useState<number | null>(() => restoreTestChat().ownerDraftId); // bản nháp mà hội thoại đang thuộc về (null = đang test bản chạy thật)
  const [draftLoaded, setDraftLoaded] = useState(false);                               // đã lấy xong bản nháp thật từ server chưa
  const chatReconciled = useRef(false);                                                // đã đối chiếu hội thoại đã lưu với bản nháp thật chưa

  const showOk = (msg: string) => { setFlash({ kind: "ok", msg }); setTimeout(() => setFlash(null), 4000); };
  const showErr = (msg: string) => { setFlash({ kind: "err", msg }); setTimeout(() => setFlash(null), 6000); };

  const loadActive = useCallback(async () => {
    try {
      const d = await apiGet<{ active: BrainVersion | null; defaultRules: string }>("/lulu-brain/active");
      setActive(d.active); setDefaultRules(d.defaultRules);
    } catch (e) { showErr(String((e as Error).message)); }
  }, []);
  const loadVersions = useCallback(async () => {
    try { const d = await apiGet<{ versions: BrainVersion[] }>("/lulu-brain/versions"); setVersions(d.versions); }
    catch (e) { showErr(String((e as Error).message)); }
  }, []);
  const loadChangeRequests = useCallback(async () => {
    try { const d = await apiGet<{ items: ChangeRequest[] }>("/lulu-brain/change-requests"); setChangeRequests(d.items); }
    catch { /* không chặn */ }
  }, []);
  const loadTestCases = useCallback(async () => {
    try { const d = await apiGet<{ cases: TestCase[] }>("/lulu-brain/test-cases"); setTestCases(d.cases); }
    catch { /* không chặn */ }
  }, []);
  // Bản nháp đang mở = nguồn chân lý từ server (một bản nháp duy nhất). DRAFT_KEY chỉ là gợi ý phụ.
  const loadDraft = useCallback(async () => {
    try {
      const d = await apiGet<{ draft: BrainVersion | null }>("/lulu-brain/draft");
      if (d.draft) { setDraft(d.draft); localStorage.setItem(DRAFT_KEY, String(d.draft.id)); }
      else { setDraft(null); localStorage.removeItem(DRAFT_KEY); }
    } catch { /* không chặn */ }
    finally { setDraftLoaded(true); }
  }, []);

  useEffect(() => {
    loadActive(); loadVersions(); loadChangeRequests(); loadTestCases(); loadDraft();
    // Deep-link ?tab= (gồm cả key cũ ai/draft/test → gộp về "fixtest").
    try {
      const t = new URLSearchParams(window.location.search).get("tab");
      if (t && LEGACY_TAB_MAP[t]) setTab(LEGACY_TAB_MAP[t]);
    } catch { /* ignore */ }
  }, [loadActive, loadVersions, loadChangeRequests, loadTestCases, loadDraft]);

  // Lưu hàng đợi sửa lỗi vào localStorage (bỏ base64 ảnh cho nhẹ; chỉ giữ số lượng ảnh).
  useEffect(() => {
    try {
      const light = fixQueue.map((c) => ({ ...c, images: [], imgCount: c.imgCount ?? c.images.length }));
      localStorage.setItem(QUEUE_KEY, JSON.stringify(light));
    } catch { /* quota — bỏ qua */ }
  }, [fixQueue]);

  // Lưu lịch sử chat test (bỏ ảnh dataURL khách đính cho nhẹ; giữ text + URL ảnh server).
  useEffect(() => {
    try {
      const lightTurns = chatTurns.map((t) => (t.role === "customer" && t.imageUrl ? { ...t, imageUrl: undefined } : t));
      localStorage.setItem(CHAT_KEY, JSON.stringify({ ownerDraftId: chatOwnerId, turns: lightTurns, convo: chatConvo }));
    } catch { /* quota — bỏ qua */ }
  }, [chatTurns, chatConvo, chatOwnerId]);

  // Sau khi biết bản nháp thật từ server: nếu hội thoại đã lưu thuộc bản nháp KHÁC (hoặc nháp đã biến mất)
  // → bắt đầu hội thoại mới cho bản nháp hiện tại. Khớp owner → GIỮ nguyên chat (yêu cầu: giữ qua refresh).
  useEffect(() => {
    if (!draftLoaded || chatReconciled.current) return;
    chatReconciled.current = true;
    const currentId = draft?.id ?? null;
    if (chatOwnerId !== currentId) { setChatTurns([]); setChatConvo([]); setChatOwnerId(currentId); }
  }, [draftLoaded, draft, chatOwnerId]);

  const setCurrentDraft = (v: BrainVersion) => {
    setDraft(v);
    localStorage.setItem(DRAFT_KEY, String(v.id));
  };
  // Bắt đầu hội thoại test MỚI (gắn về bản nháp ownerId). Dùng khi tạo bản nháp mới / bấm "Xóa hội thoại".
  const resetTestChat = (ownerId: number | null) => { setChatTurns([]); setChatConvo([]); setChatOwnerId(ownerId); };
  // Cập nhật / xoá bản nháp đang mở (dùng chung cho tab Sửa & Test).
  // LƯU Ý: đây là đường "tiếp tục sửa CÙNG bản nháp" (AI sửa rule / lưu / áp dụng / hủy) → GIỮ NGUYÊN chat test,
  // chỉ gắn lại owner. Hội thoại mới chỉ bắt đầu khi tạo bản nháp MỚI (createNewDraft / draftFromVersion).
  const onDraftChange = (v: BrainVersion | null) => {
    if (v) { setCurrentDraft(v); setChatOwnerId(v.id); }
    else { setDraft(null); localStorage.removeItem(DRAFT_KEY); setChatOwnerId(null); }
  };

  // ── Tạo bản nháp từ version ──
  const draftFromVersion = async (vid: number) => {
    setBusy(true);
    try {
      const d = await apiSend<{ draft: BrainVersion; reusedExisting?: boolean }>("POST", `/lulu-brain/versions/${vid}/draft-from`, {});
      setCurrentDraft(d.draft);
      if (d.reusedExisting) setChatOwnerId(d.draft.id); else resetTestChat(d.draft.id); // nháp đang mở → giữ chat; nháp mới → hội thoại mới
      setTab("fixtest"); showOk("Đã có bản nháp. Chat test rồi báo lỗi để AI sửa nha.");
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  // ── "+ Tạo bản nháp mới" ──
  // - Chưa có nháp → tạo ngay từ bản đang chạy.
  // - Đã có nháp + chưa force → hỏi confirm (tiếp tục sửa / tạo mới).
  // - force=true → tạo bản nháp MỚI từ bản đang chạy (hủy nháp cũ → rejected, giữ lịch sử).
  const createNewDraft = async (force = false) => {
    if (!active) { showErr("Chưa có bản đang chạy để tạo nháp."); return; }
    if (draft && !force) { setNewDraftPrompt(true); return; }
    setBusy(true);
    try {
      const d = await apiSend<{ draft: BrainVersion; reusedExisting?: boolean }>(
        "POST", `/lulu-brain/versions/${active.id}/draft-from`, force ? { force: true } : {});
      setCurrentDraft(d.draft);
      if (d.reusedExisting) setChatOwnerId(d.draft.id); else resetTestChat(d.draft.id); // bản nháp MỚI → bắt đầu hội thoại test mới
      showOk(d.reusedExisting
        ? `Đang sửa Version ${d.draft.versionNumber} — Bản nháp.`
        : `Đã tạo Version ${d.draft.versionNumber} — Bản nháp từ Version ${active.versionNumber}.`);
      loadVersions();
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); setNewDraftPrompt(false); }
  };

  // #5 — Rollback 1 chạm: quay lại version cũ ngay sau khi áp dụng (dùng endpoint rollback có sẵn).
  const quickRollback = async (sourceId: number, sourceVer: number) => {
    if (!confirm(`Quay lại Version ${sourceVer} làm bản chạy thật?\n\nHệ thống tạo version mới từ nội dung Version ${sourceVer}; Fanpage quay lại đúng nội dung đó. Không xóa lịch sử.`)) return;
    setBusy(true);
    try {
      await apiSend("POST", `/lulu-brain/versions/${sourceId}/rollback`, { note: "Quay lại nhanh sau khi áp dụng" });
      showOk(`Đã quay lại Version ${sourceVer}.`); setLastApplied(null); loadActive(); loadVersions(); resetTestChat(null);
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  const TABS: { key: Tab; label: string; icon: typeof Brain }[] = [
    { key: "fixtest", label: "Sửa & Test Lulu", icon: FlaskConical }, // ưu tiên tab làm việc chính lên đầu
    { key: "aifix", label: "Nhờ AI sửa Lulu", icon: Sparkles },
    { key: "active", label: "Não đang dùng", icon: Brain },           // xem não đang chạy — để kế cuối
    { key: "history", label: "Version History", icon: History },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Brain className="w-6 h-6 text-violet-600" /> Lulu Brain Lab</h1>
          <p className="text-sm text-gray-500 mt-1">Quản lý, chỉnh, test &amp; lưu version cho não Sale AI Lulu. AI chỉ tạo bản nháp — chỉ admin mới áp dụng vào bản chạy thật.</p>
        </div>
        {!effectiveIsAdmin && (
          <span className="text-[11px] bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-1 rounded-full">
            Chế độ nhân viên: báo lỗi / góp ý / tạo &amp; test bản nháp. Áp dụng cần admin.
          </span>
        )}
      </div>

      {/* Flash */}
      {flash && (
        <div className={`text-sm px-3 py-2 rounded-lg border ${flash.kind === "ok" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}>
          {flash.msg}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === t.key ? "border-violet-600 text-violet-700" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
            <t.icon className="w-4 h-4" />{t.label}
            {(t.key === "fixtest" || t.key === "aifix") && draft && <span className="ml-1 w-2 h-2 rounded-full bg-amber-500" />}
          </button>
        ))}
      </div>

      {/* Thanh trạng thái version + nút tạo bản nháp mới (hiện ở mọi tab) */}
      <div className="flex items-center justify-between gap-3 flex-wrap bg-white border rounded-xl px-3 py-2">
        <div className="text-sm flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span className="text-gray-500">Bản nháp đang sửa:</span>
          {draft
            ? <span className="font-semibold text-amber-700 flex items-center gap-1"><Pencil className="w-3.5 h-3.5" /> Version {draft.versionNumber} — Bản nháp</span>
            : <span className="text-gray-400">Chưa có — bấm “+ Tạo bản nháp mới” để bắt đầu.</span>}
          {active && <span className="text-gray-400">· Đang chạy thật: <b className="text-emerald-700">Version {active.versionNumber}</b></span>}
        </div>
        <button disabled={busy} onClick={() => createNewDraft(false)}
          className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-violet-700 disabled:opacity-50">
          <Plus className="w-4 h-4" /> Tạo bản nháp mới
        </button>
      </div>

      {/* Confirm khi đã có bản nháp mà bấm tạo mới */}
      {newDraftPrompt && draft && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-3 space-y-2">
          <p className="text-sm text-amber-800">Đang có <b>Version {draft.versionNumber} — Bản nháp</b>. Bạn muốn tiếp tục sửa hay tạo bản nháp mới từ bản đang chạy{active ? ` (Version ${active.versionNumber})` : ""}?</p>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setNewDraftPrompt(false)} className="text-sm border px-3 py-1.5 rounded-lg hover:bg-white">Tiếp tục sửa Version {draft.versionNumber}</button>
            <button disabled={busy} onClick={() => createNewDraft(true)} className="text-sm bg-violet-600 text-white px-3 py-1.5 rounded-lg hover:bg-violet-700 disabled:opacity-50">Tạo bản nháp mới từ bản đang chạy</button>
          </div>
          <p className="text-[11px] text-amber-700">Lưu ý: tạo bản nháp mới sẽ HỦY Version {draft.versionNumber} (vẫn còn trong Version History, không xóa).</p>
        </div>
      )}

      {/* #5 — Vừa áp dụng: cho quay lại nhanh nếu version mới lỗi */}
      {lastApplied && (
        <div className="flex items-center justify-between gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 flex-wrap">
          <span className="text-sm text-emerald-800 flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-emerald-500" /> Đã áp dụng <b>Version {lastApplied.newVer}</b> lên Fanpage thật.</span>
          <div className="flex gap-2 items-center">
            <button disabled={busy} onClick={() => quickRollback(lastApplied.prevId, lastApplied.prevVer)}
              className="flex items-center gap-1.5 text-sm border border-amber-300 text-amber-700 px-3 py-1.5 rounded-lg hover:bg-amber-50 disabled:opacity-50">
              <RotateCcw className="w-4 h-4" /> Quay lại Version {lastApplied.prevVer}
            </button>
            <button onClick={() => setLastApplied(null)} className="text-sm text-gray-400 px-2 hover:text-gray-600">Đóng</button>
          </div>
        </div>
      )}

      {/* ─── TAB 1: Não đang dùng ─── */}
      {tab === "active" && (
        <div className="space-y-3">
          {!active ? (
            <p className="text-gray-500">Đang tải não đang chạy…</p>
          ) : (
            <div className="bg-white border rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-lg font-bold">Version {active.versionNumber}</span>
                <StatusBadge status={active.status} />
                <span className="text-sm text-gray-600">— {active.title}</span>
              </div>
              <div className="flex items-center gap-2 text-sm bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-2">
                <ShieldCheck className="w-4 h-4 flex-shrink-0 text-emerald-500" />
                <span>Fanpage thật đang trả lời khách theo <b>Version {active.versionNumber}</b>. Chỉ đổi khi bạn bấm “Áp dụng version này”.</span>
              </div>
              <div className="text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
                <span>Tạo bởi: {active.createdByName || "—"} · {fmtDate(active.createdAt)}</span>
                <span>Áp dụng bởi: {active.appliedByName || "—"} · {fmtDate(active.appliedAt)}</span>
              </div>
              {active.description && <p className="text-sm text-gray-600">{active.description}</p>}
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1">BỘ LUẬT NÃO LULU ĐANG CHẠY</p>
                <pre className="text-xs bg-gray-50 border rounded-lg p-3 max-h-[420px] overflow-auto whitespace-pre-wrap">{active.promptContent}</pre>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button disabled={busy} onClick={() => draftFromVersion(active.id)}
                  className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50">
                  <Pencil className="w-4 h-4" /> Tạo bản nháp từ version này
                </button>
                <button onClick={() => setTab("history")} className="flex items-center gap-1.5 border text-sm px-3 py-2 rounded-lg hover:bg-gray-50">
                  <History className="w-4 h-4" /> Xem lịch sử version
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── TAB: Nhờ AI sửa Lulu (tab riêng — báo lỗi/dán ảnh, AI gom sửa vào bản nháp) ─── */}
      {tab === "aifix" && (
        <AiFixTab active={active} draft={draft} showOk={showOk} showErr={showErr}
          onDraftChange={onDraftChange} goTest={(msg) => { if (msg) setTestPrefill(msg); setTab("fixtest"); }}
          queue={fixQueue} setQueue={setFixQueue} onCreateDraft={() => createNewDraft(false)} />
      )}

      {/* ─── TAB: Sửa & Test Lulu (chat test 1 cột + báo lỗi từng câu) ─── */}
      {tab === "fixtest" && (
        <FixTestTab draft={draft} active={active} testCases={testCases} effectiveIsAdmin={effectiveIsAdmin}
          busy={busy} setBusy={setBusy} showOk={showOk} showErr={showErr}
          onDraftChange={onDraftChange}
          onApplied={() => { loadActive(); loadVersions(); resetTestChat(null); }}
          changeRequests={changeRequests} reloadCR={loadChangeRequests}
          createDraftFromActive={() => createNewDraft(false)}
          prefill={testPrefill} onConsumePrefill={() => setTestPrefill("")}
          onAppliedInfo={(info) => setLastApplied(info)}
          turns={chatTurns} setTurns={setChatTurns} convo={chatConvo} setConvo={setChatConvo} />
      )}

      {/* ─── TAB 3: Version History ─── */}
      {tab === "history" && (
        <HistoryTab versions={versions} effectiveIsAdmin={effectiveIsAdmin} busy={busy} setBusy={setBusy}
          showOk={showOk} showErr={showErr} currentDraftId={draft?.id ?? null}
          reload={() => { loadVersions(); loadActive(); resetTestChat(null); }}
          onCloneDraft={draftFromVersion} />
      )}
    </div>
  );
}

// ─── TAB 2 component: Chat với AI để sửa Lulu ─────────────────────────────────
type AiChatMsg =
  | { id: string; role: "user"; text: string; imageUrls?: string[] }
  | { id: string; role: "clarify"; text: string }
  | { id: string; role: "card"; analysis: ScreenshotAnalysis; imageFiles: File[]; done?: "draft" | "cr" };

function AiTab({ active, busy, setBusy, showOk, showErr, onDraft, changeRequests = [], reloadCR, effectiveIsAdmin }: {
  active: BrainVersion | null; busy: boolean; setBusy: (b: boolean) => void;
  showOk: (m: string) => void; showErr: (m: string) => void;
  onDraft: (d: BrainVersion) => void; changeRequests: ChangeRequest[]; reloadCR: () => void;
  effectiveIsAdmin: boolean;
}) {
  const [msgs, setMsgs] = useState<AiChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<Array<{ file: File; url: string }>>([]);
  const [dragOver, setDragOver] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, analyzing]);

  // Đính NHIỀU ảnh (đoạn chat dài chụp mấy tấm). Lọc loại/size, đọc data URL, gộp vào danh sách (cap MAX_IMAGES).
  const acceptFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    const list = (files ? Array.from(files) : []).filter((f) => {
      if (!IMG_ACCEPT.includes(f.type)) { showErr("Chỉ nhận ảnh jpg, png hoặc webp"); return false; }
      if (f.size > IMG_MAX_BYTES) { showErr(`"${f.name}" quá lớn (tối đa 5MB)`); return false; }
      return true;
    });
    if (!list.length) return;
    try {
      const items = await Promise.all(list.map(async (file) => ({ file, url: await fileToDataUrl(file) })));
      setAttached((prev) => {
        if (prev.length + items.length > MAX_IMAGES) showErr(`Tối đa ${MAX_IMAGES} ảnh mỗi lần.`);
        return [...prev, ...items].slice(0, MAX_IMAGES);
      });
    } catch { showErr("Không đọc được ảnh"); }
  }, [showErr]);

  // Ctrl+V dán ảnh (gỡ listener khi rời tab) — gom mọi ảnh trong clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items; if (!items) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) files.push(f); }
      }
      if (files.length) { e.preventDefault(); acceptFiles(files); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFiles]);

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer?.files?.length) acceptFiles(e.dataTransfer.files); };

  // BƯỚC 1 — gửi ảnh/chữ → AI phân tích → card xác nhận (hoặc hỏi lại nếu đọc không rõ).
  const send = async () => {
    const text = input.trim();
    const files = attached.map((a) => a.file);
    if ((!text && files.length === 0) || analyzing || busy) return;
    setMsgs((p) => [...p, { id: newId(), role: "user", text: text || `(gửi ${files.length} ảnh)`, imageUrls: attached.map((a) => a.url) }]);
    setInput(""); setAttached([]); setAnalyzing(true);
    try {
      let imagesPayload: Array<{ imageBase64: string; imageMediaType: string }> | undefined;
      if (files.length) {
        // Nén webp từng tấm trước khi gửi (≈5MB → ~200KB, đỡ cost/độ trễ vision).
        imagesPayload = await Promise.all(files.map(async (file) => {
          const { blob, mimeType } = await convertToWebP(file);
          const dataUrl = await fileToDataUrl(new File([blob], file.name || "screenshot", { type: mimeType }));
          return { imageBase64: dataUrl, imageMediaType: mimeType };
        }));
      }
      const d = await apiSend<{ analysis: ScreenshotAnalysis }>("POST", "/lulu-brain/analyze-screenshot",
        { text, ...(imagesPayload ? { images: imagesPayload } : {}) });
      const a = d.analysis;
      const confident = a.readable && a.confidence >= CONFIDENCE_MIN && (!!a.issueTitle || !!a.currentWrongBehavior);
      if (!confident) {
        setMsgs((p) => [...p, { id: newId(), role: "clarify", text: a.clarifyQuestion || "Em chưa đọc rõ nội dung trong ảnh, mình mô tả lỗi ngắn giúp em nha." }]);
      } else {
        setMsgs((p) => [...p, { id: newId(), role: "card", analysis: a, imageFiles: files }]);
      }
    } catch (e) {
      showErr(String((e as Error).message));
      setMsgs((p) => [...p, { id: newId(), role: "clarify", text: "Có lỗi khi phân tích — mình thử lại hoặc mô tả lỗi bằng chữ giúp em nha." }]);
    } finally { setAnalyzing(false); }
  };

  // BƯỚC 2a — tạo bản nháp ĐỀ XUẤT (gọi lại đường ai-draft text-only), rồi sang tab Bản nháp.
  const makeDraft = async (msgId: string, a: ScreenshotAnalysis) => {
    setBusy(true);
    try {
      const d = await apiSend<{ draft: BrainVersion }>("POST", "/lulu-brain/ai-draft",
        { instruction: analysisToInstruction(a), basedOnVersionId: active?.id });
      setMsgs((p) => p.map((m) => (m.id === msgId && m.role === "card" ? { ...m, done: "draft" } : m)));
      showOk(`Đã gom sửa vào Version ${d.draft.versionNumber} (bản nháp). Lulu CHƯA đổi — test lại ở khung chat phía trên.`);
      onDraft(d.draft);
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  // BƯỚC 2b — chỉ lưu góp ý (kèm ảnh nếu có → upload persist; ảnh chỉ admin xem).
  // CR chỉ có 1 trường screenshotUrl → lưu tấm ĐẦU làm ảnh đại diện (góp ý chủ yếu là chữ).
  const saveCr = async (msgId: string, a: ScreenshotAnalysis, files: File[]) => {
    setBusy(true);
    try {
      let screenshotUrl: string | undefined;
      if (files.length) {
        const { blob, mimeType } = await convertToWebP(files[0]);
        screenshotUrl = await uploadFileViaPresign(blob, files[0].name || "screenshot.webp", mimeType);
      }
      await apiSend("POST", "/lulu-brain/change-requests", {
        issueTitle: a.issueTitle || "Góp ý cho Lulu",
        exampleCustomerMessage: a.exampleCustomerMessage || undefined,
        currentWrongBehavior: a.currentWrongBehavior || undefined,
        expectedBehavior: a.expectedBehavior || undefined,
        ...(screenshotUrl ? { screenshotUrl } : {}),
      });
      setMsgs((p) => p.map((m) => (m.id === msgId && m.role === "card" ? { ...m, done: "cr" } : m)));
      showOk("Đã lưu góp ý cho cả nhóm."); reloadCR();
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  const CardField = ({ label, value }: { label: string; value: string }) => (
    <div className="grid grid-cols-[7rem_1fr] gap-2"><span className="text-gray-500">{label}</span><span className="font-medium text-gray-800 break-words whitespace-pre-wrap">{value}</span></div>
  );

  return (
    <div className="space-y-4">
      {/* Khung chat */}
      <div className="bg-white border rounded-xl flex flex-col" style={{ height: "min(62vh, 560px)" }}>
        <div className="px-4 py-3 border-b">
          <h3 className="font-semibold flex items-center gap-2"><MessageSquare className="w-4 h-4 text-violet-600" /> Chat với AI để sửa Lulu</h3>
          <p className="text-xs text-gray-500 mt-0.5">Dán ảnh đoạn chat hoặc nói lỗi Lulu gặp phải. AI sẽ đọc, hiểu lỗi rồi tạo bản nháp — <b>chưa áp dụng ngay</b>.</p>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
          {msgs.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-8 space-y-2">
              <MessageSquare className="w-8 h-8 mx-auto opacity-40" />
              <p>Gửi ảnh chụp đoạn chat Lulu trả lời sai, hoặc gõ mô tả lỗi.<br />Ví dụ: “Khách hỏi beauty mà Lulu gửi ảnh cưới.”</p>
            </div>
          )}
          {msgs.map((m) => {
            if (m.role === "user") return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] bg-violet-600 text-white rounded-2xl rounded-br-sm px-3 py-2 text-sm">
                  {m.imageUrls && m.imageUrls.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {m.imageUrls.map((u, i) => <img key={i} src={u} alt={`ảnh ${i + 1}`} className="rounded-lg max-h-40 border border-white/30" />)}
                    </div>
                  )}
                  <span className="whitespace-pre-wrap break-words">{m.text}</span>
                </div>
              </div>
            );
            if (m.role === "clarify") return (
              <div key={m.id} className="flex gap-2 items-start">
                <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-violet-600 shrink-0"><Bot className="w-4 h-4" /></div>
                <div className="max-w-[80%] bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl rounded-bl-sm px-3 py-2 text-sm">{m.text}</div>
              </div>
            );
            // card
            const a = m.analysis;
            return (
              <div key={m.id} className="flex gap-2 items-start">
                <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-violet-600 shrink-0"><Bot className="w-4 h-4" /></div>
                <div className="max-w-[88%] w-full bg-violet-50 border border-violet-200 rounded-2xl rounded-bl-sm p-3 space-y-1.5 text-sm">
                  <div className="font-semibold text-violet-700 flex items-center gap-1.5"><Sparkles className="w-4 h-4" /> AI hiểu lỗi này là</div>
                  <CardField label="Lỗi" value={a.issueTitle || "—"} />
                  {a.exampleCustomerMessage && <CardField label="Câu khách" value={a.exampleCustomerMessage} />}
                  <CardField label="Lulu đang sai" value={a.currentWrongBehavior || "—"} />
                  <CardField label="Mong muốn đúng" value={a.expectedBehavior || "—"} />
                  {a.affectedRules.length > 0 && <CardField label="Rule sẽ sửa" value={a.affectedRules.join(", ")} />}
                  <div className="text-[11px] text-gray-500 pt-0.5">Độ chắc của AI: {(a.confidence * 100).toFixed(0)}%</div>
                  {m.done ? (
                    <div className="text-emerald-700 text-xs font-medium flex items-center gap-1 pt-1"><Check className="w-3.5 h-3.5" /> {m.done === "draft" ? "Đã gom sửa vào bản nháp (test lại ở khung chat trên)" : "Đã lưu góp ý cho cả nhóm"}</div>
                  ) : (
                    <div className="flex gap-2 flex-wrap pt-1.5">
                      <button disabled={busy} onClick={() => makeDraft(m.id, a)}
                        className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-violet-700 disabled:opacity-50">
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Tạo bản nháp đề xuất
                      </button>
                      <button disabled={busy} onClick={() => saveCr(m.id, a, m.imageFiles)}
                        className="flex items-center gap-1.5 border text-sm px-3 py-1.5 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                        <Megaphone className="w-4 h-4 text-amber-600" /> Chỉ lưu góp ý
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {analyzing && (
            <div className="flex gap-2 items-center text-gray-400 text-sm">
              <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-violet-600 shrink-0"><Bot className="w-4 h-4" /></div>
              <Loader2 className="w-4 h-4 animate-spin" /> AI đang đọc & phân tích…
            </div>
          )}
        </div>

        {/* Quick chips */}
        <div className="px-3 pt-2 flex flex-wrap gap-1.5">
          {QUICK_CHIPS.map((c) => (
            <button key={c} onClick={() => setInput((prev) => (prev ? prev + " " : "") + c)} disabled={analyzing}
              className="text-[11px] bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded-full text-gray-600 disabled:opacity-50">{c}</button>
          ))}
        </div>

        {/* Composer */}
        <div className="p-3 border-t"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
          {dragOver && <div className="text-center text-violet-600 text-xs mb-1.5 border-2 border-dashed border-violet-300 rounded-lg py-1.5">Thả ảnh vào đây để gửi (được nhiều tấm)</div>}
          {attached.length > 0 && (
            <div className="flex flex-wrap items-end gap-2 mb-2">
              {attached.map((a, i) => (
                <div key={i} className="relative">
                  <img src={a.url} alt={`ảnh ${i + 1}`} className="h-16 rounded-lg border object-cover" />
                  <button onClick={() => setAttached((prev) => prev.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 bg-rose-500 text-white rounded-full w-5 h-5 flex items-center justify-center"><X className="w-3 h-3" /></button>
                </div>
              ))}
              <span className="text-[11px] text-gray-400 self-center">{attached.length}/{MAX_IMAGES} ảnh</span>
            </div>
          )}
          <div className="flex items-end gap-2">
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple ref={fileRef} onChange={(e) => { acceptFiles(e.target.files); e.target.value = ""; }} className="hidden" />
            <button onClick={() => fileRef.current?.click()} className="p-2 border rounded-lg hover:bg-gray-50 shrink-0" title="Đính ảnh chụp màn hình — được nhiều tấm (hoặc Ctrl+V để dán)"><ImageIcon className="w-4 h-4 text-gray-500" /></button>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Mô tả lỗi của Lulu, hoặc dán/kéo ảnh đoạn chat vào đây… (đoạn dài có thể gửi nhiều ảnh)"
              className="flex-1 border rounded-lg px-3 py-2 text-sm resize-none max-h-32" />
            <button disabled={analyzing || busy || (!input.trim() && attached.length === 0)} onClick={send}
              className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50 shrink-0">
              {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Gửi
            </button>
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Đoạn chat dài có thể gửi nhiều ảnh (tối đa {MAX_IMAGES}). Ảnh chỉ dùng để AI hiểu lỗi — nên che tên/SĐT khách nếu nhạy cảm.</p>
        </div>
      </div>

      {/* Chế độ nâng cao (form cũ + danh sách góp ý) */}
      <AdvancedMode active={active} busy={busy} setBusy={setBusy} showOk={showOk} showErr={showErr}
        onDraft={onDraft} changeRequests={changeRequests} reloadCR={reloadCR}
        effectiveIsAdmin={effectiveIsAdmin} open={advanced} setOpen={setAdvanced} />
    </div>
  );
}

// ─── Chế độ nâng cao: form tay cũ (nhập thủ công) + danh sách góp ý ───────────
function AdvancedMode({ active, busy, setBusy, showOk, showErr, onDraft, changeRequests = [], reloadCR, effectiveIsAdmin, open, setOpen }: {
  active: BrainVersion | null; busy: boolean; setBusy: (b: boolean) => void;
  showOk: (m: string) => void; showErr: (m: string) => void; onDraft: (d: BrainVersion) => void;
  changeRequests: ChangeRequest[]; reloadCR: () => void; effectiveIsAdmin: boolean;
  open: boolean; setOpen: (b: boolean) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [cr, setCr] = useState({ issueTitle: "", exampleCustomerMessage: "", currentWrongBehavior: "", expectedBehavior: "" });

  const askAi = async (text: string, changeRequestId?: number) => {
    if (!text.trim()) { showErr("Hãy nhập góp ý cho AI"); return; }
    setBusy(true);
    try {
      const d = await apiSend<{ draft: BrainVersion }>("POST", "/lulu-brain/ai-draft",
        { instruction: text, basedOnVersionId: active?.id, changeRequestId });
      showOk(`Đã gom sửa vào Version ${d.draft.versionNumber} (bản nháp). Lulu CHƯA đổi — test lại ở khung chat phía trên.`); onDraft(d.draft);
      if (changeRequestId) reloadCR();
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };
  const submitCr = async () => {
    if (!cr.issueTitle.trim()) { showErr("Nhập tiêu đề lỗi/góp ý"); return; }
    setBusy(true);
    try {
      await apiSend("POST", "/lulu-brain/change-requests", cr);
      setCr({ issueTitle: "", exampleCustomerMessage: "", currentWrongBehavior: "", expectedBehavior: "" });
      showOk("Đã lưu báo lỗi/góp ý."); reloadCR();
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  return (
    <div className="bg-white border rounded-xl">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50">
        <span className="flex items-center gap-2"><Pencil className="w-4 h-4" /> Chế độ nâng cao — nhập tay prompt/rule &amp; góp ý</span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="grid md:grid-cols-2 gap-4 p-4 border-t">
          {/* Nhờ AI bằng chữ (tay) */}
          <div className="space-y-3">
            <h4 className="font-semibold text-sm flex items-center gap-2"><Sparkles className="w-4 h-4 text-violet-600" /> Viết góp ý cho AI (tự nhập)</h4>
            <p className="text-xs text-gray-500">AI sẽ viết lại bộ luật &amp; tạo bản nháp đề xuất (không áp dụng ngay).</p>
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={5}
              placeholder="Ví dụ: Lulu đang gửi ảnh cưới khi khách hỏi beauty, sửa lại cho đúng…"
              className="w-full border rounded-lg px-3 py-2 text-sm" />
            <div className="flex flex-wrap gap-1.5">
              {QUICK_CHIPS.map((ex) => (
                <button key={ex} onClick={() => setInstruction((p) => (p ? p + " " : "") + ex)} className="text-[11px] bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded-full text-gray-600">{ex}</button>
              ))}
            </div>
            <button disabled={busy} onClick={() => askAi(instruction)}
              className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Tạo bản nháp đề xuất
            </button>
          </div>

          {/* Form góp ý tay + danh sách */}
          <div className="space-y-3">
            <h4 className="font-semibold text-sm flex items-center gap-2"><Megaphone className="w-4 h-4 text-amber-600" /> Báo lỗi / Góp ý (tự nhập)</h4>
            <input value={cr.issueTitle} onChange={(e) => setCr({ ...cr, issueTitle: e.target.value })} placeholder="Tiêu đề (vd: Lulu gửi sai ảnh khi hỏi beauty)" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input value={cr.exampleCustomerMessage} onChange={(e) => setCr({ ...cr, exampleCustomerMessage: e.target.value })} placeholder="Câu khách ví dụ" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input value={cr.currentWrongBehavior} onChange={(e) => setCr({ ...cr, currentWrongBehavior: e.target.value })} placeholder="Lulu đang làm SAI gì" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input value={cr.expectedBehavior} onChange={(e) => setCr({ ...cr, expectedBehavior: e.target.value })} placeholder="Mong Lulu làm ĐÚNG thế nào" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <button disabled={busy} onClick={submitCr} className="flex items-center gap-1.5 border text-sm px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50">
              <Plus className="w-4 h-4" /> Lưu báo lỗi / góp ý
            </button>

            {changeRequests.length > 0 && (
              <div className="pt-2 border-t space-y-2 max-h-64 overflow-auto">
                {changeRequests.slice(0, 12).map((c) => (
                  <div key={c.id} className="text-xs border rounded-lg p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-700">{c.issueTitle}</span>
                      <span className="text-[10px] text-gray-400">{c.status}</span>
                    </div>
                    {c.currentWrongBehavior && <p className="text-gray-500 mt-0.5">Sai: {c.currentWrongBehavior}</p>}
                    {c.expectedBehavior && <p className="text-gray-500">Đúng: {c.expectedBehavior}</p>}
                    {effectiveIsAdmin && c.screenshotUrl && (
                      <img src={getImageSrc(c.screenshotUrl) ?? undefined} alt="ảnh kèm" className="mt-1 max-h-24 rounded border" />
                    )}
                    <button disabled={busy}
                      onClick={() => askAi(`${c.issueTitle}. ${c.currentWrongBehavior ? "Đang sai: " + c.currentWrongBehavior + ". " : ""}${c.expectedBehavior ? "Mong muốn: " + c.expectedBehavior + ". " : ""}${c.exampleCustomerMessage ? "Câu khách ví dụ: " + c.exampleCustomerMessage : ""}`, c.id)}
                      className="mt-1 text-[11px] text-violet-600 hover:underline flex items-center gap-1">
                      <Sparkles className="w-3 h-3" /> Nhờ AI sửa từ góp ý này
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TAB 3 component ────────────────────────────────────────────────────────────
// Tab "Nhờ AI sửa Lulu" — HÀNG ĐỢI SỬA LỖI: nhập lỗi/ảnh → đưa vào hàng đợi (phân tích ở NỀN, KHÔNG
// chờ màn hình) → mỗi card hiện "AI hiểu lỗi như sau" → ADMIN duyệt mới áp dụng vào bản nháp.
// Phân tích = analyze-screenshot (nhanh, không sửa nháp); chỉ khi bấm Áp dụng mới gọi ai-draft (chậm)
// gom vào CÙNG bản nháp. Backend analyze-screenshot đã nhận images[] (tối đa 6) → tái dùng.
type QueueStatus = "analyzing" | "review" | "applying" | "applied" | "error";
type QueueImage = { url: string; base64: string; mediaType: string };
type QueueCard = {
  id: string; text: string; images: QueueImage[];
  status: QueueStatus; analysis: ScreenshotAnalysis | null;
  manualOpen: boolean; manualText: string;
  appliedVersion: number | null; error: string | null;
  imgCount?: number; // số ảnh (giữ lại khi khôi phục từ localStorage — ảnh base64 không lưu cho nhẹ)
};
const QUEUE_STATUS: Record<QueueStatus, { label: string; cls: string }> = {
  analyzing: { label: "Đang phân tích…", cls: "bg-blue-100 text-blue-700 border-blue-200" },
  review: { label: "Đã hiểu lỗi — chờ duyệt", cls: "bg-amber-100 text-amber-700 border-amber-200" },
  applying: { label: "Đang áp dụng…", cls: "bg-violet-100 text-violet-700 border-violet-200" },
  applied: { label: "Đã áp dụng", cls: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  error: { label: "Lỗi xử lý", cls: "bg-rose-100 text-rose-700 border-rose-200" },
};

function AiFixTab({ active, draft, showOk, showErr, onDraftChange, goTest, queue, setQueue, onCreateDraft }: {
  active: BrainVersion | null; draft: BrainVersion | null;
  showOk: (m: string) => void; showErr: (m: string) => void;
  onDraftChange: (v: BrainVersion | null) => void; goTest: (msg?: string) => void;
  queue: QueueCard[]; setQueue: React.Dispatch<React.SetStateAction<QueueCard[]>>;
  onCreateDraft: () => void;
}) {
  const [text, setText] = useState("");
  const [imgs, setImgs] = useState<Array<{ file: File; url: string }>>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const anyApplying = queue.some((c) => c.status === "applying");
  const verLabel = draft ? `Version ${draft.versionNumber}` : "bản nháp";

  // Thêm NHIỀU ảnh (chọn nhiều / kéo-thả / dán). Lọc loại + size, gộp vào danh sách (cap MAX_IMAGES).
  const acceptFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    const list = (files ? Array.from(files) : []).filter((f) => {
      if (!IMG_ACCEPT.includes(f.type)) { showErr("Chỉ nhận ảnh jpg, png, webp"); return false; }
      if (f.size > IMG_MAX_BYTES) { showErr(`"${f.name}" quá lớn (tối đa 5MB)`); return false; }
      return true;
    });
    if (!list.length) return;
    try {
      const items = await Promise.all(list.map(async (file) => ({ file, url: await fileToDataUrl(file) })));
      setImgs((prev) => {
        if (prev.length + items.length > MAX_IMAGES) showErr(`Tối đa ${MAX_IMAGES} ảnh mỗi lần.`);
        return [...prev, ...items].slice(0, MAX_IMAGES);
      });
    } catch { showErr("Không đọc được ảnh"); }
  }, [showErr]);

  // Ctrl+V dán ảnh screenshot (gỡ listener khi rời tab).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items; if (!items) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) files.push(f); }
      }
      if (files.length) { e.preventDefault(); acceptFiles(files); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFiles]);

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer?.files?.length) acceptFiles(e.dataTransfer.files); };

  // Phân tích 1 card ở NỀN (analyze-screenshot — KHÔNG đụng bản nháp).
  const analyzeCard = useCallback(async (card: QueueCard) => {
    setQueue((p) => p.map((c) => (c.id === card.id ? { ...c, status: "analyzing", error: null } : c)));
    try {
      const images = card.images.map((im) => ({ imageBase64: im.base64, imageMediaType: im.mediaType }));
      const a = (await apiSend<{ analysis: ScreenshotAnalysis }>("POST", "/lulu-brain/analyze-screenshot",
        { text: card.text, ...(images.length ? { images } : {}) })).analysis;
      setQueue((p) => p.map((c) => (c.id === card.id ? { ...c, status: "review", analysis: a } : c)));
    } catch (e) {
      setQueue((p) => p.map((c) => (c.id === card.id ? { ...c, status: "error", error: String((e as Error).message) } : c)));
    }
  }, [setQueue]);

  // Đưa vào hàng đợi: tạo card + clear ô nhập NGAY + chạy phân tích nền (không chặn).
  const enqueue = async () => {
    const t = text.trim();
    if (!t && imgs.length === 0) { showErr("Nhập mô tả lỗi hoặc thêm ảnh giúp em nha."); return; }
    let images: QueueImage[] = [];
    try {
      images = await Promise.all(imgs.map(async ({ file, url }) => {
        const { blob, mimeType } = await convertToWebP(file);
        const base64 = await fileToDataUrl(new File([blob], file.name || "shot", { type: mimeType }));
        return { url, base64, mediaType: mimeType };
      }));
    } catch { showErr("Không xử lý được ảnh"); return; }
    const card: QueueCard = { id: newId(), text: t, images, status: "analyzing", analysis: null, manualOpen: false, manualText: "", appliedVersion: null, error: null };
    setQueue((p) => [card, ...p]);
    setText(""); setImgs([]);
    analyzeCard(card);
  };

  // Áp dụng 1 card vào bản nháp (gọi ai-draft — gom vào CÙNG bản nháp; chưa có thì backend tự tạo).
  const applyCard = async (card: QueueCard, manualInstruction?: string) => {
    if (anyApplying) { showErr("Đang áp dụng một lỗi khác — chờ xong rồi áp dụng tiếp nha."); return; }
    const instruction = (manualInstruction ?? [card.text, card.analysis ? analysisToInstruction(card.analysis) : ""].filter(Boolean).join("\n")).trim();
    if (!instruction) { showErr("Chưa có nội dung để sửa."); return; }
    setQueue((p) => p.map((c) => (c.id === card.id ? { ...c, status: "applying", error: null } : c)));
    try {
      const d = await apiSend<{ draft: BrainVersion }>("POST", "/lulu-brain/ai-draft", { instruction });
      onDraftChange(d.draft);
      setQueue((p) => p.map((c) => (c.id === card.id ? { ...c, status: "applied", appliedVersion: d.draft.versionNumber, manualOpen: false } : c)));
      showOk(`Đã áp dụng vào Version ${d.draft.versionNumber} — Bản nháp.`);
    } catch (e) {
      setQueue((p) => p.map((c) => (c.id === card.id ? { ...c, status: "error", error: String((e as Error).message) } : c)));
    }
  };

  const patchCard = (id: string, patch: Partial<QueueCard>) => setQueue((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const removeCard = (id: string) => setQueue((p) => p.filter((c) => c.id !== id));

  return (
    <div className="space-y-3">
      {/* Banner: đang nạp lỗi vào version nào */}
      {draft ? (
        <div className="flex items-center gap-2 text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
          <Pencil className="w-4 h-4 flex-shrink-0" /> <span>Đang nạp lỗi vào: <b>Version {draft.versionNumber} — Bản nháp</b></span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2 flex-wrap">
          <span>Chưa có bản nháp. Lỗi đầu tiên được <b>áp dụng</b> sẽ tự tạo bản nháp từ bản đang chạy{active ? ` (Version ${active.versionNumber})` : ""}.</span>
          <button onClick={onCreateDraft} className="inline-flex items-center gap-1.5 bg-violet-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-violet-700"><Plus className="w-3.5 h-3.5" /> Tạo bản nháp mới</button>
        </div>
      )}

      {/* Ô nhập lỗi + ảnh */}
      <div className="bg-white border-2 border-violet-200 rounded-xl p-4 space-y-3"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
        <div>
          <h3 className="font-semibold flex items-center gap-2 text-violet-700"><Wand2 className="w-4 h-4" /> Nhờ AI sửa Lulu</h3>
          <p className="text-xs text-gray-500 mt-0.5">Báo lỗi / dán đoạn chat sai / mô tả lỗi (kèm nhiều ảnh). Bấm gửi → lỗi xuống <b>hàng đợi</b> bên dưới, AI phân tích ở nền; bạn nhập lỗi tiếp được ngay. AI <b>KHÔNG</b> tự sửa — bạn duyệt rồi mới áp dụng.</p>
        </div>
        {dragOver && <div className="text-center text-violet-600 text-xs border-2 border-dashed border-violet-300 rounded-lg py-2">Thả ảnh vào đây (được nhiều tấm)</div>}
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
          placeholder="Dán lỗi hoặc mô tả lỗi của Lulu tại đây. Ví dụ: Khách hỏi beauty nhưng Lulu gửi ảnh cưới. Hãy sửa để chỉ gửi ảnh beauty."
          className="w-full border rounded-lg px-3 py-2 text-sm" />
        {imgs.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            {imgs.map((a, i) => (
              <div key={i} className="relative"><img src={a.url} alt={`ảnh ${i + 1}`} className="h-16 rounded-lg border object-cover" />
                <button onClick={() => setImgs((p) => p.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 bg-rose-500 text-white rounded-full w-5 h-5 flex items-center justify-center"><X className="w-3 h-3" /></button>
              </div>
            ))}
            <span className="text-[11px] text-gray-400 self-center">{imgs.length}/{MAX_IMAGES} ảnh</span>
          </div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple ref={fileRef} onChange={(e) => { acceptFiles(e.target.files); e.target.value = ""; }} className="hidden" />
          <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 border rounded-lg px-3 py-2 text-sm hover:bg-gray-50 shrink-0"><ImageIcon className="w-4 h-4 text-gray-500" /> Thêm ảnh</button>
          <button onClick={enqueue} className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-violet-700">
            <Plus className="w-4 h-4" /> {draft ? `Đưa vào hàng đợi của Version ${draft.versionNumber}` : "Đưa vào hàng đợi phân tích"}
          </button>
        </div>
        <p className="text-[11px] text-gray-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Thêm nhiều ảnh: bấm “Thêm ảnh”, kéo-thả, hoặc Ctrl+V dán (tối đa {MAX_IMAGES}). Nên che tên/SĐT khách.</p>
      </div>

      {/* Hàng đợi sửa lỗi */}
      <div className="space-y-2">
        <h3 className="font-semibold text-sm flex items-center gap-2 text-gray-700"><History className="w-4 h-4" /> Hàng đợi sửa lỗi {queue.length > 0 && <span className="text-xs text-gray-400">({queue.length})</span>}</h3>
        {queue.length === 0 ? (
          <p className="text-sm text-gray-400 bg-white border rounded-xl p-4 text-center">Chưa có lỗi nào. Nhập lỗi phía trên rồi bấm “Đưa vào hàng đợi”.</p>
        ) : queue.map((c) => {
          const meta = QUEUE_STATUS[c.status];
          const a = c.analysis;
          const unsure = a ? (!a.readable || a.confidence < CONFIDENCE_MIN) : false;
          return (
            <div key={c.id} className="bg-white border rounded-xl p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${meta.cls}`}>{meta.label}</span>
                {c.status === "applied" && c.appliedVersion != null
                  ? <span className="text-xs text-emerald-700 font-medium">Đã áp dụng vào Version {c.appliedVersion} — Bản nháp</span>
                  : <span className="text-xs text-gray-500">Thuộc {draft ? `Version ${draft.versionNumber} — Bản nháp` : "bản nháp (tạo khi áp dụng)"}</span>}
              </div>

              {c.images.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {c.images.map((im, i) => <img key={i} src={im.url} alt={`ảnh ${i + 1}`} className="h-12 rounded border object-cover" />)}
                </div>
              ) : (c.imgCount ? <p className="text-[11px] text-gray-400">📎 {c.imgCount} ảnh (đính ở phiên trước)</p> : null)}
              {c.text && <p className="text-xs text-gray-600 whitespace-pre-wrap"><span className="text-gray-400">Bạn nhập: </span>{c.text}</p>}

              {c.status === "analyzing" && <p className="text-xs text-blue-600 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> AI đang đọc &amp; phân tích lỗi…</p>}
              {c.status === "applying" && <p className="text-xs text-violet-600 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang áp dụng vào bản nháp (~30–90s)…</p>}
              {c.status === "error" && (
                <div className="text-xs text-rose-600 space-y-1.5">
                  <p>{c.error || "Có lỗi khi xử lý."}</p>
                  <div className="flex gap-2"><button onClick={() => analyzeCard(c)} className="border px-2 py-1 rounded-lg hover:bg-gray-50">Chạy lại phân tích</button><button onClick={() => removeCard(c.id)} className="border px-2 py-1 rounded-lg hover:bg-gray-50">Bỏ qua</button></div>
                </div>
              )}

              {/* Card review: "AI hiểu lỗi như sau" + nút duyệt */}
              {c.status === "review" && a && (
                <div className="space-y-2">
                  <div className="bg-violet-50 border border-violet-200 rounded-lg p-2.5 text-xs space-y-1">
                    <p className="font-semibold text-violet-700 flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" /> AI hiểu lỗi như sau:</p>
                    {a.issueTitle && <p><span className="text-gray-500">Lỗi: </span>{a.issueTitle}</p>}
                    {a.exampleCustomerMessage && <p><span className="text-gray-500">Khách hỏi: </span>{a.exampleCustomerMessage}</p>}
                    {a.currentWrongBehavior && <p><span className="text-gray-500">Lulu đang sai: </span>{a.currentWrongBehavior}</p>}
                    {a.expectedBehavior && <p><span className="text-gray-500">Sẽ sửa theo hướng: </span>{a.expectedBehavior}</p>}
                    {a.affectedRules.length > 0 && <p><span className="text-gray-500">Rule liên quan: </span>{a.affectedRules.join(", ")}</p>}
                    <p className="text-[11px] text-gray-400">Độ chắc của AI: {(a.confidence * 100).toFixed(0)}%{unsure && <span className="text-rose-500 font-medium"> · ⚠ Cần kiểm tra lại</span>}</p>
                  </div>
                  {c.manualOpen ? (
                    <div className="space-y-1.5">
                      <textarea value={c.manualText} onChange={(e) => patchCard(c.id, { manualText: e.target.value })} rows={4} className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="Viết lại yêu cầu sửa bằng tay…" />
                      <div className="flex gap-2 flex-wrap">
                        <button disabled={anyApplying} onClick={() => applyCard(c, c.manualText)} className="flex items-center gap-1.5 bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-emerald-700 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> Áp dụng bản sửa tay vào {verLabel}</button>
                        <button onClick={() => patchCard(c.id, { manualOpen: false })} className="text-xs border px-3 py-1.5 rounded-lg hover:bg-gray-50">Hủy sửa tay</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 flex-wrap">
                      <button disabled={anyApplying} onClick={() => applyCard(c)} className="flex items-center gap-1.5 bg-violet-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-violet-700 disabled:opacity-50"><Wand2 className="w-3.5 h-3.5" /> Áp dụng vào {draft ? `Version ${draft.versionNumber}` : "bản nháp"}</button>
                      <button onClick={() => patchCard(c.id, { manualOpen: true, manualText: analysisToInstruction(a) })} className="flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-lg hover:bg-gray-50"><Pencil className="w-3.5 h-3.5" /> Sửa tay rồi áp dụng</button>
                      <button onClick={() => analyzeCard(c)} className="flex items-center gap-1.5 text-xs border px-3 py-1.5 rounded-lg hover:bg-gray-50"><RotateCcw className="w-3.5 h-3.5" /> Chạy lại phân tích</button>
                      <button onClick={() => removeCard(c.id)} className="flex items-center gap-1.5 text-xs text-rose-600 border border-rose-200 px-3 py-1.5 rounded-lg hover:bg-rose-50"><X className="w-3.5 h-3.5" /> Bỏ qua</button>
                    </div>
                  )}
                </div>
              )}

              {c.status === "applied" && (
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => goTest(a?.exampleCustomerMessage || c.text)} className="flex items-center gap-1.5 bg-emerald-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-emerald-700"><FlaskConical className="w-3.5 h-3.5" /> Test lại câu này ở “Sửa &amp; Test”</button>
                  <button onClick={() => removeCard(c.id)} className="text-xs border px-3 py-1.5 rounded-lg hover:bg-gray-50">Bỏ khỏi danh sách</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// FixTestTab — tab chính "Sửa & Test Lulu": khung chat 1 cột test bản nháp (hoặc bản đang chạy
// nếu chưa có nháp). Mỗi câu Lulu trả lời có nút "Báo lỗi / Sửa phản hồi này" → AI gom sửa vào
// ĐÚNG bản nháp hiện tại (tạo mới từ bản đang chạy nếu chưa có). KHÔNG gửi Messenger thật.
type TestTurn =
  | { id: string; role: "customer"; text: string; imageUrl?: string }
  | { id: string; role: "lulu"; result: SimResult; forText: string; fixed?: boolean; preview?: boolean };
// "Câu Lulu đã được dạy" trong bản nháp (gọn, khớp GET /lulu-brain/draft-overrides).
type TaughtOverride = {
  id: string; customerQuestion: string; intent: string | null; tone: string | null;
  editedText: string | null; responseMode: "exact_reply" | "learn_from_this" | null;
  correctImageCount: number; createdByName: string | null; createdAt: string;
};

function FixTestTab({
  draft, active, testCases = [], effectiveIsAdmin, busy, setBusy, showOk, showErr,
  onDraftChange, onApplied, changeRequests = [], reloadCR, createDraftFromActive,
  prefill = "", onConsumePrefill, onAppliedInfo,
  turns, setTurns, convo, setConvo,
}: {
  draft: BrainVersion | null; active: BrainVersion | null; testCases: TestCase[];
  effectiveIsAdmin: boolean; busy: boolean; setBusy: (b: boolean) => void;
  showOk: (m: string) => void; showErr: (m: string) => void;
  onDraftChange: (v: BrainVersion | null) => void; onApplied: () => void;
  changeRequests: ChangeRequest[]; reloadCR: () => void; createDraftFromActive: () => void;
  prefill?: string; onConsumePrefill?: () => void;
  onAppliedInfo?: (info: { newVer: number; prevId: number; prevVer: number }) => void;
  // Chat test do parent giữ (lift-state) → KHÔNG mất khi đổi tab / refresh.
  turns: TestTurn[]; setTurns: React.Dispatch<React.SetStateAction<TestTurn[]>>;
  convo: ConvoMsg[]; setConvo: React.Dispatch<React.SetStateAction<ConvoMsg[]>>;
}) {
  const testingDraft = !!draft;
  const testingVersion = draft?.versionNumber ?? active?.versionNumber ?? null;

  // ── Chat test (1 cột) — state nằm ở parent (LuluBrainLabPage), nhận qua props để GIỮ khi đổi tab / refresh ──
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<{ dataUrl: string; mediaType: string } | null>(null);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // ── Báo lỗi / sửa phản hồi (panel sửa text & ảnh nằm ở FixResponsePanel) ──
  const [fixingId, setFixingId] = useState<string | null>(null);

  // ── Human chat pacing: hé lộ bong bóng từng tin theo delayMs (transient, KHÔNG lưu localStorage —
  //    reload giữa chừng thì hiện đủ luôn). Lượt "Xem trước" không dùng → hiện ngay. ──
  const [revealCounts, setRevealCounts] = useState<Record<string, number>>({});
  const revealTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { revealTimers.current.forEach(clearTimeout); }, []);
  const revealChunks = (turnId: string, chunks?: { text: string; delayMs: number }[]) => {
    if (!chunks || chunks.length <= 1) return; // 0–1 bubble → hiện ngay, không cần hé lộ
    setRevealCounts((m) => ({ ...m, [turnId]: 1 }));
    let acc = 0;
    for (let i = 1; i < chunks.length; i++) {
      acc += Math.max(300, Math.min(3000, chunks[i].delayMs || 1500));
      const n = i + 1;
      revealTimers.current.push(setTimeout(() => setRevealCounts((m) => ({ ...m, [turnId]: n })), acc));
    }
  };

  // ── "Câu Lulu đã được dạy" trong bản nháp: liệt kê + xoá từng câu (sửa lại khi lỡ dạy nhầm) ──
  const [taught, setTaught] = useState<TaughtOverride[]>([]);
  const [taughtOpen, setTaughtOpen] = useState(false);
  const [taughtLoading, setTaughtLoading] = useState(false);
  const [deletingTaught, setDeletingTaught] = useState<string | null>(null);
  const loadTaught = useCallback(async () => {
    if (!draft) { setTaught([]); return; }
    setTaughtLoading(true);
    try {
      const d = await apiGet<{ overrides: TaughtOverride[] }>("/lulu-brain/draft-overrides");
      setTaught(Array.isArray(d.overrides) ? d.overrides : []);
    } catch { /* danh sách phụ — lỗi thì để trống, không quấy người dùng */ }
    finally { setTaughtLoading(false); }
  }, [draft]);
  // Tải lại khi bản nháp đổi (id hoặc nội dung cập nhật tại chỗ sau khi dạy thêm).
  useEffect(() => { loadTaught(); }, [draft?.id, draft?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const deleteTaught = async (id: string) => {
    if (deletingTaught) return;
    if (!confirm("Xoá câu đã dạy này khỏi bản nháp?\n\n(Lulu thật chỉ đổi sau khi bấm “Áp dụng version này”.)")) return;
    setDeletingTaught(id);
    try {
      const d = await apiSend<{ draft: BrainVersion }>("DELETE", `/lulu-brain/draft-overrides/${encodeURIComponent(id)}`);
      onDraftChange(d.draft);
      setTaught((p) => p.filter((o) => o.id !== id));
      showOk("Đã xoá câu đã dạy khỏi bản nháp.");
    } catch (e) { showErr(String((e as Error).message)); }
    finally { setDeletingTaught(null); }
  };

  // ── Sửa tay nâng cao (ẩn mặc định) ──
  const [advOpen, setAdvOpen] = useState(false);
  const [content, setContent] = useState(draft?.promptContent ?? "");
  const [title, setTitle] = useState(draft?.title ?? "");
  const [savingEdit, setSavingEdit] = useState(false);
  // Đồng bộ editor khi bản nháp đổi (kể cả khi AI cập nhật tại chỗ → promptContent đổi nhưng id giữ nguyên).
  useEffect(() => { setContent(draft?.promptContent ?? ""); setTitle(draft?.title ?? ""); }, [draft?.id, draft?.promptContent, draft?.title]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [turns, sending]);
  // #2 — "Test lại câu vừa sửa": prefill ô nhập rồi báo parent xoá cờ.
  useEffect(() => { if (prefill) { setInput(prefill); onConsumePrefill?.(); } }, [prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  // #4 — Soi nhanh trước khi áp dụng.
  const [scanResults, setScanResults] = useState<Array<{ q: string; reply: string; intent: string | null }>>([]);
  const [scanning, setScanning] = useState(false);

  const lostMarkers = draft ? missingMarkers(content, active?.promptContent ?? "") : [];
  const hasLostMarkers = lostMarkers.length > 0;
  const dirty = draft ? (content !== draft.promptContent || title !== draft.title) : false;
  const diff = lineDiff(active?.promptContent ?? "", content);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { showErr("Ảnh tối đa 5MB"); return; }
    try { const dataUrl = await fileToDataUrl(f); setAttached({ dataUrl, mediaType: f.type }); }
    catch { showErr("Không đọc được ảnh"); }
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && !attached) || sending) return;
    const img = attached;
    setTurns((p) => [...p, { id: newId(), role: "customer", text: text || "[ảnh]", imageUrl: img?.dataUrl }]);
    setInput(""); setAttached(null); setSending(true);
    const priorForApi = convo.map((c) => ({ direction: c.direction, text: c.text }));
    try {
      const d = await apiSend<{ draft: SimResult | null; active: SimResult | null }>("POST", "/lulu-brain/test", {
        message: text, messages: priorForApi,
        ...(draft ? { draftVersionId: draft.id, compareWithActive: false } : { compareWithActive: true }),
        ...(img ? { imageBase64: img.dataUrl, imageMediaType: img.mediaType } : {}),
      });
      const res = draft ? d.draft : d.active;
      if (!res) { showErr("Lulu chưa trả lời được — thử gửi lại nha."); return; }
      const luluId = newId();
      setTurns((p) => [...p, { id: luluId, role: "lulu", result: res, forText: text || "[ảnh]" }]);
      revealChunks(luluId, res.chunks); // hé lộ từng bong bóng theo nhịp (nếu có nhiều tin)
      const next: ConvoMsg[] = [...convo, { direction: "incoming", text: text || "[ảnh]" }];
      // Ghi lại ảnh mẫu ĐÃ GỬI vào lịch sử dạng [image:<url>] để lượt sau KHÔNG gửi trùng
      // (backend dedupe qua extractRecentSampleUrls — giống Messenger thật). Các dòng [image:] này
      // backend tự lọc khỏi ngữ cảnh AI, chỉ dùng để loại ảnh trùng; KHÔNG hiển thị trong khung chat.
      for (const s of res.sampleImages ?? []) {
        if (s?.imageUrl) next.push({ direction: "outgoing", text: `[image:${s.imageUrl}]` });
      }
      if (res.reply?.length) next.push({ direction: "outgoing", text: res.reply.join("\n\n") });
      setConvo(next);
    } catch (e) { showErr(String((e as Error).message)); } finally { setSending(false); }
  };

  const clearChat = () => { setTurns([]); setConvo([]); setFixingId(null); };
  // Xoá 1 lượt khỏi KHUNG CHAT (chỉ dọn hiển thị; KHÔNG đụng bộ luật/bản nháp). Để xoá câu ĐÃ DẠY
  // thì dùng danh sách "Câu Lulu đã được dạy" bên dưới.
  const deleteTurn = (id: string) => { setTurns((p) => p.filter((x) => x.id !== id)); if (fixingId === id) setFixingId(null); };

  // Sau khi admin "Lưu & xem trước": tự gửi lại ĐÚNG câu khách qua bản nháp để hiện kết quả THẬT
  // (ảnh + lời Lulu sẽ dùng + badge cách dùng câu). Đây là 1 lượt test thật, KHÔNG phải preview giả.
  const previewTaught = async (question: string, draftId: number) => {
    if (sending) return;
    setSending(true);
    try {
      const d = await apiSend<{ draft: SimResult | null }>("POST", "/lulu-brain/test", {
        message: question, draftVersionId: draftId, compareWithActive: false,
      });
      if (d.draft) setTurns((p) => [...p, { id: newId(), role: "lulu", result: d.draft as SimResult, forText: question, preview: true }]);
    } catch (e) { showErr(String((e as Error).message)); } finally { setSending(false); }
  };

  // ── Hành động bản nháp ──
  const saveEdit = async () => {
    if (!draft) return;
    setSavingEdit(true);
    try {
      const d = await apiSend<{ version: BrainVersion }>("PUT", `/lulu-brain/versions/${draft.id}`, { title, promptContent: content });
      onDraftChange(d.version); showOk("Đã lưu bản nháp.");
    } catch (e) { showErr(String((e as Error).message)); } finally { setSavingEdit(false); }
  };
  const cancelDraft = async () => {
    if (!draft) return;
    if (!confirm("Hủy bản nháp này? (vẫn giữ trong lịch sử, không xóa)")) return;
    setBusy(true);
    try { await apiSend("POST", `/lulu-brain/versions/${draft.id}/reject`, {}); onDraftChange(null); showOk("Đã hủy bản nháp."); }
    catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };
  const applyDraft = async () => {
    if (!draft) return;
    if (hasLostMarkers) { showErr(`Không thể áp dụng: bản nháp đang thiếu ${lostMarkers.join(", ")}. Thêm lại đủ marker rồi mới áp dụng.`); return; }
    if (dirty) { showErr("Hãy Lưu bản nháp (ở Sửa tay nâng cao) trước khi áp dụng."); return; }
    if (!confirm(`Áp dụng Version ${draft.versionNumber} lên Fanpage thật?\n\nSau khi áp dụng, khách nhắn Fanpage sẽ được Lulu trả lời theo Version ${draft.versionNumber}. Version đang chạy hiện tại sẽ được lưu trong lịch sử.`)) return;
    const prev = active;                       // #5: nhớ bản đang chạy để cho quay lại nhanh
    const appliedVer = draft.versionNumber;
    setBusy(true);
    try {
      await apiSend("POST", `/lulu-brain/versions/${draft.id}/apply`, {});
      showOk(`Đã áp dụng Version ${appliedVer}. Fanpage thật dùng não mới từ bây giờ.`);
      onDraftChange(null); onApplied();
      if (prev) onAppliedInfo?.({ newVer: appliedVer, prevId: prev.id, prevVer: prev.versionNumber });
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  // #4 — Soi nhanh: chạy 5 câu khách mẫu qua bản nháp (read-only, không gửi Messenger).
  const QUICK_SCAN_QS = ["Anh muốn chụp cool boy", "Cho anh xem mẫu beauty", "Em đang bầu 7 tháng muốn chụp ảnh", "Chụp cổng giá bao nhiêu?", "Bên mình có cho thuê váy cưới không?"];
  const quickScan = async () => {
    if (!draft || scanning) return;
    setScanning(true); setScanResults([]);
    try {
      for (const q of QUICK_SCAN_QS) {
        try {
          const d = await apiSend<{ draft: SimResult | null }>("POST", "/lulu-brain/test", { message: q, messages: [], draftVersionId: draft.id, compareWithActive: false });
          const r = d.draft;
          setScanResults((p) => [...p, { q, reply: (r?.reply?.join(" ") || r?.raw || "(không trả lời)").slice(0, 200), intent: r?.detectedIntent ?? null }]);
        } catch (e) {
          setScanResults((p) => [...p, { q, reply: `Lỗi: ${String((e as Error).message).slice(0, 80)}`, intent: null }]);
        }
      }
    } finally { setScanning(false); }
  };

  const exampleChips = testCases.slice(0, 6);

  return (
    <div className="space-y-3">
      {/* Banner: đang test version nào + không gửi Messenger */}
      <div className={`flex items-start gap-2 text-sm rounded-lg p-3 border ${testingDraft ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-emerald-50 border-emerald-200 text-emerald-800"}`}>
        <FlaskConical className="w-5 h-5 flex-shrink-0 mt-0.5" />
        <div>
          <p>Đang test: <b>Version {testingVersion ?? "—"} — {testingDraft ? "Bản nháp" : "Đang chạy thật"}</b></p>
          <p className="text-[12px] mt-0.5">Khung test mô phỏng — <b>KHÔNG gửi Messenger thật</b>, không tạo đơn. {!testingDraft && "Chưa có bản nháp: bấm “Báo lỗi / Sửa phản hồi này” ở câu trả lời sẽ tự tạo bản nháp mới từ bản đang chạy."}</p>
        </div>
      </div>

      {/* Marker bị mất → khoá Áp dụng */}
      {draft && hasLostMarkers && (
        <div className="flex items-start gap-2 text-xs bg-rose-50 border-2 border-rose-300 rounded-lg p-3 text-rose-700">
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5 text-rose-500" />
          <div className="space-y-1">
            <p className="font-bold">⛔ Bản nháp đang THIẾU dấu hiệu kỹ thuật — đã KHOÁ nút Áp dụng.</p>
            <p>Thiếu: {lostMarkers.map((m) => <code key={m} className="bg-rose-100 border border-rose-200 rounded px-1 mx-0.5">{m}</code>)}. Mở “Sửa tay nâng cao” thêm lại đủ marker → nút Áp dụng tự mở lại.</p>
          </div>
        </div>
      )}

      {/* Thanh thao tác bản nháp */}
      <div className="flex gap-2 flex-wrap items-center">
        {draft ? (
          <>
            <StatusBadge status={draft.status} />
            {dirty && (
              <button disabled={savingEdit} onClick={saveEdit} className="flex items-center gap-1.5 border text-sm px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                {savingEdit ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Lưu bản nháp
              </button>
            )}
            <button disabled={busy} onClick={cancelDraft} className="flex items-center gap-1.5 text-rose-600 border border-rose-200 text-sm px-3 py-2 rounded-lg hover:bg-rose-50 disabled:opacity-50">
              <Trash2 className="w-4 h-4" /> Hủy bản nháp
            </button>
            <button disabled={scanning} onClick={quickScan} title="Chạy thử 5 câu khách mẫu qua bản nháp trước khi áp dụng"
              className="flex items-center gap-1.5 border text-sm px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50">
              {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />} Soi nhanh 5 câu
            </button>
            {effectiveIsAdmin ? (
              <button disabled={busy || hasLostMarkers || dirty} onClick={applyDraft}
                title={hasLostMarkers ? `Đang thiếu marker: ${lostMarkers.join(", ")}` : dirty ? "Lưu bản nháp trước" : undefined}
                className="flex items-center gap-1.5 bg-emerald-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed ml-auto">
                {hasLostMarkers ? <AlertTriangle className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />} Áp dụng version này
              </button>
            ) : (
              <span className="ml-auto text-[11px] text-gray-400 self-center">Áp dụng cần quyền admin</span>
            )}
          </>
        ) : (
          <button disabled={busy || !active} onClick={createDraftFromActive} className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50">
            <Plus className="w-4 h-4" /> Tạo bản nháp mới để bắt đầu sửa
          </button>
        )}
      </div>

      {/* #4 — Kết quả "Soi nhanh" 5 câu mẫu qua bản nháp */}
      {scanResults.length > 0 && (
        <div className="bg-white border rounded-xl p-3 space-y-1.5">
          <p className="text-xs font-semibold text-gray-600 flex items-center gap-1.5"><FlaskConical className="w-3.5 h-3.5 text-violet-600" /> Soi nhanh — Lulu trả lời thử {scanResults.length}/{QUICK_SCAN_QS.length} câu mẫu (theo bản nháp) {scanning && <Loader2 className="w-3 h-3 animate-spin" />}</p>
          {scanResults.map((s, i) => (
            <div key={i} className="text-xs border-t pt-1.5">
              <p className="text-sky-700">❓ {s.q}{s.intent && <span className="text-gray-400"> · intent: {s.intent}</span>}</p>
              <p className="text-gray-700 whitespace-pre-wrap mt-0.5">💬 {s.reply}</p>
            </div>
          ))}
          <button onClick={() => setScanResults([])} className="text-[11px] text-gray-400 hover:text-rose-500 pt-1">Ẩn kết quả</button>
        </div>
      )}

      {/* Khung chat test — cao hơn cho dễ nhìn. Mobile/tablet: 88vh, tối thiểu 560px.
          Desktop: 85vh, tối thiểu 760px, tối đa 1500px. */}
      <div className="bg-white border rounded-xl flex flex-col h-[88vh] min-h-[560px] md:h-[85vh] md:min-h-[760px] md:max-h-[1500px]">
        <div className="px-4 py-2.5 border-b flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2"><MessageSquare className="w-4 h-4 text-violet-600" /> Chat test — Lulu trả lời theo Version {testingVersion ?? "—"}</h3>
          {turns.length > 0 && (
            <button
              onClick={() => { if (confirm("Xóa toàn bộ đoạn chat test này để test lại từ đầu?\n\n(Chỉ xóa khung chat test — KHÔNG ảnh hưởng bản nháp hay bộ luật.)")) clearChat(); }}
              title="Xóa khung chat test để test lại từ đầu (không ảnh hưởng bản nháp / bộ luật)"
              className="flex items-center gap-1.5 text-[12px] font-medium text-rose-600 border border-rose-200 px-2.5 py-1 rounded-lg hover:bg-rose-50 shrink-0">
              <Trash2 className="w-3.5 h-3.5" /> Xóa hội thoại
            </button>
          )}
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
          {turns.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-6 space-y-2">
              <MessageSquare className="w-8 h-8 mx-auto opacity-40" />
              <p>Nhập câu khách hỏi để xem Lulu trả lời.<br />Trả lời sai chỗ nào, bấm “Báo lỗi / Sửa phản hồi này” ngay câu đó.</p>
            </div>
          )}
          {turns.map((t) => t.role === "customer" ? (
            <div key={t.id} className="flex justify-end items-start gap-1.5 group">
              <button onClick={() => deleteTurn(t.id)} title="Xóa câu này khỏi khung chat"
                className="opacity-0 group-hover:opacity-100 transition text-gray-300 hover:text-rose-500 mt-1.5 shrink-0"><X className="w-3.5 h-3.5" /></button>
              <div className="max-w-[80%] bg-sky-600 text-white rounded-2xl rounded-br-sm px-3 py-2 text-sm">
                {t.imageUrl && <img src={t.imageUrl} alt="ảnh khách" className="rounded-lg max-h-40 border border-white/30 mb-1" />}
                <span className="whitespace-pre-wrap break-words">{t.text}</span>
              </div>
            </div>
          ) : (
            <div key={t.id} className="flex gap-2 items-start group">
              <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-violet-600 shrink-0"><Bot className="w-4 h-4" /></div>
              <div className="max-w-[88%] w-full space-y-1.5 relative">
                <button onClick={() => deleteTurn(t.id)} title="Xóa câu này khỏi khung chat"
                  className="absolute -top-1 right-0 opacity-0 group-hover:opacity-100 transition text-gray-300 hover:text-rose-500 z-10"><X className="w-3.5 h-3.5" /></button>
                {t.preview && (
                  <div className="flex items-start gap-1.5 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1">
                    <Eye className="w-3.5 h-3.5 mt-0.5 shrink-0" /> <span>Xem trước sau khi dạy — đây là ảnh &amp; lời Lulu sẽ dùng cho câu “{t.forText}”.</span>
                  </div>
                )}
                {/* Ảnh mẫu */}
                {t.result.sampleImages.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {t.result.sampleImages.map((s, i) => (
                      <div key={i} className="w-24">
                        <img src={getImageSrc(s.imageUrl) ?? undefined} alt={s.title} onError={onBrokenSampleImg} className="w-24 h-24 object-cover rounded-lg border" />
                        <p className="text-[10px] text-gray-500 truncate mt-0.5">{s.title}</p>
                      </div>
                    ))}
                  </div>
                )}
                {/* Ảnh bảng giá */}
                {t.result.priceImages.map((p, i) => (
                  <img key={`p${i}`} src={getImageSrc(p) ?? undefined} alt="bảng giá" onError={onBrokenSampleImg} className="max-w-[200px] rounded-lg border" />
                ))}
                {/* Câu trả lời — hé lộ từng bong bóng theo nhịp (human chat pacing) */}
                {(() => {
                  const all = t.result.reply.length ? t.result.reply : [t.result.raw || "(Lulu không trả lời)"];
                  const rc = revealCounts[t.id];
                  const shown = rc != null ? all.slice(0, rc) : all;
                  const more = rc != null && rc < all.length;
                  return (
                    <>
                      {shown.map((m, i) => (
                        <div key={i} className="bg-gray-50 border rounded-2xl rounded-bl-sm px-3 py-2 text-sm whitespace-pre-wrap break-words">{m}</div>
                      ))}
                      {more && (
                        <div className="bg-gray-50 border rounded-2xl rounded-bl-sm px-3 py-2 w-fit text-gray-400 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                        </div>
                      )}
                    </>
                  );
                })()}
                {t.result.sampleNote && <p className="text-[11px] text-amber-600 italic">{t.result.sampleNote}</p>}
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                  {t.result.detectedIntent && <span>intent: <b className="text-violet-600">{t.result.detectedIntent}</b></span>}
                  <span>{t.result.responseTimeMs}ms</span>
                  {t.result.overrideApplied && <span className="text-emerald-600 font-medium">✓ Ảnh do admin dạy</span>}
                  {t.result.responseMode === "exact_reply" && <span className="text-emerald-600 font-medium">✓ Nói y chang câu admin</span>}
                  {t.result.responseMode === "learn_from_this" && <span className="text-sky-600 font-medium">✓ AI học theo câu admin</span>}
                  {t.result.escalated && <span className="text-rose-600 font-medium">⚠ Sẽ chuyển người thật ({t.result.escalationReason})</span>}
                </div>
                {/* Báo lỗi / sửa phản hồi này (text & ảnh). Lượt XEM TRƯỚC thì không hiện (chỉ để xem). */}
                {/* Mở panel sửa được kiểm TRƯỚC → câu đã dạy rồi vẫn bấm "Sửa lại" để dạy đè được. */}
                {!t.preview && (fixingId === t.id ? (
                  <FixResponsePanel turn={t} onDraftChange={onDraftChange} onPreview={previewTaught}
                    markFixed={() => setTurns((p) => p.map((x) => (x.id === t.id ? { ...x, fixed: true } : x)))}
                    onClose={() => setFixingId(null)} showOk={showOk} showErr={showErr} />
                ) : t.fixed ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-emerald-700 text-xs font-medium flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Đã dạy vào bản nháp — xem ô “Xem trước” ngay dưới để kiểm tra.</span>
                    <button onClick={() => setFixingId(t.id)} className="flex items-center gap-1.5 text-[12px] text-rose-600 border border-rose-200 px-2 py-1 rounded-lg hover:bg-rose-50">
                      <Pencil className="w-3.5 h-3.5" /> Sửa lại
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setFixingId(t.id)} className="flex items-center gap-1.5 text-[12px] text-rose-600 border border-rose-200 px-2 py-1 rounded-lg hover:bg-rose-50">
                    <AlertTriangle className="w-3.5 h-3.5" /> Báo lỗi / Sửa phản hồi này
                  </button>
                ))}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex gap-2 items-center text-gray-400 text-sm">
              <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-violet-600 shrink-0"><Bot className="w-4 h-4" /></div>
              <Loader2 className="w-4 h-4 animate-spin" /> Lulu đang trả lời…
            </div>
          )}
        </div>

        {/* Câu hỏi mẫu nhanh (điền vào ô nhập) — CUỘN NGANG 1 hàng để KHÔNG ăn chiều cao khung chat. */}
        {exampleChips.length > 0 && (
          <div className="px-3 pt-2 flex flex-nowrap gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
            {exampleChips.map((tc) => (
              <button key={tc.id} onClick={() => setInput(tc.customerMessage)} disabled={sending}
                className="shrink-0 whitespace-nowrap max-w-[220px] truncate text-[11px] bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded-full text-gray-600 disabled:opacity-50" title={tc.customerMessage}>{tc.customerMessage}</button>
            ))}
          </div>
        )}

        {/* Composer */}
        <div className="p-3 border-t flex items-center gap-2">
          <input type="file" accept="image/*" ref={fileRef} onChange={onFile} className="hidden" />
          <button onClick={() => fileRef.current?.click()} className="p-2 border rounded-lg hover:bg-gray-50 shrink-0" title="Đính ảnh khách gửi"><ImageIcon className="w-4 h-4 text-gray-500" /></button>
          {attached && (
            <div className="relative shrink-0"><img src={attached.dataUrl} alt="" className="w-10 h-10 rounded object-cover border" />
              <button onClick={() => setAttached(null)} className="absolute -top-1 -right-1 bg-rose-500 text-white rounded-full w-4 h-4 flex items-center justify-center"><X className="w-2.5 h-2.5" /></button></div>
          )}
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Nhập câu khách hỏi…" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
          <button disabled={sending || (!input.trim() && !attached)} onClick={send} className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50 shrink-0">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Gửi
          </button>
        </div>
      </div>

      {/* Câu Lulu đã được dạy trong bản nháp — xoá từng câu nếu lỡ dạy nhầm (không cần hủy cả nháp) */}
      {draft && (
        <div className="bg-white border rounded-xl">
          <button onClick={() => { const open = !taughtOpen; setTaughtOpen(open); if (open) loadTaught(); }}
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50">
            <span className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-violet-500" /> Câu Lulu đã được dạy trong bản nháp
              {taught.length > 0 && <span className="text-[11px] bg-violet-100 text-violet-700 rounded-full px-2 py-0.5">{taught.length}</span>}
            </span>
            <ChevronDown className={`w-4 h-4 transition-transform ${taughtOpen ? "rotate-180" : ""}`} />
          </button>
          {taughtOpen && (
            <div className="px-4 pb-4 space-y-2">
              <p className="text-[11px] text-gray-400">Đây là những câu bạn đã dạy riêng cho bản nháp này. Lỡ dạy nhầm thì bấm <b>Xóa</b> — Lulu thật chỉ đổi sau khi <b>Áp dụng version</b>.</p>
              {taughtLoading ? (
                <p className="text-xs text-gray-400 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang tải…</p>
              ) : taught.length === 0 ? (
                <p className="text-xs text-gray-400">Chưa dạy câu riêng nào cho bản nháp này.</p>
              ) : taught.map((o) => (
                <div key={o.id} className="flex items-start gap-2 border rounded-lg p-2.5 bg-gray-50/60">
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-[12px] text-gray-700"><span className="text-gray-400">Khách hỏi:</span> <b className="break-words">{o.customerQuestion || "(không rõ)"}</b></p>
                    {o.editedText && <p className="text-[12px] text-gray-600 break-words"><span className="text-gray-400">Lulu sẽ nói:</span> {o.editedText.length > 160 ? `${o.editedText.slice(0, 160)}…` : o.editedText}</p>}
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-gray-400">
                      {o.responseMode === "exact_reply" && <span className="text-emerald-600 font-medium">Nói y chang câu admin</span>}
                      {o.responseMode === "learn_from_this" && <span className="text-sky-600 font-medium">AI học theo câu admin</span>}
                      {o.correctImageCount > 0 && <span>{o.correctImageCount} ảnh đã dạy</span>}
                      {o.intent && <span>nhóm: {o.intent}</span>}
                      {o.createdByName && <span>bởi {o.createdByName}</span>}
                    </div>
                  </div>
                  <button onClick={() => deleteTaught(o.id)} disabled={deletingTaught === o.id}
                    className="flex items-center gap-1 text-[11px] text-rose-600 border border-rose-200 px-2 py-1 rounded-lg hover:bg-rose-50 disabled:opacity-50 shrink-0">
                    {deletingTaught === o.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Xóa
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sửa tay nâng cao (ẩn mặc định): chỉ editor bộ luật + diff cho người rành kỹ thuật */}
      <div className="bg-white border rounded-xl">
        <button onClick={() => setAdvOpen(!advOpen)} className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50">
          <span className="flex items-center gap-2"><Pencil className="w-4 h-4" /> Sửa tay nâng cao (sửa trực tiếp bộ luật)</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${advOpen ? "rotate-180" : ""}`} />
        </button>
        {advOpen && (
          <div className="p-4 border-t space-y-4">
            {draft ? (
              <div className="space-y-3">
                {draft.changeSummary && (
                  <div className="bg-violet-50 border border-violet-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-violet-700 mb-1 flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" /> Đã sửa gì trong bản nháp này</p>
                    <p className="text-xs text-gray-700 whitespace-pre-wrap">{draft.changeSummary}</p>
                  </div>
                )}
                <div className="grid sm:grid-cols-2 gap-2">
                  <div className="border rounded-lg p-2 bg-rose-50/40">
                    <p className="text-[11px] font-semibold text-rose-600 mb-1 flex items-center gap-1"><GitCompareArrows className="w-3.5 h-3.5" /> Bỏ / khác so với bản đang chạy ({diff.removed.length})</p>
                    <div className="text-[11px] text-rose-700/80 max-h-32 overflow-auto space-y-0.5">
                      {diff.removed.length ? diff.removed.map((l, i) => <div key={i} className="line-through decoration-rose-300">− {l}</div>) : <span className="text-gray-400">—</span>}
                    </div>
                  </div>
                  <div className="border rounded-lg p-2 bg-emerald-50/40">
                    <p className="text-[11px] font-semibold text-emerald-600 mb-1 flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Thêm mới ({diff.added.length})</p>
                    <div className="text-[11px] text-emerald-700/90 max-h-32 overflow-auto space-y-0.5">
                      {diff.added.length ? diff.added.map((l, i) => <div key={i}>+ {l}</div>) : <span className="text-gray-400">—</span>}
                    </div>
                  </div>
                </div>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tên bản nháp" className="w-full border rounded-lg px-3 py-2 text-sm" />
                <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={16} className="w-full border rounded-lg px-3 py-2 text-xs font-mono leading-relaxed" />
                <button disabled={savingEdit || !dirty} onClick={saveEdit} className="flex items-center gap-1.5 border text-sm px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"><Save className="w-4 h-4" /> Lưu bản nháp</button>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Chưa có bản nháp. Bấm “Tạo bản nháp từ bản đang chạy” ở trên, hoặc dùng “Nhờ AI sửa Lulu” / báo lỗi ở một câu trả lời để tạo.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TAB 4 component ────────────────────────────────────────────────────────────
// (TestTab cũ — bảng so sánh 2 cột + Pass/Fail — đã được thay bằng FixTestTab phía trên.)

// ─── TAB 5 component ────────────────────────────────────────────────────────────
function HistoryTab({ versions = [], effectiveIsAdmin, busy, setBusy, showOk, showErr, reload, onCloneDraft, currentDraftId }: {
  versions: BrainVersion[]; effectiveIsAdmin: boolean; busy: boolean; setBusy: (b: boolean) => void;
  showOk: (m: string) => void; showErr: (m: string) => void; reload: () => void; onCloneDraft: (id: number) => void;
  currentDraftId: number | null;
}) {
  const [viewing, setViewing] = useState<BrainVersion | null>(null);

  const rollback = async (v: BrainVersion) => {
    if (!confirm(`Khôi phục Version ${v.versionNumber}? Hệ thống tạo version MỚI từ nội dung này và set chạy thật (không xóa lịch sử).`)) return;
    setBusy(true);
    try {
      const note = prompt("Ghi chú khôi phục (tùy chọn):") ?? undefined;
      await apiSend("POST", `/lulu-brain/versions/${v.id}/rollback`, { note });
      showOk(`Đã khôi phục từ Version ${v.versionNumber}.`); reload();
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      {versions.length === 0 ? <p className="text-gray-500">Chưa có version.</p> : versions.map((v) => (
        <div key={v.id} className="bg-white border rounded-xl p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold">Version {v.versionNumber}</span>
            {v.id === currentDraftId
              ? <span className="inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-amber-100 text-amber-800 border-amber-300">Bản nháp hiện tại</span>
              : <StatusBadge status={v.status} />}
            <span className="text-sm text-gray-600">{v.title}</span>
          </div>
          <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-4 mt-1">
            <span>Tạo: {v.createdByName || "—"} · {fmtDate(v.createdAt)}</span>
            {v.appliedAt && <span>Áp dụng: {v.appliedByName || "—"} · {fmtDate(v.appliedAt)}</span>}
          </div>
          {v.changeSummary && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{v.changeSummary}</p>}
          <div className="flex gap-2 flex-wrap mt-2">
            <button onClick={() => setViewing(viewing?.id === v.id ? null : v)} className="flex items-center gap-1 text-xs border px-2 py-1 rounded-lg hover:bg-gray-50"><Eye className="w-3.5 h-3.5" /> {viewing?.id === v.id ? "Ẩn" : "Xem"}</button>
            <button onClick={() => onCloneDraft(v.id)} className="flex items-center gap-1 text-xs border px-2 py-1 rounded-lg hover:bg-gray-50"><Pencil className="w-3.5 h-3.5" /> Tạo nháp từ version này</button>
            {effectiveIsAdmin && v.status !== "active" && (
              <button disabled={busy} onClick={() => rollback(v)} className="flex items-center gap-1 text-xs bg-amber-500 text-white px-2 py-1 rounded-lg hover:bg-amber-600 disabled:opacity-50"><RotateCcw className="w-3.5 h-3.5" /> Khôi phục version này</button>
            )}
          </div>
          {viewing?.id === v.id && (
            <pre className="mt-2 text-[11px] bg-gray-50 border rounded-lg p-2 max-h-80 overflow-auto whitespace-pre-wrap">{v.promptContent}</pre>
          )}
        </div>
      ))}
    </div>
  );
}
