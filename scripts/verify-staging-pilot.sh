#!/usr/bin/env bash
set -euo pipefail

test "${FLY_DB_APP:-}" = "amazing-studio-staging-db"
test -n "${FLY_API_TOKEN:-}" && test -n "${PGPASSWORD:-}" && test -n "${PILOT_EMAIL:-}"
case "$FLY_DB_APP" in *production*|*prod*) exit 1;; esac

proxy_pid=""
start_proxy() {
  test -z "$proxy_pid" || kill "$proxy_pid" 2>/dev/null || true
  test -z "$proxy_pid" || wait "$proxy_pid" 2>/dev/null || true
  flyctl proxy 15432:5432 --app "$FLY_DB_APP" >fly-proxy.log 2>&1 &
  proxy_pid=$!
  for i in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p 15432 -U postgres && return
    sleep 2
  done
  exit 1
}
start_proxy
restore_db="staging_pilot_restore_${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-1}"
backup_dir="${RUNNER_TEMP:-/tmp}"
backup_name="pilot-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$(date -u +%Y%m%dT%H%M%SZ).dump"
backup_file="$backup_dir/$backup_name"
checksum_file="$backup_file.sha256"
backup_parts="$backup_dir/${backup_name}.parts"
restore_parts="$backup_dir/${backup_name}.restore"
local_container="pilot-restore-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
local_port=25432
local_password="ci_restore_only_${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-1}"
cleanup() {
  psql "postgresql://postgres@127.0.0.1:15432/postgres" -v ON_ERROR_STOP=1 \
    -v restore_db="$restore_db" <<'SQL' >/dev/null 2>&1 || true
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname=:'restore_db' AND pid<>pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I', :'restore_db') \gexec
SQL
  docker rm -f "$local_container" >/dev/null 2>&1 || true
  rm -f "$backup_file" "$checksum_file"
  rm -rf "$backup_parts" "$restore_parts"
  kill "$proxy_pid" 2>/dev/null || true
}
trap cleanup EXIT
root_url="postgresql://postgres@127.0.0.1:15432/postgres"
platform_url="postgresql://postgres@127.0.0.1:15432/amazing_platform_staging"

# Remove only disposable restore databases left by an interrupted staging drill.
psql "$root_url" -v ON_ERROR_STOP=1 <<'SQL'
SELECT pg_terminate_backend(a.pid)
FROM pg_stat_activity a
WHERE a.datname LIKE 'staging_pilot_restore_%' AND a.pid<>pg_backend_pid();
SELECT format('DROP DATABASE %I', d.datname) FROM pg_database d
WHERE d.datname LIKE 'staging_pilot_restore_%' \gexec
SQL

state=$(psql "$platform_url" -v ON_ERROR_STOP=1 -v email="$PILOT_EMAIL" -AtF '|' <<'SQL'
SELECT t.id::text,t.status,signup.status,pay.status,pay.amount::text,(pay.paid_at IS NULL)::text,
  s.status,s.current_period_start::text,s.current_period_ends_at::text,
  (s.current_period_ends_at=s.current_period_start+interval '1 month')::text,
  r.health_status,r.database_name,r.role_name,
  m.status,m.tenant_role,COALESCE(m.tenant_staff_id::text,''),u.status,
  j.status,j.step,j.attempt_count::text
FROM studio_signup_requests signup
JOIN tenants t ON t.id=signup.tenant_id
JOIN subscriptions s ON s.tenant_id=t.id
JOIN platform_payments pay ON pay.subscription_id=s.id AND pay.payment_type='SETUP_FEE' AND pay.status<>'VOID'
JOIN tenant_database_registry r ON r.tenant_id=t.id
JOIN tenant_memberships m ON m.tenant_id=t.id AND m.tenant_role='OWNER'
JOIN platform_users u ON u.id=m.user_id
JOIN LATERAL (
  SELECT status,step,attempt_count FROM provisioning_jobs
  WHERE tenant_id=t.id ORDER BY created_at DESC LIMIT 1
) j ON true
WHERE lower(signup.email)=lower(:'email');
SQL
)
test -n "$state"
IFS='|' read -r tenant_id tenant_status signup_status payment_status payment_amount payment_uncollected \
  subscription_status period_start period_end exact_month registry_status database_name role_name \
  membership_status membership_role staff_id user_status job_status job_step attempt_count <<<"$state"
