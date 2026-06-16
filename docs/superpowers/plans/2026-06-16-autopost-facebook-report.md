# AutoPost Facebook — Báo cáo hoàn thành MVP (Task 10)

**Ngày:** 2026-06-16 · **Branch:** `feature/autopost-facebook` · **Trạng thái:** ✅ MVP hoàn tất (10/10 task), đã verify trực tiếp.

Hệ thống tự động đăng Facebook Page cho Amazing Studio: **Claude viết caption (đọc ảnh + metadata) → admin duyệt → scheduler tự đăng đến giờ**. Module tách biệt hoàn toàn (chỉ ghi bảng `autopost_*`), mọi lần đăng đi qua cờ an toàn `AUTOPOST_DRY_RUN` (mặc định BẬT).

---

## 1. Các task & commit

| Task | Nội dung | Commit |
|---|---|---|
| 1 | Schema 5 bảng `autopost_*` (Drizzle + migration SQL + ensureAutoPostSchema) | `bc48359` |
| 2 | AI vision — mở rộng `callChat()` đọc ảnh (Claude/OpenAI image blocks) | `a61b08f` |
| 3 | Content Pool sync (dresses/albums/photo_ideas, read-only) + image helper | `7854768` |
| 4 | Claude caption 3 mẫu + price-guard (chống bịa giá) + từ cấm | `cc3311a` |
| 7 | Facebook Page publish (photos/feed) + DRY_RUN mặc định + verifyPageToken | `7b3fee4` |
| 5 | Router admin (pool/lịch/bài/duyệt/settings) + đăng ký + wire schema | `73f9380` |
| 6 | Scheduler (sinh bài chờ duyệt + đăng bài tới giờ, atomic-claim, dedupe, giờ VN) | `278f75b` |
| 8 | UI admin 7 tab + API hooks + route + nav menu | `429a9e2` |
| 9 | Hardening sau review đối kháng (Workflow 42 agent) | `330f22c` |
| 9b | Fix sync ON CONFLICT (bug chỉ lộ khi chạy DB thật) | `51667c6` |

> Thứ tự build đảo: Task 7 trước 5/6 vì router cần `verifyPageToken` và scheduler cần `publishToPage`.

---

## 2. Kết quả kiểm thử

- **Unit test (vitest):** 85/85 pass (caption, pool, fb-publish, route-helpers, images, scheduler, vision).
- **TypeScript:** 0 lỗi ở mọi file mới/sửa (baseline tồn dư của repo không đổi: BE 358, FE 271).
- **Review đối kháng (Workflow):** 7 dimension × reviewer → verify từng finding → 27 finding thô. Sau lọc trùng/false-positive còn ~8 nhóm bug thật → đã fix hết (xem §4).
- **Verify trực tiếp (preview, đăng nhập admin thật):**
  - Trang `/auto-post-facebook` render đủ **7 tab**, không lỗi runtime.
  - Nav menu **"AutoPost Facebook"** hiển thị (admin-only).
  - **Đồng bộ app/web** → kéo thật **285 item** (184 váy/đồ + 65 album + 36 ý tưởng) vào kho.
  - **Tạo lịch** end-to-end → lưu 7 khung giờ (giờ VN), badge "Tắt" (an toàn).
  - **Facebook Test** → `{ok:true, pageName:"Amazing Studio", canPost:true}` (token Messenger sẵn có).

---

## 3. An toàn hiện tại (chưa đăng gì lên Facebook)

3 lớp khoá, tất cả đang ở trạng thái an toàn:
1. **`ENABLE_AUTO_POST_FACEBOOK`** chưa bật → scheduler KHÔNG chạy (chỉ log "scheduler TẮT").
2. **`AUTOPOST_DRY_RUN`** mặc định BẬT → kể cả khi đăng, chỉ ghi log thử (`dryrun_*`), KHÔNG gọi Graph API thật.
3. **Lịch tạo ra mặc định `enabled=false`** + **chỉ bài qua `/approve` (admin) mới `approved`** → không có gì tự đăng.

Module **không ghi** vào booking/payments/attendance/dresses/gallery — chỉ `autopost_*`.

---

## 4. Bug đã phát hiện & sửa (review + verify)

