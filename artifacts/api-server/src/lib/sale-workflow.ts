import type { ThreadState } from "./sale-thread-state";
import { detectPhone, detectAppointmentIntent, detectEscalation } from "./sale-lead-flags";

/**
 * SALE WORKFLOW V1 — Router + Playbook máy-đọc-được cho Lulu ("khúc giữa" tầng 2-3).
 *
 * OFFLINE MODULE: chưa nối vào luồng Messenger production. Hiện chỉ chạy ở:
 *   - sân test Claude Sale Test (shadow mode — hiển thị Router SẼ quyết gì, không ép LLM);
 *   - Golden Test Set (sale-workflow-golden.test.ts).
 * Nối thật vào fb-inbox là bước RIÊNG, chỉ làm sau khi thread-state chạy ổn trên pilot
 * (chỉ đạo chủ studio 28/07: "State ổn mới Router+Validator, không nhét thêm rule vào prompt").
 *
 * NGUYÊN TẮC: mọi Business Rule CỨNG (không hỏi lại ngày khi khách đã nói chưa chốt,
 * không lặp câu hỏi, escalation tiền/cọc/khiếu nại) quyết định bằng CODE deterministic —
 * KHÔNG giao cho LLM. LLM chỉ "viết lời" cho action đã chọn.
 *
 * THUẦN: không DB, không AI, không I/O → test được 100%.
 */

// ─── Kiểu dữ liệu ─────────────────────────────────────────────────────────────

export type SaleStage =
  | "NEW_LEAD"        // chưa có gì — khách vừa xuất hiện
  | "DISCOVERY"       // đang tìm hiểu khách cần dịch vụ gì
  | "CONSULTING"      // đã rõ nhóm dịch vụ — tư vấn gu/mẫu
  | "QUOTE_REFERENCE" // khách chưa chốt ngày — chỉ báo giá tham khảo
  | "QUOTED"          // đã báo giá
  | "CONSIDERING"     // sau báo giá: phân vân / so sánh / chê giá
  | "BOOKING_INTENT"  // khách muốn giữ lịch / để SĐT / cọc
  | "WAITING"         // bot đã hỏi, chờ khách (stage nghỉ giữa lượt)
  | "HUMAN_REVIEW";   // người thật phải xử lý

export type SaleAction =
  | "GREET"
  | "IDENTIFY_SERVICE" // đã rõ nhóm — đào sâu (loại con / gu)
  | "ASK_SERVICE"      // chưa rõ nhóm — hỏi khách cần gì
  | "ASK_DATE"
  | "QUOTE_REFERENCE"  // báo giá THAM KHẢO (chưa có ngày) + câu "xác nhận lại khi có ngày"
  | "QUOTE_EXACT"      // báo giá khi đã đủ dữ kiện
  | "SEND_PRICE"       // gửi ảnh/bảng giá (khách xin bảng giá)
  | "SEND_SAMPLE"      // gửi ảnh mẫu (khách đòi xem / đồng ý xem)
  | "ANSWER_FAQ"
  | "HANDLE_OBJECTION" // khách chê giá / so sánh — đồng cảm + giá trị, KHÔNG tự giảm
  | "ASK_FOR_BOOKING"  // mời giữ lịch
  | "ASK_PHONE"
  | "ESCALATE_HUMAN"
  | "WAIT";            // tin không tín hiệu (ack cụt) — đáp nhẹ, không đẩy bước mới

export type RouterInput = {
  customerMessage: string;
  /** Trạng thái thread (từ lulu_thread_state thật hoặc simulateThreadStateFromHistory). */
  threadState: ThreadState;
  /** true nếu đây là tin ĐẦU TIÊN của thread (chưa có lịch sử). */
  isFirstContact: boolean;
};

export type RouterDecision = {
  stage: SaleStage;
  action: SaleAction;
  /** Vì sao chọn action này — hiển thị cho người vận hành (trace). */
  reason: string;
  requiredData: string[];
  missingData: string[];
  allowedQuestions: string[];
  forbiddenQuestions: string[];
  /** Nguồn knowledge cần nạp cho LLM ở action này (đặt nền cho context-theo-action). */
  knowledgeNeeded: string[];
  shouldEscalate: boolean;
};

