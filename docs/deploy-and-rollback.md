# Deploy and rollback

## Nguyên tắc

- GitHub là source of truth; không sửa code trực tiếp trên VPS.
- Workflow production chỉ chạy thủ công và deploy đúng commit SHA/ref đã test.
- Workflow code deploy không chạy platform migration, tenant migration, `db push`
  hay seed.
- PR1 không migration database nghiệp vụ Amazing Studio.
- Platform migration production là một change riêng, cần owner xác nhận rõ ràng.

## Chuẩn bị production (chưa được tự thực hiện)

Trước lần migration platform đầu tiên:

1. Xác nhận backup gần nhất có thể restore.
2. Tạo backup bổ sung của database Amazing hiện tại và lưu ngoài release folder.
3. Ghi baseline read-only:

   ```sql
   SELECT count(*) FROM customers;
   SELECT count(*) FROM bookings;
   SELECT count(*) FROM payments;
   ```

4. Tạo database riêng, ví dụ `amazing_platform`; không dùng database Amazing.
5. Cấp runtime user chỉ trên platform DB; cấu hình secret/env ngoài Git:
   `PLATFORM_DATABASE_URL`, `DEFAULT_TENANT_DATABASE_URL`, `SESSION_SECRET`,
   `GOOGLE_CLIENT_ID`, `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_TENANT_STAFF_ID`,
   `PUBLIC_TENANT_HOST_MAP` (hoặc `PUBLIC_TENANT_SLUG` cho một domain).
6. Kiểm tra hai URL không trỏ cùng database.
7. Sau khi owner duyệt, chạy explicit một lần từ release đã review:
   `pnpm --filter @workspace/platform-db migrate`.
8. Migration runner dừng nếu phát hiện bảng nghiệp vụ, kiểm checksum và chỉ dùng
   additive SQL. Platform hiện gồm `0001_platform_foundation.sql`,
   `0002_membership_session_revocation.sql` và
   `0003_tenant_database_registry_isolation.sql`; migration 0003 chỉ thêm unique
   index chặn hai tenant dùng chung database vật lý, không migration database
   nghiệp vụ.
9. Với mỗi studio mới, tạo database/role/secret riêng; registry phải khớp đúng
   host, database và role của URL. Không tái dùng `DEFAULT_TENANT_DATABASE_URL`.

Không gửi URL/password vào log, PR, issue hay chat. Compose runtime tại
`/opt/amazing-studio/app/06_vps_deployment/docker-compose.yml` nằm ngoài repo;
phải cập nhật env trên VPS trước khi deploy code.

## Preview trên điện thoại

1. Mở GitHub trên điện thoại → Pull Requests → PR cần xem.
2. Chờ check `BUILD + TEST` xanh và bình luận `PREVIEW READY`.
3. Bấm `OPEN PREVIEW APP`, nhập Basic Auth preview.
4. Kiểm local login, responsive login, member page và studio selector.

Google login thật không chạy trên dynamic PR preview mặc định; xem điều kiện
staging ổn định tại [google-auth.md](google-auth.md#preview-trên-điện-thoại).

## Deploy bằng điện thoại sau khi được duyệt

1. Merge PR khi toàn bộ required checks PASS.
2. Ghi SHA của merge commit và SHA production hiện tại để rollback.
3. GitHub → Actions → **Deploy VPS (code-only)** → **Run workflow**.
4. Nhập merge commit SHA vào `ref`, nhập chính xác `DEPLOY` vào `confirm`.
5. Theo dõi ba job validate, verify và deploy. Không đóng màn hình để “cứu” job;
   workflow có timeout và tự rollback image khi health check lỗi.

## Smoke test sau deploy

- Container `web` healthy và không restart loop.
- `GET https://tranchistudio.com/api/healthz` trả `status=ok`.
- Sau khi đăng nhập, `GET /api/readyz` trả `status=ready` (platform schema và
  database tenant đều kết nối được).
- Website tải được trên mobile.
- Local login tạo server session.
- Google OWNER login và invitation login.
- Unknown Gmail bị từ chối.
- Tenant resolution đúng; suspended membership bị chặn.
- Hai tenant canary cùng ID vẫn trả dữ liệu riêng; header/body/query giả tenant
  không đổi database; registry/secret lỗi trả 503 và không lộ URL.
- Upload/media mới có prefix tenant; đổi studio khi queue đang chạy không gắn file
  của studio cũ vào studio mới.
- Database Amazing còn kết nối và baseline customer/booking/payment không giảm.
- Runtime đang chạy đúng SHA đã nhập.

## Rollback

Nếu smoke test lỗi:

1. Dừng rollout, lưu log đã lọc secret và xác định SHA lỗi.
2. Chạy lại workflow với `ref` là SHA production trước đó và `confirm=DEPLOY`.
3. Xác nhận health, website, local login và baseline counts.
4. Không rollback bằng cách xóa bảng/cột/dữ liệu platform mới. Migration additive
   tương thích ngược nên code cũ có thể bỏ qua bảng mới.
5. Nếu platform DB không sẵn sàng, rollback code và tắt platform env để trở về
   local login legacy có kiểm soát. Khi platform DB đang bật, Bearer cũ luôn bị
   từ chối để khóa/revoke session không thể bị bypass.

Không chạy production migration hoặc deploy cho đến khi có lệnh xác nhận riêng.
