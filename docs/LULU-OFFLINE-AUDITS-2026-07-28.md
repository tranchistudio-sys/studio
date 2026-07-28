# AUDIT OFFLINE TỔNG HỢP — 28/07/2026 (chỉ report, không tự bịa, không đổi prod)

> Mọi nhận định dưới đây đã xác minh bằng đọc code/grep trong phiên (citation file:dòng
> nằm ở các PR/memory tương ứng). Format knowledge: SOURCE / SOT / USED_BY / PROBLEM / FIX.

## 1. KNOWLEDGE AUDIT (nguồn sự thật Lulu đang dùng)

| SOURCE | SOURCE_OF_TRUTH | USED_BY | PROBLEM | FIX ĐỀ XUẤT |
|---|---|---|---|---|
| Bảng giá + ưu đãi | `service_groups/service_packages` (admin Pricing) | getSaleContext (lọc whitelist/denylist/dedupe, cache 5' + clear khi sửa giá) | ✅ tốt nhất hệ; NHƯNG mô tả gói bị **cắt 240 ký tự** (cleanDesc) trong khi prompt bắt "gửi NGUYÊN thành phần" | bỏ/tăng slice; hoặc knowledge package_detail theo action |
| Ảnh bảng giá nhóm | `service_groups.ai_image_url` + `public_for_customer` | resolvePriceImagesByCodes | nhóm chưa bật public → khách không nhận gì mà bot nói "em gửi bảng giá" (đã vá phần state ở #137; nội dung ảnh vẫn do admin) | checklist admin: nhóm nào thiếu ai_image_url |
| Album/mẫu | `gallery_albums/gallery_photos` + tags | sale-samples + context links | dedupe ảnh đã gửi chỉ hiệu lực 20 tin (history LIMIT) — sent_assets (#135) là nền fix, chưa có consumer | consumer sent_assets ở Đợt sau |
| Váy/đồ thuê | `dresses` | sale-samples rental | ok | — |
| Ý tưởng concept | `photo_ideas` | chỉ nạp khi wantsNewConcept ✅ | trang khóa mật khẩu → không link công khai (by design) | — |
| Makeup/quay phim | nằm trong bảng giá (MK-, QP-) | context giá | không có mô tả dịch vụ riêng → ANSWER_FAQ services thiếu nguồn | gộp vào FAQ layer |
| **FAQ: địa chỉ/giờ/giao ảnh/thanh toán** | **KHÔNG TỒN TẠI** | Router đã trả `knowledgeNeeded: faq:*` | Lulu né/bịa/escalate; nhánh `lulu-address-wt` chưa merge chứng tỏ đã từng thiếu địa chỉ | **FAQ layer bên dưới — chờ MISSING_OWNER_DATA** |
| Chính sách/SOP cọc-hoàn-dời | 2 dòng cứng trong context | prompt | quá mỏng, không máy-đọc | SOP layer |
| Playbook giọng | `sale_playbooks` (active) | styleGuide | ✅ (drift deploy đã vá #135) | — |
| Não luật | `lulu_brain_versions` | brainRules | ✅ version + marker guard | Đợt sau: chỉ còn tune GIỌNG |
| Q&A cũ | `ai_script_qa_rows` | **KHÔNG AI DÙNG** (bot chết) — admin trả lời "câu hỏi lạ" đang **dạy bot đã tắt** | migrate nội dung tốt sang FAQ layer rồi deprecate |

### FAQ/SOP layer — THIẾT KẾ (chưa migration, chờ dữ liệu chủ)
3 loại TÁCH BẠCH, không trộn vào prompt: **FAQ** (Q→A) · **SOP** (quy trình bước) · **Business Rule** (đã nằm trong Router/Validator — code, không phải data).
```ts
// đề xuất bảng lulu_faq (CHƯA tạo — sẽ theo đúng quy trình #132 khi có dữ liệu)
{ id, kind: "faq"|"sop", topic: "address"|"hours"|"delivery"|"payment"|"services"|..., 
  question, answer, status: "active"|"draft", updated_by, updated_at }
```
Seed hiện tại = `MISSING_OWNER_DATA` (WAITING_FOR_OWNER #8): địa chỉ, giờ mở cửa, thời gian giao ảnh, quy trình cọc/hoàn/dời, makeup/quay phim có gì.

## 2. AUTOPOST V2 (hiện trạng đã audit từ code autopost-*)
Hiện tại: pool ảnh (app/web/Drive) → AI caption (style samples + brand footer + signature) → admin duyệt → scheduler đăng (DRY_RUN mặc định bật). **Thiếu toàn bộ tầng chiến lược**: không Content Goal/Pillar/Audience/CTA/campaign/tracking/feedback — và bottleneck NGƯỜI DUYỆT (78 bài kẹt pending_review từng giết reach).

**V2 pipeline đề xuất** (schema thêm cột vào `autopost_posts` + bảng `autopost_pillars`, `autopost_metrics` — chưa tạo):
`BUSINESS_GOAL (booking dịch vụ X, mùa Y) → PILLAR (showcase/social-proof/edu/promo/BTS) → AUDIENCE → ASSET (pool + tránh lặp qua signature sẵn có) → HOOK 3s + CAPTION + CTA (inbox/Zalo/đặt lịch — gắn ref để đo) → REVIEW RULE (tự-duyệt pillar an toàn sau N ngày kẹt / nhắc admin — trị bottleneck) → SCHEDULE → POST → COLLECT (Graph insights: reach/comment/message tap) → LEARN (pillar nào ra inbox → ưu tiên) → NEXT`.
Đo "bài nào tạo inbox": Meta `referral` trong webhook (PR-D đã nhận postback+ref ✓ nền tảng sẵn) → map post_id ↔ thread. MISSING_OWNER_DATA: pillar + goal (WAITING #10).

## 3. META PIXEL + CAPI (audit thật)
- **Website hiện KHÔNG có Pixel/GTM** (grep fbq/connect.facebook.net/gtag toàn FE = 0) → không duplicate, làm mới từ đầu, sạch.
- Kế hoạch: Pixel base (PageView) + event chuẩn: ViewContent (trang gói/album, content_ids=mã gói), Lead (form/để SĐT), Contact (ClickMessenger/ClickZalo/ClickPhone — gắn từ các nút FE hiện có), Schedule (đặt lịch), Purchase/Deposit (server-side).
- **CAPI khả thi tốt**: backend Express sẵn; event server-side từ chính các mốc Lulu/CRM (phone_captured → Lead; deposit → Purchase) với `event_id` chung browser/server để dedupe; hash SHA-256 SĐT/email (cần chủ duyệt privacy — WAITING #10).
- Data flow: `Ads → Website(Pixel) / Messenger(ref) → CAPI → crm_leads → Lulu state → payments(cọc) → revenue engine`.
- CHƯA gắn gì lên production — cần Pixel ID + quyền Ads từ chủ.

## 4. CRM / ADS ATTRIBUTION (field-level, ưu tiên field CÓ SẴN)
Chuỗi cần nối: `ad_id → khách → tư vấn → gói báo → cọc → doanh thu`.
- ĐÃ CÓ: `crm_leads` (facebook_user_id, source, customer_id) · `claude_sale_lead_flags` (phone/appointment) · `lulu_thread_state` (#135: quoted_packages!) · `customers→bookings→payments` (revenue engine chuẩn #87-#98).
- THIẾU đúng 2 mảnh: (1) **nguồn quảng cáo trên lead**: `crm_leads` chưa lưu `referral.ad_id/ref` — webhook postback (PR-D) đã nhận payload/ref, chỉ cần cột `ad_ref` (DDL nhỏ, Đợt sau); (2) **mốc thời gian phễu**: dùng notifications/flags timestamps tạm, về sau chuẩn hóa vào thread_state.
- Metrics dựng được NGAY khi có ad_ref: Cost/Conversation → Cost/Qualified (phone∪appointment) → Cost/Deposit (join payments qua customer_id) → Lead→Deposit rate → AOV → ROAS (khi có spend import).
- Lulu KPI (đã đo được từ ai_decision + validator): Repeated-Question, Escalation rate, Wrong-Price (validator BLOCK price_mismatch), Validator Block rate, Response time (log latency có sẵn `[AI] ... OK (ms)`).

## 5. FOLLOW-UP AUDIT (từ code follow-up-scheduler + thực trạng)
- Gate: ENABLE_AI_FOLLOWUP (boot) + master + opt-out + ai_mode=active + chưa chốt (customer_id null) ✅ điều kiện STOP cho: đã cọc ✓ (customer_id), từ chối ✓ (is_opted_out), takeover ✓ (ai_mode), có người rep tay ✓ (manual outbound check).
- 🔴 RỦI RO: tag `CONFIRMED_EVENT_UPDATE` sai policy Meta cho tin sale ngoài 24h (WAITING #7 — xác nhận flag prod). 🔴 hold-followup-scheduler: file UNTRACKED, import hỏng, không ai gọi = tính năng chết.
- V1 đề xuất (CHƯA bật): follow-up như một ACTION của Router (nurture stage WAITING/CONSIDERING) thay vì scheduler tách rời; trong 24h dùng RESPONSE, ngoài 24h chỉ khi khách opt-in message tag hợp lệ / chuyển kênh người thật.

## 6. OBSERVABILITY SPEC (chuẩn log 1 dòng/lượt — nền đã có 3 dòng [LuluState])
`{turn_id (= myMsgId #140), psid, mid, stage, router_action, reason, knowledge_used, validator: PASS|rule, provider, latency_ms, send: ok|partial|fail, superseded|lock_timeout}` — ghép từ: [LuluState][in]/[out]/[decision] (#136) + [AI] provider log (có sẵn) + ai_decision. Việc còn lại: gom về 1 dòng JSON chuẩn khi nối Router thật. KHÔNG log nội dung tin đầy đủ (cắt 80 ký tự như hiện tại).

## 7. FAILURE MATRIX (hành vi hiện tại đã xác minh + test đã có)
| Sự cố | Hành vi | Đã test |
|---|---|---|
| DB state down | fail-open, bot chạy như cũ | unit (#135) + isSuperseded(null) (#140) |
| Catalog 0 gói hợp lệ | getSaleContext THROW → claude_error (⚠️ nên hạ thành fallback text — backlog nhỏ) | đọc code |
| Claude timeout | orchestrator fallback OpenAI; hết chuỗi → câu chuyển nhân viên + escalation | có test orchestrator? (logic đọc xác minh) |
| Fallback fail hết | ALL_FAILED → escalate, không im lặng ✅ | code |
| Webhook duplicate | mid unique + pseudo-mid (PR-D) | unit ✓ |
| 3 tin đồng thời | debounce+lock (PR-C) — unit mock ✓, **concurrency thật = mức 3-4 chưa kiểm** | unit ✓/pilot ✗ |
| Send fail giữa chừng | tiếp tục chunk sau, ai_decision failed; state không ghi sai (đã vá #137) | code |
| Master off / takeover | im + (PR-B) notify | unit key ✓ |
| Validator BLOCK | **chưa nối prod** — BLOCK không bao giờ tới khách khi nối (thiết kế) | unit ✓ |

## 8. processSaleTurn() — AUDIT + DESIGN + TEST PLAN (KHÔNG refactor bây giờ)
3 call-site nhân bản: `fb-inbox.handleClaudeSaleReply` (đầy đủ nhất: state/lock/notify/send/human-review) · `claude-sale-test` (sim state + trace, không side-effect) · `sale-brain-runner` (test case Brain Lab, chưa có state).
**Design**: `processSaleTurn(input: {message, history, state, mode: "live"|"bench"|"brainlab"}, ports: {sendText, sendImages, persistState, notify, humanReview})` — core thuần quyết định *(context, decision, reply, validator, stateDelta)*; ports là adapter từng mode (live = FB + DB; bench = collect-only). **Test plan equivalence**: chạy 104 golden qua core mới vs pipeline bench hiện tại — decision/state PHẢI identical 100% trước khi cắm live. **Thứ tự tách helper an toàn**: (1) context-builder (đang copy 3 nơi) → (2) post-reply asset pipeline → (3) core turn. CHỜ pilot xong mới làm (đúng lệnh).

## 9. DEAD CODE / LEGACY (report — KHÔNG tự xóa)
| Item | Phán quyết đề xuất |
|---|---|
| fb-inbox.ts:543-748 bot ChatGPT cũ sau `return` | DELETE_LATER (sau khi Router live ổn) |
| routes ai.ts / ai-scripts.ts / ai-test.ts + ai_script_qa_rows/ai_unknown_questions | MIGRATE (Q&A tốt → FAQ layer) rồi DEPRECATE |
| hold-followup-scheduler.ts (untracked, import hỏng, không ai gọi) | DELETE_LATER hoặc sửa thành action Router |
| LEGACY_FB_BOT_ENABLED (vô tác dụng vì return trước) | DELETE_LATER |
| connectMessenger / connectClaudeTest / connectZalo (decorative) | DEPRECATE khỏi UI settings |
| GET /lulu-human-reviews/count-open (FE không gọi) | KEEP (nối badge FE — việc nhỏ đáng làm) |
| test-follow-up-scheduler (dev-only) | KEEP |

## 10. WEBHOOK SECURITY — KẾ HOẠCH RIÊNG (không trộn PR đang chạy)
1. X-Hub-Signature-256: cần `express.raw` cho riêng /api/webhook/facebook TRƯỚC express.json (app.ts) + verify HMAC với App Secret → PR riêng vì đụng middleware toàn cục; fail = 403 + log.
2. GET verification: bỏ nhánh `!verifyToken ||` (pass vô điều kiện khi chưa cấu hình) — 1 dòng, gộp vào PR trên.
3. Rate-limit /webhook (chống flood khi lộ URL) — cân nhắc.
