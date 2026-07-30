# LULU CLEAN PIPELINE — KẾ HOẠCH **V2** (CHỜ CHỦ DUYỆT LẦN 2, CHƯA CODE)

> V2 ngày 30/07/2026 (V1 cùng ngày, commit `4f9b6d6`) · Nhánh: `feat/lulu-scenario-manager` · Trạng thái: **PLAN ONLY — KHÔNG code, KHÔNG migration, KHÔNG merge/deploy/Republish, KHÔNG bật production, KHÔNG tự chọn PSID khách thật.**
>
> **V2 khác V1 ở đâu:** chủ đã DUYỆT HƯỚNG kiến trúc + trả lời 5 câu (có điều kiện). V2 khoá cứng nguyên tắc (mục I), định nghĩa object `SaleDecision` (I.2), bảng ánh xạ bộ não 8,2K từng-nhóm-luật (II.1), tách fact fail-closed vs hội thoại graceful (II.2), luật ảnh 6 điều kiện (II.3), quy trình chọn PSID pilot từ tài khoản test (II.4), điều kiện bảng trace + chứng minh không tái dùng được bảng cũ (II.5), 7 PRODUCTION BLOCKER (mục III), mô hình trạng thái dữ liệu 6 mức (mục IV), định nghĩa shadow chính xác + tiêu chuẩn PASS định lượng (mục V), ma trận test 21 nhóm + cổng nghiệm thu (mục VI). Mục A–L của V1 giữ nguyên giá trị trừ chỗ V2 ghi đè — nơi nào mâu thuẫn thì **V2 thắng**.

---

# PHẦN I — NGUYÊN TẮC KIẾN TRÚC (KHOÁ CỨNG)

## I.1. Một đường quyết định duy nhất

```
CUSTOMER MESSAGE
  → INTENT              detectMessageSignals (sale-workflow.ts:297) + extractSlotsV2Patch + detectServiceIntentFromText
  → ACTIVE SERVICE      computeServiceTrail (sale-service-context.ts:23) + resolveGroupNameForService (sale-service-map.ts:101)
  → CONVERSATION STATE  getThreadState / simulateThreadStateFromHistory (sale-thread-state.ts:191/:406)
  → SCENARIO            resolveScenario (baseline = routeSaleAction + SALE_PLAYBOOK_V1, sale-scenario-resolver.ts:229)
  → REALTIME FACTS      loadKnowledge (MỚI, lib/sale-knowledge.ts) → getServicePricePreview/getEffectivePrice/…
  → RESPONSE PLAN       object SaleDecision (I.2) — do HỆ THỐNG lắp, không phải AI
  → AI NATURALIZER      callLlm (askClaudeForReply với prompt structured) — CHỈ diễn đạt SaleDecision
  → BUSINESS VALIDATOR  validateSaleReply (+ voiceCheck) qua finalizeSaleReply (sale-pipeline.ts:158)
  → FINAL RESPONSE      fb-inbox gửi (giữ nguyên hạ tầng ảnh/typing/bubble) → recordBotReply → TRACE
```

Bất biến (không PR nào được vi phạm):
- **BẢNG GIÁ REALTIME = sự thật** (service_groups/service_packages qua sale-pricing).
- **KỊCH BẢN LULU = bộ não sale duy nhất** (không tồn tại bộ luật sale thứ hai trong prompt hay Brain Lab).
- **CONTEXT/STATE = trí nhớ** (một nguồn: ThreadState; không suy song song bằng inferKnownIntent trong clean path).
- **AI = chỉ cách nói tự nhiên.** AI KHÔNG được: tự chọn lại dịch vụ, tự đổi action, tự thêm giá/gói/ưu đãi/business fact ngoài `allowedBusinessFacts`.
- **VALIDATOR = kiểm sự thật trước khi gửi** (fail-closed với business fact).
- **Brain Lab = dạy phong cách + quản lý câu override ĐÃ DUYỆT + sân test/X-quang pipeline** (không phải "chỉ style" theo nghĩa hẹp — xem II.1.b).
- **Messenger và Brain Lab gọi CHUNG một orchestrator** `runCleanSalePipeline()` (lib/sale-clean-pipeline.ts — PR-2 extract từ sale-brain-runner.ts:199-355). Không có đường thứ hai tự quyết hành vi.

## I.2. Object trung gian `SaleDecision` (hợp đồng dữ liệu trung tâm)

Định nghĩa trong `lib/sale-clean-pipeline.ts` (PR-2). AI chỉ được **diễn đạt** object này:

