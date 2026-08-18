#!/usr/bin/env bash
set -Eeuo pipefail

# Triển khai CODE-ONLY cho Amazing Studio từ gói source của GitHub Actions.
# Chỉ build/recreate dịch vụ web; không migration, db push, seed, câu SQL,
# không restart API và không tác động container database.

CONFIG_FILE="${AMAZING_DEPLOY_CONFIG:-/opt/amazing-studio/deploy.conf}"
LOCK_FILE="${AMAZING_DEPLOY_LOCK:-/tmp/amazing-studio-deploy.lock}"

die() {
  echo "[deploy] ERROR: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || die "Cần commit SHA và đường dẫn gói source."
DEPLOY_SHA="$1"
SOURCE_ARCHIVE="$2"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || die "Commit SHA không hợp lệ: $DEPLOY_SHA"
[[ "$SOURCE_ARCHIVE" =~ ^/tmp/amazing-studio-source-([0-9]+)\.tar\.gz$ ]] || \
  die "Đường dẫn gói source không hợp lệ."
RUN_ID="${BASH_REMATCH[1]}"
[ -f "$SOURCE_ARCHIVE" ] && [ ! -L "$SOURCE_ARCHIVE" ] || \
  die "Gói source phải là file thường, không phải symlink."
[ -r "$CONFIG_FILE" ] || die "Thiếu $CONFIG_FILE; chưa được phép đoán cấu hình production."

# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${DEPLOY_APP_DIR:?Thiếu DEPLOY_APP_DIR trong $CONFIG_FILE}"
: "${DEPLOY_RELEASES_DIR:?Thiếu DEPLOY_RELEASES_DIR trong $CONFIG_FILE}"
: "${DEPLOY_COMPOSE_FILE:?Thiếu DEPLOY_COMPOSE_FILE trong $CONFIG_FILE}"
: "${DEPLOY_WEB_SERVICE:?Thiếu DEPLOY_WEB_SERVICE trong $CONFIG_FILE}"
: "${DEPLOY_WEB_IMAGE:?Thiếu DEPLOY_WEB_IMAGE trong $CONFIG_FILE}"
: "${DEPLOY_ROLLBACK_IMAGE:?Thiếu DEPLOY_ROLLBACK_IMAGE trong $CONFIG_FILE}"
: "${DEPLOY_HEALTH_URL:?Thiếu DEPLOY_HEALTH_URL trong $CONFIG_FILE}"
: "${DEPLOY_WEB_URL:?Thiếu DEPLOY_WEB_URL trong $CONFIG_FILE}"

for tool in docker curl flock tar sudo; do
  command -v "$tool" >/dev/null || die "VPS chưa có $tool."
done

sudo -n true >/dev/null || die "User deploy chưa có sudo không cần mật khẩu."
[ -r "$DEPLOY_APP_DIR/06_vps_deployment/Dockerfile.web" ] || die "Thiếu Dockerfile.web production."
[ -r "$DEPLOY_APP_DIR/06_vps_deployment/docker-compose.yml" ] || die "Thiếu docker-compose.yml production."
tar -tzf "$SOURCE_ARCHIVE" >/dev/null || die "Gói source bị hỏng."

health_ok() {
  local body
  body=$(curl -fsS --max-time 15 "$DEPLOY_HEALTH_URL" 2>/dev/null || true)
  [[ "$body" == *'"status":"ok"'* ]] || return 1
  curl -fsS --max-time 15 "$DEPLOY_WEB_URL/" >/dev/null 2>&1
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 18); do
    if health_ok; then
      echo "[deploy] API và website đều healthy."
      return 0
    fi
    echo "[deploy] Health check $attempt/18 chưa đạt; chờ 5 giây..."
    sleep 5
  done
  return 1
}

exec 9>"$LOCK_FILE"
flock -n 9 || die "Đang có một lượt deploy khác chạy."

FINAL_RELEASE="$DEPLOY_RELEASES_DIR/$DEPLOY_SHA"
INCOMING_DIR="$DEPLOY_RELEASES_DIR/.incoming-$DEPLOY_SHA-$RUN_ID"
DEPLOY_FINISHED=0
IMAGE_CHANGED=0
WEB_REPLACED=0

cleanup_incoming() {
  if [ -n "${INCOMING_DIR:-}" ] && sudo -n test -d "$INCOMING_DIR"; then
    sudo -n find "$INCOMING_DIR" -xdev -mindepth 1 -delete || true
    sudo -n rmdir "$INCOMING_DIR" 2>/dev/null || true
  fi
}

