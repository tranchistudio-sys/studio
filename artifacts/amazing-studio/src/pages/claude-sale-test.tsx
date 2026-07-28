import { useState, useEffect, useRef, useCallback } from "react";
import { apiUrl } from "@/lib/api-base";
import { getImageSrc } from "@/lib/imageUtils";
import {
  Send, Trash2, Bot, User, Sparkles, Clock, Package, AlertTriangle, Loader2,
  Image as ImageIcon, X, Eye,
  Search, ShieldCheck, ShieldAlert, ChevronDown, ChevronRight, Code2, Route, Brain,
} from "lucide-react";

/**
 * Claude Sale Test (Lulu) — sân test nội bộ cho admin.
 * Mô phỏng khách nhắn (text + ẢNH) → xem Lulu (đúng askClaudeForReply + sale-context
 * + AI Vision) trả lời. KHÔNG gửi Messenger, KHÔNG tạo booking, KHÔNG đụng CRM.
 */

type ImageIntent = {
  image_type: string;
  service_intent: string;
  confidence: number;
  visual_description: string;
  outfit: string;
  mood: string;
  location_type: string;
  required_items: string[];
  can_studio_do: boolean;
  should_use_photo_ideas: boolean;
  recommended_data_source: string;
};

type SampleImage = {
  title: string;
  imageUrl: string;
  detailUrl?: string;
  sourceType: "service_package" | "rental_item" | "gallery" | "photo_idea";
  serviceIntent?: string;
};
type SampleLink = { title: string; url: string };

type ChatMsg = {
  id: string;
  from: "customer" | "claude" | "error" | "vision" | "sample" | "sampleDev" | "trace";
  text: string;
  ts: number;
  image?: string;          // data URL ảnh khách gửi (bubble khách)
  intent?: ImageIntent;    // kết quả classifier (bubble "vision")
  sample?: SampleImage;    // 1 ảnh mẫu Lulu gửi (bubble "sample")
  samples?: SampleImage[]; // nguồn ảnh mẫu (card DEV "sampleDev")
  trace?: SaleTrace;       // trace Workflow V1 shadow (panel "trace")
  llmResponse?: string;    // câu trả lời LLM gắn kèm panel trace
};
type Info = { model: string; hasApiKey: boolean; packageCount: number; totalActive: number; fbBotEnabled: boolean };
type Attached = { dataUrl: string; mediaType: string; name: string };

const STORAGE_KEY = "karuSaleTestHistory_v1";
const ACCEPT = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;

function token(): string | null {
  return localStorage.getItem("amazingStudioToken_v2");
}
function authHeaders(): Record<string, string> {
  const t = token();
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}
function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("read_error"));
    fr.readAsDataURL(file);
  });
}

/** Render nội dung bubble: ảnh [image:url] thành <img>, link http thành <a> bấm được. */
function renderBubbleContent(text: string, isCustomer: boolean, onZoom: (u: string) => void) {
  const img = text.match(/^\s*\[image:(.+?)\]\s*$/);
  if (img) {
    return (
      <img
        src={img[1]} alt="ảnh mẫu" onClick={() => onZoom(img[1])}
        className="rounded-lg max-w-[220px] max-h-60 object-cover cursor-zoom-in"
      />
    );
  }
  const linkCls = isCustomer ? "underline break-all" : "underline text-sky-600 break-all";
  return text.split(/(https?:\/\/[^\s]+)/g).map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a key={i} href={p} target="_blank" rel="noreferrer" className={linkCls}>{p}</a>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function VisionCard({ intent }: { intent: ImageIntent }) {
  const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex gap-1.5"><span className="text-gray-500 shrink-0">{k}:</span><span className="font-medium text-gray-800 break-words">{v}</span></div>
  );
  const conf = Math.round((intent.confidence ?? 0) * 100);
  return (
    <div className="max-w-[85%] mx-auto w-full bg-violet-50 border border-violet-200 rounded-xl px-3 py-2 text-[11px] text-gray-700">
      <div className="flex items-center gap-1.5 font-semibold text-violet-700 mb-1">
        <Eye className="w-3.5 h-3.5" /> AI Vision (DEV) — phân loại ảnh khách
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <Row k="service_intent" v={<b className="text-violet-700">{intent.service_intent}</b>} />
        <Row k="confidence" v={`${conf}%`} />
        <Row k="image_type" v={intent.image_type || "—"} />
        <Row k="mood" v={intent.mood || "—"} />
        <Row k="outfit" v={intent.outfit || "—"} />
        <Row k="recommended" v={intent.recommended_data_source || "—"} />
        <Row k="dùng_ý_tưởng" v={intent.should_use_photo_ideas ? "có" : "không"} />
        <Row k="studio_làm_được" v={intent.can_studio_do ? "có" : "không"} />
      </div>
      {intent.visual_description && <div className="mt-1 text-gray-600 italic">“{intent.visual_description}”</div>}
    </div>
  );
}

