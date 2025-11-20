#!/bin/bash
# Get lease information for an Akash deployment
# Usage: ./get-lease-info.sh <DSEQ>

set -e

DSEQ="${1:-24248101}"
OWNER="akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn"
AKASH_NODE="https://rpc.akashnet.net:443"

echo "=== Querying Deployment $DSEQ ==="
echo ""

# Query lease list to get provider
echo "Getting lease information..."
LEASE_DATA=$(curl -s "${AKASH_NODE}/akash/market/v1beta4/leases/list?filters.owner=${OWNER}&filters.dseq=${DSEQ}")

echo "Lease data response:"
echo "$LEASE_DATA" | jq '.'

echo ""
echo "Extracting provider and service info..."

# Try different API versions if v1beta4 doesn't work
if echo "$LEASE_DATA" | jq -e '.leases[0]' > /dev/null 2>&1; then
  PROVIDER=$(echo "$LEASE_DATA" | jq -r '.leases[0].lease.lease_id.provider // .leases[0].lease.id.provider // empty')
  
  if [ -n "$PROVIDER" ] && [ "$PROVIDER" != "null" ]; then
    echo "Provider: $PROVIDER"
    echo ""
    echo "To get service URIs, you would need to query the provider directly at:"
    echo "Provider API endpoint (requires provider host URI and certificates)"
  else
    echo "Could not extract provider from lease data"
  fi
else
  echo "No lease found or API version incompatible"
  echo "Trying alternative API endpoint..."
  
  # Try v1beta3
  LEASE_DATA_V3=$(curl -s "${AKASH_NODE}/akash/market/v1beta3/leases/list?filters.owner=${OWNER}&filters.dseq=${DSEQ}")
  echo "$LEASE_DATA_V3" | jq '.'
fi
