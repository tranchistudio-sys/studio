#!/usr/bin/env bash
set -Eeuo pipefail

# Bật Platform DB + Google Identity cho production mà không thay đổi tenant DB.
# Script chỉ được gọi từ workflow thủ công sau khi code platform đã deploy.

CONFIG_FILE="${AMAZING_DEPLOY_CONFIG:-/opt/amazing-studio/deploy.conf}"
MIGRATIONS_ARCHIVE="${1:-}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
BOOTSTRAP_OWNER_EMAIL="${BOOTSTRAP_OWNER_EMAIL:-}"
PLATFORM_DB_NAME="${PLATFORM_DB_NAME:-amazing_platform}"
PLATFORM_ENV_FILE="/opt/amazing-studio/platform-auth.env"
PLATFORM_OVERRIDE_FILE="/opt/amazing-studio/platform-auth.override.yml"
BACKUP_DIR="/opt/amazing-studio/backups"
LOCK_FILE="/tmp/amazing-studio-platform-auth.lock"

die() { echo "[platform-auth] ERROR: $*" >&2; exit 1; }

[ -r "$CONFIG_FILE" ] || die "Thiếu cấu hình deploy VPS"
# shellcheck disable=SC1090
source "$CONFIG_FILE"
: "${DEPLOY_COMPOSE_FILE:?Thiếu DEPLOY_COMPOSE_FILE}"
: "${DEPLOY_WEB_SERVICE:?Thiếu DEPLOY_WEB_SERVICE}"
: "${DEPLOY_HEALTH_URL:?Thiếu DEPLOY_HEALTH_URL}"
: "${DEPLOY_WEB_URL:?Thiếu DEPLOY_WEB_URL}"
[ -n "$MIGRATIONS_ARCHIVE" ] && [ -r "$MIGRATIONS_ARCHIVE" ] || die "Thiếu gói migration"
[[ "$GOOGLE_CLIENT_ID" == *.apps.googleusercontent.com ]] || die "GOOGLE_CLIENT_ID không hợp lệ"
[[ "$BOOTSTRAP_OWNER_EMAIL" == *@*.* ]] || die "BOOTSTRAP_OWNER_EMAIL không hợp lệ"
[[ "$PLATFORM_DB_NAME" =~ ^[a-z][a-z0-9_]{2,62}$ ]] || die "Tên platform database không hợp lệ"

for tool in docker curl flock sha256sum tar sudo; do
  command -v "$tool" >/dev/null || die "VPS thiếu $tool"
done
sudo -n true >/dev/null || die "User deploy thiếu sudo không mật khẩu"

exec 9>"$LOCK_FILE"
flock -n 9 || die "Đang có deploy hoặc cấu hình platform khác chạy"