const SOURCE_LABEL: Record<SampleImage["sourceType"], string> = {
  service_package: "Gói dịch vụ",
  rental_item: "Cho thuê đồ",
  gallery: "Bộ ảnh / Album",
  photo_idea: "Ý tưởng chụp",
};

/** Một ảnh mẫu Lulu gửi (giống ảnh gửi thật trong Messenger): ảnh + caption + Xem thêm. */
function SampleBubble({ sample, onZoom }: { sample: SampleImage; onZoom: (u: string) => void }) {
  const src = getImageSrc(sample.imageUrl);
  return (
    <div className="flex items-end gap-2 justify-start">
      <div className="w-7 h-7 rounded-full bg-rose-500 flex items-center justify-center text-white shrink-0">
        <Bot className="w-4 h-4" />
      </div>
      <div className="max-w-[75%] bg-white border border-gray-200 rounded-2xl rounded-bl-sm p-1.5">
        {src ? (
          <img
            src={src} alt={sample.title} onClick={() => onZoom(src)}
            className="rounded-xl max-w-[230px] max-h-72 object-cover cursor-zoom-in"
          />
        ) : (
          <div className="w-[230px] h-40 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 text-xs">
            (ảnh lỗi)
          </div>
        )}
        <div className="px-1.5 pt-1 pb-0.5">
          <div className="text-[13px] font-medium text-gray-800 break-words">{sample.title}</div>
          {sample.detailUrl && (
            <a
              href={sample.detailUrl} target="_blank" rel="noreferrer"
              className="text-[12px] text-sky-600 hover:underline inline-flex items-center gap-0.5"
            >
              Xem thêm <Eye className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/** Card DEV: nguồn ảnh mẫu Lulu chọn — để kiểm tra AI bốc đúng nhóm. */
function SampleSourceCard({ samples }: { samples: SampleImage[] }) {
  return (
    <div className="max-w-[88%] mx-auto w-full bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-[11px] text-gray-700">
      <div className="flex items-center gap-1.5 font-semibold text-amber-700 mb-1">
        <ImageIcon className="w-3.5 h-3.5" /> Nguồn ảnh mẫu Lulu chọn (DEV) — {samples.length} ảnh
      </div>
      <div className="space-y-1.5">
        {samples.map((s, i) => (
          <div key={i} className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t border-amber-100 pt-1 first:border-t-0 first:pt-0">
            <span className="text-gray-500">title</span><span className="font-medium text-gray-800 break-words">{s.title}</span>
            <span className="text-gray-500">sourceType</span><span><b className="text-amber-700">{s.sourceType}</b> ({SOURCE_LABEL[s.sourceType]})</span>
            <span className="text-gray-500">serviceIntent</span><span className="text-amber-700">{s.serviceIntent || "—"}</span>
            <span className="text-gray-500">imageUrl</span><span className="text-gray-600 break-all">{s.imageUrl}</span>
            <span className="text-gray-500">detailUrl</span><span className="text-gray-600 break-all">{s.detailUrl || "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TRACE WORKFLOW V1 (shadow) — hiển thị "vì sao Lulu trả lời câu này" ngay trên
// sân test, không cần mở DevTools. FE-ONLY: chỉ đọc object `trace` backend đã trả.
// ─────────────────────────────────────────────────────────────────────────────
type TraceDateSlot = { status: string; eventDate: string | null; dateText: string | null } | null;
type StateSnapshot = {
  dateStatus: string;
  eventDate?: string | null;
  serviceIntent: string | null;
  askedQuestions: Array<{ key: string }>;
  quotedPackages: string[];
};
type RouterDecisionFE = {
  stage: string;
  action: string;
  reason: string;
  requiredData: string[];
  missingData: string[];
  allowedQuestions: string[];
  forbiddenQuestions: string[];
  knowledgeNeeded: string[];
  shouldEscalate: boolean;
};
type ValidatorFE =
  | { verdict: "PASS" }
  | { verdict: "BLOCK"; reason: string; violatedRule: string; severity: "critical" | "major" | "minor"; suggestedRecovery: string }
  | { verdict: "WARN"; reason?: string; violatedRule?: string };
type SaleTrace = {
  shadowMode: boolean;
  message: string;
  extractedSlots: { dateSlot: TraceDateSlot; serviceIntent: string | null };
  stateBefore: StateSnapshot;
  stateAfterIncoming: StateSnapshot;
  routerDecision: RouterDecisionFE;
  knowledgeUsed: string[];
  validator: ValidatorFE;
};

// Nhãn tiếng Việt cho chủ studio (không cần hiểu mã code). Thiếu mã → hiện mã gốc.
const STAGE_LABEL: Record<string, string> = {
  NEW_LEAD: "Khách mới xuất hiện",
  DISCOVERY: "Đang tìm hiểu nhu cầu",
  CONSULTING: "Tư vấn gu / mẫu",
  QUOTE_REFERENCE: "Báo giá tham khảo (chưa có ngày)",
  QUOTED: "Đã báo giá",
  CONSIDERING: "Khách phân vân / so sánh",
  BOOKING_INTENT: "Khách muốn giữ lịch / cọc",
  WAITING: "Chờ khách trả lời",
  HUMAN_REVIEW: "Cần người thật xử lý",
  BOOKED: "Đã cọc / đã thành khách",
};
const ACTION_LABEL: Record<string, string> = {
  GREET: "Chào hỏi",
  IDENTIFY_SERVICE: "Đào sâu nhóm dịch vụ",
  ASK_SERVICE: "Hỏi khách cần dịch vụ gì",
  ASK_DATE: "Hỏi ngày chụp",
  QUOTE_REFERENCE: "Báo giá tham khảo",
  QUOTE_EXACT: "Báo giá chính xác",
  SEND_PRICE: "Gửi bảng giá",
  SEND_SAMPLE: "Gửi ảnh mẫu",
  ANSWER_FAQ: "Trả lời câu hỏi thường gặp",
  HANDLE_OBJECTION: "Xử lý chê giá / phân vân",
  ASK_FOR_BOOKING: "Mời giữ lịch",
  ASK_PHONE: "Xin số điện thoại",
  ESCALATE_HUMAN: "Chuyển người thật",
  WAIT: "Đáp nhẹ, không đẩy bước",
};
const INTENT_LABEL: Record<string, string> = {
  beauty: "Beauty / Trang điểm",
  wedding_album: "Album cưới",
  wedding_gate: "Cổng cưới / Phóng sự",
  wedding_party: "Tiệc cưới",
  rental_outfit: "Thuê trang phục",
  maternity: "Chụp bầu",
  family: "Gia đình",
  new_concept_idea: "Concept mới / Ý tưởng",
  unknown: "Chưa rõ",
};
const KNOWLEDGE_LABEL: Record<string, string> = {
  "faq:address": "FAQ · Địa chỉ",
  "faq:hours": "FAQ · Giờ làm việc",
  "faq:delivery": "FAQ · Giao ảnh",
  "faq:package_detail": "FAQ · Chi tiết gói",
  "faq:services": "FAQ · Danh mục dịch vụ",
  "faq:payment": "FAQ · Thanh toán / cọc",
  pricing: "Bảng giá",
};
const DATESTATUS_LABEL: Record<string, string> = {
  unset: "chưa rõ",
  unknown: "chưa rõ",
  known: "đã có ngày",
  not_decided: "khách chưa chốt ngày",
};
const ASKED_LABEL: Record<string, string> = {
  ask_date: "đã hỏi ngày",
  ask_service: "đã hỏi dịch vụ",
  ask_phone: "đã xin SĐT",
};
const SEVERITY_LABEL: Record<string, string> = {
  critical: "nghiêm trọng",
  major: "nặng",
  minor: "nhẹ",
};
const stageLabel = (s: string) => STAGE_LABEL[s] ?? s;
const actionLabel = (a: string) => ACTION_LABEL[a] ?? a;
const intentLabel = (i: string | null | undefined) => (i ? (INTENT_LABEL[i] ?? i) : "—");
const dateStatusLabel = (d: string) => DATESTATUS_LABEL[d] ?? d;

type ChipTone = "slate" | "green" | "red" | "indigo" | "amber";
function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: ChipTone }) {
  const map: Record<ChipTone, string> = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
    indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
  };
  return <span className={`inline-block px-1.5 py-0.5 rounded border text-[11px] ${map[tone]}`}>{children}</span>;
}
function TraceField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 items-start">
      <span className="text-slate-500 text-[11px] pt-0.5">{label}</span>
      <div className="text-[12px] text-slate-800 flex flex-wrap gap-1 items-center">{children}</div>
    </div>
  );
}
function TraceSection({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-slate-200 pt-2 mt-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 mb-1">{icon}{title}</div>
      {children}
    </div>
  );
}
function StateSnapshotView({ s }: { s: StateSnapshot }) {
  const asked = Array.isArray(s?.askedQuestions) ? s.askedQuestions : [];
  const quoted = Array.isArray(s?.quotedPackages) ? s.quotedPackages : [];
  return (
    <div className="space-y-1">
      <TraceField label="Ngày">
        <b>{dateStatusLabel(s?.dateStatus ?? "unset")}</b>
        {s?.eventDate ? <span className="text-slate-500">· {s.eventDate}</span> : null}
      </TraceField>
      <TraceField label="Nhu cầu">{intentLabel(s?.serviceIntent)}</TraceField>
      <TraceField label="Gói đã báo">
        {quoted.length ? quoted.map((c, i) => <Chip key={i} tone="indigo">{c}</Chip>) : <span className="text-slate-400">chưa có</span>}
      </TraceField>
      <TraceField label="Đã hỏi">
        {asked.length ? asked.map((q, i) => <Chip key={i}>{ASKED_LABEL[q?.key] ?? q?.key ?? "?"}</Chip>) : <span className="text-slate-400">chưa hỏi gì</span>}
      </TraceField>
    </div>
  );
}
function ValidatorView({ v }: { v: ValidatorFE }) {
  if (!v || v.verdict === "PASS") {
    return (
      <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
        <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
        <span className="text-[13px] font-semibold text-emerald-700">Câu trả lời HỢP LỆ — PASS</span>
      </div>
    );
  }
  if (v.verdict === "BLOCK") {
    return (
      <div className="bg-rose-50 border-2 border-rose-400 rounded-lg px-3 py-2 space-y-1">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0" />
          <span className="text-[13px] font-bold text-rose-700">BỊ CHẶN — BLOCK</span>
          <Chip tone="red">{SEVERITY_LABEL[v.severity] ?? v.severity}</Chip>
        </div>
        <TraceField label="Luật vi phạm"><b className="text-rose-700">{v.violatedRule}</b></TraceField>
        <TraceField label="Lý do">{v.reason}</TraceField>
        <TraceField label="Cách sửa">{v.suggestedRecovery}</TraceField>
      </div>
    );
  }
  return (
    <div className="bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 space-y-1">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
        <span className="text-[13px] font-semibold text-amber-700">CẢNH BÁO — WARN</span>
      </div>
      {v.violatedRule ? <TraceField label="Luật">{v.violatedRule}</TraceField> : null}
      {v.reason ? <TraceField label="Lý do">{v.reason}</TraceField> : null}
    </div>
  );
}

/** Panel trace 1 lượt chat: input → slot → state → router → knowledge → LLM → validator. */
function SaleTracePanel({ trace, llmResponse }: { trace: SaleTrace; llmResponse: string }) {
  const [open, setOpen] = useState(true);
  const [rawOpen, setRawOpen] = useState(false);
  const r = trace.routerDecision ?? ({} as RouterDecisionFE);
  const blocked = trace.validator?.verdict === "BLOCK";
  const warned = trace.validator?.verdict === "WARN";
  const allowedQ = Array.isArray(r.allowedQuestions) ? r.allowedQuestions : [];
  const forbiddenQ = Array.isArray(r.forbiddenQuestions) ? r.forbiddenQuestions : [];
  const requiredD = Array.isArray(r.requiredData) ? r.requiredData : [];
  const missingD = Array.isArray(r.missingData) ? r.missingData : [];
  const knowledge = Array.isArray(trace.knowledgeUsed) ? trace.knowledgeUsed : [];
  const ds = trace.extractedSlots?.dateSlot ?? null;
  return (
    <div
      className={`max-w-[92%] mx-auto w-full rounded-xl border overflow-hidden ${
        blocked ? "border-rose-300 bg-rose-50/40" : warned ? "border-amber-300 bg-amber-50/40" : "border-indigo-200 bg-indigo-50/40"
      }`}
    >
      {/* Header — bấm để thu/mở; verdict luôn hiện để so nhanh khi cuộn lịch sử */}
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <Search className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
        <span className="text-[12px] font-semibold text-indigo-700 shrink-0">Trace Workflow V1</span>
        <span className="text-[11px] text-slate-500 truncate">{stageLabel(r.stage)} → {actionLabel(r.action)}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {blocked ? (
            <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white text-[11px] font-bold">BLOCK</span>
          ) : warned ? (
            <span className="px-2 py-0.5 rounded-full bg-amber-500 text-white text-[11px] font-bold">WARN</span>
          ) : (
            <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-semibold">PASS</span>
          )}
          {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3">
          <div className="mb-1">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 text-[10px] font-medium">
              SHADOW · chỉ quan sát, chưa ép câu trả lời khách
            </span>
          </div>

          <TraceSection icon={<User className="w-3 h-3" />} title="Tin khách (input)">
            <div className="text-[12px] text-slate-800 bg-white border border-slate-200 rounded px-2 py-1 whitespace-pre-wrap break-words">
              {trace.message || <span className="text-slate-400">(trống)</span>}
            </div>
          </TraceSection>

          <TraceSection icon={<Sparkles className="w-3 h-3" />} title="Slot rút được từ tin">
            <TraceField label="Ngày">
              {ds ? (
                <>
                  <b>{dateStatusLabel(ds.status)}</b>
                  {ds.dateText ? <span className="text-slate-500">· {ds.dateText}</span> : null}
                  {ds.eventDate ? <span className="text-slate-500">· {ds.eventDate}</span> : null}
                </>
              ) : (
                <span className="text-slate-400">không rút được</span>
              )}
            </TraceField>
            <TraceField label="Nhu cầu">{intentLabel(trace.extractedSlots?.serviceIntent)}</TraceField>
          </TraceSection>

          <div className="border-t border-slate-200 pt-2 mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] font-semibold text-slate-600 mb-1">Trạng thái TRƯỚC lượt này</div>
              <StateSnapshotView s={trace.stateBefore} />
            </div>
            <div>
              <div className="text-[11px] font-semibold text-slate-600 mb-1">SAU khi đọc tin khách</div>
              <StateSnapshotView s={trace.stateAfterIncoming} />
            </div>
          </div>

          <TraceSection icon={<Route className="w-3 h-3" />} title="Router quyết định">
            <TraceField label="Giai đoạn"><Chip tone="indigo">{stageLabel(r.stage)}</Chip><span className="text-slate-400 text-[10px]">{r.stage}</span></TraceField>
            <TraceField label="Hành động"><Chip tone="indigo">{actionLabel(r.action)}</Chip><span className="text-slate-400 text-[10px]">{r.action}</span></TraceField>
            <TraceField label="Lý do">{r.reason || "—"}</TraceField>
            <TraceField label="Được phép hỏi">
              {allowedQ.length ? allowedQ.map((q, i) => <Chip key={i} tone="green">{q}</Chip>) : <span className="text-slate-400">—</span>}
            </TraceField>
            <TraceField label="Bị cấm hỏi">
              {forbiddenQ.length ? forbiddenQ.map((q, i) => <Chip key={i} tone="red">{q}</Chip>) : <span className="text-slate-400">—</span>}
            </TraceField>
            <TraceField label="Cần dữ kiện">
              {requiredD.length ? requiredD.map((d, i) => <Chip key={i}>{d}</Chip>) : <span className="text-slate-400">—</span>}
            </TraceField>
            <TraceField label="Còn thiếu">
              {missingD.length ? missingD.map((d, i) => <Chip key={i} tone="red">{d}</Chip>) : <span className="text-slate-400">đủ</span>}
            </TraceField>
            <TraceField label="Chuyển người">{r.shouldEscalate ? <Chip tone="red">CÓ</Chip> : <span className="text-slate-500">không</span>}</TraceField>
          </TraceSection>

          <TraceSection icon={<Brain className="w-3 h-3" />} title="Kiến thức cần nạp">
            {knowledge.length ? knowledge.map((k, i) => <Chip key={i} tone="amber">{KNOWLEDGE_LABEL[k] ?? k}</Chip>) : <span className="text-slate-400">không cần</span>}
          </TraceSection>

          <TraceSection icon={<Bot className="w-3 h-3" />} title="Câu trả lời Lulu (LLM)">
            <div className="text-[12px] text-slate-800 bg-white border border-slate-200 rounded px-2 py-1 whitespace-pre-wrap break-words">
              {llmResponse || <span className="text-slate-400">(trống)</span>}
            </div>
          </TraceSection>

          <TraceSection icon={<ShieldCheck className="w-3 h-3" />} title="Validator chấm câu trả lời">
            <ValidatorView v={trace.validator} />
          </TraceSection>

          <div className="border-t border-slate-200 pt-2 mt-2">
            <button onClick={() => setRawOpen((o) => !o)} className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700">
              <Code2 className="w-3 h-3" /> {rawOpen ? "Ẩn JSON thô" : "Xem JSON thô"}
              {rawOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
            {rawOpen && (
              <pre className="mt-1 max-h-64 overflow-auto text-[10px] leading-snug bg-slate-800 text-slate-100 rounded-lg p-2 whitespace-pre-wrap break-words">
                {JSON.stringify({ ...trace, llmResponse }, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ClaudeSaleTestPage() {
  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as ChatMsg[]) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState("");
  const [attached, setAttached] = useState<Attached | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-200))); } catch { /* quota */ }
  }, [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    fetch(apiUrl("/api/claude-sale-test/info"), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setInfo(d as Info))
      .catch(() => {});
  }, []);

  const acceptFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    if (!ACCEPT.includes(file.type)) { alert("Chỉ nhận ảnh jpg, jpeg, png, webp"); return; }
    if (file.size > MAX_BYTES) { alert("Ảnh quá lớn (tối đa 5MB)"); return; }
    try {
      const dataUrl = await fileToDataUrl(file);
      setAttached({ dataUrl, mediaType: file.type, name: file.name || "image" });
    } catch { alert("Không đọc được ảnh"); }
  }, []);

  // Ctrl+V dán ảnh — CHỈ trên màn này (listener gỡ khi rời trang).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); acceptFile(f); break; }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptFile]);

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !attached) || loading) return;
    const img = attached;
    const userMsg: ChatMsg = { id: newId(), from: "customer", text, ts: Date.now(), image: img?.dataUrl };
    // Gồm cả ảnh mẫu ĐÃ GỬI (dạng [image:url]) để backend loại trùng — KHÔNG gửi lại ảnh cũ.
    const prior = messages
      .filter((m) => m.from === "customer" || m.from === "claude" || m.from === "sample")
      .map((m) => {
        if (m.from === "sample") {
          return { direction: "outgoing", text: m.sample?.imageUrl ? `[image:${m.sample.imageUrl}]` : "" };
        }
        return {
          direction: m.from === "customer" ? "incoming" : "outgoing",
          text: m.text || (m.image ? "[Khách gửi một hình ảnh]" : ""),
        };
      })
      .filter((m) => m.text);
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setAttached(null);
    setLoading(true);
    try {
      const r = await fetch(apiUrl("/api/claude-sale-test/chat"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          message: text,
          messages: prior,
          ...(img ? { imageBase64: img.dataUrl, imageMediaType: img.mediaType } : {}),
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        setMessages((prev) => [...prev, { id: newId(), from: "error", text: data?.error || "Lỗi không xác định", ts: Date.now() }]);
      } else {
        setLastMs(typeof data.responseTimeMs === "number" ? data.responseTimeMs : null);
        if (data.model && info) setInfo({ ...info, model: data.model });
        // Kết quả AI Vision (DEV) hiện ngay trước câu trả lời.
        if (data.imageIntent) {
          setMessages((prev) => [...prev, { id: newId(), from: "vision", text: "", ts: Date.now(), intent: data.imageIntent as ImageIntent }]);
        }
        // ẢNH MẪU THẬT: gửi HÌNH trực tiếp TRƯỚC text (giống Messenger). DEV card hiện nguồn ảnh.
        const sampleImages: SampleImage[] = Array.isArray(data.sampleImages) ? data.sampleImages : [];
        if (sampleImages.length > 0) {
          setMessages((prev) => [...prev, { id: newId(), from: "sampleDev", text: "", ts: Date.now(), samples: sampleImages }]);
          for (const s of sampleImages) {
            await sleep(500);
            setMessages((prev) => [...prev, { id: newId(), from: "sample", text: "", ts: Date.now(), sample: s }]);
          }
        }
        // BẢNG GIÁ: gửi HÌNH bảng giá TRƯỚC text (yêu cầu: hình giá trước, lời giải thích bên dưới).
        const priceImages: string[] = Array.isArray(data.priceImages) ? data.priceImages : [];
        for (const objectPath of priceImages) {
          const url = getImageSrc(objectPath);
          if (!url) continue;
          await sleep(500);
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: `[image:${url}]`, ts: Date.now() }]);
        }
        const chunks: string[] = (Array.isArray(data.reply) ? data.reply : [String(data.reply ?? "")]).filter((c: string) => c && c.trim());
        for (let i = 0; i < chunks.length; i++) {
          const delay = i === 0
            ? (typeof data.replyDelayMs === "number" ? data.replyDelayMs : 400)
            : Math.min(1800, 500 + chunks[i].length * 16);
          await sleep(delay);
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: chunks[i], ts: Date.now() }]);
        }
        // Link "xem thêm" (nếu Lulu có ảnh mẫu kèm link chi tiết) — 1 bubble gọn sau text.
        const sampleLinks: SampleLink[] = Array.isArray(data.sampleLinks) ? data.sampleLinks : [];
        for (const lk of sampleLinks) {
          if (!lk?.url) continue;
          await sleep(400);
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: `${lk.title}: ${lk.url}`, ts: Date.now() }]);
        }
        // Khách đòi xem thêm nhưng đã hết mẫu mới → câu nhắn khéo (không lặp ảnh cũ).
        if (typeof data.sampleNote === "string" && data.sampleNote.trim()) {
          await sleep(400);
          setMessages((prev) => [...prev, { id: newId(), from: "claude", text: data.sampleNote, ts: Date.now() }]);
        }
        // PANEL TRACE (shadow, 1 panel/lượt): để chủ studio soi "vì sao Lulu trả lời câu này"
        // ngay trên sân test, không cần mở DevTools. Chỉ đọc trace backend đã trả — FE thuần.
        if (data.trace) {
          setMessages((prev) => [...prev, {
            id: newId(),
            from: "trace",
            text: "",
            ts: Date.now(),
            trace: data.trace as SaleTrace,
            llmResponse: typeof data.replyText === "string" ? data.replyText : (typeof data.raw === "string" ? data.raw : ""),
          }]);
        }
      }
    } catch (e) {
      setMessages((prev) => [...prev, { id: newId(), from: "error", text: `Lỗi kết nối: ${String(e).slice(0, 200)}`, ts: Date.now() }]);
    } finally {
      setLoading(false);
    }
  }, [input, attached, loading, messages, info]);

  const clearChat = () => {
    if (messages.length === 0 || confirm("Xóa toàn bộ hội thoại test?")) {
      setMessages([]);
      setLastMs(null);
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) acceptFile(f);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-white rounded-t-xl">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-full bg-rose-500 flex items-center justify-center text-white shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-gray-800 truncate">Lulu Sale Test</div>
            <div className="text-xs text-gray-500 truncate">Mô phỏng khách (text + ảnh) — không gửi ra Messenger, không tạo booking</div>
          </div>
        </div>
        <button
          onClick={clearChat}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-rose-600 px-2 py-1 rounded-md hover:bg-rose-50 shrink-0"
          title="Xóa hội thoại"
        >
          <Trash2 className="w-4 h-4" /> Xóa
        </button>
      </div>

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 bg-gray-50 border-b text-xs text-gray-600">
        <span className="flex items-center gap-1"><Bot className="w-3.5 h-3.5 text-rose-500" /> Model: <b className="text-gray-800">{info?.model ?? "…"}</b></span>
        <span className="flex items-center gap-1"><Package className="w-3.5 h-3.5 text-amber-500" /> Gói bán lẻ: <b className="text-gray-800">{info ? `${info.packageCount}/${info.totalActive}` : "…"}</b></span>
        <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-sky-500" /> Phản hồi: <b className="text-gray-800">{lastMs != null ? `${(lastMs / 1000).toFixed(1)}s` : "—"}</b></span>
        {info && !info.hasApiKey && (
          <span className="flex items-center gap-1 text-rose-600"><AlertTriangle className="w-3.5 h-3.5" /> Chưa có ANTHROPIC_API_KEY</span>
        )}
        {info && (
          <span className={`ml-auto px-2 py-0.5 rounded-full ${info.fbBotEnabled ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600"}`}>
            Fanpage: {info.fbBotEnabled ? "ĐANG BẬT" : "đang tắt"}
          </span>
        )}
      </div>

      {/* Messages (drop zone) */}
      <div
        ref={scrollRef}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
        onDrop={onDrop}
        className="relative flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-[#f5f3ef]"
      >
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-rose-500/10 border-2 border-dashed border-rose-400 rounded-lg pointer-events-none">
            <div className="bg-white/90 px-4 py-2 rounded-lg text-rose-600 font-medium flex items-center gap-2">
              <ImageIcon className="w-5 h-5" /> Thả ảnh để gửi thử
            </div>
          </div>
        )}
        {messages.length === 0 && (
          <div className="text-center text-gray-400 text-sm mt-10">
            Nhập tin nhắn như một khách hàng để xem Lulu tư vấn.<br />
            Gửi kèm ảnh (nút 🖼️, kéo-thả, hoặc Ctrl+V) để test AI Vision.<br />
            Ví dụ: <i>"Bộ này bên mình chụp được không?"</i> + đính kèm ảnh.
          </div>
        )}
        {messages.map((m) => {
          if (m.from === "error") {
            return (
              <div key={m.id} className="flex justify-center">
                <div className="max-w-[85%] bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg px-3 py-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" /> {m.text}
                </div>
              </div>
            );
          }
          if (m.from === "vision" && m.intent) {
            return <div key={m.id} className="flex justify-center"><VisionCard intent={m.intent} /></div>;
          }
          if (m.from === "sampleDev" && m.samples) {
            return <div key={m.id} className="flex justify-center"><SampleSourceCard samples={m.samples} /></div>;
          }
          if (m.from === "trace" && m.trace) {
            return <div key={m.id} className="flex justify-center"><SaleTracePanel trace={m.trace} llmResponse={m.llmResponse ?? ""} /></div>;
          }
          if (m.from === "sample" && m.sample) {
            return <SampleBubble key={m.id} sample={m.sample} onZoom={setZoom} />;
          }
          const isCustomer = m.from === "customer";
          return (
            <div key={m.id} className={`flex items-end gap-2 ${isCustomer ? "justify-end" : "justify-start"}`}>
              {!isCustomer && (
                <div className="w-7 h-7 rounded-full bg-rose-500 flex items-center justify-center text-white shrink-0">
                  <Bot className="w-4 h-4" />
                </div>
              )}
              <div
                className={`max-w-[75%] px-3.5 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                  isCustomer
                    ? "bg-sky-500 text-white rounded-br-sm"
                    : "bg-white text-gray-800 border border-gray-200 rounded-bl-sm"
                }`}
              >
                {m.image && (
                  <img
                    src={m.image} alt="ảnh khách" onClick={() => setZoom(m.image!)}
                    className={`rounded-lg max-w-[220px] max-h-60 object-cover cursor-zoom-in ${m.text ? "mb-1.5" : ""}`}
                  />
                )}
                {m.text && (m.image ? <div>{m.text}</div> : renderBubbleContent(m.text, isCustomer, setZoom))}
              </div>
              {isCustomer && (
                <div className="w-7 h-7 rounded-full bg-sky-600 flex items-center justify-center text-white shrink-0">
                  <User className="w-4 h-4" />
                </div>
              )}
            </div>
          );
        })}
        {loading && (
          <div className="flex items-end gap-2 justify-start">
            <div className="w-7 h-7 rounded-full bg-rose-500 flex items-center justify-center text-white shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-sm px-4 py-3">
              <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
            </div>
          </div>
        )}
      </div>

      {/* Preview ảnh đính kèm */}
      {attached && (
        <div className="flex items-center gap-2 px-3 py-2 border-t bg-gray-50">
          <div className="relative">
            <img src={attached.dataUrl} alt="đính kèm" className="w-14 h-14 rounded-lg object-cover border" />
            <button
              onClick={() => setAttached(null)}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-700 text-white flex items-center justify-center hover:bg-rose-600"
              title="Bỏ ảnh"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <span className="text-xs text-gray-500 truncate">{attached.name} — sẽ gửi kèm tin nhắn</span>
        </div>
      )}

      {/* Input */}
      <div className="flex items-end gap-2 p-3 border-t bg-white rounded-b-xl">
        <input
          ref={fileRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" className="hidden"
          onChange={(e) => { acceptFile(e.target.files?.[0]); if (fileRef.current) fileRef.current.value = ""; }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={loading}
          className="w-10 h-10 rounded-full border border-gray-300 text-gray-500 flex items-center justify-center hover:bg-gray-100 disabled:opacity-40 shrink-0"
          title="Gửi ảnh (jpg, png, webp) — hoặc kéo-thả / Ctrl+V"
        >
          <ImageIcon className="w-5 h-5" />
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Nhập tin nhắn của khách… (Enter để gửi, Shift+Enter xuống dòng)"
          rows={1}
          className="flex-1 resize-none max-h-32 px-3 py-2 border border-gray-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-rose-300"
        />
        <button
          onClick={send}
          disabled={loading || (!input.trim() && !attached)}
          className="w-10 h-10 rounded-full bg-rose-500 text-white flex items-center justify-center hover:bg-rose-600 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          title="Gửi"
        >
          {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
        </button>
      </div>

      {/* Lightbox phóng to ảnh */}
      {zoom && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6" onClick={() => setZoom(null)}>
          <img src={zoom} alt="phóng to" className="max-w-full max-h-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  );
}