// ─── PLAYBOOK V1 (machine-readable) ───────────────────────────────────────────
// Mỗi stage: mục tiêu, điều kiện vào, dữ liệu cần, action được phép/bị cấm,
// điều kiện hoàn thành, stage kế, khi nào chuyển người thật.
// Router DÙNG THẬT bảng này (enforcePlaybook) — không phải tài liệu suông.

export type StageDef = {
  goal: string;
  entryWhen: string;
  requiredData: string[];
  allowedActions: SaleAction[];
  forbiddenActions: SaleAction[];
  doneWhen: string;
  nextStages: SaleStage[];
  escalateWhen: string;
};

export const SALE_PLAYBOOK_V1: Record<SaleStage, StageDef> = {
  NEW_LEAD: {
    goal: "Chào tự nhiên, mở chuyện để biết khách cần gì",
    entryWhen: "Thread mới, chưa có service_intent",
    requiredData: [],
    allowedActions: ["GREET", "ASK_SERVICE", "ANSWER_FAQ", "WAIT", "ESCALATE_HUMAN"],
    forbiddenActions: ["QUOTE_EXACT", "SEND_PRICE", "ASK_PHONE", "ASK_DATE"],
    doneWhen: "Biết được service_intent",
    nextStages: ["DISCOVERY", "CONSULTING"],
    escalateWhen: "Khách mở đầu bằng khiếu nại / đòi gặp người thật",
  },
  DISCOVERY: {
    goal: "Chốt được khách cần NHÓM dịch vụ nào",
    entryWhen: "Có hội thoại nhưng service_intent chưa rõ",
    requiredData: ["service_intent"],
    allowedActions: ["ASK_SERVICE", "IDENTIFY_SERVICE", "ANSWER_FAQ", "SEND_SAMPLE", "WAIT", "ESCALATE_HUMAN"],
    forbiddenActions: ["QUOTE_EXACT", "SEND_PRICE", "ASK_PHONE"],
    doneWhen: "service_intent xác định",
    nextStages: ["CONSULTING"],
    escalateWhen: "Từ khóa escalation (cọc/CK/khiếu nại/gặp người)",
  },
  CONSULTING: {
    goal: "Tư vấn đúng nhóm: gu, mẫu, giải đáp — dẫn tới báo giá",
    entryWhen: "service_intent đã rõ",
    requiredData: ["service_intent"],
    allowedActions: [
      "IDENTIFY_SERVICE", "ASK_DATE", "SEND_SAMPLE", "ANSWER_FAQ",
      "QUOTE_REFERENCE", "QUOTE_EXACT", "SEND_PRICE", "ASK_FOR_BOOKING", "WAIT", "ESCALATE_HUMAN",
    ],
    forbiddenActions: ["GREET", "ASK_SERVICE"],
    doneWhen: "Khách hỏi giá hoặc muốn giữ lịch",
    nextStages: ["QUOTE_REFERENCE", "QUOTED", "BOOKING_INTENT"],
    escalateWhen: "Concept lạ ngoài dữ liệu / từ khóa escalation",
  },
  QUOTE_REFERENCE: {
    goal: "Khách CHƯA chốt ngày vẫn được báo giá tham khảo đầy đủ — không ép ngày",
    entryWhen: "slots.date_status = not_decided và khách quan tâm giá",
    requiredData: ["service_intent"],
    allowedActions: ["QUOTE_REFERENCE", "SEND_PRICE", "SEND_SAMPLE", "ANSWER_FAQ", "HANDLE_OBJECTION", "WAIT", "ESCALATE_HUMAN"],
    forbiddenActions: ["ASK_DATE", "GREET", "ASK_SERVICE"],
    doneWhen: "Khách có ngày (tự khai) hoặc muốn giữ lịch",
    nextStages: ["QUOTED", "CONSIDERING", "BOOKING_INTENT"],
    escalateWhen: "Khách deal giá sâu / muốn cọc",
  },
  QUOTED: {
    goal: "Đã báo giá — giải thích gói, so sánh, đẩy nhẹ sang giữ lịch",
    entryWhen: "quoted_packages có ít nhất 1 gói",
    requiredData: ["service_intent"],
    allowedActions: [
      "ANSWER_FAQ", "SEND_SAMPLE", "SEND_PRICE", "QUOTE_EXACT", "QUOTE_REFERENCE",
      "HANDLE_OBJECTION", "ASK_FOR_BOOKING", "ASK_DATE", "ASK_PHONE", "WAIT", "ESCALATE_HUMAN",
    ],
    forbiddenActions: ["GREET", "ASK_SERVICE"],
    doneWhen: "Khách đồng ý giữ lịch / để SĐT",
    nextStages: ["CONSIDERING", "BOOKING_INTENT"],
    escalateWhen: "Xin giảm giá / phát sinh phức tạp",
  },
  CONSIDERING: {
    goal: "Khách phân vân sau báo giá — xử lý băn khoăn bằng giá trị, không tự giảm",
    entryWhen: "Sau báo giá, khách chê giá / so sánh / chần chừ",
    requiredData: [],
    allowedActions: ["HANDLE_OBJECTION", "ANSWER_FAQ", "SEND_SAMPLE", "ASK_FOR_BOOKING", "WAIT", "ESCALATE_HUMAN"],
    forbiddenActions: ["GREET", "ASK_SERVICE", "QUOTE_EXACT"],
    doneWhen: "Khách quay lại quan tâm hoặc rời đi",
    nextStages: ["BOOKING_INTENT", "WAITING"],
    escalateWhen: "Deal giá cụ thể — người thật quyết",
  },
  BOOKING_INTENT: {
    goal: "Khách muốn giữ lịch/cọc/đã cho SĐT — khép kín: ngày + SĐT + bàn giao người thật",
    entryWhen: "Ý định đặt lịch / có SĐT / nhắc cọc",
    requiredData: ["service_intent", "event_date", "phone"],
    allowedActions: ["ASK_DATE", "ASK_PHONE", "ANSWER_FAQ", "ESCALATE_HUMAN", "WAIT"],
    forbiddenActions: ["GREET", "ASK_SERVICE"],
    doneWhen: "Đủ ngày + SĐT → bàn giao nhân viên",
    nextStages: ["HUMAN_REVIEW", "WAITING"],
    escalateWhen: "LUÔN bàn giao người thật để chốt cọc (bot không bao giờ tự chốt)",
  },
  WAITING: {
    goal: "Bot đã hỏi/gửi đủ — chờ khách, không dồn ép",
    entryWhen: "Không còn tín hiệu mới từ khách",
    requiredData: [],
    allowedActions: ["WAIT", "ANSWER_FAQ", "SEND_SAMPLE", "ESCALATE_HUMAN"],
    forbiddenActions: ["ASK_DATE", "ASK_PHONE"],
    doneWhen: "Khách nhắn lại có tín hiệu",
    nextStages: ["CONSULTING", "QUOTED", "BOOKING_INTENT"],
    escalateWhen: "—",
  },
  HUMAN_REVIEW: {
    goal: "Người thật tiếp quản — bot chỉ giữ khách lịch sự",
    entryWhen: "Escalation (cọc/CK/khiếu nại/gặp người/concept lạ)",
    requiredData: [],
    allowedActions: ["ESCALATE_HUMAN", "WAIT"],
    forbiddenActions: [
      "GREET", "ASK_SERVICE", "ASK_DATE", "QUOTE_REFERENCE", "QUOTE_EXACT",
      "SEND_PRICE", "SEND_SAMPLE", "ASK_FOR_BOOKING", "ASK_PHONE",
    ],
    doneWhen: "Nhân viên xử lý xong, mở lại bot",
    nextStages: ["CONSULTING", "QUOTED"],
    escalateWhen: "Mặc định đã ở người thật",
  },
};