```ts
export type FactStatus = "never_asked" | "known" | "customer_unsure" | "declined" | "not_applicable" | "stale_needs_reconfirm"; // mục IV

export type SaleDecision = {
  // NHẬN ĐỊNH
  intent: string;                        // từ MessageSignals + action map (ASK_PRICE/ASK_SAMPLE/…, mục G V1)
  activeService: string | null;          // serviceKey đã khoá (vd "beauty")
  previousService: string | null;        // từ ServiceTrail / state.previous_service
  serviceSwitch: boolean;                // lượt này khách đổi dịch vụ?
  conversationState: ThreadState;        // snapshot state TRƯỚC lượt (kèm factStatus mục IV)
  scenario: { key: string | null; name: string | null; source: "scenario" | "engine_fallback" };
  action: SaleAction;                    // từ RouterDecision (sale-workflow.ts:36-50)

  // DỮ LIỆU
  factsNeeded: string[];                 // = RouterDecision.knowledgeNeeded (nhãn 'pricing:<svc>'…)
  resolvedFacts: PipelineFacts & { factsBlock: string };  // loadKnowledge trả về — NGUỒN DUY NHẤT AI được nói
  missingFacts: string[];                // fact cần mà không lấy được (→ II.2 graceful)
  selectedPackage: { code: string; name: string } | null;

  // CÁCH TRẢ LỜI
  responseMode: "llm" | "override_exact" | "override_learn" | "stitched" | "intent_line" | "safe";
  allowedBusinessFacts: string[];        // whitelist fact được phép xuất hiện (giá/gói/ưu đãi đã resolve)
  forbiddenBusinessFacts: string[];      // vd ["giá dịch vụ khác", "khuyến mãi (promoActive=false)", "xác nhận cọc", "hứa giữ lịch"]
  assetRequest: { kind: "sample" | "price_image" | "none"; intents: string[]; approved: boolean; reason: string }; // II.3
  fallbackLevel: 0 | 1 | 2 | 3;          // 0=LLM pass · 1=clarify · 2=facts+1 câu hỏi · 3=handoff
  handoffReason: string | null;          // null nếu fallbackLevel<3; bắt buộc thuộc danh sách điều kiện handoff (mục H V1 + II.2)
};
```

Ánh xạ hiện trạng: `intent/action/factsNeeded` ← `RouterDecision`; `scenario` ← `ScenarioResolveResult`; `resolvedFacts` ← `PipelineFacts` (mở rộng); `responseMode/fallbackLevel` ← `FinalizeResult.fallbackUsed` (nắn nhãn); `assetRequest` ← marker + cổng `selectSampleImages`. `allowed/forbiddenBusinessFacts` là TRƯỜNG MỚI — validator dùng làm input đối chiếu (II.2), prompt in ra thành 2 dòng lệnh ngắn.

---

# PHẦN II — TRẢ LỜI 5 QUYẾT ĐỊNH (THEO ĐIỀU KIỆN CHỦ CHỐT)

## II.1. Bộ não 8,2K: bỏ khỏi clean prompt — CÓ ĐIỀU KIỆN, kèm bảng ánh xạ đầy đủ

**Không xoá mù.** Bản active trong `lulu_brain_versions` = byte-identical `DEFAULT_BRAIN_RULES` (md5 đã đối chiếu, audit 30/07). ⚠ Trước khi thực thi PR-5 phải **export nội dung bản active trên PROD DB thật** và diff với seed — nếu chủ đã sửa não trên prod sau 14/07, phần sửa phải được ánh xạ bổ sung (việc này ghi ở "Điểm chờ quyết" G-2).

### Bảng ánh xạ TỪNG NHÓM LUẬT → lớp chịu trách nhiệm mới

| # | Nhóm luật trong não 8,2K (nguyên văn claude-sale.ts) | Dòng | Lớp mới chịu trách nhiệm | Cơ chế thay thế |
|---|---|---|---|---|
| 1 | Chọn đúng nhóm ảnh/link theo nhu cầu (beauty↛cưới, thuê đồ→trang thuê đồ, ý tưởng chỉ khi khách đòi concept lạ) | :109-114 | **Router/Scenario + Asset engine** | `intentPrimaryGroup`+`subcategoryAllows`+`imageToggleOn` (sale-samples — cổng CỨNG đã chạy prod) + `assetRequest` trong SaleDecision |
| 2 | "TUYỆT ĐỐI KHÔNG trộn nhóm ảnh" | :115 | **Validator/Asset** | Cổng cứng sale-samples (đã có) + `service_drift` validator; không cần câu prompt |
| 3 | Ưu tiên sản phẩm có thật, ý tưởng chỉ là gợi ý phụ | :114 | **Retrieval** | loadKnowledge chỉ nạp ideas khi intent=ASK_CONCEPT |
| 4 | Tối đa 2-3 link, link có tên, gửi xong hỏi gu | :116 | **Style/Naturalizer** | vào `buildStyleBlock` (khối 9 prompt mới) |
| 5 | Beauty chưa có ảnh phù hợp → không lấy album cưới thay | :117 | **Asset engine** | đã là code: `resolveGallerySamples` đúng nhóm, thiếu = không gửi (II.3) |
| 6 | VĂN PHONG NGƯỜI THẬT (không em-dash, câu ngắn, dạ/nha, không ép chốt) | :119-123 | **Style/Naturalizer** | `buildStyleBlock` (1 nơi duy nhất — hết lặp 3 chỗ) + strip em-dash đã có trong code (claude-sale.ts:392) |
| 7 | "Báo giá: trả lời ngắn, hỏi lại nhu cầu trước khi bung bảng giá dài" | :124 | **Router/Scenario** | action `ASK_SERVICE`/`ASK_DATE` vs `QUOTE_*` quyết định; câu chữ thuộc golden bước bao-gia |
| 8 | PRICE GATING: hỏi gu trước khi báo giá, danh sách nhóm phải gate, "khách hối thì báo luôn" | :128-140 | **Router/Scenario (SALE LOGIC)** | `routeSaleAction` :551-567 (hỏi giá chưa rõ nhóm → ASK_SERVICE; chưa hỏi ngày → ASK_DATE; hối giá → QUOTE_*) + thẻ Kịch bản tình huống "hoi-gia-chung-chung"; **golden bước bao-gia đã phủ 8 tình huống** |
| 9 | "Khi báo giá: hệ thống tự gửi HÌNH bảng giá trước nên lời NGẮN" | :141 | **CORE/MARKERS (giữ trong prompt)** | giữ nguyên văn trong khối `[MARKERS]` — phối hợp `<<PRICE_IMAGE>>` |
| 10 | "Hỏi giá chung chung KHÔNG phải lý do NEEDS_HUMAN" | :142 | **CORE SAFETY (giữ)** | vào `CORE_SAFETY_BLOCK` + điều kiện handoff (II.2) chặn bằng code |
| 11 | CONCEPT/SETUP LẠ → không hứa, `<<NEEDS_HUMAN>>` | :146-148 | **CORE SAFETY (giữ nguyên văn)** | `SPECIAL_CONCEPT_ESCALATION_RULE` giữ trong khối CORE — là 1 điều kiện handoff hợp lệ |
| 12 | PRICE_IMAGE_INSTRUCTION (marker mã gói) | :87 | **MARKERS (giữ nguyên văn)** | hằng số code, không lấy từ DB |
| 13 | SAMPLE: QUY TẮC VÀNG chỉ gửi khi khách hỏi/đồng ý; bước phân loại KHÔNG ảnh | :92-98 | **Asset engine (code) + MARKERS** | cổng đã là code (`selectSampleImages` 3 cổng :668-678); giữ phần dạy marker trong `[MARKERS]`; bỏ ví dụ hội thoại (~1,5K) → thành golden bước tu-van |
| 14 | Thuật ngữ "chụp cổng" ≠ "ngày cưới" | :97 | **Kịch bản (golden/guidance)** | thuộc cách nói của dịch vụ Chụp cổng — đưa vào guidance thẻ/golden của service đó |
| 15 | Danh sách 8 nhóm `<<SAMPLE: nhóm>>`, để trống = hệ thống tự suy | :99 | **MARKERS (giữ)** | giữ trong `[MARKERS]` |
| 16 | Khớp lời-với-ảnh ("chỉ nói gửi ảnh ở lượt có marker"), không gửi lại ảnh cũ, mỗi lượt 1 lần | :100-102 | **MARKERS (giữ) + Asset engine** | dedupe `extractRecentSampleUrls` đã là code; câu nhắc giữ trong MARKERS |
| 17 | Đúng giới tính (cool boy → mẫu nam, thiếu thì không gửi) | :104 | **Asset engine (code)** | đã enforce trong `resolveGallerySamples(gender)`; bỏ khỏi prompt |
| 18 | "Không tìm được ảnh đúng nhóm → đừng bịa" | :105 | **CORE SAFETY (giữ 1 dòng)** | gộp vào CORE + II.3 (retrieval ảnh lỗi → text ngắn) |

