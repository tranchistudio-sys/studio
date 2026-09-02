#!/usr/bin/env bash
set -Eeuo pipefail
sha=${1:?tested SHA required}; archive=${2:?archive required}; incoming_env=${3:?env required}
root=/opt/amazing-studio-preview; releases=$root/releases; release=$releases/$sha
compose=$release/deploy/preview/docker-compose.preview.yml; env_file=$root/preview.env; project=amazing-preview
bootstrap_dump=$root/bootstrap/tenant-template-staging.dump
bootstrap_sha=a984718b0fb723f48063dccac8dce2e6b80bd642e2345924ec0cab3272af0919
candidate="amazing-studio-preview:candidate-$sha"; current=amazing-studio-preview:current; rollback=amazing-studio-preview:rollback
case "$sha" in *[!0-9a-f]*|'') exit 2;; esac
[[ "$archive" == /tmp/amazing-preview-source-* && "$incoming_env" == /tmp/amazing-preview-*.env ]]
free_gb() { df -Pk / | awk 'NR==2 {print int($4/1024/1024)}'; }
before=$(free_gb); (( before >= 10 )) || { echo "ABORT: ${before}GB free, need 10GB" >&2; exit 1; }
install -d -m 700 "$root" "$releases"; rm -rf "$release"; install -d -m 700 "$release"
tar -xzf "$archive" -C "$release"; install -m 600 "$incoming_env" "$env_file"
set -a; source "$env_file"; set +a
docker image inspect "$current" >/dev/null 2>&1 && docker image tag "$current" "$rollback" || true
rollback_preview() {
  echo "Rolling back Preview only" >&2
  if docker image inspect "$rollback" >/dev/null 2>&1; then
    docker image tag "$rollback" "$current"
    docker compose --project-name "$project" --env-file "$env_file" -f "$compose" up -d --no-build --force-recreate app || true
  else docker compose --project-name "$project" --env-file "$env_file" -f "$compose" rm -sf app || true; fi
  docker image rm "$candidate" >/dev/null 2>&1 || true
}
trap rollback_preview ERR
docker build --label com.amazing-studio.scope=preview --label "com.amazing-studio.commit=$sha" -t "$candidate" -f "$release/Dockerfile" "$release"
docker image tag "$candidate" "$current"
docker compose --project-name "$project" --env-file "$env_file" -f "$compose" up -d --no-build db
for attempt in $(seq 1 30); do
  docker exec amazing-preview-db pg_isready -U preview -d amazing_preview >/dev/null 2>&1 && break
  (( attempt < 30 )) || { echo "Preview DB readiness failed" >&2; false; }
  sleep 2
done
marker=$(docker exec amazing-preview-db psql -U preview -d amazing_preview -Atqc \
  "SELECT to_regclass('public.preview_db_marker') IS NOT NULL")
if [[ "$marker" != t ]]; then
  [[ -r "$bootstrap_dump" ]] || { echo "Missing safe Preview bootstrap dump" >&2; false; }
  echo "$bootstrap_sha  $bootstrap_dump" | sha256sum -c -
  tables=$(docker exec amazing-preview-db psql -U preview -d amazing_preview -Atqc \
    "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
  [[ "$tables" == 0 ]] || { echo "Unmarked Preview DB is not empty; refusing restore" >&2; false; }
  docker exec -i amazing-preview-db pg_restore -U preview -d amazing_preview --no-owner --no-privileges < "$bootstrap_dump"
  unsafe=$(docker exec amazing-preview-db psql -U preview -d amazing_preview -Atqc \
    "SELECT (SELECT count(*) FROM customers)+(SELECT count(*) FROM fb_inbox_messages)+(SELECT count(*) FROM settings)+(SELECT count(*) FROM push_subscriptions)")
  [[ "$unsafe" == 0 ]] || { echo "Bootstrap dataset contains sensitive/outbound rows" >&2; false; }
  docker exec amazing-preview-db psql -U preview -d amazing_preview -v ON_ERROR_STOP=1 -c \
    "CREATE TABLE preview_db_marker(id integer PRIMARY KEY,is_preview boolean NOT NULL,seeded_at timestamptz NOT NULL DEFAULT now(),note text); INSERT INTO preview_db_marker VALUES(1,true,now(),'Empty staging template; no customer or outbound data');"
fi
login_hash=$(docker run --rm --network none -e PREVIEW_LOGIN_PASSWORD "$candidate" node -e \
  "const {createRequire}=require('node:module'); const requireFromApi=createRequire('/app/artifacts/api-server/package.json'); requireFromApi('bcryptjs').hash(process.env.PREVIEW_LOGIN_PASSWORD,10).then(console.log)")
docker exec -i amazing-preview-db psql -U preview -d amazing_preview -v ON_ERROR_STOP=1 \
  -v login="$PREVIEW_LOGIN_USERNAME" -v hash="$login_hash" <<'SQL'
UPDATE staff SET password_hash=:'hash' WHERE username=:'login';
INSERT INTO staff(name,phone,role,roles,username,password_hash,is_active)
SELECT 'Preview Owner','0000000000','admin','["admin"]'::jsonb,:'login',:'hash',1
WHERE NOT EXISTS (SELECT 1 FROM staff WHERE username=:'login');
SQL
docker compose --project-name "$project" --env-file "$env_file" -f "$compose" up -d --no-build db app
for attempt in $(seq 1 30); do
  body=$(curl -fsS --max-time 5 http://172.30.0.3:8080/api/healthz 2>/dev/null || true)
  [[ "$body" == *'"status":"ok"'* ]] && break
  (( attempt < 30 )) || { echo "Preview health failed" >&2; false; }
  sleep 5
done
after=$(free_gb); (( after >= 8 )) || { echo "Only ${after}GB free after build" >&2; false; }
trap - ERR; docker image rm "$candidate" >/dev/null 2>&1 || true
find "$releases" -mindepth 1 -maxdepth 1 -type d ! -path "$release" -exec rm -rf -- {} +
echo "Preview $sha healthy; disk ${before}GB -> ${after}GB"
