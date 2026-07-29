import type { SaleAction, SaleStage } from "./sale-workflow";
import type { DateStatus } from "./sale-slots";

/**
 * GOLDEN TEST SET V1 — hội thoại sale giả lập thực tế của Amazing Studio.
 *
 * Mỗi case chấm bằng EXPECTED CÓ CẤU TRÚC (slot / stage / action / forbidden /
 * state change) — KHÔNG chấm bằng "câu trả lời nghe hay". Chạy trong
 * sale-workflow-golden.test.ts qua pipeline: simulateThreadStateFromHistory →
 * routeSaleAction. Dữ liệu tách riêng để dùng lại cho report chất lượng.
 */

export type GoldenTurn = { direction: "incoming" | "outgoing"; message: string };

export type GoldenCase = {
  id: string;
  name: string;
  /** Lịch sử TRƯỚC tin hiện tại (rỗng = khách mới). */
  history: GoldenTurn[];
  /** Tin khách của lượt đang chấm. */
  message: string;
  /** Mã gói đã báo giá ở các lượt trước (mô phỏng quoted_packages). */
  quotedCodes?: string[];
  expected: {
    /** Subset slot sau khi xử lý tin này. dateStatus "unset" = chưa được ghi. */
    dateStatus?: DateStatus | "unset";
    eventDate?: string | null;
    serviceIntent?: string | null;
    stage?: SaleStage;
    action?: SaleAction;
    /** Action TUYỆT ĐỐI không được chọn ở lượt này. */
    forbiddenAction?: SaleAction;
    /** forbiddenQuestions phải CHỨA các key này. */
    forbiddenQuestionsInclude?: string[];
    shouldEscalate?: boolean;
    /** Mô tả thay đổi state kỳ vọng (đọc cho người; máy chấm bằng các field trên). */
    stateChange?: string;
  };
};

const ASKED_DATE: GoldenTurn = { direction: "outgoing", message: "Dạ mình dự định chụp khi nào ạ?" };

