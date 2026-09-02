#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_FILE="${AMAZING_DEPLOY_CONFIG:-/opt/amazing-studio/deploy.conf}"
MIGRATION_FILE="${1:-}"
BACKUP_TIMESTAMP="${2:-}"
EXPECTED_NAME=0007_platform_admin_commercial_dashboard.sql
BACKUP_DIR="/opt/amazing-studio/backups/first-pilot/$BACKUP_TIMESTAMP"
die(){ echo "[platform-0007] ERROR: $*" >&2; exit 1; }

test "$(basename "$MIGRATION_FILE")" = "$EXPECTED_NAME" && test -s "$MIGRATION_FILE" || die "Invalid migration artifact"
[[ "$BACKUP_TIMESTAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "Invalid backup timestamp"
test -r "$CONFIG_FILE" || die "Missing production deploy config"
# shellcheck disable=SC1090
source "$CONFIG_FILE"
: "${DEPLOY_COMPOSE_FILE:?Missing compose path}"
for file in amazing-business.dump platform.dump runtime-config.tar.gz; do
  sudo -n test -s "$BACKUP_DIR/$file" || die "Missing verified backup: $file"
  sudo -n sha256sum -c "$BACKUP_DIR/$file.sha256" >/dev/null || die "Backup checksum failed: $file"
done

api_cid=""
while IFS= read -r service; do
  cid=$(sudo -n docker compose -f "$DEPLOY_COMPOSE_FILE" ps -q "$service")
  test -n "$cid" || continue
  if sudo -n docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^PLATFORM_DATABASE_URL='; then
    api_cid="$cid"; break
  fi
done < <(sudo -n docker compose -f "$DEPLOY_COMPOSE_FILE" config --services)
test -n "$api_cid" || die "API container not found"
network=$(sudo -n docker inspect "$api_cid" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' | head -n1)
platform_url=$(sudo -n docker inspect "$api_cid" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PLATFORM_DATABASE_URL=//p' | head -n1)
business_url=$(sudo -n docker inspect "$api_cid" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^DATABASE_URL=//p' | head -n1)
test -n "$network" && test -n "$platform_url" && test -n "$business_url" || die "Database identity unavailable"
test "$platform_url" != "$business_url" || die "Platform and business databases collide"

pg_image=postgres:17-alpine
sudo -n docker image inspect "$pg_image" >/dev/null 2>&1 || sudo -n docker pull "$pg_image" >/dev/null
query(){ sudo -n docker run --rm --network "$network" -e TARGET_URL="$platform_url" -e TARGET_QUERY="$1" "$pg_image" sh -c 'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -Atqc "$TARGET_QUERY"'; }
test "$(query "SELECT count(*) FROM (VALUES (to_regclass('public.customers')),(to_regclass('public.bookings')),(to_regclass('public.payments'))) t(x) WHERE x IS NOT NULL")" = 0 || die "Target is not Platform DB"

checksum=$(sha256sum "$MIGRATION_FILE" | awk '{print $1}')
recorded=$(query "SELECT coalesce(checksum_sha256,'') FROM platform_schema_migrations WHERE filename='$EXPECTED_NAME'")
if test -n "$recorded"; then
  test "$recorded" = "$checksum" || die "Recorded checksum mismatch"
  echo "[platform-0007] NO-OP: migration already applied with verified checksum"
  exit 0
fi

{
  cat "$MIGRATION_FILE"
  printf "\nINSERT INTO platform_schema_migrations(filename,checksum_sha256) VALUES ('%s','%s');\n" "$EXPECTED_NAME" "$checksum"
} | sudo -n docker run --rm -i --network "$network" -e TARGET_URL="$platform_url" "$pg_image" \
  sh -c 'psql "$TARGET_URL" -v ON_ERROR_STOP=1 -1' >/dev/null

test "$(query "SELECT count(*) FROM platform_schema_migrations WHERE filename='$EXPECTED_NAME' AND checksum_sha256='$checksum'")" = 1 || die "Migration verification failed"
echo "[platform-0007] PASS: applied exactly once"
