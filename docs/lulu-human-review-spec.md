# Lulu Human Review — "Câu hỏi lạ cần xử lý" (Spec thực thi)

Ngày: 2026-06-19 · Trạng thái: đã duyệt thiết kế, triển khai phase 1.

## Nguyên tắc
- Tái dụng tối đa hệ thống cũ (escalate / pause / notify / manual-send / playbook / settings).
- Thêm **1 bảng mỏng** `lulu_human_reviews` (chưa có bảng tương đương per-câu-hỏi).
- **1 trang riêng** `/lulu-human-review` ("Câu hỏi lạ cần xử lý").
- **KHÔNG** job nhắc-5-phút ở phase này (chừa cột `followup_hold_sent_at`).
- Price-gating tách riêng ở prompt/context (claude-sale.ts), KHÔNG trộn vào human review.
- KHÔNG push Git. KHÔNG đụng production DB. KHÔNG sửa booking/payment/calendar/attendance.
- Migration an toàn: chỉ `CREATE TABLE IF NOT EXISTS` (đúng pattern `ensure*Table()` sẵn có).

## 8 điểm đã chốt
1. Nhân viên "Gửi cho khách" → GIỮ `takeover`, KHÔNG tự mở lại bot. Có nút riêng "Mở lại bot".
2. `staffReply` gửi NGUYÊN VĂN, không cho AI viết lại/paraphrase.
3. Chống trùng báo đỏ: 1 `facebook_user_id` đang có review `open` → UPDATE dòng cũ (cập nhật câu hỏi mới nhất), KHÔNG tạo dòng mới.
4. Hold message: mỗi escalation chỉ gửi 1 lần (dựa `hold_message_sent_at`); không lặp.
5. "Lưu kịch bản" → chỉ tạo `sale_playbooks` status='draft' (KHÔNG tự active).
6. `lowConfidenceThreshold` chỉ áp cho ảnh khi có `imageIntent`. `confidence < threshold` hoặc `can_studio_do=false` → escalate; không gửi sampleImages khi ảnh không chắc.
7. Cool boy/chụp nam: giữ rule cứng sẵn có (sale-samples.ts) — không gửi ảnh nữ/cưới, chưa có mẫu nam đúng thì không gửi ảnh. KHÔNG sửa.
8. Câu hỏi giá chung chung KHÔNG escalate → dùng price-gating hỏi nhu cầu. Chỉ escalate khi: deal sâu/than mắc, câu lạ, khiếu nại, lịch/cam kết, hủy-dời lịch/phát sinh, ngoài dữ liệu.

## Bảng mới: `lulu_human_reviews`
id · facebook_user_id · channel(messenger/website/test) · customer_name · customer_question ·
customer_images_json(jsonb) · detected_intent · confidence(numeric) · reason_for_escalation ·
ai_suggested_reply · staff_reply · staff_id · status(open/sent/ignored) · priority(normal/high/urgent) ·
saved_to_playbook(bool) · hold_message_sent_at · followup_hold_sent_at(reserved) · created_at · updated_at · sent_at

Không có `bot_paused` (dùng `crm_leads.ai_mode`).

## Settings thêm vào `claude_sale_settings.config` (JSONB — KHÔNG migration)
humanReviewEnabled(true) · lowConfidenceThreshold(0.65) · holdMessageAfterSeconds(10) ·
followUpHoldAfterMinutes(5, reserved) · autoPauseThreadWhenEscalated(true) ·
allowAiSuggestedReply(true) · saveHumanAnswerAsPlaybook(true)

## Files
### Backend (api-server/src)
- `lib/sale-human-review.ts` (MỚI): ensure table, HOLD_MESSAGE, imageEscalationReason(), upsertOpenHumanReview(), markHoldSent(), list/get/markSent/markIgnored/markSavedToPlaybook/countOpen.
- `lib/sale-settings.ts` (SỬA): +7 field type + default + normalize.
- `lib/claude-sale.ts` (SỬA): +PRICE_GATING_RULE, chèn vào buildSystemPrompt (nhánh có settings). Nói rõ price-gating KHÔNG phải lý do escalate.
- `lib/sale-lead-flags.ts` (SỬA): mở rộng `detectEscalation` (giảm sâu/than mắc, hủy-dời lịch/phát sinh).
- `routes/fb-inbox.ts` (SỬA): escalationReason += imageEscalationReason; nếu humanReviewEnabled && escalation → CHẶN nội dung chính/ảnh/giá, gửi 1 hold message, upsert báo đỏ, escalateToHuman, return. + export `sendManualReply()`.
- `routes/lulu-human-review.ts` (MỚI): GET list, GET count-open, POST :id/reply, POST :id/save-playbook, POST :id/ignore, POST :id/reopen-bot.
- `routes/index.ts` (SỬA): mount router.
- `routes/claude-sale-test.ts` (SỬA): DEV MODE thêm escalated/escalationReason/holdMessage/usedPlaybook/botPaused/humanReviewId(null, test không ghi DB).

### Frontend (amazing-studio/src)
- `pages/lulu-human-review.tsx` (MỚI): bảng hàng đợi + ô staffReply + Gửi/Lưu kịch bản/Bỏ qua/Mở hội thoại/Mở lại bot + badge đỏ.
- `App.tsx` (SỬA): import + INTERNAL_PREFIXES + Route (AdminRoute).
- `components/layout.tsx` (SỬA): +1 item FACEBOOK_NAV.

## Test cases
- CASE 1 "Chụp cưới bao nhiêu?" → hỏi nhu cầu (price-gating), KHÔNG escalate, không tạo báo đỏ.
- CASE 2 "concept cổ trang dưới nước khói lạnh" → escalate, hold message, tạo báo đỏ, bot pause (takeover).
- CASE 3 "giảm thêm, bên kia rẻ hơn" → escalate (keyword giảm/rẻ hơn), không tự deal sâu.
- CASE 4 ảnh lạ confidence thấp → không gửi ảnh mẫu, hold + escalate.
- CASE 5 nhân viên nhập staffReply + Gửi → gửi nguyên văn ra Messenger, status=sent, log manual_sent, có nút Lưu kịch bản (draft).
- Anti-spam: khách hỏi liên tục khi đang open → chỉ 1 dòng báo đỏ, hold không lặp.
