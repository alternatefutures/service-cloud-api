#!/bin/bash
# Clean up old Akash deployments
# Usage: ./scripts/cleanup-deployments.sh [keep-latest|close-all]

set -e

AKASH_NODE="${AKASH_NODE:-https://rpc.akashnet.net:443}"
AKASH_CHAIN_ID="${AKASH_CHAIN_ID:-akashnet-2}"
AKASH_KEYRING_BACKEND="${AKASH_KEYRING_BACKEND:-test}"
AKASH_KEY_NAME="${AKASH_KEY_NAME:-deploy}"

MODE="${1:-keep-latest}"

# Get wallet address
AKASH_ADDRESS=$(akash keys show $AKASH_KEY_NAME -a --keyring-backend $AKASH_KEYRING_BACKEND)

echo "=== Akash Deployment Cleanup ==="
echo "Wallet: $AKASH_ADDRESS"
echo "Mode: $MODE"
echo ""

# List all deployments
echo "Fetching deployments..."
DEPLOYMENTS=$(akash query deployment list --owner $AKASH_ADDRESS --node $AKASH_NODE --output json)

# Get deployment count
DEPLOYMENT_COUNT=$(echo "$DEPLOYMENTS" | jq '.deployments | length')
echo "Found $DEPLOYMENT_COUNT active deployments"
echo ""

if [ "$DEPLOYMENT_COUNT" -eq 0 ]; then
  echo "No deployments to clean up"
  exit 0
fi

# Show all deployments
echo "=== Active Deployments ==="
echo "$DEPLOYMENTS" | jq -r '.deployments[] | "\(.deployment.deployment_id.dseq) - Created at block \(.deployment.created_at)"'
echo ""

# Determine which deployments to close
if [ "$MODE" == "keep-latest" ]; then
  # Keep the most recent deployment, close all others
  LATEST_DSEQ=$(echo "$DEPLOYMENTS" | jq -r '.deployments | sort_by(.deployment.deployment_id.dseq | tonumber) | .[-1].deployment.deployment_id.dseq')
  echo "Keeping latest deployment: $LATEST_DSEQ"
  echo "Closing all other deployments..."
  echo ""

  DSEQS_TO_CLOSE=$(echo "$DEPLOYMENTS" | jq -r ".deployments[] | select(.deployment.deployment_id.dseq != \"$LATEST_DSEQ\") | .deployment.deployment_id.dseq")
elif [ "$MODE" == "close-all" ]; then
  echo "Closing ALL deployments..."
  echo ""

  DSEQS_TO_CLOSE=$(echo "$DEPLOYMENTS" | jq -r '.deployments[].deployment.deployment_id.dseq')
else
  echo "Invalid mode: $MODE"
  echo "Usage: $0 [keep-latest|close-all]"
  exit 1
fi

# Close deployments
CLOSED_COUNT=0
for DSEQ in $DSEQS_TO_CLOSE; do
  echo "Closing deployment $DSEQ..."

  akash tx deployment close \
    --dseq $DSEQ \
    --from $AKASH_KEY_NAME \
    --keyring-backend $AKASH_KEYRING_BACKEND \
    --node $AKASH_NODE \
    --chain-id $AKASH_CHAIN_ID \
    --gas-prices 0.025uakt \
    --gas auto \
    --gas-adjustment 1.5 \
    -y

  CLOSED_COUNT=$((CLOSED_COUNT + 1))
  echo "✓ Deployment $DSEQ closed"
  echo ""

  # Small delay to avoid overwhelming the node
  sleep 2
done

echo "=== Cleanup Complete ==="
echo "Closed $CLOSED_COUNT deployment(s)"

# Show remaining deployments
REMAINING=$(akash query deployment list --owner $AKASH_ADDRESS --node $AKASH_NODE --output json | jq '.deployments | length')
echo "Remaining active deployments: $REMAINING"

# Calculate deposits that will be returned
DEPOSIT_PER_DEPLOYMENT=500000  # 0.5 AKT in uakt
TOTAL_RETURNED=$((CLOSED_COUNT * DEPOSIT_PER_DEPLOYMENT))
TOTAL_RETURNED_AKT=$(echo "scale=2; $TOTAL_RETURNED / 1000000" | bc)

echo ""
echo "💰 Estimated AKT returned to your wallet: ~${TOTAL_RETURNED_AKT} AKT"
echo "   (Deployment deposits of 0.5 AKT each)"
