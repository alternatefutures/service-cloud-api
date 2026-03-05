#!/bin/sh
set -e

echo "Starting application..."

# ─── Import Akash wallet from mnemonic into CLI keyring ─────────────────────
# The wallet key is needed for signing transactions (deployments, leases) and
# for JWT authentication with providers (provider-services v0.10.0+ signs JWTs
# with the account's private key automatically — no certificates needed).
if [ -n "$AKASH_MNEMONIC" ]; then
  KEY_NAME="${AKASH_KEY_NAME:-default}"
  echo "Importing Akash wallet key '${KEY_NAME}' from mnemonic..."
  echo "$AKASH_MNEMONIC" | akash keys add "$KEY_NAME" --recover --keyring-backend test 2>/dev/null && \
    echo "Akash wallet key imported successfully" || \
    echo "Akash wallet key already exists or import failed (non-fatal)"
fi

# NOTE: prisma CLI is a devDependency — not installed in production.
# Migrations must be applied externally. See AF_DB_RESET_PROTOCOL.md.

echo "Starting Node.js application..."
exec node dist/index.js
