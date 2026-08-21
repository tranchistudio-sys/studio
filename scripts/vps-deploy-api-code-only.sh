#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy duy nhất API từ release đã được web workflow chốt trên production.
# Không migration, không db push, không seed, không SQL và không thay database.

CONFIG_FILE="${AMAZING_DEPLOY_CONFIG:-/opt/amazing-studio/deploy.conf}"
PLATFORM_ENV_FILE="${AMAZING_PLATFORM_ENV_FILE:-/opt/amazing-studio/platform-auth.env}"
PLATFORM_OVERRIDE_FILE="${AMAZING_PLATFORM_OVERRIDE_FILE:-/opt/amazing-studio/platform-auth.override.yml}"
LOCK_FILE="${AMAZING_DEPLOY_LOCK:-/tmp/amazing-studio-deploy.lock}"
SESSION_TTL_HOURS="4320"

die() {
  echo "[deploy-api] ERROR: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || die "Cần commit SHA và GitHub run ID."
TARGET_SHA="$1"
RUN_ID="$2"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "Commit SHA không hợp lệ."
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || die "Run ID không hợp lệ."
[ -r "$CONFIG_FILE" ] || die "Thiếu cấu hình deploy production."
[ -r "$PLATFORM_ENV_FILE" ] || die "Thiếu platform-auth.env production."
[ -r "$PLATFORM_OVERRIDE_FILE" ] || die "Thiếu platform-auth.override.yml production."

# shellcheck disable=SC1090
source "$CONFIG_FILE"
: "${DEPLOY_COMPOSE_FILE:?Thiếu DEPLOY_COMPOSE_FILE}"
: "${DEPLOY_RELEASES_DIR:?Thiếu DEPLOY_RELEASES_DIR}"
: "${DEPLOY_HEALTH_URL:?Thiếu DEPLOY_HEALTH_URL}"
: "${DEPLOY_WEB_URL:?Thiếu DEPLOY_WEB_URL}"

for tool in docker curl flock sudo awk; do
  command -v "$tool" >/dev/null || die "VPS thiếu $tool."
done
sudo -n true >/dev/null || die "User deploy thiếu sudo không mật khẩu."

exec 9>"$LOCK_FILE"
flock -n 9 || die "Đang có lượt deploy production khác chạy."

DEPLOYED_SHA=$(sudo -n sed -n '1p' /opt/amazing-studio/DEPLOYED_SHA)
[ "$DEPLOYED_SHA" = "$TARGET_SHA" ] || \
  die "Web đang ở commit $DEPLOYED_SHA, không trùng API cần deploy $TARGET_SHA."

RELEASE_COMPOSE="$DEPLOY_RELEASES_DIR/$TARGET_SHA/06_vps_deployment/docker-compose.yml"
[ -r "$RELEASE_COMPOSE" ] || die "Không tìm thấy release đã kiểm thử: $TARGET_SHA."

compose_production() {
  sudo -n docker compose \
    -f "$DEPLOY_COMPOSE_FILE" \
    -f "$PLATFORM_OVERRIDE_FILE" "$@"
}

API_SERVICE=""
API_CID=""
while IFS= read -r service; do
  cid=$(compose_production ps -q "$service")
  [ -n "$cid" ] || continue
  if docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep -q '^DATABASE_URL='; then
    API_SERVICE="$service"
    API_CID="$cid"
    break
  fi
done < <(compose_production config --services)

[ -n "$API_SERVICE" ] && [ -n "$API_CID" ] || die "Không xác định được container API."
docker compose -f "$RELEASE_COMPOSE" config --services | grep -Fxq "$API_SERVICE" || \
  die "Release không có service API $API_SERVICE."

PREVIOUS_API_IMAGE_ID=$(docker inspect "$API_CID" --format '{{.Image}}')
API_IMAGE_NAME=$(docker inspect "$API_CID" --format '{{.Config.Image}}')
[ -n "$PREVIOUS_API_IMAGE_ID" ] && [ -n "$API_IMAGE_NAME" ] || \
  die "Không xác định được image API hiện tại."

ROLLBACK_API_IMAGE="amazing-studio-api:rollback"
ENV_BACKUP="/tmp/amazing-platform-auth-$RUN_ID.bak"
ENV_CANDIDATE="/tmp/amazing-platform-auth-$RUN_ID.new"
ENV_CHANGED=0
API_REPLACED=0
DEPLOY_FINISHED=0

sudo -n cp --preserve=mode,ownership,timestamps "$PLATFORM_ENV_FILE" "$ENV_BACKUP"
sudo -n awk '!/^PLATFORM_SESSION_TTL_HOURS=/' "$PLATFORM_ENV_FILE" > "$ENV_CANDIDATE"
printf 'PLATFORM_SESSION_TTL_HOURS=%s\n' "$SESSION_TTL_HOURS" >> "$ENV_CANDIDATE"
chmod 600 "$ENV_CANDIDATE"
docker tag "$PREVIOUS_API_IMAGE_ID" "$ROLLBACK_API_IMAGE"

health_ok() {
  local health config new_cid ttl
  health=$(curl -fsS --max-time 15 "$DEPLOY_HEALTH_URL" 2>/dev/null || true)
  config=$(curl -fsS --max-time 15 "$DEPLOY_WEB_URL/api/auth/config" 2>/dev/null || true)
  new_cid=$(compose_production ps -q "$API_SERVICE")
  ttl=$(docker inspect "$new_cid" --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | sed -n 's/^PLATFORM_SESSION_TTL_HOURS=//p' | head -n 1)
  [[ "$health" == *'"status":"ok"'* ]] &&
    [[ "$config" == *'"platformEnabled":true'* ]] &&
    [[ "$config" == *'"googleEnabled":true'* ]] &&
    [[ "$ttl" == "$SESSION_TTL_HOURS" ]]
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 24); do
    if health_ok; then
      echo "[deploy-api] API healthy; Google/platform bật; TTL=4320 giờ."
      return 0
    fi
    echo "[deploy-api] Health check $attempt/24 chưa đạt; chờ 5 giây..."
    sleep 5
  done
  return 1
}

