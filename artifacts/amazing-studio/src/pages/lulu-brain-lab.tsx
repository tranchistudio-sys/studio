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

  const setCurrentDraft = (v: BrainVersion) => {
    setDraft(v);
    localStorage.setItem(DRAFT_KEY, String(v.id));
  };
  // Cập nhật / xoá bản nháp đang mở (dùng chung cho tab Sửa & Test).
  const onDraftChange = (v: BrainVersion | null) => {
    if (v) setCurrentDraft(v);
    else { setDraft(null); localStorage.removeItem(DRAFT_KEY); }
  };

  // ── Tạo bản nháp từ version ──
  const draftFromVersion = async (vid: number) => {
    setBusy(true);
    try {
      const d = await apiSend<{ draft: BrainVersion }>("POST", `/lulu-brain/versions/${vid}/draft-from`, {});
      setCurrentDraft(d.draft); setTab("fixtest"); showOk("Đã có bản nháp. Chat test rồi báo lỗi để AI sửa nha.");
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
      showOk(`Đã quay lại Version ${sourceVer}.`); setLastApplied(null); loadActive(); loadVersions();
    } catch (e) { showErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  const TABS: { key: Tab; label: string; icon: typeof Brain }[] = [
    { key: "active", label: "Não đang dùng", icon: Brain },
    { key: "aifix", label: "Nhờ AI sửa Lulu", icon: Sparkles },
    { key: "fixtest", label: "Sửa & Test Lulu", icon: FlaskConical },
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
          onApplied={() => { loadActive(); loadVersions(); }}
          changeRequests={changeRequests} reloadCR={loadChangeRequests}
          createDraftFromActive={() => createNewDraft(false)}
          prefill={testPrefill} onConsumePrefill={() => setTestPrefill("")}
          onAppliedInfo={(info) => setLastApplied(info)} />
      )}

      {/* ─── TAB 3: Version History ─── */}
      {tab === "history" && (
        <HistoryTab versions={versions} effectiveIsAdmin={effectiveIsAdmin} busy={busy} setBusy={setBusy}
          showOk={showOk} showErr={showErr} currentDraftId={draft?.id ?? null}
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
  | { id: string; role: "lulu"; result: SimResult; forText: string; fixed?: boolean };

function FixTestTab({
  draft, active, testCases = [], effectiveIsAdmin, busy, setBusy, showOk, showErr,
  onDraftChange, onApplied, changeRequests = [], reloadCR, createDraftFromActive,
  prefill = "", onConsumePrefill, onAppliedInfo,
}: {
  draft: BrainVersion | null; active: BrainVersion | null; testCases: TestCase[];
  effectiveIsAdmin: boolean; busy: boolean; setBusy: (b: boolean) => void;
  showOk: (m: string) => void; showErr: (m: string) => void;
  onDraftChange: (v: BrainVersion | null) => void; onApplied: () => void;
  changeRequests: ChangeRequest[]; reloadCR: () => void; createDraftFromActive: () => void;
  prefill?: string; onConsumePrefill?: () => void;
  onAppliedInfo?: (info: { newVer: number; prevId: number; prevVer: number }) => void;
}) {
  const testingDraft = !!draft;
  const testingVersion = draft?.versionNumber ?? active?.versionNumber ?? null;

  // ── Chat test (1 cột) ──
  const [turns, setTurns] = useState<TestTurn[]>([]);
  const [convo, setConvo] = useState<ConvoMsg[]>([]);
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<{ dataUrl: string; mediaType: string } | null>(null);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // ── Báo lỗi / sửa phản hồi ──
  const [fixingId, setFixingId] = useState<string | null>(null);
  const [fixText, setFixText] = useState("");
  const [fixing, setFixing] = useState(false);

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
      setTurns((p) => [...p, { id: newId(), role: "lulu", result: res, forText: text || "[ảnh]" }]);
      const next: ConvoMsg[] = [...convo, { direction: "incoming", text: text || "[ảnh]" }];
      if (res.reply?.length) next.push({ direction: "outgoing", text: res.reply.join("\n\n") });
      setConvo(next);
    } catch (e) { showErr(String((e as Error).message)); } finally { setSending(false); }
  };

  const clearChat = () => { setTurns([]); setConvo([]); setFixingId(null); setFixText(""); };

  // Báo lỗi 1 câu trả lời → gom sửa vào bản nháp hiện tại (AI viết lại bộ luật; chưa có nháp thì tạo từ active).
  const submitFix = async (turn: Extract<TestTurn, { role: "lulu" }>) => {
    const want = fixText.trim();
    if (!want) { showErr("Nhập yêu cầu sửa giúp em nha."); return; }
    setFixing(true);
    const instruction = [
      `Tình huống test: khách nhắn: "${turn.forText}".`,
      `Lulu trả lời (đang bị xem là CHƯA ĐÚNG): "${turn.result.reply.join(" / ") || turn.result.raw}".`,
      `YÊU CẦU SỬA: ${want}`,
      `Hãy sửa bộ luật để lần sau Lulu xử lý ĐÚNG tình huống này và các tình huống tương tự.`,
    ].join("\n");
    try {
      const d = await apiSend<{ draft: BrainVersion }>("POST", "/lulu-brain/ai-draft", { instruction });
      onDraftChange(d.draft);
      setTurns((p) => p.map((t) => (t.id === turn.id ? { ...t, fixed: true } : t)));
      setFixingId(null); setFixText("");
      showOk(`Đã gửi sửa vào Version ${d.draft.versionNumber} (bản nháp). Gửi lại câu khách để test lại nha.`);
    } catch (e) { showErr(String((e as Error).message)); } finally { setFixing(false); }
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
    try { await apiSend("POST", `/lulu-brain/versions/${draft.id}/reject`, {}); onDraftChange(null); clearChat(); showOk("Đã hủy bản nháp."); }
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
      onDraftChange(null); clearChat(); onApplied();
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

      {/* Khung chat test */}
      <div className="bg-white border rounded-xl flex flex-col" style={{ height: "min(64vh, 600px)" }}>
        <div className="px-4 py-2.5 border-b flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2"><MessageSquare className="w-4 h-4 text-violet-600" /> Chat test — Lulu trả lời theo Version {testingVersion ?? "—"}</h3>
          {turns.length > 0 && <button onClick={clearChat} className="text-[11px] text-gray-400 hover:text-rose-500">Xóa hội thoại</button>}
        </div>

        <div ref={scrollRef} className="flex-1 overflow-auto p-4 space-y-3">
          {turns.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-6 space-y-2">
              <MessageSquare className="w-8 h-8 mx-auto opacity-40" />
              <p>Nhập câu khách hỏi để xem Lulu trả lời.<br />Trả lời sai chỗ nào, bấm “Báo lỗi / Sửa phản hồi này” ngay câu đó.</p>
            </div>
          )}
          {turns.map((t) => t.role === "customer" ? (
            <div key={t.id} className="flex justify-end">
              <div className="max-w-[80%] bg-sky-600 text-white rounded-2xl rounded-br-sm px-3 py-2 text-sm">
                {t.imageUrl && <img src={t.imageUrl} alt="ảnh khách" className="rounded-lg max-h-40 border border-white/30 mb-1" />}
                <span className="whitespace-pre-wrap break-words">{t.text}</span>
              </div>
            </div>
          ) : (
            <div key={t.id} className="flex gap-2 items-start">
              <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-violet-600 shrink-0"><Bot className="w-4 h-4" /></div>
              <div className="max-w-[88%] w-full space-y-1.5">
                {/* Ảnh mẫu */}
                {t.result.sampleImages.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {t.result.sampleImages.map((s, i) => (
                      <div key={i} className="w-24">
                        <img src={getImageSrc(s.imageUrl) ?? undefined} alt={s.title} className="w-24 h-24 object-cover rounded-lg border" />
                        <p className="text-[10px] text-gray-500 truncate mt-0.5">{s.title}</p>
                      </div>
                    ))}
                  </div>
                )}
                {/* Ảnh bảng giá */}
                {t.result.priceImages.map((p, i) => (
                  <img key={`p${i}`} src={getImageSrc(p) ?? undefined} alt="bảng giá" className="max-w-[200px] rounded-lg border" />
                ))}
                {/* Câu trả lời */}
                {(t.result.reply.length ? t.result.reply : [t.result.raw || "(Lulu không trả lời)"]).map((m, i) => (
                  <div key={i} className="bg-gray-50 border rounded-2xl rounded-bl-sm px-3 py-2 text-sm whitespace-pre-wrap break-words">{m}</div>
                ))}
                {t.result.sampleNote && <p className="text-[11px] text-amber-600 italic">{t.result.sampleNote}</p>}
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-400">
                  {t.result.detectedIntent && <span>intent: <b className="text-violet-600">{t.result.detectedIntent}</b></span>}
                  <span>{t.result.responseTimeMs}ms</span>
                  {t.result.escalated && <span className="text-rose-600 font-medium">⚠ Sẽ chuyển người thật ({t.result.escalationReason})</span>}
                </div>
                {/* Báo lỗi / sửa phản hồi này */}
                {t.fixed ? (
                  <div className="text-emerald-700 text-xs font-medium flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Đã gửi sửa vào bản nháp — gửi lại câu khách để test lại.</div>
                ) : fixingId === t.id ? (
                  <div className="border border-violet-200 rounded-lg p-2 bg-violet-50/50 space-y-2">
                    <textarea value={fixText} onChange={(e) => setFixText(e.target.value)} rows={3} autoFocus
                      placeholder="Nói rõ Lulu sai gì & cần sửa thế nào. Vd: “Khách hỏi chụp bầu mà gửi ảnh cưới — phải gửi nhóm ảnh bầu và hỏi tháng thai.”"
                      className="w-full border rounded-lg px-3 py-2 text-sm" />
                    <div className="flex gap-2">
                      <button disabled={fixing} onClick={() => submitFix(t)} className="flex items-center gap-1.5 bg-violet-600 text-white text-sm px-3 py-1.5 rounded-lg hover:bg-violet-700 disabled:opacity-50">
                        {fixing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Gửi cho AI sửa vào bản nháp
                      </button>
                      <button disabled={fixing} onClick={() => { setFixingId(null); setFixText(""); }} className="text-sm px-3 py-1.5 rounded-lg border hover:bg-gray-50 disabled:opacity-50">Thôi</button>
                    </div>
                    <p className="text-[11px] text-gray-400">AI viết lại bộ luật mất khoảng 30–90 giây. Mọi lỗi đều gom vào cùng một bản nháp.</p>
                  </div>
                ) : (
                  <button onClick={() => { setFixingId(t.id); setFixText(""); }} className="flex items-center gap-1.5 text-[12px] text-rose-600 border border-rose-200 px-2 py-1 rounded-lg hover:bg-rose-50">
                    <AlertTriangle className="w-3.5 h-3.5" /> Báo lỗi / Sửa phản hồi này
                  </button>
                )}
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

        {/* Câu hỏi mẫu nhanh (điền vào ô nhập) */}
        {exampleChips.length > 0 && (
          <div className="px-3 pt-2 flex flex-wrap gap-1.5">
            {exampleChips.map((tc) => (
              <button key={tc.id} onClick={() => setInput(tc.customerMessage)} disabled={sending}
                className="text-[11px] bg-gray-100 hover:bg-gray-200 px-2 py-1 rounded-full text-gray-600 disabled:opacity-50" title={tc.title}>{tc.customerMessage}</button>
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
