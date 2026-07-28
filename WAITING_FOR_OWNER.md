# WAITING_FOR_OWNER — các quyết định chỉ anh Chí chốt được

> Quy ước: mỗi mục có QUESTION / WHY / OPTIONS / RECOMMENDATION / RISK_IF_DELAYED.
> Bot/agent KHÔNG tự quyết các mục này. Xong mục nào xóa mục đó.

## 1. Republish #135 (trí nhớ Lulu — flag TẮT)
- WHY: Bước 3 kế hoạch 8 bước; DDL additive đã vào main (5acc3a9).
- OPTIONS: (a) Republish theo runbook — màn migration hiện `CREATE TABLE lulu_thread_state` + 2 index (+có thể `sale_playbooks`) là DỰ KIẾN → Approve; DROP bất kỳ → Cancel. (b) Chạy tay DDL lên prod trước để màn hình "No changes".
- RECOMMENDATION: (a).
- RISK_IF_DELAYED: pilot Bước 6 và mọi thứ sau đứng chờ; không rủi ro kỹ thuật khi chậm.

## 2. Duyệt PR #136 → PR #137 (Brain Lab + Workflow V1, offline)
- WHY: sân test có trí nhớ + trace là điều kiện Bước 5 (anh test tay).
- OPTIONS: merge lần lượt #136 rồi #137 (stacked, tự retarget) / yêu cầu sửa.
- RECOMMENDATION: merge cả hai — 104 golden case + 57/57 file test xanh, đã qua 2 vòng review đối kháng (14+11 lỗi thật đã sửa).
- RISK_IF_DELAYED: không test tay được trên UI; các PR sau chồng thêm khó review.

## 3. Master switch admin-only (PR #138 — ĐẢO quyết định cũ của anh)
- QUESTION: Code hiện ghi chú "mở mọi màn Lulu cho MỌI staff là quyết định của chủ studio" (claude-sale-settings.ts:53-55). Siết PUT /claude-sale/master về admin-only là đảo một phần quyết định đó — anh xác nhận?
- OPTIONS: (a) admin-only + audit + notify (như PR #138). (b) Giữ mọi staff nhưng thêm audit + notify.
- RECOMMENDATION: (a) — nguyên nhân trực tiếp sự cố 28/6 (ai đó tắt bot, không truy được).
- RISK_IF_DELAYED: sự cố "bot tự tắt" có thể tái diễn, vẫn không truy được ai.

## 4. Notify gửi cho AI? (PR-B sắp làm)
- QUESTION: Notify "khách mới / khách để SĐT / bot đang tắt mà khách nhắn" gửi cho MỌI SALE hay CHỈ ADMIN?
- CONTEXT: web push broadcast hiện chỉ tới staff role='admin' (web-push.ts:102-114, còn bỏ sót mảng roles).
- RECOMMENDATION: mọi sale (kèm sửa web-push đọc cả mảng roles).
- RISK_IF_DELAYED: PR-B em sẽ tạm làm theo recommendation, đổi 1 dòng nếu anh chọn khác.

## 5. Debounce gộp tin — mấy giây? (PR-C sắp làm)
- RECOMMENDATION: 6 giây (Lulu vốn delay giả-người-thật 2-11s nên khách không cảm nhận chậm thêm).

## 6. Sửa bug prod detectEscalation "gặp người thật" (PR nhỏ riêng)
- QUESTION: sale-lead-flags.ts:254 class `ng[uư][oơ]i` thiếu "ờ" → khách gõ ĐỦ DẤU "cho chị gặp người thật" KHÔNG được escalate trên prod hiện tại. Sửa = đổi hành vi prod (escalate NHIỀU hơn, đúng hơn) — cần anh duyệt.
- RECOMMENDATION: duyệt sửa (1 dòng regex + test).
- RISK_IF_DELAYED: khách đòi gặp người thật bị bot tiếp tục trả lời.

## 7. ENABLE_AI_FOLLOWUP trên Deployment env prod đang bật hay tắt?
- WHY: follow-up dùng sai tag Meta `CONFIRMED_EVENT_UPDATE` (rủi ro policy). Nếu đang TẮT → để backlog; nếu BẬT → cần vá tag sớm.
- RISK_IF_DELAYED: nếu đang bật, rủi ro Meta phạt page.

## 8. Nội dung FAQ/SOP thật (địa chỉ, giờ mở cửa, thời gian giao ảnh, chính sách cọc/hoàn/dời lịch)
- WHY: Router đã có ANSWER_FAQ + knowledgeNeeded nhưng NGUỒN DỮ LIỆU CHƯA TỒN TẠI — em không bịa nội dung kinh doanh.
- CẦN Ở ANH: 1 danh sách Q&A ngắn (10-20 dòng) + SOP cọc/dời lịch. Em sẽ dựng bảng + UI + nạp theo action.
- RISK_IF_DELAYED: khách hỏi địa chỉ/giờ → Lulu né hoặc phải escalate.

## 9. Pilot Bước 6: chọn 2-3 psid khách test
- WHY: `LULU_STATE_ENABLED=1` + `LULU_STATE_PSIDS=<psid,psid>` chỉ bật trí nhớ cho đúng các thread đó.

## 10. AutoPost V2 & Meta Pixel/CAPI — input kinh doanh
- CẦN Ở ANH: (a) 3-5 content pillar + mục tiêu (booking mùa nào, dịch vụ nào cần đẩy); (b) quyền truy cập Meta Ads/Pixel (có pixel chưa? ID?); (c) đồng ý phạm vi tracking (hash SĐT gửi Meta cần cân nhắc privacy).
- RISK_IF_DELAYED: em chỉ dựng được kiến trúc + schema đề xuất (đã có trong backlog doc), chưa cắm số thật.
