import { describe, it, expect, vi } from "vitest";
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

/**
 * SALES BRAIN — 30 HỘI THOẠI MULTI-TURN (Sales Brain V1 mục 14).
 *
 * Mỗi hội thoại 2–8 lượt chạy qua ĐÚNG pipeline thật: simulate state (nuốt cả tin bot
 * synthetic theo action đã chọn) → resolveScenario(21 thẻ seed) → assert thẻ/hành động.
 * Kèm 2 LUẬT BẤT BIẾN chạy trên MỌI lượt của cả 30 hội thoại:
 *   (1) không bao giờ ASK_DATE/ASK_PHONE khi câu đó đang bị cấm;
 *   (2) action cuối luôn nằm trong allowedActions của playbook stage.
 */

import { simulateThreadStateFromHistory, type ThreadState } from "./sale-thread-state";
import { SALE_PLAYBOOK_V1, type SaleAction, type SaleStage } from "./sale-workflow";
import { resolveScenario, type ScenarioResolveResult } from "./sale-scenario-resolver";
import { cardToDef, type ScenarioDef } from "./sale-scenario-types";
import { compileCard } from "./sale-scenario-compiler";
import { SEED_SCENARIOS } from "./sale-scenario-seed";

const NOW = new Date(2026, 6, 28, 10, 0, 0);
const DEFS: ScenarioDef[] = SEED_SCENARIOS.map((s, i) => cardToDef(s.key, compileCard(s.card).card, (i + 1) * 10, true));

// Tin bot synthetic theo action — để state lượt sau thấy đúng dấu vết (botAsksDate, ảnh…).
const BOT_SAY: Partial<Record<SaleAction, string>> = {
  GREET: "Dạ em chào mình ạ, mình đang quan tâm dịch vụ nào ạ?",
  ASK_SERVICE: "Dạ mình đang cần chụp cưới, beauty hay gia đình ạ?",
  IDENTIFY_SERVICE: "Dạ mình thích tone nhẹ nhàng hay sang trọng ạ?",
  ASK_DATE: "Dạ mình dự định chụp khi nào ạ?",
  QUOTE_REFERENCE: "Dạ em gửi mình mức giá tham khảo nha.",
  QUOTE_EXACT: "Dạ giá gói của mình đây ạ.",
  SEND_PRICE: "Dạ em gửi bảng giá cho mình nha.",
  SEND_SAMPLE: "Em gửi mình 2 mẫu gần gu nhất nha.",
  ANSWER_FAQ: "Dạ em trả lời mình nè.",
  HANDLE_OBJECTION: "Dạ em hiểu mà, để em nói rõ quyền lợi cho mình nha.",
  ASK_FOR_BOOKING: "Mình muốn em giữ lịch giúp không ạ?",
  ASK_PHONE: "Mình để lại số điện thoại giúp em nha.",
  ESCALATE_HUMAN: "Dạ em báo nhân viên hỗ trợ mình ngay nha.",
  WAIT: "Dạ vâng ạ, mình cứ thoải mái nha.",
};

type Turn = {
  msg: string;
  winner?: string | null;           // key thẻ kỳ vọng (null = theo hệ thống; bỏ qua nếu undefined)
  winnerIn?: string[];              // 1 trong các thẻ (khi nhiều thẻ hợp lệ ngang nhau)
  action?: SaleAction;
  actionNot?: SaleAction[];
  stage?: SaleStage;
  escalate?: boolean;
};
type Convo = { id: string; name: string; turns: Turn[]; startStatus?: string };

