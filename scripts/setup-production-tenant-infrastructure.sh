#!/usr/bin/env bash
set -Eeuo pipefail

# Creates an isolated, private PostgreSQL service for new SaaS tenants.
# It never connects to or modifies the legacy Amazing business database.

CONFIG_FILE="${AMAZING_DEPLOY_CONFIG:-/opt/amazing-studio/deploy.conf}"
PLATFORM_ENV_FILE="/opt/amazing-studio/platform-auth.env"
PLATFORM_OVERRIDE_FILE="/opt/amazing-studio/platform-auth.override.yml"
SCHEMA_ARCHIVE="${1:-}"
CONTAINER="amazing-tenants-prod"
VOLUME="amazing-tenants-prod-data"
PROVISIONER="amazing_tenant_provisioner"
TEMPLATE="tenant_template_prod"
SECRETS_FILE="/opt/amazing-studio/tenant-postgres.env"
LOCK_FILE="/tmp/amazing-studio-tenant-infrastructure.lock"
PG_IMAGE="postgres:18-alpine"

die(){ echo "[tenant-infra] ERROR: $*" >&2; exit 1; }
[ -r "$CONFIG_FILE" ] || die "Thiếu deploy.conf"
sudo -n test -r "$PLATFORM_ENV_FILE" || die "Thiếu platform-auth.env"
[ -s "$SCHEMA_ARCHIVE" ] || die "Thiếu schema artifact"
# shellcheck disable=SC1090
source "$CONFIG_FILE"
: "${DEPLOY_COMPOSE_FILE:?Thiếu DEPLOY_COMPOSE_FILE}"
for tool in docker curl flock openssl sudo tar; do command -v "$tool" >/dev/null || die "VPS thiếu $tool"; done
sudo -n true >/dev/null || die "User deploy thiếu sudo không mật khẩu"
exec 9>"$LOCK_FILE"; flock -n 9 || die "Đang có cấu hình production khác chạy"

compose_platform(){ sudo -n docker compose -f "$DEPLOY_COMPOSE_FILE" -f "$PLATFORM_OVERRIDE_FILE" "$@"; }
API_SERVICE=""; API_CID=""
while IFS= read -r service; do
  cid=$(compose_platform ps -q "$service")
  [ -n "$cid" ] || continue
  if sudo -n docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^PLATFORM_DATABASE_URL=' >/dev/null; then
    API_SERVICE="$service"; API_CID="$cid"; break
  fi
