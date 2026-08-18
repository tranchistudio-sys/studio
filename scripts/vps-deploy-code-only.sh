#!/usr/bin/env bash
set -Eeuo pipefail

# Triển khai CODE-ONLY cho Amazing Studio theo mô hình release + Docker image.
# Script chỉ build/recreate dịch vụ web; không chạy migration, db push, seed,
# câu SQL, không restart API và không tác động container database.

CONFIG_FILE="${AMAZING_DEPLOY_CONFIG:-/opt/amazing-studio/deploy.conf}"
LOCK_FILE="${AMAZING_DEPLOY_LOCK:-/tmp/amazing-studio-deploy.lock}"

die() {
  echo "[deploy] ERROR: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || die "Cần đúng một commit SHA."
DEPLOY_SHA="$1"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]] || die "Commit SHA không hợp lệ: $DEPLOY_SHA"
[ -r "$CONFIG_FILE" ] || die "Thiếu $CONFIG_FILE; chưa được phép đoán cấu hình production."

# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${DEPLOY_REPO_DIR:?Thiếu DEPLOY_REPO_DIR trong $CONFIG_FILE}"
: "${DEPLOY_REPO_USER:?Thiếu DEPLOY_REPO_USER trong $CONFIG_FILE}"
: "${DEPLOY_APP_DIR:?Thiếu DEPLOY_APP_DIR trong $CONFIG_FILE}"
: "${DEPLOY_RELEASES_DIR:?Thiếu DEPLOY_RELEASES_DIR trong $CONFIG_FILE}"
: "${DEPLOY_COMPOSE_FILE:?Thiếu DEPLOY_COMPOSE_FILE trong $CONFIG_FILE}"
: "${DEPLOY_WEB_SERVICE:?Thiếu DEPLOY_WEB_SERVICE trong $CONFIG_FILE}"
: "${DEPLOY_WEB_IMAGE:?Thiếu DEPLOY_WEB_IMAGE trong $CONFIG_FILE}"
: "${DEPLOY_ROLLBACK_IMAGE:?Thiếu DEPLOY_ROLLBACK_IMAGE trong $CONFIG_FILE}"
: "${DEPLOY_HEALTH_URL:?Thiếu DEPLOY_HEALTH_URL trong $CONFIG_FILE}"
: "${DEPLOY_WEB_URL:?Thiếu DEPLOY_WEB_URL trong $CONFIG_FILE}"

for tool in git docker curl flock tar sudo; do
  command -v "$tool" >/dev/null || die "VPS chưa có $tool."
done

sudo -n true >/dev/null || die "User deploy chưa có sudo không cần mật khẩu."
[ -d "$DEPLOY_REPO_DIR/.git" ] || die "$DEPLOY_REPO_DIR không phải Git repository."
[ -r "$DEPLOY_APP_DIR/06_vps_deployment/Dockerfile.web" ] || die "Thiếu Dockerfile.web production."
[ -r "$DEPLOY_APP_DIR/06_vps_deployment/docker-compose.yml" ] || die "Thiếu docker-compose.yml production."

repo_git() {
  sudo -n -u "$DEPLOY_REPO_USER" git \
    -c safe.directory="$DEPLOY_REPO_DIR" \
    -C "$DEPLOY_REPO_DIR" "$@"
}

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

[ -z "$(repo_git status --porcelain --untracked-files=no)" ] || \
  die "Repository nguồn có file tracked đang sửa tay; dừng để không ghi đè."

echo "[deploy] Fetch đúng commit $DEPLOY_SHA"
repo_git fetch --no-tags origin "$DEPLOY_SHA"
repo_git cat-file -e "$DEPLOY_SHA^{commit}"

RELEASE_DIR="$DEPLOY_RELEASES_DIR/$DEPLOY_SHA"
[ ! -e "$RELEASE_DIR" ] || die "Release $DEPLOY_SHA đã tồn tại; dừng để không ghi đè."

sudo -n install -d -m 755 -o root -g root "$RELEASE_DIR"
repo_git archive "$DEPLOY_SHA" | sudo -n tar -x -C "$RELEASE_DIR"
sudo -n cp -a "$DEPLOY_APP_DIR/06_vps_deployment" "$RELEASE_DIR/"

RELEASE_COMPOSE="$RELEASE_DIR/06_vps_deployment/docker-compose.yml"
docker compose -f "$RELEASE_COMPOSE" config --services | grep -Fxq "$DEPLOY_WEB_SERVICE" || \
  die "Không tìm thấy service $DEPLOY_WEB_SERVICE trong release."
docker compose -f "$DEPLOY_COMPOSE_FILE" config --services | grep -Fxq "$DEPLOY_WEB_SERVICE" || \
  die "Không tìm thấy service $DEPLOY_WEB_SERVICE trong production."

PREVIOUS_IMAGE_ID=$(docker image inspect "$DEPLOY_WEB_IMAGE" --format '{{.Id}}')
docker tag "$PREVIOUS_IMAGE_ID" "$DEPLOY_ROLLBACK_IMAGE"

rollback() {
  local status=$?
  trap - ERR
  echo "[deploy] Deploy web hỏng; rollback image cũ $PREVIOUS_IMAGE_ID" >&2
  docker tag "$DEPLOY_ROLLBACK_IMAGE" "$DEPLOY_WEB_IMAGE" || true
  docker compose -f "$DEPLOY_COMPOSE_FILE" up -d --no-deps --force-recreate "$DEPLOY_WEB_SERVICE" || true
  wait_for_health || true
  exit "$status"
}
trap rollback ERR

echo "[deploy] Build image web từ release $RELEASE_DIR"
docker compose -f "$RELEASE_COMPOSE" build "$DEPLOY_WEB_SERVICE"

echo "[deploy] Chỉ thay container $DEPLOY_WEB_SERVICE; API và database giữ nguyên."
docker compose -f "$DEPLOY_COMPOSE_FILE" up -d --no-deps --force-recreate "$DEPLOY_WEB_SERVICE"
wait_for_health

printf '%s\n' "$DEPLOY_SHA" | sudo -n tee /opt/amazing-studio/DEPLOYED_SHA >/dev/null
trap - ERR
echo "[deploy] SUCCESS: web đang chạy commit $DEPLOY_SHA"
