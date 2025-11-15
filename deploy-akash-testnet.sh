#!/bin/bash
# Akash TESTNET Deployment Script
# Use this to test on Akash Sandbox before mainnet deployment

set -e  # Exit on error

echo "🧪 Alternate Futures - Akash TESTNET Deployment"
echo "================================================"
echo "⚠️  This deploys to TESTNET (free tokens for testing)"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if akash CLI is installed
if ! command -v akash &> /dev/null; then
    echo -e "${RED}❌ Akash CLI not found!${NC}"
    echo "Install it first:"
    echo "  brew tap akash-network/tap"
    echo "  brew install akash-provider-services"
    exit 1
fi

echo -e "${GREEN}✅ Akash CLI found${NC}"

# Set Akash TESTNET environment variables
export AKASH_NODE=https://rpc.sandbox-01.aksh.pw:443
export AKASH_CHAIN_ID=sandbox-01
export AKASH_GAS=auto
export AKASH_GAS_ADJUSTMENT=1.5
export AKASH_GAS_PRICES=0.025uakt
export AKASH_SIGN_MODE=amino-json

echo -e "${BLUE}📡 Using Testnet: ${AKASH_CHAIN_ID}${NC}"
echo -e "${BLUE}🔗 RPC: ${AKASH_NODE}${NC}"

# Get wallet address
AKASH_ACCOUNT_ADDRESS=$(akash keys show testnet -a 2>/dev/null || echo "")

if [ -z "$AKASH_ACCOUNT_ADDRESS" ]; then
    echo -e "${YELLOW}⚠️  No testnet wallet found!${NC}"
    echo ""
    echo "Options:"
    echo "  1. Create new testnet wallet:"
    echo "     akash keys add testnet"
    echo ""
    echo "  2. Import existing wallet:"
    echo "     akash keys add testnet --recover"
    echo ""
    echo "Then get free testnet AKT from:"
    echo "  https://faucet.sandbox-01.aksh.pw/"
    exit 1
fi

echo -e "${GREEN}✅ Testnet wallet found: ${AKASH_ACCOUNT_ADDRESS}${NC}"

# Check balance
echo ""
echo "💰 Checking testnet AKT balance..."
BALANCE=$(akash query bank balances $AKASH_ACCOUNT_ADDRESS --node $AKASH_NODE -o json 2>/dev/null | jq -r '.balances[] | select(.denom=="uakt") | .amount' || echo "0")

if [ -z "$BALANCE" ] || [ "$BALANCE" -lt 1000000 ]; then
    echo -e "${YELLOW}⚠️  Low balance! You need testnet AKT${NC}"
    echo "Current balance: $(echo "scale=2; $BALANCE/1000000" | bc 2>/dev/null || echo "0") AKT"
    echo ""
    echo -e "${BLUE}Get free testnet AKT from:${NC}"
    echo "  https://faucet.sandbox-01.aksh.pw/"
    echo ""
    echo "Your testnet address: ${AKASH_ACCOUNT_ADDRESS}"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo -e "${GREEN}✅ Balance: $(echo "scale=2; $BALANCE/1000000" | bc) AKT${NC}"
fi

# Check if testnet deploy file exists
if [ ! -f "deploy-testnet.yaml" ]; then
    echo -e "${RED}❌ deploy-testnet.yaml not found!${NC}"
    exit 1
fi

echo ""
echo "📋 Pre-flight Checklist:"
echo "========================"
echo ""

# Check Docker image
echo -n "🐳 Docker image built and pushed? (y/n): "
read -r DOCKER_BUILT
if [[ ! $DOCKER_BUILT =~ ^[Yy]$ ]]; then
    echo ""
    echo "Build and push your Docker image first:"
    echo "  npm run build"
    echo "  docker build -t ghcr.io/alternatefutures/service-cloud-api:latest ."
    echo "  docker push ghcr.io/alternatefutures/service-cloud-api:latest"
    exit 1
fi

# Check environment variables
echo -n "🔐 Testnet environment variables configured in deploy-testnet.yaml? (y/n): "
read -r ENV_CONFIGURED
if [[ ! $ENV_CONFIGURED =~ ^[Yy]$ ]]; then
    echo ""
    echo "Edit deploy-testnet.yaml and set:"
    echo "  - YSQL_PASSWORD (all YugabyteDB nodes)"
    echo "  - DATABASE_URL password"
    echo "  - JWT_SECRET"
    echo "  - RESEND_API_KEY (optional for testnet)"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ Pre-flight checks passed!${NC}"
echo ""
echo -e "${YELLOW}⚠️  Remember: This is TESTNET${NC}"
echo "  - Using free testnet AKT tokens"
echo "  - Data is temporary (testnet resets)"
echo "  - Perfect for testing before mainnet"
echo ""

# Create deployment
echo "🚀 Creating Akash TESTNET deployment..."
echo ""

DEPLOY_OUTPUT=$(akash tx deployment create deploy-testnet.yaml \
  --from testnet \
  --node $AKASH_NODE \
  --chain-id $AKASH_CHAIN_ID \
  --gas $AKASH_GAS \
  --gas-adjustment $AKASH_GAS_ADJUSTMENT \
  --gas-prices $AKASH_GAS_PRICES \
  --yes 2>&1)

# Extract DSEQ
AKASH_DSEQ=$(echo "$DEPLOY_OUTPUT" | grep -oE 'dseq: [0-9]+' | head -1 | cut -d' ' -f2)

if [ -z "$AKASH_DSEQ" ]; then
    echo -e "${RED}❌ Failed to create deployment${NC}"
    echo "$DEPLOY_OUTPUT"
    exit 1
fi

echo -e "${GREEN}✅ Testnet deployment created!${NC}"
echo "DSEQ: $AKASH_DSEQ"
echo ""

# Wait for bids
echo "⏳ Waiting for bids (30 seconds)..."
sleep 30

# List bids
echo ""
echo "📨 Available testnet bids:"
echo "=========================="
akash query market bid list \
  --owner $AKASH_ACCOUNT_ADDRESS \
  --node $AKASH_NODE \
  --dseq $AKASH_DSEQ 2>&1 || echo "No bids yet, wait a bit longer..."

echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo ""
echo "1. Choose a provider from above"
echo "2. Create lease:"
echo ""
echo "export AKASH_DSEQ=$AKASH_DSEQ"
echo "export AKASH_PROVIDER=<provider-address>"
echo ""
echo "akash tx market lease create \\"
echo "  --dseq \$AKASH_DSEQ \\"
echo "  --from testnet \\"
echo "  --provider \$AKASH_PROVIDER \\"
echo "  --node $AKASH_NODE \\"
echo "  --chain-id $AKASH_CHAIN_ID \\"
echo "  --yes"
echo ""
echo "3. Send manifest:"
echo ""
echo "akash provider send-manifest deploy-testnet.yaml \\"
echo "  --dseq \$AKASH_DSEQ \\"
echo "  --from testnet \\"
echo "  --provider \$AKASH_PROVIDER \\"
echo "  --node $AKASH_NODE"
echo ""
echo "4. Check deployment status:"
echo ""
echo "akash provider lease-status \\"
echo "  --dseq \$AKASH_DSEQ \\"
echo "  --from testnet \\"
echo "  --provider \$AKASH_PROVIDER \\"
echo "  --node $AKASH_NODE"
echo ""
echo -e "${GREEN}✅ Testnet deployment in progress!${NC}"
echo -e "${BLUE}📖 Once tested, use deploy-akash.sh for mainnet${NC}"
