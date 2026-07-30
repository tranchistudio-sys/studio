# LULU CLEAN PIPELINE — KẾ HOẠCH (CHỜ CHỦ DUYỆT, CHƯA CODE)

> Ngày lập: 30/07/2026 · Nhánh: `feat/lulu-scenario-manager` · Trạng thái: **PLAN ONLY**
> Nguồn: audit toàn hệ Facebook & Sale 30/07 (8 agent + 2 verifier) + inventory 6 mảng (chữ ký hàm, file:line đã xác minh trên HEAD `efec9e3`).
> Nguyên tắc: KHÔNG rebuild. GIỮ phần tốt. LOẠI quyền quyết định trùng lặp. Mọi thay đổi nằm sau cờ `LULU_CLEAN_PIPELINE_*`, legacy giữ nguyên làm rollback.

---

## A. PRODUCTION PATH HIỆN TẠI (đã audit, tóm tắt để đối chiếu)

```
Meta POST /api/webhook/facebook          webhook-facebook.ts:96   (không verify chữ ký)
  → processIncomingFacebookMessage       fb-inbox.ts:415          (dedupe mid)
  → applyIncomingMessage (state, flag)   fb-inbox.ts:539          (LULU_STATE_* OFF)
  → GATE: getMasterEnabled() + ai_mode   fb-inbox.ts:547-549
  → handleClaudeSaleReply                fb-inbox.ts:776
      context = getSaleContext()  ~19,5K fb-inbox.ts:820          (nạp mù toàn bộ)
      + ideas/vision/state/scenario      fb-inbox.ts:822-884      (2 khối cuối flag OFF)
      → askClaudeForReply                claude-sale.ts:303
          buildSystemPrompt ~38K         claude-sale.ts:168       (mega-prompt, 1 cú gọi LLM)
          → callChat (claude→openai)     ai-orchestrator.ts:149
          → parse 4 marker + tách bubble claude-sale.ts:356-393
      → escalation gate (3 nguồn)        fb-inbox.ts:914-955      (hậu kiểm DUY NHẤT)
      → gửi ảnh mẫu → ảnh giá → text     fb-inbox.ts:964-1096     (Graph v22.0)
      → recordBotReply (flag OFF)        fb-inbox.ts:1073
```

**Sự thật quyết định thiết kế:** `fb-inbox.ts` KHÔNG import `sale-pipeline` / `sale-workflow-validator` / `sale-script-library` (grep = 0). Toàn bộ Understand → Route → Retrieve → Validate → Fallback đã tồn tại nhưng chỉ chạy trong `sale-brain-runner.ts` (Brain Lab, cờ `LULU_BRAIN_STRUCTURED_ENABLED`).

**2 xung đột phải xử trước khi nói chuyện "khôn":**
1. `claude_sale_settings.config→saleSteps[3]` (B4 "KHÔNG hỏi ngược, gửi ngay các gói" — seed `DEFAULT_SALE_STEPS` sale-settings.ts:97) ⟂ `PRICE_GATING_RULE` (claude-sale.ts:128 "ghi đè mọi bước Báo giá… TUYỆT ĐỐI KHÔNG bung bảng giá") ⟂ `antiDriftBlock` (sale-conversation-discipline.ts:115 tự nhận "không được phá kể cả khi luật ở trên nói khác"). Ba khối cùng vào 1 prompt, trọng tài là văn xuôi.
2. Hai bộ suy dịch vụ song song: `inferKnownIntent` (discipline.ts:72, prompt prod) vs `ThreadState.serviceIntent`/`resolveScenario` (hệ mới). Có thể khoá 2 nhóm khác nhau trong cùng 1 lượt.

---

## B. MODULE GIỮ (reuse — đây là 70% pipeline sạch, ĐÃ CÓ SẴN)

