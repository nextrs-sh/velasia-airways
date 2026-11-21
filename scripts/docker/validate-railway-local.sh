#!/bin/sh
# Milestone 9: container-level checks of the Railway-like local stack
# (compose.dual-runtime.yaml + compose.railway-local.yaml). HTTP behaviour is covered by the
# parity suite; this checks what is specific to the Railway configuration:
#
#   1. API privileges: started as root on a root-owned volume, the API itself runs as uid 1000
#   2. volume: /data is a mount point owned by uid 1000 (mode 0700)
#   3. private DNS: the API name has IPv4 and IPv6 addresses; NextRS logged them at startup
#   4. NextRS allowlist: both families -> ready; one family only -> refused (503), explicit log
#   5. private API: no published port; 401 without the service token, 200 with it; health open
#   6. secrets: the service token is in no image file, no image history, no browser bundle
#   7. persistence: orders survive a re-created API container; the guards fail clearly
#   8. the documented private-range discovery commands on the API container
#
# Usage (stack up with the same env file):
#   sh scripts/docker/validate-railway-local.sh <env-file> [output-dir]
# DOCKER overrides the docker command (e.g. DOCKER="flatpak-spawn --host docker").
set -eu

DOCKER=${DOCKER:-docker}
ENV_FILE=$1
OUT=${2:-test-results/railway-local}
PROJECT=velasia-railway-local
TAG=${VELASIA_TAG:-m9}
API="$PROJECT-velasia-api-1"
NODE="$PROJECT-velasia-node-1"
NEXTRS="$PROJECT-velasia-nextrs-1"
NET="${PROJECT}_backend"
mkdir -p "$OUT"
: > "$OUT/summary.txt"
d() { $DOCKER "$@"; }
dc() { $DOCKER compose --env-file "$ENV_FILE" -f compose.dual-runtime.yaml -f compose.railway-local.yaml "$@"; }
log() { printf '%s\n' "$*" | tee -a "$OUT/summary.txt"; }
fails=0
ok() { log "- PASS: $*"; }
bad() { log "- FAIL: $*"; fails=$((fails + 1)); }
expect() { if [ "$1" = "$2" ]; then ok "$3 ($1)"; else bad "$3 (got '$1', expected '$2')"; fi; }
# GET a path inside a container (nextrs image has no curl/node: bash /dev/tcp).
status_in() { # container port path
  d exec "$1" bash -c "exec 3<>/dev/tcp/127.0.0.1/$2 && printf 'GET $3 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3 && head -n1 <&3" |
    awk '{ print $2 }'
}
# A request from the Node.js storefront container to the private API (node's fetch). The token,
# if used, is read from the container's own environment: it never appears on a command line.
api_from_node() { # path with-token(yes|no)
  d exec -e "WITH_TOKEN=$2" -e "P=$1" "$NODE" node -e '
    const h = process.env.WITH_TOKEN === "yes" ? { "x-velasia-service-token": process.env.RETAILING_API_SERVICE_TOKEN } : {};
    fetch("http://velasia-api.railway.internal:4010" + process.env.P, { headers: h })
      .then((r) => console.log(r.status), (e) => console.log("error " + e.cause?.code));'
}

log "# Railway-like local validation ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
log ""
log "## 1. API privileges"
uid=$(d exec "$API" sh -c "awk '/^Uid:/ { print \$2 \":\" \$3 }' /proc/1/status")
expect "$uid" "1000:1000" "API PID 1 real:effective uid"
caps=$(d exec "$API" sh -c "awk '/^CapEff:/ { print \$2 }' /proc/1/status")
expect "$caps" "0000000000000000" "API PID 1 effective capabilities"
nnp=$(d exec "$API" sh -c "awk '/^NoNewPrivs:/ { print \$2 }' /proc/1/status")
expect "$nnp" "1" "API PID 1 no_new_privs"
expect "$(d inspect -f '{{.Config.User}}' "$API")" "0" "container started as root (RAILWAY_RUN_UID=0 equivalent)"
d logs "$API" > "$OUT/api.log" 2>&1
if grep -q 'given to uid 1000' "$OUT/api.log"; then ok "entrypoint gave the root-owned volume to uid 1000 (first start)"; else log "- note: no ownership change logged (the volume was already owned by uid 1000)"; fi

