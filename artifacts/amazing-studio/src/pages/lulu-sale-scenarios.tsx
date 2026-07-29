import { useState, useEffect, useCallback, useMemo } from "react";
import { apiUrl } from "@/lib/api-base";
import { useStaffAuth } from "@/contexts/StaffAuthContext";
import {
  type ScenarioCard, type ScenarioRecord, type ScenarioLabels,
  emptyCard, displayCard, summarizeWhen, summarizeNever, verdictInfo, moveItem, statusLabel,
} from "@/lib/scenario-card";
import {
  NotebookPen, Plus, Wand2, Pencil, FlaskConical, Copy, History, Loader2, Check,
  AlertTriangle, X, ChevronDown, ChevronUp, Lock, ShieldCheck, GripVertical,
  RotateCcw, Save, Trash2, Search, Power, ArrowRight, Bot, User, Archive,
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
  nodeType: "stage" | "group" | "subgroup" | "leaf" | "pricing";
  title: string; serviceKey: string | null; scenarioKey: string | null;
  children: TreeNodeFE[];
  scenario?: { name: string; enabled: boolean; status: string; whenText: string; missing?: boolean } | null;
};
type EffPkg = { code: string; name: string; groupName: string; basePrice: number; effectivePrice: number; promoActive: boolean; promoName: string | null; promoEnd: string | null };

const vnd = (n: number) => (Number.isFinite(n) && n > 0 ? n.toLocaleString("vi-VN") + "đ" : "liên hệ");