cleanup_on_exit() {
  if [ "$DEPLOY_FINISHED" -eq 0 ]; then
    cleanup_incoming
  fi
}
trap cleanup_on_exit EXIT

if [ -f /opt/amazing-studio/DEPLOYED_SHA ] && \
   grep -Fxq "$DEPLOY_SHA" /opt/amazing-studio/DEPLOYED_SHA && \
   [ -d "$FINAL_RELEASE" ]; then
  health_ok || die "Commit đã ghi nhận nhưng website không healthy."
  DEPLOY_FINISHED=1
  echo "[deploy] Commit $DEPLOY_SHA đã được deploy trước đó và đang healthy."
  exit 0
fi

[ ! -e "$FINAL_RELEASE" ] || die "Release $DEPLOY_SHA đã tồn tại nhưng chưa được ghi nhận thành công."
[ ! -e "$INCOMING_DIR" ] || die "Thư mục incoming của run $RUN_ID đã tồn tại."

echo "[deploy] Giải nén đúng commit $DEPLOY_SHA"
sudo -n install -d -m 755 -o root -g root "$INCOMING_DIR"
sudo -n tar --no-same-owner \
  --exclude='06_vps_deployment' --exclude='06_vps_deployment/*' \
  -xzf "$SOURCE_ARCHIVE" -C "$INCOMING_DIR"
[ -r "$INCOMING_DIR/package.json" ] || die "Gói source thiếu package.json."

# Dùng nguyên bộ Docker đang chạy ổn định trên production, không trộn file hạ tầng từ source.
sudo -n cp -a "$DEPLOY_APP_DIR/06_vps_deployment" "$INCOMING_DIR/"

RELEASE_COMPOSE="$INCOMING_DIR/06_vps_deployment/docker-compose.yml"
docker compose -f "$RELEASE_COMPOSE" config --services | grep -Fxq "$DEPLOY_WEB_SERVICE" || \
  die "Không tìm thấy service $DEPLOY_WEB_SERVICE trong release."
docker compose -f "$DEPLOY_COMPOSE_FILE" config --services | grep -Fxq "$DEPLOY_WEB_SERVICE" || \
  die "Không tìm thấy service $DEPLOY_WEB_SERVICE trong production."

PREVIOUS_IMAGE_ID=$(docker image inspect "$DEPLOY_WEB_IMAGE" --format '{{.Id}}')
docker tag "$PREVIOUS_IMAGE_ID" "$DEPLOY_ROLLBACK_IMAGE"

rollback() {
  local status="$1"
  trap - ERR INT TERM HUP
  echo "[deploy] Deploy web hỏng; khôi phục image cũ $PREVIOUS_IMAGE_ID" >&2
  if [ "$IMAGE_CHANGED" -eq 1 ]; then
    docker tag "$DEPLOY_ROLLBACK_IMAGE" "$DEPLOY_WEB_IMAGE" || true
  fi
  if [ "$WEB_REPLACED" -eq 1 ]; then
    docker compose -f "$DEPLOY_COMPOSE_FILE" up -d --no-deps --force-recreate "$DEPLOY_WEB_SERVICE" || true
    wait_for_health || true
  fi
  exit "$status"
}

trap 'status=$?; rollback "$status"' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM
trap 'rollback 129' HUP

echo "[deploy] Build image web từ source đã kiểm thử"
docker compose -f "$RELEASE_COMPOSE" build "$DEPLOY_WEB_SERVICE"
IMAGE_CHANGED=1

echo "[deploy] Chỉ thay container $DEPLOY_WEB_SERVICE; API và database giữ nguyên."
WEB_REPLACED=1
docker compose -f "$DEPLOY_COMPOSE_FILE" up -d --no-deps --force-recreate "$DEPLOY_WEB_SERVICE"
wait_for_health

sudo -n mv "$INCOMING_DIR" "$FINAL_RELEASE"
INCOMING_DIR=""
printf '%s\n' "$DEPLOY_SHA" | sudo -n tee /opt/amazing-studio/DEPLOYED_SHA >/dev/null
DEPLOY_FINISHED=1
trap - ERR INT TERM HUP EXIT
echo "[deploy] SUCCESS: web đang chạy commit $DEPLOY_SHA"
