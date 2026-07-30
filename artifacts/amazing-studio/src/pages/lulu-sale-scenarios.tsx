import { useState, useEffect, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "@/lib/api-base";
import { getImageSrc } from "@/lib/imageUtils";
import { PackagePriceCard, type PricePkg } from "@/components/package-price-card";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import {
  type ScenarioCard, type ScenarioRecord, type ScenarioLabels,
  emptyCard, displayCard, summarizeWhen, summarizeNever, verdictInfo, moveItem, statusLabel,
} from "@/lib/scenario-card";
import {
  NotebookPen, Plus, Wand2, Pencil, FlaskConical, Copy, History, Loader2, Check,
  AlertTriangle, X, ChevronDown, ChevronUp, Lock, ShieldCheck, GripVertical,
  RotateCcw, Save, Trash2, Search, Power, ArrowRight, Bot, User, Archive, BookOpen,
} from "lucide-react";

/**
 * Kịch bản tư vấn Lulu — Scenario Manager.
 *
 * Chủ studio sửa thẻ bằng TIẾNG VIỆT đời thường: KHI KHÁCH / LULU NÊN / ĐỪNG BAO GIỜ /
 * CẦN BIẾT / CÂU KẾT / CHUYỂN TIẾP. Không JSON, không mã kỹ thuật (phần máy đọc nằm trong
 * "Kỹ thuật nâng cao" thu gọn). Sửa → bản NHÁP; bấm "Áp dụng tất cả" mới chạy thật.
 * Feature flag LULU_SCENARIO_MANAGER_ENABLED tắt → màn hướng dẫn bật.
 */

function token(): string | null { return localStorage.getItem("amazingStudioToken_v2"); }
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(apiUrl(`/api${path}`), { headers: authHeaders() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((data as { error?: string }).error || `Lỗi ${r.status}`), data);
  return data as T;
}
async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(apiUrl(`/api${path}`), { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((data as { error?: string }).error || `Lỗi ${r.status}`), data);
  return data as T;
}

type Issue = { field: string; message: string; suggest?: string; scenarioKey?: string };

// Bằng chứng STATIC-vs-DYNAMIC: kịch bản = cách nói, CRM = giá thật.
type PriceEvidence = {
  serviceLabel: string | null;
  crmGroupName: string | null; crmPackageName: string | null;
  crmBasePrice: number | null; crmEffectivePrice: number | null; crmPriceText: string;
  promoActive: boolean | null;
  goldenCustomerText: string; goldenOldPrices: number[];
  stitchedReply: string; stitchedVerdict: "PASS" | "BLOCK";
  oldPriceReply: string | null; oldPriceVerdict: "PASS" | "BLOCK" | null; oldPriceBlockReason: string | null;
};
const fmtVnd = (n: number) => `${Math.round(n).toLocaleString("vi-VN")}đ`;
const SERVICE_VN: Record<string, string> = {
  wedding_album: "Album cưới", wedding_gate: "Ảnh cổng", wedding_party: "Phóng sự cưới",
  family: "Chụp gia đình", maternity: "Chụp bầu", beauty: "Beauty / Kỷ yếu", rental_outfit: "Thuê váy/đồ",
};
const svcVn = (k: string | null | undefined) => (k ? (SERVICE_VN[k] ?? k) : null);

type TestResult = {
  stageVn?: string;
  memoryVN?: string[];
  dataSources?: string[];
  winner: { key: string; name: string } | null;
  losers: Array<{ key: string; name: string; reason: string; detail?: string }>;
  explain: string;
  action: string; stage: string; baselineAction: string; actionChanged: boolean;
  forbiddenQuestions: string[]; knowledge: string[];
  guidance: string | null; closingLine: string | null;
  replyText: string | null; replyError: string | null; provider: string;
  goldenUsed?: Array<{ customerText: string; idealResponse: string }>;
  priceEvidence?: PriceEvidence | null;
  serviceTrail?: { current: string | null; previous: string | null; referenced: string[]; switched: boolean } | null;
  validator: { verdict: string; reason?: string; violatedRule?: string; suggestedRecovery?: string };
  verdict: string;
  stateBefore: unknown; stateAfter: unknown;
};

const ACTION_VN_FALLBACK: Record<string, string> = {
  GREET: "chào hỏi", ASK_SERVICE: "hỏi nhu cầu", IDENTIFY_SERVICE: "đào sâu gu",
  ASK_DATE: "hỏi ngày", QUOTE_REFERENCE: "báo giá tham khảo", QUOTE_EXACT: "báo giá chính thức",
  SEND_PRICE: "gửi bảng giá", SEND_SAMPLE: "gửi ảnh mẫu", ANSWER_FAQ: "trả lời câu hỏi",
  HANDLE_OBJECTION: "xử lý băn khoăn", ASK_FOR_BOOKING: "mời giữ lịch", ASK_PHONE: "xin SĐT",
  ESCALATE_HUMAN: "chuyển người thật", WAIT: "đáp nhẹ, chờ khách",
};
const actionVn = (a: string) => ACTION_VN_FALLBACK[a] ?? a;

// ─── Badge nhỏ ────────────────────────────────────────────────────────────────

function VerdictBadge({ verdict }: { verdict: string | null | undefined }) {
  const v = verdictInfo(verdict);
  const cls = v.tone === "ok" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : v.tone === "warn" ? "bg-amber-50 text-amber-700 border-amber-200"
    : v.tone === "block" ? "bg-rose-50 text-rose-700 border-rose-200"
    : "bg-gray-50 text-gray-500 border-gray-200";
  return <span className={`inline-flex items-center gap-1 text-[11px] border rounded-full px-2 py-0.5 ${cls}`}>
    {v.tone === "ok" ? <Check className="w-3 h-3" /> : v.tone === "none" ? null : <AlertTriangle className="w-3 h-3" />}
    {v.label}
  </span>;
}

function StatusBadge({ rec }: { rec: ScenarioRecord }) {
  const s = statusLabel(rec);
  const cls = s.tone === "active" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : s.tone === "draft" ? "bg-amber-50 text-amber-700 border-amber-200"
    : "bg-gray-100 text-gray-500 border-gray-200";
  return <span className={`text-[11px] border rounded-full px-2 py-0.5 ${cls}`}>{s.label}</span>;
}

// ─── Bằng chứng giá: KỊCH BẢN (cách nói) vs CRM (giá thật) ────────────────────

function PriceEvidenceCard({ e }: { e: PriceEvidence }) {
  return (
    <div className="border border-emerald-200 bg-emerald-50/50 rounded-lg p-2.5 space-y-2 text-[12px]">
      <p className="font-semibold text-emerald-800 flex items-center gap-1">💡 Bằng chứng: giữ CÁCH NÓI kịch bản, LẤY GIÁ từ CRM</p>

      <div className="grid grid-cols-2 gap-2">
        <div className="bg-white border rounded-lg p-2">
          <p className="text-[10px] uppercase text-gray-400 mb-0.5">CRM · giá thật hiện tại</p>
          <p className="text-gray-700">{e.serviceLabel ?? "—"}{e.crmGroupName ? ` · ${e.crmGroupName}` : ""}</p>
          <p className="font-semibold text-emerald-700 text-[15px]">{e.crmPriceText}
            {e.crmBasePrice != null && e.crmEffectivePrice != null && e.crmEffectivePrice < e.crmBasePrice &&
              <span className="text-gray-400 line-through font-normal text-[11px] ml-1">{fmtVnd(e.crmBasePrice)}</span>}
          </p>
          <p className="text-[10px] text-gray-400">{e.promoActive ? "đang có ưu đãi CRM" : "không ưu đãi"}</p>
        </div>
        <div className="bg-white border rounded-lg p-2">
          <p className="text-[10px] uppercase text-gray-400 mb-0.5">Kịch bản (golden) · cách nói</p>
          <p className="text-gray-600 italic">“{e.goldenCustomerText}”</p>
          {e.goldenOldPrices.length > 0
            ? <p className="text-[10px] text-amber-600">có giá cũ: {e.goldenOldPrices.map(fmtVnd).join(", ")} → KHÔNG dùng</p>
            : <p className="text-[10px] text-gray-400">không chứa số tiền (dùng {"{{PRICE}}"})</p>}
        </div>
      </div>

      <div className="bg-white border rounded-lg p-2">
        <p className="text-[10px] uppercase text-gray-400 mb-0.5">→ Câu Lulu (ghép: cách nói + giá CRM)</p>
        <p className="text-gray-800 whitespace-pre-line">{e.stitchedReply}</p>
        <span className={`inline-flex items-center gap-1 text-[10px] border rounded-full px-2 py-0.5 mt-1 ${e.stitchedVerdict === "PASS" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}>
          {e.stitchedVerdict === "PASS" ? "✓ Validator cho qua (giá khớp CRM)" : "✗ Validator chặn"}
        </span>
      </div>

      {e.oldPriceReply && (
        <div className="bg-rose-50/60 border border-rose-200 rounded-lg p-2">
          <p className="text-[10px] uppercase text-rose-400 mb-0.5">Nếu Lulu lỡ đọc y nguyên giá cũ trong kịch bản</p>
          <p className="text-gray-500 line-through whitespace-pre-line">{e.oldPriceReply}</p>
          <span className={`inline-flex items-center gap-1 text-[10px] border rounded-full px-2 py-0.5 mt-1 ${e.oldPriceVerdict === "BLOCK" ? "bg-rose-100 text-rose-700 border-rose-300" : "bg-gray-50 text-gray-500 border-gray-200"}`}>
            {e.oldPriceVerdict === "BLOCK" ? "✗ Validator CHẶN — không gửi giá cũ cho khách" : "—"}
          </span>
          {e.oldPriceBlockReason && <p className="text-[10px] text-rose-600 mt-0.5">{e.oldPriceBlockReason}</p>}
        </div>
      )}
    </div>
  );
}

// ─── Panel TEST THỬ ───────────────────────────────────────────────────────────

function TestPanel({ scenarioKey, hasDraft, onClose }: { scenarioKey: string; hasDraft: boolean; onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [multiline, setMultiline] = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [after, setAfter] = useState<TestResult | null>(null);
  const [before, setBefore] = useState<TestResult | null>(null);
  const [turns, setTurns] = useState<Array<TestResult & { message: string }>>([]);
  const [advOpen, setAdvOpen] = useState(false);

  const run = async () => {
    setErr(null); setRunning(true); setAfter(null); setBefore(null); setTurns([]);
    try {
      if (multiline) {
        const messages = message.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 8);
        const r = await apiSend<{ turns: Array<TestResult & { message: string }> }>(
          "POST", `/lulu-scenarios/test-conversation`, { messages, draftOf: scenarioKey });
        setTurns(r.turns);
      } else {
        const r = await apiSend<{ after: TestResult; before: TestResult | null }>(
          "POST", `/lulu-scenarios/${scenarioKey}/test`, { message, compare: hasDraft });
        setAfter(r.after); setBefore(r.before);
      }
    } catch (e) { setErr(String((e as Error).message)); }
    finally { setRunning(false); }
  };

  const Col = ({ title, r }: { title: string; r: TestResult }) => (
    <div className="flex-1 min-w-0 space-y-2 border rounded-lg p-3 bg-white">
      <p className="text-xs font-semibold text-gray-600">{title}</p>
      <div className="text-[12px] space-y-1.5">
        <p><span className="text-gray-400">Lulu hiểu:</span> {r.explain}</p>
        {r.stageVn && <p><span className="text-gray-400">Khách đang ở giai đoạn:</span> <b>{r.stageVn}</b></p>}
        <p><span className="text-gray-400">Kịch bản đang dùng:</span> <b>{r.winner ? r.winner.name : "— (theo hệ thống)"}</b></p>
        {r.memoryVN && r.memoryVN.length > 0 && (
          <div><span className="text-gray-400">Lulu đang nhớ:</span>
            <ul className="ml-4 list-disc text-gray-600">{r.memoryVN.map((m, i) => <li key={i}>{m}</li>)}</ul>
          </div>
        )}
        {r.dataSources && r.dataSources.length > 0 && (
          <p><span className="text-gray-400">Dữ liệu lấy từ:</span> {r.dataSources.join(" · ")}</p>
        )}
        {r.serviceTrail?.current && (
          <p><span className="text-gray-400">Dịch vụ đang bàn:</span> <b>{svcVn(r.serviceTrail.current)}</b>
            {r.serviceTrail.switched && r.serviceTrail.previous &&
              <span className="text-violet-600"> (vừa chuyển từ: {svcVn(r.serviceTrail.previous)})</span>}
          </p>
        )}
        {r.goldenUsed && r.goldenUsed.length > 0 && (
          <div><span className="text-gray-400">Học giọng từ mẫu bảng ({r.goldenUsed.length}):</span>
            <ul className="ml-4 list-disc text-gray-600">{r.goldenUsed.map((g, i) => <li key={i} className="truncate">“{g.customerText}”</li>)}</ul>
            <span className="text-[10px] text-gray-400">(chỉ tham khảo cách nói — con số giá vẫn lấy realtime từ bảng giá)</span>
          </div>
        )}
        <p><span className="text-gray-400">Lulu sẽ làm:</span> {actionVn(r.action)}
          {r.actionChanged && <span className="text-violet-600"> (thẻ đổi từ: {actionVn(r.baselineAction)})</span>}</p>
        {r.forbiddenQuestions.length > 0 && (
          <p><span className="text-gray-400">Bị cấm:</span> {r.forbiddenQuestions.map((q) =>
            q === "ask_date" ? "hỏi lại ngày" : q === "ask_phone" ? "xin SĐT" : q === "self_discount" ? "tự giảm giá" : q).join(", ")}</p>
        )}
      </div>
      <div className="border-t pt-2">
        <p className="text-[11px] text-gray-400 mb-1">Câu trả lời thử ({r.provider}):</p>
        {r.replyText
          ? <div className="text-[13px] bg-gray-50 rounded-lg p-2 whitespace-pre-line">{r.replyText}</div>
          : <div className="text-[12px] text-amber-700 bg-amber-50 rounded-lg p-2">{r.replyError ?? "Không có câu trả lời"}</div>}
      </div>
      <div className="flex items-center gap-2">
        <VerdictBadge verdict={r.verdict} />
        {r.validator.verdict === "BLOCK" && (
          <span className="text-[11px] text-rose-600">{r.validator.reason}</span>
        )}
      </div>
      {r.priceEvidence && <PriceEvidenceCard e={r.priceEvidence} />}
      {r.losers.length > 0 && (
        <details className="text-[11px] text-gray-500">
          <summary className="cursor-pointer">Thẻ bị loại ({r.losers.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {r.losers.map((l) => <li key={l.key}>• {l.name}: {l.reason === "dang_tat" ? "đang tắt"
              : l.reason === "trigger_khong_khop" ? "tình huống không khớp"
              : l.reason === "dieu_kien_khong_khop" ? `điều kiện không đúng${l.detail ? ` (${l.detail})` : ""}`
              : l.reason === "thieu_du_lieu" ? `thiếu dữ liệu${l.detail ? ` (${l.detail})` : ""}`
              : `thua ưu tiên${l.detail ? ` (${l.detail})` : ""}`}</li>)}
          </ul>
        </details>
      )}
    </div>
  );

  return (
    <div className="border rounded-xl bg-violet-50/40 border-violet-200 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium flex items-center gap-1.5"><FlaskConical className="w-4 h-4 text-violet-600" /> Test thử — không gửi Messenger thật</p>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
      </div>
      <div className="flex items-center gap-2 text-[12px]">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={multiline} onChange={(e) => setMultiline(e.target.checked)} />
          Hội thoại nhiều lượt (mỗi dòng 1 câu khách)
        </label>
        {hasDraft && !multiline && <span className="text-violet-700">Có bản nháp → tự so sánh TRƯỚC / SAU</span>}
      </div>
      <div className="flex gap-2">
        {multiline ? (
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3}
            placeholder={"Chị chưa biết ngày, cho chị tham khảo giá chụp cưới\nCó mẫu nào đẹp không\nGói đó gồm những gì"}
            className="flex-1 border rounded-lg px-3 py-2 text-sm" />
        ) : (
          <input value={message} onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && message.trim() && !running) run(); }}
            placeholder="Chị chưa biết ngày, cho chị tham khảo giá trước…"
            className="flex-1 border rounded-lg px-3 py-2 text-sm" />
        )}
        <button disabled={running || !message.trim()} onClick={run}
          className="bg-violet-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5">
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />} Gửi thử
        </button>
      </div>
      {err && <p className="text-[12px] text-rose-600">{err}</p>}
      {(after || before) && (
        <div className="flex gap-3 flex-col md:flex-row">
          {before && <Col title="TRƯỚC KHI SỬA (bản đang dùng)" r={before} />}
          {after && <Col title={before ? "SAU KHI SỬA (bản nháp)" : "KẾT QUẢ"} r={after} />}
        </div>
      )}
      {turns.length > 0 && (
        <div className="space-y-2">
          {turns.map((t, i) => (
            <div key={i} className="space-y-1">
              <div className="flex justify-end"><span className="bg-blue-600 text-white text-[13px] rounded-2xl px-3 py-1.5 max-w-[70%]"><User className="w-3 h-3 inline mr-1" />{t.message}</span></div>
              <div className="flex items-start gap-2">
                <Bot className="w-4 h-4 text-violet-500 mt-1.5 shrink-0" />
                <div className="max-w-[85%]">
                  <div className="bg-white border text-[13px] rounded-2xl px-3 py-1.5 whitespace-pre-line">{t.replyText ?? t.replyError ?? "…"}</div>
                  <p className="text-[11px] text-gray-400 mt-0.5">Thẻ: {t.winner?.name ?? "theo hệ thống"} · {actionVn(t.action)} · <VerdictBadge verdict={t.verdict} /></p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {(after || turns.length > 0) && (
        <div className="border-t border-violet-200 pt-2">
          <button onClick={() => setAdvOpen(!advOpen)} className="text-[11px] text-gray-500 flex items-center gap-1">
            {advOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} Xem kỹ thuật nâng cao (stage / action / state / validator)
          </button>
          {advOpen && (
            <pre className="mt-1 text-[10px] bg-gray-900 text-gray-100 rounded-lg p-2 max-h-64 overflow-auto">
              {JSON.stringify(after ?? turns, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── EDITOR 1 thẻ ─────────────────────────────────────────────────────────────

function CardEditor({ rec, labels, allRecords, isAdmin, seedCard, seedIssues, onSaved, onClose, showOk, showErr }: {
  rec: ScenarioRecord | null; // null = tạo mới
  labels: ScenarioLabels;
  allRecords: ScenarioRecord[];
  isAdmin: boolean;
  /** Thẻ nháp AI đề xuất (chỉ dùng khi tạo mới). */
  seedCard?: ScenarioCard | null;
  seedIssues?: Issue[];
  onSaved: () => void;
  onClose: () => void;
  showOk: (m: string) => void;
  showErr: (m: string) => void;
}) {
  const [card, setCard] = useState<ScenarioCard>(() => rec ? (displayCard(rec) ?? emptyCard()) : (seedCard ?? emptyCard()));
  const [issues, setIssues] = useState<Issue[]>(seedIssues ?? []);
  const [saving, setSaving] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  // Mặc định GIẤU phần kỹ thuật (chip điều kiện, điều cấm, dữ liệu, chuyển tiếp) — chủ studio
  // chỉ thấy 3 ô đơn giản; thẻ mới thì mở sẵn để đặt "khi nào dùng".
  const [showDetail, setShowDetail] = useState(rec == null);
  const isNew = rec == null;
  const set = (patch: Partial<ScenarioCard>) => setCard((c) => ({ ...c, ...patch }));

  const toggleIn = (arr: string[], key: string) => arr.includes(key) ? arr.filter((x) => x !== key) : [...arr, key];

  const save = async () => {
    setSaving(true); setIssues([]);
    try {
      if (isNew) {
        await apiSend("POST", "/lulu-scenarios", { card });
        showOk("Đã tạo thẻ mới (bản nháp — bấm 'Áp dụng tất cả' để chạy thật)");
      } else {
        await apiSend("PUT", `/lulu-scenarios/${rec!.scenarioKey}`, { card });
        showOk("Đã lưu bản nháp — Test thử rồi 'Áp dụng tất cả' để chạy thật");
      }
      onSaved();
    } catch (e) {
      const anyE = e as { issues?: Issue[]; message?: string };
      if (anyE.issues?.length) setIssues(anyE.issues);
      showErr(anyE.message ?? "Lưu lỗi");
    } finally { setSaving(false); }
  };

  const otherScenarios = allRecords.filter((r) => r.scenarioKey !== rec?.scenarioKey && r.status !== "archived");

  return (
    <div className="bg-white border rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="font-medium flex items-center gap-2"><Pencil className="w-4 h-4 text-violet-600" />
          {isNew ? "Tạo kịch bản mới" : `Sửa thẻ: ${card.name || rec!.scenarioKey}`}
          {rec?.isCore && <span className="text-[11px] bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5 flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> thẻ lõi an toàn</span>}
        </p>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
      </div>

      {issues.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-1.5">
          <p className="text-[12px] font-semibold text-rose-700 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Thẻ chưa hợp lệ — sửa theo gợi ý:</p>
          {issues.map((i, idx) => (
            <div key={idx} className="text-[12px] text-rose-700">
              • {i.message}
              {i.suggest && <p className="text-emerald-700 ml-3">→ {i.suggest}</p>}
            </div>
          ))}
        </div>
      )}

      <div>
        <label className="text-[11px] font-semibold text-gray-500">A. TÊN TÌNH HUỐNG</label>
        <input value={card.name} onChange={(e) => set({ name: e.target.value })}
          placeholder="Vd: Khách hỏi giá nhưng chưa biết ngày" className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
      </div>

      {/* Dòng tóm tắt "khi nào dùng" — luôn hiện, tiếng Việt, không chip rối. */}
      <div className="bg-gray-50 border rounded-lg px-3 py-2 text-[12px] text-gray-600">
        <span className="text-gray-400">Thẻ này dùng khi khách: </span>
        <b>{summarizeWhen(card, labels)}</b>
      </div>

      {/* C — Ô CHÍNH chủ studio sửa hằng ngày. */}
      <div>
        <label className="text-sm font-semibold text-gray-700">Lulu nên nói / làm gì trong tình huống này?</label>
        <p className="text-[11px] text-gray-400 mb-1">Viết lời dặn tự nhiên như dặn nhân viên. Lulu tự diễn đạt lại, không đọc y nguyên.</p>
        <textarea value={card.guidance} onChange={(e) => set({ guidance: e.target.value })} rows={4}
          placeholder="Vd: Báo giá tham khảo đúng nhóm, nói ngắn gọn, gợi ý xem ảnh mẫu nếu hợp…"
          className="w-full border rounded-lg px-3 py-2 text-sm" />
      </div>

      {/* F — câu kết. */}
      <div>
        <label className="text-sm font-semibold text-gray-700">Câu kết gợi ý</label>
        <p className="text-[11px] text-gray-400 mb-1">Câu chốt cuối lượt (Lulu diễn đạt lại tự nhiên, không đọc y nguyên).</p>
        <input value={card.closingLine} onChange={(e) => set({ closingLine: e.target.value })}
          placeholder="Vd: Khi nào mình có ngày cụ thể, em kiểm tra lịch và xác nhận lại cho mình nha."
          className="w-full border rounded-lg px-3 py-2 text-sm" />
      </div>

      {/* Nút mở phần kỹ thuật — mặc định ẩn để chủ studio đỡ rối. */}
      <button onClick={() => setShowDetail(!showDetail)}
        className="w-full text-[12px] text-gray-500 flex items-center justify-center gap-1.5 border rounded-lg py-2 hover:bg-gray-50">
        {showDetail ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        Cài đặt chi tiết (khi nào dùng · điều cấm · dữ liệu · chuyển tiếp)
      </button>

      {showDetail && (<>
      <div>
        <label className="text-[11px] font-semibold text-gray-500">KHI KHÁCH… (chọn các tình huống áp dụng)</label>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {Object.entries(labels.triggers).map(([k, l]) => (
            <button key={k} onClick={() => set({ triggers: toggleIn(card.triggers, k) })}
              className={`text-[12px] border rounded-full px-2.5 py-1 ${card.triggers.includes(k)
                ? "bg-violet-600 text-white border-violet-600" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="grid sm:grid-cols-2 gap-2 mt-2">
          {([
            ["serviceIntent", ["any", "known", "unknown"]],
            ["dateStatus", ["any", "known", "not_decided", "unset"]],
            ["quoted", ["any", "yes", "no"]],
            ["firstContact", ["any", "yes", "no"]],
          ] as Array<[keyof ScenarioCard["conditions"], string[]]>).map(([field, opts]) => (
            <select key={field} value={card.conditions[field]}
              onChange={(e) => set({ conditions: { ...card.conditions, [field]: e.target.value } as ScenarioCard["conditions"] })}
              className="border rounded-lg px-2 py-1.5 text-[12px]">
              {opts.map((o) => <option key={o} value={o}>{(labels.conditions[field] as Record<string, string>)[o] ?? o}</option>)}
            </select>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-gray-400">Hành động chính:</span>
        <select value={card.primaryAction} onChange={(e) => set({ primaryAction: e.target.value })}
          className="border rounded-lg px-2 py-1 text-[12px]">
          {Object.entries(labels.actions).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      <div>
        <label className="text-[11px] font-semibold text-gray-500">ĐỪNG BAO GIỜ…</label>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {labels.coreForbidden.map((k) => (
            <span key={k} title="Luật an toàn khoá sẵn trong hệ thống — không tắt được"
              className="text-[12px] border border-rose-200 bg-rose-50 text-rose-600 rounded-full px-2.5 py-1 flex items-center gap-1">
              <Lock className="w-3 h-3" /> {labels.forbidden[k]}
            </span>
          ))}
          {Object.entries(labels.forbidden).filter(([k]) => !labels.coreForbidden.includes(k)).map(([k, l]) => (
            <button key={k} onClick={() => set({ forbiddenExtra: toggleIn(card.forbiddenExtra, k) })}
              className={`text-[12px] border rounded-full px-2.5 py-1 ${card.forbiddenExtra.includes(k)
                ? "bg-rose-600 text-white border-rose-600" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[11px] font-semibold text-gray-500">CẦN BIẾT… (dữ liệu Lulu được dùng cho tình huống này)</label>
        <div className="flex flex-wrap gap-3 mt-1">
          {Object.entries(labels.knowledge).map(([k, l]) => (
            <label key={k} className="text-[12px] flex items-center gap-1.5">
              <input type="checkbox" checked={card.knowledge.includes(k)}
                onChange={() => set({ knowledge: toggleIn(card.knowledge, k) })} />
              {l}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="text-[11px] font-semibold text-gray-500">ĐIỀU KIỆN THOÁT (mỗi dòng 1 ý — để người vận hành hiểu thẻ kết thúc khi nào)</label>
        <textarea value={card.exitConditions.join("\n")}
          onChange={(e) => set({ exitConditions: e.target.value.split("\n") })}
          onBlur={(e) => set({ exitConditions: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
          rows={2} placeholder={"khách cung cấp ngày\nkhách chọn gói"}
          className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
      </div>

      <div>
        <label className="text-[11px] font-semibold text-gray-500">CHUYỂN SANG KỊCH BẢN… KHI…</label>
        <div className="space-y-1.5 mt-1">
          {card.nextScenarios.map((n, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={n.whenVn} placeholder="khi khách…"
                onChange={(e) => set({ nextScenarios: card.nextScenarios.map((x, j) => j === i ? { ...x, whenVn: e.target.value } : x) })}
                className="flex-1 border rounded-lg px-2 py-1.5 text-[12px]" />
              <ArrowRight className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <select value={n.scenarioKey}
                onChange={(e) => set({ nextScenarios: card.nextScenarios.map((x, j) => j === i ? { ...x, scenarioKey: e.target.value } : x) })}
                className="border rounded-lg px-2 py-1.5 text-[12px] max-w-[220px]">
                <option value="">— chọn kịch bản —</option>
                {otherScenarios.map((s) => <option key={s.scenarioKey} value={s.scenarioKey}>{displayCard(s)?.name ?? s.scenarioKey}</option>)}
              </select>
              <button onClick={() => set({ nextScenarios: card.nextScenarios.filter((_, j) => j !== i) })}
                className="text-gray-400 hover:text-rose-500"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <button onClick={() => set({ nextScenarios: [...card.nextScenarios, { whenVn: "", scenarioKey: "" }] })}
            className="text-[12px] text-violet-600 flex items-center gap-1"><Plus className="w-3 h-3" /> thêm chuyển tiếp</button>
        </div>
      </div>
      </>)}

      <div className="border-t pt-2">
        <button onClick={() => setAdvOpen(!advOpen)} className="text-[11px] text-gray-500 flex items-center gap-1">
          {advOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} Kỹ thuật nâng cao (dữ liệu máy đọc)
        </button>
        {advOpen && <pre className="mt-1 text-[10px] bg-gray-900 text-gray-100 rounded-lg p-2 max-h-48 overflow-auto">{JSON.stringify(card, null, 2)}</pre>}
      </div>

      <div className="flex items-center gap-2 border-t pt-3">
        {isAdmin ? (
          <button disabled={saving} onClick={save}
            className="bg-violet-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {isNew ? "Tạo thẻ (bản nháp)" : "Lưu bản nháp"}
          </button>
        ) : <span className="text-[12px] text-gray-400">Sửa thẻ cần quyền admin</span>}
        {!isNew && (
          <button onClick={() => setTestOpen(!testOpen)} className="border text-sm px-4 py-2 rounded-lg hover:bg-gray-50 flex items-center gap-1.5">
            <FlaskConical className="w-4 h-4" /> Test thử
          </button>
        )}
        {!isNew && rec!.draftCard && isAdmin && (
          <button onClick={async () => {
            try { await apiSend("POST", `/lulu-scenarios/${rec!.scenarioKey}/discard-draft`); showOk("Đã hủy bản nháp"); onSaved(); }
            catch (e) { showErr(String((e as Error).message)); }
          }} className="text-rose-600 border border-rose-200 text-sm px-3 py-2 rounded-lg hover:bg-rose-50 flex items-center gap-1.5">
            <Trash2 className="w-4 h-4" /> Hủy nháp
          </button>
        )}
      </div>

      {testOpen && !isNew && <TestPanel scenarioKey={rec!.scenarioKey} hasDraft={!!rec!.draftCard} onClose={() => setTestOpen(false)} />}
    </div>
  );
}

// ─── AI DRAFT modal ───────────────────────────────────────────────────────────

function AiDraftBox({ onDraft, onClose, showErr }: {
  onDraft: (card: ScenarioCard, issues: Issue[]) => void; onClose: () => void; showErr: (m: string) => void;
}) {
  const [desc, setDesc] = useState("");
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="bg-white border border-violet-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-medium flex items-center gap-2"><Wand2 className="w-4 h-4 text-violet-600" /> Nhờ AI viết kịch bản</p>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
      </div>
      <p className="text-[12px] text-gray-500">Mô tả vấn đề bằng 1–2 câu. AI tạo BẢN NHÁP để bạn duyệt và sửa — không tự áp dụng.</p>
      <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2}
        placeholder="Vd: Lulu cứ hỏi lại ngày dù khách đã nói chưa biết ngày."
        className="w-full border rounded-lg px-3 py-2 text-sm" />
      <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={3}
        placeholder="(Tuỳ chọn) Dán đoạn chat Lulu trả lời chưa tốt vào đây…"
        className="w-full border rounded-lg px-3 py-2 text-[12px]" />
      <button disabled={busy || (!desc.trim() && !transcript.trim())} onClick={async () => {
        setBusy(true);
        try {
          const r = await apiSend<{ card: ScenarioCard; issues: Issue[] }>("POST", "/lulu-scenarios/ai-draft", { description: desc, transcript });
          onDraft(r.card, r.issues ?? []);
        } catch (e) { showErr(String((e as Error).message)); }
        finally { setBusy(false); }
      }} className="bg-violet-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1.5">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} Tạo bản nháp đề xuất
      </button>
    </div>
  );
}

// ─── Trang chính ──────────────────────────────────────────────────────────────

// ─── CÂY KỊCH BẢN (folder thu gọn +/−) ──────────────────────────────────────

type TreeNodeFE = {
  nodeKey: string; parentKey: string | null;
  nodeType: "greeting" | "service" | "step" | "leaf" | "pricing" | "stage" | "group" | "subgroup";
  title: string; serviceKey: string | null; scenarioKey: string | null; priceSource?: string | null;
  children: TreeNodeFE[];
  meta?: { groupName?: string | null; packageCount?: number; situationCount?: number; filledCount?: number; priceConnected?: boolean; showPricing?: boolean; imageUrl?: string | null; hasScript?: boolean; autoGenerated?: boolean };
  scenario?: { name: string; enabled: boolean; status: string; whenText: string; missing?: boolean } | null;
};

// Ngữ cảnh khi mở 1 bảng Hỏi & Trả lời — đủ để hiện breadcrumb + đọc đúng bảng giá + tự điền.
type ScriptTarget = {
  nodeKey: string; scenarioKey: string | null; serviceKey: string | null;
  title: string; groupName?: string | null; serviceTitle?: string; stepTitle?: string; situationTitle?: string;
};
type TreeCtx = { serviceTitle?: string; groupName?: string | null; stepTitle?: string };

type PreviewResp = { groups: Array<{ groupName: string; packages: Array<{ code: string }>; imageUrl?: string | null }> };

function PricingNode({ serviceKey, groupName, variant = "tree" }: { serviceKey: string | null; groupName?: string | null; variant?: "tree" | "card" }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [compactIds, setCompactIds] = useState<Set<number>>(new Set()); // gói đang thu gọn (chỉ tên + giá)
  // price-preview = NGUỒN THẨM QUYỀN: đúng bộ gói ENGINE Lulu dùng (đã lọc gói hợp lệ có mã) + ảnh nhóm.
  // /service-packages = data ĐẦY ĐỦ (mô tả/chi phí/loại DV/discount) để dựng card giống trang Bảng giá.
  const qs = groupName ? `group=${encodeURIComponent(groupName)}` : `service=${encodeURIComponent(serviceKey ?? "")}`;
  const { data: preview, isLoading: pvLoading, error: pvErr } = useQuery<PreviewResp>({
    queryKey: ["lulu-price-preview", groupName ?? serviceKey ?? ""], queryFn: () => apiGet<PreviewResp>(`/lulu-scenarios/price-preview?${qs}`),
  });
  const { data: pkgs, isLoading: pLoading, error: pErr } = useQuery<PricePkg[]>({
    queryKey: ["service-packages"], queryFn: () => apiGet<PricePkg[]>("/service-packages"),
  });
  const loading = pvLoading || pLoading;
  const err = (pvErr || pErr) as Error | null;

  // CHỈ hiện gói mà engine thật sự dùng (khớp mã) — KHÔNG hiện gói không mã / giá đối tác nội bộ.
  const codes = new Set((preview?.groups ?? []).flatMap((g) => g.packages).map((p) => (p.code ?? "").trim().toUpperCase()).filter(Boolean));
  const list = (pkgs ?? [])
    .filter((p) => codes.has((p.code ?? "").trim().toUpperCase()) && p.isActive !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const rawImg = preview?.groups?.find((g) => g.imageUrl)?.imageUrl ?? null;
  const imageUrl = rawImg ? getImageSrc(rawImg) : null;
  const bare = variant === "card";
  const allCompact = list.length > 0 && list.every((p) => compactIds.has(p.id));
  const toggleCard = (id: number) => setCompactIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAllCompact = () => setCompactIds(allCompact ? new Set() : new Set(list.map((p) => p.id)));

  return (
    <div className={bare
      ? "rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 text-[12px]"
      : "ml-6 my-1 border-l-2 border-emerald-200 pl-3 py-1 text-[12px]"}>
      <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
        <p className="text-emerald-800 font-semibold flex items-center gap-1.5 text-[13px]">💰 BẢNG GIÁ REALTIME{groupName ? ` — ${groupName}` : ""}</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-emerald-600 bg-white border border-emerald-200 rounded-full px-2 py-0.5">🔄 đọc thẳng từ Bảng giá</span>
          {!collapsed && list.length > 0 && (
            <button onClick={toggleAllCompact}
              className="text-[11px] text-gray-600 border border-gray-300 bg-white rounded-full px-2 py-0.5 hover:bg-gray-50 flex items-center gap-0.5">
              {allCompact ? <><ChevronDown className="w-3 h-3" /> Mở chi tiết gói</> : <><ChevronUp className="w-3 h-3" /> Gọn gói (tên + giá)</>}
            </button>
          )}
          <button onClick={() => setCollapsed((c) => !c)}
            className="text-[11px] text-emerald-700 border border-emerald-300 bg-white rounded-full px-2 py-0.5 hover:bg-emerald-50 flex items-center gap-0.5">
            {collapsed ? <><ChevronDown className="w-3 h-3" /> Hiện bảng giá ({list.length})</> : <><ChevronUp className="w-3 h-3" /> Ẩn bảng giá</>}
          </button>
        </div>
      </div>

      {!collapsed && <>
        {loading && <p className="text-gray-400 mt-1">Đang đọc bảng giá…</p>}
        {err && <p className="text-rose-600 mt-1">Không đọc được giá: {err.message}</p>}
        {!loading && !err && list.length === 0 && <p className="text-amber-600 mt-1">Chưa có gói nào — mở "Dịch vụ &amp; Bảng giá" thêm gói cho nhóm này.</p>}

        {imageUrl && (
          <img src={imageUrl} alt={`Bảng giá ${groupName ?? ""}`} onClick={() => setZoom(imageUrl)}
            className="mt-1.5 rounded-lg border border-emerald-200 max-h-56 w-auto cursor-zoom-in hover:opacity-90"
            title="Ảnh bảng giá (đồng bộ từ Dịch vụ & Bảng giá) — bấm để phóng to" />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 mt-2">
          {list.map((p) => <PackagePriceCard key={p.id} pkg={p} collapsed={compactIds.has(p.id)} onToggle={() => toggleCard(p.id)} />)}
        </div>
      </>}

      {zoom && (
        <div onClick={() => setZoom(null)} className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-6 cursor-zoom-out">
          <img src={zoom} alt="Bảng giá" className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl" />
        </div>
      )}

      <a href={`/pricing${groupName ? `?group=${encodeURIComponent(groupName)}` : ""}`}
        className="inline-block mt-2 text-violet-600 font-medium">Mở bảng giá đầy đủ →</a>
    </div>
  );
}

type ScriptField = "groupLabel" | "situationLabel" | "customerText" | "idealResponse" | "notes";
type ScriptRowFE = { groupLabel: string; situationLabel: string; customerText: string; idealResponse: string; notes: string; isActive: boolean };
const EMPTY_ROW = (): ScriptRowFE => ({ groupLabel: "", situationLabel: "", customerText: "", idealResponse: "", notes: "", isActive: true });

const FIELD_LABELS: Record<ScriptField, string> = {
  groupLabel: "Nhóm", situationLabel: "Tình huống", customerText: "Khách hỏi / nói", idealResponse: "Lulu nên trả lời", notes: "Ghi chú",
};

const hasHardcodedPriceFE = (t: string) => /(\d{1,3}([.,]\d{3}){1,3}\s*(đ|d|vnd|k|tr|triệu)|\d+\s*(triệu|tr\b)|\d{2,4}\s*k\b)/i.test(t ?? "");

function parseMatrixFE(text: string): string[][] {
  return (text ?? "").replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim())
    .map((line) => (line.includes("\t") ? line.split("\t") : line.split(/\s*\|\s*|\s{2,}/)).map((c) => c.trim()));
}
function looksLikeHeaderFE(cols: string[]): boolean {
  const j = cols.join(" ").toLowerCase();
  return ["nhóm", "nhom", "tình huống", "tinh huong", "khách", "khach", "trả lời", "tra loi", "ghi chú", "sale"].filter((k) => j.includes(k)).length >= 2;
}
// Suy mapping mặc định theo số cột (thứ tự chuẩn: Nhóm|Tình huống|Khách|Trả lời|Ghi chú).
function defaultMapping(colCount: number): ScriptField[] {
  if (colCount >= 5) return ["groupLabel", "situationLabel", "customerText", "idealResponse", "notes"];
  if (colCount === 4) return ["groupLabel", "situationLabel", "customerText", "idealResponse"];
  if (colCount === 3) return ["customerText", "idealResponse", "notes"];
  return ["customerText", "idealResponse"];
}
function matrixToRowsFE(matrix: string[][], mapping: (ScriptField | "skip")[], dropHeader: boolean): ScriptRowFE[] {
  const body = dropHeader ? matrix.slice(1) : matrix;
  const out: ScriptRowFE[] = [];
  for (const cols of body) {
    const r = EMPTY_ROW();
    mapping.forEach((f, idx) => { if (f !== "skip" && cols[idx] != null) (r as Record<string, unknown>)[f] = cols[idx]; });
    if (!r.customerText && !r.idealResponse) continue;
    out.push(r);
  }
  return out;
}

// Thay các cụm SỐ TIỀN trong câu bằng {{PRICE}} (giữ chữ xung quanh).
const MONEY_RE_G = /(\d{1,3}(?:[.,]\d{3}){1,3}\s*(?:đ|d|vnd)?|\d+\s*(?:triệu|tr)\b|\d{2,4}\s*k\b)/gi;
const suggestPriceReplace = (t: string) => (t ?? "").replace(MONEY_RE_G, "{{PRICE}}");

type PasteState = { text: string; matrix: string[][]; mapping: (ScriptField | "skip")[]; dropHeader: boolean };
const MAP_CHOICES: (ScriptField | "skip")[] = ["groupLabel", "situationLabel", "customerText", "idealResponse", "notes", "skip"];

function ScriptTablePanel({ nodeKey, scenarioKey, title, serviceKey, groupName, serviceTitle, stepTitle, situationTitle, isAdmin, onClose, onSaved, showOk, showErr }: {
  nodeKey: string; scenarioKey: string | null; title: string; serviceKey: string | null;
  groupName?: string | null; serviceTitle?: string; stepTitle?: string; situationTitle?: string;
  isAdmin: boolean; onClose: () => void; onSaved?: () => void; showOk: (m: string) => void; showErr: (m: string) => void;
}) {
  // Tự điền Nhóm = tên dịch vụ, Tình huống = tên tình huống (chủ khỏi gõ lại).
  const newRow = (): ScriptRowFE => ({ ...EMPTY_ROW(), groupLabel: serviceTitle ?? "", situationLabel: situationTitle ?? title ?? "" });
  const breadcrumb = [serviceTitle, stepTitle, situationTitle ?? title].filter(Boolean).join(" › ");
  const [rows, setRows] = useState<ScriptRowFE[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState("");
  const [paste, setPaste] = useState<PasteState | null>(null);
  // Excel gọn: mặc định CHỈ 2 cột (Khách hỏi · Lulu trả lời). Ghi chú + tìm kiếm nằm trong
  // "Cài đặt nâng cao" (đóng sẵn). Nhóm/Tình huống vẫn lưu DB nhưng ẨN khỏi giao diện.
  const [showNotes, setShowNotes] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [focusedCell, setFocusedCell] = useState<number | null>(null);

  const normRows = (raw: ScriptRowFE[]) => raw.map((x) => ({
    groupLabel: x.groupLabel ?? "", situationLabel: x.situationLabel ?? "",
    customerText: x.customerText, idealResponse: x.idealResponse, notes: x.notes, isActive: x.isActive !== false,
  }));

  useEffect(() => {
    setLoading(true);
    apiGet<{ rows: ScriptRowFE[] }>(`/lulu-scenarios/scripts/${encodeURIComponent(nodeKey)}`)
      .then((r) => setRows(normRows(r.rows)))
      .catch((e) => showErr(String((e as Error).message)))
      .finally(() => setLoading(false));
    // CHỈ nạp lại khi ĐỔI node — KHÔNG phụ thuộc showErr (nó tạo mới mỗi render,
    // sẽ khiến effect chạy lại lúc hiện toast và xoá mất dòng vừa dán/sửa).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeKey]);

  // Đóng modal bằng phím Esc (X vẫn là nút đóng chính; không đóng khi bấm nền để tránh mất sửa).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setRow = (i: number, patch: Partial<ScriptRowFE>) => setRows((rs) => rs.map((r, j) => j === i ? { ...r, ...patch } : r));
  const addRow = () => setRows((rs) => [...rs, newRow()]);
  const dupRow = (i: number) => setRows((rs) => [...rs.slice(0, i + 1), { ...rs[i] }, ...rs.slice(i + 1)]);
  const delRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));

  const save = async () => {
    setSaving(true);
    try {
      const r = await apiSend<{ rows: ScriptRowFE[]; priceWarnings: number[] }>("PUT", `/lulu-scenarios/scripts/${encodeURIComponent(nodeKey)}`, { scenarioKey, serviceKey, rows });
      setRows(normRows(r.rows));
      showOk(`Đã lưu ${r.rows.length} dòng${r.priceWarnings.length ? ` (⚠ ${r.priceWarnings.length} dòng có số tiền — nên dùng {{PRICE}} vì giá lấy từ bảng giá)` : ""}`);
      onSaved?.();
    } catch (e) { showErr(String((e as Error).message)); }
    finally { setSaving(false); }
  };

  // ── Paste + preview ──────────────────────────────────────────────
  const openPaste = () => setPaste({ text: "", matrix: [], mapping: defaultMapping(2), dropHeader: false });
  const onPasteText = (text: string) => {
    const matrix = parseMatrixFE(text);
    const maxCols = matrix.reduce((m, r) => Math.max(m, r.length), 0);
    const dropHeader = matrix.length > 0 && looksLikeHeaderFE(matrix[0]);
    setPaste({ text, matrix, mapping: defaultMapping(maxCols), dropHeader });
  };
  const previewRows = paste ? matrixToRowsFE(paste.matrix, paste.mapping, paste.dropHeader) : [];
  const previewMissingResp = previewRows.filter((r) => r.customerText && !r.idealResponse).length;
  const previewPriced = previewRows.filter((r) => hasHardcodedPriceFE(r.idealResponse)).length;
  const commitPaste = () => {
    // Điền sẵn Nhóm/Tình huống cho dòng dán còn trống = dịch vụ/tình huống đang mở.
    const filled = previewRows.map((r) => ({
      ...r,
      groupLabel: r.groupLabel || (serviceTitle ?? ""),
      situationLabel: r.situationLabel || (situationTitle ?? title ?? ""),
    }));
    setRows((rs) => [...rs, ...filled]);
    setPaste(null);
    showOk(`Đã thêm ${previewRows.length} dòng${previewPriced ? ` — ${previewPriced} dòng có số tiền, cân nhắc {{PRICE}}` : ""} — nhớ bấm Lưu bảng`);
  };

  const qn = q.trim().toLowerCase();
  const visible = rows.map((r, i) => ({ r, i }))
    .filter(({ r }) => !qn || `${r.customerText} ${r.idealResponse} ${r.notes}`.toLowerCase().includes(qn));

  const cell = (v: string, on: (x: string) => void, ph: string, cls = "", rows2 = 2, onFocus?: () => void) => (
    <textarea value={v} onChange={(e) => on(e.target.value)} onFocus={onFocus} rows={rows2} readOnly={!isAdmin}
      className={`w-full border rounded px-1.5 py-1 text-[13px] ${cls}`} placeholder={ph} />
  );

  // Chèn token FACT vào ô "Lulu trả lời" đang focus (hoặc dòng cuối). Giá/tên gói/nội dung/ưu đãi
  // luôn lấy realtime từ Bảng giá — chủ KHÔNG gõ số cứng.
  const TOKENS: Array<{ t: string; label: string; desc: string }> = [
    { t: "{{PRICE}}", label: "Giá", desc: "Giá hiện tại — lấy từ Bảng giá" },
    { t: "{{PACKAGE_NAME}}", label: "Tên gói", desc: "Tên gói hiện tại" },
    { t: "{{PACKAGE_CONTENT}}", label: "Nội dung gói", desc: "Nội dung/mô tả gói" },
    { t: "{{PROMOTION}}", label: "Ưu đãi", desc: "Ưu đãi đang chạy (rỗng nếu không có)" },
  ];
  const insertToken = (tok: string) => setRows((rs) => {
    if (rs.length === 0) { const r = newRow(); r.idealResponse = tok; return [r]; }
    const i = focusedCell != null && focusedCell < rs.length ? focusedCell : rs.length - 1;
    return rs.map((r, j) => j === i ? { ...r, idealResponse: (r.idealResponse ? r.idealResponse.replace(/\s*$/, "") + " " : "") + tok } : r);
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-3 sm:p-6">
     <div className="bg-white border rounded-xl shadow-2xl w-full max-w-4xl my-2 sm:my-6 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {breadcrumb && <p className="text-[11px] text-gray-400 truncate">{breadcrumb}</p>}
          <p className="font-semibold text-[15px] flex items-center gap-2"><NotebookPen className="w-4 h-4 text-violet-600 shrink-0" /> Hỏi &amp; Trả lời: {situationTitle ?? title}</p>
        </div>
        <button onClick={onClose} title="Đóng" className="text-gray-400 hover:text-gray-700 shrink-0 border rounded-lg p-1"><X className="w-4 h-4" /></button>
      </div>

      {/* BẢNG GIÁ REALTIME — luôn hiện ở trên để đối chiếu giá thật ↔ kịch bản (Req 1, 8). */}
      {(groupName || serviceKey) && (
        <PricingNode serviceKey={serviceKey} groupName={groupName} variant="card" />
      )}

      <p className="text-[12px] text-gray-500">Viết <b>câu khách hay hỏi</b> ↔ <b>câu Lulu nên trả lời</b>. Lulu học <b>giọng/cách nói</b> — không đọc y nguyên. Giá &amp; thông tin gói luôn lấy realtime từ Bảng giá qua các thẻ dưới đây.</p>

      {isAdmin && (
        <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
          <span className="text-gray-400">Chèn dữ liệu thật:</span>
          {TOKENS.map((tk) => (
            <button key={tk.t} onClick={() => insertToken(tk.t)} title={tk.desc}
              className="border border-emerald-200 bg-emerald-50 text-emerald-700 rounded-full px-2 py-0.5 hover:bg-emerald-100 font-mono">{tk.t}</button>
          ))}
          <span className="text-gray-300">→ chèn vào ô “Lulu trả lời”; giá tự lấy từ Bảng giá.</span>
        </div>
      )}

      {isAdmin && (
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={addRow} className="border text-[12px] px-3 py-1.5 rounded-lg hover:bg-gray-50 flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Thêm dòng</button>
          <button onClick={openPaste} className="border border-violet-300 text-violet-700 text-[12px] px-3 py-1.5 rounded-lg hover:bg-violet-50">📋 Dán nhiều dòng (Excel / Sheets / ChatGPT)</button>
          <button disabled={saving} onClick={save} className="bg-emerald-600 text-white text-[12px] px-4 py-1.5 rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1 ml-auto">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Lưu ({rows.length} dòng)
          </button>
        </div>
      )}

      {paste !== null && (
        <div className="border border-violet-200 bg-violet-50/40 rounded-lg p-3 space-y-2">
          <p className="text-[12px] text-gray-700 font-medium">Dán từ Excel / Google Sheets / ChatGPT — mỗi dòng một cặp, xong bấm “Thêm {previewRows.length} dòng”.</p>
          <p className="text-[11px] text-gray-500">2 cột: <b>Khách hỏi / nói</b> · <b>Lulu nên trả lời</b> (cách nhau bằng Tab hoặc dấu <b>|</b>). Nhiều cột hơn cũng được — chỉnh cột bên dưới.</p>
          <textarea value={paste.text} onChange={(e) => onPasteText(e.target.value)} rows={5}
            placeholder={"Gói này bao nhiêu tiền?\tDạ gói hiện tại {{PRICE}}, gồm {{PACKAGE_CONTENT}} ạ\nCó bao gồm in ảnh không?\tDạ có ạ, gói gồm {{PACKAGE_CONTENT}} nha chị"}
            className="w-full border rounded-lg px-2 py-1.5 text-[12px] font-mono" />

          {paste.matrix.length > 0 && (
            <>
              <div className="flex items-center gap-3 flex-wrap text-[12px]">
                <span className="text-gray-600">Đọc được <b>{paste.matrix.length}</b> dòng · <b>{paste.matrix.reduce((m, r) => Math.max(m, r.length), 0)}</b> cột.</span>
                <label className="flex items-center gap-1 text-gray-600"><input type="checkbox" checked={paste.dropHeader} onChange={(e) => setPaste({ ...paste, dropHeader: e.target.checked })} /> Bỏ dòng đầu (tiêu đề)</label>
                {previewMissingResp > 0 && <span className="text-rose-600">⚠ {previewMissingResp} dòng THIẾU câu trả lời</span>}
                {previewPriced > 0 && <span className="text-amber-600">⚠ {previewPriced} dòng có số tiền — nên dùng {"{{PRICE}}"}</span>}
              </div>
              <div className="border rounded-lg overflow-auto max-h-64 bg-white">
                <table className="w-full text-[12px]">
                  <thead className="bg-gray-50 sticky top-0"><tr>
                    {paste.mapping.map((f, ci) => (
                      <th key={ci} className="px-1.5 py-1 text-left">
                        <select value={f} onChange={(e) => { const m = [...paste.mapping]; m[ci] = e.target.value as ScriptField | "skip"; setPaste({ ...paste, mapping: m }); }}
                          className="border rounded px-1 py-0.5 text-[11px] bg-white">
                          {MAP_CHOICES.map((c) => <option key={c} value={c}>{c === "skip" ? "— bỏ qua —" : FIELD_LABELS[c]}</option>)}
                        </select>
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {(paste.dropHeader ? paste.matrix.slice(1) : paste.matrix).slice(0, 8).map((r, ri) => (
                      <tr key={ri} className="border-t">
                        {paste.mapping.map((_, ci) => <td key={ci} className="px-1.5 py-1 text-gray-700 whitespace-pre-wrap max-w-[16rem] truncate">{r[ci] ?? ""}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {previewRows.length > 8 && <p className="text-[11px] text-gray-400 px-2 py-1">… và {previewRows.length - 8} dòng nữa</p>}
              </div>
            </>
          )}
          <div className="flex gap-2">
            <button disabled={previewRows.length === 0} onClick={commitPaste} className="bg-violet-600 text-white text-[12px] px-3 py-1.5 rounded-lg disabled:opacity-40">Thêm {previewRows.length} dòng vào bảng</button>
            <button onClick={() => setPaste(null)} className="border text-[12px] px-3 py-1.5 rounded-lg">Hủy</button>
          </div>
        </div>
      )}

      {loading ? <p className="text-gray-400 text-sm py-4">Đang tải…</p> : (
        <div className="border rounded-lg overflow-auto max-h-[60vh]">
          <table className="w-full text-[13px]">
            <thead className="bg-gray-50 sticky top-0"><tr className="text-left text-[11px] text-gray-500">
              <th className="px-2 py-1.5 w-8">#</th>
              <th className="px-2 py-1.5 w-[42%]">KHÁCH HỎI / NÓI</th>
              <th className="px-2 py-1.5">LULU NÊN TRẢ LỜI</th>
              {showNotes && <th className="px-2 py-1.5 w-[18%]">GHI CHÚ</th>}
              <th className="w-12"></th>
            </tr></thead>
            <tbody>
              {visible.map(({ r, i }) => (
                <tr key={i} className="border-t align-top">
                  <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                  <td className="px-1 py-1">{cell(r.customerText, (v) => setRow(i, { customerText: v }), "Câu khách hỏi / nói…")}</td>
                  <td className="px-1 py-1">
                    {cell(r.idealResponse, (v) => setRow(i, { idealResponse: v }), "Câu Lulu trả lời… (dùng {{PRICE}} thay số tiền)", hasHardcodedPriceFE(r.idealResponse) ? "border-amber-400 bg-amber-50" : "", 2, () => setFocusedCell(i))}
                    {hasHardcodedPriceFE(r.idealResponse) && isAdmin && (
                      <button onClick={() => setRow(i, { idealResponse: suggestPriceReplace(r.idealResponse) })}
                        className="text-[10px] text-amber-700 underline mt-0.5">⚠ Có số tiền — bấm thay bằng {"{{PRICE}}"} (lấy giá thật)</button>
                    )}
                  </td>
                  {showNotes && <td className="px-1 py-1">{cell(r.notes, (v) => setRow(i, { notes: v }), "Ghi chú", "text-[12px]")}</td>}
                  <td className="px-1 py-1">
                    {isAdmin && <div className="flex flex-col gap-1">
                      <button onClick={() => dupRow(i)} title="Nhân bản" className="text-gray-400 hover:text-gray-700"><Copy className="w-3.5 h-3.5" /></button>
                      <button onClick={() => delRow(i)} title="Xóa" className="text-gray-400 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && <tr><td colSpan={showNotes ? 5 : 4} className="text-center text-gray-400 py-6 text-[13px]">{rows.length ? "Không có dòng khớp tìm kiếm." : "Chưa có dòng nào — bấm 'Thêm dòng' hoặc 'Dán nhiều dòng'."}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Cài đặt nâng cao — đóng sẵn (Req 3, 8): Ghi chú + tìm kiếm; Nhóm/Tình huống ẩn. */}
      <div className="border-t pt-2">
        <button onClick={() => setShowAdvanced(!showAdvanced)} className="text-[11px] text-gray-400 flex items-center gap-1 hover:text-gray-600">
          {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} Cài đặt nâng cao
        </button>
        {showAdvanced && (
          <div className="flex items-center gap-3 flex-wrap text-[12px] bg-gray-50 rounded-lg p-2 mt-1">
            <label className="flex items-center gap-1.5 text-gray-600"><input type="checkbox" checked={showNotes} onChange={(e) => setShowNotes(e.target.checked)} /> Hiện cột Ghi chú</label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm trong bảng…" className="border rounded-lg pl-8 pr-3 py-1 text-[12px] w-52" />
            </div>
            <span className="text-gray-400">Nhóm/Tình huống tự lưu theo dịch vụ — ẩn cho gọn.</span>
          </div>
        )}
      </div>
     </div>
    </div>
  );
}

type ServiceOpt = { key: string; title: string };

// Thanh "Chép kịch bản từ dịch vụ khác" — tiết kiệm công soạn (bỏ qua tình huống đã có).
function CopyGoldenBar({ toServiceKey, toGroupName, options, onCopy }: {
  toServiceKey: string; toGroupName: string; options: ServiceOpt[];
  onCopy: (from: string, to: string, toGroupName: string) => Promise<void>;
}) {
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const others = options.filter((o) => o.key !== toServiceKey);
  if (others.length === 0) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-gray-500 flex-wrap">
      <span className="text-gray-400">Chưa muốn gõ? Chép kịch bản từ:</span>
      <select value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded-lg px-2 py-1 text-[12px] bg-white max-w-[180px]">
        <option value="">— chọn dịch vụ —</option>
        {others.map((o) => <option key={o.key} value={o.key}>{o.title}</option>)}
      </select>
      <button disabled={!from || busy}
        onClick={async () => { setBusy(true); try { await onCopy(from, toServiceKey, toGroupName); setFrom(""); } finally { setBusy(false); } }}
        className="border border-violet-300 text-violet-700 rounded-lg px-2.5 py-1 hover:bg-violet-50 disabled:opacity-40 flex items-center gap-1">
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Copy className="w-3 h-3" />} Chép sang đây
      </button>
      <span className="text-gray-300">(giữ nguyên tình huống đã có; giá vẫn realtime)</span>
    </div>
  );
}

function TreeRowView({ node, depth, expanded, toggle, onOpenScript, ctx, serviceOptions, onCopyGolden }: {
  node: TreeNodeFE; depth: number; expanded: Set<string>; toggle: (k: string) => void;
  onOpenScript: (t: ScriptTarget) => void;
  ctx?: TreeCtx;
  serviceOptions?: ServiceOpt[];
  onCopyGolden?: (from: string, to: string, toGroupName: string) => Promise<void>;
}) {
  const isOpen = expanded.has(node.nodeKey);
  const pad = { paddingLeft: `${depth * 16 + 4}px` };
  const openScript = () => onOpenScript({
    nodeKey: node.nodeKey, scenarioKey: node.scenarioKey, serviceKey: node.serviceKey, title: node.title,
    groupName: ctx?.groupName ?? node.priceSource ?? null,
    serviceTitle: ctx?.serviceTitle, stepTitle: ctx?.stepTitle, situationTitle: node.title,
  });
  // Ngữ cảnh truyền xuống con: service đặt tên+nhóm; step/pricing/greeting bổ sung tên bước.
  const childCtx: TreeCtx =
    node.nodeType === "service" ? { serviceTitle: node.title, groupName: node.meta?.groupName ?? node.priceSource ?? null }
    : node.nodeType === "greeting" ? { serviceTitle: "Chào hỏi chung", groupName: null }
    : (node.nodeType === "step" || node.nodeType === "pricing") ? { ...ctx, stepTitle: node.title }
    : (ctx ?? {});

  // TÌNH HUỐNG (leaf) — bấm mở thẳng bảng Excel Hỏi & Trả lời (không còn scenario editor).
  if (node.nodeType === "leaf") {
    const has = node.meta?.hasScript;
    const auto = node.meta?.autoGenerated; // kịch bản tự sinh & chưa admin chỉnh
    return (
      <button id={`tree-node-${node.nodeKey}`} onClick={openScript} style={pad}
        title="Mở bảng Hỏi & Trả lời"
        className={`w-full text-left flex items-center gap-2.5 py-1.5 pr-2 rounded-lg text-[13px] group transition-colors ${has ? "hover:bg-emerald-50/60" : "hover:bg-violet-50"}`}>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${has ? (auto ? "bg-indigo-400" : "bg-emerald-500") : "bg-gray-300"}`} />
        <span className={`flex-1 min-w-0 truncate ${has ? "text-gray-800" : "text-gray-600"}`}>{node.title}</span>
        {has
          ? (auto
              ? <span className="text-[11px] text-indigo-600 shrink-0 flex items-center gap-1"><Bot className="w-3 h-3" /> Tự động<span className="text-gray-300 group-hover:text-violet-500 ml-1">· sửa</span></span>
              : <span className="text-[11px] text-emerald-600 shrink-0 flex items-center gap-1"><Check className="w-3 h-3" /> Đã chỉnh<span className="text-gray-300 group-hover:text-violet-500 ml-1">· sửa</span></span>)
          : <span className="text-[11px] text-violet-600 border border-violet-200 rounded-full px-2 py-0.5 shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"><Plus className="w-3 h-3" /> Soạn</span>}
      </button>
    );
  }

  // DỊCH VỤ (service) — card lớn: ảnh + tên + tiến độ + chip số gói/giá.
  if (node.nodeType === "service") {
    const m = node.meta ?? {};
    const total = m.situationCount ?? 0;
    const filled = m.filledCount ?? 0;
    const pct = total > 0 ? Math.round((filled / total) * 100) : 0;
    return (
      <div id={`tree-node-${node.nodeKey}`} className={`border rounded-xl mb-2 overflow-hidden bg-white transition-shadow ${isOpen ? "border-violet-200 shadow-sm" : "border-gray-200 hover:shadow-sm hover:border-gray-300"}`}>
        <button onClick={() => toggle(node.nodeKey)} className="w-full text-left flex items-center gap-3 px-3 py-2.5">
          <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${isOpen ? "text-violet-500" : "-rotate-90"}`} />
          {m.imageUrl
            ? <img src={getImageSrc(m.imageUrl) ?? ""} alt="" className="w-10 h-10 rounded-lg object-cover ring-1 ring-gray-200 shrink-0" />
            : <span className="w-10 h-10 rounded-lg bg-violet-50 text-violet-400 grid place-items-center shrink-0"><BookOpen className="w-5 h-5" /></span>}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-[15px] truncate">{node.title}</p>
            <div className="flex items-center gap-2 mt-1">
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden flex-1 max-w-[160px]">
                <div className={`h-full rounded-full ${pct > 0 ? "bg-emerald-400" : ""}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[11px] text-gray-400 shrink-0">{filled}/{total} tình huống có kịch bản</span>
            </div>
          </div>
          <span className="flex flex-col items-end gap-1 text-[11px] shrink-0">
            <span className="bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">{m.packageCount ?? 0} gói</span>
            <span className={`rounded-full px-2 py-0.5 ${m.priceConnected ? "bg-emerald-50 text-emerald-600" : "bg-amber-50 text-amber-600"}`}>
              {m.priceConnected ? "💰 giá realtime" : "⚠ chưa nối giá"}
            </span>
          </span>
        </button>
        {isOpen && (
          <div className="border-t border-gray-100 py-1 bg-gray-50/40">
            {/* BẢNG GIÁ REALTIME ngay đầu card — ảnh + gói + giá đọc thẳng từ Bảng giá (Req 1). */}
            <div className="px-3 pt-2 pb-1">
              <PricingNode serviceKey={node.serviceKey} groupName={m.groupName ?? node.title} variant="card" />
            </div>
            {onCopyGolden && serviceOptions && node.serviceKey && filled < total && (
              <CopyGoldenBar toServiceKey={node.serviceKey} toGroupName={m.groupName ?? node.title} options={serviceOptions} onCopy={onCopyGolden} />
            )}
            {node.children.map((c) => (
              <TreeRowView key={c.nodeKey} node={c} depth={1} expanded={expanded} toggle={toggle} onOpenScript={onOpenScript} ctx={childCtx} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // BÁO GIÁ (pricing step) — folder thường; KHÔNG lặp lại bảng giá ở đây
  // (bảng giá realtime đã hiện 1 lần ở ĐẦU card dịch vụ — tránh trùng UI).
  if (node.nodeType === "pricing") {
    return (
      <div id={`tree-node-${node.nodeKey}`}>
        <button onClick={() => toggle(node.nodeKey)} style={pad}
          className="w-full text-left flex items-center gap-2 py-1.5 pr-2 rounded hover:bg-emerald-50 text-[13px]">
          <ChevronDown className={`w-3.5 h-3.5 text-emerald-500 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
          <span className="font-medium text-emerald-700">💰 {node.title}</span>
          <span className="text-[11px] text-gray-400">{node.meta?.situationCount ?? node.children.length} tình huống · giá ở bảng đầu thẻ</span>
        </button>
        {isOpen && node.children.map((c) => (
          <TreeRowView key={c.nodeKey} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} onOpenScript={onOpenScript} ctx={childCtx} />
        ))}
      </div>
    );
  }

  // BƯỚC (step) / greeting / folder cũ = thư mục thu gọn.
  const isGreeting = node.nodeType === "greeting";
  const count = node.meta?.situationCount ?? countLeaves(node);
  return (
    <div id={`tree-node-${node.nodeKey}`} className={isGreeting ? "border border-amber-200 bg-amber-50/40 rounded-xl mb-2" : ""}>
      <button onClick={() => toggle(node.nodeKey)} style={isGreeting ? undefined : pad}
        className={`w-full text-left flex items-center gap-2 pr-2 rounded hover:bg-gray-50 ${isGreeting ? "px-3 py-2.5 font-semibold text-[15px]" : "py-1.5 text-[13px] font-medium text-gray-700"}`}>
        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform shrink-0 ${isOpen ? "" : "-rotate-90"}`} />
        <span className="flex-1 min-w-0">{node.title}</span>
        {count > 0 && <span className="text-[11px] text-gray-400 font-normal shrink-0">{count} tình huống</span>}
      </button>
      {isOpen && node.children.map((c) => (
        <TreeRowView key={c.nodeKey} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} onOpenScript={onOpenScript} ctx={childCtx} />
      ))}
    </div>
  );
}

function countLeaves(node: TreeNodeFE): number {
  if (node.nodeType === "leaf") return 1;
  return node.children.reduce((s, c) => s + countLeaves(c), 0);
}

// Đường nodeKey từ gốc tới card DỊCH VỤ khớp (theo tên nhóm/serviceKey) — để mở + cuộn khi deep-link.
function findServicePath(nodes: TreeNodeFE[], key: string, trail: string[] = []): string[] | null {
  const k = key.trim().toLowerCase();
  for (const n of nodes) {
    const here = [...trail, n.nodeKey];
    const match = n.nodeType === "service" && (
      (n.serviceKey ?? "").toLowerCase() === k ||
      (n.title ?? "").toLowerCase() === k ||
      (n.meta?.groupName ?? n.priceSource ?? "").toLowerCase() === k
    );
    if (match) return here;
    const sub = findServicePath(n.children, key, here);
    if (sub) return sub;
  }
  return null;
}

function ScenarioTreeView({ reloadKey, onOpenScript, showErr, autoOpenServiceKey, onCopyGolden }: {
  reloadKey: number;
  onOpenScript: (t: ScriptTarget) => void;
  showErr: (m: string) => void;
  autoOpenServiceKey?: string | null;
  onCopyGolden?: (from: string, to: string, toGroupName: string) => Promise<void>;
}) {
  const [tree, setTree] = useState<TreeNodeFE[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    apiGet<{ tree: TreeNodeFE[] }>("/lulu-scenarios/tree").then((r) => setTree(r.tree)).catch((e) => showErr(String((e as Error).message)));
  }, [reloadKey, showErr]);
  // Deep-link từ Bảng giá: mở đúng nhánh dịch vụ + cuộn tới.
  useEffect(() => {
    if (!tree || !autoOpenServiceKey) return;
    const path = findServicePath(tree, autoOpenServiceKey);
    if (!path) return;
    setExpanded((prev) => new Set([...prev, ...path]));
    const target = path[path.length - 1];
    const timer = setTimeout(() => {
      document.getElementById(`tree-node-${target}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 200);
    return () => clearTimeout(timer);
  }, [tree, autoOpenServiceKey]);
  const toggle = (k: string) => setExpanded((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const expandAll = () => { const all = new Set<string>(); const walk = (ns: TreeNodeFE[]) => ns.forEach((n) => { if (n.children.length || n.nodeType === "pricing") { all.add(n.nodeKey); walk(n.children); } }); if (tree) walk(tree); setExpanded(all); };
  if (!tree) return <p className="text-gray-400 text-sm py-6">Đang tải cây kịch bản…</p>;
  const firstServiceKey = tree.find((n) => n.nodeType === "service")?.nodeKey;
  const serviceNodes = tree.filter((n) => n.nodeType === "service");
  const svcCount = serviceNodes.length;
  const serviceOptions: ServiceOpt[] = serviceNodes.map((n) => ({ key: n.serviceKey ?? "", title: n.title })).filter((o) => o.key);
  const totalSit = tree.reduce((s, n) => s + (n.meta?.situationCount ?? 0), 0);
  const totalFilled = tree.reduce((s, n) => s + (n.meta?.filledCount ?? 0), 0);
  const totalPct = totalSit > 0 ? Math.round((totalFilled / totalSit) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="bg-white border border-gray-200 rounded-xl p-3 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center justify-between text-[12px] mb-1">
            <span className="font-medium text-gray-700">Tiến độ toàn studio</span>
            <span className="text-gray-500"><b className="text-violet-600">{totalFilled}</b>/{totalSit} tình huống đã có kịch bản ({totalPct}%)</span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-emerald-400" style={{ width: `${totalPct}%` }} />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 px-1 py-1">
        <span className="text-[12px] text-gray-400 mr-auto">{svcCount} dịch vụ</span>
        <button onClick={expandAll} className="text-[12px] text-gray-500 border border-gray-200 rounded-full px-2.5 py-1 hover:bg-gray-50">Mở tất cả</button>
        <button onClick={() => setExpanded(new Set())} className="text-[12px] text-gray-500 border border-gray-200 rounded-full px-2.5 py-1 hover:bg-gray-50">Thu gọn tất cả</button>
      </div>
      {tree.map((n) => (
        <div key={n.nodeKey}>
          {n.nodeKey === firstServiceKey && (
            <p className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold mt-3 mb-1 px-1">Dịch vụ</p>
          )}
          <TreeRowView node={n} depth={0} expanded={expanded} toggle={toggle} onOpenScript={onOpenScript} serviceOptions={serviceOptions} onCopyGolden={onCopyGolden} />
        </div>
      ))}
    </div>
  );
}

export default function LuluSaleScenariosPage() {
  const { effectiveIsAdmin } = useStaffAuth();
  const [labels, setLabels] = useState<ScenarioLabels | null>(null);
  const [records, setRecords] = useState<ScenarioRecord[]>([]);
  const [featureOff, setFeatureOff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "off" | "draft" | "archived">("all");
  const [editing, setEditing] = useState<ScenarioRecord | null | "new">(null!);
  const [editingSeed, setEditingSeed] = useState<{ card: ScenarioCard; issues: Issue[] } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [newNonce, setNewNonce] = useState(0);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<Array<{ id: number; kind: string; note: string | null; count: number; createdByName: string | null; createdAt: string }>>([]);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [applyIssues, setApplyIssues] = useState<Issue[]>([]);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"tree" | "list">("tree");
  const [treeReloadKey, setTreeReloadKey] = useState(0);
  const [scriptNode, setScriptNode] = useState<ScriptTarget | null>(null);
  const [autoOpenServiceKey, setAutoOpenServiceKey] = useState<string | null>(null);

  // Deep-link từ trang Bảng giá: /lulu-sale-scenarios?service=<TÊN NHÓM giá>. Card dịch vụ mang
  // tên nhóm nên khớp thẳng — admin KHÔNG cần biết khoá. Mở đúng card + xoá param khỏi URL.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("service");
    if (param) { setAutoOpenServiceKey(param); setView("tree"); }
    const url = new URL(window.location.href);
    url.searchParams.delete("service");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const showOk = (msg: string) => { setToast({ ok: true, msg }); setTimeout(() => setToast(null), 3500); };
  const showErr = (msg: string) => { setToast({ ok: false, msg }); setTimeout(() => setToast(null), 5000); };

  const loadVersions = useCallback(async () => {
    try { const r = await apiGet<{ versions: { id: number; kind: string; note: string | null; count: number; createdByName: string | null; createdAt: string }[] }>("/lulu-scenarios/versions"); setVersions(r.versions); }
    catch { /* panel đóng thì thôi */ }
  }, []);

  const reload = useCallback(async () => {
    try {
      const st = await apiGet<{ labels: ScenarioLabels }>("/lulu-scenarios/status");
      setLabels(st.labels);
      const r = await apiGet<{ scenarios: ScenarioRecord[] }>("/lulu-scenarios");
      setRecords(r.scenarios);
      setTreeReloadKey((k) => k + 1);
      setFeatureOff(false);
    } catch (e) {
      if ((e as { featureOff?: boolean }).featureOff) setFeatureOff(true);
      else showErr(String((e as Error).message));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const draftCount = records.filter((r) => r.draftCard && r.status !== "archived").length;

  const visible = useMemo(() => {
    let list = records;
    if (filter === "active") list = list.filter((r) => r.status === "active" && r.enabled);
    else if (filter === "off") list = list.filter((r) => !r.enabled && r.status !== "archived");
    else if (filter === "draft") list = list.filter((r) => r.draftCard || r.status === "draft");
    else if (filter === "archived") list = list.filter((r) => r.status === "archived");
    else list = list.filter((r) => r.status !== "archived");
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter((r) => (displayCard(r)?.name ?? r.scenarioKey).toLowerCase().includes(s));
    }
    return list;
  }, [records, filter, q]);

  const doReorder = async (fromKey: string, toKey: string) => {
    const keys = records.filter((r) => r.status !== "archived").map((r) => r.scenarioKey);
    const next = moveItem(keys, keys.indexOf(fromKey), keys.indexOf(toKey));
    setRecords((rs) => {
      const map = new Map(next.map((k, i) => [k, i]));
      return [...rs].sort((a, b) => (map.get(a.scenarioKey) ?? 999) - (map.get(b.scenarioKey) ?? 999));
    });
    try { await apiSend("POST", "/lulu-scenarios/reorder", { keys: next }); }
    catch (e) { showErr(String((e as Error).message)); reload(); }
  };

  const applyAll = async () => {
    if (!confirm(`Áp dụng ${draftCount} bản nháp vào bản chạy thật? (Có snapshot để khôi phục)`)) return;
    setBusy(true); setApplyIssues([]);
    try {
      const out = await apiSend<{ applied: string[] }>("POST", "/lulu-scenarios/apply", {});
      showOk(`Đã áp dụng ${out.applied.length} thẻ — có snapshot khôi phục trong Lịch sử`);
      reload();
      if (versionsOpen) loadVersions();
    } catch (e) {
      const anyE = e as { issues?: Issue[]; message?: string };
      if (anyE.issues?.length) setApplyIssues(anyE.issues);
      showErr(anyE.message ?? "Áp dụng lỗi");
    } finally { setBusy(false); }
  };

  if (loading) return <div className="p-8 text-gray-400 flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Đang tải…</div>;

  if (featureOff) {
    return (
      <div className="max-w-2xl mx-auto p-8">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 space-y-3">
          <p className="font-medium text-amber-800 flex items-center gap-2"><Power className="w-5 h-5" /> Tính năng chưa được bật</p>
          <p className="text-sm text-amber-800">Trang "Kịch bản tư vấn Lulu" đang tắt an toàn. Để bật (chỉ nên bật ở môi trường test trước):</p>
          <pre className="text-[12px] bg-white border rounded-lg p-3">LULU_SCENARIO_MANAGER_ENABLED=1</pre>
          <p className="text-[12px] text-amber-700">Bật xong khởi động lại server rồi tải lại trang. Cờ này CHỈ mở trang quản lý — chưa đụng gì tới Lulu trả lời khách.</p>
        </div>
      </div>
    );
  }

  if (!labels) return null;

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-4">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm text-white ${toast.ok ? "bg-emerald-600" : "bg-rose-600"}`}>
          {toast.msg}
        </div>
      )}

      <div className="flex items-start justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><NotebookPen className="w-6 h-6 text-violet-600" /> Kịch bản tư vấn Lulu</h1>
          <p className="text-sm text-gray-500 mt-0.5">Chọn dịch vụ → mở 7 bước sale → soạn câu Lulu trả lời cho từng tình huống. Giá luôn lấy realtime từ Bảng giá.</p>
        </div>
        <div className="flex gap-2">
          {effectiveIsAdmin && view === "list" && (
            <>
              <button onClick={() => { setAiOpen(true); setEditing(null!); setEditingSeed(null); }}
                className="border border-violet-300 text-violet-700 text-sm px-3 py-2 rounded-lg hover:bg-violet-50 flex items-center gap-1.5">
                <Wand2 className="w-4 h-4" /> Nhờ AI viết
              </button>
              <button onClick={() => { setEditing("new"); setEditingSeed(null); setAiOpen(false); setNewNonce((n) => n + 1); }}
                className="bg-violet-600 text-white text-sm px-3 py-2 rounded-lg hover:bg-violet-700 flex items-center gap-1.5">
                <Plus className="w-4 h-4" /> Kịch bản mới
              </button>
            </>
          )}
          {effectiveIsAdmin && (
            <button disabled={busy} title="Tạo kịch bản mặc định cho mọi nhóm/gói còn thiếu — KHÔNG đè phần đã soạn"
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await apiSend<{ message: string }>("POST", "/lulu-scenarios/sync-pricing", {});
                  showOk(`Đồng bộ xong — ${r.message}`);
                  setTreeReloadKey((k) => k + 1);
                  reload();
                } catch (e) { showErr(String((e as Error).message)); }
                finally { setBusy(false); }
              }}
              className="border border-emerald-300 text-emerald-700 text-sm px-3 py-2 rounded-lg hover:bg-emerald-50 disabled:opacity-50 flex items-center gap-1.5">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Đồng bộ từ Bảng giá
            </button>
          )}
          <button onClick={async () => {
            setVersionsOpen(!versionsOpen);
            if (!versionsOpen) {
              try { const r = await apiGet<{ versions: typeof versions }>("/lulu-scenarios/versions"); setVersions(r.versions); }
              catch (e) { showErr(String((e as Error).message)); }
            }
          }} className="border text-sm px-3 py-2 rounded-lg hover:bg-gray-50 flex items-center gap-1.5">
            <History className="w-4 h-4" /> Lịch sử
          </button>
        </div>
      </div>

      {draftCount > 0 && effectiveIsAdmin && view === "list" && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-amber-800">Đang có <b>{draftCount} bản nháp</b> chưa chạy thật. Test kỹ rồi áp dụng cả bộ (có snapshot khôi phục).</p>
          <button disabled={busy} onClick={applyAll}
            className="bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1.5">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />} Áp dụng tất cả
          </button>
        </div>
      )}

      {applyIssues.length > 0 && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 space-y-1">
          <p className="text-[12px] font-semibold text-rose-700">Chưa áp dụng được — các thẻ sau cần sửa:</p>
          {applyIssues.map((i, idx) => (
            <p key={idx} className="text-[12px] text-rose-700">• [{i.scenarioKey}] {i.message}{i.suggest ? ` → ${i.suggest}` : ""}</p>
          ))}
        </div>
      )}

      {versionsOpen && (
        <div className="bg-white border rounded-xl p-3 space-y-2">
          <p className="text-sm font-medium flex items-center gap-1.5"><History className="w-4 h-4" /> Lịch sử áp dụng (khôi phục = quay cả bộ về snapshot)</p>
          {versions.length === 0 && <p className="text-[12px] text-gray-400">Chưa có lần áp dụng nào.</p>}
          {versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between text-[12px] border rounded-lg px-3 py-2">
              <span>#{v.id} · {v.kind === "apply" ? "Áp dụng" : "Khôi phục"} · {v.note ?? ""} · {v.count} thẻ · {v.createdByName ?? ""} · {new Date(v.createdAt).toLocaleString("vi-VN")}</span>
              {effectiveIsAdmin && (
                <button onClick={async () => {
                  if (!confirm(`Khôi phục CẢ BỘ kịch bản về snapshot #${v.id}?`)) return;
                  try { await apiSend("POST", "/lulu-scenarios/rollback", { versionId: v.id }); showOk("Đã khôi phục cả bộ"); reload(); loadVersions(); }
                  catch (e) { showErr(String((e as Error).message)); }
                }} className="text-amber-700 border border-amber-300 rounded-lg px-2 py-1 hover:bg-amber-50 flex items-center gap-1">
                  <RotateCcw className="w-3 h-3" /> Khôi phục
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {aiOpen && <AiDraftBox onClose={() => setAiOpen(false)} showErr={showErr}
        onDraft={(card, issues) => { setAiOpen(false); setEditingSeed({ card, issues }); setEditing("new"); setNewNonce((n) => n + 1); }} />}

      {(editing === "new" || editing) && (
        <CardEditorWrapper key={editing === "new" ? `new-${newNonce}` : (editing as ScenarioRecord).scenarioKey}
          editing={editing} editingSeed={editingSeed} labels={labels} records={records}
          isAdmin={effectiveIsAdmin} onSaved={() => { setEditing(null!); setEditingSeed(null); reload(); }}
          onClose={() => { setEditing(null!); setEditingSeed(null); }} showOk={showOk} showErr={showErr} />
      )}

      {/* Chọn cách xem: CÂY (mặc định, thu gọn theo 7 chặng) hoặc DANH SÁCH phẳng (tìm/lọc). */}
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] text-gray-400 mr-1">Xem:</span>
        <button onClick={() => setView("tree")}
          className={`text-[12px] border rounded-lg px-3 py-1.5 ${view === "tree" ? "bg-violet-600 text-white border-violet-600" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
          🌳 Cây kịch bản
        </button>
        <button onClick={() => setView("list")}
          className={`text-[12px] border rounded-lg px-3 py-1.5 ${view === "list" ? "bg-violet-600 text-white border-violet-600" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
          ☰ Danh sách
        </button>
      </div>

      {scriptNode && (
        <ScriptTablePanel key={scriptNode.nodeKey} nodeKey={scriptNode.nodeKey} scenarioKey={scriptNode.scenarioKey}
          title={scriptNode.title} serviceKey={scriptNode.serviceKey} groupName={scriptNode.groupName ?? null}
          serviceTitle={scriptNode.serviceTitle} stepTitle={scriptNode.stepTitle} situationTitle={scriptNode.situationTitle}
          isAdmin={effectiveIsAdmin} onClose={() => setScriptNode(null)} onSaved={() => setTreeReloadKey((k) => k + 1)} showOk={showOk} showErr={showErr} />
      )}

      {view === "tree" && (
        <ScenarioTreeView reloadKey={treeReloadKey}
          onOpenScript={(t) => { setScriptNode(t); setEditing(null!); }}
          showErr={showErr} autoOpenServiceKey={autoOpenServiceKey}
          onCopyGolden={effectiveIsAdmin ? async (from, to, toGroupName) => {
            try {
              const r = await apiSend<{ copiedRows: number; copiedSituations: number; skippedSituations: number }>(
                "POST", "/lulu-scenarios/copy-golden", { fromServiceKey: from, toServiceKey: to, toGroupName });
              showOk(r.copiedSituations > 0
                ? `Đã chép ${r.copiedSituations} tình huống (${r.copiedRows} câu)${r.skippedSituations ? `, giữ nguyên ${r.skippedSituations} tình huống đã có` : ""}`
                : "Nguồn chưa có kịch bản để chép");
              setTreeReloadKey((k) => k + 1);
            } catch (e) { showErr(String((e as Error).message)); }
          } : undefined} />
      )}

      {view === "list" && (<>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-2.5" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm kịch bản…"
            className="border rounded-lg pl-8 pr-3 py-1.5 text-sm w-52" />
        </div>
        {([["all", "Tất cả"], ["active", "Đang dùng"], ["off", "Đang tắt"], ["draft", "Bản nháp"], ["archived", "Đã lưu trữ"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`text-[12px] border rounded-full px-3 py-1 ${filter === k ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
            {l}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {visible.map((rec) => {
          const card = displayCard(rec);
          if (!card) return null;
          return (
            <div key={rec.scenarioKey} draggable={effectiveIsAdmin}
              onDragStart={() => setDragKey(rec.scenarioKey)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragKey && dragKey !== rec.scenarioKey) doReorder(dragKey, rec.scenarioKey); setDragKey(null); }}
              className={`bg-white border rounded-xl p-3 flex items-start gap-3 ${!rec.enabled ? "opacity-60" : ""} ${dragKey === rec.scenarioKey ? "border-violet-400" : ""}`}>
              {effectiveIsAdmin && <GripVertical className="w-4 h-4 text-gray-300 mt-1 cursor-grab shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-medium text-sm">{card.name}</p>
                  <StatusBadge rec={rec} />
                  {rec.isCore && <span title="Thẻ an toàn — không xoá được, chỉ tắt tạm" className="text-[10px] text-blue-600 flex items-center gap-0.5"><ShieldCheck className="w-3 h-3" /> an toàn</span>}
                  {rec.lastTestResult && <VerdictBadge verdict={rec.lastTestResult} />}
                </div>
                <p className="text-[12px] text-gray-500 mt-0.5"><b>Khi khách:</b> {summarizeWhen(card, labels)}</p>
                <p className="text-[12px] text-gray-500 truncate"><b>Lulu nên:</b> {card.guidance || "—"}</p>
                {summarizeNever(card, labels) && (
                  <p className="text-[12px] text-rose-500 truncate"><b>Đừng bao giờ:</b> {summarizeNever(card, labels)}</p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => { setEditing(rec); setEditingSeed(null); setAiOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  title="Sửa" className="border rounded-lg p-1.5 hover:bg-gray-50"><Pencil className="w-3.5 h-3.5 text-gray-500" /></button>
                {effectiveIsAdmin && (
                  <>
                    <button onClick={async () => {
                      try { await apiSend("POST", `/lulu-scenarios/${rec.scenarioKey}/clone`); showOk("Đã nhân bản (bản nháp mới)"); reload(); }
                      catch (e) { showErr(String((e as Error).message)); }
                    }} title="Nhân bản" className="border rounded-lg p-1.5 hover:bg-gray-50"><Copy className="w-3.5 h-3.5 text-gray-500" /></button>
                    {!rec.isCore && rec.status !== "archived" && (
                      <button onClick={async () => {
                        if (!confirm(`Lưu trữ thẻ '${card.name}'? (không xoá vĩnh viễn — khôi phục qua Lịch sử)`)) return;
                        try { await apiSend("POST", `/lulu-scenarios/${rec.scenarioKey}/archive`); showOk("Đã lưu trữ"); reload(); }
                        catch (e) { showErr(String((e as Error).message)); }
                      }} title="Lưu trữ" className="border rounded-lg p-1.5 hover:bg-gray-50"><Archive className="w-3.5 h-3.5 text-gray-500" /></button>
                    )}
                    <button role="switch" aria-checked={rec.enabled} title={rec.enabled ? "Đang bật — bấm để tắt" : "Đang tắt — bấm để bật"}
                      onClick={async () => {
                        try { await apiSend("POST", `/lulu-scenarios/${rec.scenarioKey}/toggle`, { enabled: !rec.enabled }); reload(); }
                        catch (e) { showErr(String((e as Error).message)); }
                      }}
                      className={`w-9 h-5 rounded-full relative transition-colors ${rec.enabled ? "bg-emerald-500" : "bg-gray-300"}`}>
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${rec.enabled ? "left-[18px]" : "left-0.5"}`} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {visible.length === 0 && <p className="text-sm text-gray-400 text-center py-8">Không có kịch bản nào khớp bộ lọc.</p>}
      </div>
      </>)}
    </div>
  );
}

// Wrapper: chọn editor sửa thẻ có sẵn hoặc tạo mới (seed từ AI draft nếu có).
function CardEditorWrapper({ editing, editingSeed, labels, records, isAdmin, onSaved, onClose, showOk, showErr }: {
  editing: ScenarioRecord | "new" | null; editingSeed: { card: ScenarioCard; issues: Issue[] } | null;
  labels: ScenarioLabels; records: ScenarioRecord[]; isAdmin: boolean;
  onSaved: () => void; onClose: () => void; showOk: (m: string) => void; showErr: (m: string) => void;
}) {
  if (editing === "new") {
    return <CardEditor rec={null} seedCard={editingSeed?.card ?? null} seedIssues={editingSeed?.issues ?? []}
      labels={labels} allRecords={records} isAdmin={isAdmin}
      onSaved={onSaved} onClose={onClose} showOk={showOk} showErr={showErr} />;
  }
  if (editing) {
    return <CardEditor key={editing.scenarioKey} rec={editing} labels={labels} allRecords={records}
      isAdmin={isAdmin} onSaved={onSaved} onClose={onClose} showOk={showOk} showErr={showErr} />;
  }
  return null;
}
