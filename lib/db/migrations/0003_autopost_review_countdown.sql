-- 0003_autopost_review_countdown.sql
-- Tính năng "AutoPost Review Countdown" (cửa sổ kiểm duyệt 30' trước khi tự đăng).
--
-- LƯU Ý VẬN HÀNH: 2 cột dưới đây ĐÃ được thêm tự động (idempotent) lúc API khởi
-- động qua ensureAutoPostSchema() — xem artifacts/api-server/src/lib/autopost-schema.ts.
-- File này CHỈ để version-control / chạy tay khi cần; KHÔNG bắt buộc chạy trên prod
-- và KHÔNG nằm trong db push. An toàn chạy lại nhiều lần (IF NOT EXISTS).

ALTER TABLE autopost_posts ADD COLUMN IF NOT EXISTS editing_until timestamptz;
ALTER TABLE autopost_posts ADD COLUMN IF NOT EXISTS auto_paused boolean NOT NULL DEFAULT false;

-- (Không thêm status mới ở cấp DB: cột status là text; giá trị 'review_pending'
--  chỉ là một giá trị hợp lệ mới ở tầng ứng dụng — POST_STATUSES.)
