#!/bin/sh
# Milestone 9.3: local checks of the retailing API image for the Railway persistence stage
# (.railway/proposals/api-persistence.ts). The API container alone, no storefronts, nothing sent
# to Railway. It reproduces what stage 1 relies on:
#
#   1. guard: TALADB_REQUIRE_VOLUME=enabled refuses to start without a mount at /data (as root
#      and as uid 1000), with an explicit message, and never falls back to ephemeral storage
#   2. ownership: a fresh, root-owned volume without RAILWAY_RUN_UID=0 fails with a message
#      naming the fix; with it (started as root) /data goes to uid 1000 and the API runs as
#      uid 1000 with no capabilities and no_new_privs
#   3. a fresh database is created on the volume, migrations recorded, /health/ready 200
#      (and its answer names no path or configuration)
#   4. one owner: a second API process on the same volume fails on TalaDB's lock
#   5. SIGTERM: graceful shutdown (exit 0, "shutdown complete") well inside the 15 s window
#   6. restart and redeploy: the existing database is reopened, not reset; a disposable
#      record (a shopping session with synthetic data) is still there
#
# Usage: sh scripts/docker/validate-api-persistence.sh [image] [output-dir]
#   image defaults to velasia-api:m93 (docker build -f docker/Dockerfile.api -t velasia-api:m93 .)
# DOCKER overrides the docker command; PORT the host port (default 4390).
set -u

DOCKER=${DOCKER:-docker}
IMAGE=${1:-velasia-api:m93}
OUT=${2:-test-results/api-persistence}
PORT=${PORT:-4390}
P=velasia-m93-persistence
VOL=$P-data
BASE="http://127.0.0.1:$PORT"
mkdir -p "$OUT"
: > "$OUT/summary.txt"
passed=0
failed=0

ok() { passed=$((passed + 1)); echo "PASS  $1" | tee -a "$OUT/summary.txt"; }
ko() { failed=$((failed + 1)); echo "FAIL  $1" | tee -a "$OUT/summary.txt"; }
check() { if eval "$2"; then ok "$1"; else ko "$1"; fi; }

cleanup() {
  $DOCKER rm -f "$P-api" "$P-second" >/dev/null 2>&1
  $DOCKER volume rm -f "$VOL" >/dev/null 2>&1
}
cleanup
trap cleanup EXIT

# The Railway stage-1 variables (railway.ts with apiPersistence) that matter here.
ENV="-e NODE_ENV=production -e TALADB_PATH=/data/velasia.db -e TALADB_REQUIRE_VOLUME=enabled \
  -e RETAILING_API_HOST=:: -e RETAILING_API_PORT=4010 -e PORT=4010 -e SHUTDOWN_TIMEOUT_MS=10000 \
  -e ACCOUNT_REGISTRATION=disabled -e PAYMENT_OUTCOME_CONTROLS=disabled -e LOG_LEVEL=info"
# A new Railway volume is empty and root-owned: nocopy keeps the image's /data out of it.
MOUNT="--mount type=volume,src=$VOL,dst=/data,volume-nocopy"

wait_ready() {
  i=0
  while [ $i -lt 90 ]; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health/ready")" = 200 ] && return 0
    [ "$($DOCKER inspect -f '{{.State.Running}}' "$P-api" 2>/dev/null)" = true ] || return 1
    sleep 1
    i=$((i + 1))
  done
  return 1
}
start_api() { # [extra docker args]
  # shellcheck disable=SC2086
  $DOCKER run -d --name "$P-api" --user 0 $ENV $MOUNT -p "127.0.0.1:$PORT:4010" "$@" "$IMAGE" >/dev/null
}

echo "== 1. volume guard"
# shellcheck disable=SC2086
out=$($DOCKER run --rm --user 0 $ENV "$IMAGE" 2>&1); code=$?
echo "$out" > "$OUT/1-no-volume-root.log"
check "no volume, started as root: exit 1" "[ $code = 1 ]"
check "no volume: explicit 'not a mounted volume' message" "echo \"\$out\" | grep -q 'is not a mounted volume'"
check "no volume: the API never started (no database opened)" "! echo \"\$out\" | grep -q 'orders database ready'"
# shellcheck disable=SC2086
out=$($DOCKER run --rm $ENV "$IMAGE" 2>&1); code=$?
check "no volume, as uid 1000: exit 1 with the same message" "[ $code = 1 ] && echo \"\$out\" | grep -q 'is not a mounted volume'"

echo "== 2. ownership"
$DOCKER volume create "$VOL" >/dev/null
# shellcheck disable=SC2086
out=$($DOCKER run --rm $ENV $MOUNT "$IMAGE" 2>&1); code=$?
echo "$out" > "$OUT/2-root-owned-no-run-uid.log"
check "root-owned volume without RAILWAY_RUN_UID=0: exit 1" "[ $code = 1 ]"
check "the message names RAILWAY_RUN_UID=0" "echo \"\$out\" | grep -q 'RAILWAY_RUN_UID=0'"

