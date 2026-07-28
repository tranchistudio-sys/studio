# Deploy CODE-ONLY — runbook chống DROP TABLE (sự cố 24/07/2026)

## Chuyện gì đã xảy ra
Màn Replit Publishing hiện "Development database changes detected" và sinh migration
`DROP TABLE lulu_brain_* / lulu_human_reviews CASCADE` cho **production** (5 bảng, có dữ liệu thật).

## Cơ chế (đã xác minh bằng tài liệu Replit + sự cố 13/07)
- Workspace có database tích hợp (module `postgresql-16`) → **mỗi lần Publish, Replit tự diff
  schema DEV DB ↔ PROD DB** và sinh SQL đưa prod về giống dev. Đây là bước **platform**,
  KHÔNG có config nào trong repo (.replit / artifact.toml) tắt được, docs chính thức không có
  nút opt-out. Bảng nào **prod có mà dev thiếu** → Replit đề xuất `DROP` trên prod.
- 5 bảng `lulu_*` là bảng **runtime-managed**: code chỉ tạo lazy (`CREATE TABLE IF NOT EXISTS`)
  khi bot Lulu / Brain Lab thực sự chạy — thứ chỉ chạy trên **prod** → prod có bảng (kèm data),
  DEV DB của workspace không bao giờ có → drift vĩnh viễn → lần Republish nào cũng đòi DROP.

## Đã sửa gốc trong repo (PR fix/deploy-code-only-guard)
1. `migrations.ts` gọi `ensureBrainLabTables()` + `ensureHumanReviewTable()` ở startup
   (additive, idempotent, seed chỉ-khi-rỗng) → DEV DB tự có đủ 5 bảng mỗi lần Run → diff sạch.
2. `startup-ddl.ts` **fail-closed**: `NODE_ENV=production` mặc định KHÔNG chạy DDL
   (kể cả khi quên `SKIP_STARTUP_MIGRATIONS`); muốn chạy phải đặt `ALLOW_STARTUP_DDL_IN_PRODUCTION=1`.
3. `scripts/post-merge.sh`: `drizzle-kit push` đổi thành **opt-in** (`ALLOW_DB_PUSH=1`),
   mặc định bỏ qua — hết footgun push tự động sau merge.
4. `scripts/deploy-guard.mjs` chạy **đầu mỗi build api-server** (local + Replit build):
   FAIL build nếu thấy migration lạ / SQL destructive / lệnh push-migrate trong deploy path /
   guard bị revert. Chạy tay: `pnpm deploy:guard`.

## Quy trình Republish CODE-ONLY (mỗi lần deploy)
1. **Cancel** publish đang treo (nếu có) — không Approve màn migration cũ.
2. Workspace Replit: `git pull` main mới → bấm **Run** 1 lần, chờ log
   `[migrations] lulu_* runtime-managed tables OK` (DEV DB được vá additive — KHÔNG đụng prod).
3. Bấm **Republish** (Publishing → Republish).
4. Tới bước "Database migrations": **đọc kỹ**.
   - Hiện "No changes"/không có lệnh nào → tiếp tục.
   - Còn **BẤT KỲ** dòng `DROP` / `ALTER … DROP` / `TRUNCATE` nào → **Cancel ngay**, không Approve,
     báo lại để điều tra drift mới. KHÔNG bao giờ "Approve cho xong".
   - **NGOẠI LỆ CÓ CHỦ ĐÍCH — publish ĐẦU TIÊN sau khi merge PR #135 (lulu-thread-state):**
     màn migration SẼ hiện đúng các lệnh additive sau (vì prod chưa có bảng, dev vừa được Run tạo):
     `CREATE TABLE lulu_thread_state` + `CREATE UNIQUE INDEX idx_lulu_thread_state_user`
     + `CREATE INDEX idx_lulu_thread_state_updated` (và có thể `CREATE TABLE sale_playbooks`
     nếu prod chưa từng chạy Sale Learning). Đây là DỰ KIẾN → **được Approve**.
     CHỈ các lệnh CREATE nêu trên; nếu kèm bất kỳ dòng DROP/ALTER…DROP/TRUNCATE nào → vẫn Cancel.
     (Cách thay thế thỏa Quy tắc sắt #3: chạy tay chính các câu DDL `IF NOT EXISTS` đó lên PROD DB
     trước khi Republish để màn hình ra "No changes".)
5. Không bấm Promote Database / copy data trong bất kỳ bước nào.
6. Sau publish: smoke test `https://tranchistudio.com/api/healthz` + 1 trang chính.

## Env chuẩn (Deployment)
- `SKIP_STARTUP_MIGRATIONS=1` — giữ nguyên (tắt DDL startup trên prod).
- KHÔNG đặt `ALLOW_STARTUP_DDL_IN_PRODUCTION` / `ALLOW_DB_PUSH` trừ khi chủ chủ động migrate.

## Quy tắc sắt
- Màn migration còn DROP → Cancel. Không có ngoại lệ.
- Cấm `drizzle-kit push` thủ công (kể cả dev) khi chưa hiểu diff — bảng runtime-managed
  không nằm hết trong Drizzle schema là bị đề xuất DROP.
- Schema mới phải áp **CẢ DEV DB lẫn PROD** (additive) trước khi Republish — xem sự cố 13/07.