rollback() {
  local status="$1"
  trap - ERR INT TERM HUP
  echo "[deploy-api] API mới không đạt; khôi phục image và cấu hình cũ." >&2
  if [ "$ENV_CHANGED" -eq 1 ] && sudo -n test -r "$ENV_BACKUP"; then
    sudo -n install -m 600 -o root -g root "$ENV_BACKUP" "$PLATFORM_ENV_FILE" || true
  fi
  docker tag "$ROLLBACK_API_IMAGE" "$API_IMAGE_NAME" || true
  if [ "$API_REPLACED" -eq 1 ]; then
    compose_production up -d --no-deps --force-recreate "$API_SERVICE" || true
  fi
  rm -f "$ENV_CANDIDATE"
  sudo -n rm -f "$ENV_BACKUP"
  exit "$status"
}

cleanup() {
  rm -f "$ENV_CANDIDATE"
  sudo -n rm -f "$ENV_BACKUP"
}
trap cleanup EXIT
trap 'status=$?; rollback "$status"' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM
trap 'rollback 129' HUP

echo "[deploy-api] Build API từ release $TARGET_SHA"
sudo -n docker compose -f "$RELEASE_COMPOSE" build "$API_SERVICE"

sudo -n install -m 600 -o root -g root "$ENV_CANDIDATE" "$PLATFORM_ENV_FILE"
ENV_CHANGED=1

echo "[deploy-api] Chỉ recreate service $API_SERVICE; web và database giữ nguyên."
API_REPLACED=1
compose_production up -d --no-deps --force-recreate "$API_SERVICE"
wait_for_health

printf '%s\n' "$TARGET_SHA" | sudo -n tee /opt/amazing-studio/API_DEPLOYED_SHA >/dev/null
DEPLOY_FINISHED=1
trap - ERR INT TERM HUP
cleanup
trap - EXIT
echo "[deploy-api] SUCCESS: API commit $TARGET_SHA, TTL 180 ngày."
