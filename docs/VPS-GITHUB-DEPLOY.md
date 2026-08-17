# GitHub → VPS (code-only)

Mục tiêu sau khi cài một lần:

1. Sửa code bằng điện thoại và đưa lên GitHub.
2. Mở **GitHub → Actions → Deploy VPS (code-only) → Run workflow**.
3. Nhập `main` và `DEPLOY`.
4. GitHub tự test, build, đưa đúng commit lên VPS, restart app và kiểm tra `/api/healthz`.

Workflow không chạy migration, `db push`, seed hay SQL. Nếu build/restart/health check hỏng,
script tự quay lại commit trước.

## Cài một lần trên VPS

Trước khi bật workflow, phải kiểm tra read-only để xác định app đang được quản lý bằng
`systemd`, `systemd --user`, `pm2` hay `docker compose`. Sau đó tạo file chỉ có trên VPS:

```ini
DEPLOY_APP_DIR=/opt/amazing-studio/app
DEPLOY_DRIVER=systemd
DEPLOY_SERVICE=TEN_DICH_VU_THAT.service
DEPLOY_HEALTH_URL=https://tranchistudio.com/api/healthz
```

Lưu tại `/opt/amazing-studio/deploy.conf`. Không đoán `DEPLOY_DRIVER` hoặc
`DEPLOY_SERVICE`: sai tên sẽ dừng trước khi thay đổi code.

Nếu dùng systemd hệ thống, user `deploy` còn cần quyền `sudo -n` giới hạn đúng hai thao tác
`systemctl show/restart TEN_DICH_VU_THAT.service`. Không cấp sudo toàn bộ.

## GitHub Secrets

Trong **Settings → Secrets and variables → Actions**, tạo:

- `VPS_HOST`: IP VPS.
- `VPS_USER`: `deploy`.
- `VPS_PORT`: thường là `22`.
- `VPS_SSH_PRIVATE_KEY`: private key dành riêng cho GitHub Actions, không phải public key `.pub`.

Public key tương ứng phải được thêm vào `/home/deploy/.ssh/authorized_keys` trên VPS.
Không gửi private key qua chat và không commit key vào Git.

## Vì sao chưa tự chạy sau mỗi merge?

Giai đoạn đầu workflow chỉ chạy thủ công để kiểm tra một lần trên production. Sau khi một lượt
deploy và rollback drill đều xanh, có thể thêm trigger `push` trên `main` để hoàn toàn tự động.
