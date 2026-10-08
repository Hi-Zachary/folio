#!/usr/bin/env bash
# Folio 停止脚本：结束本脚本启动的应用与依赖服务
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

log() { printf '\033[1;36m[folio]\033[0m %s\n' "$*"; }

[ -f .env ] && { set -a; . <(grep -v '^[[:space:]]*#' ./.env); set +a; }
APP_PORT="${APP_PORT:-6008}"
MYSQL_PORT="${MYSQL_PORT:-3307}"

kill_port() {
  local port="$1" name="$2" pids
  pids="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)"
  if [ -z "$pids" ]; then
    log "$name(:$port) 未在运行"
    return
  fi
  log "停止 $name(:$port) -> $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
}

kill_port "$APP_PORT" "Folio 应用"
kill_port 8080 "本地模型"
kill_port 6333 "Qdrant"
# 优雅关闭 MariaDB
if command -v mysqladmin >/dev/null 2>&1; then
  mysqladmin --socket="$ROOT/data/mysql.sock" -uroot ${MYSQL_PASSWORD:+-p"$MYSQL_PASSWORD"} shutdown 2>/dev/null \
    && log "MariaDB 已关闭" || kill_port "$MYSQL_PORT" "MariaDB"
fi
