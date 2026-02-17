#!/bin/sh
set -e

echo "Starting application..."

# ─── Import Akash wallet from mnemonic into CLI keyring ─────────────────────
# The AkashOrchestrator calls `akash keys show default -a` which requires
# the key to exist in the keyring. Import it on every container start.
if [ -n "$AKASH_MNEMONIC" ]; then
  KEY_NAME="${AKASH_KEY_NAME:-default}"
  echo "Importing Akash wallet key '${KEY_NAME}' from mnemonic..."
  echo "$AKASH_MNEMONIC" | akash keys add "$KEY_NAME" --recover --keyring-backend test 2>/dev/null && \
    echo "Akash wallet key imported successfully" || \
    echo "Akash wallet key already exists or import failed (non-fatal)"

  # Generate mTLS certificate if it doesn't exist (required for Akash deployments)
  AKASH_ADDR=$(akash keys show "$KEY_NAME" -a --keyring-backend test 2>/dev/null)
  CERT_PATH="$HOME/.akash/${AKASH_ADDR}.pem"
  if [ -n "$AKASH_ADDR" ] && [ ! -f "$CERT_PATH" ]; then
    echo "Generating Akash mTLS certificate for ${AKASH_ADDR}..."
    export AKASH_NODE="${RPC_ENDPOINT:-https://rpc.akashnet.net:443}"
    export AKASH_CHAIN_ID="${AKASH_CHAIN_ID:-akashnet-2}"
    export AKASH_GAS=auto
    export AKASH_GAS_ADJUSTMENT=1.5
    export AKASH_GAS_PRICES=0.025uakt
    export AKASH_YES=true
    akash tx cert generate client --from "$KEY_NAME" --keyring-backend test 2>/dev/null && \
      echo "Certificate generated" || echo "Certificate generation failed (non-fatal)"
    # Publish cert on chain (idempotent -- will fail harmlessly if already published)
    akash tx cert publish client --from "$KEY_NAME" --keyring-backend test -o json 2>/dev/null && \
      echo "Certificate published on chain" || echo "Certificate already published or publish failed (non-fatal)"
  else
    echo "Akash certificate already exists at ${CERT_PATH}"
  fi
fi

# ─── Restore Akash certificate from env var (ephemeral container storage) ────
# Write cert to disk so MCP process can find it. The akash-mcp loadCertificate()
# also reads AKASH_CERT_JSON directly, but writing to disk covers both paths.
if [ -n "$AKASH_CERT_JSON" ] && [ -n "$AKASH_MNEMONIC" ]; then
  CERT_DIR="/app/akash-mcp/.local/akash-certs"
  mkdir -p "$CERT_DIR"
  echo "$AKASH_CERT_JSON" | base64 -d > "$CERT_DIR/_env_cert.json" 2>/dev/null || true
  echo "Akash certificate restored from env"
fi

# NOTE: prisma CLI is a devDependency — not installed in production.
# Migrations must be applied externally. See INCIDENTS.md (canonical runbook).

echo "Starting Node.js application..."
exec node dist/index.js
