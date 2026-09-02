# Dockerfile — CHỈ dùng cho fixed Preview slot (VPS; legacy Fly rollback compatible).
#
# Production chạy bằng image/compose riêng và KHÔNG dùng file này.
#
# Một container = TOÀN BỘ app: backend Express phục vụ luôn frontend đã build
# (xem artifacts/api-server/src/lib/serve-frontend.ts — "Cách C", single origin),
# nên bản xem thử chỉ có MỘT URL duy nhất, giống hệt cách prod đang chạy.

# ── Giai đoạn BUILD: dùng image node đầy đủ (có sẵn công cụ biên dịch) ────────
FROM node:24 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

WORKDIR /app
COPY . .

# --frozen-lockfile: đúng y hệt pnpm-lock.yaml, không tự nâng phiên bản.
RUN pnpm install --frozen-lockfile

# build:deploy = api-server (esbuild, có chạy scripts/deploy-guard.mjs) + frontend (vite).
RUN pnpm run build:deploy

# ── Giai đoạn CHẠY: image gọn hơn ─────────────────────────────────────────────
FROM node:24-slim AS runner
ENV NODE_ENV=production
ENV PORT=8080
# PREVIEW_MODE bật toàn bộ chốt an toàn trong preview-guard/preview-net-guard/
# preview-basic-auth. Production KHÔNG BAO GIỜ đặt biến này.
ENV PREVIEW_MODE=1

WORKDIR /app

# Chép nguyên cây thư mục đã build sang. Cố tình KHÔNG chép lẻ từng thư mục:
# pnpm dùng symlink (node_modules/.pnpm → workspace), chép lẻ rất dễ đứt liên kết
# và chỉ phát hiện được lúc chạy. Bản xem thử ưu tiên CHẮC CHẮN CHẠY ĐƯỢC hơn là
# tiết kiệm dung lượng. Ảnh thật của studio (artifacts/data/object-storage) cũng
# đi kèm, nên preview hiển thị đúng như production.
COPY --from=build /app /app

EXPOSE 8080
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
