#!/usr/bin/env sh
set -eu

STATE_DIR="${MILADY_STATE_DIR:-/home/node/.milady}"

mkdir -p "$STATE_DIR"

# If we are root, fix ownership for the non-root node user (uid 1000),
# then re-exec this same script as `node`.
if [ "$(id -u)" = "0" ]; then
  chown -R 1000:1000 "$STATE_DIR" 2>/dev/null || true

  echo "[entrypoint] Dropping privileges to node user..."

  if command -v gosu >/dev/null 2>&1; then
    exec gosu node "$0" "$@"
  fi
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$0" "$@"
  fi

  exec su -s /bin/sh node -c "\"$0\" $*"
fi

echo "[entrypoint] Running as uid=$(id -u), starting services..."

# Internal API port (not exposed to the outside)
INTERNAL_PORT="${MILADY_INTERNAL_API_PORT:-31337}"

# Tell Milady to listen on the internal port first.
export MILADY_PORT="${INTERNAL_PORT}"
export MILADY_INTERNAL_API_PORT="${INTERNAL_PORT}"

echo "[entrypoint] Starting Milady API on internal port ${INTERNAL_PORT}..."
node --import tsx /app/milady.mjs start &
API_PID=$!

sleep 3

# Set the public port for the UI server.
PUBLIC_PORT="${MILADY_PUBLIC_PORT:-2138}"
export MILADY_PORT="${PUBLIC_PORT}"

echo "[entrypoint] Starting UI server on public port ${PUBLIC_PORT}..."
node /usr/local/bin/serve-with-ui.mjs &
UI_PID=$!

cleanup() {
  echo "[entrypoint] Shutting down..."
  kill "$UI_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

wait
echo "[entrypoint] All child processes exited, shutting down."