// ─── Nhận diện tín hiệu trong tin khách (thuần regex, đã bỏ dấu) ──────────────

function normalizeVi(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}

const PRICE_QUESTION_RE =
  /(gia (sao|the nao|nhieu|bao nhieu)|bao nhieu (tien|1 goi|mot goi)?|nhieu tien|gia ca|bang gia|hoi gia|xin gia|cho.{0,8}gia|gia goi|combo bao nhieu|het bao nhieu|tam bao nhieu|khoang bao nhieu)/;
const SEND_PRICELIST_RE = /((gui|xin|cho)[^.?!\n]{0,15}bang gia|bang gia day du|gui gia\b)/;
// Khách đòi gặp người thật — check trên text ĐÃ BỎ DẤU vì detectEscalation (prod) dùng
// class [oơ] không chứa "ờ" nên "người thật" gõ đủ dấu KHÔNG match (bug tiềm ẩn prod,
// đã ghi vào báo cáo — không sửa file prod trong PR offline này).
const WANT_HUMAN_RE = /((gap|noi chuyen voi|cho (gap|noi chuyen))\s*(nguoi that|nhan vien|nguoi tu van|ai do)|can nguoi that|nguoi that (tu van|tra loi))/;
const WANT_SAMPLE_RE =
  /(xem (anh|hinh|mau|album|bo anh)|cho.{0,10}(mau|anh mau|hinh)|co (mau|anh mau|hinh mau)|gui (anh|hinh|mau)|mau (nao )?dep|anh (that|chup) (cua )?ben|cho coi|xem thu)/;
