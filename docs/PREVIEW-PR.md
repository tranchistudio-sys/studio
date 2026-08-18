# Xem thử app trên điện thoại trước khi Merge

Từ nay mỗi Pull Request tự có **một bản app chạy thật, một đường link riêng**, mở
được bằng iPhone. Chủ không cần mở máy tính để kiểm tra.

## Chủ dùng hàng ngày (chỉ 4 bước)

1. Mở GitHub trên iPhone → vào Pull Request.
2. Xem bình luận **“📱 Bản xem thử cho PR này”**:

   ```
   ✅ BUILD
   ✅ TEST
   ✅ PREVIEW READY
   🔗 OPEN PREVIEW APP
   ```

3. Bấm **OPEN PREVIEW APP** → nhập mật khẩu xem thử (hỏi 1 lần) → dùng app như thật.
4. Kết luận:
   - Có lỗi → **KHÔNG MERGE**, nhắn Claude sửa. Claude push lại trên **cùng nhánh**,
     bình luận tự cập nhật, link cũ giữ nguyên, chỉ cần tải lại trang.
   - Ổn → chủ tự bấm **Merge**. (Claude không bao giờ tự merge.)

Sau khi merge, **production KHÔNG tự đổi**. Muốn lên production thì làm riêng theo
[DEPLOY-CODE-ONLY.md](DEPLOY-CODE-ONLY.md) và chỉ khi chủ ra lệnh.

Nếu bình luận báo ❌ hoặc ⛔ thì chưa có link — nghĩa là code còn hỏng, **không được Merge**.

## Bản xem thử an toàn tới mức nào

| Rủi ro | Cách chặn |
|---|---|
| Nối nhầm database production | `preview-guard.ts` chỉ cho phép đúng host + tên database ghi trong allowlist. Sai → app **không khởi động**. Không dùng ký tự đại diện vì database production của Replit cũng nằm trên Neon. |
| Allowlist bị điền nhầm | `preview-db-marker.ts` bắt buộc database phải có bảng `preview_db_marker` do script seed tạo ra. Production không có bảng này. |
| Lộ thông tin khách | Dữ liệu xem thử **đã che** tên, SĐT, email, địa chỉ, ID Facebook, toàn bộ nội dung hội thoại. Script tự kiểm chứng lại, còn sót là dừng. |
| Nhắn Facebook / ghi Drive / đẩy push / gọi AI mất tiền | 2 lớp: xoá sạch env (`preview-guard.ts`) **và** chặn mọi kết nối HTTP ra ngoài (`preview-net-guard.ts`, mặc định CẤM). Token nằm trong database cũng vô dụng vì bị chặn ở tầng mạng và bị script seed xoá. |
| Người lạ mở link | Basic Auth phủ toàn site (`preview-basic-auth.ts`), kèm `X-Robots-Tag: noindex`. |
| Tốn tiền server | Máy tự ngủ khi không ai dùng; đóng PR là app bị **xoá hẳn**. |

Dynamic PR preview **không kiểm tra Google login hoặc trang platform**. Workflow
fail-closed bằng cách xóa và kiểm chứng không còn các Fly secret platform,
Google và bootstrap từ lần deploy trước. Chỉ local login được bật. Google login
thật cần staging hostname cố định cùng platform DB và tenant DB test tách biệt;
xem [google-auth.md](google-auth.md#preview-trên-điện-thoại).

Mật khẩu đăng nhập *bên trong* app xem thử được script seed đặt lại — **mật khẩu
production không dùng trên hạ tầng xem thử**.

---

## Cài đặt một lần (kỹ thuật)

### 1. GitHub Secrets (Settings → Secrets and variables → Actions)

| Tên | Kiểu | Nội dung |
|---|---|---|
| `FLY_API_TOKEN` | Secret | Token deploy của Fly.io |
| `PREVIEW_DATABASE_URL` | Secret | Chuỗi kết nối database preview (Neon) |
| `PREVIEW_DB_HOST_ALLOWLIST` | Secret | `ep-xxx.aws.neon.tech/amazing_preview` |
| `PREVIEW_SESSION_SECRET` | Secret | Chuỗi ngẫu nhiên ≥ 32 ký tự, **khác** production |
| `PREVIEW_BASIC_AUTH_PASS` | Secret | Mật khẩu mở bản xem thử |
| `PREVIEW_BASIC_AUTH_USER` | Variable | Tuỳ chọn, mặc định `amazing` |
| `FLY_ORG` | Variable | Tuỳ chọn, mặc định `personal` |

### 2. Dựng database preview (chạy trên máy studio, **không** chạy trong CI)

Tạo `.env.preview` ở gốc repo (đã nằm trong `.gitignore`):

```
PREVIEW_DATABASE_URL=postgresql://...@ep-xxx.aws.neon.tech/amazing_preview?sslmode=require
PREVIEW_DB_HOST_ALLOWLIST=ep-xxx.aws.neon.tech/amazing_preview
SOURCE_DATABASE_URL=postgresql://postgres:...@localhost:5432/amazing_studio
```

Rồi chạy:

```bash
node scripts/seed-preview-db.mjs --source-url="$SOURCE_DATABASE_URL" --yes
```

Script sẽ: nạp dữ liệu → che danh tính khách → xoá secret trong database → xoá
đăng ký push → đặt lại mật khẩu đăng nhập → **kiểm chứng** không còn SĐT/email
thật → đánh dấu database là preview. Bất kỳ bước nào không đạt là dừng, không đánh dấu.

Chạy lại bất cứ lúc nào để làm mới dữ liệu xem thử.

### 3. Bảo vệ nhánh `main`

GitHub → Settings → Rules → New ruleset, áp cho `main`:
- Require a pull request before merging
- Require status checks to pass → chọn **BUILD + TEST**
- Block force pushes

### Muốn bỏ qua bản xem thử cho một PR nào đó
Đóng PR (app bị xoá) hoặc để PR ở dạng Draft nếu chưa cần xem.

## File liên quan

| File | Việc |
|---|---|
| `.github/workflows/pr-preview.yml` | BUILD + TEST → dựng preview → bình luận vào PR → xoá khi đóng PR |
| `Dockerfile`, `.dockerignore`, `fly.toml` | Đóng gói 1 container = toàn bộ app |
| `artifacts/api-server/src/lib/preview-guard.ts` | Chốt database + dọn env side effect |
| `artifacts/api-server/src/lib/preview-net-guard.ts` | Chặn mọi kết nối ra ngoài (mặc định CẤM) |
| `artifacts/api-server/src/lib/preview-basic-auth.ts` | Mật khẩu phủ toàn bản xem thử |
| `artifacts/api-server/src/lib/preview-db-marker.ts` | Bắt buộc database có dấu “đây là preview” |
| `scripts/seed-preview-db.mjs` | Dựng + che dữ liệu database preview |