log ""
log "## 2. Volume"
expect "$(d exec "$API" stat -c '%u:%g %a' /data)" "1000:1000 700" "/data owner and mode"
expect "$(d exec "$API" sh -c 'mountpoint -q /data && echo mounted')" "mounted" "/data is a mount point"
expect "$(d exec "$API" stat -c '%u:%g' /data/velasia.db)" "1000:1000" "database file owner"

log ""
log "## 3. Private DNS (dual stack)"
addrs=$(d exec "$NEXTRS" sh -c "getent ahosts velasia-api.railway.internal | awk '{ print \$1 }' | sort -u | tr '\n' ' '")
log "- velasia-api.railway.internal -> $addrs"
case "$addrs" in *.*.*.*) ok "IPv4 address present" ;; *) bad "no IPv4 address" ;; esac
case "$addrs" in *:*) ok "IPv6 address present" ;; *) bad "no IPv6 address" ;; esac
d logs "$NEXTRS" 2>&1 | grep -m1 '"msg":"retailing API host"' | tee -a "$OUT/summary.txt" >/dev/null &&
  ok "NextRS logged the API host addresses at startup" || bad "no 'retailing API host' line in the NextRS log"
d logs "$NEXTRS" 2>&1 | grep -m1 '"msg":"exec nextrs"' > "$OUT/nextrs-exec.log" || true
if grep -q -- '--net-allow http://velasia-api.railway.internal:4010' "$OUT/nextrs-exec.log"; then ok "NextRS --net-allow is the API origin"; else bad "NextRS --net-allow"; fi
if d logs "$NEXTRS" 2>&1 | grep -q 'outside NEXTRS_NET_ALLOW_ADDR'; then bad "NextRS warned that API addresses are outside its ranges"; else ok "no allowlist warning with both ranges listed"; fi

