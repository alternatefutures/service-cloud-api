#!/bin/sh
set -e

echo "Starting application..."

# ─── Import Akash wallet from mnemonic into CLI keyring ─────────────────────
# The wallet key is needed for signing transactions (deployments, leases) and
# for JWT authentication with providers (provider-services v0.10.0+ signs JWTs
# with the account's private key automatically).
if [ -n "$AKASH_MNEMONIC" ]; then
  KEY_NAME="${AKASH_KEY_NAME:-default}"
  echo "Importing Akash wallet key '${KEY_NAME}' from mnemonic..."
  echo "$AKASH_MNEMONIC" | akash keys add "$KEY_NAME" --recover --keyring-backend test 2>/dev/null && \
    echo "Akash wallet key imported successfully" || \
    echo "Akash wallet key already exists or import failed (non-fatal)"

  # ─── Ensure Akash mTLS certificate exists ───────────────────────────────
  # The Akash CLI requires a local PEM cert file at ~/.akash/<address>.pem
  # to create deployments. Generate and publish if missing.
  AKASH_ADDR=$(akash keys show "$KEY_NAME" -a --keyring-backend test 2>/dev/null || true)
  if [ -n "$AKASH_ADDR" ]; then
    CERT_PATH="$HOME/.akash/${AKASH_ADDR}.pem"
    if [ ! -f "$CERT_PATH" ]; then
      echo "Akash certificate PEM not found at ${CERT_PATH}, generating..."
      AKASH_NODE="${RPC_ENDPOINT:-https://rpc.akashnet.net:443}"

      akash tx cert generate client \
        --from "$KEY_NAME" \
        --keyring-backend test 2>&1 && \
        echo "Certificate generated locally" || \
        echo "Certificate generation failed (non-fatal, may already exist)"

      if [ -f "$CERT_PATH" ]; then
        echo "Publishing certificate on-chain..."
        akash tx cert publish client \
          --from "$KEY_NAME" \
          --keyring-backend test \
          --node "$AKASH_NODE" \
          --chain-id "${AKASH_CHAIN_ID:-akashnet-2}" \
          --gas-prices 0.025uakt \
          --gas auto \
          --gas-adjustment 1.5 \
          -y 2>&1 && \
          echo "Certificate published on-chain" || \
          echo "Certificate publish failed (non-fatal, may already be on-chain)"
        sleep 5
      fi
    else
      echo "Akash certificate PEM exists at ${CERT_PATH}"
    fi
  fi
fi

# NOTE: prisma CLI is a devDependency — not installed in production.
# Migrations must be applied externally. See AF_DB_RESET_PROTOCOL.md.

echo "Starting Node.js application..."
exec node dist/index.js
