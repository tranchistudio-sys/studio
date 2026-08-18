# Amazing Studio

Hệ thống quản lý studio dùng React/Vite, Express/Node.js 24, PNPM và PostgreSQL.
Production là `https://tranchistudio.com`; GitHub là source of truth và deploy chỉ
được thực hiện bằng GitHub Actions theo commit SHA.

## Kiến trúc dữ liệu

- `DATABASE_URL`: database nghiệp vụ hiện tại của Amazing Studio. PR1 không copy,
  reset, seed đè hoặc thay thế database này.
- `PLATFORM_DATABASE_URL`: database điều khiển riêng cho user, Google identity,
  tenant, membership, invitation, server session và audit log.
- `DEFAULT_TENANT_DATABASE_URL`: secret reference runtime trỏ lại đúng database
  Amazing hiện tại. URL/password không được lưu trong platform database.

Xem [kiến trúc multi-tenant](docs/multitenant-architecture.md) và
[Google authentication](docs/google-auth.md).

## Chạy local

Yêu cầu Node.js 24, PNPM 10.34.5 và hai PostgreSQL database local tách biệt.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm --filter @workspace/platform-db migrate
pnpm dev:api
pnpm dev:web
```

Lệnh `platform-db migrate` là thao tác explicit. App không tự chạy platform
migration khi startup, build hoặc deploy.

## Kiểm tra

```bash
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/amazing-studio test
pnpm --filter @workspace/api-server test:platform
pnpm run build:deploy
pnpm deploy:guard
```

`test:platform` chỉ chấp nhận database có hậu tố `_test` và bắt buộc platform DB
khác tenant DB.

## Deploy

Không sửa source trực tiếp tại `/opt/amazing-studio/app`. Xem
[deploy và rollback](docs/deploy-and-rollback.md). Workflow production là thủ
công, yêu cầu nhập commit SHA/ref và xác nhận `DEPLOY`; workflow không chạy
migration production.
