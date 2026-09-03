#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
COMPOSE="$ROOT/compose.yaml"; ENV_FILE="$ROOT/.env"; SECRETS_DIR="$ROOT/secrets"; STATE_KEY="$SECRETS_DIR/state-encryption-key"; PREVIOUS_KEYS="$SECRETS_DIR/state-encryption-previous-keys"; BASE_URL="http://127.0.0.1:9042"; COMMAND="${1:-start}"
info() { printf '\033[36m[MakerHub]\033[0m %s\n' "$*"; }
ok() { printf '\033[32m[MakerHub]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[MakerHub]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[MakerHub]\033[0m %s\n' "$*" >&2; exit 1; }
random_hex() { if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; fi; }
random_key() { if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; else dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 | tr '+/' '-_' | tr -d '=\n'; fi; }
check_platform() { case "$(uname -m)" in x86_64|amd64) ;; *) die "Linux Release 仅支持 x86-64/amd64；当前架构：$(uname -m)" ;; esac; }
check_docker() { command -v docker >/dev/null 2>&1 || die "未找到 Docker。请先安装 Docker Engine。"; docker compose version >/dev/null 2>&1 || die "Docker Compose v2 不可用。"; docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || die "Docker Engine 未运行或当前用户没有访问权限。"; }
ensure_secrets() { mkdir -p "$SECRETS_DIR"; if [[ ! -f "$ENV_FILE" ]]; then umask 077; cat >"$ENV_FILE" <<EOF
MAKERHUB_POSTGRES_PASSWORD=$(random_hex)
MAKERHUB_CLOAKBROWSER_AUTH_TOKEN=$(random_hex)
MAKERHUB_BIND_ADDRESS=127.0.0.1
MAKERHUB_AUTO_VERIFY_3MF=false
TZ=Asia/Shanghai
EOF
chmod 600 "$ENV_FILE"; ok "已生成 .env"; fi; if [[ ! -f "$STATE_KEY" ]]; then umask 077; printf 'base64:%s' "$(random_key)" >"$STATE_KEY"; chmod 600 "$STATE_KEY"; ok "已生成 AES-256 状态加密主密钥"; fi; if [[ ! -f "$PREVIOUS_KEYS" ]]; then umask 077; : >"$PREVIOUS_KEYS"; chmod 600 "$PREVIOUS_KEYS"; fi; }
wait_ready() { local timeout="${1:-180}" elapsed=0; while (( elapsed < timeout )); do if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 3 "$BASE_URL/api/public/health/ready" >/dev/null 2>&1 && { ok "服务已就绪：$BASE_URL"; return 0; }; elif command -v wget >/dev/null 2>&1; then wget -q -T 3 -O /dev/null "$BASE_URL/api/public/health/ready" >/dev/null 2>&1 && { ok "服务已就绪：$BASE_URL"; return 0; }; else docker compose -f "$COMPOSE" exec -T makerhub-app python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/public/health/ready', timeout=3)" >/dev/null 2>&1 && { ok "服务已就绪：$BASE_URL"; return 0; }; fi; sleep 2; elapsed=$((elapsed + 2)); done; docker compose -f "$COMPOSE" ps || true; die "MakerHub 在 ${timeout}s 内未进入 ready 状态。运行 ./makerhub.sh logs 查看日志。"; }
show_password() { local password; password="$(docker compose -f "$COMPOSE" exec -T makerhub-app sh -lc 'cat /app/config/state/admin-bootstrap-password 2>/dev/null || true' | tr -d '\r' | tail -n 1)"; if [[ -n "$password" ]]; then printf '\n首次登录用户名：admin\n'; printf '\033[33m一次性密码：%s\033[0m\n' "$password"; printf '\033[33m登录后请立即修改密码。\033[0m\n'; else info "未发现一次性密码文件；如果已修改过管理员密码，这是正常的。"; fi; }
doctor() { check_platform; check_docker; ensure_secrets; docker compose -f "$COMPOSE" config --quiet; ok "Compose 配置：OK"; docker compose -f "$COMPOSE" ps; if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 5 "$BASE_URL/api/public/health/ready" >/dev/null 2>&1; then ok "App readiness：OK"; else warn "App readiness：未就绪"; fi; docker compose -f "$COMPOSE" exec -T makerhub-worker python -m app.worker --healthcheck >/dev/null 2>&1 && ok "Worker heartbeat：OK" || warn "Worker heartbeat：失败"; docker compose -f "$COMPOSE" exec -T makerhub-postgres pg_isready -U makerhub -d makerhub >/dev/null 2>&1 && ok "PostgreSQL：OK" || warn "PostgreSQL：失败"; docker compose -f "$COMPOSE" exec -T makerhub-app python -c "import socket; s=socket.create_connection(('cloakbrowser',8080),5); s.close()" >/dev/null 2>&1 && ok "CloakBrowser network：OK" || warn "CloakBrowser network：失败"; }
check_platform; check_docker; ensure_secrets
case "$COMMAND" in
  start) info "拉取已验证的 Release 镜像..."; docker compose -f "$COMPOSE" pull; info "启动 MakerHub..."; docker compose -f "$COMPOSE" up -d; wait_ready; show_password; if [[ "${MAKERHUB_NO_OPEN:-0}" != "1" ]] && command -v xdg-open >/dev/null 2>&1; then xdg-open "$BASE_URL" >/dev/null 2>&1 || true; fi ;;
  stop) docker compose -f "$COMPOSE" down ;;
  restart) docker compose -f "$COMPOSE" restart; wait_ready ;;
  status) docker compose -f "$COMPOSE" ps ;;
  logs) docker compose -f "$COMPOSE" logs -f makerhub-app makerhub-worker ;;
  doctor) doctor ;;
  password) show_password ;;
  update) info "当前 Release 包固定到已验证镜像；update 仅重新拉取同一镜像并重建容器。"; docker compose -f "$COMPOSE" pull; docker compose -f "$COMPOSE" up -d; wait_ready ;;
  *) printf '%s\n' '用法：./makerhub.sh start|stop|restart|status|logs|doctor|password|update'; exit 2 ;;
esac
