import type { ThreadState } from "./sale-thread-state";
import { OBJECTION_LABELS, UNKNOWN_VALID, type ObjectionType } from "./sale-slots-extra";

/**
 * FOLLOW-UP PLAN (Sales Brain V1 mục 8) — "follow-up CÓ LÝ DO", module THUẦN.
 *
 * Nhìn vào trí nhớ (objection cuối, gói đã báo, gu, ngày, người quyết định) → chọn
 * ĐÚNG lý do nhắn lại + soạn nháp giọng Hoa THÊM GIÁ TRỊ MỚI cho lần chạm này.
 * CẤM tuyệt đối kiểu "chị chốt chưa ạ" / "chị suy nghĩ sao rồi".
 *
 * An toàn Meta: module này CHỈ LẬP KẾ HOẠCH — không gửi gì. Consumer hiện tại là panel
 * "Khách cần chăm lại" (người thật bấm gửi). Auto-scheduler NÂNG CẤP SAU, cần chủ duyệt riêng.
 */

export type FollowUpReason =
  | "after_quote"       // im lặng sau khi được báo giá
  | "ask_partner"       // đang chờ bàn với chồng/gia đình
  | "price_objection"   // từng chê giá / xin giảm
  | "style_support"     // chưa chốt được gu
  | "has_event_date"    // đã có ngày — nhắc mốc thời gian nhẹ
  | "general_care";     // không rõ — hỏi thăm + cho giá trị

export type FollowUpPlan = {
  reasonType: FollowUpReason;
  /** Lý do hiển thị cho nhân viên (VN). */
  reasonVn: string;
  /** Nháp tin giọng Hoa — người thật duyệt/sửa trước khi gửi. */
  draft: string;
  /** Objection gần nhất (nếu có) để nhân viên nắm bối cảnh. */
  lastObjection: { type: ObjectionType; quote: string } | null;
};

const first = (name: string | null | undefined) =>
  (name ?? "").trim().split(/\s+/).slice(-1)[0] || "mình";

/**
 * Lập kế hoạch follow-up từ trí nhớ. null = không đủ căn cứ (để hệ cũ tự xử).
 * KHÔNG bao giờ đề xuất khi khách đã LOST (từ chối rõ) — tôn trọng tuyệt đối.
 */
export function planFollowUpFromState(state: ThreadState | null, name?: string | null): FollowUpPlan | null {
  if (!state) return null;
  if (state.customerStatus === "lost" || state.slots.lost_reason) return null;
  if (state.customerStatus === "customer") return null;

  const n = first(name);
  const objections = state.slots.objections ?? [];
  const last = objections.length ? objections[objections.length - 1] : null;
  const lastObjection = last ? { type: last.type, quote: last.quote } : null;
  const gu = state.slots.style && state.slots.style !== UNKNOWN_VALID ? state.slots.style : null;

  // 1. Đang chờ hỏi chồng/gia đình → gửi tóm tắt tiện chuyển, không hỏi kết quả.
  if (state.slots.decision_maker === "partner" || last?.type === "ASK_PARTNER") {
    return {
      reasonType: "ask_partner",
      reasonVn: "Khách đang bàn với chồng/gia đình — gửi tóm tắt gọn để khách tiện đưa người nhà xem (KHÔNG hỏi kết quả).",
      draft: `Em gửi ${n} bản tóm tắt gói kèm vài ảnh đẹp để mình tiện đưa anh nhà xem cho dễ hình dung nha. Cần em giải thích thêm phần nào cứ nhắn em ạ 😊`,
      lastObjection,
    };
  }

  // 2. Từng chê giá/xin giảm → bằng chứng giá trị MỚI, không nhắc lại giá y nguyên.
  if (last?.type === "PRICE_OBJECTION" || last?.type === "DISCOUNT_REQUEST" || last?.type === "BUDGET_CONCERN") {
    return {
      reasonType: "price_objection",
      reasonVn: `Khách từng ${OBJECTION_LABELS[last.type]} ("${last.quote.slice(0, 60)}") — gửi bằng chứng giá trị mới (ảnh giao thật/feedback), KHÔNG lặp lại giá.`,
      draft: `Em mới soạn thêm bộ ảnh khách bên em vừa nhận tuần rồi, gửi ${n} xem chất lượng thật tế nha. Mình xem có gì thắc mắc về quyền lợi gói cứ hỏi em ạ.`,
      lastObjection,
    };
  }

  // 3. Chưa chốt được gu → gửi 1 hướng concept MỚI.
  if (last?.type === "STYLE_UNCERTAIN" || state.slots.style === UNKNOWN_VALID) {
    return {
      reasonType: "style_support",
      reasonVn: "Khách chưa chốt được gu — gửi 1 hướng concept MỚI chưa gửi lần trước.",
      draft: `Em vừa lọc thêm một hướng concept khác${gu ? "" : " (tone nhẹ nhàng tự nhiên)"} thấy hợp với mình nè, ${n} xem thử gần gu mình hơn không nha 😊`,
      lastObjection,
    };
  }

  // 4. Đã có mốc ngày → nhắc mốc thời gian NHẸ (không dọa khan hiếm giả).
  if (state.slots.date_status === "known" && (state.slots.event_date || state.slots.date_text)) {
    const when = state.slots.date_text || state.slots.event_date;
    return {
      reasonType: "has_event_date",
      reasonVn: `Khách có mốc ${when} — nhắc nhẹ để chuẩn bị kịp, mời xác nhận lịch (không hứa chắc còn lịch).`,
      draft: `${n} ơi, sắp tới mốc ${when} của mình rồi á. Nếu mình vẫn định chụp dịp đó thì nhắn em để em kiểm tra lịch và nhờ nhân viên giữ chỗ sớm cho mình nha.`,
      lastObjection,
    };
  }

  // 5. Đã báo giá mà im lặng → thêm giá trị mới đúng gu (không hỏi "chốt chưa").
  if (state.quotedPackages.length > 0) {
    return {
      reasonType: "after_quote",
      reasonVn: `Đã báo giá (${state.quotedPackages.map((p) => p.code).join(", ")}) mà khách im — gửi ảnh thật đúng gu + 1 giá trị mới, KHÔNG hỏi "chốt chưa".`,
      draft: `Em gửi ${n} thêm vài ảnh${gu ? ` đúng gu ${gu}` : ""} bên em mới chụp xong nha, xem cho có thêm hình dung á. Mình cần em tư vấn thêm phần nào cứ nhắn em 😊`,
      lastObjection,
    };
  }

  // 6. Có nhu cầu nhưng chưa đi tới đâu → hỏi thăm + cho giá trị.
  if (state.serviceIntent) {
    return {
      reasonType: "general_care",
      reasonVn: "Khách có nhu cầu nhưng chưa đi tiếp — hỏi thăm thật lòng + tặng 1 thông tin hữu ích.",
      draft: `${n} ơi, em thấy mình có quan tâm bên em mà chưa kịp tư vấn kỹ á. Em gửi mình vài mẫu đẹp mùa này hay chụp nha, mình rảnh xem cho vui, cần gì hỏi em ạ 😊`,
      lastObjection,
    };
  }

  return null;
}
