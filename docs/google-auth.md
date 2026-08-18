# Google authentication (Google Identity Services)

## Luồng đã triển khai

1. Login page lấy public config và login-CSRF từ `GET /api/auth/config`.
2. Frontend render nút chính thức bằng `google.accounts.id.renderButton`.
3. GIS trả ID token cho callback; frontend gửi đúng một request
   `POST /api/auth/google` với `{ credential, loginCsrfToken }`.
4. Backend dùng `google-auth-library` và `verifyIdToken({ idToken, audience })`.
   Thư viện kiểm chữ ký, issuer, audience và expiration; code bắt buộc có `sub`,
   `email` và `email_verified === true`.
5. Google `sub` là identity key. Email chỉ dùng để đối chiếu bootstrap/invitation.
6. Backend không lưu ID token, access token, refresh token hay Google password;
   chỉ lưu `sub`, email đã xác minh, tên và avatar.
7. Login thành công rotate sang opaque server session trong cookie HttpOnly.

Tài khoản lạ không được tự đăng ký. Nếu không có Google identity hiện hữu,
bootstrap hợp lệ hoặc invitation còn hạn, backend trả:

> Tài khoản Google này chưa được cấp quyền sử dụng Amazing Studio. Vui lòng liên hệ quản trị viên.

Tài liệu Google chính thức:

- [Verify the Google ID token on the server](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
- [Display the official Sign in with Google button](https://developers.google.com/identity/gsi/web/guides/display-button)
- [Get a Google API client ID](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)

## Cấu hình Google Cloud

1. Mở Google Cloud Console, chọn/tạo project dành cho Amazing Studio SaaS.
2. Cấu hình OAuth consent screen với thông tin app và domain đã xác minh.
3. Tạo OAuth Client ID loại **Web application** dành riêng cho GIS login.
4. Thêm Authorized JavaScript origins chính xác:
   - `https://tranchistudio.com`
   - origin staging ổn định nếu có
   - `http://localhost:5173` chỉ cho local development
5. Không thêm Gmail, Contacts, Drive hoặc Calendar scope. GIS login chỉ cần thông
   tin OpenID cơ bản do Google trả.
6. Đặt Client ID vào secret/env `GOOGLE_CLIENT_ID`. GIS flow này không cần
   `GOOGLE_CLIENT_SECRET` và không có redirect URI backend.

Google Drive AutoPost phải dùng `GOOGLE_DRIVE_CLIENT_ID` và
`GOOGLE_DRIVE_CLIENT_SECRET` riêng. Không tái sử dụng OAuth client của login.

## Bootstrap OWNER Amazing Studio

Đặt trên môi trường runtime, không commit:

```dotenv
BOOTSTRAP_OWNER_EMAIL=owner@example.com
BOOTSTRAP_TENANT_STAFF_ID=123
```

Lần Google login đầu tiên bằng đúng email đã xác minh:

- tạo/link platform user và Google identity;
- nâng membership liên kết lên `OWNER`;
- cấp `PLATFORM_OWNER` cho chủ nền tảng;
- ghi `bootstrap_completed_at` và `bootstrap_owner_user_id`.

Nếu đã local-login trước đó, bootstrap liên kết đúng platform user đang gắn với
staff record, không tạo user OWNER trùng. Sau khi đã bootstrap, đổi biến email
không tự cấp OWNER cho người khác.

## Invitation MVP

OWNER tạo hồ sơ nhân sự nghiệp vụ trước, sau đó nhập Gmail + role tại trang
`/members`. Invitation lưu email chuẩn hóa, role, staff reference, hạn 7 ngày,
status và audit; không có token rõ trong database. Người được mời chỉ cần login
đúng Gmail. MVP chưa gửi email mời.

## Preview trên điện thoại

PR preview hiện có hostname động `pr-N-amazing-studio.fly.dev` và không có
platform database riêng được kiểm chứng độc lập. Workflow chủ động xóa mọi Fly
secret `PLATFORM_DATABASE_URL`, `DEFAULT_TENANT_DATABASE_URL`, `GOOGLE_CLIENT_ID`
và bootstrap còn sót trước khi deploy. Vì vậy preview này chỉ kiểm tra local
login; nút Google và các trang platform được cố ý tắt, không tuyên bố Google
login thật hoạt động.

Muốn test Google thật phải có một staging hostname ổn định (khuyến nghị), đăng
ký chính xác origin đó trong Google Cloud, cấp **hai database test tách biệt**:
`STAGING_PLATFORM_DATABASE_URL` chỉ chứa platform schema và
`STAGING_TENANT_DATABASE_URL` chỉ chứa dữ liệu nghiệp vụ đã ẩn danh. Hai URL phải
có allowlist/marker riêng, khác nhau và khác mọi database production; sau đó mới
map chúng vào `PLATFORM_DATABASE_URL` / `DATABASE_URL` /
`DEFAULT_TENANT_DATABASE_URL`, cấu hình `GOOGLE_CLIENT_ID`, và allow đúng host
public certificate. Preview network guard chỉ tự mở hai đường dẫn certificate
Google cần cho việc xác minh ID token (`/oauth2/v1/certs` và
`/oauth2/v3/certs`) khi có `GOOGLE_CLIENT_ID`; không mở toàn bộ
`www.googleapis.com` và không mở Google Drive. Không dùng wildcard origin và
không dùng database/credential production.