WEB_CID=$(docker compose -f "$DEPLOY_COMPOSE_FILE" ps -q "$DEPLOY_WEB_SERVICE")
[ -n "$WEB_CID" ] || die "Không tìm thấy container web production"
WEB_NETWORK=$(docker inspect "$WEB_CID" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' | head -n 1)
[ -n "$WEB_NETWORK" ] || die "Không xác định được Docker network production"

read_web_env() {
  docker inspect "$WEB_CID" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n "s/^$1=//p" | head -n 1
}

DATABASE_URL=$(read_web_env DATABASE_URL)
SESSION_SECRET=$(read_web_env SESSION_SECRET)
[ -n "$DATABASE_URL" ] || die "Container web thiếu DATABASE_URL"
[ -n "$SESSION_SECRET" ] || die "Container web thiếu SESSION_SECRET; từ chối tự đổi secret production"

url_for_database() {
  docker exec -e SOURCE_DATABASE_URL="$DATABASE_URL" -e TARGET_DATABASE="$1" "$WEB_CID" \
    node -e 'const u=new URL(process.env.SOURCE_DATABASE_URL);u.pathname=`/${process.env.TARGET_DATABASE}`;process.stdout.write(u.toString())'
}

ADMIN_DATABASE_URL=$(url_for_database postgres)
PLATFORM_DATABASE_URL=$(url_for_database "$PLATFORM_DB_NAME")
[ "$PLATFORM_DATABASE_URL" != "$DATABASE_URL" ] || die "Platform DB trùng tenant DB"

PG_IMAGE="postgres:16-alpine"
docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || docker pull "$PG_IMAGE" >/dev/null

sudo -n install -d -m 750 -o root -g root "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_TMP="/tmp/amazing-studio-before-platform-$STAMP.dump"
BACKUP_FINAL="$BACKUP_DIR/tenant-before-platform-$STAMP.dump"
echo "[platform-auth] Tạo backup tenant database trước khi cấu hình"
docker run --rm --network "$WEB_NETWORK" -e TARGET_URL="$DATABASE_URL" "$PG_IMAGE" \
  sh -c 'pg_dump --format=custom --no-owner --no-acl "$TARGET_URL"' > "$BACKUP_TMP"
[ -s "$BACKUP_TMP" ] || die "Backup tenant database rỗng"
sudo -n install -m 600 -o root -g root "$BACKUP_TMP" "$BACKUP_FINAL"
rm -f "$BACKUP_TMP"

COUNTS=$(docker run --rm --network "$WEB_NETWORK" -e TARGET_URL="$DATABASE_URL" "$PG_IMAGE" sh -c \
  'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -Atqc "SELECT (SELECT count(*) FROM customers),(SELECT count(*) FROM bookings),(SELECT count(*) FROM payments)"')
echo "[platform-auth] Baseline customers,bookings,payments: $COUNTS"

DB_EXISTS=$(docker run --rm --network "$WEB_NETWORK" \
  -e TARGET_URL="$ADMIN_DATABASE_URL" -e TARGET_DB="$PLATFORM_DB_NAME" "$PG_IMAGE" sh -c \
  'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -v db_name="$TARGET_DB" -Atqc "SELECT 1 FROM pg_database WHERE datname = :'\''db_name'\''"')
if [ "$DB_EXISTS" != "1" ]; then
  echo "[platform-auth] Tạo database riêng $PLATFORM_DB_NAME"
  docker run --rm --network "$WEB_NETWORK" \
    -e TARGET_URL="$ADMIN_DATABASE_URL" -e TARGET_DB="$PLATFORM_DB_NAME" "$PG_IMAGE" sh -c \
    'createdb --maintenance-db="$TARGET_URL" "$TARGET_DB"'
else
  echo "[platform-auth] Database $PLATFORM_DB_NAME đã tồn tại; kiểm tra và tiếp tục idempotent"
fi

BUSINESS_TABLES=$(docker run --rm --network "$WEB_NETWORK" \
  -e TARGET_URL="$PLATFORM_DATABASE_URL" "$PG_IMAGE" sh -c \
  'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -Atqc "SELECT count(*) FROM (VALUES (to_regclass('\''public.customers'\'')),(to_regclass('\''public.bookings'\'')),(to_regclass('\''public.payments'\''))) AS t(x) WHERE x IS NOT NULL"')
[ "$BUSINESS_TABLES" = "0" ] || die "Platform DB có bảng nghiệp vụ; từ chối migration"

MIGRATIONS_DIR=$(mktemp -d /tmp/amazing-platform-migrations.XXXXXX)
trap 'rm -rf "$MIGRATIONS_DIR"' EXIT
tar -xzf "$MIGRATIONS_ARCHIVE" -C "$MIGRATIONS_DIR"
mapfile -t MIGRATIONS < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '[0-9]*.sql' -printf '%f\n' | sort)
[ "${#MIGRATIONS[@]}" -gt 0 ] || die "Không tìm thấy platform migration"

docker run --rm --network "$WEB_NETWORK" \
  -e TARGET_URL="$PLATFORM_DATABASE_URL" "$PG_IMAGE" sh -c \
  'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS platform_schema_migrations (filename TEXT PRIMARY KEY, checksum_sha256 TEXT, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"' >/dev/null