export const GOLDEN_CASES: GoldenCase[] = [
  // ── GOLDEN FLOW "CHƯA BIẾT NGÀY" (kịch bản chỉ đạo) ──────────────────────────
  {
    id: "G01", name: "Khách xin giá chụp cưới (chưa ngày, chưa hỏi) → hỏi ngày đúng 1 lần",
    history: [], message: "Cho chị xin giá chụp cưới",
    expected: { serviceIntent: "wedding_album", dateStatus: "unset", stage: "CONSULTING", action: "ASK_DATE", stateChange: "intent=wedding_album; router mở ask_date lần đầu" },
  },
  {
    id: "G02", name: "Khách trả lời 'chưa biết ngày, tham khảo trước' → BẮT BUỘC báo giá tham khảo",
    history: [{ direction: "incoming", message: "Cho chị xin giá chụp cưới" }, ASKED_DATE],
    message: "Chị chưa biết ngày, chị tham khảo trước thôi",
    expected: { dateStatus: "not_decided", stage: "QUOTE_REFERENCE", action: "QUOTE_REFERENCE", forbiddenAction: "ASK_DATE", forbiddenQuestionsInclude: ["ask_date"], stateChange: "date_status→not_decided; cấm ask_date" },
  },
  {
    id: "G03", name: "Sau not_decided, khách hỏi 'Có váy không?' → FAQ, vẫn cấm hỏi ngày",
    history: [{ direction: "incoming", message: "Cho chị xin giá chụp cưới" }, ASKED_DATE, { direction: "incoming", message: "Chị chưa biết ngày, chị tham khảo trước thôi" }],
    message: "Có váy không em?",
    expected: { action: "ANSWER_FAQ", forbiddenAction: "ASK_DATE", forbiddenQuestionsInclude: ["ask_date"] },
  },
  {
    id: "G04", name: "Sau not_decided, khách 'Cho chị xem ảnh' → gửi mẫu, vẫn cấm hỏi ngày",
    history: [{ direction: "incoming", message: "Cho chị xin giá chụp cưới" }, ASKED_DATE, { direction: "incoming", message: "Chị chưa biết ngày, tham khảo thôi" }],
    message: "Cho chị xem ảnh mẫu với",
    expected: { action: "SEND_SAMPLE", forbiddenAction: "ASK_DATE", forbiddenQuestionsInclude: ["ask_date"] },
  },
  {
    id: "G05", name: "Sau not_decided, khách 'Gói này gồm gì?' → FAQ chi tiết gói, cấm hỏi ngày",
    history: [{ direction: "incoming", message: "Cho chị xin giá chụp cưới" }, ASKED_DATE, { direction: "incoming", message: "chưa biết ngày em ơi" }],
    message: "Gói này gồm những gì vậy?",
    expected: { action: "ANSWER_FAQ", forbiddenAction: "ASK_DATE" },
  },
  {
    id: "G06", name: "Sau not_decided, khách 'Có makeup không?' → FAQ, cấm hỏi ngày",
    history: [{ direction: "incoming", message: "Cho chị xin giá chụp cưới" }, ASKED_DATE, { direction: "incoming", message: "chưa chốt ngày đâu" }],
    message: "Có makeup không?",
    expected: { action: "ANSWER_FAQ", forbiddenAction: "ASK_DATE" },
  },
  {
    id: "G07", name: "not_decided nhưng khách MUỐN GIỮ LỊCH → lý do nghiệp vụ mới, MỞ LẠI hỏi ngày",
    history: [{ direction: "incoming", message: "Cho chị xin giá chụp cưới" }, ASKED_DATE, { direction: "incoming", message: "chưa biết ngày, tham khảo thôi" }, { direction: "outgoing", message: "Dạ em gửi giá tham khảo nha" }],
    message: "Ok em, chị muốn giữ lịch luôn",
    expected: { stage: "BOOKING_INTENT", action: "ASK_DATE", stateChange: "reopen ask_date vì khách muốn giữ lịch" },
  },

  // ── ĐÃ BIẾT NGÀY ─────────────────────────────────────────────────────────────
  {
    id: "G08", name: "Khách cho ngày cụ thể rồi hỏi giá → báo giá chính thức",
    history: [{ direction: "incoming", message: "chụp cưới nha em" }, ASKED_DATE, { direction: "incoming", message: "20/12 nha" }],
    message: "vậy giá sao em?",
    expected: { dateStatus: "known", eventDate: "2026-12-20", stage: "QUOTED", action: "QUOTE_EXACT", forbiddenQuestionsInclude: ["ask_date"], stateChange: "đã có ngày → không bao giờ hỏi lại" },
  },
  {
    id: "G09", name: "Ngày tương đối 'cuối tháng 12' → known (mốc chữ), hỏi giá → QUOTE_EXACT",
    history: [{ direction: "incoming", message: "chụp cưới" }, ASKED_DATE, { direction: "incoming", message: "chắc cuối tháng 12" }],
    message: "giá nhiêu em",
    expected: { dateStatus: "known", eventDate: null, action: "QUOTE_EXACT" },
  },

  // ── HỎI GIÁ / ẢNH KHI CHƯA RÕ DỊCH VỤ ───────────────────────────────────────
  {
    id: "G10", name: "Hỏi giá ngay tin đầu, chưa rõ dịch vụ → hỏi nhóm (price gating)",
    history: [], message: "giá bao nhiêu vậy?",
    expected: { serviceIntent: null, stage: "DISCOVERY", action: "ASK_SERVICE", forbiddenAction: "QUOTE_EXACT" },
  },
  {
    id: "G11", name: "Đòi xem ảnh trước khi rõ dịch vụ → hỏi nhóm trước",
    history: [], message: "cho xem ảnh đi em",
    expected: { action: "ASK_SERVICE", forbiddenAction: "SEND_SAMPLE" },
  },
  {
    id: "G12", name: "Khách chào tin đầu → GREET",
    history: [], message: "chào em",
    expected: { stage: "NEW_LEAD", action: "GREET" },
  },

  // ── DỊCH VỤ CỤ THỂ ──────────────────────────────────────────────────────────
  {
    id: "G13", name: "Hỏi thuê váy → intent rental, trả lời FAQ dịch vụ",
    history: [], message: "bên em có cho thuê váy cưới không?",
    expected: { serviceIntent: "rental_outfit", action: "ANSWER_FAQ" },
  },
  {
    id: "G14", name: "Hỏi makeup lẻ → FAQ dịch vụ",
    history: [{ direction: "incoming", message: "chụp beauty nha" }],
    message: "bên em có makeup không?",
    expected: { serviceIntent: "beauty", action: "ANSWER_FAQ" },
  },
  {
    id: "G15", name: "Hỏi địa chỉ studio → FAQ address (nguồn FAQ còn thiếu — phải lộ rõ trong reason)",
    history: [{ direction: "incoming", message: "chụp gia đình" }],
    message: "studio mình ở đâu vậy?",
    expected: { action: "ANSWER_FAQ" },
  },
  {
    id: "G16", name: "Khách đổi dịch vụ giữa chừng → intent theo tin MỚI nhất",
    history: [{ direction: "incoming", message: "em tư vấn chụp cưới nha" }, { direction: "outgoing", message: "Dạ mình thích tone nào ạ?" }],
    message: "à thôi, chị hỏi chụp gia đình đi",
    expected: { serviceIntent: "family", action: "IDENTIFY_SERVICE", forbiddenAction: "ASK_SERVICE", stateChange: "intent wedding_album→family (khách chủ động đổi — hợp lệ)" },
  },

  // ── TIN CỤT / DỒN DẬP / BỎ QUA CÂU HỎI ──────────────────────────────────────
  {
    id: "G17", name: "Khách trả lời cụt 'dạ' → WAIT, không đẩy bước",
    history: [{ direction: "incoming", message: "chụp cưới" }, { direction: "outgoing", message: "Dạ bên em có cổng, album, ngoại cảnh ạ" }],
    message: "dạ",
    expected: { action: "WAIT" },
  },
  {
    id: "G18", name: "Khách gửi 3 tin liên tiếp → state gộp đủ, tin cuối hỏi giá → hỏi ngày 1 lần",
    history: [{ direction: "incoming", message: "chụp cưới" }, { direction: "incoming", message: "à mà cho hỏi" }],
    message: "giá sao em",
    expected: { serviceIntent: "wedding_album", action: "ASK_DATE", stateChange: "intent giữ từ tin 1 dù tin 2 vô nghĩa" },
  },
  {
    id: "G19", name: "Bot hỏi ngày, khách BỎ QUA hỏi mẫu → gửi mẫu, KHÔNG lặp câu hỏi ngày",
    history: [{ direction: "incoming", message: "chụp cổng nha em" }, ASKED_DATE],
    message: "cho xem mẫu cổng đẹp đẹp đi",
    expected: { serviceIntent: "wedding_gate", action: "SEND_SAMPLE", forbiddenAction: "ASK_DATE", forbiddenQuestionsInclude: ["ask_date"] },
  },
  {
    id: "G20", name: "Khách hỏi LẠI giá sau khi đã nhận bảng giá → nhắc giá, không hỏi ngày lại",
    history: [{ direction: "incoming", message: "chụp cổng giá sao" }, ASKED_DATE, { direction: "incoming", message: "chưa biết ngày" }, { direction: "outgoing", message: "Dạ em gửi giá tham khảo nha" }],
    message: "nãy nhiêu tiền ấy nhỉ?",
    quotedCodes: ["CG-BASIC"],
    expected: { stage: "QUOTED", action: "QUOTE_REFERENCE", forbiddenAction: "ASK_DATE" },
  },

  // ── TIỀN / CỌC / SĐT / NGƯỜI THẬT ───────────────────────────────────────────
  {
    id: "G21", name: "Khách xin giảm giá → xử lý băn khoăn + báo người thật, KHÔNG tự giảm",
    history: [{ direction: "incoming", message: "chụp cưới giá sao" }, ASKED_DATE, { direction: "incoming", message: "20/12" }, { direction: "outgoing", message: "Dạ gói bên em 3.900.000đ ạ" }],
    message: "bớt chút đi em, chỗ khác rẻ hơn",
    quotedCodes: ["ST-BASIC"],
    expected: { action: "HANDLE_OBJECTION", shouldEscalate: true, forbiddenQuestionsInclude: ["self_discount"] },
  },
  {
    id: "G22", name: "Khách muốn đặt cọc → BOOKING_INTENT + người thật, được phép chốt ngày",
    history: [{ direction: "incoming", message: "chụp cưới nha" }],
    message: "chị muốn đặt cọc giữ lịch luôn",
    expected: { stage: "BOOKING_INTENT", action: "ESCALATE_HUMAN", shouldEscalate: true },
  },
  {
    id: "G23", name: "Khách hỏi 'cọc bao nhiêu' → chuyện tiền → người thật xác nhận",
    history: [{ direction: "incoming", message: "chụp cưới nha" }],
    message: "cọc bao nhiêu vậy em?",
    expected: { action: "ESCALATE_HUMAN", shouldEscalate: true },
  },
  {
    id: "G24", name: "Khách để SĐT → bàn giao người thật ngay",
    history: [{ direction: "incoming", message: "chụp gia đình" }],
    message: "0909 123 456 gọi chị nha",
    expected: { stage: "BOOKING_INTENT", action: "ESCALATE_HUMAN", shouldEscalate: true },
  },
  {
    id: "G25", name: "Khách đòi gặp người thật → HUMAN_REVIEW",
    history: [{ direction: "incoming", message: "chụp cưới" }],
    message: "cho chị nói chuyện với người thật đi",
    expected: { stage: "HUMAN_REVIEW", action: "ESCALATE_HUMAN", shouldEscalate: true },
  },

  // ── SỐ KHÔNG PHẢI NGÀY ──────────────────────────────────────────────────────
  {
    id: "G26", name: "'nhà chị 2-3 người' sau khi bot hỏi ngày → KHÔNG thành ngày, không hỏi lại",
    history: [{ direction: "incoming", message: "chụp gia đình nha" }, ASKED_DATE],
    message: "nhà chị 2-3 người chụp chung được không?",
    expected: { dateStatus: "unset", forbiddenAction: "ASK_DATE", forbiddenQuestionsInclude: ["ask_date"], stateChange: "2-3 người KHÔNG ghi thành event_date" },
  },
  {
    id: "G27", name: "Tuổi bé '3 tháng 10 ngày' → KHÔNG thành ngày chụp",
    history: [],
    message: "bé nhà em được 3 tháng 10 ngày, chụp được không?",
    expected: { dateStatus: "unset", stateChange: "tuổi bé không thành event_date" },
  },
  {
    id: "G28", name: "'tầm 2-3 triệu thì chụp 20/12 được không' → ngày THẬT vẫn bắt được",
    history: [{ direction: "incoming", message: "chụp cưới" }, ASKED_DATE],
    message: "tầm 2-3 triệu thì mình chụp 20/12 được không em?",
    expected: { dateStatus: "known", eventDate: "2026-12-20" },
  },

  // ── CÁC CA CÒN LẠI ──────────────────────────────────────────────────────────
  {
    id: "G29", name: "Khách 'ngày nào cũng được' + hỏi giá → tham khảo, cấm hỏi ngày",
    history: [{ direction: "incoming", message: "chụp beauty nha em" }, ASKED_DATE],
    message: "ngày nào cũng được á, giá sao em?",
    expected: { dateStatus: "not_decided", action: "QUOTE_REFERENCE", forbiddenAction: "ASK_DATE" },
  },
  {
    id: "G30", name: "Khách xin gửi bảng giá (đã rõ nhóm) → SEND_PRICE",
    history: [{ direction: "incoming", message: "chụp cổng nha" }],
    message: "gửi chị bảng giá đi em",
    expected: { serviceIntent: "wedding_gate", action: "SEND_PRICE" },
  },
  {
    id: "G31", name: "Sau QUOTE_REFERENCE khách chốt 'ok chốt lịch giúp chị' → mở lại ngày",
    history: [{ direction: "incoming", message: "chụp cưới giá sao" }, ASKED_DATE, { direction: "incoming", message: "tham khảo thôi em" }, { direction: "outgoing", message: "Dạ em gửi giá tham khảo nha" }],
    message: "ok đó em, chốt lịch giúp chị đi",
    expected: { stage: "BOOKING_INTENT", action: "ASK_DATE", stateChange: "reopen vì khách muốn chốt lịch" },
  },
  {
    id: "G32", name: "Khách quay lại sau nhiều ngày thăm dò 'còn đó không' → WAIT, state giữ nguyên",
    history: [{ direction: "incoming", message: "chụp cưới nha" }, ASKED_DATE, { direction: "incoming", message: "chưa biết ngày" }, { direction: "outgoing", message: "Dạ em gửi giá tham khảo nha" }],
    message: "em ơi còn đó không?",
    expected: { dateStatus: "not_decided", action: "WAIT", forbiddenAction: "ASK_DATE", stateChange: "quay lại sau nhiều ngày — trí nhớ giữ nguyên not_decided" },
  },
  {
    id: "G33", name: "Booking intent khi ĐÃ có ngày → xin SĐT (không hỏi lại ngày)",
    history: [{ direction: "incoming", message: "chụp cưới" }, ASKED_DATE, { direction: "incoming", message: "20/12 nha em" }],
    message: "vậy giữ lịch cho chị nha",
    expected: { stage: "BOOKING_INTENT", action: "ASK_PHONE", forbiddenAction: "ASK_DATE" },
  },

  // ── KHÓA HÀNH VI TỪ VÒNG REVIEW ĐỐI KHÁNG #137 (14 lỗi đã xác nhận) ──────────
  {
    id: "G34", name: "Khách CHỐT MUA 'chốt gói này nha' sau báo giá → booking, KHÔNG phải FAQ",
    history: [{ direction: "incoming", message: "chụp cưới giá sao em" }, ASKED_DATE, { direction: "incoming", message: "chưa biết ngày, tham khảo thôi" }, { direction: "outgoing", message: "Dạ em gửi giá tham khảo nha" }],
    message: "Ok chốt gói này nha em",
    quotedCodes: ["ST-BASIC"],
    expected: { stage: "BOOKING_INTENT", action: "ASK_DATE", forbiddenAction: "ANSWER_FAQ", stateChange: "chốt mua = lý do nghiệp vụ mới → mở lại hỏi ngày" },
  },
  {
    id: "G35", name: "'em lấy gói basic nha' → booking",
    history: [{ direction: "incoming", message: "chụp cổng giá sao" }, ASKED_DATE, { direction: "incoming", message: "chưa chốt ngày" }, { direction: "outgoing", message: "Dạ em gửi giá tham khảo nha" }],
    message: "em lấy gói basic nha",
    quotedCodes: ["CG-BASIC"],
    expected: { stage: "BOOKING_INTENT", action: "ASK_DATE", forbiddenAction: "ANSWER_FAQ" },
  },
  {
    id: "G36", name: "Chốt lịch khi ĐÃ hỏi ngày 2 lần → xin SĐT + bàn giao (không FAQ, không hỏi ngày lần 3)",
    history: [
      { direction: "incoming", message: "chụp cưới nha" }, ASKED_DATE,
      { direction: "incoming", message: "để chị coi đã" }, ASKED_DATE,
    ],
    message: "ok chốt lịch giúp chị đi",
    expected: { stage: "BOOKING_INTENT", action: "ASK_PHONE", forbiddenAction: "ANSWER_FAQ", shouldEscalate: true },
  },
  {
    id: "G37", name: "Tin đầu 'Chào em, chị muốn chụp gia đình' → GREET có intent (không bị hạ về FAQ)",
    history: [], message: "Chào em, chị muốn chụp gia đình",
    expected: { serviceIntent: "family", stage: "NEW_LEAD", action: "GREET", forbiddenAction: "ANSWER_FAQ" },
  },
  {
    id: "G38", name: "'bao nhiêu NGƯỜI' là câu số lượng, không phải giá — không bung giá, không hỏi ngày",
    history: [{ direction: "incoming", message: "chụp gia đình nha em" }, ASKED_DATE, { direction: "incoming", message: "chưa biết ngày" }],
    message: "gói này chụp được bao nhiêu người vậy em?",
    expected: { dateStatus: "not_decided", forbiddenAction: "ASK_DATE", forbiddenQuestionsInclude: ["ask_date"] },
  },
  {
    id: "G39", name: "'chụp CHO GIA đình được không' không phải hỏi giá — không đốt lượt hỏi ngày",
    history: [], message: "chụp cho gia đình được không em?",
    expected: { serviceIntent: "family", action: "GREET", forbiddenAction: "ASK_DATE" },
  },
  {
    id: "G40", name: "'để chị xem thử rồi báo lại' sau báo giá = trì hoãn → WAIT, không bung ảnh",
    history: [{ direction: "incoming", message: "chụp cưới giá sao" }, ASKED_DATE, { direction: "incoming", message: "20/12" }, { direction: "outgoing", message: "Dạ gói bên em 3.900.000đ ạ" }],
    message: "để chị xem thử rồi báo lại em nha",
    quotedCodes: ["ST-BASIC"],
    expected: { stage: "QUOTED", action: "WAIT", forbiddenAction: "SEND_SAMPLE" },
  },
  {
    id: "G41", name: "'chụp xong khi nào cho hình' = hỏi thời gian trả ảnh → FAQ, không gửi mẫu",
    history: [{ direction: "incoming", message: "chụp gia đình nha" }],
    message: "chụp xong khi nào cho hình vậy em?",
    expected: { action: "ANSWER_FAQ", forbiddenAction: "SEND_SAMPLE" },
  },
  {
    id: "G42", name: "Khách cũ 'ok ạ' (ack 2 từ) → WAIT",
    history: [{ direction: "incoming", message: "chụp cưới nha" }, { direction: "outgoing", message: "Dạ bên em có cổng, album, ngoại cảnh ạ" }],
    message: "ok ạ",
    expected: { action: "WAIT" },
  },
  {
    id: "G43", name: "Khách cũ nhắn 'chào' trần → WAIT (không đẩy bước)",
    history: [{ direction: "incoming", message: "chụp beauty nha" }, { direction: "outgoing", message: "Dạ mình thích tone nào ạ?" }],
    message: "chào",
    expected: { action: "WAIT" },
  },
  {
    id: "G44", name: "'khi nào có ngày em báo' → not_decided, cấm hỏi ngày",
    history: [{ direction: "incoming", message: "chụp cưới nha" }, ASKED_DATE],
    message: "khi nào có ngày em báo nha",
    expected: { dateStatus: "not_decided", forbiddenAction: "ASK_DATE", forbiddenQuestionsInclude: ["ask_date"] },
  },
  {
    id: "G45", name: "'cho chị xin giá trước đi' khi đã hỏi ngày 1 lần → giá tham khảo, không lặp",
    history: [{ direction: "incoming", message: "chụp cưới nha" }, ASKED_DATE],
    message: "cho chị xin giá trước đi em",
    expected: { action: "QUOTE_REFERENCE", forbiddenAction: "ASK_DATE" },
  },
  {
    id: "G46", name: "Slang viết tắt 'z gia sao e' → vẫn hiểu là hỏi giá",
    history: [{ direction: "incoming", message: "chụp cổng nha em" }, ASKED_DATE],
    message: "z gia sao e",
    expected: { action: "QUOTE_REFERENCE", forbiddenAction: "ASK_DATE" },
  },
  {
    id: "G47", name: "'ngày 20-12 nha em' (dấu gạch) → known, không hỏi lại",
    history: [{ direction: "incoming", message: "chụp cưới" }, ASKED_DATE],
    message: "ngày 20-12 nha em",
    expected: { dateStatus: "known", eventDate: "2026-12-20", forbiddenQuestionsInclude: ["ask_date"] },
  },
  {
    id: "G48", name: "Khách bỏ qua câu hỏi ngày 2 lần rồi hỏi váy → chuyển rental, vẫn cấm hỏi ngày",
    history: [
      { direction: "incoming", message: "chụp cưới nha" }, ASKED_DATE,
      { direction: "incoming", message: "mà bên em chụp đẹp không" }, ASKED_DATE,
    ],
    message: "bên em có cho thuê váy cưới không?",
    expected: { serviceIntent: "rental_outfit", action: "ANSWER_FAQ", forbiddenAction: "ASK_DATE", forbiddenQuestionsInclude: ["ask_date"] },
  },
  {
    id: "G49", name: "4 tin dồn dập kết bằng chốt lịch → state gộp đủ, booking",
    history: [
      { direction: "incoming", message: "e oi" },
      { direction: "incoming", message: "chụp cưới nha" },
      { direction: "incoming", message: "20/12" },
    ],
    message: "chốt lịch luôn nha",
    expected: { dateStatus: "known", eventDate: "2026-12-20", stage: "BOOKING_INTENT", action: "ASK_PHONE" },
  },
  {
    id: "G50", name: "Objection slang không dấu 'bot chut duoc k e' → xử lý băn khoăn + báo người thật",
    history: [{ direction: "incoming", message: "chụp cưới giá sao" }, ASKED_DATE, { direction: "incoming", message: "20/12" }, { direction: "outgoing", message: "Dạ gói bên em 3.900.000đ ạ" }],
    message: "bot chut duoc k e",
    quotedCodes: ["ST-BASIC"],
    expected: { action: "HANDLE_OBJECTION", shouldEscalate: true },
  },
  {
    id: "G51", name: "Sample slang 'e oi cho xem mau vay cuoi' → gửi mẫu rental",
    history: [],
    message: "e oi cho xem mau vay cuoi voi",
    expected: { serviceIntent: "rental_outfit", action: "SEND_SAMPLE" },
  },
  {
    id: "G52", name: "'chị hỏi thật, hôm bữa em báo nhiêu tiền ấy nhỉ' — khách quay lại hỏi giá cũ",
    history: [{ direction: "incoming", message: "chụp cổng giá sao" }, ASKED_DATE, { direction: "incoming", message: "chưa biết ngày" }, { direction: "outgoing", message: "Dạ em gửi giá tham khảo nha" }],
    message: "chị hỏi thật, hôm bữa em báo nhiêu tiền ấy nhỉ",
    quotedCodes: ["CG-BASIC"],
    expected: { stage: "QUOTED", action: "QUOTE_REFERENCE", forbiddenAction: "ASK_DATE" },
  },
  {
    // 30/07 — phát hiện từ demo live Scenario Manager: "cho chị tham khảo giá trước" là cách
    // hỏi giá rất phổ biến mà PRICE_QUESTION_RE cũ bỏ sót → router rơi về IDENTIFY_SERVICE.
    id: "G53", name: "'chưa chốt ngày, cho chị tham khảo giá trước' → giá tham khảo, cấm hỏi ngày",
    history: [{ direction: "incoming", message: "Chào em, chị muốn chụp album cưới" }],
    message: "chị chưa chốt ngày đâu, cho chị tham khảo giá trước nha",
    expected: {
      serviceIntent: "wedding_album", dateStatus: "not_decided",
      stage: "QUOTE_REFERENCE", action: "QUOTE_REFERENCE",
      forbiddenQuestionsInclude: ["ask_date"],
      stateChange: "tham khảo giá = hỏi giá; chưa chốt ngày → báo tham khảo, không hỏi ngày",
    },
  },
];

// ─── BIẾN THỂ KHÔNG DẤU (slang/typo layer) ───────────────────────────────────
// Khách Việt gõ không dấu rất nhiều — mọi extractor/router đều normalize nên hành vi
// PHẢI y hệt bản có dấu. Sinh tự động 1 biến thể/case (id + "-nd") với message + history
// đã bỏ dấu; expected giữ nguyên.

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

export function buildNoDiacriticVariants(cases: GoldenCase[]): GoldenCase[] {
  return cases.map((c) => ({
    ...c,
    id: `${c.id}-nd`,
    name: `${c.name} (không dấu)`,
    history: c.history.map((h) => ({ ...h, message: stripDiacritics(h.message) })),
    message: stripDiacritics(c.message),
  }));
}

/** Bộ đầy đủ: case gốc + biến thể không dấu (dùng cho runner + report). */
export function allGoldenCases(): GoldenCase[] {
  return [...GOLDEN_CASES, ...buildNoDiacriticVariants(GOLDEN_CASES)];
}
