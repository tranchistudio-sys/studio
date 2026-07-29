# KỊCH BẢN THÔ — LULU SALES BRAIN V1

> **Tài liệu thiết kế cho developer + chủ studio.** Mục tiêu: Lulu hoạt động như nhân viên sale thật —
> `KHÁCH NÓI → HIỂU Ý ĐỊNH → BIẾT KHÁCH Ở GIAI ĐOẠN NÀO → CHỌN HÀNH ĐỘNG → DẪN KHÁCH TIẾN 1 BƯỚC` —
> KHÔNG phải chatbot hỏi đáp, KHÔNG phải một mega-prompt học thuộc lòng.
>
> **Nguồn:** (1) hệ thống thật đang chạy (Workflow V1 + Thread State + Scenario Manager PR #145 +
> follow-up scheduler + sale-reengage); (2) tài liệu nội bộ `sal.docx` "AI Inbox Sale System 7 Bước";
> (3) 5 skill sale trong thư viện `D:\SKILL CHO AI` (sales-enablement, cold-email, marketing-psychology,
> pricing, emails). **Lưu ý trung thực:** không tìm thấy sách đào tạo sale thương mại nào trên máy —
> mục 12–13 map từ 2 nguồn trên; nếu chủ có trang sách chụp ảnh, gửi vào chat để bổ sung V1.1.

---

## 0. NGUYÊN TẮC KIẾN TRÚC — 3 LỚP (mục K)

```
LỚP 1 — DATA (đã có, không đụng):
  bảng giá + gói (service_groups/packages + discount), ảnh mẫu (sale-samples/CMS),
  lịch (sale-calendar read-only), chính sách (sale-settings), khách (crm_leads/customers)

LỚP 2 — SALES BRAIN (tài liệu này):
  State machine + Decision tree = CODE deterministic (sale-workflow.ts mở rộng)
  Thẻ tình huống = DATA chủ sửa được (Scenario Manager — lulu_sale_scenarios)
  Trí nhớ khách = lulu_thread_state (slots mở rộng)
  Follow-up engine = hợp nhất follow-up-scheduler + sale-reengage + thread-state

LỚP 3 — CONVERSATION (đã có):
  askClaudeForReply: LLM CHỈ viết lời tự nhiên cho action đã được Lớp 2 quyết,
  qua Validator 8 luật + human-chat pacing (chia 2–3 tin, delay 3–9s — đúng sal.docx)
```

**Luật vàng:** Business rule quyết bằng CODE. LLM chỉ viết lời. Chủ sửa hành vi qua THẺ, không qua prompt.

---

## 1. CUSTOMER JOURNEY HOÀN CHỈNH (mục A + L1)

```
                     ┌──────────────────────────────────────────────────────────┐
                     ▼                                                          │
[1] CHÀO HỎI ──► [2] XÁC ĐỊNH NHU CẦU ──► [3] TƯ VẤN ──► [4] BÁO GIÁ           │
 (NEW_LEAD)      (DISCOVERY)             (CONSULTING)   (QUOTE_REFERENCE/QUOTED)│
                     ▲                                        │                 │
                     │                              ┌─────────┴─────────┐       │
                     │                              ▼                   ▼       │
                     │                    [5] PHẢN ĐỐI/PHÂN VÂN   [BUYING SIGNAL]
                     │                    (CONSIDERING+OBJECTION)       │       │
                     │                              │                   ▼       │
                     │                              │            [6] SẴN SÀNG CHỐT
                     │                              │            (BOOKING_INTENT)
                     │                              ▼                   │       │
                     │                    [7] NGỦ ĐÔNG/CHĂM LẠI         ▼       │
                     │                    (WAITING + FOLLOW_UP)  [7'] CHỐT CỌC  │
                     │                              │            (HUMAN_REVIEW  │
                     └──────────────────────────────┤             → người thật) │
                                                    │                   │       │
                                                    ▼                   ▼       │
                                                 [LOST]            [BOOKED] ────┘
                                              (mất lead)                │  (khách cũ quay lại
                                                                        ▼   → về [2])
                                                                   [8] UPSELL/CSKH
```

Điểm khác chatbot hỏi-đáp: **mọi lượt trả lời đều phải đẩy khách sang phải 1 nấc** (hoặc giữ ấm có chủ đích ở WAITING) — không có lượt "trả lời xong để đó".

---

## 2. STATE MACHINE CỦA LULU (mục B + L2)

### 2.1 Map state yêu cầu → hệ thống thật

