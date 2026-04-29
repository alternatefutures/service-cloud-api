#!/bin/sh
set -eu

cd /app
exec node ./bot.mjs
