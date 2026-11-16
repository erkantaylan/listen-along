#!/bin/sh
# Local development through the Aspire AppHost (aspire/apphost.mts):
#
#   sh scripts/aspire-dev.sh up      install what is missing, start everything, wait for the seed
#   sh scripts/aspire-dev.sh down    stop it, then make sure nothing is left (containers, processes, ports)
#   sh scripts/aspire-dev.sh reset   down, then delete the database volume and .dev-data/
#   sh scripts/aspire-dev.sh status  what is running
#
# `make up|down|reset` and `npm run aspire:up|aspire:down|aspire:reset` call this.
# Options for `up` are environment variables read by the AppHost: LISTEN_PORT,
# LISTEN_WORKER=1, LISTEN_AUTH=oidc, LISTEN_PGWEB=0 (see README "Local development").
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${LISTEN_PORT:-3100}
DASHBOARD_PORT=15260
# The same name aspire/apphost.mts gives the data volume: a hash of this checkout's path.
VOLUME="listen-along-dev-pgdata-$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,10))' "$ROOT")"

aspire_cli() { (cd "$ROOT/aspire" && aspire "$@" --non-interactive --nologo); }

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "aspire-dev: '$1' is not installed. $2" >&2; exit 1; }
}

port_busy() { (ss -ltnH 2>/dev/null || true) | awk '{print $4}' | grep -q "[:.]$1\$"; }

# Processes this checkout's AppHost runs, by working directory AND command line,
# so an editor or a shell that happens to sit in the repo is never touched.
our_processes() {
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    cwd=$(readlink "$p/cwd" 2>/dev/null) || continue
    # (Worktrees nested under .claude/ are other checkouts with their own AppHost.)
    case "$cwd" in "$ROOT"/.claude|"$ROOT"/.claude/*) continue ;; "$ROOT"|"$ROOT"/*) ;; *) continue ;; esac
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
    # Only node and Aspire's own binaries (aspire-managed, and DCP, which runs from
    # aspire/.aspire/): never a shell whose command line merely mentions these.
    exe=${cmd%% *}
    case "${exe##*/}" in node|aspire-managed|dcp) ;; *) continue ;; esac
    case "$cmd" in
      *src/index.js*|*"tsc -b frontend -w"*|*scripts/dev-seed.js*|*fakeOidcIssuer.ts*|*"la.js worker"*|*apphost.mts*|*aspire-managed*|*nodemon*|*/dcp/dcp\ *)
        echo "$pid" ;;
    esac
  done
}

up() {
  need node "Node.js 22.18+ (https://nodejs.org)."
  need docker "Docker (or Podman with ASPIRE_CONTAINER_RUNTIME=podman)."
  need aspire "The Aspire CLI: https://aspire.dev/get-started/install-cli/ (no .NET SDK needed)."
  command -v ffmpeg >/dev/null 2>&1 || echo "aspire-dev: warning: ffmpeg/ffprobe not on PATH; the seed and uploads need them" >&2
  if port_busy "$PORT"; then echo "aspire-dev: port $PORT is in use (LISTEN_PORT=... picks another, or 'make down')" >&2; exit 1; fi
  [ -d node_modules ] || npm ci --no-audit --no-fund
  [ -d backend/node_modules ] || npm --prefix backend ci --no-audit --no-fund
  [ -d aspire/node_modules ] || npm --prefix aspire ci --no-audit --no-fund
  mkdir -p .dev-data
  out=$(aspire_cli run --detach --format Json)
  echo "$out"
  dashboard=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/\{[\s\S]*\}/);try{process.stdout.write(JSON.parse(m[0]).dashboardUrl||"")}catch{}})')
  aspire_cli wait listen-along --status healthy --timeout 300
  # The seed starts once the server is healthy and exits; wait for its exit code.
  i=0
  seed_exit=""
  while [ -z "$seed_exit" ] && [ $i -lt 150 ]; do
    seed_exit=$(aspire_cli describe seed --format Json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/"exitCode":\s*(-?\d+)/);process.stdout.write(m?m[1]:"")})')
    [ -n "$seed_exit" ] || { i=$((i + 1)); sleep 2; }
  done
  if [ "$seed_exit" = "0" ]; then
    echo "aspire-dev: seed done"
  else
    echo "aspire-dev: the seed failed (exit $seed_exit); see: cd aspire && aspire logs seed" >&2
  fi
  echo
  if [ "${LISTEN_AUTH:-}" = "oidc" ]; then
    echo "listen-along:  http://localhost:$PORT  (Sign in goes through the fake IdP as Dev User)"
  else
    echo "listen-along:  http://localhost:$PORT  (sign in: http://localhost:$PORT/auth/dev/login)"
  fi
  echo "dashboard:     ${dashboard:-http://localhost:$DASHBOARD_PORT}"
  echo "stop:          make down"
}

# This AppHost's containers: the one holding our data volume, and every other
# container started by the same orchestrator process (pgweb), by DCP's label.
our_containers() {
  creator=$(docker ps -a --filter "volume=$VOLUME" --format '{{.Label "com.microsoft.developer.usvc-dev.creatorProcessId"}}' 2>/dev/null | head -n 1)
  if [ -n "$creator" ]; then
    docker ps -a -q --filter "label=com.microsoft.developer.usvc-dev.creatorProcessId=$creator" 2>/dev/null || true
  fi
}

down() {
  containers=$(our_containers)
  if command -v aspire >/dev/null 2>&1 && [ -d aspire/node_modules ]; then
    aspire_cli stop || true
  fi
  # `aspire stop` returns before the containers are gone (mercatus lessons 12/13).
  i=0
  left=""
  while [ -n "$containers" ] && [ $i -lt 30 ]; do
    left=""
    for c in $containers; do
      if docker inspect "$c" >/dev/null 2>&1; then left="$left $c"; fi
    done
    [ -z "$left" ] && break
    i=$((i + 1)); sleep 1
  done
  if [ -n "$left" ]; then
    echo "aspire-dev: removing leftover container(s):$left" >&2
    docker rm -f $left >/dev/null
  fi
  # And processes a stopped AppHost did not reap. Give the ones still shutting down 10 s.
  i=0
  pids=$(our_processes)
  while [ -n "$pids" ] && [ $i -lt 10 ]; do
    i=$((i + 1)); sleep 1
    pids=$(our_processes)
  done
  if [ -n "$pids" ]; then
    for pid in $pids; do
      echo "aspire-dev: stopping leftover process $pid: $( (tr '\0' ' ' < /proc/$pid/cmdline) 2>/dev/null | cut -c1-160)" >&2
    done
    kill $pids 2>/dev/null || true
    sleep 2
    pids=$(our_processes)
    [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true
  fi
  for p in "$PORT" "$DASHBOARD_PORT"; do
    if port_busy "$p"; then echo "aspire-dev: warning: port $p is still in use" >&2; fi
  done
  echo "aspire-dev: stopped (the database volume $VOLUME is kept; 'make reset' deletes it)"
}

reset() {
  down
  docker volume rm "$VOLUME" >/dev/null 2>&1 && echo "aspire-dev: deleted volume $VOLUME" || true
  rm -rf .dev-data
  echo "aspire-dev: deleted .dev-data/ (songs, covers, seed audio)"
}

status() {
  aspire_cli describe || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  reset) reset ;;
  status) status ;;
  *) echo "usage: $0 up|down|reset|status" >&2; exit 2 ;;
esac