| State yêu cầu | Trong hệ thống | Trạng thái |
|---|---|---|
| NEW_LEAD, GREETING | `NEW_LEAD` (SaleStage) | ✅ có |
| DISCOVERY | `DISCOVERY` | ✅ có |
| CONSULTING | `CONSULTING` | ✅ có |
| PRICE_PRESENTED | `QUOTE_REFERENCE` (chưa ngày) / `QUOTED` (đã báo) | ✅ có |
| OBJECTION | `CONSIDERING` + slot `objection` (mới) | 🔶 nâng cấp |
| CONSIDERING | `CONSIDERING` | ✅ có |
| FOLLOW_UP | `WAITING` + engine follow-up (mới) | 🔶 nâng cấp |
| READY_TO_BOOK | `BOOKING_INTENT` | ✅ có |
| DEPOSIT_PENDING | `HUMAN_REVIEW` (bàn giao người — bot **không bao giờ** đụng tiền cọc, luật lõi) | ✅ có |
| BOOKED | `BOOKED` | ✅ có (deriveStage chưa tự vào — cần nối `crm_leads.customer_id`) |
| UPSELL | `UPSELL` | 🆕 V2 |
| LOST | `LOST` | 🆕 V2 |

### 2.2 Đặc tả từng state (mục tiêu / đã biết / thiếu / hỏi gì / cấm gì / chuyển / nhánh)

> Ký hiệu: **S** = slots trong `lulu_thread_state`. Cấm 🔒 = Validator/Core Guard chặn cứng, thẻ không gỡ được.

**NEW_LEAD — Chào hỏi**
- Mục tiêu: thiện cảm + mở chuyện nhu cầu (sal.docx B1: KHÔNG báo giá).
- Đã biết: chưa gì (hoặc tên FB). Thiếu: `service_intent`.
- Hỏi: "mình đang quan tâm dịch vụ nào" (gợi 2–3 lựa chọn trong câu). Cấm: 🔒báo giá, 🔒xin SĐT, hỏi ngày.
- Chuyển: có `service_intent` → CONSULTING; nói chung chung → DISCOVERY; khiếu nại/gặp người → HUMAN_REVIEW.

**DISCOVERY — Xác định nhu cầu**
- Mục tiêu: chốt NHÓM dịch vụ (1 trong 8 intent: beauty, wedding_album, wedding_gate, wedding_party, rental_outfit, maternity, family, new_concept_idea).
- Đã biết: có hội thoại. Thiếu: `service_intent`.
- Hỏi: đúng 1 câu khoanh nhóm. Cấm: 🔒báo giá chính thức, gửi bảng giá, xin SĐT, hỏi dồn (>1 câu 🔒validator).
- Chuyển: rõ nhóm → CONSULTING. Nhánh: hỏi FAQ → trả lời rồi quay lại; đòi xem mẫu chưa rõ nhóm → hỏi nhóm trước.

**CONSULTING — Tư vấn**
- Mục tiêu: hiểu gu → dẫn tới báo giá đúng nhu cầu (sal.docx B2+B3).
- Đã biết: `service_intent`. Thiếu (hỏi TỰ NHIÊN, mỗi lượt 1 câu, theo thứ tự ưu tiên): `date_status` (1 lần duy nhất) → `style` → `location_type` (nếu dịch vụ cần) → `headcount` (gia đình/tiệc) → `budget` (CHỈ khi khách phân vân giữa nhiều gói).
- Quy tắc UNKNOWN_VALID: khách trả lời "chưa biết" → ghi UNKNOWN_VALID, **coi là ĐÃ trả lời**, không bao giờ hỏi lại (đã có với ngày = `not_decided`; V2 áp cho mọi slot).
- Cấm: 🔒hỏi lại slot đã có/UNKNOWN_VALID, GREET lại, ASK_SERVICE lại, ép "phải có ngày mới tư vấn".
- Chuyển: khách hỏi giá → QUOTE_REFERENCE/QUOTED; đòi xem mẫu → gửi rồi ở lại; BUYING_SIGNAL → BOOKING_INTENT.

**QUOTE_REFERENCE / QUOTED — Báo giá (sal.docx B4)**
- Mục tiêu: báo giá ĐÚNG NHÓM như người tư vấn, không phải menu: chọn **1–3 gói** (Good-Better-Best, highlight 1 gói "hợp với mình nhất" — skill pricing), giải thích VÌ SAO hợp (mirror lời khách), kèm ảnh bảng giá + mẫu.
- Đã biết: `service_intent` (+ngày nếu có). QUOTE_REFERENCE khi `date_status=not_decided` — **vẫn báo giá tham khảo đầy đủ**, chốt "có ngày em kiểm tra lịch xác nhận lại".
- Cấm: 🔒bịa giá/thành phần (price_mismatch), 🔒tự giảm, dump cả bảng giá, hỏi lại ngày khi not_decided 🔒.
- Ghi: `quoted_packages` (đã có). Chuyển: BUYING_SIGNAL → BOOKING_INTENT; chê/so sánh/im → CONSIDERING; hỏi tiếp → ở lại.

