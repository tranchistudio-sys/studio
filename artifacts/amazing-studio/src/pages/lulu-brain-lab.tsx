import { useState, useEffect, useCallback, useRef } from "react";
import { apiUrl } from "@/lib/api-base";
import { getImageSrc } from "@/lib/imageUtils";
import { convertToWebP, uploadFileViaPresign } from "@/lib/image-upload";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import {
  Brain, Sparkles, Pencil, FlaskConical, History, Send, Image as ImageIcon, X,
  Check, AlertTriangle, Loader2, RotateCcw, Save, Trash2, Bot, User, ShieldCheck,
  Plus, Eye, Megaphone, GitCompareArrows, ChevronDown, Wand2, MessageSquare,
} from "lucide-react";

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
};

type Tab = "active" | "ai" | "draft" | "test" | "history";
type ConvoMsg = { direction: "incoming" | "outgoing"; text: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function token(): string | null { return localStorage.getItem("amazingStudioToken_v2"); }
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
const DRAFT_KEY = "luluBrainLab.draftId";

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
                    <img src={getImageSrc(s.imageUrl) ?? undefined} alt={s.title} className="w-24 h-24 object-cover rounded-lg border" />
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

// ═══════════════════════════════════════════════════════════════════════════════
export default function LuluBrainLabPage() {
  const { effectiveIsAdmin } = useStaffAuth();
  const [tab, setTab] = useState<Tab>("active");
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const [active, setActive] = useState<BrainVersion | null>(null);
  const [defaultRules, setDefaultRules] = useState("");
  const [versions, setVersions] = useState<BrainVersion[]>([]);
  const [draft, setDraft] = useState<BrainVersion | null>(null);
  const [changeRequests, setChangeRequests] = useState<ChangeRequest[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [busy, setBusy] = useState(false);

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

  useEffect(() => {
    loadActive(); loadVersions(); loadChangeRequests(); loadTestCases();
    const savedId = Number(localStorage.getItem(DRAFT_KEY) || 0);
    if (savedId) {
      apiGet<{ version: BrainVersion }>(`/lulu-brain/versions/${savedId}`)
        .then((d) => { if (d.version.status === "draft") setDraft(d.version); else localStorage.removeItem(DRAFT_KEY); })
        .catch(() => localStorage.removeItem(DRAFT_KEY));
    }
  }, [loadActive, loadVersions, loadChangeRequests, loadTestCases]);

  const setCurrentDraft = (v: BrainVersion) => {
    setDraft(v);
    localStorage.setItem(DRAFT_KEY, String(v.id));
  };

  // ── Tạo bản nháp từ version ──
  const draftFromVersion = async (vid: number) => {
    setBusy(true);
    try {
      const d = await apiSend<{ draft: BrainVersion }>("POST", `/lulu-brain/versions/${vid}/draft-from`, {});
      setCurrentDraft(d.draft); setTab("draft"); showOk("Đã tạo bản nháp. Bạn có thể sửa rồi test.");
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  const TABS: { key: Tab; label: string; icon: typeof Brain }[] = [
    { key: "active", label: "Não đang dùng", icon: Brain },
    { key: "ai", label: "Nhờ AI sửa Lulu", icon: Sparkles },
    { key: "draft", label: "Bản nháp", icon: Pencil },
    { key: "test", label: "Test chatbot", icon: FlaskConical },
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
            {t.key === "draft" && draft && <span className="ml-1 w-2 h-2 rounded-full bg-amber-500" />}
          </button>
        ))}
      </div>

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

      {/* ─── TAB 2: Nhờ AI sửa Lulu ─── */}
      {tab === "ai" && (
        <AiTab active={active} busy={busy} setBusy={setBusy} showOk={showOk} showErr={showErr}
          onDraft={(d) => { setCurrentDraft(d); setTab("draft"); }}
          changeRequests={changeRequests} reloadCR={loadChangeRequests} effectiveIsAdmin={effectiveIsAdmin} />
      )}

      {/* ─── TAB 3: Bản nháp ─── */}
      {tab === "draft" && (
        <DraftTab draft={draft} active={active} effectiveIsAdmin={effectiveIsAdmin}
          setDraft={(v) => { if (v) setCurrentDraft(v); else { setDraft(null); localStorage.removeItem(DRAFT_KEY); } }}
          showOk={showOk} showErr={showErr}
          onApplied={() => { loadActive(); loadVersions(); }}
          goTest={() => setTab("test")} />
      )}

      {/* ─── TAB 4: Test chatbot ─── */}
      {tab === "test" && (
        <TestTab draft={draft} testCases={testCases} showOk={showOk} showErr={showErr} />
      )}

      {/* ─── TAB 5: Version History ─── */}
      {tab === "history" && (
        <HistoryTab versions={versions} effectiveIsAdmin={effectiveIsAdmin} busy={busy} setBusy={setBusy}
          showOk={showOk} showErr={showErr}
          reload={() => { loadVersions(); loadActive(); }}
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
      showOk("Đã tạo bản nháp đề xuất. Lulu CHƯA đổi — xem & test ở tab Bản nháp.");
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
                    <div className="text-emerald-700 text-xs font-medium flex items-center gap-1 pt-1"><Check className="w-3.5 h-3.5" /> {m.done === "draft" ? "Đã tạo bản nháp đề xuất (xem tab Bản nháp)" : "Đã lưu góp ý cho cả nhóm"}</div>
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
      showOk("Đã tạo bản nháp đề xuất. Lulu CHƯA đổi — xem & test ở tab Bản nháp."); onDraft(d.draft);
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
function DraftTab({ draft, active, effectiveIsAdmin, setDraft, showOk, showErr, onApplied, goTest }: {
  draft: BrainVersion | null; active: BrainVersion | null; effectiveIsAdmin: boolean;
  setDraft: (v: BrainVersion | null) => void; showOk: (m: string) => void; showErr: (m: string) => void;
  onApplied: () => void; goTest: () => void;
}) {
  const [content, setContent] = useState(draft?.promptContent ?? "");
  const [title, setTitle] = useState(draft?.title ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setContent(draft?.promptContent ?? ""); setTitle(draft?.title ?? ""); }, [draft?.id]);

  if (!draft) {
    return <div className="bg-white border rounded-xl p-6 text-center text-gray-500">
      Chưa có bản nháp. Vào <b>Nhờ AI sửa Lulu</b> hoặc bấm <b>Tạo bản nháp từ version này</b> ở tab Não đang dùng.
    </div>;
  }

  const diff = lineDiff(active?.promptContent ?? "", content);
  const dirty = content !== draft.promptContent || title !== draft.title;
  // Lưới an toàn marker: tính LIVE theo nội dung đang sửa → admin thêm lại marker là tự mở khoá nút Áp dụng.
  const lostMarkers = missingMarkers(content, active?.promptContent ?? "");
  const hasLostMarkers = lostMarkers.length > 0;

  const save = async () => {
    setBusy(true);
    try {
      const d = await apiSend<{ version: BrainVersion }>("PUT", `/lulu-brain/versions/${draft.id}`, { title, promptContent: content });
      setDraft(d.version); showOk("Đã lưu bản nháp.");
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };
  const saveThenTest = async () => { await save(); goTest(); };
  const cancel = async () => {
    if (!confirm("Hủy bản nháp này? (giữ trong lịch sử, không xóa)")) return;
    setBusy(true);
    try { await apiSend("POST", `/lulu-brain/versions/${draft.id}/reject`, {}); setDraft(null); showOk("Đã hủy bản nháp."); }
    catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (hasLostMarkers) { showErr(`Không thể áp dụng: bản nháp đang thiếu ${lostMarkers.join(", ")}. Thêm lại đủ marker rồi mới áp dụng.`); return; }
    if (dirty) { showErr("Hãy Lưu bản nháp trước khi áp dụng."); return; }
    if (!confirm(`Áp dụng bản nháp này thành bản chạy THẬT? Version đang chạy sẽ chuyển sang lưu trữ. Khách thật sẽ dùng não mới từ lúc này.`)) return;
    setBusy(true);
    try {
      await apiSend("POST", `/lulu-brain/versions/${draft.id}/apply`, {});
      showOk("Đã áp dụng. Lulu khách thật dùng não mới từ bây giờ."); setDraft(null); onApplied();
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white border rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold">Bản nháp · Version {draft.versionNumber}</span>
          <StatusBadge status={draft.status} />
          {draft.basedOnVersionId && <span className="text-xs text-gray-400">dựa trên version #{draft.basedOnVersionId}</span>}
        </div>

        {/* Banner an toàn — LUÔN hiện khi đang xem bản nháp. */}
        <div className="flex items-start gap-2 text-sm bg-sky-50 border border-sky-200 text-sky-800 rounded-lg p-3">
          <ShieldCheck className="w-5 h-5 flex-shrink-0 mt-0.5 text-sky-500" />
          <span>Đây là <b>BẢN NHÁP</b>, Lulu <b>CHƯA đổi</b> với khách thật. {effectiveIsAdmin ? "Cần bấm Áp dụng (bên dưới) mới chạy thật." : "Cần Admin bấm Áp dụng mới chạy thật."}</span>
        </div>

        {draft.changeSummary && (
          <div className="bg-violet-50 border border-violet-200 rounded-lg p-3">
            <p className="text-xs font-semibold text-violet-700 mb-1 flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" /> AI đã thay đổi gì</p>
            <p className="text-xs text-gray-700 whitespace-pre-wrap">{draft.changeSummary}</p>
          </div>
        )}

        {/* Diff vs active */}
        <div className="grid sm:grid-cols-2 gap-2">
          <div className="border rounded-lg p-2 bg-rose-50/40">
            <p className="text-[11px] font-semibold text-rose-600 mb-1 flex items-center gap-1"><GitCompareArrows className="w-3.5 h-3.5" /> Bỏ / khác so với bản đang chạy ({diff.removed.length})</p>
            <div className="text-[11px] text-rose-700/80 max-h-40 overflow-auto space-y-0.5">
              {diff.removed.length ? diff.removed.map((l, i) => <div key={i} className="line-through decoration-rose-300">− {l}</div>) : <span className="text-gray-400">—</span>}
            </div>
          </div>
          <div className="border rounded-lg p-2 bg-emerald-50/40">
            <p className="text-[11px] font-semibold text-emerald-600 mb-1 flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Thêm mới ({diff.added.length})</p>
            <div className="text-[11px] text-emerald-700/90 max-h-40 overflow-auto space-y-0.5">
              {diff.added.length ? diff.added.map((l, i) => <div key={i}>+ {l}</div>) : <span className="text-gray-400">—</span>}
            </div>
          </div>
        </div>

        {hasLostMarkers ? (
          <div className="flex items-start gap-2 text-xs bg-rose-50 border-2 border-rose-300 rounded-lg p-3 text-rose-700">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5 text-rose-500" />
            <div className="space-y-1">
              <p className="font-bold">⛔ Bản nháp đang THIẾU dấu hiệu kỹ thuật quan trọng — đã KHOÁ nút Áp dụng.</p>
              <p>Thiếu: {lostMarkers.map((m) => <code key={m} className="bg-rose-100 border border-rose-200 rounded px-1 mx-0.5">{m}</code>)}</p>
              <p>Mất marker này, Lulu sẽ không gửi được ảnh mẫu / ảnh bảng giá / chuyển người thật. Hãy <b>sửa tay thêm lại đủ marker</b> vào ô bộ luật bên dưới — nút Áp dụng sẽ tự mở lại.</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-[11px] bg-amber-50 border border-amber-200 rounded-lg p-2 text-amber-700">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>Đừng xóa các dòng có dấu hiệu kỹ thuật <code>&lt;&lt;SAMPLE&gt;&gt;</code>, <code>&lt;&lt;PRICE_IMAGE&gt;&gt;</code>, <code>&lt;&lt;NAME&gt;&gt;</code>, <code>&lt;&lt;NEEDS_HUMAN&gt;&gt;</code> — hệ thống cần chúng để gửi ảnh / báo người thật.</span>
          </div>
        )}

        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tên bản nháp" className="w-full border rounded-lg px-3 py-2 text-sm" />
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-1">SỬA TAY BỘ LUẬT (editor)</p>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={18}
            className="w-full border rounded-lg px-3 py-2 text-xs font-mono leading-relaxed" />
        </div>

        <div className="flex gap-2 flex-wrap">
          <button disabled={busy || !dirty} onClick={save} className="flex items-center gap-1.5 border text-sm px-3 py-2 rounded-lg hover:bg-gray-50 disabled:opacity-50"><Save className="w-4 h-4" /> Lưu bản nháp</button>
          <button disabled={busy} onClick={saveThenTest} className="flex items-center gap-1.5 bg-sky-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-sky-700 disabled:opacity-50"><FlaskConical className="w-4 h-4" /> {dirty ? "Lưu & Test" : "Test bản nháp"}</button>
          <button disabled={busy} onClick={cancel} className="flex items-center gap-1.5 text-rose-600 border border-rose-200 text-sm px-3 py-2 rounded-lg hover:bg-rose-50 disabled:opacity-50"><Trash2 className="w-4 h-4" /> Hủy bản nháp</button>
          {effectiveIsAdmin ? (
            <button disabled={busy || hasLostMarkers} onClick={apply}
              title={hasLostMarkers ? `Đang thiếu marker: ${lostMarkers.join(", ")} — thêm lại mới áp dụng được` : undefined}
              className="flex items-center gap-1.5 bg-emerald-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed ml-auto">
              {hasLostMarkers ? <AlertTriangle className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />} Áp dụng bản nháp
            </button>
          ) : (
            <span className="ml-auto text-[11px] text-gray-400 self-center">Áp dụng cần quyền admin</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── TAB 4 component ────────────────────────────────────────────────────────────
function TestTab({ draft, testCases = [], showOk, showErr }: {
  draft: BrainVersion | null; testCases: TestCase[];
  showOk: (m: string) => void; showErr: (m: string) => void;
}) {
  const [convo, setConvo] = useState<ConvoMsg[]>([]);
  const [msg, setMsg] = useState("");
  const [attached, setAttached] = useState<{ dataUrl: string; mediaType: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [draftRes, setDraftRes] = useState<SimResult | null>(null);
  const [activeRes, setActiveRes] = useState<SimResult | null>(null);
  const [activeCaseId, setActiveCaseId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!draft) {
    return <div className="bg-white border rounded-xl p-6 text-center text-gray-500">
      Chưa có bản nháp để test. Tạo/sửa bản nháp ở tab <b>Bản nháp</b> trước.
    </div>;
  }

  const loadCase = (tc: TestCase) => {
    setConvo(tc.priorContext.map((p) => ({ direction: p.direction, text: p.text })));
    setMsg(tc.customerMessage); setActiveCaseId(tc.id); setDraftRes(null); setActiveRes(null);
  };

  const send = async () => {
    if (!msg.trim() && !attached) return;
    setLoading(true); setDraftRes(null); setActiveRes(null);
    const priorForApi = convo.map((c) => ({ direction: c.direction, text: c.text }));
    try {
      const d = await apiSend<{ draft: SimResult | null; active: SimResult | null }>("POST", "/lulu-brain/test", {
        message: msg, messages: priorForApi, draftVersionId: draft.id, compareWithActive: true,
        ...(attached ? { imageBase64: attached.dataUrl, imageMediaType: attached.mediaType } : {}),
      });
      setDraftRes(d.draft); setActiveRes(d.active);
      // Ghi câu khách + câu trả lời bản nháp vào hội thoại để test nhiều lượt.
      const newConvo: ConvoMsg[] = [...convo, { direction: "incoming", text: msg || "[ảnh]" }];
      if (d.draft?.reply?.length) newConvo.push({ direction: "outgoing", text: d.draft.reply.join("\n\n") });
      setConvo(newConvo); setMsg(""); setAttached(null);
    } catch (e) { showErr(String((e as Error).message)); } finally { setLoading(false); }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { showErr("Ảnh tối đa 5MB"); return; }
    try { const dataUrl = await fileToDataUrl(f); setAttached({ dataUrl, mediaType: f.type }); }
    catch { showErr("Không đọc được ảnh"); }
  };

  const saveResult = async (passed: boolean) => {
    if (!draftRes) return;
    let failReason: string | undefined;
    if (!passed) { failReason = prompt("Lỗi gì? (ghi chú ngắn)") ?? undefined; }
    try {
      await apiSend("POST", "/lulu-brain/test-result", {
        brainVersionId: draft.id, testCaseId: activeCaseId,
        actualReply: draftRes.reply.join("\n\n"), detectedIntent: draftRes.detectedIntent,
        sampleImages: draftRes.sampleImages.map((s) => s.imageUrl), passed, failReason,
      });
      showOk(passed ? "Đã lưu Pass." : "Đã lưu Fail + ghi chú.");
    } catch (e) { showErr(String((e as Error).message)); }
  };

  return (
    <div className="space-y-3">
      <div className="bg-white border rounded-xl p-3">
        <p className="text-xs text-gray-500 mb-2">Đang test bản nháp <b>Version {draft.versionNumber}</b> — so với bản đang chạy thật. Chọn case mẫu hoặc tự nhập câu khách.</p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {testCases.map((tc) => (
            <button key={tc.id} onClick={() => loadCase(tc)} className={`text-[11px] px-2 py-1 rounded-full border ${activeCaseId === tc.id ? "bg-violet-100 border-violet-300 text-violet-700" : "bg-gray-50 hover:bg-gray-100 text-gray-600"}`}>{tc.title}</button>
          ))}
        </div>
        {convo.length > 0 && (
          <div className="border rounded-lg p-2 mb-2 max-h-40 overflow-auto space-y-1 bg-gray-50">
            {convo.map((c, i) => (
              <div key={i} className={`text-xs flex gap-1.5 ${c.direction === "incoming" ? "" : "justify-end"}`}>
                {c.direction === "incoming" ? <User className="w-3 h-3 text-gray-400 mt-0.5" /> : null}
                <span className={`px-2 py-1 rounded-lg ${c.direction === "incoming" ? "bg-white border" : "bg-sky-100 text-sky-800"}`}>{c.text}</span>
                {c.direction === "outgoing" ? <Bot className="w-3 h-3 text-sky-400 mt-0.5" /> : null}
              </div>
            ))}
            <button onClick={() => { setConvo([]); setActiveCaseId(null); setDraftRes(null); setActiveRes(null); }} className="text-[10px] text-gray-400 hover:text-rose-500">Xóa hội thoại</button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <input type="file" accept="image/*" ref={fileRef} onChange={onFile} className="hidden" />
          <button onClick={() => fileRef.current?.click()} className="p-2 border rounded-lg hover:bg-gray-50" title="Đính ảnh khách gửi"><ImageIcon className="w-4 h-4 text-gray-500" /></button>
          {attached && (
            <div className="relative"><img src={attached.dataUrl} alt="" className="w-10 h-10 rounded object-cover border" />
              <button onClick={() => setAttached(null)} className="absolute -top-1 -right-1 bg-rose-500 text-white rounded-full w-4 h-4 flex items-center justify-center"><X className="w-2.5 h-2.5" /></button></div>
          )}
          <input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Nhập câu khách giả lập…" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
          <button disabled={loading} onClick={send} className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Gửi
          </button>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-3">
        <ReplyColumn title="Bản đang chạy thật" accent="bg-gray-600" result={activeRes} />
        <ReplyColumn title="Bản nháp (mới)" accent="bg-violet-600" result={draftRes} />
      </div>

      {draftRes && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">Kết quả bản nháp:</span>
          <button onClick={() => saveResult(true)} className="flex items-center gap-1 bg-emerald-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-emerald-700"><Check className="w-4 h-4" /> Pass</button>
          <button onClick={() => saveResult(false)} className="flex items-center gap-1 bg-rose-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-rose-700"><X className="w-4 h-4" /> Fail + ghi chú</button>
        </div>
      )}
    </div>
  );
}

// ─── TAB 5 component ────────────────────────────────────────────────────────────
function HistoryTab({ versions = [], effectiveIsAdmin, busy, setBusy, showOk, showErr, reload, onCloneDraft }: {
  versions: BrainVersion[]; effectiveIsAdmin: boolean; busy: boolean; setBusy: (b: boolean) => void;
  showOk: (m: string) => void; showErr: (m: string) => void; reload: () => void; onCloneDraft: (id: number) => void;
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
            <StatusBadge status={v.status} />
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
