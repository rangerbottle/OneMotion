#!/usr/bin/env bash
#
# OneMotion local dev orchestrator.
#
#   ./dev.sh deps      check toolchain + project dependencies, install what's missing
#   ./dev.sh start     start the backend (FastAPI) and web (Next.js) servers
#   ./dev.sh status    report whether each server is up and healthy
#   ./dev.sh stop      stop both servers
#   ./dev.sh restart   stop then start
#   ./dev.sh logs      tail both server logs
#
# Env overrides:
#   ONEMOTION_PUBLIC_HOST   LAN address (e.g. 192.168.0.132) to serve other devices;
#                           binds both servers to 0.0.0.0 and fixes the API URL + CORS
#   ONEMOTION_API_PORT (8000)   ONEMOTION_WEB_PORT (3000)
#   ONEMOTION_API_HOST / ONEMOTION_WEB_HOST   explicit bind address (advanced)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
WEB_DIR="$REPO_ROOT/apps/web"
RUN_DIR="$REPO_ROOT/.run"

API_PORT="${ONEMOTION_API_PORT:-8000}"
WEB_PORT="${ONEMOTION_WEB_PORT:-3000}"

# By default both servers bind to loopback only (127.0.0.1) — reachable from this
# machine, not from other devices. Set ONEMOTION_PUBLIC_HOST to your LAN address
# (e.g. 192.168.0.132) to serve the rest of the network: both servers then bind
# to all interfaces, the browser is pointed at the API by that address, and the
# web origin is added to the backend's CORS allow-list.
PUBLIC_HOST="${ONEMOTION_PUBLIC_HOST:-}"
if [ -n "$PUBLIC_HOST" ]; then
  API_BIND="${ONEMOTION_API_HOST:-0.0.0.0}"
  WEB_BIND="${ONEMOTION_WEB_HOST:-0.0.0.0}"
  API_ADVERTISE="$PUBLIC_HOST"
  WEB_ADVERTISE="$PUBLIC_HOST"
else
  API_BIND="${ONEMOTION_API_HOST:-127.0.0.1}"
  WEB_BIND="${ONEMOTION_WEB_HOST:-127.0.0.1}"
  API_ADVERTISE="127.0.0.1"
  WEB_ADVERTISE="127.0.0.1"
fi
API_BASE="http://${API_ADVERTISE}:${API_PORT}"          # how a browser reaches the API
WEB_BASE="http://${WEB_ADVERTISE}:${WEB_PORT}"          # how a person reaches the app
API_SSR_BASE="http://127.0.0.1:${API_PORT}"             # Next.js server-side calls (same host)
ALLOWED_ORIGINS="http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT},${WEB_BASE}"

API_PID_FILE="$RUN_DIR/api.pid"
WEB_PID_FILE="$RUN_DIR/web.pid"
API_LOG="$RUN_DIR/api.log"
WEB_LOG="$RUN_DIR/web.log"
NPM_CACHE="$RUN_DIR/npm-cache"

MIN_NODE_MAJOR=20

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi
info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s ok %s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s warn%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%s err %s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# toolchain
# ---------------------------------------------------------------------------
ensure_uv_on_path() {
  # uv's installer drops the binary here; make sure we can see it.
  [ -d "$HOME/.local/bin" ] && case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
  export PATH
}