**CONSIDERING (+substate OBJECTION) — Phản đối / phân vân (sal.docx B6)**
- Mục tiêu: xử lý đúng LOẠI phản đối (mục 7 dưới), không ép, không giảm.
- Ghi MỚI: `S.objections[] = {type, quote (nguyên văn), at}` — nền cho follow-up có lý do.
- Cấm: 💒tự giảm/bịa ưu đãi, ép chốt, hỏi dồn, nói xấu đối thủ.
- Chuyển: quay lại quan tâm → QUOTED/BOOKING_INTENT; im lặng → WAITING(+follow_up); từ chối rõ → LOST.

**BOOKING_INTENT — Sẵn sàng chốt (mục E + H)**
- Vào khi có BUYING_SIGNAL (mục 6). Mục tiêu: **NGỪNG tư vấn dài** — khép kín: xác nhận dịch vụ → gói → ngày → địa điểm → yêu cầu đặc biệt → giá; xin tên + SĐT.
- Cấm: 🔒tự xác nhận cọc/báo STK, 🔒hứa chắc còn lịch, sale lan man thêm.
- Chuyển: đủ ngày+SĐT → HUMAN_REVIEW (người thật chốt cọc — DEPOSIT_PENDING); khách khựng lại → CONSIDERING.

**WAITING + FOLLOW_UP — Chờ / chăm lại (sal.docx B7, thiết kế mục 8)**
- Vào khi: bot đã hỏi/gửi đủ mà khách im, hoặc khách hẹn ("để chị hỏi chồng").
- Ghi MỚI: `S.follow_up = {due_at, reason, last_objection, count}`.
- Cấm: hỏi ngày/SĐT khi chưa có tín hiệu mới, follow-up suông 🔒 (mục 8).
- Chuyển: khách nhắn lại → theo nội dung tin; hết chuỗi follow-up không phản hồi → LOST(soft).

**HUMAN_REVIEW — Người thật (DEPOSIT_PENDING nằm ở đây)**
- Bot chỉ giữ khách 1 câu lịch sự; 🔒không bán tiếp (escalate_but_selling). Nhân viên chốt cọc theo quy trình studio (bot không đụng tiền — bất di bất dịch).

**BOOKED — Đã cọc/thành khách**
- Mục tiêu: CSKH + mở cửa UPSELL. Cấm: 🔒sale lại từ đầu, GREET lại, hỏi ngày.
- V2: `deriveStage` đọc `crm_leads.customer_id`/`customer_status` để tự vào BOOKED (hiện chờ nối).

**UPSELL 🆕 (mục 9)** — chỉ sau khi BOOKED hoặc nhu cầu chính đã chốt; xem mục 9.

**LOST 🆕** — vào khi: từ chối rõ (REFUSAL_PATTERNS — đã có detect ở fb-inbox), "chốt bên khác rồi", hết chuỗi follow-up. Ghi `lost_reason`. Cấm: mọi follow-up tự động. KHÔNG xoá — khách có thể quay lại (LOST → DISCOVERY khi tự nhắn lại).

---

## 3. DECISION TREE TỪNG GIAI ĐOẠN (L3)

Đã chạy thật trong `routeSaleAction` (thứ tự ưu tiên cứng, mọi state đều đi qua):

```
Tin khách vào state S:
1. ESCALATION CỨNG?  (cọc/chuyển khoản/khiếu nại/huỷ-dời/xin giảm sâu)  → người thật 🔒
2. Đòi gặp người?                                                       → người thật 🔒
3. Để lại SĐT?                                                          → cảm ơn + bàn giao 🔒
4. BUYING_SIGNAL? (mục 6)                                               → BOOKING_INTENT
5. Câu hỏi FAQ? (địa chỉ/giờ/giao ảnh/gồm gì/thanh toán*)               → trả lời đúng nguồn (*tiền → người)
6. Đòi xem mẫu / xin bảng giá?                                          → gửi đúng nhóm (chưa rõ nhóm → hỏi nhóm)
7. Hỏi giá?  → đủ dữ liệu: QUOTED/QUOTE_REFERENCE; thiếu nhóm: hỏi nhóm; chưa từng hỏi ngày: hỏi ngày 1 lần
8. Ack cụt/thăm dò ("ok", "còn đó k")?                                  → đáp nhẹ, KHÔNG đẩy bước 🔒
9. Mặc định theo state: thiếu nhóm → hỏi nhóm; đủ → đào sâu gu / theo THẺ tình huống
```