| # | Bug | Mức | Fix |
|---|---|---|---|
| 1 | PATCH `/posts/:id` sửa được caption bài ĐÃ duyệt (lách quy trình) + cho null/whitespace + index ngoài biên | critical | Guard `status IN ('pending_review','draft_ai')` + validate caption + tính lại `caption_hash` + chặn biên index |
| 2 | `verifyToken` có thể null → `approved_by`/`updated_by` = NULL | high | Null-check → 401 (approve + settings) |
| 3 | Thiếu `'posting'` trong `POST_STATUSES` | high | Bổ sung |
| 4 | Dedupe race: chỉ check `posted`, bỏ `posting` → 2 worker đăng trùng | high | Thêm `'posting'` vào điều kiện dedupe |
| 5 | Upsert pool hardcode `is_eligible=true` | high | `EXCLUDED.is_eligible` |
| 6 | `image_hash = sha1("")` khi không ảnh (lệch pool) | med | `images[0] ? sha1 : null` |
| 7 | Post type FE thiếu `captionHash/imageHash` + chưa guard caption rỗng | low | Bổ sung type + lọc |
| 8 | **Sync ON CONFLICT không khớp partial unique index → 500** (chỉ lộ khi chạy DB thật) | critical | Lặp lại predicate `WHERE source_table IS NOT NULL AND source_item_id IS NOT NULL` |

False-positive đã bác (có lý do): datetime đã parse LOCAL đúng cho browser VN; `caption_hash` ở generatePendingPosts set lúc approve; approve cho `approved/scheduled` là cố ý (đổi giờ); orphan slot vô hại.

---

## 5. Thứ tự bật tính năng (rollout an toàn)

Tất cả qua **biến môi trường** (không sửa code). Sau mỗi bước quan sát 1 ngày:

1. **B1 — Đã xong:** code deploy, `ensureAutoPostSchema()` tạo bảng. App cũ chạy bình thường.
2. **B2 — Kho + UI:** vào `/auto-post-facebook` → **Đồng bộ app/web** → kiểm tra kho. Scheduler vẫn tắt.
3. **B3 — Caption + Duyệt:** ở Kho bấm **Tạo bài** (cần `ANTHROPIC_API_KEY`) → Claude viết 3 caption → **Bài chờ duyệt** chọn/sửa → **Duyệt đăng** (đặt giờ). Vẫn chưa bật scheduler.
4. **B4 — DRY_RUN:** đặt `ENABLE_AUTO_POST_FACEBOOK=true` (giữ `AUTOPOST_DRY_RUN=true`). Tới giờ → log `[AutoPost][DRY_RUN]`, bài chuyển `posted` với id `dryrun_*` (link rỗng). Quan sát 1 ngày.
5. **B5 — Page nháp:** có token quyền `pages_manage_posts` → `AUTOPOST_DRY_RUN=false` trên **page test**. Theo dõi `posted/failed`.
6. **B6 — Page thật:** đổi `fb_active_page_id`/`FB_PAGE_ID`. Bắt đầu 2–3 bài/ngày rồi tăng.

**Biến môi trường liên quan** (ghi trong comment code, KHÔNG commit `.env`):
`ENABLE_AUTO_POST_FACEBOOK` (mặc định off) · `AUTO_POST_CHECK_INTERVAL_SEC` (120) · `AUTOPOST_DRY_RUN` (mặc định true) · `FB_PAGE_ID` · `PUBLIC_APP_URL` (cho link trong caption).

**Rollback toàn module:** `ENABLE_AUTO_POST_FACEBOOK=false` (tắt ngay, không cần deploy) + ẩn nav item. Module độc lập → về nguyên trạng.

---

## 6. Phase 2 (chưa làm — ngoài MVP)

Google Drive (hậu trường/makeup/feedback/bill/reels), vision đa ảnh, A/B caption, multi-page, thống kê reach/engagement qua Graph insights.

---

## 7. Lưu ý vận hành local

- Ảnh trong kho hiện hiện **placeholder** ở bản backup local vì ảnh nằm ở `uploads/object-storage-gcs/<uuid>.<ext>` còn code đọc `<root>/uploads/<uuid>` (không đuôi) — cần copy + strip đuôi. URL lưu trong DB đúng cho production. Component `Thumb` tự fallback, không vỡ layout.
- Caption (Task B3) cần `ANTHROPIC_API_KEY`; bản local key trống nên **Tạo bài** sẽ báo `caption_failed` cho tới khi có key.