done < <(compose_platform config --services)
[ -n "$API_CID" ] || die "Không xác định được API production"
API_NETWORK=$(sudo -n docker inspect "$API_CID" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' | head -n1)
[ -n "$API_NETWORK" ] || die "Không xác định được private Docker network"
PLATFORM_HOST=$(sudo -n docker inspect "$API_CID" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PLATFORM_DATABASE_URL=//p' | head -n1 | sudo -n docker exec -i "$API_CID" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(new URL(s.trim()).hostname))')
[ -n "$PLATFORM_HOST" ] || die "Không đọc được host Platform DB"

# This directory contains non-secret deployment control files that the unprivileged
# deploy account must be able to traverse. Secret files below remain root-owned
# and mode 600; tightening the parent to 750 makes deploy.conf and compose appear
# missing even though they still exist.
sudo -n install -d -m 755 -o root -g root /opt/amazing-studio
if ! sudo -n test -s "$SECRETS_FILE"; then
  ROOT_PASSWORD=$(openssl rand -base64 36 | tr -d '\n' | tr '+/' '-_')
  PROVISIONER_PASSWORD=$(openssl rand -base64 36 | tr -d '\n' | tr '+/' '-_')
  MASTER_KEY=$(openssl rand -base64 32 | tr -d '\n')
  tmp=$(mktemp /tmp/amazing-tenant-secrets.XXXXXX); chmod 600 "$tmp"
  printf 'POSTGRES_PASSWORD=%s\nPROVISIONER_PASSWORD=%s\nTENANT_SECRET_MASTER_KEY=%s\n' \
    "$ROOT_PASSWORD" "$PROVISIONER_PASSWORD" "$MASTER_KEY" > "$tmp"
  sudo -n install -m 600 -o root -g root "$tmp" "$SECRETS_FILE"; rm -f "$tmp"
fi
ROOT_PASSWORD=$(sudo -n sed -n 's/^POSTGRES_PASSWORD=//p' "$SECRETS_FILE")
PROVISIONER_PASSWORD=$(sudo -n sed -n 's/^PROVISIONER_PASSWORD=//p' "$SECRETS_FILE")
MASTER_KEY=$(sudo -n sed -n 's/^TENANT_SECRET_MASTER_KEY=//p' "$SECRETS_FILE")
[ -n "$ROOT_PASSWORD" ] && [ -n "$PROVISIONER_PASSWORD" ] && [ -n "$MASTER_KEY" ] || die "Tenant secrets không đầy đủ"

sudo -n docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || sudo -n docker pull "$PG_IMAGE" >/dev/null
if ! sudo -n docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  sudo -n docker volume create "$VOLUME" >/dev/null
  sudo -n docker run -d --name "$CONTAINER" --restart unless-stopped \
    --network "$API_NETWORK" --network-alias "$CONTAINER" \
    -e POSTGRES_PASSWORD="$ROOT_PASSWORD" -e POSTGRES_USER=postgres \
    -v "$VOLUME:/var/lib/postgresql" "$PG_IMAGE" >/dev/null
fi
# Explicitly reject a container accidentally exposed on the host/public network.
[ -z "$(sudo -n docker port "$CONTAINER" 2>/dev/null)" ] || die "Tenant PostgreSQL đang expose port; từ chối tiếp tục"
for i in $(seq 1 30); do sudo -n docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; [ "$i" != 30 ] || die "Tenant PostgreSQL không healthy"; sleep 2; done

sudo -n docker exec -i -e PGPASSWORD="$ROOT_PASSWORD" -e PROVISIONER_PASSWORD="$PROVISIONER_PASSWORD" "$CONTAINER" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v provisioner_pass="$PROVISIONER_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE amazing_tenant_provisioner LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD %L', :'provisioner_pass')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='amazing_tenant_provisioner') \gexec
SELECT format('ALTER ROLE amazing_tenant_provisioner LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD %L', :'provisioner_pass') \gexec
SELECT 'CREATE DATABASE tenant_template_prod OWNER amazing_tenant_provisioner TEMPLATE template0'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='tenant_template_prod') \gexec
ALTER DATABASE tenant_template_prod ALLOW_CONNECTIONS true;
REVOKE CONNECT ON DATABASE tenant_template_prod FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE tenant_template_prod TO amazing_tenant_provisioner;
SQL

tmpdir=$(mktemp -d /tmp/amazing-tenant-schema.XXXXXX); trap 'rm -rf "$tmpdir"' EXIT
tar -xzf "$SCHEMA_ARCHIVE" -C "$tmpdir"
[ -s "$tmpdir/tenant-template-schema.sql" ] || die "Schema artifact rỗng"
existing=$(sudo -n docker exec "$CONTAINER" psql -U postgres -d "$TEMPLATE" -Atqc "SELECT to_regclass('public.customers') IS NOT NULL")
if [ "$existing" != "t" ]; then
  sudo -n docker exec -i -e PGPASSWORD="$PROVISIONER_PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$PROVISIONER" -d "$TEMPLATE" -v ON_ERROR_STOP=1 < "$tmpdir/tenant-template-schema.sql"
fi
counts=$(sudo -n docker exec "$CONTAINER" psql -U postgres -d "$TEMPLATE" -Atqc "SELECT (SELECT count(*) FROM customers),(SELECT count(*) FROM bookings),(SELECT count(*) FROM payments),(SELECT count(*) FROM expenses),(SELECT count(*) FROM contracts),(SELECT count(*) FROM staff)")
[ "$counts" = "0|0|0|0|0|0" ] || die "Template chứa business data: $counts"
sudo -n docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE $TEMPLATE OWNER TO $PROVISIONER; ALTER DATABASE $TEMPLATE ALLOW_CONNECTIONS false" >/dev/null

ADMIN_URL="postgresql://${PROVISIONER}:${PROVISIONER_PASSWORD}@${CONTAINER}:5432/postgres"
envtmp=$(mktemp /tmp/amazing-platform-worker.XXXXXX); chmod 600 "$envtmp"
sudo -n awk '!/^(APP_ENV|TENANT_PROVISIONING_ADMIN_URL|TENANT_PROVISIONING_TEMPLATE_DATABASE|TENANT_SECRET_MASTER_KEY|TENANT_PROVISIONING_PRODUCTION_ACK|TENANT_PROVISIONING_HOST_ALLOWLIST|TENANT_MIGRATIONS_DIR|ENABLE_TENANT_PROVISIONING_WORKER)=/' "$PLATFORM_ENV_FILE" > "$envtmp"
cat >> "$envtmp" <<EOF
APP_ENV=production
TENANT_PROVISIONING_ADMIN_URL=$ADMIN_URL
TENANT_PROVISIONING_TEMPLATE_DATABASE=$TEMPLATE
TENANT_SECRET_MASTER_KEY=$MASTER_KEY
TENANT_PROVISIONING_PRODUCTION_ACK=DATABASE_PER_TENANT
TENANT_PROVISIONING_HOST_ALLOWLIST=$CONTAINER,$PLATFORM_HOST
TENANT_MIGRATIONS_DIR=/app/lib/db/migrations
ENABLE_TENANT_PROVISIONING_WORKER=1
EOF
sudo -n install -m 600 -o root -g root "$envtmp" "$PLATFORM_ENV_FILE"; rm -f "$envtmp"
compose_platform up -d --no-deps --force-recreate "$API_SERVICE"
for i in $(seq 1 24); do
  health=$(curl -fsS --max-time 15 "${DEPLOY_HEALTH_URL:?Thiếu DEPLOY_HEALTH_URL}" 2>/dev/null || true)
  [[ "$health" == *'"status":"ok"'* ]] && break
  [ "$i" != 24 ] || die "API không healthy sau khi bật worker"
  sleep 5
done
new_cid=$(compose_platform ps -q "$API_SERVICE")
enabled=$(sudo -n docker inspect "$new_cid" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^ENABLE_TENANT_PROVISIONING_WORKER=//p' | head -n1)
[ "$enabled" = "1" ] || die "Worker chưa được bật"
echo "[tenant-infra] SUCCESS: private PostgreSQL healthy; empty template verified; production worker enabled"
