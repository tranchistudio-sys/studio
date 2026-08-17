#!/usr/bin/env bash
set -Eeuo pipefail

# Bộ triển khai CODE-ONLY cho Amazing Studio.
# Cấu hình VPS nằm ngoài Git: /opt/amazing-studio/deploy.conf
# Script không chạy migration, db push, seed hoặc bất kỳ câu SQL nào.

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

: "${DEPLOY_APP_DIR:?Thiếu DEPLOY_APP_DIR trong $CONFIG_FILE}"
: "${DEPLOY_DRIVER:?Thiếu DEPLOY_DRIVER trong $CONFIG_FILE}"
: "${DEPLOY_SERVICE:?Thiếu DEPLOY_SERVICE trong $CONFIG_FILE}"
: "${DEPLOY_HEALTH_URL:?Thiếu DEPLOY_HEALTH_URL trong $CONFIG_FILE}"

command -v git >/dev/null || die "VPS chưa có git."
command -v pnpm >/dev/null || die "VPS chưa có pnpm."
command -v curl >/dev/null || die "VPS chưa có curl."
command -v flock >/dev/null || die "VPS chưa có flock."
git -C "$DEPLOY_APP_DIR" rev-parse --is-inside-work-tree 2>/dev/null | grep -qx true || \
  die "$DEPLOY_APP_DIR không phải Git working tree."

exec 9>"$LOCK_FILE"
flock -n 9 || die "Đang có một lượt deploy khác chạy."

restart_app() {
  case "$DEPLOY_DRIVER" in
    systemd)
      sudo -n systemctl restart "$DEPLOY_SERVICE"
      ;;
    systemd-user)
      systemctl --user restart "$DEPLOY_SERVICE"
      ;;
    pm2)
      pm2 restart "$DEPLOY_SERVICE" --update-env
      ;;
    docker-compose)
      : "${DEPLOY_COMPOSE_FILE:?Thiếu DEPLOY_COMPOSE_FILE}"
      docker compose -f "$DEPLOY_COMPOSE_FILE" up -d --no-deps --force-recreate "$DEPLOY_SERVICE"
      ;;
    *)
      die "DEPLOY_DRIVER phải là systemd, systemd-user, pm2 hoặc docker-compose."
      ;;
  esac
}

preflight_service() {
  case "$DEPLOY_DRIVER" in
    systemd)
      sudo -n systemctl show "$DEPLOY_SERVICE" -p LoadState --value | grep -qx loaded
      ;;
    systemd-user)
      systemctl --user show "$DEPLOY_SERVICE" -p LoadState --value | grep -qx loaded
      ;;
    pm2)
      command -v pm2 >/dev/null && pm2 describe "$DEPLOY_SERVICE" >/dev/null
      ;;
    docker-compose)
      : "${DEPLOY_COMPOSE_FILE:?Thiếu DEPLOY_COMPOSE_FILE}"
      docker compose -f "$DEPLOY_COMPOSE_FILE" config --services | grep -Fxq "$DEPLOY_SERVICE"
      ;;
    *) return 1 ;;
  esac
}

health_ok() {
  local body
  body=$(curl -fsS --max-time 15 "$DEPLOY_HEALTH_URL" 2>/dev/null || true)
  [[ "$body" == *'"status":"ok"'* ]]
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 18); do
    if health_ok; then
      echo "[deploy] Health check OK."
      return 0
    fi
    echo "[deploy] Health check $attempt/18 chưa đạt; chờ 5 giây..."
    sleep 5
  done
  return 1
}

preflight_service || die "Không xác nhận được dịch vụ $DEPLOY_SERVICE; chưa thay đổi code."

cd "$DEPLOY_APP_DIR"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "Production có file tracked đang sửa tay; dừng để không ghi đè."
PREVIOUS_SHA=$(git rev-parse HEAD)

rollback() {
  local status=$?
  trap - ERR
  echo "[deploy] Deploy hỏng; rollback về $PREVIOUS_SHA" >&2
  git checkout --detach "$PREVIOUS_SHA"
  pnpm install --frozen-lockfile
  pnpm deploy:guard
  pnpm run build:deploy
  restart_app
  wait_for_health || true
  exit "$status"
}
trap rollback ERR

echo "[deploy] $PREVIOUS_SHA -> $DEPLOY_SHA"
git fetch --no-tags origin "$DEPLOY_SHA"
git checkout --detach "$DEPLOY_SHA"

pnpm install --frozen-lockfile
pnpm deploy:guard
pnpm run build:deploy
restart_app
wait_for_health

trap - ERR
echo "[deploy] SUCCESS: $DEPLOY_SHA"