Chủ studio tinh chỉnh nhánh 5–9 bằng **thẻ Scenario Manager** (không sửa code). Nhánh 1–4 + mọi 🔒 là luật lõi.

---

## 4. BỘ DỮ LIỆU LULU NHỚ VỀ TỪNG KHÁCH (mục C + G + L4)

### Đang có (3 bảng, live)
| Nhóm | Field | Ở đâu |
|---|---|---|
| Danh tính | name, phone, zalo, avatar, psid | `crm_leads` |
| Trạng thái bot | ai_mode (active/takeover/paused), customer_id | `crm_leads` |
| Thành tích AI | phone_captured, appointment_intent, needs_human + lý do | `claude_sale_lead_flags` |
| Nhu cầu | service_intent (8 nhóm) | `lulu_thread_state` |
| Ngày chụp | date_status (unknown/**not_decided=UNKNOWN_VALID**/known) + event_date + date_text | S.slots |
| Đã hỏi gì | asked_questions{key,count} — chống hỏi lặp | S |
| Đã báo giá gì | quoted_packages[mã gói] | S |
| Đã gửi gì | sent_assets{sample_urls, price_group_ids} | S |
| Follow-up cũ | follow_up_count, last_follow_up_at, is_opted_out | `ai_follow_up_logs` |

### V2 bổ sung (slots JSONB — KHÔNG cần DDL, chỉ thêm extractor)
| Slot mới | Giá trị | Ví dụ bắt được |
|---|---|---|
| `style` | text \| UNKNOWN_VALID | "kiểu Hàn Quốc", "tone trầm", "sang trọng" |
| `location_type` | studio/outdoor/both/UNKNOWN_VALID | "chụp ngoại cảnh", "tại studio" |
| `headcount` | số \| UNKNOWN_VALID | "nhà mình 5 người" |
| `budget` | khoảng VND \| UNKNOWN_VALID | "tầm 3–5 triệu" |
| `decision_maker` | self/partner/family | "để chị hỏi chồng" |
| `objections[]` | {type, quote, at} | mục 7 |
| `liked_packages[]` | mã gói khách ƯNG (≠ đã báo) | "gói giữa được á" |
| `follow_up` | {due_at, reason, count} | "tuần sau nhắn chị nha" |
| `lost_reason` | text | "chốt bên X rồi" |
| `asked_questions` mở rộng key | ask_style, ask_location, ask_headcount, ask_budget | chống hỏi lặp mọi câu |

**Quy tắc (mục C):** 1 slot đã có → không hỏi lại 🔒. "Chưa biết" = UNKNOWN_VALID = đã trả lời. Mỗi lượt hỏi TỐI ĐA 1 câu quan trọng nhất còn thiếu. Không bắt có ngày mới tư vấn.

---

## 5. ĐIỀU KIỆN CHUYỂN STATE (L5)

Đã mô tả trong 2.2; nguyên tắc máy:

- Stage suy từ state mỗi lượt (`deriveStage`) + **V2: persist `current_stage`** (đã có cột, chưa ghi) để FOLLOW_UP/UPSELL/LOST — các stage không suy được từ text — sống qua nhiều ngày.
- Chuyển bằng SỰ KIỆN: slot mới ghi được / signal detect được / mốc thời gian (follow_up.due_at) / hành động người (staff tiếp quản, tạo customer).
- Không bao giờ "lùi cưỡng bức": khách nhảy cóc (tin đầu đã đòi cọc) → theo khách, không theo thứ tự 1→7 (điểm SỬA so với sal.docx "không lùi step" — xem mục 12).

---

## 6. BỘ INTENT KHÁCH HÀNG (mục E + L6)

| Intent | Câu mẫu | Detector | Trạng thái |
|---|---|---|---|
| service_intent (8 nhóm) | "chụp cưới", "thuê váy" | detectServiceIntentFromText | ✅ |
| price_question | "giá sao", "bao nhiêu", "tham khảo giá" | PRICE_QUESTION_RE (+G53) | ✅ |
| want_pricelist | "gửi bảng giá đi" | SEND_PRICELIST_RE | ✅ |
| want_sample | "cho xem mẫu/album" | WANT_SAMPLE_RE | ✅ |
| FAQ 6 chủ đề | địa chỉ/giờ/giao ảnh/gồm gì/dịch vụ/thanh toán | FAQ_TOPICS | ✅ |
| **BUYING_SIGNAL** | "cọc bao nhiêu?" · "ngày X còn lịch không?" · "book sao em?" · "giữ ngày giúp chị" · "chốt gói này" · "có hợp đồng không?" · "qua thử váy được không?" | REOPEN_DATE_RE + CLOSE_DEAL_RE + detectAppointmentIntent + escalation cọc/CK | ✅ phần lớn; 🔶 V2 thêm: "có hợp đồng không", "qua thử váy/đồ", "ngày X còn trống không" |
| give_phone | để lại SĐT | detectPhone | ✅ |
| want_human | "cho gặp nhân viên" | WANT_HUMAN_RE | ✅ |
| objection_* | mục 7 | detectEscalation (giá) — 🔶 V2 mở rộng 12 loại | 🔶 |
| refusal | "không cần nữa", "đừng nhắn nữa" | REFUSAL_PATTERNS (fb-inbox) | ✅ → LOST |
| ack/presence | "ok ạ", "còn đó k" | isShortAck/PRESENCE | ✅ |
| postpone | "để chị suy nghĩ", "hỏi chồng đã" | 🆕 V2 → ghi follow_up + decision_maker | 🆕 |

