#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_FILE="${AMAZING_DEPLOY_CONFIG:-/opt/amazing-studio/deploy.conf}"
BACKUP_ROOT="/opt/amazing-studio/backups/first-pilot"
EXPECTED_HOST="160.250.128.162"
die(){ echo "[production-audit] ERROR: $*" >&2; exit 1; }

test "$(hostname -I | tr ' ' '\n' | grep -Fxc "$EXPECTED_HOST" || true)" -le 1 || die "Host identity ambiguous"
test -r "$CONFIG_FILE" || die "Missing production deploy config"
# shellcheck disable=SC1090
source "$CONFIG_FILE"
: "${DEPLOY_COMPOSE_FILE:?Missing compose path}"
test -r "$DEPLOY_COMPOSE_FILE" || die "Missing production compose"
for tool in docker curl sha256sum tar sudo; do command -v "$tool" >/dev/null || die "Missing $tool"; done
sudo -n true >/dev/null || die "Passwordless sudo unavailable"

deployed_sha=$(sudo -n sed -n '1p' /opt/amazing-studio/DEPLOYED_SHA)
[[ "$deployed_sha" =~ ^[0-9a-f]{40}$ ]] || die "Invalid deployed SHA"

api_cid=""; api_service=""
while IFS= read -r service; do
  cid=$(sudo -n docker compose -f "$DEPLOY_COMPOSE_FILE" ps -q "$service")
  test -n "$cid" || continue
  if sudo -n docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^DATABASE_URL='; then
    api_cid="$cid"; api_service="$service"; break
  fi
done < <(sudo -n docker compose -f "$DEPLOY_COMPOSE_FILE" config --services)
test -n "$api_cid" || die "API container not found"
network=$(sudo -n docker inspect "$api_cid" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' | head -n1)
test -n "$network" || die "API network not found"

read_env(){ sudo -n docker inspect "$api_cid" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$1=//p" | head -n1; }
business_url=$(read_env DATABASE_URL); test -n "$business_url" || die "DATABASE_URL missing"
platform_url=$(read_env PLATFORM_DATABASE_URL); test -n "$platform_url" || die "PLATFORM_DATABASE_URL missing"

safe_url_part(){
  sudo -n docker exec -e SAFE_URL="$1" -e SAFE_PART="$2" "$api_cid" node -e '
    const u=new URL(process.env.SAFE_URL); process.stdout.write(process.env.SAFE_PART==="host"?u.hostname:u.pathname.slice(1))'
}
business_host=$(safe_url_part "$business_url" host); business_db=$(safe_url_part "$business_url" db)
platform_host=$(safe_url_part "$platform_url" host); platform_db=$(safe_url_part "$platform_url" db)
test "$business_db" != "$platform_db" || die "Platform and business DB identities collide"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_ROOT/$stamp"
sudo -n install -d -m 700 -o root -g root "$target"
pg_image=postgres:17-alpine
sudo -n docker image inspect "$pg_image" >/dev/null 2>&1 || sudo -n docker pull "$pg_image" >/dev/null

backup_db(){
  local label="$1" url="$2" tmp final
  tmp="/tmp/${label}-${stamp}.dump"; final="$target/${label}.dump"
  sudo -n docker run --rm --network "$network" -e TARGET_URL="$url" "$pg_image" \
    sh -c 'pg_dump --format=custom --no-owner --no-acl "$TARGET_URL"' > "$tmp"
  test -s "$tmp" || die "$label backup empty"
  sudo -n docker run --rm -i "$pg_image" pg_restore -l < "$tmp" >/dev/null
  sudo -n install -m 600 -o root -g root "$tmp" "$final"; rm -f "$tmp"
  sudo -n sha256sum "$final" | sudo -n tee "$final.sha256" >/dev/null
}
backup_db amazing-business "$business_url"
backup_db platform "$platform_url"

runtime_tmp="/tmp/runtime-config-${stamp}.tar.gz"
runtime_paths=("$CONFIG_FILE" "$DEPLOY_COMPOSE_FILE" /opt/amazing-studio/DEPLOYED_SHA)
for optional in /opt/amazing-studio/platform-auth.env /opt/amazing-studio/platform-auth.override.yml; do
  sudo -n test -e "$optional" && runtime_paths+=("$optional")
done
sudo -n tar -czf "$runtime_tmp" --absolute-names "${runtime_paths[@]}"
sudo -n install -m 600 -o root -g root "$runtime_tmp" "$target/runtime-config.tar.gz"
sudo -n rm -f "$runtime_tmp"
sudo -n sha256sum "$target/runtime-config.tar.gz" | sudo -n tee "$target/runtime-config.tar.gz.sha256" >/dev/null

db_query(){ sudo -n docker run --rm --network "$network" -e TARGET_URL="$1" -e TARGET_QUERY="$2" "$pg_image" sh -c 'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -Atqc "$TARGET_QUERY"'; }
counts=$(db_query "$business_url" 'SELECT (SELECT count(*) FROM customers),(SELECT count(*) FROM bookings),(SELECT count(*) FROM payments),(SELECT count(*) FROM staff)')
migrations=$(db_query "$platform_url" "SELECT coalesce(string_agg(filename,',' ORDER BY filename),'') FROM platform_schema_migrations")

env_exists(){ test -n "$(read_env "$1")" && echo EXISTS || echo MISSING; }
health=$(curl -fsS --max-time 20 https://tranchistudio.com/api/healthz)
auth=$(curl -fsS --max-time 20 https://tranchistudio.com/api/auth/config)
[[ "$health" == *'"status":"ok"'* ]] || die "Production health failed"

echo "PRODUCTION_AUDIT=PASS"
echo "HOST_CLASSIFICATION=production-vps"
echo "API_SERVICE=$api_service"
echo "DEPLOYED_SHA=$deployed_sha"
echo "BUSINESS_DB_HOST=$business_host"
echo "BUSINESS_DB_NAME=$business_db"
echo "PLATFORM_DB_HOST=$platform_host"
echo "PLATFORM_DB_NAME=$platform_db"
echo "PLATFORM_MIGRATIONS=$migrations"
echo "TENANT_SECRET_MASTER_KEY=$(env_exists TENANT_SECRET_MASTER_KEY)"
echo "TENANT_PROVISIONING_ADMIN_URL=$(env_exists TENANT_PROVISIONING_ADMIN_URL)"
echo "TENANT_PROVISIONING_TEMPLATE_DATABASE=$(env_exists TENANT_PROVISIONING_TEMPLATE_DATABASE)"
echo "ENABLE_TENANT_PROVISIONING_WORKER=$(env_exists ENABLE_TENANT_PROVISIONING_WORKER)"
echo "BUSINESS_BASELINE=$counts"
echo "BACKUP_TIMESTAMP=$stamp"
echo "BACKUP_VERIFIED=PASS"
echo "GOOGLE_CONFIGURED=$([[ "$auth" == *'"googleEnabled":true'* ]] && echo YES || echo NO)"
echo "DISK=$(df -h /opt/amazing-studio | awk 'NR==2{print $4"-free"}')"
echo "RAM=$(free -h | awk '/Mem:/{print $7"-available"}')"
