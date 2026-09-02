#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=/opt/amazing-studio
CONFIG="$ROOT/deploy.conf"
BACKUP_ROOT="$ROOT/backups/control-plane"
die(){ echo "[control-plane-recovery] ERROR: $*" >&2; exit 1; }

for tool in docker sha256sum sudo tar; do command -v "$tool" >/dev/null || die "Missing $tool"; done
sudo -n true >/dev/null || die "Passwordless sudo unavailable"

# Restore traversal only. Secrets keep their existing ownership and file modes.
sudo -n chown root:root "$ROOT"
sudo -n chmod 755 "$ROOT"
[ -r "$CONFIG" ] || die "deploy.conf is not readable by deploy account"
# shellcheck disable=SC1090
source "$CONFIG"
: "${DEPLOY_COMPOSE_FILE:?Missing DEPLOY_COMPOSE_FILE}"
[ -r "$DEPLOY_COMPOSE_FILE" ] || die "production compose is not readable by deploy account"

sudo -n docker compose -f "$DEPLOY_COMPOSE_FILE" config --quiet
services=$(sudo -n docker compose -f "$DEPLOY_COMPOSE_FILE" config --services)
grep -Fxq api <<<"$services" || die "compose is missing api service"
grep -Fxq web <<<"$services" || die "compose is missing web service"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$BACKUP_ROOT/$stamp"
sudo -n install -d -m 700 -o root -g root "$target"
sudo -n tar -czf "$target/control-plane.tar.gz" \
  -C "$ROOT" deploy.conf DEPLOYED_SHA app/06_vps_deployment/docker-compose.yml
sudo -n sha256sum "$target/control-plane.tar.gz" | sudo -n tee "$target/SHA256SUMS" >/dev/null
sudo -n sha256sum -c "$target/SHA256SUMS" >/dev/null

test "$(sudo -n stat -c '%a:%U:%G' "$ROOT")" = "755:root:root" || die "control root permissions drifted"
test "$(sudo -n stat -c '%a:%U:%G' "$CONFIG")" = "644:root:root" || die "deploy.conf permissions are unexpected"
echo "CONTROL_ROOT=755:root:root"
echo "DEPLOY_CONFIG=READABLE"
echo "COMPOSE=VALID"
echo "CONTROL_BACKUP=PASS"
