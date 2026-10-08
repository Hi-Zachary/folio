#!/usr/bin/env bash
# Folio 一键启动脚本（AutoDL 容器，无 Docker）
#
# 用法:
#   ./start.sh                                   # 用 .env 里已有的 APP_ORIGIN 启动
#   ./start.sh https://xxx.seetacloud.com:8443   # 覆盖 APP_ORIGIN（公网映射变了就传这个）
#
# 说明:
#   - 依次拉起 MariaDB(3307) / Qdrant(6333) / 本地 Embedding+Rerank(8080) / Folio 应用(APP_PORT)
#   - 已监听的端口会跳过，可重复执行（幂等）
#   - 前端按同源 /api 访问，VITE_API_URL 必须留空；公网地址变化只需改 APP_ORIGIN，
#     无需重新 build。仅当 dist/ 或 dist-server/ 缺失、或前端源码/代理有改动时才 build。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

log() { printf '\033[1;36m[folio]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[folio]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[folio]\033[0m %s\n' "$*" >&2; exit 1; }

PUBLIC_ORIGIN="${1:-}"

# ---------- 环境准备 ----------
[ -f .env ] || die ".env 不存在，请先 cp .env.example .env 并填写 AI_API_KEY / MYSQL_PASSWORD"

if [ -n "$PUBLIC_ORIGIN" ]; then
  if grep -q '^APP_ORIGIN=' .env; then
    sed -i "s|^APP_ORIGIN=.*|APP_ORIGIN=${PUBLIC_ORIGIN}|" .env
  else
    printf '\nAPP_ORIGIN=%s\n' "$PUBLIC_ORIGIN" >> .env
  fi
  log "APP_ORIGIN -> ${PUBLIC_ORIGIN}"
fi

# 读取 .env（忽略以 # 开头的注释行）
set -a
# shellcheck disable=SC1091
. <(grep -v '^[[:space:]]*#' ./.env)
set +a

APP_PORT="${APP_PORT:-6008}"
PUBLIC_BASE_PATH="${PUBLIC_BASE_PATH:-/folio}"
MYSQL_PORT="${MYSQL_PORT:-3307}"
MYSQL_DATABASE="${MYSQL_DATABASE:-folio}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-}"
UPLOAD_DIR="${UPLOAD_DIR:-$ROOT/data/storage}"

