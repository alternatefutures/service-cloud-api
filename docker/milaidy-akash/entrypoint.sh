#!/usr/bin/env sh
set -eu

STATE_DIR="${MILAIDY_STATE_DIR:-/home/node/.milaidy}"

mkdir -p "$STATE_DIR"

# ── Privilege-drop wrapper ──────────────────────────────────────────────
# If we are root, fix ownership for the non-root node user (uid 1000),
# then re-exec THIS SCRIPT as `node` user.
if [ "$(id -u)" = "0" ]; then
  chown -R 1000:1000 "$STATE_DIR" 2>/dev/null || true

  echo "[entrypoint] Dropping privileges to node user..."

  # Re-exec this same script as the node user.
  if command -v gosu >/dev/null 2>&1; then
    exec gosu node "$0" "$@"
  fi
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$0" "$@"
  fi

  exec su -s /bin/sh node -c "\"$0\" $*"
fi

# ── Production startup (runs as node user) ──────────────────────────────
echo "[entrypoint] Running as uid=$(id -u), starting services..."

# Internal API port (not exposed to the outside)
INTERNAL_PORT="${MILAIDY_INTERNAL_API_PORT:-31337}"

# Tell Milaidy to listen on the internal port
export MILAIDY_PORT="${INTERNAL_PORT}"
export MILAIDY_INTERNAL_API_PORT="${INTERNAL_PORT}"

echo "[entrypoint] Starting Milaidy API on internal port ${INTERNAL_PORT}..."
node /app/milaidy.mjs start &
API_PID=$!

# Give the API server time to initialize
sleep 3

# Set the public port for the UI server
PUBLIC_PORT="${MILAIDY_PUBLIC_PORT:-2138}"
export MILAIDY_PORT="${PUBLIC_PORT}"

echo "[entrypoint] Starting UI server on public port ${PUBLIC_PORT}..."
node /usr/local/bin/serve-with-ui.mjs &
UI_PID=$!

# Forward signals to both processes
cleanup() {
  echo "[entrypoint] Shutting down..."
  kill "$UI_PID" 2>/dev/null || true
  kill "$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

# Keep the entrypoint alive as long as both children run.
# POSIX `wait` (no -n) blocks until ALL children exit.
wait
echo "[entrypoint] All child processes exited, shutting down."