| Module | File:line | Vai trò trong pipeline mới | Ghi chú |
|---|---|---|---|
| `finalizeSaleReply` | sale-pipeline.ts:158 | Generate→Validate→Regenerate(1)→Fallback ladder | Giữ nguyên thang: LLM → gate kép (validator+voiceCheck) → tái sinh 1 lần → intent-first → blind-golden → stitched → intent → SAFE+needsHuman |
| `intentFallbackLine` / `SAFE_REPLY_LINE` / `tryStitch` | sale-pipeline.ts:67/:124/:138 | Fallback Level 1–2 deterministic | `tryStitch` cần export để test trực tiếp |
| `routeSaleAction` + `SALE_PLAYBOOK_V1` + `enforcePlaybook` + `computeForbiddenQuestions` | sale-workflow.ts:389/:90/:378/:364 | Rule engine "bước tiếp theo" (11 stage / 14 action) | Deterministic, không DB/AI |
| `detectMessageSignals` | sale-workflow.ts:297 | Understand (1 nguồn tín hiệu) | Điểm mở rộng intent mới |
| `resolveScenario` + `buildScenarioGuidanceBlock` | sale-scenario-resolver.ts:229/:310 | Sale Scenario = sale brain duy nhất (overlay trên Router, fail-open) | `baseline` vs `decision` sẵn khung so sánh |
| `getGoldenExamples` + `buildGoldenExamplesBlock` | sale-script-library.ts:307/:381 | Kịch bản service-first (tier 100/50/kw) | 3.609 golden cuối cùng được dùng thật |
| `validateSaleReply` + `extractMoneyVnd` | sale-workflow-validator.ts:159/:103 | Fact Validator | Sửa theo mục I |
| `checkDatabaseVoice` + `naturalizePackageContent` | sale-content-naturalizer.ts:74/:60 | Voice gate + fact tự nhiên | Đã tách đúng khỏi validator |
| `getServicePricePreview` / `getEffectivePrice` / `validPricesFor` / `matchedGroupNamesForService` / `auditPackages` | sale-pricing.ts:92/:145/:160/:134, sale-context.ts:129 | Retrieve FACT giá theo dịch vụ | `validPricesFor` hiện 0 caller runtime — sẽ thành nguồn catalog validator |
| `resolveGroupNameForService` / `listServiceMap` | sale-service-map.ts:101/:85 | Resolve Service → nhóm giá CRM | null = dịch vụ chưa có nhóm (không đoán) |
| `computeServiceTrail` | sale-service-context.ts:23 | Phát hiện đổi/quay lại dịch vụ | Sẽ nối vào State (hiện chỉ trace) |
| ThreadState + `applyIncomingMessage`/`recordBotReply`/`getThreadState`/`simulateThreadStateFromHistory` | sale-thread-state.ts:77/:232/:344/:191/:406 | Conversation State | DDL đã có sẵn 3 cột `current_service/previous_service/services_json` (:166-168) chưa ai đọc/ghi |
| `selectSampleImages` + họ resolve* | sale-samples.ts:701 | Retrieve ảnh mẫu | Entry dùng chung Test+Messenger |
| `getScheduleContext` | sale-calendar.ts:40 | Retrieve lịch | Read-only, cache 3' |
| Marker protocol 4 marker + parse/strip | sale-settings.ts:425-443, claude-sale.ts:356-393 | Giao thức gửi ảnh/tên/escalation | **Bất di bất dịch** — fb-inbox phụ thuộc (mục F) |
| `askClaudeForReply` phần parse + `toApiMessages` + nhánh ALL_FAILED | claude-sale.ts:356-393/:281/:328-349 | LLM wording + an toàn provider | Tái dùng nguyên |
| `constraints` (core safety) + `SPECIAL_CONCEPT_ESCALATION_RULE` + `PRICE_IMAGE_INSTRUCTION` + phần lõi `SAMPLE_IMAGE_INSTRUCTION` + `whoLine` | claude-sale.ts:194-202/:146/:87/:91-105/:208-210 | CORE SAFETY của prompt mới | whoLine là nơi DUY NHẤT dạy `<<NAME>>` |
| Hạ tầng flags mẫu | sale-scenario-types.ts:326-342 | Khuôn cờ mới | helper `on()` + allowlist PSID fail-closed |
| Human Review gate + hold + takeover | fb-inbox.ts:922-955, sale-human-review.ts | Level 3 handoff | Giữ nguyên hành vi |
| Test harness | sale-workflow-golden-set.ts (58/116 case), sale-brain-conversations.test.ts (30 convo/70 lượt), runScenarioTest + POST /lulu-scenarios/test-conversation, POST /lulu-brain/test (so sánh 2 chiều) | Khung test/so sánh | Mở rộng theo mục K |

---

## C. MODULE DEPRECATED (đánh dấu, KHÔNG xoá trong đợt này)