test "$tenant_status" = "active" && test "$signup_status" = "ACTIVE"
# WAIVED retains the nominal fee for audit/reporting; it records no collection.
test "$payment_status" = "WAIVED" && test "$payment_amount" = "900000" && test "$payment_uncollected" = "true"
test "$subscription_status" = "trial"
test -n "$period_start" && test -n "$period_end" && test "$exact_month" = "true"
test "$registry_status" = "healthy"
test "$membership_status" = "active" && test "$membership_role" = "OWNER" && test -n "$staff_id"
test "$user_status" = "active"
test "$job_status" = "succeeded" && test "$job_step" = "COMPLETED" && test "$attempt_count" -ge 2
case "$database_name" in tenant_[0-9a-f]*) ;; *) exit 1;; esac
case "$role_name" in tenant_[0-9a-f]*_role) ;; *) exit 1;; esac

tenant_url="postgresql://postgres@127.0.0.1:15432/${database_name}"
tenant_state=$(psql "$tenant_url" -v ON_ERROR_STOP=1 -v tenant_id="$tenant_id" -AtF '|' <<'SQL'
SELECT
  (SELECT count(*) FROM customers)::text,
  (SELECT count(*) FROM bookings)::text,
  (SELECT count(*) FROM payments)::text,
  (SELECT count(*) FROM expenses)::text,
  (SELECT count(*) FROM contracts)::text,
  (SELECT count(*) FROM staff)::text,
  (SELECT count(*) FROM tenant_metadata WHERE tenant_id=:'tenant_id')::text,
  COALESCE((SELECT schema_version FROM tenant_metadata WHERE tenant_id=:'tenant_id'),'');
SQL
)
test "$tenant_state" = "0|0|0|0|0|1|1|0007_tenant_metadata.sql"

isolation=$(psql "$root_url" -v ON_ERROR_STOP=1 -v database_name="$database_name" -v role_name="$role_name" -AtF '|' <<'SQL'
SELECT
  has_database_privilege(:'role_name',:'database_name','CONNECT')::text,
  (NOT EXISTS(
    SELECT 1 FROM pg_database d,
      LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) acl
    WHERE d.datname=:'database_name' AND acl.grantee=0 AND acl.privilege_type='CONNECT'
  ))::text,
  (SELECT count(*)=1 FROM pg_database WHERE datname=:'database_name')::text;
