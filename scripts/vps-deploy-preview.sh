#!/usr/bin/env bash
set -Eeuo pipefail
sha=${1:?tested SHA required}; archive=${2:?archive required}; incoming_env=${3:?env required}
root=/opt/amazing-studio-preview; releases=$root/releases; release=$releases/$sha
compose=$release/deploy/preview/docker-compose.preview.yml; env_file=$root/preview.env; project=amazing-preview
candidate="amazing-studio-preview:candidate-$sha"; current=amazing-studio-preview:current; rollback=amazing-studio-preview:rollback
case "$sha" in *[!0-9a-f]*|'') exit 2;; esac
[[ "$archive" == /tmp/amazing-preview-source-* && "$incoming_env" == /tmp/amazing-preview-*.env ]]
free_gb() { df -Pk / | awk 'NR==2 {print int($4/1024/1024)}'; }
before=$(free_gb); (( before >= 10 )) || { echo "ABORT: ${before}GB free, need 10GB" >&2; exit 1; }
install -d -m 700 "$root" "$releases"; rm -rf "$release"; install -d -m 700 "$release"
tar -xzf "$archive" -C "$release"; install -m 600 "$incoming_env" "$env_file"
docker image inspect "$current" >/dev/null 2>&1 && docker image tag "$current" "$rollback" || true
rollback_preview() {
  echo "Rolling back Preview only" >&2
  if docker image inspect "$rollback" >/dev/null 2>&1; then
    docker image tag "$rollback" "$current"
    docker compose --project-name "$project" --env-file "$env_file" -f "$compose" up -d --no-build db app || true
  else docker compose --project-name "$project" --env-file "$env_file" -f "$compose" rm -sf app || true; fi
  docker image rm "$candidate" >/dev/null 2>&1 || true
}
trap rollback_preview ERR
docker build --label com.amazing-studio.scope=preview --label "com.amazing-studio.commit=$sha" -t "$candidate" -f "$release/Dockerfile" "$release"
docker image tag "$candidate" "$current"
docker compose --project-name "$project" --env-file "$env_file" -f "$compose" up -d --no-build db app
for attempt in $(seq 1 30); do
  body=$(curl -fsS --max-time 5 http://127.0.0.1:18080/api/healthz 2>/dev/null || true)
  [[ "$body" == *'"status":"ok"'* ]] && break
  (( attempt < 30 )) || { echo "Preview health failed" >&2; false; }
  sleep 5
done
after=$(free_gb); (( after >= 8 )) || { echo "Only ${after}GB free after build" >&2; false; }
trap - ERR; docker image rm "$candidate" >/dev/null 2>&1 || true
find "$releases" -mindepth 1 -maxdepth 1 -type d ! -path "$release" -exec rm -rf -- {} +
echo "Preview $sha healthy; disk ${before}GB -> ${after}GB"