log ""
log "## 4. NextRS allowlist (whole-answer policy)"
expect "$(status_in "$NEXTRS" 8080 /api/internal/health/ready)" "200" "both families allowed: ready"
v4=$(printf '%s' "$addrs" | tr ' ' '\n' | grep -m1 '\.' || true)
v6=$(printf '%s' "$addrs" | tr ' ' '\n' | grep -m1 ':' || true)
for case_ in "ipv6-only:fd12:7e57:a11::/64" "ipv4-only:172.30.48.0/24"; do
  name=${case_%%:*}; ranges=${case_#*:}
  c="velasia-m9-allow-$name"
  d rm -f "$c" >/dev/null 2>&1 || true
  d run -d --name "$c" --network "$NET" --env-file "$ENV_FILE" \
    -e RETAILING_API_URL=http://velasia-api.railway.internal:4010 -e SITE_URL=http://localhost:8080 \
    -e NEXTRS_NET_ALLOW_ADDR="$ranges" "velasia-nextrs:$TAG" >/dev/null
  i=0; until [ "$(status_in "$c" 8080 /api/internal/health/live 2>/dev/null)" = 200 ] || [ $i -ge 60 ]; do sleep 1; i=$((i + 1)); done
  expect "$(status_in "$c" 8080 /api/internal/health/ready)" "503" "$name allowlist ($ranges): ready refused"
  d logs "$c" > "$OUT/allow-$name.log" 2>&1
  if grep -q 'outside NEXTRS_NET_ALLOW_ADDR' "$OUT/allow-$name.log"; then
    ok "$name allowlist: the start script warned ($(grep -m1 -o '"outside":"[^"]*"' "$OUT/allow-$name.log"))"
  else
    bad "$name allowlist: no 'outside NEXTRS_NET_ALLOW_ADDR' warning"
  fi
  d rm -f "$c" >/dev/null
done
log "  (resolved: v4=$v4 v6=$v6)"

log ""
log "## 5. Private API"
expect "$(d port "$API" | wc -l | tr -d ' ')" "0" "API publishes no port"
expect "$(api_from_node /health/ready no)" "200" "health without token"
expect "$(api_from_node /v1/airports no)" "401" "business endpoint without token"
expect "$(api_from_node /v1/airports yes)" "200" "business endpoint with the service token"
expect "$(api_from_node /metrics yes)" "401" "API metrics need METRICS_TOKEN (token alone is not enough)"

log ""
log "## 6. Secrets"
for img in "velasia-node:$TAG" "velasia-nextrs:$TAG" "velasia-api:$TAG"; do
  n=$(d run --rm --env-file "$ENV_FILE" --entrypoint sh "$img" -c 'grep -rlF -- "$RETAILING_API_SERVICE_TOKEN" /app /usr/local/bin 2>/dev/null | wc -l')
  expect "$n" "0" "$img: no file contains the service token"
  if d history --no-trunc "$img" | grep -q 'SERVICE_TOKEN=[^ ]'; then bad "$img: history sets a token value"; else ok "$img: no token value in image history"; fi
done
n=$(d run --rm --entrypoint sh "velasia-node:$TAG" -c 'grep -rlE "RETAILING_API_SERVICE_TOKEN|x-velasia-service-token|velasia-api\.railway\.internal" /app/apps/web/.next/static | wc -l')
expect "$n" "0" "browser bundles: no token name, header name or private hostname"

log ""
log "## 7. Persistence and guards"
count() { # record counts in the database (API stopped: db-tool takes TalaDB's lock)
  dc run --rm --no-deps -T --user 1000 --entrypoint node velasia-api dist/db-tool.mjs verify \
    --db /data/velasia.db > "$OUT/verify.json" 2>/dev/null || true
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(JSON.stringify(r.counts))' "$OUT/verify.json"
}
dc stop velasia-api >/dev/null 2>&1
before=$(count)
log "- before: $before"
dc up -d --force-recreate --no-deps --wait velasia-api >/dev/null 2>&1
d logs "$API" 2>&1 | grep -q 'opening the existing database' && ok "re-created API opened the existing database" || bad "re-created API did not log 'opening the existing database'"
dc stop velasia-api >/dev/null 2>&1
after=$(count)
log "- after re-creation: $after"
expect "$after" "$before" "order/account counts survive a re-created container"
dc up -d --no-deps --wait velasia-api >/dev/null 2>&1
set +e
d run --rm -e TALADB_REQUIRE_VOLUME=enabled "velasia-api:$TAG" > "$OUT/no-volume.log" 2>&1; code=$?
set -e
expect "$code" "1" "TALADB_REQUIRE_VOLUME without a volume: exit code"
grep -q 'is not a mounted volume' "$OUT/no-volume.log" && ok "no-volume failure is explicit" || bad "no-volume message missing"
set +e
d run --rm --user 1000 -e TALADB_PATH=/srv/velasia.db "velasia-api:$TAG" > "$OUT/not-writable.log" 2>&1; code=$?
set -e
expect "$code" "1" "unwritable database directory: exit code"
grep -q 'RAILWAY_RUN_UID=0' "$OUT/not-writable.log" && ok "unwritable-directory failure names the fix" || bad "unwritable-directory message missing"

log ""
log "## 8. Private-range discovery commands (docs/deployment/railway.md)"
ranges=$(d exec "$API" node -e 'for (const [n, a] of Object.entries(require("os").networkInterfaces())) for (const i of a) if (!i.internal) console.log(n, i.family, i.cidr)')
printf '%s\n' "$ranges" | sed 's/^/  /' | tee -a "$OUT/summary.txt"
printf '%s' "$ranges" | grep -q 'IPv4 172.30.48.2/24' && ok "node os.networkInterfaces() shows the IPv4 subnet" || bad "IPv4 subnet not shown"
fib=$(d exec "$API" sh -c "awk '/\|-- /{ip=\$2} /link UNICAST/{print ip \$1}' /proc/net/fib_trie | sort -u")
expect "$fib" "172.30.48.0/24" "fib_trie fallback shows the IPv4 subnet"

log ""
if [ "$fails" -eq 0 ]; then log "All checks passed."; else log "$fails check(s) FAILED."; fi
[ "$fails" -eq 0 ]