**Luật BUYING_SIGNAL (mục E):** xuất hiện = NGỪNG tư vấn dài ngay lượt đó → BOOKING_INTENT (đã đúng trong engine — nhánh 3–4 decision tree, đứng TRÊN tư vấn).

---

## 7. BỘ OBJECTION — 12 LOẠI + CHIẾN THUẬT (mục F + L7)

Khung xử lý chung (skill sales-enablement, 5 bước): **nguyên văn khách → mối lo THẬT → ghi nhận → bằng chứng cụ thể → câu hỏi giữ nhịp.** Mọi loại đều GHI `S.objections[]` để follow-up đúng bệnh.

| Type | Khách nói | Mối lo thật | Chiến thuật Lulu | Cấm |
|---|---|---|---|---|
| PRICE_OBJECTION | "mắc quá" | chưa thấy giá trị | Đồng cảm → tách giá trị theo kết quả ("300 ảnh gốc + 50 tinh chỉnh, giao 7 ngày") → mental accounting ("kỷ niệm cả đời") → nếu thật sự lệch ngân sách: gợi gói thấp hơn NHƯ MỘT LỰA CHỌN TỐT | 🔒giảm giá, 🔒bịa ưu đãi |
| COMPARE_COMPETITOR | "bên X rẻ hơn" | sợ chọn sai | Không nói xấu; nêu điểm khác biệt CỤ THỂ + ảnh thật + feedback khách cũ (social proof) | nói xấu, đôi co |
| ASK_PARTNER | "hỏi chồng/mẹ đã" | cần người quyết | ACKNOWLEDGE ("dạ đúng rồi, chuyện lớn mà"); gửi TÓM TẮT gọn để khách chuyển cho người quyết; ghi decision_maker + hẹn follow_up 2–3 ngày | ép chốt ngay |
| NEED_TIME | "để chị suy nghĩ" | chưa đủ tin/quá tải | Hỏi NHẸ 1 câu điều còn lấn cấn; không được → chốt cửa mở + follow_up có giá trị mới | bám đuổi, hỏi dồn |
| NO_DATE_YET | "chưa biết ngày" | thăm dò sớm | = UNKNOWN_VALID: báo giá THAM KHẢO đầy đủ (thẻ đã có), không ép ngày 🔒 | hỏi lại ngày 🔒 |
| JUST_BROWSING | "tham khảo thôi" | đầu funnel | Phục vụ hào phóng (reciprocity): mẫu đẹp + giá tham khảo; không xin gì; ghi warm-lead | xin SĐT sớm |
| NO_RESPONSE | seen không rep | nhiều lý do | KHÔNG spam; theo chuỗi follow-up mục 8 (mỗi lần 1 giá trị mới, tối đa 3) | "chị chốt chưa" |
| NOT_TRUST_YET | "ảnh thật hay mẫu đó" | sợ ảo | Bằng chứng: ảnh khách thật (không phải concept), feedback, chính sách xem ảnh gốc trước khi chọn (regret aversion) | khen mình quá đà |
| STYLE_UNCERTAIN | "chưa biết chụp kiểu gì" | thiếu hình dung | Gửi 2–3 hướng gu KHÁC NHAU cho chọn (không dump 20 ảnh); hỏi "gần gu mình nhất?" | spam ảnh |
| BUDGET_UNCLEAR | "cỡ nhiêu thì đủ" | sợ vượt túi tiền | Good-Better-Best 3 gói + recommend 1; Rule: hỏi ngân sách CHỈ khi khách phân vân nhiều gói | ép gói cao |
| BUSY | "đang bận, tí nói" | thời điểm sai | Rút ngay 1 câu lịch sự + hẹn; ghi follow_up.due_at theo lời khách | nhắn tiếp liền |
| OTHER | còn lại | — | Không đoán bừa: hỏi làm rõ 1 câu; 2 lượt không rõ → người thật | vòng vo |