function runConvo(c: Convo): Array<{ turn: Turn; r: ScenarioResolveResult; state: ThreadState }> {
  const out: Array<{ turn: Turn; r: ScenarioResolveResult; state: ThreadState }> = [];
  let history: Array<{ direction: "incoming" | "outgoing"; message: string }> = [];
  const quoted: string[] = [];
  let quoteN = 0;
  for (const turn of c.turns) {
    const state = simulateThreadStateFromHistory(
      [...history, { direction: "incoming", message: turn.msg }],
      { quotedCodes: quoted, now: NOW },
    );
    if (c.startStatus) state.customerStatus = c.startStatus;
    const r = resolveScenario({
      customerMessage: turn.msg, threadState: state,
      isFirstContact: history.length === 0, scenarios: DEFS,
    });
    out.push({ turn, r, state });
    // Bot "trả lời" → vào history + tích luỹ mã gói đã báo.
    const say = BOT_SAY[r.decision.action] ?? "Dạ vâng ạ.";
    if (["QUOTE_REFERENCE", "QUOTE_EXACT", "SEND_PRICE"].includes(r.decision.action)) {
      quoteN += 1; quoted.push(`GOI-${quoteN}`);
    }
    history = [
      ...history,
      { direction: "incoming", message: turn.msg },
      ...(r.decision.action === "SEND_SAMPLE" ? [{ direction: "outgoing" as const, message: "[image:https://x/mau.jpg]" }] : []),
      { direction: "outgoing", message: say },
    ];
  }
  return out;
}