echo "== 3. fresh database on the volume (RAILWAY_RUN_UID=0)"
start_api
if wait_ready; then ok "ready on a fresh volume"; else ko "ready on a fresh volume"; fi
$DOCKER logs "$P-api" > "$OUT/3-first-start.log" 2>&1
check "start.sh gave /data to uid 1000" "grep -q 'given to uid 1000' '$OUT/3-first-start.log'"
check "a fresh database was created (no restore)" "grep -q 'no database at /data/velasia.db yet' '$OUT/3-first-start.log'"
status=$($DOCKER exec "$P-api" cat /proc/1/status)
check "PID 1 (the API) runs as uid 1000" "echo \"\$status\" | grep -Eq '^Uid:[[:space:]]+1000[[:space:]]+1000'"
check "PID 1 has no effective capabilities" "echo \"\$status\" | grep -Eq '^CapEff:[[:space:]]+0+$'"
check "PID 1 has no_new_privs" "echo \"\$status\" | grep -Eq '^NoNewPrivs:[[:space:]]+1'"
check "/data is a mount point" "$DOCKER exec '$P-api' mountpoint -q /data"
check "velasia.db is on the volume, owned by uid 1000" "[ \"\$($DOCKER exec '$P-api' stat -c %u /data/velasia.db)\" = 1000 ]"
ready=$(curl -s "$BASE/health/ready")
echo "$ready" > "$OUT/3-ready.json"
check "/health/ready: ok, database answering, schema recorded" "echo '$ready' | grep -q '\"status\":\"ok\"' && echo '$ready' | grep -q '\"schemaVersion\":'"
check "/health/ready names no path or configuration" "! echo '$ready' | grep -Eq '/data|velasia.db|TALADB|TOKEN'"
schema=$(echo "$ready" | sed -n 's/.*"schemaVersion":\([0-9]*\).*/\1/p')

# A disposable record: a shopping session with a synthetic search (no personal data).
session=$(curl -s -X POST "$BASE/v1/shopping-sessions" -H 'content-type: application/json' \
  -d '{"search":{"tripType":"one-way","origin":"MNL","destination":"SIN","departDate":"2026-12-15","passengers":{"adults":1,"children":0,"infants":0},"cabin":"economy"}}')
sid=$(echo "$session" | sed -n 's/.*"id":"\(ses_[A-Za-z0-9_-]*\)".*/\1/p')
tok=$(echo "$session" | sed -n 's/.*"token":"\([A-Za-z0-9_-]*\)".*/\1/p')
check "disposable record created (shopping session ${sid%"${sid#????????}"}…)" "[ -n '$sid' ] && [ -n '$tok' ]"
get_session() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $tok" "$BASE/v1/shopping-sessions/$sid"; }

echo "== 4. one owner"
# shellcheck disable=SC2086
out=$($DOCKER run --rm --name "$P-second" --user 0 $ENV $MOUNT "$IMAGE" 2>&1); code=$?
echo "$out" > "$OUT/4-second-process.log"
check "a second API process on the same volume exits 1" "[ $code = 1 ]"
check "…because TalaDB's lock is held ('in use by another process')" "echo \"\$out\" | grep -q 'in use by another process'"
check "the first process is still ready" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $BASE/health/ready)\" = 200 ]"

echo "== 5. SIGTERM"
t0=$(date +%s)
$DOCKER stop -t 15 "$P-api" >/dev/null
t1=$(date +%s)
$DOCKER logs "$P-api" > "$OUT/5-shutdown.log" 2>&1
check "exit code 0 after SIGTERM" "[ \"\$($DOCKER inspect -f '{{.State.ExitCode}}' '$P-api')\" = 0 ]"
check "graceful shutdown logged ('shutdown complete')" "grep -q 'shutdown complete' '$OUT/5-shutdown.log'"
check "stopped in $((t1 - t0)) s, inside the 15 s draining window" "[ $((t1 - t0)) -lt 15 ]"

echo "== 6. restart and redeploy"
$DOCKER start "$P-api" >/dev/null
if wait_ready; then ok "restart: ready"; else ko "restart: ready"; fi
$DOCKER logs "$P-api" > "$OUT/6-restart.log" 2>&1
check "restart: the existing database is reopened" "grep -q 'opening the existing database at /data/velasia.db' '$OUT/6-restart.log'"
check "restart: the disposable record survived" "[ \"\$(get_session)\" = 200 ]"
$DOCKER stop -t 15 "$P-api" >/dev/null
$DOCKER rm "$P-api" >/dev/null
start_api # a new container from the same image on the same volume: what a redeploy does
if wait_ready; then ok "redeploy (new container): ready"; else ko "redeploy (new container): ready"; fi
$DOCKER logs "$P-api" > "$OUT/6-redeploy.log" 2>&1
check "redeploy: the existing database is reopened" "grep -q 'opening the existing database' '$OUT/6-redeploy.log'"
check "redeploy: no ownership change needed (already uid 1000)" "! grep -q 'given to uid 1000' '$OUT/6-redeploy.log'"
check "redeploy: the disposable record survived" "[ \"\$(get_session)\" = 200 ]"
check "redeploy: same schema version ($schema)" "curl -s $BASE/health/ready | grep -q '\"schemaVersion\":$schema'"
$DOCKER stop -t 15 "$P-api" >/dev/null

echo
echo "API persistence (local): $passed passed, $failed failed. Logs in $OUT/" | tee -a "$OUT/summary.txt"
[ "$failed" = 0 ]
