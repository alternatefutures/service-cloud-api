#!/bin/bash
set -e

echo "════════════════════════════════════════════════════════════════"
echo "  Phase 5: Deploy and Configure Infisical"
echo "════════════════════════════════════════════════════════════════"
echo ""

# Step 1: Deploy Infisical
echo "Step 1: Deploy Infisical to Akash"
echo "────────────────────────────────────────────────────────────────"
echo ""
echo "This will:"
echo "  • Decrypt bootstrap secrets using AGE_SECRET_KEY"
echo "  • Deploy Infisical + MongoDB to Akash"
echo "  • Use only audited providers"
echo "  • Expose at secrets.alternatefutures.ai"
echo ""
read -p "Trigger Infisical deployment? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "Triggering workflow..."
  gh workflow run deploy-infisical.yml -f action=deploy
  echo ""
  echo "✓ Workflow triggered!"
  echo ""
  echo "Monitor progress at:"
  echo "https://github.com/alternatefutures/service-cloud-api/actions/workflows/deploy-infisical.yml"
  echo ""
  echo "Waiting 10 seconds before checking status..."
  sleep 10
  
  echo ""
  echo "Recent workflow runs:"
  gh run list --workflow=deploy-infisical.yml --limit 3
  echo ""
  
  read -p "Wait for deployment to complete? (y/n) " -n 1 -r
  echo ""
  
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Watching workflow... (Ctrl+C to stop watching)"
    RUN_ID=$(gh run list --workflow=deploy-infisical.yml --limit 1 --json databaseId --jq '.[0].databaseId')
    gh run watch $RUN_ID
  fi
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Step 2: Configure DNS (if needed)"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "If DNS is not auto-configured, you need to:"
echo "  1. Get the provider endpoint from deployment logs"
echo "  2. Create CNAME: secrets.alternatefutures.ai → provider endpoint"
echo ""
read -p "Press Enter when DNS is configured or if auto-configured..."

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Step 3: Access Infisical and Create Account"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "1. Open: https://secrets.alternatefutures.ai"
echo "2. Create your admin account"
echo "3. Create a new project (e.g., 'AlternateFutures Production')"
echo ""
read -p "Press Enter when you've created your account and project..."

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Step 4: Add Secrets to Infisical"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Add these secrets to your Infisical project:"
echo ""
echo "  DATABASE_URL          - YugabyteDB connection string"
echo "  JWT_SECRET            - Application JWT secret"
echo "  RESEND_API_KEY        - Email service API key"
echo "  ARWEAVE_WALLET        - Arweave wallet JSON"
echo "  FILECOIN_WALLET_KEY   - Filecoin wallet private key"
echo "  SENTRY_DSN            - Error tracking DSN"
echo "  STRIPE_SECRET_KEY     - Stripe API key"
echo "  STRIPE_WEBHOOK_SECRET - Stripe webhook signing secret"
echo ""
echo "Tip: Copy values from your current .env or GitHub Secrets"
echo ""
read -p "Press Enter when you've added all secrets..."

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Step 5: Generate Service Token"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "In Infisical:"
echo "  1. Go to Project Settings → Access Control → Service Tokens"
echo "  2. Click 'Create Token'"
echo "  3. Name: 'Production API'"
echo "  4. Environment: production"
echo "  5. Permissions: Read"
echo "  6. Copy the token (shown only once!)"
echo ""
read -p "Enter the service token: " SERVICE_TOKEN
echo ""
read -p "Enter the project ID (from URL or settings): " PROJECT_ID
echo ""

echo "════════════════════════════════════════════════════════════════"
echo "  Step 6: Add Tokens to GitHub Secrets"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Adding secrets to GitHub..."

gh secret set INFISICAL_SERVICE_TOKEN --body "$SERVICE_TOKEN"
echo "✓ INFISICAL_SERVICE_TOKEN added"

gh secret set INFISICAL_PROJECT_ID --body "$PROJECT_ID"
echo "✓ INFISICAL_PROJECT_ID added"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  🎉 Phase 5 Complete!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Deploy main application:"
echo "     gh workflow run deploy-akash.yml \\"
echo "       -f sdl_file=deploy-mainnet-with-infisical.yaml \\"
echo "       -f use_infisical=true"
echo ""
echo "  2. Or use the GitHub UI:"
echo "     https://github.com/alternatefutures/service-cloud-api/actions/workflows/deploy-akash.yml"
echo ""
echo "Your application will now fetch all secrets from Infisical at runtime!"
echo ""
