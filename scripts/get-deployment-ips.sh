#!/bin/bash

# Script to get deployment IPs for DNS configuration
# Usage: ./get-deployment-ips.sh <DSEQ> <OWNER_ADDRESS>

DSEQ=${1:-24262356}
OWNER=${2:-akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn}
AKASH_NODE="https://rpc.akashnet.net:443"

echo "Looking up deployment $DSEQ for owner $OWNER..."
echo ""

# Query lease information
echo "Querying lease information..."
LEASE_DATA=$(akash query market lease list \
  --owner $OWNER \
  --dseq $DSEQ \
  --node $AKASH_NODE \
  --output json 2>&1)

if [ $? -ne 0 ]; then
  echo "Error querying lease: $LEASE_DATA"
  exit 1
fi

echo "Lease data received"
echo "$LEASE_DATA" | jq '.'

# Extract provider address
PROVIDER=$(echo "$LEASE_DATA" | jq -r '.leases[0].lease.id.provider // empty')

if [ -z "$PROVIDER" ] || [ "$PROVIDER" == "null" ]; then
  echo "Error: Could not extract provider address"
  echo "Lease structure:"
  echo "$LEASE_DATA" | jq 'keys'
  exit 1
fi

echo ""
echo "Provider: $PROVIDER"

# Query provider info for host URI
echo ""
echo "Querying provider info..."
PROVIDER_INFO=$(akash query provider get $PROVIDER --node $AKASH_NODE --output json 2>&1)

if [ $? -ne 0 ]; then
  echo "Error querying provider: $PROVIDER_INFO"
  exit 1
fi

PROVIDER_HOST=$(echo "$PROVIDER_INFO" | jq -r '.provider.host_uri // empty')

if [ -z "$PROVIDER_HOST" ] || [ "$PROVIDER_HOST" == "null" ]; then
  echo "Error: Could not extract provider host URI"
  exit 1
fi

echo "Provider Host: $PROVIDER_HOST"

# Try to get lease status from provider
echo ""
echo "Fetching service URIs from provider..."
CERT_PATH="$HOME/.akash/certs"

if [ ! -f "$CERT_PATH/client.crt" ] || [ ! -f "$CERT_PATH/client.key" ]; then
  echo "Warning: Client certificates not found at $CERT_PATH"
  echo "You can access the provider web interface at: https://$PROVIDER_HOST"
  echo "Lease status page: https://$PROVIDER_HOST/lease/$DSEQ/1/1/status"
  exit 0
fi

# Query provider API with certificates
LEASE_STATUS=$(curl -sk --max-time 10 \
  --cert "$CERT_PATH/client.crt" \
  --key "$CERT_PATH/client.key" \
  "https://$PROVIDER_HOST/lease/$DSEQ/1/1/status" 2>&1)

if [ $? -eq 0 ] && echo "$LEASE_STATUS" | jq -e '.' >/dev/null 2>&1; then
  echo "=== Service Endpoints ==="
  echo ""

  # Extract service URIs
  echo "$LEASE_STATUS" | jq -r '
    .services // {} | to_entries[] |
    "Service: \(.key)\n  URIs: \(.value.uris // [])\n"
  '

  # Extract forwarded ports with IPs
  echo "$LEASE_STATUS" | jq -r '
    .forwarded_ports // {} | to_entries[] |
    "Service: \(.key)\n  Host: \(.value[0].host // "N/A")\n  Port: \(.value[0].port // "N/A")\n  External Port: \(.value[0].externalPort // "N/A")\n"
  '

  echo ""
  echo "=== DNS Configuration ==="
  echo ""
  echo "Extract the hostnames from the URIs above and create A records pointing to the provider's IP"

else
  echo "Could not fetch lease status from provider API"
  echo ""
  echo "You can access the provider web interface at: https://$PROVIDER_HOST"
  echo "Lease status page (requires authentication): https://$PROVIDER_HOST/lease/$DSEQ/1/1/status"
fi