| Deprecate | Ở đâu | Vì sao | Cách xử |
|---|---|---|---|
| `PRICE_GATING_RULE` | claude-sale.ts:128-142 (2.484 ký tự) | Quyết định gate giá thuộc Router (`ASK_DATE`/`QUOTE_*`) + Scenario | Loại khỏi prompt clean path. Giữ 2 mảnh: dòng "lời ngắn vì hệ thống gửi hình bảng giá" + "hỏi giá KHÔNG phải lý do NEEDS_HUMAN" → chuyển vào khối marker/core |
| `SALE_SELECTION_AND_STYLE_RULES` | claude-sale.ts:109-124 (3.112) | Chọn nhóm ảnh đã có cổng cứng `imageToggleOn`+`intentPrimaryGroup` (sale-samples); văn phong trùng 3 nơi | Loại khỏi clean path; luật "không trộn nhóm ảnh" thành invariant code (đã có) |
| `saleSteps` + `saleLevel` trong prompt | sale-settings.ts:61/:44, render :380-382/:414-415 | SALE SCRIPT cạnh tranh Kịch bản — nguồn xung đột B4 | Clean path KHÔNG render 2 khối này. Settings/FE giữ nguyên (đường cũ vẫn dùng) — deprecate UI ở đợt sau |
| Khối "MỤC TIÊU" | claude-sale.ts:220 | Bước kế tiếp do Router/Scenario quyết | Loại khỏi clean path |
| `antiDriftBlock` (văn 2,2K) | sale-conversation-discipline.ts:114-129 | Kỷ luật đã enforce bằng State + `forbiddenQuestions` + validator `service_drift`/`repeated_question` | Clean path thay bằng 3-5 dòng STATE FACTS; giữ `detectServiceDrift` (validator) + `buildAntiDriftRule` cho đường cũ |
| Nhánh fallback không-settings | claude-sale.ts:234-278 (3.257) | CODE CHẾT — `getClaudeSaleSettings` không bao giờ null (5/5 call site truyền settings) | Đánh dấu `@deprecated`, xoá ở đợt dọn sau |
| `cleanDesc` slice(0,240) cho gói | sale-context.ts:92-99 | Mất thành phần gói | Clean path dùng `EffectivePackage.description` raw + `naturalizePackageContent` |
| Khối album 92 dòng trong context | sale-context.ts:213-224 (~6,9K) | Ảnh mẫu đi qua `selectSampleImages` + `SampleImage.detailUrl`; album list "nội bộ" không cần trong prompt | Clean path bỏ hẳn; đường cũ giữ |
| `SERVICE_GROUP_KEYWORDS` hard-code | sale-pricing.ts:57-66 | Trùng nguồn với `lulu_service_map.keywords` | Đợt này: GIỮ (đường chạy chính), ghi nợ hợp nhất về DB ở đợt sau |
| `ai_per_thread_enabled`, `connectMessenger/connectClaudeTest/connectZalo`, `calWeekendCaution`, `followUpHoldAfterMinutes` | fb-inbox.ts:486 (SELECT nhưng gate không đọc), sale-settings.ts:64-66/:78/:85 | Toggle chết | Đánh dấu deprecated trong comment + FE ghi chú; KHÔNG đổi hành vi đợt này |
| Trace shadow riêng của Claude Sale Test | claude-sale-test.ts:335-359 | 2 định dạng trace song song | Hợp nhất về `PipelineTrace` khi PR-2 tách orchestrator |
| (ghi nhận, KHÔNG đụng) Engine GPT legacy 3 cửa + dead branch fb-inbox:560-768 + BE claude-sale-test | ai-engine.ts, fb-inbox.ts:1511/:1617 | Ngoài scope cleanup pipeline | Đợt dọn legacy riêng, sau khi clean pipeline ổn |

---

## D. CÁC LUẬT XUNG ĐỘT SẼ BỎ (trong clean path)

1. **B4 "gửi giá ngay" vs PRICE_GATING "cấm bung giá"** → CẢ HAI biến mất khỏi prompt. Chủ sở hữu mới của quyết định báo-giá-hay-hỏi-lại: `routeSaleAction` (`QUOTE_REFERENCE`/`QUOTE_EXACT`/`ASK_DATE`/`ASK_SERVICE`, sale-workflow.ts:551-567) + thẻ Kịch bản override trong giới hạn playbook. LLM không còn được "tự trọng tài".
2. **antiDrift tự nhận supremacy vs PRICE_GATING tự nhận ghi đè** → hết tồn tại vì cả 2 khối rời prompt. Ưu tiên chính thức nằm ở mục 9 (mandate) và được enforce bằng THỨ TỰ CODE, không bằng câu văn.
3. **inferKnownIntent vs ThreadState.serviceIntent** → clean path chỉ dùng MỘT nguồn: ThreadState (+ `computeServiceTrail` khi state chưa có). `inferKnownIntent` chỉ còn phục vụ đường cũ.
4. **Văn phong lặp 3 lần** (persona styleLines / constraints / SALE_SELECTION) → còn MỘT khối style duy nhất (mục F, BRAIN STYLE).
5. **Luật cọc/chuyển khoản lặp 2 lần** (constraints vs calendarBlock) → giữ 1 lần trong CORE.
6. **2 regex `NEW_CONCEPT_RE` gần trùng** (sale-context.ts:262 vs sale-samples.ts:75) → hợp nhất về 1 export (sale-samples) khi làm PR-3.
7. **`asksPrice` override đè stepHint bất kể action** (sale-brain-runner.ts:238-240) → thay bằng map `ACTION_STEP_HINT` tách module + luật: chỉ override khi action thuộc nhóm QUOTE_*; `HANDLE_OBJECTION` ("mắc quá") không bị ép về bao-gia.

---

## E. PIPELINE MỚI (map 10 bước mục tiêu → hàm đã có / hàm phải viết)

**Module mới trung tâm: `lib/sale-clean-pipeline.ts`** — tách nguyên khối structured từ `sale-brain-runner.ts:199-355` thành hàm dùng chung, để **Messenger và Brain Lab gọi ĐÚNG MỘT hàm**:

```ts
export type CleanPipelineInput = {
  psid: string | null;                  // null = sân test
  customerMessage: string;
  history: Array<{ direction: "incoming"|"outgoing"; message: string }>;
  threadState: ThreadState | null;      // thật (getThreadState) hoặc mô phỏng
  settings: ClaudeSaleSettings;
  callLlm: PipelineLlmCall | null;      // đã đóng gói provider/askClaudeForReply
  imageContext?: { visionIntent: CustomerImageIntent | null };
};
export type CleanPipelineResult = {
  finalize: FinalizeResult;             // replyText/fallbackUsed/needsHuman/blockedReason…
  decision: RouterDecision;             // stage/action/forbidden…
  resolve: ScenarioResolveResult;       // winner/guidance/source
  facts: PipelineFacts;
  serviceKey: string | null; groupName: string | null;
  trace: PipelineTrace;
  statePatch: BotReplyInfo;             // để caller ghi state SAU khi gửi
  markers: { priceImageCodes: string[]; sampleRequested: boolean; sampleIntents: string[]; learnedName: string | null };
};
export async function runCleanSalePipeline(input: CleanPipelineInput): Promise<CleanPipelineResult>
```