Mỗi loại = **1 thẻ Scenario Manager** (mục 11) → chủ sửa lời/chiến thuật không cần dev.

---

## 8. FOLLOW-UP ENGINE (mục G + L8)

### Hiện trạng (audit 30/07)
- `follow-up-scheduler.ts`: tự gửi 24/48/72h khi im lặng, template tĩnh random, **không biết nội dung hội thoại**; dùng MESSAGE_TAG lách cửa sổ 24h Meta (⚠️ rủi ro policy).
- `sale-reengage.ts` ("Khách cần chăm lại"): chấm hot/warm/cold + soạn nháp có lý do — nhưng CHỈ hiển thị, không liên thông scheduler.

### Thiết kế V2 — "follow-up có lý do" (hợp nhất 2 hệ + thread-state)

**Dữ liệu:** `S.follow_up = {due_at, reason_type, reason_detail, count}` — ghi khi: khách hẹn (postpone), objection cần nguội (ASK_PARTNER/NEED_TIME), im lặng sau báo giá, im lặng sau gửi mẫu.

**Chọn NỘI DUNG theo reason (cấm follow-up suông — sal.docx "không spam" + skill cold-email):**

| Lý do im | Follow-up ĐÚNG (thêm giá trị mới) | CẤM |
|---|---|---|
| Sau báo giá | Gửi bộ ảnh THẬT đúng gu đã khai thác + 1 câu giá trị | "chị chốt chưa ạ?" |
| ASK_PARTNER | "Em gửi tóm tắt gói để mình đưa anh nhà xem cho tiện nha" + ảnh | "anh nhà nói sao rồi" |
| PRICE_OBJECTION | Bằng chứng giá trị mới (feedback, ảnh giao thật) hoặc gói phù hợp hơn | nhắc lại giá y nguyên |
| Có event_date | Nhắc mốc: "tháng X là mùa đẹp, lịch bắt đầu kín — em giữ slot cho mình sớm nha" (chỉ khi khan hiếm THẬT) | dọa giả |
| STYLE_UNCERTAIN | 1 hướng concept MỚI chưa gửi | gửi lại ảnh cũ |
| Không rõ | Hỏi thăm thật lòng + 1 nội dung hữu ích (checklist chuẩn bị chụp) | "sao chị im vậy" |

**Nhịp (giữ khung sal.docx, nâng chất):** 3 lần, giãn dần 24h → 48h → 72h (hoặc theo due_at khách hẹn); mỗi tin tự đứng được; tin cuối là "tin chia tay" tử tế mở cửa quay lại → LOST(soft).

**Dừng tuyệt đối:** refusal/opt-out ✅ · đã BOOKED/customer ✅ · staff đang nhắn ✅ · LOST · quá 3 lần.

**An toàn Meta (đổi mặc định):** trong 24h window → được tự gửi; ngoài 24h → KHÔNG tự gửi bằng tag lách nữa, đẩy vào panel "Khách cần chăm lại" với **tin nháp soạn sẵn theo reason** để người bấm gửi (1 chạm). Log kết quả từng lần (khách rep không) → đo hiệu quả.

---

## 9. QUY TRÌNH CHỐT + UPSELL (mục H, I + L9, L10)

### Chốt (BOOKING_INTENT)
```
BUYING_SIGNAL → NGỪNG tư vấn → xác nhận CHECKLIST (chỉ hỏi cái CHƯA có trong S):
  dịch vụ ✓ → gói ✓ → ngày (hỏi được — lý do nghiệp vụ mới) → địa điểm → yêu cầu đặc biệt → chốt lại giá
→ xin tên + SĐT → "nhân viên bên em gọi xác nhận giữ lịch và hướng dẫn giữ chỗ trong hôm nay nha"
→ HUMAN_REVIEW (báo đỏ nhân viên — hạ tầng đã có). Đề xuất luôn có MỐC THỜI GIAN (skill: "giữ lịch 15/8 đến hết mai nhé").
🔒 Bot không xác nhận cọc, không báo STK, không hứa chắc lịch.
```

### Upsell (CHỈ khi nhu cầu chính đã rõ/đã chốt — không sớm hơn)
Công thức bắt buộc: **"Với trường hợp của mình (X), thêm (Y) có lợi vì (Z)"** — lợi ích thật, không "mua thêm không?".

| Khách đã chốt | Upsell tự nhiên (ưu tiên trước) |
|---|---|
| wedding_album | album cao cấp/phôi in → ảnh cổng (wedding_gate) → makeup → váy đi kèm → phóng sự ngày cưới |
| wedding_gate | album studio → makeup mẹ cô dâu → phóng sự tiệc |
| wedding_party | máy 2 / photographer thứ hai → video highlight |
| rental_outfit | makeup → chụp kèm khi thử đồ → vest chú rể |
| maternity | album bé sơ sinh (hẹn lịch sau sinh — follow_up dài hạn!) |
| beauty | ảnh in/khung → gói gia đình dịp lễ |
| family | ảnh in cỡ lớn → gói định kỳ hằng năm |

