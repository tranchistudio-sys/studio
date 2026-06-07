#!/usr/bin/env bash
# Chạy full stack local: Postgres + API (3000) + Frontend (5000+)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Thiếu file .env tại $ENV_FILE"
  echo "Copy từ .env.example và sửa DATABASE_URL."
  exit 1
fi

# Postgres.app
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:${PATH:-}"

if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  echo "PostgreSQL chưa chạy. Mở Postgres.app → Initialize / Start."
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

export NODE_ENV="${NODE_ENV:-development}"
export PORT="${PORT:-3000}"
export LOCAL_OBJECT_STORAGE_DIR="${LOCAL_OBJECT_STORAGE_DIR:-$ROOT/artifacts/data/object-storage}"

PNPM=(npx --yes pnpm@10)

echo "=== Amazing Studio — local dev ==="
echo "DATABASE_URL=${DATABASE_URL:-<missing>}"
echo "API PORT=$PORT"
echo ""

case "${1:-}" in
  api)
    exec "${PNPM[@]}" --filter @workspace/api-server run dev
    ;;
  web)
    exec "${PNPM[@]}" --filter @workspace/amazing-studio run dev
    ;;
  check)
    exec node "$ROOT/scripts/verify-stack.mjs"
    ;;
  *)
    echo "Dùng 2 terminal:"
    echo "  Terminal 1: ./scripts/dev-local.sh api"
    echo "  Terminal 2: ./scripts/dev-local.sh web"
    echo ""
    echo "Kiểm tra:     ./scripts/dev-local.sh check"
    ;;
esac