| # Bước mục tiêu | Hàm đảm nhiệm | Trạng thái |
|---|---|---|
| 1. Understand | `detectMessageSignals` (workflow:297) + `extractSlotsV2Patch` (thread-state:104) + `detectServiceIntentFromText` (samples:82) | ĐÃ CÓ — gom gọi trong orchestrator |
| 2. Conversation State | prod: `getThreadState`; test: `simulateThreadStateFromHistory` | ĐÃ CÓ. **PHẢI SỬA**: `applyIncomingMessage` COALESCE không bao giờ hạ intent cũ (thread-state:266) → nối `computeServiceTrail`: switch phát hiện được thì UPDATE `service_intent` + ghi `previous_service`/`services_json` (cột DDL đã có :166-168, thêm vào SELECT :195-199 + type + drizzle ĐÃ khai sẵn lulu-brain.ts:145-147 — không cần migration mới) |
| 3. Resolve Service | `computeServiceTrail` + `resolveGroupNameForService` → `serviceKey`/`groupName`/`serviceSlug` | ĐÃ CÓ — tách 6 dòng inline (brain-runner:219-226) thành hàm export |
| 4. Resolve Sale Scenario | `loadActiveScenarioDefs` + `resolveScenario` (baseline = `routeSaleAction`) | ĐÃ CÓ |
| 5. Retrieve Required Data | **MỚI: `lib/sale-knowledge.ts` → `loadKnowledge(decision, serviceKey, opts)`** đọc `RouterDecision.knowledgeNeeded` (hiện là nhãn suông — 0 consumer) | VIẾT MỚI (mục G) |
| 6. Generate Natural Response | `callLlm` bọc `askClaudeForReply` với **prompt mới** (mục F) | Sửa điểm nối |
| 7. Fact Validator | `validateSaleReply` (sửa theo mục I) + `checkDatabaseVoice`, tiêm qua `finalizeSaleReply` | ĐÃ CÓ + sửa |
| 8. State Update | caller (fb-inbox / test) gọi `recordBotReply(statePatch)` SAU khi gửi thành công; patch tính trong orchestrator (fix: fallback không có giá thì KHÔNG ghi quoted) | ĐÃ CÓ + fix thứ tự |
| 9. Reply | fb-inbox giữ nguyên chuỗi gửi (ảnh mẫu → ảnh giá → bubble typing) — orchestrator chỉ trả text+markers đúng shape | Giữ nguyên hạ tầng |
| 10. Monitor Trace | `PipelineTrace` (brain-runner:77-102) + **bảng mới `lulu_pipeline_traces`** (PR-8, đăng ký ĐỦ migrations.ts + drizzle schema theo bài học #132) + console log `[CleanPipeline]` từ PR-7 | ĐÃ CÓ type, thêm nơi lưu |

**Chỉ còn MỘT đường quyết định:** Brain Lab (`simulateReply`) refactor thành wrapper của `runCleanSalePipeline` (giữ nguyên SimulateResult shape); fb-inbox gọi cùng hàm sau cờ. Sân Kịch bản (`runScenarioTest`) chuyển sang cùng orchestrator ở PR-8 (hết cảnh 2 sân test 2 pipeline).

---

## F. PROMPT STACK MỚI (structured context — thay mega-prompt 38K)

Builder mới: `buildCleanSystemPrompt(parts: CleanPromptParts): string` trong `sale-clean-pipeline.ts`. Thứ tự CỐ ĐỊNH đúng priority mục 9 mandate, mỗi phần có header máy-đọc:

| # | Khối | Nguồn | Ước cỡ |
|---|---|---|---|
| 1 | `[CORE RULES]` — constraints (claude-sale.ts:194-202) + SPECIAL_CONCEPT (:146) + luật cọc/CK/lịch (rút từ calendarBlock, 1 lần) + "hỏi giá không phải NEEDS_HUMAN" | hằng số code, export mới `CORE_SAFETY_BLOCK` | ~2,5K |
| 2 | `[MARKERS]` — PRICE_IMAGE_INSTRUCTION + lõi SAMPLE_IMAGE_INSTRUCTION (cắt ví dụ sale ~1,5K) + whoLine (dạy `<<NAME>>`) + dạy `<<NEEDS_HUMAN>>` | hằng số code — **KHÔNG lấy từ DB brain version** | ~2,5K |
| 3 | `[CONVERSATION STATE]` — buildThreadStateBlock rút gọn: tên, dịch vụ hiện tại/trước, ngày, gói đã báo, đã hỏi gì | ThreadState | ~0,4K |
| 4 | `[ACTIVE SERVICE]` — groupName + serviceKey + "CHỈ nói về dịch vụ này" | Resolve Service | ~0,15K |
| 5 | `[SALE STAGE + ACTION]` — decision.stage/action + allowedQuestions/forbiddenQuestions render thành 2-3 dòng lệnh | RouterDecision | ~0,3K |
| 6 | `[SCENARIO GUIDANCE]` — buildScenarioGuidanceBlock (thẻ thắng) | resolveScenario | ~0,5K |
| 7 | `[GOLDEN EXAMPLES]` — buildGoldenExamplesBlock (4 ví dụ service-first) | script-library | ~1,4K |
| 8 | `[FACTS]` — output `loadKnowledge` theo intent (giá 1 nhóm / gói / lịch / menu dịch vụ…) + luật ƯU ĐÃI (tách export từ sale-context.ts:240-249, chỉ chèn khi có giá) | sale-knowledge | ~0,8–2,5K |
| 9 | `[BRAIN STYLE]` — persona rút gọn: aiName/gender/role + style toggles (KHÔNG saleSteps, KHÔNG saleLevel) + nhịp bubble | settings (buildSettingsPromptBlock thay bằng `buildStyleBlock` mới) | ~0,8K |
| 10 | messages[] — 20 tin (toApiMessages giữ nguyên) | fb_inbox_messages | ~1,6K |

**Tổng system ≈ 9–12K** (so 38K; context động 19,5K → 2–4K theo intent — chi tiết mục G). Bật **prompt caching** (`cache_control` cho khối 1-2, tĩnh tuyệt đối) ở PR-7 — hiện `grep cache_control = 0`.

**Chốt quan trọng (điểm quyết định #1 cho chủ):** clean path **KHÔNG nhét `getActiveBrainRules()` (bản active lulu_brain_versions, 8.241 ký tự) vào prompt** — Brain Lab theo mandate 6 chỉ còn quyền style. Marker được dạy từ hằng số code nên không mất chức năng ảnh. Hệ quả: (a) chỉnh "não" qua Brain Lab không ảnh hưởng clean path (đúng thiết kế); (b) `AI_DRAFT_SYSTEM` (lulu-brain-lab.ts:202-215, ép "bản mới DÀI tương đương") phải sửa mô tả ở PR-8 để khỏi tái sinh mega-prompt. Đường cũ giữ nguyên brainRules.

---

## G. DATA RETRIEVAL THEO NHU CẦU

Module mới **`lib/sale-knowledge.ts`**: `loadKnowledge(decision: RouterDecision, serviceKey: string | null, opts?: { now?: Date }): Promise<{ block: string; facts: PipelineFacts; catalog: CatalogItem[]; promoActive: boolean }>` — consumer ĐẦU TIÊN của `knowledgeNeeded` (nhãn hiện được sinh ở workflow:335-342/:526-529 nhưng 0 nơi đọc).

| Intent (map vào action/signal ĐÃ CÓ) | Gọi gì | Cỡ block | Việc phải làm |
|---|---|---|---|
| SERVICE_AVAILABILITY = `faqTopic 'faq:services'` (workflow:257) | `detectServiceIntentFromText` + `matchedGroupNamesForService` + `listServiceMap` | ~0,7K | **MỚI** `buildServiceMenuBlock(rows)`; **MỚI** TriggerKey `hoi_co_dich_vu` (2/6 FAQ topic chưa có trigger) |
| ASK_PRICE = `priceQuestion` → `QUOTE_REFERENCE/QUOTE_EXACT/SEND_PRICE` | `resolveGroupNameForService` → `getServicePricePreview(serviceKey, { pinnedGroup })` + luật ƯU ĐÃI | ~2,3K | **MỚI** `buildServicePriceBlock(preview)` (format hiện inline sale-context.ts:174-208, không tách được); **FIX BUG** brain-runner:248 gọi thiếu `pinnedGroup` → dịch vụ không khớp keyword bị "trả tất cả nhóm" (biến thể bug chụp-bầu-ra-CHỤP-CỔNG) |
| ASK_PACKAGE_CONTENT = `faq:package_detail` | `getEffectivePrice` → `description` RAW → `naturalizePackageContent` | ~0,7K | Sửa lệch step-hint: ANSWER_FAQ+package_detail → hint `bao-gia` (hiện `tu-van`) |
| ASK_SAMPLE = `wantSample` → `SEND_SAMPLE` | `selectSampleImages` (ảnh đi Graph API, KHÔNG vào prompt) + 0,3K quy tắc link | ~0,3K | Bỏ 6,9K album khỏi prompt |
| ASK_CONCEPT (hiện bị nuốt vào `wantSample`) | `wantsNewConcept` + `getPhotoIdeasBlock(serviceKey?, limit?)` | ~2K | **MỚI** signal `wantConcept` trong MessageSignals + thêm tham số lọc cho getPhotoIdeasBlock; hợp nhất 2 regex NEW_CONCEPT_RE |
| ASK_AVAILABILITY (hiện bị nuốt vào `bookingIntent`) | `getScheduleContext(calWindowDays)` | ~1,5K | **MỚI** signal `askAvailability` tách khỏi REOPEN_DATE_RE (giữ nguyên `reopenDate` cho computeForbiddenQuestions — rủi ro hỏi-lặp-ngày, xem K) |
| HANDLE_OBJECTION (đã có 1-1) | golden stepHint `xu-ly-phan-van` + facts gói đã báo (`quotedPackages`) | ~2K | Nguồn `value_points` CHƯA CÓ — v1 dùng golden; bảng điểm-mạnh là backlog |
| GREET / mọi action khác | menu 10 nhóm từ `FALLBACK_CONTEXT` seed | ~0,4K | — |

Cache: block theo `serviceKey` TTL 5' + mở rộng `clearSaleContextCache()` (sale-context.ts:63) xoá cache mới cùng lúc (hook routes/pricing.ts đã gọi sẵn).

---

## H. FALLBACK 3 TẦNG (thay "không match → safe → chuyển người")

Map vào thang `finalizeSaleReply` hiện có (đổi NHÃN + nắn điều kiện, không viết lại):

- **LEVEL 1 — Natural clarification** = nhánh intent-first + blind-golden (sale-pipeline.ts:209-242): `intentFallbackLine` cho GREET/ASK_SERVICE/IDENTIFY_SERVICE (đã có 3 biến thể xoay vòng). Điều kiện: chưa khoá dịch vụ / câu mơ hồ.
- **LEVEL 2 — Answer known facts + 1 câu hỏi** = stitched (`tryStitch` + facts CRM) và intent-line có facts (QUOTE_*/ANSWER_FAQ/HANDLE_OBJECTION). **Sửa nhỏ:** các câu Level 2 kết bằng đúng 1 câu hỏi hữu ích theo `allowedQuestions` (template thêm vào intentFallbackLine).
- **LEVEL 3 — Human handoff** = SAFE_REPLY_LINE + needsHuman → đi vào Human Review gate hiện có (hold + takeover). **Siết điều kiện đúng mandate:** chỉ khi (a) `wantHuman` (khách đòi), (b) `detectEscalation` nhóm quyền-người-thật (cọc/CK/khiếu nại/hủy dời lịch), (c) validator BLOCK critical 2 lần liên tiếp VÀ không stitch/intent được (= dữ liệu bắt buộc không tồn tại), (d) `ESCALATE_HUMAN` từ Router/Scenario. **Bỏ** đường "escalate chỉ vì không match" — hiện `intentTried` guard (sale-pipeline.ts:210-213) làm intent-line chỉ thử 1 lần rồi rơi safe; nới: nhánh 2c được thử lại với action khác (`ANSWER_FAQ` generic) trước khi safe.

Ghi chú hành vi phải chốt (điểm quyết định #3): khi rơi Level 2/3, hiện `reply = null` → lượt đó không gửi ảnh mẫu/ảnh giá (brain-runner:355). Đề xuất giữ (an toàn: câu fallback không nên kèm ảnh của câu bị chặn) + statePatch KHÔNG ghi `quoted` cho lượt fallback (fix gap "state ghi đã-báo-giá cho câu không có giá").

---

## I. VALIDATOR (business fact + safety ONLY)

**Giữ (8 rule):** `price_mismatch` (critical), `price_unverifiable` (fail-closed), `promo_not_active`, `self_discount`, `leak_internal`, `deposit_confirmed_by_bot`, `schedule_promised`, `service_drift`, `repeated_question`, `forbidden_ask_date` (kỷ luật hỏi — giữ vì gắn Router).

**Tách khỏi validator (chuyển sang voiceCheck/style layer, KHÔNG chặn business):** `too_many_questions` (validator.ts:310), `competitor_bashing` (:261), `response_not_matching_action` (:182), vế `countQuestions>=2` của `escalate_but_selling` (:323, giữ vế tiền). → các rule này trả về qua `checkDatabaseVoice`-style warn, đi vào trace, không BLOCK.

**Nâng cấp:**
1. **Catalog theo dịch vụ**: thay catalog toàn cục bằng `validPricesFor(serviceKey, now)` (sale-pricing.ts:160 — hàm canonical, 0 caller runtime) + vẫn hợp nhất `factCatalog`. Hết cảnh "giá Beauty PASS trong hội thoại cưới".
2. **Rule `package_mismatch` MỚI**: đối chiếu TÊN/MÃ gói trong reply với catalog (CatalogItem đã có code/name nhưng vòng validPrices bỏ qua — gap đã xác minh validator.ts:196-205).
3. **Port bắt buộc từ brain-runner sang orchestrator chung**: `scrubFacts` + `factCatalog` (brain-runner:306-321) — thiếu 2 mảnh này khi nối prod là chặn oan hàng loạt (facts CRM verbatim bị tính là giá lạ/từ khoá lạ).
4. ValidatorInput thêm `now?: Date` + `serviceKey?: string` (additive, không phá 3 call site cũ).
5. Giữ fail-fast BLOCK, nhưng thêm mode `collectAll?: boolean` cho test/audit (trả mảng vi phạm).

**Luồng khi FAIL (giữ nguyên finalize):** BLOCK → regenerate đúng 1 lần kèm feedback → vẫn FAIL → Level 2 (stitched/intent) → Level 3. Test set `sale-workflow-validator.test.ts` (21 test) sẽ đỏ ở các rule bị tách — cập nhật test là một phần của PR-4, không phải "sửa cho xanh" âm thầm.

---

## J. MIGRATION / FEATURE FLAGS

**Cờ mới (theo đúng khuôn scenario — fail-closed):** đặt tại `sale-scenario-types.ts` cạnh `on()`:
```ts
export function isCleanPipelineShadowEnabled(): boolean            // LULU_CLEAN_PIPELINE_SHADOW_ENABLED
export function isCleanPipelineEnabledFor(psid: string): boolean   // LULU_CLEAN_PIPELINE_ENABLED + LULU_CLEAN_PIPELINE_PSIDS (allowlist BẮT BUỘC, rỗng = không ai)
```
LƯU Ý khuôn allowlist: copy mẫu `isScenarioEnforceEnabledFor` (:337-342), **KHÔNG** copy mẫu LULU_STATE (rỗng = mở toàn bộ — ngược nhau, đã xác minh).

**Điểm rẽ prod: fb-inbox.ts:885-898 (Điểm rẽ #2 — hẹp nhất).** Bọc:
```
if (isCleanPipelineEnabledFor(psid)) → runCleanSalePipeline(...) → map sang shape ClaudeReply
else → askClaudeForReply(...) như cũ  (nguyên trạng 100%)
```
Ràng buộc shape: code sau phụ thuộc `reply.learnedName`(:907) `.escalation`(:915) `.sampleRequested/.sampleIntents`(:974-987) `.messageChunks`(:1010) `.priceImageCodes`(:1037) `.messages/.raw`(:933) — orchestrator phải trả đủ (đã thiết kế trong CleanPipelineResult.markers).

**Shadow trước, enforce sau:** shadow = chạy `runCleanSalePipeline` với `callLlm: null` (0 chi phí LLM, chỉ Router/Scenario/Retrieval/stitched) song song đường cũ, log `[CleanPipelineShadow]` so sánh action/service/facts — nuốt lỗi fail-open y khuôn fb-inbox.ts:856-884.

**Thứ tự PR (mỗi PR nhỏ, bật/tắt độc lập, KHÔNG PR nào đổi hành vi prod khi cờ OFF):**

| PR | Nội dung | File đụng chính | Rủi ro |
|---|---|---|---|
| 1 | Plan này (docs) | docs/LULU_CLEAN_PIPELINE_PLAN.md | 0 |
| 2 | Tách `sale-clean-pipeline.ts` (extract brain-runner:199-355, export ACTION_STEP_HINT/scrubFacts/tryStitch, tiêm rng cho tie-break để test deterministic); Brain Lab thành wrapper | +lib/sale-clean-pipeline.ts, sale-brain-runner.ts, sale-pipeline.ts | Thấp (refactor thuần, suite hiện có khoá) |
| 3 | `sale-knowledge.ts` + buildServicePriceBlock/buildServiceMenuBlock/buildStyleBlock + tách CORE_SAFETY_BLOCK/POLICY_BLOCK export + fix pinnedGroup + hợp nhất NEW_CONCEPT_RE + signal mới wantConcept/askAvailability | +lib/sale-knowledge.ts, sale-context.ts, sale-pricing.ts, sale-workflow.ts, claude-sale.ts (chỉ export hằng) | Trung bình (đụng regex golden — chạy 116 golden + 30 convo) |
| 4 | Validator: tách rule văn phong, package_mismatch, validPricesFor(serviceKey), collectAll; cập nhật test | sale-workflow-validator.ts + test | Trung bình |
| 5 | `buildCleanSystemPrompt` + map ClaudeReply | sale-clean-pipeline.ts, claude-sale.ts (export toApiMessages/parse) | Thấp (chưa nối prod) |
| 6 | State per-service: đọc/ghi `current_service/previous_service/services_json` (cột ĐÃ có cả DDL lẫn drizzle — chỉ sửa SELECT/UPSERT/type), nối computeServiceTrail vào applyIncomingMessage (hạ COALESCE khi switch) | sale-thread-state.ts, sale-service-context.ts + test | Trung bình (golden state phải xanh) |
| 7 | Nối fb-inbox: shadow → enforce per-PSID + prompt caching + log | fb-inbox.ts (1 khối ~40 dòng theo khuôn :856-884), sale-scenario-types.ts (2 cờ) | Cao nhất — nhưng flag OFF = 0 ảnh hưởng |
| 8 | Trace: bảng `lulu_pipeline_traces` (migrations.ts + lib/db/schema đầy đủ — bài học #132) + Brain Lab so sánh OLD vs CLEAN (3 trục trong POST /lulu-brain/test) + hợp nhất trace claude-sale-test + sửa AI_DRAFT_SYSTEM | migrations.ts, lib/db/src/schema/lulu-brain.ts, routes/lulu-brain-lab.ts, FE lulu-brain-lab.tsx | Trung bình |

**KHÔNG đổi DB schema** ngoài: (a) 3 cột thread-state ĐÃ TỒN TẠI, (b) bảng trace mới ở PR-8 (additive, đăng ký đủ 2 nơi, Run dev 1 lần trước mọi Republish, màn migration phải "No changes" — quy trình docs/DEPLOY-CODE-ONLY.md).

---

## K. TEST STRATEGY (≥100 hội thoại multi-turn)

**Tầng 1 — deterministic, không LLM (chạy trong `pnpm test`):**
- Golden 58/116 case (`sale-workflow-golden-set.ts` — số 104 trong ghi nhớ cũ đã lệch, thực tế 58 gốc ×2 biến thể không dấu) giữ xanh qua PR-3/-4/-6.
- Mở rộng `sale-brain-conversations.test.ts` (hiện 30 convo/70 lượt): **thêm ≥70 hội thoại mới, mỗi hội thoại 10-20 lượt**, phủ đúng danh mục mandate 14: greeting, unknown service, Beauty, Chụp cổng, Album, service switching (2 chiều + quay lại), pricing, package detail, objections, discount request, booking, no-date, typo, không dấu, tin cụt, follow-up, human handoff. Mỗi lượt assert: winner/action/stage/escalate + **MỚI: facts.serviceName đúng nhóm + validator PASS trên câu stitched**.
- Test mới cho: sale-knowledge (ma trận intent→block), sale-clean-pipeline (fallback 3 tầng, statePatch), state per-service (switch/quay lại), validator rule mới. Lấp vùng mù: sale-brain-runner/sale-slots-extra hiện KHÔNG có test.
- Tie-break `Math.random` → tiêm `rng` injectable (PR-2) để parity không chập chờn.

**Tầng 2 — API-level qua preview (tái dùng QA runner đã có `scratchpad/lulu-qa-runner.mjs`, đưa vào repo `scripts/lulu-clean-qa.mjs`):** chạy qua `POST /lulu-brain/test` (so sánh OLD vs CLEAN cùng input) + `POST /lulu-scenarios/test-conversation`. Mỗi lượt lưu JSON: `input / intent / service / scenario / factsUsed / response / validator / stateAfter` (= PipelineTrace + stateAfter đã có sẵn trong response). Có LLM key (ShopAIKey qua `LULU_TEST_PROVIDER`) thì đo thêm wording; không key thì tầng deterministic vẫn đủ chấm đúng-sai business (báo trung thực như đợt nghiệm thu trước).

**Tầng 3 — shadow trên prod (PR-7, cờ shadow):** so `action/service/facts` clean-vs-cũ trên tin thật, không đổi câu trả lời; gom log 1 tuần trước khi xin chủ bật enforce PSID pilot.

**Gates mỗi PR:** `pnpm --filter @workspace/api-server run typecheck && run test` + FE `vitest run` + `node scripts/deploy-guard.mjs` + build api (đã kèm check-duplicate-functions). (Không có script tên "dup-check" riêng — nó nằm trong build api-server.)

**Quality target (mandate 15) → cơ chế enforce tương ứng:** đúng service = Resolve Service + validator service_drift/catalog-theo-service · đúng fact = facts CRM + price/package_mismatch · không đọc raw DB = naturalize + checkDatabaseVoice · không hỏi lặp = forbiddenQuestions + repeated_question · không chuyển người vô lý = điều kiện Level 3 siết · trả lời câu hỏi trước = stepHint theo action (bỏ override mù) · ngắn/1 câu hỏi = voiceCheck warn + style block · biết bước kế = RouterDecision.action · không phụ thuộc exact golden = stitch token + LLM paraphrase khi có key.

---

## L. ROLLBACK

1. **Tắt cờ = về nguyên trạng tức thì**: `LULU_CLEAN_PIPELINE_ENABLED`/`_SHADOW_ENABLED` unset → fb-inbox đi đúng đường mega-prompt hiện tại (điểm rẽ chỉ là 1 `if`). Không cần deploy lại nếu đổi được env (Replit Deployment env).
2. Mỗi PR độc lập, revert từng cái không kéo nhau (PR-2..-6 không đổi hành vi khi cờ OFF; PR-7 là điểm nối duy nhất).
3. Không migration phá: không DROP, không đổi cột cũ; bảng trace mới là additive và có thể bỏ đọc.
4. Brain Lab giữ chế độ so sánh OLD vs CLEAN → chủ tự thấy khác biệt trước khi cho khách thật.
5. Khẩn cấp nhất: cầu dao tổng (settings `claude_sale_master_enabled`) vẫn đứng TRÊN mọi cờ — tắt là Lulu im hoàn toàn, như hiện nay.

---

## ĐIỂM CẦN CHỦ QUYẾT TRƯỚC KHI CODE (5 câu)

1. **Brain Lab trong clean path**: đồng ý "Brain Lab chỉ còn style, KHÔNG nhét bản não active 8,2K vào prompt mới" (mục F)? (Đường cũ vẫn dùng não như hiện tại.)
2. **Fail-closed giá**: khi lỗi DB không lấy được bảng giá mà câu trả lời có số tiền → chặn + Level 2/3 (an toàn nhưng có thể "chuyển người" nhiều hơn khi DB trục trặc). OK?
3. **Lượt fallback không gửi ảnh** (reply=null giữ nguyên) — OK?
4. **PSID pilot**: chủ cho em 1-2 PSID test (khách giả trên Fanpage) để bật enforce đầu tiên.
5. **Bảng trace `lulu_pipeline_traces`** (PR-8): đồng ý thêm bảng additive này (theo đủ checklist #132)?

**Phạm vi cam kết:** KHÔNG merge · KHÔNG deploy · KHÔNG Republish · KHÔNG bật cờ nào trên production · mọi PR chờ chủ duyệt từng cái.