const CONVOS: Convo[] = [
  { id: "C01", name: "Giá chưa ngày → concept → gồm gì (không lượt nào hỏi lại ngày)", turns: [
    { msg: "Chào em, chị muốn chụp album cưới", winner: null, action: "GREET" },
    { msg: "Chị chưa chốt ngày đâu, giá bao nhiêu em?", winner: "hoi-gia-chua-ngay", action: "QUOTE_REFERENCE", actionNot: ["ASK_DATE"] },
    { msg: "Có concept nào đẹp không cho chị xem", action: "SEND_SAMPLE", actionNot: ["ASK_DATE"] },
    { msg: "Gói đó gồm những gì?", winner: "hoi-chi-tiet-goi", action: "ANSWER_FAQ", actionNot: ["ASK_DATE"] },
  ]},
  { id: "C02", name: "Giá có ngày → báo giá chính thức", turns: [
    // Tin đầu hỏi giá: engine hỏi ngày ĐÚNG 1 LẦN (luật: chưa từng hỏi thì được hỏi).
    { msg: "chụp cổng giá sao em", winner: null, action: "ASK_DATE" },
    { msg: "20/12 nha em", actionNot: ["ASK_DATE"] },
    { msg: "vậy giá bao nhiêu?", winner: "hoi-gia-co-ngay", action: "QUOTE_EXACT" },
  ]},
  { id: "C03", name: "Hỏi package trước rồi hỏi giá", turns: [
    { msg: "gói chụp gia đình gồm những gì em", winner: "hoi-chi-tiet-goi", action: "ANSWER_FAQ" },
    { msg: "giá sao em", actionNot: ["GREET"] },
  ]},
  { id: "C04", name: "Xem hình → chọn gu → hỏi giá", turns: [
    { msg: "cho xem mẫu beauty với", winner: "xem-anh-mau", action: "SEND_SAMPLE" },
    { msg: "chị thích kiểu Hàn Quốc nhẹ nhàng", actionNot: ["ASK_SERVICE", "GREET"] },
    { msg: "tầm giá sao em", actionNot: ["GREET", "ASK_SERVICE"] },
  ]},
  { id: "C05", name: "Đổi dịch vụ giữa chừng (cưới → gia đình)", turns: [
    { msg: "chị muốn chụp album cưới", winner: null, action: "GREET" },
    { msg: "à mà thôi, nhà chị muốn chụp gia đình 5 người", actionNot: ["ASK_SERVICE", "GREET"] },
  ]},
  { id: "C06", name: "Đổi package sau báo giá", turns: [
    { msg: "chụp cưới giá bao nhiêu em?", winner: null, action: "ASK_DATE" },
    { msg: "chưa biết ngày, cứ báo giá đi", winner: "hoi-gia-chua-ngay", action: "QUOTE_REFERENCE" },
    { msg: "gói kia thì sao em", actionNot: ["GREET", "ASK_SERVICE", "ASK_DATE"] },
  ]},
  { id: "C07", name: "Chê mắc sau báo giá → xử lý + báo người thật, không giảm", turns: [
    { msg: "chụp cổng giá sao", winner: null, action: "ASK_DATE" },
    { msg: "20/12", actionNot: ["ASK_DATE"] },
    { msg: "giá bao nhiêu em", action: "QUOTE_EXACT" },
    { msg: "mắc quá vậy", action: "HANDLE_OBJECTION", escalate: true, winnerIn: ["xin-giam-gia", "che-gia-cao"] },
  ]},
  { id: "C08", name: "'Bớt được không' khi CHƯA báo giá → thẻ xin-giam-them", turns: [
    { msg: "chụp bầu bên em giá nhiêu", winner: null, action: "ASK_DATE" },
    { msg: "bớt được không em", winnerIn: ["xin-giam-them", "xin-giam-gia", "che-gia-cao"], action: "HANDLE_OBJECTION" },
  ]},
  { id: "C09", name: "'Để chị hỏi chồng' sau báo giá → thẻ hỏi-chồng, không ép", turns: [
    { msg: "chụp cưới chưa chốt ngày, giá tham khảo đi em", winner: "hoi-gia-chua-ngay", action: "QUOTE_REFERENCE" },
    { msg: "để chị hỏi chồng đã nha", winner: "hoi-chong-gia-dinh", action: "WAIT", actionNot: ["ASK_FOR_BOOKING", "ASK_PHONE"] },
  ]},
  { id: "C10", name: "Ack cụt sau báo giá → phân vân, chờ", turns: [
    { msg: "chụp cưới chưa chốt ngày, báo giá em", action: "QUOTE_REFERENCE" },
    { msg: "ok ạ", winner: "phan-van", action: "WAIT" },
  ]},
  { id: "C11", name: "Từ chối rồi QUAY LẠI — không chào như người lạ", turns: [
    { msg: "chụp cưới giá sao em", winner: null, action: "ASK_DATE" },
    { msg: "thôi khỏi em ơi, chị chốt bên khác rồi", action: "WAIT", stage: "LOST" },
    { msg: "à mà cho chị xem mẫu beauty đi", action: "SEND_SAMPLE", actionNot: ["GREET"] },
  ]},
  { id: "C12", name: "Hỏi cọc → người thật (bot không đụng tiền)", turns: [
    { msg: "chụp cổng nha em", winner: null, action: "GREET" },
    { msg: "cọc sao em?", winner: "gap-nguoi-that", action: "ESCALATE_HUMAN", escalate: true },
  ]},
  { id: "C13", name: "Giữ lịch có ngày → xin SĐT bàn giao", turns: [
    { msg: "giữ lịch 20/12 chụp cưới giúp chị nha", winner: "giu-lich-coc", stage: "BOOKING_INTENT", actionNot: ["ASK_DATE"] },
  ]},
  { id: "C14", name: "Đòi gặp người thật giữa tư vấn", turns: [
    { msg: "chụp gia đình tư vấn giúp chị", winner: null, action: "GREET" },
    { msg: "cho chị gặp người thật đi", winner: "gap-nguoi-that", action: "ESCALATE_HUMAN", escalate: true },
  ]},
  { id: "C15", name: "Short replies liên tiếp — không đẩy bước", turns: [
    { msg: "chụp beauty chưa chốt ngày, giá tham khảo?", action: "QUOTE_REFERENCE" },
    { msg: "ừ", action: "WAIT" },
    { msg: "vậy hả", action: "WAIT", actionNot: ["ASK_FOR_BOOKING", "ASK_PHONE"] },
  ]},
  { id: "C16", name: "Multi-intent: giá + hỏi có váy thuê", turns: [
    { msg: "giá chụp cưới sao, mà bên em có váy thuê không?", action: "ANSWER_FAQ" },
  ]},
  { id: "C17", name: "Tin lạ không kịch bản → fallback hệ thống an toàn", turns: [
    { msg: "trời hôm nay đẹp ghê em ha", winner: null, action: "GREET" },
    { msg: "haha vui thiệt", actionNot: ["QUOTE_EXACT", "SEND_PRICE", "ASK_PHONE"] },
  ]},
  { id: "C18", name: "Chốt gói → thẻ chốt (guidance có gợi upsell)", turns: [
    { msg: "chụp cưới nha, chị ưng lắm", winner: null, action: "GREET" },
    { msg: "ok chốt gói này luôn em", winner: "chon-duoc-goi" },
  ]},
  { id: "C19", name: "Khách ĐÃ BOOKED hỏi giao ảnh → CSKH, không sale lại", startStatus: "customer", turns: [
    { msg: "em ơi bao lâu thì có ảnh vậy", action: "ANSWER_FAQ", stage: "BOOKED", actionNot: ["GREET", "QUOTE_REFERENCE", "ASK_PHONE"] },
  ]},
  { id: "C20", name: "Từ chối cuối chuỗi → LOST, đáp tử tế", turns: [
    { msg: "chụp bầu giá sao", winner: null, action: "ASK_DATE" },
    { msg: "đừng nhắn nữa nha em", action: "WAIT", stage: "LOST", actionNot: ["HANDLE_OBJECTION", "QUOTE_REFERENCE"] },
  ]},
  { id: "C21", name: "'Để tham khảo thêm' → hào phóng, không xin gì", turns: [
    { msg: "chụp cưới bên em sao", winner: null, action: "GREET" },
    { msg: "chị đang tham khảo thêm vài chỗ á", winner: "tham-khao-them", action: "WAIT", actionNot: ["ASK_PHONE", "ASK_FOR_BOOKING"] },
  ]},
  { id: "C22", name: "'Đang bận tí nói' → rút lịch sự", turns: [
    { msg: "chụp gia đình tư vấn chị", winner: null, action: "GREET" },
    { msg: "chị đang bận, tí chị nhắn lại nha", winner: "dang-ban", action: "WAIT" },
  ]},
  { id: "C23", name: "'Ảnh thật hay ảnh mẫu đó' → bằng chứng, không hứa suông", turns: [
    { msg: "cho xem mẫu chụp cổng", winner: "xem-anh-mau", action: "SEND_SAMPLE" },
    { msg: "ảnh thật hay ảnh trên mạng thôi vậy", winner: "chua-tin-anh-that", action: "ANSWER_FAQ" },
  ]},
  { id: "C24", name: "'Chưa biết chụp kiểu gì' → gợi hướng gu, không hỏi trần", turns: [
    { msg: "chị muốn chụp beauty", winner: null, action: "GREET" },
    { msg: "mà chị chưa biết chụp kiểu gì luôn", winner: "chua-biet-gu", action: "SEND_SAMPLE" },
  ]},
  { id: "C25", name: "'Tầm bao nhiêu thì đủ' → 3 mức + recommend", turns: [
    { msg: "nhà chị 4 người muốn chụp gia đình", winner: null, action: "GREET" },
    { msg: "tầm bao nhiêu thì đủ em", winner: "lo-ngan-sach", action: "QUOTE_REFERENCE" },
  ]},
  { id: "C26", name: "Hỏi địa chỉ giờ làm", turns: [
    { msg: "studio bên em ở đâu vậy", winner: "dia-chi-gio-lam", action: "ANSWER_FAQ" },
  ]},
  { id: "C27", name: "Chuỗi 3 lượt chưa-biết-ngày — RULE: 0 lần hỏi lại ngày", turns: [
    { msg: "chị chưa biết ngày, cho chị tham khảo giá chụp cưới trước", winner: "hoi-gia-chua-ngay", action: "QUOTE_REFERENCE", actionNot: ["ASK_DATE"] },
    { msg: "concept có gì đẹp", actionNot: ["ASK_DATE"] },
    { msg: "gói đó gồm gì em", actionNot: ["ASK_DATE"] },
  ]},
  { id: "C28", name: "Slang không dấu: 'z gia sao e' + 'chua chot ngay dau'", turns: [
    { msg: "z gia sao e, chup cuoi a", winner: null, action: "ASK_DATE" },
    // Tin chỉ nói "chưa chốt ngày" (không nhắc giá) → theo hệ thống: giao giá tham khảo (golden flow).
    { msg: "chua chot ngay dau", action: "QUOTE_REFERENCE", actionNot: ["ASK_DATE"] },
  ]},
  { id: "C29", name: "'Bên kia rẻ hơn' → xử lý so sánh, cấm nói xấu", turns: [
    { msg: "chụp cưới chưa chốt ngày, giá tham khảo em", action: "QUOTE_REFERENCE" },
    { msg: "bên kia rẻ hơn em ơi", winnerIn: ["so-sanh-ben-khac", "che-gia-cao", "xin-giam-gia"], action: "HANDLE_OBJECTION" },
  ]},
  { id: "C30", name: "Hành trình dài: chào → gu → giá → phân vân → chốt → giữ lịch", turns: [
    { msg: "alo em ơi", winner: "chao-hoi-moi", action: "GREET" },
    { msg: "chị muốn chụp album cưới, kiểu Hàn Quốc", actionNot: ["ASK_SERVICE", "GREET"] },
    { msg: "chưa chốt ngày, giá tham khảo đi", winner: "hoi-gia-chua-ngay", action: "QUOTE_REFERENCE" },
    { msg: "để chị suy nghĩ thêm xíu", winner: "xin-suy-nghi-them", action: "WAIT" },
    { msg: "thôi được, chốt gói này luôn, giữ lịch 20/12 cho chị", stage: "BOOKING_INTENT", actionNot: ["ASK_DATE"] },
  ]},
];