Tổng kết: **GIỮ trong prompt mới** ≈ 3,5K (nhóm 9-12-13-15-16 phần marker + 10-11-18 core safety). **Chuyển thành code/scenario/golden/style** ≈ 4,7K. Không nhóm luật nào "mất" — mỗi dòng có nơi ở mới.

### II.1.b. Câu admin dạy (matchResponseOverride) — KHÔNG được mất chức năng

Hiện trạng (audit): `matchResponseOverride` (sale-image-overrides.ts:244) chỉ có 1 caller = sale-brain-runner.ts:193 → **test thấy đúng, khách thật không nhận** (gap TEST↔PROD lớn nhất của cơ chế dạy).

Quyết định trong plan V2: **nối chính thức vào orchestrator chung** — vì Messenger và Brain Lab cùng gọi `runCleanSalePipeline`, override tự động chạy CẢ HAI nơi:
- Bước sau Resolve Scenario: `matchResponseOverride(message, priorContext, activeOverrides, {hasImage})`.
- `exact_reply` → `responseMode="override_exact"`: bỏ qua LLM, reply = câu admin, **VẪN đi qua validator** (câu dạy có giá sai/khác CRM hiện tại thì BLOCK + trace `override_blocked` để admin biết câu dạy đã lỗi thời — không gửi mù).
- `learn_from_this` → `responseMode="override_learn"`: câu admin được chèn như golden ưu tiên cao nhất (score đội lên trên), LLM diễn đạt lại.
- Đường dài hạn (PR-8+, tuỳ chủ): nút "Chuyển câu dạy thành Kịch bản" — promote override vào `lulu_sale_script_examples` qua `saveScripts` (source='manual') để về một mối; trong lúc đó 2 cơ chế cùng sống, override thắng vì cụ thể hơn.

**Brain Lab sau cleanup =** ① quản lý STYLE (xưng hô, độ dài, nhịp bubble); ② quản lý + duyệt response override (ảnh & chữ — chữ giờ chạy thật); ③ sân test & X-quang so sánh OLD vs CLEAN; ④ KHÔNG còn quyền sửa luật sale/giá/gói (các mục đó thuộc Kịch bản + Validator).

## II.2. DB không lấy được bảng giá: FAIL-CLOSED fact, GRACEFUL hội thoại

Hai tầng TÁCH BẠCH:

**(a) FACT FAIL-CLOSED (validator + retrieval):** khi `loadKnowledge` không lấy được giá (DB lỗi / dịch vụ chưa có nhóm):
- `resolvedFacts.crmPriceVnd = null`, `missingFacts += ["pricing:<svc>"]`, `catalogAuthoritative: true` giữ nguyên → **mọi con số tiền trong reply đều bị BLOCK** (price_unverifiable).
- CẤM tuyệt đối (enforce bằng validator + forbiddenBusinessFacts): đoán giá; lấy giá từ lịch sử chat (history KHÔNG nằm trong factCatalog); giá legacy `ai_service_scripts.priceContent` (engine GPT — không bao giờ là nguồn của clean path, xem Blocker #3); giá dịch vụ khác (catalog theo serviceKey — `validPricesFor`); tự bung toàn bộ bảng giá (loadKnowledge chỉ nạp nhóm active service).

**(b) HỘI THOẠI GRACEFUL (không sập, không auto-handoff):** "không có giá" ≠ "chuyển người". Thang xử lý khi missingFacts chứa pricing:
1. `fallbackLevel=2` — trả lời tự nhiên bằng template deterministic mới `FACT_UNAVAILABLE_LINE` (thêm vào `intentFallbackLine`): *"Dạ phần giá chính xác của [dịch vụ] em xin phép kiểm tra lại hệ thống để báo mình đúng nhất nha. Mình định chụp khoảng thời gian nào để em tư vấn luôn ạ?"* — nói rõ chưa lấy được mức giá + hỏi TỐI ĐA 1 câu hữu ích (theo `allowedQuestions`).
2. Chỉ lên `fallbackLevel=3` (handoff) khi rơi đúng điều kiện handoff chuẩn: khách yêu cầu người thật · nghiệp vụ cần quyền người (cọc/CK/khiếu nại/hủy dời) · dữ liệu bắt buộc không tồn tại **VÀ khách đã hối lần 2** (không trả lời được nữa mà không có số) · concept lạ (II.1 nhóm 11) · Router/Scenario ESCALATE_HUMAN.
3. Lỗi hạ tầng (exception giữa chừng): enforce-mode trả `SAFE_REPLY_LINE` + needsHuman + trace lỗi — **không im lặng, không sập hội thoại, không quay mega-prompt** (Blocker #7).

## II.3. Ảnh: FALLBACK KHÔNG GỬI ẢNH — 6 điều kiện gửi (enforce bằng code, không bằng prompt)

`assetRequest.approved = true` CHỈ khi **đủ cả 6**:
1. Khách yêu cầu ảnh (cổng explicit-request/consent — regex tại sale-samples.ts:668-677, gate check trong `selectSampleImages` khai báo :701) HOẶC scenario/action xác định cần gửi (`SEND_SAMPLE`/`SEND_PRICE`). **SIẾT so với hiện tại:** hiện gate 1 chấp nhận cả marker `<<SAMPLE>>` do AI tự đặt kể cả khi khách chưa yêu cầu; trong clean path, marker AI chỉ là "đề nghị" — không thoả điều kiện 1 thì không gửi.
2. `activeService` đã rõ (≠ null/unknown).
3. Asset map đúng activeService (`intentPrimaryGroup`/`subcategoryAllows` — cổng cứng hiện có).
4. Asset tồn tại thật (resolve trả ≥1 ảnh; ảnh giá: `resolvePriceImagesByCodes` trả hit).
5. Không service drift trong lượt (validator PASS service_drift).
6. `fallbackLevel === 0` (LLM pass) — **mọi lượt fallback 1/2/3 KHÔNG gửi ảnh** (giữ hành vi reply=null hiện tại, nay thành luật chính thức).

Retrieval ảnh lỗi → text ngắn ("Dạ em lọc thêm ảnh đúng gu cho mình nha") — **không gửi ảnh ngẫu nhiên**, không lấy nhóm khác thay (II.1 nhóm 5/17). StatePatch: lượt không gửi ảnh thì KHÔNG ghi `sent_assets`; lượt fallback KHÔNG ghi `quoted`.

## II.4. PSID pilot: KHÔNG khách thật — quy trình chọn từ tài khoản test

Bổ sung vào PR-7 (phần Brain Lab, read-only):
1. Endpoint mới `GET /api/lulu-brain/pilot-candidates` (admin): liệt kê ≤20 thread gần nhất có dấu hiệu TEST — lead name chứa "test"/nhân viên tự nhắn, hoặc thread do chủ chỉ định tay; MỖI DÒNG: tên hiển thị · thời điểm nhắn cuối · PSID che bớt (`1234…89`, 4 đầu 2 cuối) · số tin.
2. Panel trong Brain Lab "Chọn thread pilot": chủ tick đúng thread → hệ hiện hướng dẫn **chủ tự dán PSID đầy đủ vào Deployment env `LULU_CLEAN_PIPELINE_PSIDS`** (app không tự ghi env, không tự bật).
3. Ràng buộc cứng ghi trong code + doc: KHÔNG đưa lead có `ai_mode='active'` đang được sale chăm / lead có customer_id (đã chốt) vào danh sách candidates.
4. Thứ tự bắt buộc trước enforce bất kỳ PSID nào: sandbox sạch (mục VI) → shadow đạt PASS (mục V) → chủ chọn PSID test → enforce pilot chỉ PSID đó.

## II.5. Bảng `lulu_pipeline_traces`: ĐỒNG Ý CÓ ĐIỀU KIỆN — kèm chứng minh không tái dùng được bảng cũ

**Vì sao không dùng bảng/log hiện có (đối chiếu từng ứng viên):**
| Ứng viên | Vì sao không đủ |
|---|---|
| `fb_inbox_messages.ai_decision` | 1 chuỗi enum ngắn/tin (`claude_replied`…) — không chứa intent/service/scenario/facts/validator |
| `lulu_scenario_test_runs` | chỉ sandbox Kịch bản, gated LULU_SCENARIO_MANAGER_ENABLED, schema test (draft/expected) — không phải prod turn log |
| `lulu_brain_test_results` | kết quả test case Brain Lab, không phải hội thoại thật |
| `notifications` | kênh cảnh báo, có dedupe_key, không phải nơi ghi mỗi lượt |
| console log | không truy vấn được, mất khi restart, không đếm được tỷ lệ PASS shadow |
→ Không bảng nào đáp ứng → cần bảng mới.

**Điều kiện thiết kế (PR-8, làm ĐÚNG khuôn chống DROP #132):**
- Additive thuần: `CREATE TABLE IF NOT EXISTS` trong migrations.ts **+ khai drizzle** `lib/db/src/schema/lulu-brain.ts` cùng PR. Không DROP/rename bất kỳ thứ gì.
- Cột (tối giản, ưu tiên mã — hạn chế nguyên văn khách): `id, created_at, psid_hash (sha256, KHÔNG lưu PSID trần), mode('shadow'|'enforce'|'test'), intent, active_service, previous_service, service_switch bool, scenario_key, action, stage, facts_source text[] (mã nguồn fact: 'pricing:beauty'), selected_package_code, response_mode, fallback_level smallint, validator_verdict, violated_rule, blocked_reason_code, handoff_reason_code, latency_ms, message_excerpt varchar(120) NULL` — **message_excerpt mặc định NULL, chỉ ghi khi bật cờ debug riêng**; KHÔNG token/secret/URL ảnh/URL nhạy cảm; KHÔNG lưu reply nguyên văn (đã có fb_inbox_messages).
- Index: `(created_at DESC)`, `(psid_hash, created_at DESC)`, `(mode, validator_verdict)`.
- Retention: sweep lúc startup + mỗi 24h `DELETE WHERE created_at < now() - interval '30 days'` (30 ngày — chủ chỉnh được, xem G-4).
- Không chậm luồng gửi: ghi **fire-and-forget sau khi đã gửi tin** (`insert().catch(log)` — không await trên đường reply); lỗi ghi trace không được đụng tin nhắn (bọc catch riêng).
- Rollback = tắt cờ ngừng ghi; **không bao giờ xoá bảng trên production**.
- **Thời điểm tạo bảng: chuyển vào PR-7** (shadow CẦN bảng để ghi mode='shadow' và để tính tiêu chuẩn PASS V.2) — PR-8 chỉ còn phần Brain Lab so sánh/hợp nhất trace/AI_DRAFT_SYSTEM/promote (sửa mâu thuẫn thứ tự của bản nháp V2 đầu).

---

# PHẦN III — PRODUCTION BLOCKER (điều kiện CHẶN trước khi bật Messenger thật)

| # | Blocker | Hiện trạng (evidence audit) | PR xử lý | Dependency | Bắt buộc trước |
|---|---|---|---|---|---|
| B1 | **Webhook phải verify chữ ký Meta** `X-Hub-Signature-256` | webhook-facebook.ts:96 nhận body trần; grep createHmac trong file webhook = 0 (createHmac có ở auth.ts/autopost nhưng không dùng cho webhook này) | **PR-B1 (MỚI, độc lập)**: HMAC app-secret, sai chữ ký → 403 + log; cờ tắt-mở để không chặn nhầm khi chưa cấu hình secret | FB_APP_SECRET vào env | **ENFORCE pilot** |
| B2 | **2 tin nhanh = 2 lượt AI song song** (không lock/debounce) | fb-inbox.ts không có lock quanh handleClaudeSaleReply; PR #140 (pg advisory lock + debounce gộp tin) đang MỞ, cần rebase | **PR #140** (đã có, rebase lên main mới) — lock phải pg advisory (Replit autoscale nhiều instance, không dùng in-memory) | rebase #136-#137 chain | **ENFORCE pilot** |
| B3 | **Engine GPT legacy (giá nhập tay) không được là fallback của clean pipeline** | Thang fallback clean kết thúc ở SAFE_REPLY (sale-pipeline.ts:265-270) — KHÔNG có nhánh nào gọi ai-engine; enforce-mode lỗi → SAFE, không rơi mega-prompt (II.2.b.3) | PR-7 (spec + test khẳng định: grep ai-engine trong sale-clean-pipeline = 0) | — | ENFORCE pilot (test tự động) |
| B4 | **Nút "Gợi ý AI" inbox đang dùng giá text tay legacy** — nhân viên tưởng realtime | /fb-inbox/threads/:psid/suggest (fb-inbox.ts:1493-1521) → askChatGptForReply → buildStudioContext (ai-engine.ts, giá từ ai_service_scripts.priceContent); endpoint GET /fb-ai/service-context (fb-inbox.ts:1617) cũng dùng buildStudioContext | **PR-B2 (MỚI, nhỏ)**: phương án A (khuyến nghị) đổi suggest sang getSaleContext realtime; phương án B tối thiểu: badge đỏ "⚠ giá tham khảo — KIỂM TRA Bảng giá" trên FE + dòng cảnh báo trong text trả về — **chủ chọn A/B (G-5)** | — | **Trước khi đội sale dùng suggest thường xuyên** (không chặn enforce pilot vì là tính năng nhân viên, nhưng xếp cùng đợt) |
| B5 | **"Duyệt & gửi" trang chăm lại khoá Lulu vĩnh viễn** không đường bật lại | /threads/:psid/send (route :1523) luôn set ai_mode='takeover' (fb-inbox.ts:1544, vô điều kiện); trang reengage không có nút mở bot | **PR-B3 (MỚI, nhỏ)**: thêm nút "Mở lại Lulu cho khách này" trên trang chăm lại + tham số `keepAiMode` cho route send khi gửi từ reengage (mặc định giữ hành vi cũ) | — | Trước khi bật master switch chăm khách diện rộng |
| B6 | **Flag fail-closed; allowlist rỗng ≠ bật toàn bộ** | Khuôn scenario enforce đúng (rỗng = không ai, sale-scenario-types.ts:340); khuôn LULU_STATE NGƯỢC (rỗng = tất cả, sale-thread-state.ts:43) | PR-7: cờ clean theo khuôn scenario; **clean path đọc/ghi state theo `LULU_CLEAN_PIPELINE_PSIDS` của chính nó**, không dựa ngữ nghĩa LULU_STATE; thêm test unit khẳng định "env rỗng → isCleanPipelineEnabledFor luôn false" | — | ENFORCE pilot |
| B7 | **Clean pipeline lỗi → hành vi an toàn, không âm thầm quay mega-prompt** | Thiết kế V1 chưa ghi rõ | PR-7 spec: **shadow-mode lỗi → nuốt + log (legacy vẫn trả lời như cũ — đúng vì legacy là đường chính)**; **enforce-mode lỗi → SAFE_REPLY_LINE + needsHuman + trace `pipeline_error`, KHÔNG rơi về askClaudeForReply** (câu chưa qua validator không được gửi) | — | ENFORCE pilot |

---

# PHẦN IV — STATE: MÔ HÌNH TRẠNG THÁI DỮ LIỆU + QUY TẮC KHÔNG HỎI LẠI

## IV.1. 6 trạng thái cho MỖI fact (không chỉ known/unknown)

```ts
type FactStatus = "never_asked" | "known" | "customer_unsure" | "declined" | "not_applicable" | "stale_needs_reconfirm";
```
Lưu per-service trong `services_json` (cột ĐÃ CÓ, sale-thread-state.ts:168): `services_json[serviceKey].facts = { event_date: {status, value?, at}, style: {...}, headcount: {...}, budget: {...}, phone: {...} }`.

Ánh xạ hiện trạng: `date_status='known'` → known; `'not_decided'` → **customer_unsure — TRẠNG THÁI HỢP LỆ, không phải dữ liệu trống** (khách tham khảo chưa biết ngày vẫn được báo giá tham khảo `QUOTE_REFERENCE` — router đã làm đúng, V2 chỉ đặt tên chính thức); `UNKNOWN_VALID` của headcount → customer_unsure; refusal → declined; fact > 30 ngày không nhắc lại (vd ngày cưới đã qua) → stale_needs_reconfirm.

## IV.2. Quy tắc không-hỏi-lại (enforce 3 lớp, cùng ngữ cảnh dịch vụ)

1. **Router**: `computeForbiddenQuestions` mở rộng từ ask_date/ask_phone → thêm ask_style, ask_budget, ask_service (mỗi câu hỏi 1 lần khi fact ∈ {known, customer_unsure, declined}).
2. **Validator** `repeated_question`: mở rộng key tương ứng (hiện chỉ ask_date — sale-workflow-validator.ts:172 tự nhận "key khác chờ detector riêng"). Ghi chú chính xác hiện trạng: `computeForbiddenQuestions` hard-code riêng ask_date; ask_phone chỉ được phủ qua vòng generic "key nào hỏi ≥2 lần".
3. **Prompt** `[CONVERSATION STATE]`: in factStatus dạng lệnh: "ĐÃ BIẾT: ngày 15/8, gu Hàn Quốc. KHÁCH CHƯA QUYẾT: số người. ĐÃ TỪ CHỐI CHO: SĐT — không hỏi lại các mục này."
4. **customer_unsure với ngày**: vẫn báo giá tham khảo + câu định vị "giá em báo là tham khảo, có ngày cụ thể em xác nhận lịch + giá chính xác lại cho mình" (golden bước bao-gia).
5. **Đổi dịch vụ**: `serviceSwitch=true` → chuyển `current_service`, đẩy cũ vào `previous_service`, facts của dịch vụ cũ Ở YÊN trong `services_json[old]` (không nhiễm sang mới, không mất khi khách quay lại); slots dùng chung (ngày/SĐT) giữ nguyên; fact riêng dịch vụ (gu/gói đã báo) tách theo service. Sửa gốc COALESCE (sale-thread-state.ts:266) trong PR-6.

---

# PHẦN V — SHADOW MODE: ĐỊNH NGHĨA CHÍNH XÁC

## V.1. Chạy gì / không chạy gì

| Thành phần | Shadow có chạy? | Ghi chú |
|---|---|---|
| Understand + Resolve Service + State (ĐỌC) + resolveScenario + loadKnowledge + lắp SaleDecision + stitched/intent plan (deterministic) | ✅ | Toàn bộ DB-read, có cache |
| **AI Naturalizer (callLlm)** | ❌ `callLlm: null` | **Vì thế 0 chi phí LLM** — cú gọi LLM duy nhất của lượt vẫn là mega-prompt legacy như hiện tại |
| Validator | ✅ 2 lần | (a) chấm **legacy output** (câu mega-prompt SẮP gửi — đo "nếu validator đã bật thì hôm nay chặn bao nhiêu"); (b) chấm **clean plan** (câu stitched/intent deterministic) |
| Gửi tin/ảnh, typing | ❌ | Legacy gửi như cũ, shadow im tuyệt đối |
| Ghi state production | ❌ | Shadow đọc snapshot; applyIncomingMessage/recordBotReply vẫn thuộc luồng legacy như hiện tại |
| Takeover / booking / cọc / notification | ❌ | Không side-effect nào |
| Trace | ✅ | Ghi `lulu_pipeline_traces` mode='shadow' (fire-and-forget) + console `[CleanPipelineShadow]` |

So sánh legacy vs clean ghi trong trace mỗi lượt: `legacy_action_inferred?` không suy được đáng tin → so ở tầng đo được: (1) service legacy nói tới (detect từ output) vs `activeService` clean; (2) tiền trong legacy output (`extractMoneyVnd`) ∈ catalog clean?; (3) validator verdict trên legacy output; (4) clean fallbackLevel dự kiến. Lỗi shadow → nuốt + log, legacy không bị ảnh hưởng (B7).

## V.2. Tiêu chuẩn PASS định lượng (điều kiện sang pilot enforce — không phải "chạy 1 tuần" suông)

Trên tối thiểu **200 lượt khách thật** (hoặc 14 ngày, lấy mốc đến trước):
1. **0 crash** ảnh hưởng luồng legacy (0 tin nhắn mất/chậm do shadow; p95 overhead shadow < 150ms).
2. **100% lượt có trace đủ trường** (intent/service/action/facts_source/validator).
3. **Service accuracy ≥ 95%**: chấm tay mẫu 50 lượt — activeService clean khớp dịch vụ thật khách đang hỏi.
4. **Validator false-block < 5%** trên mẫu 50 câu legacy mà người chấm cho là ĐÚNG (đo chặn oan trước khi cho validator cầm quyền).
5. **0 lượt clean plan chứa giá ngoài catalog** (đếm tự động từ trace).
6. Báo cáo tổng hợp gửi chủ: phân bố intent/action/fallbackLevel + top blocked reason → **chủ đọc và duyệt bằng chữ** rồi mới chọn PSID pilot (II.4).

---

# PHẦN VI — MA TRẬN TEST + CỔNG NGHIỆM THU

## VI.1. Ma trận coverage (≥100 hội thoại multi-turn, mỗi ô ≥3 hội thoại trừ khi ghi khác)

| # | Nhóm | Điểm phải chứng minh |
|---|---|---|
| 1 | Service unknown (chưa rõ dịch vụ) | clarify Level 1, không đoán, không safe-handoff |
| 2 | Album cưới | đúng giá/gói album |
| 3 | Chụp cổng | Basic/Premium/Luxury đúng từng gói |
| 4 | Tiệc cưới | phân nhánh nhà/nhà hàng, 1 máy/2 máy |
| 5 | Beauty/thời trang | 0 nhiễm cưới (regression bug cũ) |
| 6 | Thuê trang phục | dịch vụ chưa có nhóm giá → graceful II.2, không lấy giá nhóm khác |
| 7 | Hỏi giá CÓ ngày | QUOTE_EXACT + giá đúng |
| 8 | Hỏi giá CHƯA có ngày / "tham khảo thôi" | QUOTE_REFERENCE — customer_unsure vẫn báo giá tham khảo, KHÔNG ép hỏi ngày lại |
| 9 | Hỏi gói gồm gì | package content tự nhiên, không database-voice |
| 10 | Xem ảnh | 6 điều kiện II.3; đúng nhóm, đúng giới tính |
| 11 | Chê mắc | HANDLE_OBJECTION, không tự giảm |
| 12 | Xin giảm | chuyển phụ trách đúng điều kiện, không hứa |
| 13 | Chốt gói | selectedPackage đúng, mời giữ lịch |
| 14 | Giữ lịch/cọc | không xác nhận cọc, không đưa STK, handoff hợp lệ |
| 15 | Đổi dịch vụ giữa chừng (cả 2 chiều + quay lại) | serviceSwitch đúng, facts cũ không nhiễm, quay lại không hỏi lại |
| 16 | Câu cực ngắn "ừ" / "vậy hả" / "bao nhiêu" / "gửi xem" | bám ngữ cảnh, không reset |
| 17 | Khách nhắn 2 tin liên tiếp | (unit + integration với lock #140) 1 câu trả lời gộp, không trả lời chồng |
| 18 | DB giá lỗi (mock reject) | II.2: fail-closed fact + graceful text, 0 số tiền lọt |
| 19 | Asset lỗi (mock ảnh rỗng) | text ngắn, không ảnh ngẫu nhiên |
| 20 | Validator chặn → regenerate → fallback 3 tầng | đủ 3 level, thứ tự đúng |
| 21 | Handoff: hợp lệ (đủ 5 điều kiện II.2.b.2) + SAI điều kiện (hỏi giá chung chung, câu lạ vô hại) | có handoff đúng · 0 handoff sai |

## VI.2. Trace bắt buộc mỗi lượt test

`input → intent → service → state-before → scenario → facts(source) → response-plan(SaleDecision) → output → validator → fallbackLevel → state-after`. Hiện trạng chính xác: `runScenarioTest` (lulu-scenarios.ts:493) đã trả `stateAfter` + validator/verdict nhưng CHƯA trả `PipelineTrace` (type đó chỉ do `simulateReply` dựng); `SaleDecision` là type MỚI (PR-2). PR-8 hợp nhất: cả 2 sân test trả cùng bộ `PipelineTrace + SaleDecision + stateAfter`, xuất JSON per-turn vào báo cáo nghiệm thu.

## VI.3. Cổng BẮT BUỘC trước pilot (điều kiện ĐỦ, thiếu 1 = không sang pilot)

- 0 câu sai giá · 0 bịa business fact · 0 cross-service contamination · 0 hỏi lại fact ∈ {known, customer_unsure, declined} · 0 gửi ảnh sai dịch vụ · 0 handoff ngoài điều kiện — trên TOÀN BỘ ma trận VI.1.
- Flags OFF = Messenger nguyên trạng: `routes/fb-inbox.test.ts` (22 test) + golden 116 + convo suite xanh, diff hành vi = 0.
- `pnpm typecheck` (BE+FE baseline) · `vitest run` BE+FE · `node scripts/deploy-guard.mjs` · build api (kèm check-duplicate-functions) — tất cả sạch.
- Shadow PASS định lượng (V.2) + chủ duyệt báo cáo shadow bằng chữ.

---

# PHẦN CŨ V1 GIỮ NGUYÊN (đã duyệt hướng)

Mục A (production path), B (module giữ), C (deprecate — bổ sung: mọi mục deprecate của não 8,2K nay theo bảng ánh xạ II.1), D (xung đột bỏ), E (pipeline 10 bước — nay output là `SaleDecision` I.2), F (prompt stack — khối 2 MARKERS lấy nguyên văn theo II.1 nhóm 9/12/13/15/16), G (retrieval theo intent), H (fallback — nay gắn nhãn `fallbackLevel` 1/2/3 + FACT_UNAVAILABLE_LINE II.2), I (validator — bổ sung input `allowed/forbiddenBusinessFacts`), J (8 PR + cờ), K (test — nay theo ma trận VI), L (rollback). Xem lịch sử git `4f9b6d6` cho toàn văn V1.

**Cập nhật danh sách PR (V2):** 8 PR cũ + **PR-B1** (webhook signature) + **PR-B2** (Gợi ý AI giá realtime/badge) + **PR-B3** (mở lại bot trang chăm lại) + **PR #140** (lock, đã mở — rebase). Phân công lại theo II.5: **PR-7 = shadow + bảng `lulu_pipeline_traces`** (shadow cần bảng để ghi và để chấm PASS V.2); **PR-8 = Brain Lab so sánh OLD vs CLEAN + hợp nhất trace claude-sale-test + sửa AI_DRAFT_SYSTEM + nút promote override→Kịch bản**. Thứ tự khuyến nghị: PR-2 → PR-3 → PR-4 → PR-5 → PR-6 → **PR-B1 + #140 (song song, blocker)** → **PR-7 (shadow + trace table)** → [shadow PASS V.2 + chủ duyệt] → PR-8 + PR-B2/B3 → [chủ chọn PSID test II.4] → enforce pilot.

---

# ĐIỂM CÒN CHỜ CHỦ QUYẾT (G)

1. **G-1** Duyệt bảng ánh xạ não 8,2K (II.1) — đặc biệt **8 nhóm GIỮ trong prompt** (9/10/11/12/13/15/16/18) đã đủ chưa, có nhóm nào chủ muốn giữ thêm nguyên văn? (Lưu ý: bảng không có nhóm nào thuộc lớp "State" vì não 8,2K không chứa luật trí nhớ — luật "đã biết không hỏi lại" nằm ở antiDriftBlock NGOÀI não, đã ánh xạ về State/Validator ở mục D V1.)
2. **G-2** Cho phép em (hoặc chủ tự chạy) **1 câu SELECT read-only trên PROD DB** lấy `prompt_content` bản active để diff với seed trước PR-5 (nếu chủ đã từng sửa não trên prod thì phần sửa cần ánh xạ bổ sung). Nếu chưa tiện, PR-5 sẽ ship với giả định seed + guard runtime (nếu bản active ≠ seed → clean path log cảnh báo).
3. **G-3** Câu admin dạy: đồng ý cơ chế II.1.b (override chạy thật trong clean path, exact_reply vẫn qua validator)? Và có muốn nút "promote thành Kịch bản" ở PR-8?
4. **G-4** Retention trace 30 ngày — OK hay chủ muốn số khác?
5. **G-5** Blocker B4 "Gợi ý AI": chọn phương án A (đổi hẳn sang giá realtime) hay B (chỉ gắn nhãn cảnh báo)?
6. **G-6** Sau khi chủ duyệt V2: cho phép bắt đầu **PR-2** (tách orchestrator, thuần refactor, flag OFF, zero hành vi đổi)?
7. **G-7** Xác nhận 2 blocker KHÔNG gắn cổng enforce-pilot: B4 (Gợi ý AI — tính năng nhân viên, xếp cùng đợt PR-8) và B5 (chăm lại — chỉ bắt buộc trước khi bật master switch diện rộng). Nếu chủ muốn CẢ 7 blocker đều chặn enforce thì em nâng B4/B5 lên bắt buộc.
8. **G-8** Đề bài ghi object "tối thiểu 18 field" — danh sách chủ liệt kê và SaleDecision trong plan đều là **17 field** (đủ 17/17 tên chủ nêu; field lồng `resolvedFacts.factsBlock` có thể tính là thứ 18). Chủ xác nhận danh sách hiện tại là đủ, hay còn field thứ 18 chủ định thêm?

**Cam kết phạm vi:** KHÔNG merge · KHÔNG deploy · KHÔNG Republish · KHÔNG bật Messenger · KHÔNG migration · KHÔNG tự chọn PSID khách thật · mọi PR chờ duyệt từng cái.