hostport() { local u="${1#*://}"; u="${u%%/*}"; echo "${u##*:}"; }
QDRANT_PORT="$(hostport "${QDRANT_URL:-http://127.0.0.1:6333}")"
LOCAL_PORT="$(hostport "${EMBEDDING_BASE_URL:-http://127.0.0.1:8080/v1}")"

is_listening() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }

wait_port() {
  local port="$1" name="$2" i=0
  while ! is_listening "$port"; do
    i=$((i + 1))
    [ "$i" -ge "${3:-60}" ] && { warn "$name(:$port) 启动超时，见 data/*.log"; return 1; }
    sleep 1
  done
  log "$name(:$port) 已就绪"
}

mkdir -p "$ROOT/data" "$ROOT/data/qdrant/storage" "$ROOT/data/qdrant/snapshots" \
  "$ROOT/data/hf-cache" "$UPLOAD_DIR"

# ---------- 1. MariaDB ----------
if is_listening "$MYSQL_PORT"; then
  log "MariaDB(:$MYSQL_PORT) 已在运行"
else
  log "启动 MariaDB(:$MYSQL_PORT) ..."
  FRESH_DB=0
  if [ ! -d "$ROOT/data/mysql/mysql" ]; then
    FRESH_DB=1
    log "初始化 MariaDB 数据目录 ..."
    mariadb-install-db --user=root --datadir="$ROOT/data/mysql" \
      --auth-root-authentication-method=normal >/dev/null
  fi
  nohup mariadbd --user=root \
    --datadir="$ROOT/data/mysql" \
    --port="$MYSQL_PORT" \
    --socket="$ROOT/data/mysql.sock" \
    --pid-file="$ROOT/data/mysql.pid" \
    --bind-address=127.0.0.1 \
    --skip-networking=0 \
    >>"$ROOT/data/mysql.log" 2>&1 &
  wait_port "$MYSQL_PORT" MariaDB 60

  if [ "$FRESH_DB" = "1" ]; then
    log "创建数据库与账户 ..."
    mysql --socket="$ROOT/data/mysql.sock" -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '${MYSQL_PASSWORD}';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;
ALTER USER 'root'@'localhost' IDENTIFIED BY '${MYSQL_PASSWORD}';
FLUSH PRIVILEGES;
SQL
  fi
fi

# ---------- 2. Qdrant ----------
if is_listening "$QDRANT_PORT"; then
  log "Qdrant(:$QDRANT_PORT) 已在运行"
elif [ -x "$ROOT/vendor/qdrant/qdrant" ]; then
  log "启动 Qdrant(:$QDRANT_PORT) ..."
  QDRANT__STORAGE__STORAGE_PATH="$ROOT/data/qdrant/storage" \
  QDRANT__STORAGE__SNAPSHOTS_PATH="$ROOT/data/qdrant/snapshots" \
  QDRANT__SERVICE__HOST=127.0.0.1 \
  QDRANT__TELEMETRY_DISABLED=true \
    nohup "$ROOT/vendor/qdrant/qdrant" >>"$ROOT/data/qdrant.log" 2>&1 &
  wait_port "$QDRANT_PORT" Qdrant 30
else
  warn "未找到 vendor/qdrant/qdrant，跳过 Qdrant（将回退 MySQL 向量检索）"
fi

# ---------- 3. 本地 Embedding + Rerank ----------
if is_listening "$LOCAL_PORT"; then
  log "本地 Embedding/Rerank(:$LOCAL_PORT) 已在运行"
elif [ -f "$ROOT/local_models/serve.py" ]; then
  log "启动本地 Embedding/Rerank(:$LOCAL_PORT) ..."
  HF_HOME="$ROOT/data/hf-cache" \
  LOCAL_EMBEDDING_MODEL="${LOCAL_EMBEDDING_MODEL:-$ROOT/models/bge-m3}" \
  LOCAL_RERANK_MODEL="${LOCAL_RERANK_MODEL:-$ROOT/models/bge-reranker-v2-m3}" \
  LOCAL_MODEL_THREADS="${LOCAL_MODEL_THREADS:-$(nproc)}" \
    nohup python3 "$ROOT/local_models/serve.py" --port "$LOCAL_PORT" \
    >>"$ROOT/data/local-models.log" 2>&1 &
  wait_port "$LOCAL_PORT" "本地模型" 180
else
  warn "未找到 local_models/serve.py，跳过本地模型"
fi

# ---------- 4. 依赖与构建 ----------
if [ ! -d "$ROOT/node_modules" ]; then
  log "安装 node 依赖 (npm ci) ..."
  npm ci
fi

if [ ! -f "$ROOT/dist/index.html" ] || [ ! -d "$ROOT/dist-server/src" ]; then
  warn "未检测到构建产物，执行 npm run build ..."
  npm run build
fi

if [ -n "${VITE_API_URL:-}" ]; then
  warn "检测到 VITE_API_URL 非空：前端会直连该地址，公网变化后需要重新 npm run build:client。建议留空走同源 /api。"
fi

# ---------- 5. Folio 应用 ----------
if is_listening "$APP_PORT"; then
  log "Folio 应用(:$APP_PORT) 已在运行"
else
  log "启动 Folio 应用(:$APP_PORT) ..."
  NODE_ENV=production nohup node "$ROOT/dist-server/src/index.js" \
    >>"$ROOT/data/app.log" 2>&1 &
  wait_port "$APP_PORT" Folio 60
fi

# ---------- 6. 健康检查 + 输出 ----------
HEALTH="$(curl -s -m 10 "http://127.0.0.1:${APP_PORT}/api/health" || true)"
if printf '%s' "$HEALTH" | grep -q '"ok":true'; then
  log "健康检查通过: $HEALTH"
else
  warn "健康检查未通过: ${HEALTH:-无响应}（见 data/app.log）"
fi

ORIGIN="${APP_ORIGIN:-http://127.0.0.1:${APP_PORT}}"
BASE="${PUBLIC_BASE_PATH%/}"
printf '\n'
log "访问地址:      ${ORIGIN}${BASE}/"
log "健康检查:      ${ORIGIN}/api/health"
log "本地直连:      http://127.0.0.1:${APP_PORT}${BASE}/"
printf '\n'
log "停止: ./stop.sh"
