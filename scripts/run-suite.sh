#!/bin/sh
# Fast local loop: run the kit's sealed env (server.mjs) beside this forge, as a trial does, and print
# the env log's check lines and the exports. Usage: scripts/run-suite.sh [kit-dir]
KIT=${1:-$HOME/workspace/makefun-forge/github-core-clone-01-kit}
HERE=$(cd "$(dirname "$0")/.." && pwd)
STATE=$(mktemp -d)
PORT=${ENV_PORT:-18080}
export MAKEFUN_SHOP_TOKEN=local-token-0123456789 MAKEFUN_TRIAL_NOW=2026-11-21T06:40:00.000Z
MAKEFUN_STATE_DIR=$STATE MAKEFUN_ENV_PORT=$PORT MAKEFUN_TRIAL_WALL_BUDGET_SEC=900 \
  node "$KIT/program/env/server.mjs" 2> "$STATE/env.log" &
ENV_PID=$!
sleep 0.5
MAKEFUN_ENV_URL=http://127.0.0.1:$PORT node "$HERE/main.ts" > "$STATE/entry.log" 2>&1
sleep 0.3
kill $ENV_PID 2>/dev/null
grep -E ' (pass|fail)( |$)' "$STATE/env.log" | grep ' fail' 
grep -E 'bench|export' "$STATE/env.log"
echo "state: $STATE"
node -e "const s=require('$STATE/export/state.json');console.log(JSON.stringify(s.counts));const p=require('$STATE/export/perf.json');console.log(p.points, p.points_total, p.workloads.map(w=>w.name+':'+w.p50_ms).join(' '))"