SQL
)
test "$isolation" = "true|true|true"
duplicate_registry=$(psql "$platform_url" -v ON_ERROR_STOP=1 -Atqc "
  SELECT count(*) FROM (
    SELECT host_ref,database_name FROM tenant_database_registry
    GROUP BY host_ref,database_name HAVING count(*)>1
  ) duplicates")
test "$duplicate_registry" = "0"

# The smallest staging DB restarts even for a schema-only pg_dump. Build a
# tenant-specific, portable artifact without asking that server to catalogue the
# whole schema: trusted repository migrations plus one CSV stream per table.
# Each read is its own short transaction and the restore uses the exact same
# migration orchestrator as provisioning.
mkdir -p "$backup_parts"
mkdir -p "$backup_parts/migrations" "$backup_parts/data"
for migration in lib/db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  test "$(basename "$migration")" = "0004_seed_amazing_wedding_gifts.sql" && continue
  cp "$migration" "$backup_parts/migrations/"
done
mapfile -t tenant_tables < <(psql "$tenant_url" -v ON_ERROR_STOP=1 -Atqc \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'tenant_schema_migrations' ORDER BY tablename")
: > "$backup_parts/data/manifest.tsv"
for table_name in "${tenant_tables[@]}"; do
  [[ "$table_name" =~ ^[a-zA-Z0-9_]+$ ]]
  csv_name="${table_name}.csv"
  printf '%s\t%s\n' "$table_name" "$csv_name" >> "$backup_parts/data/manifest.tsv"
  psql "$tenant_url" -v ON_ERROR_STOP=1 \
    -c "\\copy public.\"$table_name\" TO '$backup_parts/data/$csv_name' WITH (FORMAT csv, HEADER true)" >/dev/null
done
tar -C "$backup_parts" -cf "$backup_file" .
(cd "$backup_dir" && sha256sum "$backup_name" > "${backup_name}.sha256")
(cd "$backup_dir" && sha256sum --check "${backup_name}.sha256")

docker run -d --name "$local_container" \
  -e POSTGRES_PASSWORD="$local_password" -p "${local_port}:5432" postgres:18 >/dev/null
for i in $(seq 1 30); do
  docker exec "$local_container" pg_isready -U postgres >/dev/null 2>&1 && break
  test "$i" != 30 || exit 1
  sleep 2
done
PGPASSWORD="$local_password" createdb -h 127.0.0.1 -p "$local_port" -U postgres "$restore_db"
mkdir -p "$restore_parts"
tar -C "$restore_parts" -xf "$backup_file"
restore_url="postgresql://postgres@127.0.0.1:${local_port}/${restore_db}"
CI=true DATABASE_URL="$restore_url" TENANT_MIGRATIONS_DIR="$restore_parts/migrations" \
  pnpm --filter @workspace/scripts exec tsx run-ci-tenant-template-migrations.mjs >/dev/null
while IFS=$'\t' read -r table_name csv_name; do
  [[ "$table_name" =~ ^[a-zA-Z0-9_]+$ ]]
  [[ "$csv_name" =~ ^[a-zA-Z0-9_]+\.csv$ ]]
  PGPASSWORD="$local_password" psql "$restore_url" -v ON_ERROR_STOP=1 \
    -c "SET session_replication_role=replica" \
    -c "\\copy public.\"$table_name\" FROM '$restore_parts/data/$csv_name' WITH (FORMAT csv, HEADER true)" >/dev/null
done < "$restore_parts/data/manifest.tsv"
# Bring serial/identity sequences forward so the restored database is writable.
PGPASSWORD="$local_password" psql "$restore_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
DECLARE item record; maximum bigint;
BEGIN
  FOR item IN
    SELECT table_name,column_name,pg_get_serial_sequence(format('%I.%I',table_schema,table_name),column_name) AS sequence_name
    FROM information_schema.columns
    WHERE table_schema='public' AND (column_default LIKE 'nextval(%' OR is_identity='YES')
  LOOP
    EXECUTE format('SELECT max(%I) FROM %I.%I',item.column_name,'public',item.table_name) INTO maximum;
    IF item.sequence_name IS NOT NULL AND maximum IS NOT NULL THEN
      PERFORM setval(item.sequence_name,maximum,true);
    END IF;
  END LOOP;
END $$;
SQL
restored=$(PGPASSWORD="$local_password" psql \
  "$restore_url" \
  -v ON_ERROR_STOP=1 -v tenant_id="$tenant_id" -AtF '|' <<'SQL'
SELECT
  (SELECT count(*) FROM customers)::text,
  (SELECT count(*) FROM bookings)::text,
  (SELECT count(*) FROM payments)::text,
  (SELECT count(*) FROM expenses)::text,
  (SELECT count(*) FROM contracts)::text,
  (SELECT count(*) FROM staff)::text,
  (SELECT count(*) FROM tenant_metadata WHERE tenant_id=:'tenant_id')::text,
  COALESCE((SELECT schema_version FROM tenant_metadata WHERE tenant_id=:'tenant_id'),'');
SQL
)
test "$restored" = "$tenant_state"
backup_checksum=$(cut -d' ' -f1 "$checksum_file")

summary_file="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
{
  echo "### Staging pilot verification"
  echo "- Lifecycle: ACTIVE / TRIAL / WAIVED"
  echo "- Trial period: exactly one calendar month"
  echo "- Registry and tenant DB: healthy"
  echo "- Owner membership and empty tenant: verified"
  echo "- Database-per-tenant isolation: verified"
  echo "- Failure/retry attempts: $attempt_count"
  echo "- Backup checksum (SHA-256): $backup_checksum"
  echo "- Backup/restore: repository schema + sequential tenant data verified on isolated PostgreSQL 18"
  echo "- Capacity note: the smallest permanent staging DB is not used as restore-capacity proof"
} >> "$summary_file"
