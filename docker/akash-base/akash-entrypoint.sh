#!/bin/sh
set -eu

# Generic Akash entrypoint: fix persistent-volume ownership then drop privileges.
#
# Akash persistent volumes are mounted root-owned. Non-root containers cannot
# write to them without a chown at startup. This entrypoint handles that
# generically for ANY upstream image.
#
# Environment variables:
#   AKASH_CHOWN_PATHS  — colon-separated paths to chown (e.g. /home/node/.app:/data)
#   AKASH_RUN_USER     — user to drop to (default: node)
#   AKASH_RUN_UID      — uid for chown (default: 1000)

PATHS="${AKASH_CHOWN_PATHS:-}"
RUN_USER="${AKASH_RUN_USER:-node}"
RUN_UID="${AKASH_RUN_UID:-1000}"

# If no CMD/args provided, fall back to AKASH_DEFAULT_CMD (set at build time
# to preserve the original image's CMD which Docker resets on ENTRYPOINT change).
if [ $# -eq 0 ] && [ -n "${AKASH_DEFAULT_CMD:-}" ]; then
  eval "set -- $AKASH_DEFAULT_CMD"
fi

if [ "$(id -u)" = "0" ] && [ -n "$PATHS" ]; then
  OLD_IFS="$IFS"
  IFS=':'
  for p in $PATHS; do
    mkdir -p "$p"
    chown -R "$RUN_UID:$RUN_UID" "$p" 2>/dev/null || true
  done
  IFS="$OLD_IFS"

  echo "[akash-entrypoint] Ownership fixed for: $PATHS"
  echo "[akash-entrypoint] Dropping privileges to $RUN_USER (uid $RUN_UID)..."

  if command -v gosu >/dev/null 2>&1; then
    exec gosu "$RUN_USER" "$@"
  fi
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec "$RUN_USER" "$@"
  fi

  exec su -s /bin/sh "$RUN_USER" -c "$(printf '%s ' "$@")"
fi

exec "$@"
