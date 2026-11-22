#!/bin/sh
# Velasia Airways storefront on NextRS: turns the container environment into `nextrs start`
# flags (Milestone 8). Every flag used here is listed by `nextrs start --help` in
# @nextrs/cli@0.1.0-rc.2; nothing is emulated and nothing falls back to Node.js (there is no
# Node.js in this image).
#
# Environment (application variables are the same ones the Node.js image reads):
#   PORT                      listen port (default 8080), always on 0.0.0.0
#   RETAILING_API_URL         required; its origin becomes the only --net-allow destination
#   RETAILING_API_SERVICE_TOKEN, SITE_URL, RETAILING_API_TIMEOUT_MS, VELASIA_TODAY, METRICS_TOKEN,
#   RETAILING_API_FORWARD_FAULTS, VELASIA_ALLOW_TEST_CONTROLS
#                             passed to JavaScript by name (--js-env); NextRS exposes nothing else
#   NEXTRS_ISOLATES           V8 isolates (default 1: one JavaScript thread, like one Node.js
#                             process; see docs/deployment/runtime-parity-report.md)
#   NEXTRS_NET_ALLOW_ADDR     private address/CIDR the API resolves to (repeatable, space or
#                             comma separated): needed when the API is on a private network
#                             (Docker Compose, Railway private networking); a public HTTPS API
#                             URL needs none. NextRS refuses a lookup if ANY address in the answer
#                             is outside these ranges, so a dual-stack hostname (A and AAAA
#                             records) needs both its IPv4 and its IPv6 range listed.
#   NEXTRS_TRUSTED_PROXY      reverse-proxy address/CIDR whose X-Forwarded-* headers are kept
#   NEXTRS_STRIP_FORWARDED_HEADERS=true   drop X-Forwarded-* from every request (no proxy)
#                             (neither set: forwarded headers pass through, as with next start)
#   NEXTRS_METRICS_ADDR       operations listener (default 127.0.0.1:9100; "off" disables it)
#   NEXTRS_SHUTDOWN_GRACE     seconds in-flight requests get after SIGTERM (default 10)
#   NEXTRS_IMAGE_CACHE_DIR    optimised-image cache (default /var/cache/nextrs/images)
#   NEXTRS_CACHE_DIR          persist the data cache here (default: in memory, as next start)
#   NEXTRS_EXTRA_ARGS         further `nextrs start` flags, word-split (tuning experiments)
#   NEXTRS_LOG_FORMAT, RUST_LOG   read by nextrs itself (the image defaults to json logs)
set -eu

fail() {
  printf '{"level":"error","service":"velasia-nextrs","msg":"startup failed","reason":"%s"}\n' "$1" >&2
  exit 1
}

port="${PORT:-8080}"
case "$port" in
  '' | *[!0-9]*) fail "PORT must be a number." ;;
esac

api="${RETAILING_API_URL:-}"
[ -n "$api" ] || fail "RETAILING_API_URL must be set."
# scheme://host[:port] of the API (NextRS allow-lists origins, not paths).
api_origin=$(printf '%s\n' "$api" | sed -n -E 's#^(https?://[^/?]+).*$#\1#p')
[ -n "$api_origin" ] || fail "RETAILING_API_URL must be an http:// or https:// URL."

