#!/bin/sh
# Velasia Airways retailing API: container entrypoint (Milestone 9).
#
# Prepares the TalaDB directory, then execs the API (CMD) as the unprivileged `node` user
# (uid 1000), so the API is PID 1 and receives SIGTERM itself.
#
# - Started as `node` (the image's USER; Docker Compose): checks the directory and execs.
# - Started as root (Railway with RAILWAY_RUN_UID=0, because a Railway volume is mounted
#   root-owned at runtime): makes the TalaDB directory and the database files in it (top level
#   only, same filesystem, symlinks never followed) owned by `node`, then drops to uid/gid 1000
#   with no supplementary groups, no capabilities and no_new_privs before anything else runs.
#   Only this script runs as root; the API never does.
#
# Environment:
#   TALADB_PATH              database file (the image sets /data/velasia.db)
#   TALADB_REQUIRE_VOLUME    `enabled`: refuse to start unless the database directory is a
#                            mount point (a Railway volume, a Compose volume), so orders are never
#                            written only to the container's ephemeral filesystem
#
# Nothing here creates, seeds, resets or deletes a database: the API opens the existing file, or
# creates an empty one on first start (flight inventory is computed, not stored). Failures are
# one JSON line on stderr and exit 1.
set -eu

APP_UID=1000
APP_GID=1000

fail() {
  printf '{"level":60,"service":"velasia-retailing-api","msg":"startup failed","reason":"%s"}\n' "$1" >&2
  exit 1
}
note() {
  printf '{"level":30,"service":"velasia-retailing-api","msg":"%s"}\n' "$1" >&2
}

db="${TALADB_PATH:-/data/velasia.db}"
case "$db" in
  /*) ;;
  *) fail "TALADB_PATH must be an absolute path." ;;
esac
dir=$(dirname "$db")

if [ "$(id -u)" = 0 ]; then
  [ -d "$dir" ] || fail "The database directory $dir does not exist (is the volume mounted?)."
  if [ "$(stat -c %u:%g "$dir")" != "$APP_UID:$APP_GID" ]; then
    chown "$APP_UID:$APP_GID" "$dir" || fail "Could not give $dir to uid $APP_UID."
    chmod 0700 "$dir"
    note "database directory $dir given to uid $APP_UID (volume mounted root-owned)"
  fi
  # Database files left by another uid (e.g. a restore run as root). Top level only: a volume's
  # lost+found and anything below it stay as they are.
  find "$dir" -mindepth 1 -maxdepth 1 -xdev -type f ! -user "$APP_UID" \
    -exec chown -h "$APP_UID:$APP_GID" {} + || fail "Could not give the files in $dir to uid $APP_UID."
  # Changing to a non-zero uid clears the effective and permitted capabilities; no_new_privs
  # stops setuid/file-capability binaries from giving any back. (No --bounding-set: it needs
  # CAP_SETPCAP, which a restricted platform may not grant.)
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups \
    --inh-caps=-all --no-new-privs -- "$0" "$@"
fi

[ "$(id -u)" = "$APP_UID" ] || note "running as uid $(id -u) (expected $APP_UID)"

if [ "${TALADB_REQUIRE_VOLUME:-disabled}" = enabled ]; then
  mountpoint -q "$dir" ||
    fail "TALADB_REQUIRE_VOLUME=enabled but $dir is not a mounted volume: attach the volume at $dir, or the orders database would live on the container's ephemeral filesystem."
fi
[ -d "$dir" ] || mkdir -p -m 0700 "$dir" 2>/dev/null || fail "Could not create the database directory $dir."
[ -w "$dir" ] ||
  fail "The database directory $dir is not writable by uid $(id -u). On Railway, set RAILWAY_RUN_UID=0 on this service: the entrypoint then fixes the volume's owner and drops to uid $APP_UID."
if [ -e "$db" ]; then
  [ -w "$db" ] || fail "The database file $db is not writable by uid $(id -u)."
  note "opening the existing database at $db"
else
  note "no database at $db yet: the API creates an empty one"
fi

exec "$@"