describe("30 hội thoại multi-turn — Sales Brain end-to-end (brain-level)", () => {
  for (const c of CONVOS) {
    it(`${c.id} — ${c.name}`, () => {
      const results = runConvo(c);
      for (let i = 0; i < results.length; i++) {
        const { turn, r } = results[i];
        const at = `${c.id} lượt ${i + 1} ("${turn.msg.slice(0, 40)}")`;
        if (turn.winner !== undefined) {
          expect(r.winner?.key ?? null, `${at}: thẻ`).toBe(turn.winner);
        }
        if (turn.winnerIn) {
          expect(turn.winnerIn, `${at}: thẻ phải thuộc nhóm`).toContain(r.winner?.key ?? "(none)");
        }
        if (turn.action) expect(r.decision.action, `${at}: action`).toBe(turn.action);
        for (const not of turn.actionNot ?? []) {
          expect(r.decision.action, `${at}: cấm action`).not.toBe(not);
        }
        if (turn.stage) expect(r.decision.stage, `${at}: stage`).toBe(turn.stage);
        if (turn.escalate !== undefined) expect(r.decision.shouldEscalate, `${at}: escalate`).toBe(turn.escalate);
      }
    });
  }

  it("LUẬT BẤT BIẾN trên mọi lượt của cả 30 hội thoại", () => {
    let turns = 0;
    for (const c of CONVOS) {
      for (const { r } of runConvo(c)) {
        turns++;
        // 1. Không bao giờ hỏi câu đang bị cấm.
        if (r.decision.action === "ASK_DATE") expect(r.decision.forbiddenQuestions).not.toContain("ask_date");
        if (r.decision.action === "ASK_PHONE") expect(r.decision.forbiddenQuestions).not.toContain("ask_phone");
        // 2. Action hợp lệ theo playbook stage.
        expect(SALE_PLAYBOOK_V1[r.decision.stage].allowedActions).toContain(r.decision.action);
        // 3. Cấm của baseline không bao giờ bị bớt.
        for (const q of r.baseline.forbiddenQuestions) {
          expect(r.decision.forbiddenQuestions).toContain(q);
        }
      }
    }
    console.log(`\n══ SALES BRAIN CONVERSATIONS: ${CONVOS.length} hội thoại, ${turns} lượt — luật bất biến sạch ══`);
    expect(turns).toBeGreaterThanOrEqual(60);
  });
});
