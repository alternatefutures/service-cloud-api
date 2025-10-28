#!/bin/bash
set -e

echo "🚂 AlternateFutures - Railway Deployment Script"
echo "================================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo -e "${RED}Error: Railway CLI is not installed${NC}"
    echo "Install it with: npm install -g @railway/cli"
    exit 1
fi

# Check if logged in to Railway
if ! railway whoami &> /dev/null; then
    echo -e "${YELLOW}Not logged in to Railway. Running login...${NC}"
    railway login
fi

echo ""
echo "📋 Step 1: Check Railway project status"
echo "----------------------------------------"
railway status

echo ""
echo "🗄️  Step 2: Add PostgreSQL database (if not exists)"
echo "---------------------------------------------------"
echo "Checking for existing PostgreSQL database..."

# Check if DATABASE_URL already exists
if railway variables | grep -q "DATABASE_URL"; then
    echo -e "${GREEN}✓ PostgreSQL database already configured${NC}"
else
    echo -e "${YELLOW}Adding PostgreSQL database...${NC}"
    echo "Note: You may need to manually add PostgreSQL via Railway dashboard:"
    echo "      https://railway.app → Your Project → + New → Database → Add PostgreSQL"
    echo ""
    read -p "Press Enter after you've added PostgreSQL, or Ctrl+C to exit..."
fi

echo ""
echo "⚙️  Step 3: Set environment variables"
echo "-------------------------------------"

# Prompt for required environment variables
echo ""
echo "Please provide the following environment variables:"
echo ""

read -p "JWT_SECRET (leave blank to generate random): " JWT_SECRET
if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET=$(openssl rand -base64 32)
    echo "Generated JWT_SECRET: $JWT_SECRET"
fi

read -p "PINATA_JWT (your Pinata JWT token): " PINATA_JWT
read -p "PINATA_GATEWAY (e.g., your-gateway.mypinata.cloud): " PINATA_GATEWAY

echo ""
echo "Setting environment variables..."

railway variables \
    --set "JWT_SECRET=$JWT_SECRET" \
    --set "NODE_ENV=production" \
    --set "PORT=4000" \
    --set "FUNCTIONS_DOMAIN=af-functions.dev" \
    --set "APP_URL=https://app.alternatefutures.ai" \
    --set "IPFS_STORAGE_API_URL=https://storage.alternatefutures.ai" \
    --set "UPLOAD_PROXY_API_URL=https://uploads.alternatefutures.ai"

if [ -n "$PINATA_JWT" ]; then
    railway variables --set "PINATA_JWT=$PINATA_JWT"
fi

if [ -n "$PINATA_GATEWAY" ]; then
    railway variables --set "PINATA_GATEWAY=$PINATA_GATEWAY"
fi

echo -e "${GREEN}✓ Environment variables configured${NC}"

echo ""
echo "🚀 Step 4: Deploy to Railway"
echo "----------------------------"
echo "Deploying backend service..."
railway up

echo ""
echo "⏳ Step 5: Wait for deployment"
echo "------------------------------"
echo "Railway will automatically run the build process which includes:"
echo "  - npm install"
echo "  - npm run build"
echo "  - npm run db:generate"
echo "  - npm run db:push (schema migration)"
echo "  - npm run db:seed (seed database)"
echo ""
echo "Check deployment status: railway logs"

echo ""
echo "🌐 Step 6: Get deployment URL"
echo "-----------------------------"
railway domain

echo ""
echo -e "${GREEN}✓ Deployment complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Check logs: railway logs"
echo "  2. Test API: curl https://api.alternatefutures.ai/graphql"
echo "  3. Configure cloud-cli to use: https://api.alternatefutures.ai/graphql"
echo ""