Nhịp: gợi 1 thứ MỘT LẦN sau khi chốt xong nhu cầu chính; khách không hứng → dừng, không lặp. Foot-in-the-door: cọc gói chuẩn trước, upsell khi khách đến thử đồ/duyệt concept (nhân viên tiếp sức — bot ghi `liked_packages` làm mồi).

---

## 10. GIỌNG LULU (mục J)

Đã có nền: persona Hoa (sale-settings toggles: xưng em, không markdown, không "quý khách", không lặp anh/chị) + human-chat pacing (chia 2–3 tin, delay theo độ dài — đúng sal.docx) + playbook giọng học từ chat thật (Sale Learning).

Bổ sung 6 luật văn phong vào Brain Lab (lớp giọng — KHÔNG nhét vào thẻ):
1. Nói về thế giới KHÁCH trước, studio sau ("Chụp cho bé 3 tháng thì nên…" thay vì "Bên em có gói…").
2. Mỗi tin 1 nhiệm vụ + tối đa 1 câu hỏi; "lẽ ra còn ngắn hơn được" là chuẩn duyệt.
3. Không kết thúc MỌI tin bằng câu hỏi — xen kẽ tin cho-đi (ảnh, mẹo) không đòi gì.
4. Mirror từ ngữ khách ("chụp cổng" nói "chụp cổng", đừng đổi "gói cổng hoa premium").
5. Khen có căn cứ, 1 lần; cấm "tuyệt vời quá ạ" dây chuyền.
6. Đọc to thấy giọng tờ rơi → viết lại (test: bỏ hết tính từ, còn thông tin không?).

---

## 11. KỊCH BẢN MẪU TỪNG NHÁNH (L11) — thẻ Scenario Manager mới