install_uv() {
  info "installing uv (astral.sh)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  ensure_uv_on_path
  command -v uv >/dev/null || die "uv install did not land on PATH — open a new shell and retry"
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

check_toolchain() {
  local missing=0
  for tool in curl; do
    command -v "$tool" >/dev/null || { err "missing required tool: $tool"; missing=1; }
  done
  command -v lsof >/dev/null || warn "lsof not found — port checks/stop will be less reliable"

  ensure_uv_on_path
  if command -v uv >/dev/null; then
    ok "uv $(uv --version | awk '{print $2}')"
  else
    install_uv
    ok "uv $(uv --version | awk '{print $2}')"
  fi

  if ! command -v node >/dev/null; then
    err "Node.js not found — install Node >= ${MIN_NODE_MAJOR} (nvm, Homebrew, or nodejs.org) and retry"
    missing=1
  elif [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
    err "Node $(node --version) is too old — need >= ${MIN_NODE_MAJOR}"
    missing=1
  else
    ok "node $(node --version)  npm $(npm --version)"
  fi

  [ "$missing" -eq 0 ] || die "fix the missing toolchain above, then re-run"
}

# ---------------------------------------------------------------------------
# project dependencies
# ---------------------------------------------------------------------------
backend_deps_ok() { [ -x "$BACKEND_DIR/.venv/bin/python" ]; }
web_deps_ok()     { [ -d "$WEB_DIR/node_modules" ] && [ -e "$WEB_DIR/node_modules/.package-lock.json" ]; }

sync_backend_deps() {
  ensure_uv_on_path
  info "syncing backend deps (uv sync)…"
  ( cd "$BACKEND_DIR" && uv sync )
  ok "backend deps ready"
}

install_web_deps() {
  info "installing web deps (npm ci)…"
  if ! ( cd "$WEB_DIR" && npm ci ); then
    warn "npm ci failed (often a root-owned ~/.npm/_cacache) — retrying with a project-local cache"
    warn "permanent fix: sudo chown -R \"\$(id -u):\$(id -g)\" ~/.npm"
    mkdir -p "$NPM_CACHE"
    ( cd "$WEB_DIR" && npm ci --cache "$NPM_CACHE" )
  fi
  ok "web deps ready"
}

check_reference_media() {
  local bench="$REPO_ROOT/data/benchmarks/curry_v3.json"
  local video="$REPO_ROOT/data/raw_videos/curry/curry_v3_reference.mp4"
  local model="$REPO_ROOT/models/yolo11n-pose.pt"
  [ -f "$model" ] && ok "pose model present" || warn "pose model missing: models/yolo11n-pose.pt (see README)"
  if [ -f "$bench" ] && [ -f "$video" ]; then
    ok "Curry v3 reference media present"
  else
    warn "Curry v3 reference media missing — /health works but shot analysis returns 503"
    warn "  need: data/benchmarks/curry_v3.json + data/raw_videos/curry/curry_v3_reference.mp4"
    warn "  build these from an approved source clip (see README 'Local development')"
  fi
}

cmd_deps() {
  check_toolchain
  backend_deps_ok && ok "backend deps ready" || sync_backend_deps
  web_deps_ok     && ok "web deps ready"     || install_web_deps
  check_reference_media
  info "dependencies satisfied"
}

# ---------------------------------------------------------------------------
# process helpers
# ---------------------------------------------------------------------------
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

read_pid() { [ -f "$1" ] && cat "$1" 2>/dev/null || true; }

port_pids() { command -v lsof >/dev/null && lsof -ti "tcp:$1" 2>/dev/null || true; }

port_busy() { [ -n "$(port_pids "$1")" ]; }

wait_for_http() { # url timeout_seconds
  local url="$1" timeout="${2:-60}" i=0
  while [ "$i" -lt "$timeout" ]; do
    curl -sf -o /dev/null --max-time 3 "$url" && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}

kill_pid_tree() { # pid
  local pid="$1"
  pid_alive "$pid" || return 0
  # children first (npm -> next dev -> workers)
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pid_alive "$pid" || return 0
    sleep 0.5
  done
  pkill -KILL -P "$pid" 2>/dev/null || true
  kill -KILL "$pid" 2>/dev/null || true
}

stop_service() { # name pid_file port
  local name="$1" pid_file="$2" port="$3"
  local stopped=0
  local pid; pid="$(read_pid "$pid_file")"
  if pid_alive "$pid"; then
    info "stopping $name (pid $pid)…"
    kill_pid_tree "$pid"
    stopped=1
  fi
  # backstop: anything still holding the port
  local leftover; leftover="$(port_pids "$port")"
  if [ -n "$leftover" ]; then
    info "freeing port $port ($(echo "$leftover" | tr '\n' ' '))…"
    # shellcheck disable=SC2086
    kill -TERM $leftover 2>/dev/null || true
    sleep 1
    leftover="$(port_pids "$port")"
    # shellcheck disable=SC2086
    [ -n "$leftover" ] && kill -KILL $leftover 2>/dev/null || true
    stopped=1
  fi
  rm -f "$pid_file"
  [ "$stopped" -eq 1 ] && ok "$name stopped" || info "$name was not running"
}

# ---------------------------------------------------------------------------
# start / stop / status
# ---------------------------------------------------------------------------
cmd_start() {
  check_toolchain
  backend_deps_ok || sync_backend_deps
  web_deps_ok     || install_web_deps
  mkdir -p "$RUN_DIR"

  # backend
  if pid_alive "$(read_pid "$API_PID_FILE")"; then
    info "backend already running (pid $(read_pid "$API_PID_FILE"))"
  elif port_busy "$API_PORT"; then
    die "port $API_PORT is already in use by another process — free it or set ONEMOTION_API_PORT"
  else
    info "starting backend on $API_BASE …"
    ensure_uv_on_path
    (
      cd "$BACKEND_DIR" &&
      ONEMOTION_ALLOWED_ORIGINS="$ALLOWED_ORIGINS" \
        exec uv run uvicorn app.main:app --host "$API_BIND" --port "$API_PORT"
    ) >"$API_LOG" 2>&1 &
    echo $! >"$API_PID_FILE"
    if wait_for_http "$API_SSR_BASE/health" 60; then
      ok "backend healthy ($API_BASE/health)"
    else
      err "backend did not become healthy in 60s — see $API_LOG"
      tail -n 20 "$API_LOG" >&2 || true
      exit 1
    fi
  fi

  # web
  if pid_alive "$(read_pid "$WEB_PID_FILE")"; then
    info "web already running (pid $(read_pid "$WEB_PID_FILE"))"
  elif port_busy "$WEB_PORT"; then
    die "port $WEB_PORT is already in use by another process — free it or set ONEMOTION_WEB_PORT"
  else
    info "starting web on $WEB_BASE …"
    (
      cd "$WEB_DIR" &&
      NEXT_PUBLIC_API_BASE="$API_BASE" ONEMOTION_API_BASE="$API_SSR_BASE" \
        exec npm run dev -- --hostname "$WEB_BIND" --port "$WEB_PORT"
    ) >"$WEB_LOG" 2>&1 &
    echo $! >"$WEB_PID_FILE"
    if wait_for_http "$WEB_BASE" 120; then
      ok "web serving ($WEB_BASE)"
    else
      err "web did not come up in 120s — see $WEB_LOG"
      tail -n 20 "$WEB_LOG" >&2 || true
      exit 1
    fi
  fi

  echo
  cmd_status || true
  echo
  info "open $WEB_BASE  ·  logs: ./dev.sh logs  ·  stop: ./dev.sh stop"
}

cmd_stop() {
  stop_service "web" "$WEB_PID_FILE" "$WEB_PORT"
  stop_service "backend" "$API_PID_FILE" "$API_PORT"
}

report_service() { # name base pid_file health_path
  local name="$1" base="$2" pid_file="$3" health_path="${4:-}"
  local pid; pid="$(read_pid "$pid_file")"
  local running="no" pidinfo="pid file: none"
  if pid_alive "$pid"; then running="yes"; pidinfo="pid $pid"
  elif port_busy "$(echo "$base" | sed 's|.*:||')"; then running="yes"; pidinfo="pid $(port_pids "$(echo "$base" | sed 's|.*:||')" | tr '\n' ' ')(not from dev.sh)"
  fi

  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$base${health_path}" 2>/dev/null || echo 000)"

  if [ "$running" = "yes" ] && [ "$code" != "000" ]; then
    ok "$name — up ($pidinfo) — HTTP $code $base${health_path}"
    return 0
  elif [ "$running" = "yes" ]; then
    warn "$name — process up ($pidinfo) but not answering on $base${health_path}"
    return 1
  else
    err "$name — down"
    return 1
  fi
}

cmd_status() {
  local rc=0
  report_service "backend" "$API_BASE" "$API_PID_FILE" "/health" || rc=1

  # /ready is dependency-aware; surface why it is not ready if applicable.
  local ready_body
  ready_body="$(curl -s --max-time 4 "$API_BASE/ready" 2>/dev/null || true)"
  if [ -n "$ready_body" ]; then
    if echo "$ready_body" | grep -q '"status": *"ready"' || echo "$ready_body" | grep -q '"status":"ready"'; then
      ok "backend /ready — ready (analysis enabled)"
    else
      warn "backend /ready — not ready (analysis disabled):"
      echo "$ready_body" | sed 's/^/       /'
    fi
  fi

  report_service "web" "$WEB_BASE" "$WEB_PID_FILE" "/" || rc=1
  return "$rc"
}

cmd_restart() { cmd_stop; echo; cmd_start; }

cmd_logs() {
  local files=()
  [ -f "$API_LOG" ] && files+=("$API_LOG")
  [ -f "$WEB_LOG" ] && files+=("$WEB_LOG")
  [ "${#files[@]}" -eq 0 ] && die "no logs yet — start the servers first"
  info "tailing ${files[*]} (Ctrl-C to stop)"
  tail -n 40 -f "${files[@]}"
}

usage() {
  # print the header comment block (everything after the shebang, up to the first
  # non-comment line), stripping the leading "# ".
  awk 'NR==1 { next } /^#/ { line = $0; sub(/^# ?/, "", line); print line; next } { exit }' \
    "${BASH_SOURCE[0]}"
}

main() {
  case "${1:-}" in
    deps|check)      cmd_deps ;;
    start|up)        cmd_start ;;
    stop|down)       cmd_stop ;;
    status|ps)       cmd_status ;;
    restart)         cmd_restart ;;
    logs|tail)       cmd_logs ;;
    ""|-h|--help|help) usage ;;
    *) err "unknown command: $1"; echo; usage; exit 2 ;;
  esac
}

main "$@"
