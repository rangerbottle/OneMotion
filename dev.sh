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
#   ./dev.sh media     verify the local analysis artifacts; rebuild/re-pin any gaps
#   ./dev.sh benchmark <video>   build the Curry v3 reference clip + benchmark from a source
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

CURRY_DIR="$REPO_ROOT/data/raw_videos/curry"
CURRY_SOURCE="$CURRY_DIR/curry_v3_source.mp4"
CURRY_REFERENCE="$CURRY_DIR/curry_v3_reference.mp4"
CURRY_MANIFEST="$CURRY_DIR/curry_v3_sources.json"
CURRY_BENCHMARK="$REPO_ROOT/data/benchmarks/curry_v3.json"
POSE_MODEL="$REPO_ROOT/models/yolo11n-pose.pt"

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
  [ -f "$POSE_MODEL" ] && ok "pose model present" || warn "pose model missing: models/yolo11n-pose.pt (see README)"
  if [ -f "$CURRY_BENCHMARK" ] && [ -f "$CURRY_REFERENCE" ]; then
    ok "Curry v3 reference media present"
  else
    warn "Curry v3 reference media missing — /health works but shot analysis returns 503"
    warn "  need: data/benchmarks/curry_v3.json + data/raw_videos/curry/curry_v3_reference.mp4"
    warn "  run ./dev.sh media (or ./dev.sh start) to build them, or ./dev.sh benchmark <video>"
  fi
}

# Extract the reference clip, build the benchmark, and re-pin the local-only
# manifest from <source-video>. Returns non-zero (without exiting) on any
# failure so both `dev.sh benchmark` and the gap-fill in `start` can react.
build_benchmark_artifacts() { # source-video start-ms end-ms time-scale [source-url]
  local source="$1" start_ms="$2" end_ms="$3" time_scale="$4" source_url="${5:-}"

  [ -f "$source" ] || { err "source video not found: $source"; return 1; }
  [ "$end_ms" -gt "$start_ms" ] 2>/dev/null || { err "--end-ms ($end_ms) must exceed --start-ms ($start_ms)"; return 1; }

  local timing_mode="realtime"
  [ "$time_scale" = "1" ] || timing_mode="slow_motion"

  ensure_uv_on_path
  command -v uv >/dev/null || install_uv
  backend_deps_ok || sync_backend_deps
  [ -f "$POSE_MODEL" ] || { err "pose model missing: models/yolo11n-pose.pt — see README to fetch it"; return 1; }

  mkdir -p "$CURRY_DIR" "$(dirname "$CURRY_BENCHMARK")"

  # Stage the source at the canonical path (prepare_reference_clip refuses to
  # read and write the same file, so the source must be distinct from the clip).
  local src_abs; src_abs="$(cd "$(dirname "$source")" && pwd)/$(basename "$source")"
  if [ "$src_abs" != "$CURRY_SOURCE" ]; then
    info "staging source → data/raw_videos/curry/curry_v3_source.mp4"
    cp "$src_abs" "$CURRY_SOURCE"
  fi

  local prep_args=(
    "$CURRY_SOURCE" "$CURRY_REFERENCE"
    --start-ms "$start_ms" --end-ms "$end_ms"
    --provenance "$CURRY_MANIFEST"
    --timing-mode "$timing_mode" --time-scale "$time_scale"
  )
  [ -n "$source_url" ] && prep_args+=( --source-url "$source_url" )

  info "1/3  extracting ${start_ms}-${end_ms} ms reference clip + provenance manifest…"
  if ! ( cd "$BACKEND_DIR" && uv run python scripts/prepare_reference_clip.py "${prep_args[@]}" ); then
    err "clip extraction failed — the source must be a decodable video whose footage covers roughly ${start_ms}-${end_ms} ms"
    return 1
  fi

  info "2/3  building benchmark (pose → phases → metrics → aggregate)…"
  if ! ( cd "$BACKEND_DIR" && uv run python scripts/build_curry_benchmark.py \
           --clip "$CURRY_REFERENCE" --out "$CURRY_BENCHMARK" --input-manifest "$CURRY_MANIFEST" ); then
    err "benchmark build failed — the ${start_ms}-${end_ms} ms window must contain ONE full jump shot,"
    err "  filmed side-on, whole body + shooting arm + ball visible the entire time."
    err "  re-run: ./dev.sh benchmark <video> --start-ms N --end-ms N   bracketing the shot"
    return 1
  fi

  info "3/3  pinning artifact hashes → infra/artifacts.json (local only — do not commit)…"
  if ! ( cd "$BACKEND_DIR" && uv run python scripts/release_artifacts.py ) \
     || ! ( cd "$BACKEND_DIR" && uv run python scripts/release_artifacts.py --check ); then
    err "manifest pinning failed — see: cd backend && uv run python scripts/release_artifacts.py"
    return 1
  fi

  ok "benchmark ready — data/benchmarks/curry_v3.json (timing: $timing_mode)"
}

