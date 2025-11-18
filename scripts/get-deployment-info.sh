#!/bin/bash
# Get Akash deployment information for DNS setup
# Usage: ./scripts/get-deployment-info.sh [DSEQ]

set -e

AKASH_NODE="${AKASH_NODE:-https://rpc.akashnet.net:443}"
AKASH_CHAIN_ID="${AKASH_CHAIN_ID:-akashnet-2}"
WALLET_ADDRESS="${WALLET_ADDRESS:-akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn}"

# If DSEQ not provided, get the latest deployment
if [ -z "$1" ]; then
  echo "Getting latest deployment..."
  DSEQ=$(curl -s "https://api.akashnet.net/akash/deployment/v1beta3/deployments/list?filters.owner=$WALLET_ADDRESS" | jq -r '.deployments[0].deployment.deployment_id.dseq')

  if [ -z "$DSEQ" ] || [ "$DSEQ" == "null" ]; then
    echo "Error: Could not get latest deployment DSEQ"
    echo "Please provide DSEQ manually: ./scripts/get-deployment-info.sh <DSEQ>"
    exit 1
  fi

  echo "Found latest DSEQ: $DSEQ"
else
  DSEQ=$1
  echo "Using provided DSEQ: $DSEQ"
fi

echo ""
echo "=== Deployment Information ==="
echo "DSEQ: $DSEQ"
echo "Wallet: $WALLET_ADDRESS"
echo ""

# Get lease information
echo "Fetching lease information..."
LEASE=$(curl -s "https://api.akashnet.net/akash/market/v1beta4/leases/list?filters.owner=$WALLET_ADDRESS&filters.dseq=$DSEQ")

PROVIDER=$(echo "$LEASE" | jq -r '.leases[0].lease.lease_id.provider')
echo "Provider: $PROVIDER"
echo ""

# Get lease status from provider
echo "Fetching service URIs from provider..."
echo "(This requires akash CLI with keyring setup)"
echo ""

# Try to get lease status
if command -v akash &> /dev/null; then
  echo "Attempting to fetch lease status..."
  akash provider lease-status \
    --dseq $DSEQ \
    --provider $PROVIDER \
    --node $AKASH_NODE \
    --output json 2>/dev/null | jq -r '
      .forwarded_ports | to_entries[] |
      "Service: \(.key)\n  Host: \(.value[0].host)\n  Port: \(.value[0].port)\n  External Port: \(.value[0].external_port // "N/A")\n"
    ' || echo "Could not fetch lease status (requires wallet access)"
else
  echo "akash CLI not found. Install it to fetch detailed service information."
fi

echo ""
echo "=== DNS Configuration ==="
echo ""
echo "To manually configure DNS on NameCheap:"
echo ""
echo "You'll need to get the service IPs from the GitHub Actions deployment logs at:"
echo "https://github.com/alternatefutures/service-cloud-api/actions"
echo ""
echo "Look for the 'Get lease status and service URIs' step in the latest successful deployment."
echo ""
echo "Then create A records:"
echo "  api.alternatefutures.ai  → API service IP"
echo "  yb.alternatefutures.ai   → YugabyteDB UI IP (yb-node-1)"
echo "  ipfs.alternatefutures.ai → IPFS gateway IP"
echo ""
echo "TTL: 300 (5 minutes) for easy updates"
