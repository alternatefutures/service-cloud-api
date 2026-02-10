#!/usr/bin/env sh
set -eu

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"

mkdir -p "$STATE_DIR"

# If we are root, fix ownership for the non-root node user (uid 1000).
if [ "$(id -u)" = "0" ]; then
  # Best-effort chown (can be slow on large volumes; required for first boot).
  chown -R 1000:1000 "$STATE_DIR" 2>/dev/null || true

  # Drop privileges for runtime.
  if command -v gosu >/dev/null 2>&1; then
    exec gosu node "$@"
  fi
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$@"
  fi

  # Fallback (should be rare).
  exec su -s /bin/sh node -c "$*"
fi

exec "$@"