Đang có 13 thẻ (PR #145). V2 thêm **12 thẻ** (chủ sửa lời trong UI, không cần dev):

| # | Thẻ mới | KHI KHÁCH | LULU NÊN (tóm tắt) | ĐỪNG BAO GIỜ |
|---|---|---|---|---|
| 14 | Hỏi chồng/mẹ đã | postpone + decision_maker | ghi nhận + gửi tóm tắt cho người quyết + hẹn 2–3 ngày | ép chốt, "anh nói sao rồi" |
| 15 | Để suy nghĩ thêm | postpone | hỏi nhẹ 1 điều lấn cấn → chốt cửa mở | bám đuổi |
| 16 | So sánh bên khác | COMPARE | khác biệt cụ thể + ảnh thật + feedback | nói xấu 🔒 |
| 17 | Chưa tin ảnh thật | NOT_TRUST | ảnh khách thật + chính sách xem gốc | khen lố |
| 18 | Chưa biết gu | STYLE_UNCERTAIN | 2–3 hướng gu cho chọn | spam ảnh |
| 19 | Hỏi ngân sách bao nhiêu đủ | BUDGET_UNCLEAR | 3 gói + recommend 1 | ép gói cao |
| 20 | Đang bận | BUSY | rút lịch sự + ghi hẹn | nhắn tiếp liền |
| 21 | Follow-up sau báo giá | follow_up.due (reason=quoted) | ảnh thật đúng gu + 1 giá trị mới | "chốt chưa ạ" |
| 22 | Follow-up sau hỏi chồng | follow_up.due (reason=partner) | tóm tắt tiện chuyển + mở cửa | hỏi kết quả |
| 23 | Tin chia tay | follow_up count=3 im lặng | 1 tin tử tế mở cửa quay lại → LOST soft | trách khéo |
| 24 | Upsell sau chốt | BOOKED + gợi ý theo bảng mục 9 | "với mình, thêm X lợi Y" 1 lần | mời mua chay |
| 25 | Khách cũ quay lại | LOST/BOOKED nhắn lại | nhớ đúng lịch sử cũ, tiếp đúng mạch | chào như người lạ 🔒 |

(Thẻ 14–20 = OBJECTION; 21–23 = FOLLOW_UP; 24 = UPSELL; 25 = re-entry. ASK_PARTNER/BUSY cần intent `postpone` V2.)

---

## 12–13. MAPPING NGUỒN TRI THỨC — GIỮ / SỬA / BỎ (L12 + L13)

### Từ `sal.docx` (tài liệu 7 bước của chủ)
| Nội dung sách | Phán quyết | Vì sao / thành cái gì |
|---|---|---|
| 7 bước Greeting→Follow-up | **GIỮ ý, SỬA hình** | Bước tuyến tính → **state machine** (mục 2): khách nhảy cóc được, không ép đi 1→7 |
| Không báo giá bước 1–2 | **GIỮ** | = forbidden NEW_LEAD/DISCOVERY (đã trong playbook) |
| "Không lùi step" | **BỎ** | Ngược thực tế — khách quay lại hỏi mẫu sau báo giá là bình thường; thay bằng "không GREET/ASK_SERVICE lại" |
| Khai thác: dịch vụ/ngày/phong cách/ngân sách | **GIỮ + nâng** | thành slots V2 + UNKNOWN_VALID + luật 1-câu/lượt (sách chưa có) |
| Follow-up 24/48/72, max 3 | **GIỮ khung, SỬA ruột** | template tĩnh → content-by-reason (mục 8); tag lách 24h → BỎ, thay panel người-bấm-gửi |
| Luật cứng giá/tặng/giảm | **GIỮ** | = Validator 8 luật (đã chạy) |
| Delay 3–9s, chia 2–3 tin | **GIỮ** | đã có computeReplyDelayMs + chunks |
| 50 câu hỏi–đáp + kho tri thức | **GIỮ, đổi chỗ** | KHÔNG nhét prompt → Golden Set (test) + bảng FAQ (data) + thẻ (hành vi) |
| "1 module duy nhất" | **BỎ** | ngược nguyên tắc 3 lớp — một cục = mega-prompt, chính là bệnh cũ |

### Từ 5 skill thư viện (thay cho sách thương mại — không có trên máy)
- **sales-enablement** → khung objection 5 bước + 6 nhóm từ chối (mục 7), "mọi claim gắn kết quả", chốt có mốc thời gian (mục 9).
- **cold-email** → luật follow-up thêm-giá-trị-mới, tin tự đứng, tin chia tay (mục 8), giọng ngang hàng (mục 10).
- **marketing-psychology** → anchoring/Good-Better-Best, loss-aversion thật, reciprocity, foot-in-the-door, Rule of 7 (mục 7, 9).
- **pricing** → 3 gói + recommend 1, chê-đắt-là-lỗi-framing, phân biệt gói bằng thứ khách hiểu (mục 7, 9).
- **emails** → 1 tin 1 nhiệm vụ, nurture giá-trị-trước, chuỗi re-engagement 30–60 ngày (mục 8, 10).
- **BỎ** (không hợp chat 1-1 studio): cold-email phần B2B outbound, emails phần automation platform, mọi thứ về SaaS metrics.

---

## 14. LỘ TRÌNH TRIỂN KHAI (L14) — cho developer

Nền đã có sẵn ~70%: state machine 10 stage + detector + trí nhớ + validator + Scenario Manager + follow-up hạ tầng. V2 = 5 PR nhỏ, additive, flag OFF:

| PR | Nội dung | Chạm file | Rủi ro |
|---|---|---|---|
| **B1** | Slots V2: extractor style/location/headcount/budget/postpone/decision_maker + UNKNOWN_VALID chung + asked_questions keys mới | `sale-slots.ts` (mở rộng), `sale-thread-state.ts` (ghi slot — JSONB sẵn, không DDL) + unit test từng regex | 0 (flag state đang tắt) |
| **B2** | Objection detector 12 loại + ghi `S.objections[]` + 7 thẻ objection (14–20) seed | detector mới + seed | 0 |
| **B3** | Stage persist + BOOKED tự nhận (customer_id) + LOST + UPSELL + intent BUYING_SIGNAL bổ sung ("có hợp đồng", "thử váy", "còn trống") + golden cases | `sale-workflow.ts` additive | thấp |
| **B4** | Follow-up engine V2: `S.follow_up` + content-by-reason + hợp nhất reengage panel (nháp theo reason, người bấm gửi ngoài 24h) + log kết quả | scheduler + reengage | trung bình — cần chủ duyệt riêng phần TẮT tag lách 24h |
| **B5** | Thẻ 21–25 + luật giọng vào Brain Lab + Golden Set mở rộng ~40 case (objection/follow-up/upsell) | seed + docs | 0 |

Thứ tự bật thật (sau mỗi PR): sân test → shadow log → pilot PSID — đúng lộ trình 4 cờ của PR #145.

**KPI đo được** (log sẵn đường): % lượt đúng thẻ · repeated-question = 0 🔒 · % lead lấy được SĐT · % follow-up có phản hồi · % lead → BOOKED · lý do LOST top 3.

---

*Sales Brain V1 — 30/07/2026. Nguyên tắc số 1: đừng dạy Lulu thuộc lòng; hãy cho Lulu biết khách đang ở đâu và bước tốt nhất tiếp theo là gì.*