function PricingNode({ serviceKey }: { serviceKey: string | null }) {
  const [groups, setGroups] = useState<Array<{ groupName: string; packages: EffPkg[] }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    apiGet<{ groups: Array<{ groupName: string; packages: EffPkg[] }> }>(`/lulu-scenarios/price-preview?service=${encodeURIComponent(serviceKey ?? "")}`)
      .then((r) => { if (alive) setGroups(r.groups); })
      .catch((e) => { if (alive) setErr(String((e as Error).message)); });
    return () => { alive = false; };
  }, [serviceKey]);
  return (
    <div className="ml-6 my-1 border-l-2 border-emerald-200 pl-3 py-1 text-[12px]">
      <p className="text-emerald-700 font-medium">Nguồn giá: Dịch vụ &amp; Bảng giá {serviceKey ? `→ ${serviceKey}` : ""} · <span className="text-gray-400">đọc realtime, không nhập tay</span></p>
      {err && <p className="text-rose-600 mt-1">Không đọc được giá: {err}</p>}
      {!groups && !err && <p className="text-gray-400 mt-1">Đang đọc bảng giá…</p>}
      {groups && groups.length === 0 && <p className="text-amber-600 mt-1">Chưa có gói nào khớp — mở "Dịch vụ &amp; Bảng giá" thêm gói cho nhóm này.</p>}
      {groups?.map((g) => (
        <div key={g.groupName} className="mt-1.5">
          <p className="font-medium text-gray-700">{g.groupName}</p>
          <table className="text-[12px] mt-0.5"><tbody>
            {g.packages.slice(0, 8).map((p) => (
              <tr key={p.code}>
                <td className="pr-3 text-gray-600">{p.name || p.code}</td>
                <td className="pr-3">
                  {p.promoActive
                    ? <span><span className="line-through text-gray-400">{vnd(p.basePrice)}</span> <b className="text-rose-600">{vnd(p.effectivePrice)}</b></span>
                    : <b>{vnd(p.effectivePrice)}</b>}
                </td>
                <td className="text-emerald-600">{p.promoActive ? `KM${p.promoName ? " " + p.promoName : ""}${p.promoEnd ? ` (đến ${new Date(p.promoEnd).toLocaleDateString("vi-VN")})` : ""}` : ""}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      ))}
      <a href="/pricing" className="inline-block mt-1.5 text-violet-600">Xem / sửa bảng giá →</a>
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

function ScriptTablePanel({ nodeKey, scenarioKey, title, serviceKey, isAdmin, onClose, showOk, showErr }: {
  nodeKey: string; scenarioKey: string | null; title: string; serviceKey: string | null;
  isAdmin: boolean; onClose: () => void; showOk: (m: string) => void; showErr: (m: string) => void;
}) {
  const [rows, setRows] = useState<ScriptRowFE[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [q, setQ] = useState("");
  const [sitFilter, setSitFilter] = useState("");
  const [paste, setPaste] = useState<PasteState | null>(null);

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
  }, [nodeKey, showErr]);

  const setRow = (i: number, patch: Partial<ScriptRowFE>) => setRows((rs) => rs.map((r, j) => j === i ? { ...r, ...patch } : r));
  const addRow = () => setRows((rs) => [...rs, EMPTY_ROW()]);
  const dupRow = (i: number) => setRows((rs) => [...rs.slice(0, i + 1), { ...rs[i] }, ...rs.slice(i + 1)]);
  const delRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));

  const save = async () => {
    setSaving(true);
    try {
      const r = await apiSend<{ rows: ScriptRowFE[]; priceWarnings: number[] }>("PUT", `/lulu-scenarios/scripts/${encodeURIComponent(nodeKey)}`, { scenarioKey, rows });
      setRows(normRows(r.rows));
      showOk(`Đã lưu ${r.rows.length} dòng${r.priceWarnings.length ? ` (⚠ ${r.priceWarnings.length} dòng có số tiền — nên dùng {{PRICE}} vì giá lấy từ bảng giá)` : ""}`);
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
    setRows((rs) => [...rs, ...previewRows]);
    setPaste(null);
    showOk(`Đã thêm ${previewRows.length} dòng${previewPriced ? ` — ${previewPriced} dòng có số tiền, cân nhắc {{PRICE}}` : ""} — nhớ bấm Lưu bảng`);
  };

  const situations = Array.from(new Set(rows.map((r) => r.situationLabel).filter(Boolean)));
  const qn = q.trim().toLowerCase();
  const visible = rows.map((r, i) => ({ r, i }))
    .filter(({ r }) => !sitFilter || r.situationLabel === sitFilter)
    .filter(({ r }) => !qn || `${r.groupLabel} ${r.situationLabel} ${r.customerText} ${r.idealResponse} ${r.notes}`.toLowerCase().includes(qn));

  const cell = (v: string, on: (x: string) => void, ph: string, cls = "", rows2 = 2) => (
    <textarea value={v} onChange={(e) => on(e.target.value)} rows={rows2} readOnly={!isAdmin}
      className={`w-full border rounded px-1.5 py-1 text-[13px] ${cls}`} placeholder={ph} />
  );

  return (
    <div className="bg-white border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-medium flex items-center gap-2"><NotebookPen className="w-4 h-4 text-violet-600" /> Bảng Kịch bản Sale: {title}</p>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
      </div>
      <p className="text-[12px] text-gray-500">Chủ tự viết câu khách hay hỏi ↔ câu Lulu nên trả lời. Lulu học GIỌNG/cách dẫn — không đọc y nguyên, giá luôn lấy từ bảng giá (dùng <code>{"{{PRICE}}"}</code> thay cho số tiền).</p>

      {serviceKey && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-emerald-700">💰 Xem bảng giá sống của nhóm này</summary>
          <PricingNode serviceKey={serviceKey} />
        </details>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-2.5" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm trong bảng…" className="border rounded-lg pl-8 pr-3 py-1.5 text-[13px] w-52" />
        </div>
        {situations.length > 0 && (
          <select value={sitFilter} onChange={(e) => setSitFilter(e.target.value)} className="border rounded-lg px-2 py-1.5 text-[13px]">
            <option value="">Mọi tình huống</option>
            {situations.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {isAdmin && <>
          <button onClick={addRow} className="border text-[12px] px-3 py-1.5 rounded-lg hover:bg-gray-50 flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Thêm dòng</button>
          <button onClick={openPaste} className="border border-violet-300 text-violet-700 text-[12px] px-3 py-1.5 rounded-lg hover:bg-violet-50">📋 Dán nhiều dòng (Excel / Sheets / ChatGPT)</button>
          <button disabled={saving} onClick={save} className="bg-emerald-600 text-white text-[12px] px-4 py-1.5 rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-1 ml-auto">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Lưu bảng ({rows.length} dòng)
          </button>
        </>}
      </div>

      {paste !== null && (
        <div className="border border-violet-200 bg-violet-50/40 rounded-lg p-3 space-y-2">
          <p className="text-[12px] text-gray-700 font-medium">Dán bảng từ Excel / Google Sheets / ChatGPT rồi xem trước — chỉnh cột nếu sai, xong bấm “Thêm {previewRows.length} dòng”.</p>
          <p className="text-[11px] text-gray-500">Thứ tự cột chuẩn: <b>Nhóm · Tình huống · Khách hỏi/nói · Lulu nên trả lời · Ghi chú</b>. Thiếu cột cũng được — bảng tự suy.</p>
          <textarea value={paste.text} onChange={(e) => onPasteText(e.target.value)} rows={5}
            placeholder={"Album cưới\tChê giá cao\tSao mắc vậy em?\tDạ em hiểu ạ, giá gồm…\tghi chú\nAlbum cưới\tXin nghĩ thêm\tĐể chị suy nghĩ\tDạ chị cứ thong thả ạ…\t"}
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
              <th className="px-2 py-1.5 w-[12%]">NHÓM</th>
              <th className="px-2 py-1.5 w-[14%]">TÌNH HUỐNG</th>
              <th className="px-2 py-1.5 w-[28%]">KHÁCH HỎI / NÓI</th>
              <th className="px-2 py-1.5">LULU NÊN TRẢ LỜI</th>
              <th className="px-2 py-1.5 w-[14%]">GHI CHÚ</th>
              <th className="w-12"></th>
            </tr></thead>
            <tbody>
              {visible.map(({ r, i }) => (
                <tr key={i} className="border-t align-top">
                  <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                  <td className="px-1 py-1">{cell(r.groupLabel, (v) => setRow(i, { groupLabel: v }), "Nhóm…", "text-[12px]")}</td>
                  <td className="px-1 py-1">{cell(r.situationLabel, (v) => setRow(i, { situationLabel: v }), "Tình huống…", "text-[12px]")}</td>
                  <td className="px-1 py-1">{cell(r.customerText, (v) => setRow(i, { customerText: v }), "Câu khách…")}</td>
                  <td className="px-1 py-1">
                    {cell(r.idealResponse, (v) => setRow(i, { idealResponse: v }), "Câu Lulu trả lời… (dùng {{PRICE}} thay số tiền)", hasHardcodedPriceFE(r.idealResponse) ? "border-amber-400 bg-amber-50" : "")}
                    {hasHardcodedPriceFE(r.idealResponse) && isAdmin && (
                      <button onClick={() => setRow(i, { idealResponse: suggestPriceReplace(r.idealResponse) })}
                        className="text-[10px] text-amber-700 underline mt-0.5">⚠ Có số tiền — bấm thay bằng {"{{PRICE}}"} (lấy giá thật)</button>
                    )}
                  </td>
                  <td className="px-1 py-1">{cell(r.notes, (v) => setRow(i, { notes: v }), "Ghi chú", "text-[12px]")}</td>
                  <td className="px-1 py-1">
                    {isAdmin && <div className="flex flex-col gap-1">
                      <button onClick={() => dupRow(i)} title="Nhân bản" className="text-gray-400 hover:text-gray-700"><Copy className="w-3.5 h-3.5" /></button>
                      <button onClick={() => delRow(i)} title="Xóa" className="text-gray-400 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && <tr><td colSpan={7} className="text-center text-gray-400 py-6 text-[13px]">{rows.length ? "Không có dòng khớp tìm kiếm/lọc." : "Chưa có dòng nào — bấm 'Thêm dòng' hoặc 'Dán nhiều dòng'."}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TreeRowView({ node, depth, expanded, toggle, onEditLeaf, onOpenScript }: {
  node: TreeNodeFE; depth: number; expanded: Set<string>; toggle: (k: string) => void;
  onEditLeaf: (scenarioKey: string) => void;
  onOpenScript: (nodeKey: string, scenarioKey: string | null, title: string, serviceKey: string | null) => void;
}) {
  const isOpen = expanded.has(node.nodeKey);
  const pad = { paddingLeft: `${depth * 18 + 4}px` };
  const scriptBtn = (
    <button onClick={(e) => { e.stopPropagation(); onOpenScript(node.nodeKey, node.scenarioKey, node.scenario?.name || node.title, node.serviceKey); }}
      title="Bảng Kịch bản Sale (Hỏi & Trả lời)"
      className="text-[11px] text-violet-600 border border-violet-200 rounded px-1.5 py-0.5 hover:bg-violet-50 shrink-0 flex items-center gap-1">
      <NotebookPen className="w-3 h-3" /> Hỏi & Trả lời
    </button>
  );
  if (node.nodeType === "leaf") {
    return (
      <div style={pad} className="flex items-center gap-2 py-1.5 pr-2 rounded hover:bg-violet-50 text-[13px]">
        <button onClick={() => node.scenarioKey && onEditLeaf(node.scenarioKey)} className="flex items-center gap-2 text-left flex-1 min-w-0">
          <span className="text-gray-300">•</span>
          <span className={node.scenario?.missing ? "text-rose-500" : ""}>{node.scenario?.name || node.title}</span>
          {node.scenario && !node.scenario.enabled && <span className="text-[10px] text-gray-400">(đang tắt)</span>}
          <Pencil className="w-3 h-3 text-gray-300 shrink-0" />
        </button>
        {scriptBtn}
      </div>
    );
  }
  if (node.nodeType === "pricing") {
    return (
      <div>
        <button onClick={() => toggle(node.nodeKey)} style={pad}
          className="w-full text-left flex items-center gap-2 py-1.5 pr-2 rounded hover:bg-emerald-50 text-[13px]">
          <ChevronDown className={`w-3.5 h-3.5 text-emerald-500 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
          <span className="font-medium text-emerald-700">💰 {node.title}</span>
          <span className="text-[11px] text-gray-400">(giá sống từ Bảng giá)</span>
          {scriptBtn}
        </button>
        {isOpen && <PricingNode serviceKey={node.serviceKey} />}
      </div>
    );
  }
  // stage / group / subgroup = folder
  const leafCount = countLeaves(node);
  return (
    <div>
      <div style={pad} className={`flex items-center gap-2 py-2 pr-2 rounded hover:bg-gray-50 ${node.nodeType === "stage" ? "font-semibold text-[15px]" : "text-[13px] font-medium text-gray-700"}`}>
        <button onClick={() => toggle(node.nodeKey)} className="flex items-center gap-2 text-left flex-1 min-w-0">
          <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
          <span>{node.title}</span>
          {leafCount > 0 && <span className="text-[11px] text-gray-400 font-normal">({leafCount})</span>}
        </button>
        {node.nodeType !== "stage" && scriptBtn}
      </div>
      {isOpen && node.children.map((c) => (
        <TreeRowView key={c.nodeKey} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} onEditLeaf={onEditLeaf} onOpenScript={onOpenScript} />
      ))}
    </div>
  );
}

function countLeaves(node: TreeNodeFE): number {
  if (node.nodeType === "leaf") return 1;
  return node.children.reduce((s, c) => s + countLeaves(c), 0);
}

function ScenarioTreeView({ reloadKey, onEditLeaf, onOpenScript, showErr }: {
  reloadKey: number; onEditLeaf: (scenarioKey: string) => void;
  onOpenScript: (nodeKey: string, scenarioKey: string | null, title: string, serviceKey: string | null) => void;
  showErr: (m: string) => void;
}) {
  const [tree, setTree] = useState<TreeNodeFE[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    apiGet<{ tree: TreeNodeFE[] }>("/lulu-scenarios/tree").then((r) => setTree(r.tree)).catch((e) => showErr(String((e as Error).message)));
  }, [reloadKey, showErr]);
  const toggle = (k: string) => setExpanded((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const expandAll = () => { const all = new Set<string>(); const walk = (ns: TreeNodeFE[]) => ns.forEach((n) => { if (n.children.length || n.nodeType === "pricing") { all.add(n.nodeKey); walk(n.children); } }); if (tree) walk(tree); setExpanded(all); };
  if (!tree) return <p className="text-gray-400 text-sm py-6">Đang tải cây kịch bản…</p>;
  return (
    <div className="bg-white border rounded-xl p-2">
      <div className="flex gap-3 px-2 py-1 text-[11px] text-gray-400">
        <button onClick={expandAll} className="hover:text-gray-600">Mở tất cả</button>
        <button onClick={() => setExpanded(new Set())} className="hover:text-gray-600">Thu gọn tất cả</button>
      </div>
      {tree.map((n) => (
        <TreeRowView key={n.nodeKey} node={n} depth={0} expanded={expanded} toggle={toggle} onEditLeaf={onEditLeaf} onOpenScript={onOpenScript} />
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
  const [scriptNode, setScriptNode] = useState<{ nodeKey: string; scenarioKey: string | null; title: string; serviceKey: string | null } | null>(null);

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
          <p className="text-sm text-gray-500 mt-0.5">Mỗi thẻ = một tình huống khách. Sửa bằng tiếng Việt, Test thử, rồi Áp dụng. Kéo thả để đổi ưu tiên.</p>
        </div>
        <div className="flex gap-2">
          {effectiveIsAdmin && (
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

      {draftCount > 0 && effectiveIsAdmin && (
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
          title={scriptNode.title} serviceKey={scriptNode.serviceKey} isAdmin={effectiveIsAdmin}
          onClose={() => setScriptNode(null)} showOk={showOk} showErr={showErr} />
      )}

      {view === "tree" && (
        <ScenarioTreeView reloadKey={treeReloadKey}
          onEditLeaf={(scenarioKey) => {
            const rec = records.find((r) => r.scenarioKey === scenarioKey);
            if (rec) { setEditing(rec); setEditingSeed(null); setAiOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }
            else showErr("Không tìm thấy thẻ — thử tải lại trang.");
          }}
          onOpenScript={(nodeKey, scenarioKey, title, serviceKey) => { setScriptNode({ nodeKey, scenarioKey, title, serviceKey }); setEditing(null!); window.scrollTo({ top: 0, behavior: "smooth" }); }}
          showErr={showErr} />
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
