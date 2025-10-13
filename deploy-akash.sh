#!/bin/bash
# Akash Deployment Script for Alternate Futures Backend
# Phase 1: Akash + Resend

set -e  # Exit on error

echo "🚀 Alternate Futures - Akash Deployment Script"
echo "================================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Set Akash environment variables
export AKASH_NODE=https://rpc.akash.network:443
export AKASH_CHAIN_ID=akashnet-2
export AKASH_GAS=auto
export AKASH_GAS_ADJUSTMENT=1.5
export AKASH_GAS_PRICES=0.025uakt
export AKASH_SIGN_MODE=amino-json

# Get wallet address
AKASH_ACCOUNT_ADDRESS=$(akash keys show default -a 2>/dev/null || echo "")

if [ -z "$AKASH_ACCOUNT_ADDRESS" ]; then
    echo -e "${RED}❌ No Akash wallet found!${NC}"
    echo "Create one first:"
    echo "  akash keys add default --recover"
    exit 1
fi

echo -e "${GREEN}✅ Wallet found: ${AKASH_ACCOUNT_ADDRESS}${NC}"

# Check balance
echo ""
echo "💰 Checking AKT balance..."
BALANCE=$(akash query bank balances $AKASH_ACCOUNT_ADDRESS --node $AKASH_NODE -o json | jq -r '.balances[] | select(.denom=="uakt") | .amount')

if [ -z "$BALANCE" ] || [ "$BALANCE" -lt 5000000 ]; then
    echo -e "${YELLOW}⚠️  Low balance! You need at least 5 AKT${NC}"
    echo "Current balance: $(echo "scale=2; $BALANCE/1000000" | bc) AKT"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo -e "${GREEN}✅ Balance: $(echo "scale=2; $BALANCE/1000000" | bc) AKT${NC}"
fi

# Check if deploy.yaml exists
if [ ! -f "deploy.yaml" ]; then
    echo -e "${RED}❌ deploy.yaml not found!${NC}"
    exit 1
fi

echo ""
echo "📋 Pre-flight Checklist:"
echo "========================"
echo ""

# Check Docker image
echo -n "🐳 Docker image built? (y/n): "
read -r DOCKER_BUILT
if [[ ! $DOCKER_BUILT =~ ^[Yy]$ ]]; then
    echo ""
    echo "Build and push your Docker image first:"
    echo "  npm run build"
    echo "  docker build -t alternatefutures/backend:latest ."
    echo "  docker push YOUR_DOCKERHUB_USERNAME/alternatefutures-backend:latest"
    exit 1
fi

# Check environment variables
echo -n "🔐 Environment variables configured in deploy.yaml? (y/n): "
read -r ENV_CONFIGURED
if [[ ! $ENV_CONFIGURED =~ ^[Yy]$ ]]; then
    echo ""
    echo "Edit deploy.yaml and set:"
    echo "  - POSTGRES_PASSWORD"
    echo "  - DATABASE_URL"
    echo "  - JWT_SECRET"
    echo "  - RESEND_API_KEY"
    echo "  - PINATA_JWT"
    exit 1
fi

echo ""
echo -e "${GREEN}✅ Pre-flight checks passed!${NC}"
echo ""

# Create deployment
echo "🚀 Creating Akash deployment..."
echo ""

DEPLOY_OUTPUT=$(akash tx deployment create deploy.yaml \
  --from default \
  --node $AKASH_NODE \
  --chain-id $AKASH_CHAIN_ID \
  --gas $AKASH_GAS \
  --gas-adjustment $AKASH_GAS_ADJUSTMENT \
  --gas-prices $AKASH_GAS_PRICES \
  --yes)

# Extract DSEQ
AKASH_DSEQ=$(echo "$DEPLOY_OUTPUT" | grep -oE 'dseq: [0-9]+' | cut -d' ' -f2)

if [ -z "$AKASH_DSEQ" ]; then
    echo -e "${RED}❌ Failed to create deployment${NC}"
    echo "$DEPLOY_OUTPUT"
    exit 1
fi

echo -e "${GREEN}✅ Deployment created!${NC}"
echo "DSEQ: $AKASH_DSEQ"
echo ""

# Wait for bids
echo "⏳ Waiting for bids (30 seconds)..."
sleep 30

# List bids
echo ""
echo "📨 Available bids:"
echo "=================="
akash query market bid list \
  --owner $AKASH_ACCOUNT_ADDRESS \
  --node $AKASH_NODE \
  --dseq $AKASH_DSEQ

echo ""
echo -e "${YELLOW}Choose a provider from above and run:${NC}"
echo ""
echo "export AKASH_DSEQ=$AKASH_DSEQ"
echo "export AKASH_PROVIDER=<provider-address>"
echo ""
echo "akash tx market lease create \\"
echo "  --dseq \$AKASH_DSEQ \\"
echo "  --from default \\"
echo "  --provider \$AKASH_PROVIDER \\"
echo "  --node $AKASH_NODE \\"
echo "  --chain-id $AKASH_CHAIN_ID"
echo ""
echo "akash provider send-manifest deploy.yaml \\"
echo "  --dseq \$AKASH_DSEQ \\"
echo "  --from default \\"
echo "  --provider \$AKASH_PROVIDER \\"
echo "  --node $AKASH_NODE"
echo ""
echo -e "${GREEN}📖 For detailed instructions, see AKASH_DEPLOYMENT.md${NC}"
