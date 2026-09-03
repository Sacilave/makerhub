#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d -t makerhub-e2e-XXXXXX)"
export COMPOSE_PROJECT_NAME="makerhub-e2e-$$"
export MAKERHUB_POSTGRES_PASSWORD="e2e-$(date +%s%N)"
export MAKERHUB_CLOAKBROWSER_AUTH_TOKEN="e2e-$(date +%s%N)"
export MAKERHUB_BIND_ADDRESS=127.0.0.1
export MAKERHUB_CONFIG_PATH="$TMP/config"
export MAKERHUB_ARCHIVE_PATH="$TMP/archive"
export MAKERHUB_POSTGRES_DATA_PATH="$TMP/postgres"
export MAKERHUB_CLOAKBROWSER_DATA_PATH="$TMP/cloakbrowser"
export MAKERHUB_DATA_ENCRYPTION_KEY_PATH="$TMP/state-encryption-key"
export MAKERHUB_DATA_ENCRYPTION_PREVIOUS_KEYS_PATH="$TMP/state-encryption-previous-keys"
export MAKERHUB_AUTO_VERIFY_3MF=false

cleanup() {
  local status=$?
  local cleanup_image="${MAKERHUB_IMAGE:-}"

  # Never let cleanup replace the actual E2E result. Bind-mounted files can be
  # created as root by PostgreSQL/MakerHub containers, while the CI runner is
  # an unprivileged host user.
  trap - EXIT INT TERM
  set +e
  docker compose down -v --remove-orphans >/dev/null 2>&1

  if [[ -d "$TMP" ]]; then
    rm -rf "$TMP" >/dev/null 2>&1
  fi

  if [[ -d "$TMP" ]] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo rm -rf "$TMP" >/dev/null 2>&1
  fi

  if [[ -d "$TMP" ]] && [[ -n "$cleanup_image" ]] && docker image inspect "$cleanup_image" >/dev/null 2>&1; then
    docker run --rm --user 0:0 \
      -v "$TMP:/cleanup" \
      --entrypoint sh "$cleanup_image" \
      -c 'rm -rf /cleanup/* /cleanup/.[!.]* /cleanup/..?*' \
      >/dev/null 2>&1
    rm -rf "$TMP" >/dev/null 2>&1
  fi

  if [[ -d "$TMP" ]]; then
    echo "[release-gate] warning: unable to remove temporary directory $TMP" >&2
  fi

  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$TMP/config" "$TMP/archive" "$TMP/postgres" "$TMP/cloakbrowser"
printf 'base64:%s' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" >"$MAKERHUB_DATA_ENCRYPTION_KEY_PATH"
: >"$MAKERHUB_DATA_ENCRYPTION_PREVIOUS_KEYS_PATH"
chmod 600 "$MAKERHUB_DATA_ENCRYPTION_KEY_PATH" "$MAKERHUB_DATA_ENCRYPTION_PREVIOUS_KEYS_PATH"

if [[ -n "${MAKERHUB_E2E_IMAGE:-}" ]]; then
  export MAKERHUB_IMAGE="$MAKERHUB_E2E_IMAGE"
else
  export MAKERHUB_IMAGE='makerhub:e2e'
  docker compose build makerhub-app makerhub-worker
fi

docker compose up -d

wait_ready() {
  local elapsed=0
  while (( elapsed < 180 )); do
    if curl -fsS --max-time 3 http://127.0.0.1:9042/api/public/health/ready >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  docker compose ps
  docker compose logs --tail=200 makerhub-app makerhub-worker makerhub-postgres cloakbrowser || true
  return 1
}

wait_ready
docker compose exec -T makerhub-postgres pg_isready -U makerhub -d makerhub
docker compose exec -T makerhub-worker python -m app.worker --healthcheck
docker compose exec -T makerhub-app python -c "import socket; s=socket.create_connection(('cloakbrowser',8080),5); s.close()"

PASSWORD="$(docker compose exec -T makerhub-app sh -lc 'cat /app/config/state/admin-bootstrap-password' | tr -d '\r' | tail -n 1)"
[[ -n "$PASSWORD" ]]

MAKERHUB_BASE_URL=http://127.0.0.1:9042 \
MAKERHUB_USERNAME=admin \
MAKERHUB_PASSWORD="$PASSWORD" \
  bash scripts/check_runtime_engine_flows.sh

ENCRYPTED="$(docker compose exec -T makerhub-postgres psql -U makerhub -d makerhub -Atc "SELECT CASE WHEN value ? '_makerhub_encrypted_state' THEN 'yes' ELSE 'no' END FROM makerhub_json_state WHERE key='app_config';" | tr -d '\r')"
[[ "$ENCRYPTED" == yes ]]

QUEUE_ENVELOPE="$(docker compose exec -T makerhub-postgres psql -U makerhub -d makerhub -Atc "SELECT COALESCE((SELECT CASE WHEN value ? '_makerhub_encrypted_state' THEN 'yes' ELSE 'no' END FROM makerhub_json_state WHERE key='archive_queue'),'missing');" | tr -d '\r')"
[[ "$QUEUE_ENVELOPE" != yes ]]

docker compose exec -T makerhub-app python -c "from importlib.metadata import version; import cv2; assert version('pillow')=='12.3.0'; assert version('cryptography')=='50.0.1'; assert cv2.__version__.startswith('4.14.')"

docker compose restart makerhub-app makerhub-worker >/dev/null
wait_ready
docker compose exec -T makerhub-worker python -m app.worker --healthcheck
MAKERHUB_BASE_URL=http://127.0.0.1:9042 \
MAKERHUB_USERNAME=admin \
MAKERHUB_PASSWORD="$PASSWORD" \
  bash scripts/check_runtime_engine_flows.sh

echo '[release-gate] PASS'