const GREETING_ONLY_RE = /^(hi+|hello+|alo+|chao (em|shop|ban|anh|chi)?|xin chao|cho hoi|e oi|em oi|shop oi)[.!~\s]*$/;
const SHORT_ACK_RE = /^(da|vang|ok(e|ie)?|uh+|u+m+|dạ|ừ|uk|okay|👍|\.+)[.!\s]*$/;
// Khách quay lại thăm dò ("còn đó không / ngủ chưa") — đáp nhẹ, không đẩy bước.
const PRESENCE_CHECK_RE = /(con (do|o do|day) (khong|ko|hong)|ngu chua|co (do|day) (khong|ko)|check tin nhan|thay tin nhan (khong|ko))/;

// FAQ topic → knowledge cần nạp. (Nguồn FAQ có cấu trúc CHƯA tồn tại — known gap từ audit;
// router vẫn trả knowledgeNeeded để tầng knowledge sau này nạp đúng.)
const FAQ_TOPICS: Array<{ topic: string; re: RegExp }> = [
  { topic: "faq:address", re: /(dia chi|o dau|cho nao|nam o|studio o|toi dau|den dau|duong nao)/ },
  { topic: "faq:hours", re: /(may gio|gio mo|gio lam viec|mo cua|dong cua)/ },
  { topic: "faq:delivery", re: /(bao lau (co|nhan|lay)|khi nao (co|nhan|lay)) (anh|hinh)|bao lau xong|may ngay (co|tra) (anh|hinh)/ },
  { topic: "faq:package_detail", re: /(gom (nhung )?gi|bao gom|co nhung gi|trong goi co|goi nay (co|gom))/ },
  { topic: "faq:services", re: /(co (vay|ao dai|vest|makeup|trang diem|quay phim|make up)|ben (em|minh) co)/ },
  { topic: "faq:payment", re: /(thanh toan|tra gop|coc bao nhieu|dat coc bao nhieu)/ },
];

function detectFaqTopic(t: string): string | null {
  for (const f of FAQ_TOPICS) if (f.re.test(t)) return f.topic;
  return null;
}

// Lý do nghiệp vụ MỚI được phép mở lại câu hỏi ngày (theo chỉ đạo golden flow):
// khách muốn giữ lịch / đặt cọc / nhờ kiểm tra lịch cụ thể.
const REOPEN_DATE_RE = /(giu lich|chot lich|dat lich|book lich|dat coc|coc giu|kiem tra lich|xem lich (giup|gium)|con lich khong|ngay .{0,12}con (trong|lich))/;

// ─── Suy stage từ state (V1: stage suy mỗi lượt, chưa persist current_stage) ──

export function deriveStage(state: ThreadState, opts?: { isFirstContact?: boolean }): SaleStage {
  if (opts?.isFirstContact) return "NEW_LEAD";
  if (state.quotedPackages.length > 0) return "QUOTED";
  if (state.slots.date_status === "not_decided") {
    // Chưa chốt ngày + đã rõ nhóm → làm việc ở chế độ tham khảo.
    return state.serviceIntent ? "QUOTE_REFERENCE" : "DISCOVERY";
  }
  if (state.serviceIntent) return "CONSULTING";
  if (state.lastUserMessageAt || state.lastBotMessageAt) return "DISCOVERY";
  return "NEW_LEAD";
}

// ─── Router ───────────────────────────────────────────────────────────────────