# Milestone 9: log what the API hostname resolves to right now (addresses are not secret), and
# warn about every address outside NEXTRS_NET_ALLOW_ADDR. NextRS refuses a lookup if any address
# in the answer is non-public and outside the ranges, and it does not log why (the app sees a
# failed fetch). Informational only: NextRS enforces the policy on every connection, and the
# readiness route (/api/internal/health/ready, Railway's deploy health check) fails meanwhile.
api_host=$(printf '%s\n' "$api_origin" | sed -E 's#^https?://##; s#:[0-9]+$##; s#^\[(.*)\]$#\1#')
allow_addr=$(printf '%s' "${NEXTRS_NET_ALLOW_ADDR:-}" | tr ',' ' ')
if command -v getent >/dev/null 2>&1; then
  api_addrs=$(getent ahosts "$api_host" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' | sed 's/ $//')
  printf '{"level":"info","service":"velasia-nextrs","msg":"retailing API host","host":"%s","addresses":"%s","allowAddr":"%s"}\n' \
    "$api_host" "${api_addrs:-unresolved}" "${NEXTRS_NET_ALLOW_ADDR:-}" >&2
  if [ -n "$allow_addr" ] && [ -n "$api_addrs" ]; then
    # Addresses no listed range contains (IPv4 and IPv6 CIDRs or single addresses; POSIX awk).
    outside=$(printf '%s\n' $api_addrs | awk -v RANGES="$allow_addr" '
      function bits(n, w,   s, k) { s = ""; for (k = 0; k < w; k++) { s = (n % 2) s; n = int(n / 2) } return s }
      function h4(g) { while (length(g) < 4) g = "0" g; return tolower(g) }
      function v6hex(a,   n, parts, hp, tp, nh, nt, i, s, miss) {
        n = split(a, parts, "::")
        if (n == 1) { nh = split(a, hp, ":"); nt = 0 }
        else {
          nh = (parts[1] == "") ? 0 : split(parts[1], hp, ":")
          nt = (parts[2] == "") ? 0 : split(parts[2], tp, ":")
        }
        s = ""; for (i = 1; i <= nh; i++) s = s h4(hp[i])
        miss = 8 - nh - nt; for (i = 1; i <= miss; i++) s = s "0000"
        for (i = 1; i <= nt; i++) s = s h4(tp[i])
        return s
      }
      function addrbits(a,   p, s, i) {
        if (a ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
          split(a, p, "."); return "4" bits(p[1], 8) bits(p[2], 8) bits(p[3], 8) bits(p[4], 8)
        }
        if (a ~ /:/ && a !~ /\./) {
          a = v6hex(a); s = "6"
          for (i = 1; i <= 32; i++) s = s bits(index("0123456789abcdef", substr(a, i, 1)) - 1, 4)
          return s
        }
        return ""
      }
      BEGIN { nr = split(RANGES, r, " ") }
      {
        a = addrbits($1); if (a == "") next; hit = 0
        for (i = 1; i <= nr; i++) {
          split(r[i], c, "/"); net = addrbits(c[1])
          if (net == "" || substr(net, 1, 1) != substr(a, 1, 1)) continue
          plen = (c[2] == "") ? length(net) - 1 : c[2] + 0
          if (substr(a, 2, plen) == substr(net, 2, plen)) { hit = 1; break }
        }
        if (!hit) print $1
      }' | tr '\n' ' ' | sed 's/ $//')
    [ -z "$outside" ] ||
      printf '{"level":"warn","service":"velasia-nextrs","msg":"retailing API addresses outside NEXTRS_NET_ALLOW_ADDR: NextRS refuses the API unless they are public","outside":"%s","allowAddr":"%s"}\n' \
        "$outside" "${NEXTRS_NET_ALLOW_ADDR:-}" >&2
  fi
fi

set -- start /app/apps/web \
  --host 0.0.0.0 \
  --port "$port" \
  --js-runtime embedded-v8 \
  --isolates "${NEXTRS_ISOLATES:-1}" \
  --shutdown-grace "${NEXTRS_SHUTDOWN_GRACE:-10}" \
  --image-cache-dir "${NEXTRS_IMAGE_CACHE_DIR:-/var/cache/nextrs/images}" \
  --net-allow "$api_origin"

for name in RETAILING_API_URL RETAILING_API_SERVICE_TOKEN SITE_URL RETAILING_API_TIMEOUT_MS \
  VELASIA_TODAY METRICS_TOKEN RETAILING_API_FORWARD_FAULTS VELASIA_ALLOW_TEST_CONTROLS; do
  # Only variables that are set: an unset one reads as undefined in JavaScript either way, and
  # NextRS warns about each --js-env name that is missing.
  eval "isset=\${$name+x}"
  [ -z "$isset" ] || set -- "$@" --js-env "$name"
done

for addr in $allow_addr; do
  set -- "$@" --net-allow-addr "$addr"
done
for proxy in $(printf '%s' "${NEXTRS_TRUSTED_PROXY:-}" | tr ',' ' '); do
  set -- "$@" --trusted-proxy "$proxy"
done
case "${NEXTRS_STRIP_FORWARDED_HEADERS:-false}" in
  true | 1 | yes) set -- "$@" --strip-forwarded-headers ;;
esac

metrics="${NEXTRS_METRICS_ADDR:-127.0.0.1:9100}"
[ "$metrics" = off ] || set -- "$@" --metrics-addr "$metrics"
[ -z "${NEXTRS_CACHE_DIR:-}" ] || set -- "$@" --cache-dir "$NEXTRS_CACHE_DIR"

# shellcheck disable=SC2086 # deliberate word splitting of extra flags
[ -z "${NEXTRS_EXTRA_ARGS:-}" ] || set -- "$@" $NEXTRS_EXTRA_ARGS

# The effective command line holds variable names and the API origin, never secret values.
printf '{"level":"info","service":"velasia-nextrs","msg":"exec nextrs","args":"%s"}\n' "$*" >&2
exec /usr/local/bin/nextrs "$@"
