#!/bin/sh
set -eu

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "TELEGRAM_BOT_TOKEN is required" >&2
  exit 1
fi

node /usr/local/bin/telegram-health-server.mjs &

cd /app
exec ./examples/telegram-chat/node_modules/.bin/tsx examples/telegram-chat/src/index.ts