const KNOWLEDGE_BY_ACTION: Partial<Record<SaleAction, (intent: string | null) => string[]>> = {
  QUOTE_REFERENCE: (i) => [`pricing:${i ?? "all"}`],
  QUOTE_EXACT: (i) => [`pricing:${i ?? "all"}`],
  SEND_PRICE: (i) => [`pricing:${i ?? "all"}`, "price_images"],
  SEND_SAMPLE: (i) => [`gallery:${i ?? "all"}`],
  IDENTIFY_SERVICE: (i) => [`services:${i ?? "all"}`],
  ASK_SERVICE: () => ["services:menu"],
};

function baseDecision(stage: SaleStage, action: SaleAction, reason: string): RouterDecision {
  return {
    stage,
    action,
    reason,
    requiredData: [],
    missingData: [],
    allowedQuestions: [],
    forbiddenQuestions: [],
    knowledgeNeeded: [],
    shouldEscalate: false,
  };
}

/**
 * Tính danh sách câu hỏi BỊ CẤM từ state (rule cứng — chạy cho MỌI quyết định):
 *  - ask_date cấm khi khách ĐÃ nói chưa chốt ngày (trừ khi có lý do nghiệp vụ mới).
 *  - ask_date cấm khi đã hỏi mà khách chưa trả lời (đừng lặp).
 *  - mọi câu đã hỏi >=2 lần đều cấm.
 */
export function computeForbiddenQuestions(state: ThreadState, reopenDate: boolean): string[] {
  const forbidden = new Set<string>();
  const askedDate = state.askedQuestions.find((q) => q.key === "ask_date");
  if (!reopenDate) {
    if (state.slots.date_status === "not_decided") forbidden.add("ask_date");
    if (askedDate && state.slots.date_status !== "known") forbidden.add("ask_date");
  }
  if (state.slots.date_status === "known") forbidden.add("ask_date"); // đã có ngày thì không bao giờ hỏi lại
  for (const q of state.askedQuestions) if ((q.count ?? 0) >= 2) forbidden.add(q.key);
  return [...forbidden];
}

/** Áp playbook: action nằm ngoài allowedActions của stage → hạ về fallback an toàn. */
function enforcePlaybook(d: RouterDecision): RouterDecision {
  const def = SALE_PLAYBOOK_V1[d.stage];
  if (def.allowedActions.includes(d.action)) return d;
  const fallback: SaleAction = def.allowedActions.includes("ANSWER_FAQ") ? "ANSWER_FAQ" : "WAIT";
  return {
    ...d,
    action: fallback,
    reason: `${d.reason} → action gốc bị playbook stage ${d.stage} cấm, hạ về ${fallback}`,
  };
}

