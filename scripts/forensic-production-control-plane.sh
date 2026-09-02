#!/usr/bin/env bash
set -Eeuo pipefail

echo "FORENSIC_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "HOSTNAME=$(hostname)"
echo "HEALTH=$(curl -fsS --max-time 15 https://tranchistudio.com/api/healthz | grep -o '"status":"[^"]*"' | head -n1)"
echo "DEPLOYED_SHA=$(sudo -n sed -n '1p' /opt/amazing-studio/DEPLOYED_SHA 2>/dev/null || echo MISSING)"
echo "API_DEPLOYED_SHA=$(sudo -n sed -n '1p' /opt/amazing-studio/API_DEPLOYED_SHA 2>/dev/null || echo MISSING)"

echo "--- RUNNING CONTAINERS ---"
sudo -n docker ps --format 'name={{.Names}} image={{.Image}} status={{.Status}} ports={{.Ports}}'
echo "--- COMPOSE PROJECTS ---"
sudo -n docker compose ls 2>/dev/null || true

echo "--- CONTAINER CONTROL LABELS ---"
while IFS= read -r cid; do
  name=$(sudo -n docker inspect "$cid" --format '{{.Name}}' | sed 's#^/##')
  echo "CONTAINER=$name"
  sudo -n docker inspect "$cid" --format 'image_id={{.Image}} restart={{.HostConfig.RestartPolicy.Name}} working_dir={{.Config.WorkingDir}}'
  sudo -n docker inspect "$cid" --format '{{range $k,$v := .Config.Labels}}{{if or (eq $k "com.docker.compose.project") (eq $k "com.docker.compose.project.config_files") (eq $k "com.docker.compose.project.working_dir") (eq $k "com.docker.compose.service")}}{{$k}}={{$v}}{{println}}{{end}}{{end}}'
  echo "mounts:"
  sudo -n docker inspect "$cid" --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}'
  echo "env_names:"
  sudo -n docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed 's/=.*//' | sort
done < <(sudo -n docker ps -q)

echo "--- CONTROL FILE CANDIDATES ---"
for root in /opt/amazing-studio /etc /root /home /var/backups; do
  sudo -n test -e "$root" || continue
  sudo -n find "$root" -xdev -type f \( -name 'deploy.conf' -o -name 'docker-compose.yml' -o -name 'docker-compose.yaml' -o -name 'compose.yml' -o -name 'compose.yaml' -o -name '*.bak' -o -name '*.backup' -o -name '*.old' \) \
    -printf '%TY-%Tm-%TdT%TH:%TM:%TSZ mode=%m owner=%u:%g size=%s path=%p\n' 2>/dev/null | sort
done

echo "--- RELEASES ---"
sudo -n find /opt/amazing-studio/releases -mindepth 1 -maxdepth 2 -type d -printf '%TY-%Tm-%TdT%TH:%TM:%TSZ %p\n' 2>/dev/null | sort || true
echo "--- APP TREE ---"
sudo -n find /opt/amazing-studio/app -xdev -maxdepth 3 -printf '%y mode=%m owner=%u:%g %p\n' 2>/dev/null | sort || true

echo "--- SERVICES AND TIMERS ---"
systemctl list-unit-files --type=service --type=timer --no-pager 2>/dev/null | grep -Ei 'amazing|studio|docker|deploy|cleanup' || true
sudo -n grep -RIlE 'amazing-studio|deploy.conf|rsync --delete|git clean|rm -rf' /etc/systemd /etc/cron.d /etc/cron.daily /etc/cron.hourly 2>/dev/null | sort || true
echo "FORENSIC_END=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
