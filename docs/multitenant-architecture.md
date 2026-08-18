# Multi-tenant architecture

## Quyết định

SaaS dùng mô hình **control-plane database + database-per-tenant**. Không thêm
`tenant_id` vào mọi bảng nghiệp vụ trong một database dùng chung.

```mermaid
flowchart TD
  B["Browser"] --> A["Express API"]
  A --> P["Platform DB"]
  P --> C["Verified session + membership"]
  C --> R["Tenant DB router"]
  R --> T1["Amazing DB hiện tại"]
  R --> T2["Studio B DB - PR2+"]
```

Platform DB chỉ chứa control-plane data:

- `platform_users`, `auth_identities`
- `tenants`, `tenant_memberships`, `tenant_invitations`
- `tenant_database_registry`, `sessions`, `platform_audit_logs`
- `plans`, `subscriptions`, `provisioning_jobs`

Booking, customer, service, payment, debt, calendar, rental và dữ liệu vận hành
luôn nằm trong tenant database.

## Amazing Studio là tenant đầu tiên

Tenant có `name=Amazing Studio`, `slug=amazing-studio`, `status=active`.
Registry lưu metadata không nhạy cảm và `secret_ref=env:DEFAULT_TENANT_DATABASE_URL`.
Database production hiện tại được giữ nguyên; PR1 không copy, migrate nghiệp vụ,
seed hay tạo database trắng thay thế.

PR1 chỉ cho phép business request khi registry xác nhận active tenant là reference
`amazing-studio-current-production`. Tenant database khác trả 503, không fallback
sang Amazing. Pool router database-per-tenant và cross-tenant repository refactor
thuộc PR2.

## Identity và quyền

Hai lớp quyền độc lập:

| Lớp | Role | Phạm vi |
|---|---|---|
| Platform | `PLATFORM_OWNER` | Chủ phần mềm, tenant/provisioning toàn nền tảng |
| Platform | `PLATFORM_ADMIN` | Quản trị SaaS được cấp sau này |
| Tenant | `OWNER` | Toàn quyền studio, member/role/session |
| Tenant | `ADMIN` | Quản trị studio; invite STAFF khi OWNER cấp permission |
| Tenant | `STAFF` | Chỉ module nghiệp vụ được cấp; không quản trị membership |

`staff.role/roles` trong tenant DB vẫn là vai trò nghiệp vụ. Membership liên kết
bằng `tenant_staff_id`; không có foreign key xuyên database. API compatibility
giữ `user.id = tenant_staff_id`, đồng thời trả riêng `platformUserId` và
`tenantMembershipId`.

Không thể sửa `PLATFORM_OWNER` qua member API. Thay role/khóa OWNER cuối cùng bị
chặn trong transaction có advisory lock.

## Session và request boundary

- Cookie opaque 256-bit; database chỉ lưu SHA-256 hash.
- Cookie production: HttpOnly, Secure, SameSite=Lax, Path `/`, không set Domain.
- Session rotate sau login; logout hiện tại, logout-all và revoke từng session.
- Thu hồi do đổi role/khóa thành viên được scope theo membership của studio bằng
  `auth_version` và `sessions_revoked_at`; quản trị studio A không làm đăng xuất
  phiên đang hoạt động hợp lệ của cùng người dùng tại studio B.
- Mỗi request kiểm tra lại session, platform user, tenant, membership và tenant
  staff còn active.
- Tenant lấy từ server session; body/query/header client không được dùng để chọn DB.
- Unsafe business request được bảo vệ bằng SameSite + exact same-origin check;
  auth/member mutation còn yêu cầu CSRF token riêng.
- API nghiệp vụ mặc định-deny; public routes được allowlist theo method + exact path.
- Platform DB hoặc tenant DB lỗi trả lỗi rõ ràng và fail closed.

PR1 tạo legacy JWT bridge 60 giây chỉ bên trong request để route cũ tiếp tục dùng
`verifyToken`; token không trả frontend, không lưu localStorage và không log.
Tenant role trong bridge là trần quyền cho các helper đã refactor. PR2 sẽ bỏ bridge
khi repository/service nhận tenant context trực tiếp.

## Frontend cache isolation

React Query cache được xóa trước khi render user/tenant mới ở login, logout và
studio switch. PR2 sẽ namespace query keys bằng `activeTenantId`; xóa cache trong
PR1 ngăn dữ liệu tenant/user trước lóe sang phiên tiếp theo.
