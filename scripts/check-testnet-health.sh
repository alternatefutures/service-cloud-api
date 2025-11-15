#!/bin/bash
# Testnet Health Check Script
# Quick snapshot of testnet deployment health

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔍 Alternate Futures - Testnet Health Check${NC}"
echo "================================================"
echo ""

# Check if required env vars are set
if [ -z "$AKASH_DSEQ" ] || [ -z "$AKASH_PROVIDER" ]; then
    echo -e "${YELLOW}⚠️  Environment variables not set${NC}"
    echo ""
    echo "Please set:"
    echo "  export AKASH_DSEQ=<your-deployment-sequence>"
    echo "  export AKASH_PROVIDER=<your-provider-address>"
    echo ""
    exit 1
fi

# Akash testnet config
export AKASH_NODE=https://rpc.sandbox-01.aksh.pw:443
export AKASH_CHAIN_ID=sandbox-01

echo "Deployment:"
echo "  DSEQ: $AKASH_DSEQ"
echo "  Provider: $AKASH_PROVIDER"
echo ""

# Function to check service status
check_service_status() {
    local service_name=$1
    echo -n "  ${service_name}: "

    # Get lease status and check if service is available
    STATUS=$(akash provider lease-status \
        --dseq $AKASH_DSEQ \
        --from testnet \
        --provider $AKASH_PROVIDER \
        --node $AKASH_NODE \
        2>/dev/null | grep -A 5 "\"name\": \"$service_name\"" | grep "\"available\":" | grep -oE "[0-9]+")

    if [ "$STATUS" = "1" ]; then
        echo -e "${GREEN}✅ Running${NC}"
        return 0
    else
        echo -e "${RED}❌ Down${NC}"
        return 1
    fi
}

# 1. Check Akash Deployment Status
echo "1. Akash Deployment Status"
echo "=========================="

check_service_status "yb-node-1"
check_service_status "yb-node-2"
check_service_status "yb-node-3"
check_service_status "api"
check_service_status "ipfs"

echo ""

# 2. Get Service URLs
echo "2. Service Endpoints"
echo "==================="

LEASE_STATUS=$(akash provider lease-status \
    --dseq $AKASH_DSEQ \
    --from testnet \
    --provider $AKASH_PROVIDER \
    --node $AKASH_NODE \
    2>/dev/null)

# Extract forwarded ports (this is simplified - actual parsing may need jq)
echo "$LEASE_STATUS" | grep -A 3 "forwarded_ports" | head -20

echo ""

# 3. Check API Health
echo "3. GraphQL API Health"
echo "===================="

# You'll need to update this with actual API URL from lease-status
# For now, show how to test
echo "Test API with:"
echo "  curl -X POST http://<api-url>/graphql \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"query\":\"{ __typename }\"}'"
echo ""

# 4. Check YugabyteDB (via Admin UI)
echo "4. YugabyteDB Cluster"
echo "===================="
echo "Access Admin UI at: http://<provider-ip>:<admin-port>"
echo ""
echo "Check:"
echo "  - All 3 nodes showing ALIVE"
echo "  - 0 under-replicated tablets"
echo "  - Replication factor: 3"
echo ""

# 5. Resource Usage
echo "5. Resource Usage"
echo "================"
echo "Check Akash provider dashboard for:"
echo "  - CPU usage per service"
echo "  - Memory usage per service"
echo "  - Disk usage"
echo ""

# 6. Logs Check
echo "6. Recent Logs (API)"
echo "==================="
echo "Getting last 20 lines of API logs..."
akash provider service-logs \
    --dseq $AKASH_DSEQ \
    --from testnet \
    --provider $AKASH_PROVIDER \
    --node $AKASH_NODE \
    --service api \
    --tail 20 2>/dev/null || echo "Could not fetch logs"

echo ""
echo "================================================"
echo -e "${GREEN}✅ Health check complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Review service status above"
echo "  2. Test API endpoint manually"
echo "  3. Check YugabyteDB Admin UI"
echo "  4. Review logs for errors"
echo ""
echo "For continuous monitoring, run:"
echo "  ./scripts/monitor-testnet.sh"
echo ""
