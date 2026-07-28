# Lulu Sale Workflow V1 — Router + Playbook + Validator (OFFLINE)

> Trạng thái: **chưa nối production**. Chạy ở sân test Claude Sale Test (shadow mode) +
> Golden Test Set. Nối vào Messenger thật là PR riêng, CHỈ sau khi thread-state chạy ổn
> trên pilot (chỉ đạo 28/07: "State ổn mới Router+Validator, không nhét thêm rule vào prompt").

## Pipeline (đã chạy được toàn bộ trong sân test)

```
Message khách
  → Slot Extractor        (sale-slots.ts: ngày, chưa-chốt-ngày; sale-samples: nhóm dịch vụ)
  → Thread State          (sale-thread-state.ts: mô phỏng ở bench / bảng thật khi bật cờ)
  → Business State        (deriveStage — suy stage từ state)
  → Suggested Action      (sale-workflow.ts: routeSaleAction — DETERMINISTIC)
  → Context cho LLM       (khối TRẠNG THÁI KHÁCH + knowledgeNeeded [nền cho context-theo-action])
  → Response              (LLM chỉ "viết lời")
  → Validator             (sale-workflow-validator.ts: PASS/BLOCK — shadow)
  → State sau lượt nói    (recordBotReply / stateAfter trong trace)
```

Sân test trả về field `trace` mỗi lượt: message → extractedSlots → stateBefore → stateAfter
→ routerDecision (stage/action/reason/allowed/forbidden/knowledge) → validator. **Lulu trả
lời sai thì nhìn trace biết sai Ở TẦNG NÀO** — hết sửa prompt theo cảm giác.

## Router — nguyên tắc

- Business rule CỨNG quyết bằng code, LLM không có quyền: cấm hỏi lại ngày khi khách đã nói
  chưa chốt; cấm lặp câu đã hỏi; tiền/cọc/SĐT/khiếu nại/gặp người thật → người thật;
  không bao giờ tự giảm giá.
- 14 action V1: GREET, IDENTIFY_SERVICE, ASK_SERVICE, ASK_DATE, QUOTE_REFERENCE, QUOTE_EXACT,
  SEND_PRICE, SEND_SAMPLE, ANSWER_FAQ, HANDLE_OBJECTION, ASK_FOR_BOOKING, ASK_PHONE,
  ESCALATE_HUMAN, WAIT.
- Chỉ 3 lý do nghiệp vụ mở lại quyền hỏi ngày sau khi khách nói "chưa biết": khách muốn
  giữ lịch · muốn đặt cọc · nhờ kiểm tra lịch cụ thể.
- `SALE_PLAYBOOK_V1` (9 stage: NEW_LEAD, DISCOVERY, CONSULTING, QUOTE_REFERENCE, QUOTED,
  CONSIDERING, BOOKING_INTENT, WAITING, HUMAN_REVIEW) là bảng máy-đọc-được, router
  **enforce thật** (action ngoài allowedActions của stage → hạ về fallback an toàn).

## Validator — 7 rule deterministic (PASS / BLOCK{reason, violatedRule, suggestedRecovery})

1. `forbidden_ask_date` — hỏi ngày khi đang cấm.
2. `repeated_question` — hỏi lại câu đã hỏi ≥2 lần.
3. `response_not_matching_action` — router không chọn ASK_DATE mà reply chèn câu hỏi ngày.
4. `price_mismatch` — số tiền trong reply không khớp catalog (giá gốc hoặc giá sau ưu đãi).
5. `self_discount` — bot tự giảm giá / hứa ưu đãi.
6. `service_drift` — trôi khỏi nhu cầu đang khóa (nâng detectServiceDrift từ log → chặn).
7. `too_many_questions` — ≥3 câu hỏi một lượt.

Response BLOCK **không bao giờ** được gửi cho khách (khi nối thật: tái sinh 1 lần → cắt câu
vi phạm → escalate).

## Golden Test Set — 104 case (52 hội thoại thật × biến thể KHÔNG DẤU tự sinh)

Chấm bằng expected có cấu trúc (slot/stage/action/forbidden/state change), không chấm
"nghe hay". Phủ: date, pricing, intent, ảnh, gói, objection, booking, handoff,
multi-message, khách quay lại, số-không-phải-ngày, slang/không dấu — gồm đúng các lỗi
từng gặp thật ("chưa biết ngày", "2-3 người", "bé 3 tháng 10 ngày", "khi nào có ngày em
báo", "chốt gói này nha"...). Kết quả sau vòng review đối kháng (14 lỗi xác nhận → đã sửa):

| Metric | Kết quả | Mục tiêu trước pilot |
|---|---|---|
| Slot Accuracy | 100% (48/48) | — |
| Correct Action Rate | 100% (92/92) | — |
| Correct Stage Rate | 100% (38/38) | — |
| Escalation Accuracy | 100% (14/14) | — |
| Repeated Question Violations (rule cứng) | **0** | **0** |
| Business Rule Violations (deterministic) | **0** | **0** |
| Validator Catch Rate (bộ reply lỗi) | 100% | — |
| Price Accuracy (khi có catalog) | enforce bởi rule 4 (critical) | 100% |

Chạy lại: `pnpm exec vitest run src/lib/sale-workflow-golden.test.ts --disableConsoleIntercept`
(in bảng metric); thêm `GOLDEN_TRACE=1` để in 5 trace tiêu biểu.

## Khoảng trống đã biết (chưa chặn V1, ghi rõ để không ảo tưởng)

- Nguồn FAQ/SOP có cấu trúc (địa chỉ, giờ mở cửa, giao ảnh) **chưa tồn tại** — ANSWER_FAQ
  mới trả `knowledgeNeeded`, chưa có dữ liệu nạp. Cần bảng FAQ trước khi bật thật.
- Slot mới có NGÀY; gu/tone, ngân sách, số người là slot V2.
- `detectEscalation` (prod, sale-lead-flags.ts) có bug tiềm ẩn: class `ng[uư][oơ]i` không
  chứa "ờ" nên "**gặp người thật**" gõ đủ dấu KHÔNG match — router V1 tự vá bằng detector
  đã-bỏ-dấu (WANT_HUMAN_RE), file prod giữ nguyên chờ anh duyệt sửa riêng.
- Router/Validator đang shadow (quan sát) — chưa ép reply, chưa nối fb-inbox.