for migration in "${MIGRATIONS[@]}"; do
  checksum=$(sha256sum "$MIGRATIONS_DIR/$migration" | awk '{print $1}')
  recorded=$(docker run --rm --network "$WEB_NETWORK" \
    -e TARGET_URL="$PLATFORM_DATABASE_URL" -e FILE_NAME="$migration" "$PG_IMAGE" sh -c \
    'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -v file_name="$FILE_NAME" -Atqc "SELECT coalesce(checksum_sha256, '\'''\'') FROM platform_schema_migrations WHERE filename = :'\''file_name'\''"')
  if [ -n "$recorded" ]; then
    [ "$recorded" = "$checksum" ] || die "Checksum migration đã đổi: $migration"
    echo "[platform-auth] Đã có $migration"
    continue
  fi
  echo "[platform-auth] Áp dụng $migration"
  docker run --rm --network "$WEB_NETWORK" \
    -e TARGET_URL="$PLATFORM_DATABASE_URL" -e FILE_NAME="$migration" -e CHECKSUM="$checksum" \
    -v "$MIGRATIONS_DIR:/migrations:ro" "$PG_IMAGE" sh -c \
    'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -1 -f "/migrations/$FILE_NAME" && psql "$TARGET_URL" -v ON_ERROR_STOP=1 -v file_name="$FILE_NAME" -v checksum="$CHECKSUM" -c "INSERT INTO platform_schema_migrations(filename, checksum_sha256) VALUES (:'\''file_name'\'', :'\''checksum'\'')"' >/dev/null
done

ADMIN_STAFF_ID=$(docker run --rm --network "$WEB_NETWORK" \
  -e TARGET_URL="$DATABASE_URL" "$PG_IMAGE" sh -c \
  'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -Atqc "SELECT id FROM staff WHERE is_active = 1 AND (role = '\''admin'\'' OR roles::text LIKE '\''%admin%'\'') ORDER BY id LIMIT 1"')
[[ "$ADMIN_STAFF_ID" =~ ^[0-9]+$ ]] || die "Không tìm thấy admin staff đang hoạt động"

ENV_TMP=$(mktemp /tmp/amazing-platform-auth.env.XXXXXX)
OVERRIDE_TMP=$(mktemp /tmp/amazing-platform-auth.override.XXXXXX)
chmod 600 "$ENV_TMP"
{
  printf 'PLATFORM_DATABASE_URL=%s\n' "$PLATFORM_DATABASE_URL"
  printf 'DEFAULT_TENANT_DATABASE_URL=%s\n' "$DATABASE_URL"
  printf 'SESSION_SECRET=%s\n' "$SESSION_SECRET"
  printf 'GOOGLE_CLIENT_ID=%s\n' "$GOOGLE_CLIENT_ID"
  printf 'BOOTSTRAP_OWNER_EMAIL=%s\n' "$BOOTSTRAP_OWNER_EMAIL"
  printf 'BOOTSTRAP_TENANT_STAFF_ID=%s\n' "$ADMIN_STAFF_ID"
  printf 'PUBLIC_TENANT_SLUG=amazing-studio\n'
} > "$ENV_TMP"
cat > "$OVERRIDE_TMP" <<'YAML'
services:
  web:
    env_file:
      - /opt/amazing-studio/platform-auth.env
YAML

sudo -n install -m 600 -o "$(id -un)" -g "$(id -gn)" "$ENV_TMP" "$PLATFORM_ENV_FILE"
sudo -n install -m 644 -o root -g root "$OVERRIDE_TMP" "$PLATFORM_OVERRIDE_FILE"
rm -f "$ENV_TMP" "$OVERRIDE_TMP"

echo "[platform-auth] Recreate duy nhất web với platform override"
docker compose -f "$DEPLOY_COMPOSE_FILE" -f "$PLATFORM_OVERRIDE_FILE" \
  up -d --no-deps --force-recreate "$DEPLOY_WEB_SERVICE"

for attempt in $(seq 1 24); do
  health=$(curl -fsS --max-time 15 "$DEPLOY_HEALTH_URL" 2>/dev/null || true)
  config=$(curl -fsS --max-time 15 "$DEPLOY_WEB_URL/api/auth/config" 2>/dev/null || true)
  if [[ "$health" == *'"status":"ok"'* ]] && \
     [[ "$config" == *'"platformEnabled":true'* ]] && \
     [[ "$config" == *'"googleEnabled":true'* ]] && \
     [[ "$config" == *'"registrationEnabled":true'* ]]; then
    echo "[platform-auth] SUCCESS: health, Google login và đăng ký đều đã bật"
    rm -f "$MIGRATIONS_ARCHIVE"
    exit 0
  fi
  echo "[platform-auth] Chờ web sẵn sàng $attempt/24"
  sleep 5
done

die "Web chưa xác nhận đủ platformEnabled/googleEnabled/registrationEnabled"