export function routeSaleAction(input: RouterInput): RouterDecision {
  const state = input.threadState;
  const msg = (input.customerMessage ?? "").trim();
  const t = normalizeVi(msg);
  const intent = state.serviceIntent;
  const stage = deriveStage(state, { isFirstContact: input.isFirstContact });

  const reopenDate = REOPEN_DATE_RE.test(t) || detectAppointmentIntent(msg);
  const forbidden = computeForbiddenQuestions(state, reopenDate);

  const finish = (d: RouterDecision): RouterDecision => {
    d.forbiddenQuestions = [...new Set([...forbidden, ...d.forbiddenQuestions])];
    // RULE CỨNG CUỐI: router không bao giờ được trả ASK_DATE khi ask_date đang bị cấm.
    if (d.action === "ASK_DATE" && d.forbiddenQuestions.includes("ask_date")) {
      const alt = baseDecision(
        d.stage === "BOOKING_INTENT" ? d.stage : "QUOTE_REFERENCE",
        "QUOTE_REFERENCE",
        `${d.reason} → NHƯNG ask_date đang bị cấm (khách chưa chốt/đã hỏi rồi) → báo giá tham khảo`,
      );
      alt.forbiddenQuestions = d.forbiddenQuestions;
      alt.shouldEscalate = d.shouldEscalate;
      d = alt;
    }
    d.knowledgeNeeded = d.knowledgeNeeded.length ? d.knowledgeNeeded : (KNOWLEDGE_BY_ACTION[d.action]?.(intent) ?? []);
    // requiredData/missingData theo action
    if (d.action === "QUOTE_EXACT") d.requiredData = ["service_intent", "event_date"];
    else if (d.action === "QUOTE_REFERENCE" || d.action === "SEND_PRICE" || d.action === "SEND_SAMPLE") d.requiredData = ["service_intent"];
    d.missingData = d.requiredData.filter((k) =>
      k === "service_intent" ? !intent : k === "event_date" ? state.slots.date_status !== "known" : false,
    );
    return enforcePlaybook(d);
  };

  // ── 1. ESCALATION CỨNG (tiền/cọc/khiếu nại/gặp người/hủy dời) ──
  const esc = detectEscalation(msg);
  if (esc) {
    if (/giảm giá|so sánh|than mắc/.test(esc)) {
      const d = baseDecision(state.quotedPackages.length ? "CONSIDERING" : stage, "HANDLE_OBJECTION", `Khách chê giá/xin giảm ("${esc}") — đồng cảm + giá trị, KHÔNG tự giảm; vẫn báo người thật`);
      d.shouldEscalate = true;
      d.forbiddenQuestions.push("self_discount");
      return finish(d);
    }
    const isBooking = /chuyển khoản|đặt cọc/.test(esc);
    const d = baseDecision(isBooking ? "BOOKING_INTENT" : "HUMAN_REVIEW", "ESCALATE_HUMAN", `Escalation cứng: ${esc}`);
    d.shouldEscalate = true;
    if (isBooking) d.allowedQuestions.push("ask_date"); // muốn cọc → được phép chốt ngày
    return finish(d);
  }

  // ── 1b. Khách đòi gặp người thật (bắt cả bản gõ đủ dấu — detectEscalation prod bỏ sót) ──
  if (WANT_HUMAN_RE.test(t)) {
    const d = baseDecision("HUMAN_REVIEW", "ESCALATE_HUMAN", "Khách muốn gặp người thật — bàn giao ngay");
    d.shouldEscalate = true;
    return finish(d);
  }

  // ── 2. Khách để SĐT → bàn giao người thật chốt ──
  if (detectPhone(msg)) {
    const d = baseDecision("BOOKING_INTENT", "ESCALATE_HUMAN", "Khách để lại SĐT — cảm ơn + hẹn nhân viên liên hệ, bàn giao ngay");
    d.shouldEscalate = true;
    return finish(d);
  }

  // ── 3. Ý định giữ lịch (lý do nghiệp vụ MỚI → mở lại quyền hỏi ngày) ──
  if (reopenDate) {
    if (state.slots.date_status !== "known") {
      const d = baseDecision("BOOKING_INTENT", "ASK_DATE", "Khách muốn giữ lịch/kiểm tra lịch — lý do nghiệp vụ mới, được phép hỏi ngày");
      d.allowedQuestions.push("ask_date");
      return finish(d);
    }
    const d = baseDecision("BOOKING_INTENT", "ASK_PHONE", "Khách muốn giữ lịch, đã có ngày — xin SĐT để nhân viên chốt");
    d.allowedQuestions.push("ask_phone");
    return finish(d);
  }

  // ── 4. FAQ ──
  const faq = detectFaqTopic(t);
  if (faq) {
    // Câu hỏi cọc/thanh toán = việc tiền bạc → người thật xác nhận (chính sách prod hiện hành).
    if (faq === "faq:payment") {
      const d = baseDecision("BOOKING_INTENT", "ESCALATE_HUMAN", "Khách hỏi cọc/thanh toán — người thật xác nhận thông tin tiền bạc, bot không tự trả lời");
      d.shouldEscalate = true;
      d.allowedQuestions.push("ask_date");
      return finish(d);
    }
    const d = baseDecision(stage, "ANSWER_FAQ", `Khách hỏi ${faq}`);
    d.knowledgeNeeded = [faq];
    if (faq === "faq:address" || faq === "faq:hours") {
      d.reason += " (LƯU Ý: nguồn FAQ có cấu trúc chưa tồn tại — cần bảng FAQ trước khi bật thật)";
    }
    return finish(d);
  }

  // ── 5. Khách đòi xem mẫu / xin bảng giá ──
  if (WANT_SAMPLE_RE.test(t)) {
    if (!intent) return finish(baseDecision("DISCOVERY", "ASK_SERVICE", "Khách đòi xem mẫu nhưng chưa rõ nhóm dịch vụ — hỏi nhóm trước để gửi đúng ảnh"));
    return finish(baseDecision(stage === "QUOTE_REFERENCE" ? stage : "CONSULTING", "SEND_SAMPLE", "Khách chủ động đòi xem mẫu — gửi đúng nhóm"));
  }
  if (SEND_PRICELIST_RE.test(t)) {
    if (!intent) return finish(baseDecision("DISCOVERY", "ASK_SERVICE", "Khách xin bảng giá nhưng chưa rõ nhóm — hỏi nhóm để gửi đúng bảng"));
    return finish(baseDecision(stage, "SEND_PRICE", "Khách xin bảng giá — gửi ảnh bảng giá đúng nhóm"));
  }

  // ── 6. Câu hỏi giá ──
  if (PRICE_QUESTION_RE.test(t)) {
    if (!intent) return finish(baseDecision("DISCOVERY", "ASK_SERVICE", "Hỏi giá nhưng chưa rõ nhóm dịch vụ — price gating: hỏi nhóm trước"));
    const askedDate = state.askedQuestions.some((q) => q.key === "ask_date");
    const quotedStage: SaleStage = state.quotedPackages.length ? "QUOTED" : "QUOTE_REFERENCE";
    if (state.slots.date_status === "not_decided") {
      return finish(baseDecision(quotedStage, "QUOTE_REFERENCE", "Khách hỏi giá nhưng ĐÃ nói chưa chốt ngày — báo giá tham khảo, tuyệt đối không hỏi ngày"));
    }
    if (state.slots.date_status === "known") {
      return finish(baseDecision("QUOTED", "QUOTE_EXACT", "Đủ nhóm + ngày — báo giá chính thức"));
    }
    if (!askedDate) {
      const d = baseDecision("CONSULTING", "ASK_DATE", "Hỏi giá, chưa biết ngày & chưa từng hỏi — hỏi ngày 1 lần để tư vấn đúng (khách không trả lời sẽ không hỏi lại)");
      d.allowedQuestions.push("ask_date");
      return finish(d);
    }
    return finish(baseDecision(quotedStage, "QUOTE_REFERENCE", "Khách hỏi giá, đã hỏi ngày 1 lần mà khách bỏ qua — không lặp, báo giá tham khảo"));
  }

  // ── 7. Chào hỏi / tin cụt ──
  if (GREETING_ONLY_RE.test(t)) {
    if (input.isFirstContact) return finish(baseDecision("NEW_LEAD", "GREET", "Khách chào — chào lại + mở chuyện nhu cầu"));
    return finish(baseDecision(stage, "WAIT", "Khách chỉ chào/gọi — đáp nhẹ, không đẩy bước mới"));
  }
  if (SHORT_ACK_RE.test(t) || PRESENCE_CHECK_RE.test(t)) {
    return finish(baseDecision(stage, "WAIT", "Tin xác nhận cụt / thăm dò còn đó không — đáp nhẹ, không đẩy bước mới"));
  }

  // ── 8. Mặc định theo trạng thái ──
  if (!intent) {
    return finish(baseDecision(input.isFirstContact ? "NEW_LEAD" : "DISCOVERY", input.isFirstContact ? "GREET" : "ASK_SERVICE", "Chưa rõ nhóm dịch vụ — hỏi nhu cầu"));
  }
  // GOLDEN FLOW: khách vừa chốt "chưa biết ngày / tham khảo" (thường là câu trả lời cho
  // câu hỏi ngày sau khi hỏi giá) → giao ngay GIÁ THAM KHẢO thay vì hỏi thêm.
  if (stage === "QUOTE_REFERENCE" && state.quotedPackages.length === 0) {
    return finish(baseDecision("QUOTE_REFERENCE", "QUOTE_REFERENCE", "Khách chưa chốt ngày & chưa được báo giá — giao giá tham khảo kèm câu 'xác nhận lại khi có ngày'"));
  }
  // Đã rõ nhóm, không tín hiệu đặc biệt → đào sâu gu/loại con (không tự bung giá/ảnh).
  const d = baseDecision(stage, "IDENTIFY_SERVICE", "Đã rõ nhóm — đào sâu gu/loại để tư vấn đúng, chưa tự bung giá/ảnh");
  d.allowedQuestions.push("ask_style");
  return finish(d);
}