# Verify the local-only analysis artifacts and close any gap we can close
# unattended: rebuild the Curry v3 benchmark from the staged source video, or
# just re-pin the (gitignored) manifest when the media is already in place.
# Never fatal — the app still starts and /ready reports whatever is still
# missing. Run automatically by `dev.sh start`; also `./dev.sh media`.
ensure_reference_media() {
  ensure_uv_on_path
  command -v uv >/dev/null || install_uv
  backend_deps_ok || sync_backend_deps

  if [ ! -f "$POSE_MODEL" ]; then
    warn "pose model missing: models/yolo11n-pose.pt"
    warn "  restore it (git checkout -- models/yolo11n-pose.pt) or fetch it per README"
  fi

  if [ ! -f "$CURRY_BENCHMARK" ] || [ ! -f "$CURRY_REFERENCE" ]; then
    if [ -f "$CURRY_SOURCE" ] && [ -f "$POSE_MODEL" ]; then
      info "Curry v3 benchmark missing — rebuilding from data/raw_videos/curry/curry_v3_source.mp4 …"
      build_benchmark_artifacts "$CURRY_SOURCE" 0 3000 1 \
        || warn "automatic rebuild failed — run ./dev.sh benchmark <video>; shot analysis stays disabled (503)"
      return 0
    fi
    warn "Curry v3 reference media missing and no source video to rebuild from"
    warn "  add data/raw_videos/curry/curry_v3_source.mp4 and re-run, or: ./dev.sh benchmark <video>"
    warn "  the app still starts — /health is up; /ready and shot analysis return 503 until fixed"
    return 0
  fi

  if ( cd "$BACKEND_DIR" && uv run python scripts/release_artifacts.py --check ) >/dev/null 2>&1; then
    ok "Curry v3 reference media + manifest verified"
    return 0
  fi

  info "artifact manifest missing or out of date — re-pinning infra/artifacts.json (local only) …"
  if ( cd "$BACKEND_DIR" && uv run python scripts/release_artifacts.py ) >/dev/null 2>&1 \
     && ( cd "$BACKEND_DIR" && uv run python scripts/release_artifacts.py --check ) >/dev/null 2>&1; then
    ok "infra/artifacts.json re-pinned"
  else
    warn "could not re-pin infra/artifacts.json"
    warn "  run: cd backend && uv run python scripts/release_artifacts.py"
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
  ensure_reference_media
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
      ONEMOTION_PUBLIC_HOST="$PUBLIC_HOST" \
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

cmd_benchmark() {
  local source="" start_ms=0 end_ms=3000 time_scale=1 source_url=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --start-ms)    start_ms="$2"; shift 2 ;;
      --end-ms)      end_ms="$2"; shift 2 ;;
      --time-scale)  time_scale="$2"; shift 2 ;;
      --source-url)  source_url="$2"; shift 2 ;;
      -h|--help)
        echo "usage: ./dev.sh benchmark <source-video> [--start-ms N] [--end-ms N] [--time-scale N] [--source-url URL]"
        echo
        echo "Builds data/raw_videos/curry/curry_v3_reference.mp4 + data/benchmarks/curry_v3.json"
        echo "from <source-video> and re-pins infra/artifacts.json (local only — do not commit)."
        echo "The [start,end] window must contain one full side-on jump shot with the shooter"
        echo "fully visible. Default window is 0–3000 ms at real-time speed (--time-scale 1)."
        return 0 ;;
      -*)  die "unknown option: $1 (see ./dev.sh benchmark --help)" ;;
      *)   [ -z "$source" ] && source="$1" || die "unexpected argument: $1"; shift ;;
    esac
  done

  [ -n "$source" ] || die "usage: ./dev.sh benchmark <source-video> [options] — see --help"

  build_benchmark_artifacts "$source" "$start_ms" "$end_ms" "$time_scale" "$source_url" || exit 1

  if pid_alive "$(read_pid "$API_PID_FILE")"; then
    info "restarting backend to pick up the new benchmark…"
    stop_service "backend" "$API_PID_FILE" "$API_PORT"
    cmd_start
  else
    info "now run:  ./dev.sh start   — GET /ready should report \"ready\""
  fi
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
    media|check-media) ensure_reference_media ;;
    benchmark|bench) shift; cmd_benchmark "$@" ;;
    ""|-h|--help|help) usage ;;
    *) err "unknown command: $1"; echo; usage; exit 2 ;;
  esac
}

main "$@"
