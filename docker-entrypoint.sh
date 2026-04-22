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
        # Publish on-chain. Critical: parse the JSON tx response and retry
        # on non-zero `code`. The CLI exits 0 on a *broadcast* but the tx
        # itself can fail (sequence mismatch / out-of-gas / mempool full).
        # Previously we used `... && echo "published" || echo "failed (non-
        # fatal)"` which silently swallowed code-32 (account sequence) and
        # left a local cert that didn't exist on-chain — every subsequent
        # `akash tx deployment create` then errored "certificate has not
        # been committed to blockchain". See incident 2026-04-22.
        echo "Publishing certificate on-chain..."
        PUBLISH_OK=0
        for attempt in 1 2 3 4 5; do
          PUBLISH_OUT=$(akash tx cert publish client \
            --from "$KEY_NAME" \
            --keyring-backend test \
            --node "$AKASH_NODE" \
            --chain-id "${AKASH_CHAIN_ID:-akashnet-2}" \
            --gas-prices 0.025uakt \
            --gas auto \
            --gas-adjustment 1.5 \
            -o json -y 2>&1) || true
          PUBLISH_CODE=$(echo "$PUBLISH_OUT" | jq -r '.code // 99' 2>/dev/null || echo 99)
          PUBLISH_HASH=$(echo "$PUBLISH_OUT" | jq -r '.txhash // empty' 2>/dev/null)
          if [ "$PUBLISH_CODE" = "0" ] && [ -n "$PUBLISH_HASH" ]; then
            echo "Certificate published on-chain (txhash=$PUBLISH_HASH, attempt=$attempt)"
            PUBLISH_OK=1
            break
          fi
          # Treat "already exists" (code 11) as success — another pod beat
          # us to it, our local key matches the on-chain cert.
          if echo "$PUBLISH_OUT" | grep -qiE 'certificate.*already exists|already exists.*certificate'; then
            echo "Certificate already on-chain — skipping (attempt=$attempt)"
            PUBLISH_OK=1
            break
          fi
          echo "Certificate publish attempt $attempt failed (code=$PUBLISH_CODE):"
          echo "$PUBLISH_OUT" | head -c 600
          echo
          sleep $((attempt * 3))
        done
        if [ "$PUBLISH_OK" != "1" ]; then
          # Fail loud — without a published cert the API can't broadcast
          # *any* deployment tx. Better to crashloop and surface the issue
          # than to start serving traffic that 100% errors at submit time.
          echo "FATAL: certificate publish failed after 5 attempts. Refusing to start."
          echo "Removing local PEM so the next pod retries cleanly."
          rm -f "$CERT_PATH"
          exit 71
        fi
        # Wait a couple of blocks (~12s) so the cert is queryable before
        # we accept traffic. Akash blocks ~6s; 12s gives a safety margin.
        sleep 12
      fi
    else
      # Local PEM exists. The pod is being recycled with a persistent
      # state, OR the Dockerfile/entrypoint produced the same key+cert
      # bytes. Verify the on-chain side still has a matching valid cert
      # — if it doesn't (revoked, missed broadcast, etc.) republish.
      echo "Akash certificate PEM exists at ${CERT_PATH}, verifying on-chain..."
      LOCAL_HEX=$(openssl x509 -in "$CERT_PATH" -noout -serial 2>/dev/null | cut -d= -f2 || echo "")
      if [ -n "$LOCAL_HEX" ]; then
        LOCAL_DEC=$(printf "%d\n" 0x"$LOCAL_HEX" 2>/dev/null || echo "")
        if [ -n "$LOCAL_DEC" ]; then
          MATCH=$(akash query cert list --owner "$AKASH_ADDR" --serial "$LOCAL_DEC" \
            --node "${RPC_ENDPOINT:-https://rpc.akashnet.net:443}" -o json 2>/dev/null \
            | jq -r '.certificates[]?.certificate.state // empty' 2>/dev/null || echo "")
          if [ "$MATCH" = "valid" ]; then
            echo "On-chain cert matches local PEM (state=valid)."
          else
            echo "WARNING: local PEM serial $LOCAL_DEC not found on-chain (state=$MATCH). Republishing."
            akash tx cert publish client \
              --from "$KEY_NAME" --keyring-backend test \
              --node "${RPC_ENDPOINT:-https://rpc.akashnet.net:443}" \
              --chain-id "${AKASH_CHAIN_ID:-akashnet-2}" \
              --gas-prices 0.025uakt --gas auto --gas-adjustment 1.5 \
              -o json -y 2>&1 | head -c 600 || true
            sleep 12
          fi
        fi
      fi
    fi
  fi
fi

# NOTE: prisma CLI is a devDependency — not installed in production.
# Migrations must be applied externally. See AF_DATABASE_OPERATIONS.md.

echo "Starting Node.js application..."
exec node dist/index.js
