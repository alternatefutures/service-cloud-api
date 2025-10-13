# Akash Deployment Guide - Phase 1
## Deploy Alternate Futures Backend to Akash Network

**Status:** Phase 1 - Akash + Resend
**Cost:** ~$15/month (vs $25 on Railway)
**Time:** 2-3 hours initial setup

---

## 📋 Prerequisites

### 1. Install Akash CLI

**macOS:**
```bash
# Using Homebrew
brew tap akash-network/tap
brew install akash-provider-services

# Or direct download
curl -sSfL https://raw.githubusercontent.com/akash-network/node/master/install.sh | sh
```

**Verify installation:**
```bash
akash version
```

### 2. Get AKT Tokens

You need 5-10 AKT tokens (~$15-30) to deploy:

**Where to buy:**
- [Osmosis](https://app.osmosis.zone) (recommended)
- [Kraken](https://kraken.com)
- [Gate.io](https://gate.io)

**Transfer to Keplr Wallet:**
1. Install [Keplr browser extension](https://www.keplr.app/)
2. Create/import wallet
3. Add Akash Network
4. Send AKT to your Keplr address

### 3. Set Up Keplr Wallet

```bash
# Import your Keplr mnemonic to Akash CLI
akash keys add default --recover

# Verify your address
akash keys show default -a

# Check balance (need at least 5 AKT)
akash query bank balances $(akash keys show default -a) \
  --node https://rpc.akash.network:443
```

---

## 🐳 Step 1: Build and Push Docker Image

### Build the Docker image

```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend

# Build TypeScript
npm run build

# Build Docker image
docker build -t alternatefutures/backend:latest .

# Test locally (optional)
docker run -p 4000:4000 \
  -e DATABASE_URL=postgresql://... \
  -e JWT_SECRET=test \
  alternatefutures/backend:latest
```

### Push to Docker Hub

```bash
# Login to Docker Hub
docker login

# Tag image
docker tag alternatefutures/backend:latest \
  YOUR_DOCKERHUB_USERNAME/alternatefutures-backend:latest

# Push
docker push YOUR_DOCKERHUB_USERNAME/alternatefutures-backend:latest
```

**Update deploy.yaml:**
```yaml
services:
  api:
    image: YOUR_DOCKERHUB_USERNAME/alternatefutures-backend:latest
    # ...
```

---

## 🔐 Step 2: Configure Environment Variables

Edit `deploy.yaml` and replace all secrets:

```yaml
services:
  postgres:
    env:
      - POSTGRES_PASSWORD=USE_STRONG_PASSWORD_HERE

  api:
    env:
      - DATABASE_URL=postgresql://postgres:USE_STRONG_PASSWORD_HERE@postgres:5432/alternatefutures
      - JWT_SECRET=GENERATE_RANDOM_32_CHAR_STRING
      - RESEND_API_KEY=re_YOUR_RESEND_KEY
      - PINATA_JWT=YOUR_PINATA_JWT
```

**Generate secure secrets:**
```bash
# Generate JWT secret (32 chars)
openssl rand -base64 32

# Generate Postgres password
openssl rand -base64 24
```

---

## 🚀 Step 3: Deploy to Akash

### Set environment variables

```bash
export AKASH_NODE=https://rpc.akash.network:443
export AKASH_CHAIN_ID=akashnet-2
export AKASH_GAS=auto
export AKASH_GAS_ADJUSTMENT=1.5
export AKASH_GAS_PRICES=0.025uakt
export AKASH_SIGN_MODE=amino-json
```

### Create deployment

```bash
# Create deployment
akash tx deployment create deploy.yaml \
  --from default \
  --node $AKASH_NODE \
  --chain-id $AKASH_CHAIN_ID \
  --gas $AKASH_GAS \
  --gas-adjustment $AKASH_GAS_ADJUSTMENT \
  --gas-prices $AKASH_GAS_PRICES

# Save your deployment sequence (DSEQ) from output
export AKASH_DSEQ=<your-deployment-sequence>

# Get your wallet address
export AKASH_ACCOUNT_ADDRESS=$(akash keys show default -a)
```

### Wait for bids

```bash
# Check for bids (wait 30-60 seconds)
akash query market bid list \
  --owner $AKASH_ACCOUNT_ADDRESS \
  --node $AKASH_NODE \
  --dseq $AKASH_DSEQ

# Choose a provider with good reputation
export AKASH_PROVIDER=<provider-address-from-bids>
```

### Create lease

```bash
# Accept the bid and create lease
akash tx market lease create \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE \
  --chain-id $AKASH_CHAIN_ID

# Send manifest to provider
akash provider send-manifest deploy.yaml \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE
```

---

## 🔍 Step 4: Verify Deployment

### Get deployment status

```bash
# Check deployment status
akash provider lease-status \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE

# Get your deployment URI
akash provider lease-status \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE | jq -r '.services.api.uris[0]'
```

### Test the API

```bash
# Save the URI
export AKASH_URI=$(akash provider lease-status \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE | jq -r '.services.api.uris[0]')

# Test health endpoint
curl https://$AKASH_URI/health

# Test GraphQL
curl -X POST https://$AKASH_URI/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}'
```

---

## 🌐 Step 5: Update DNS

### Point your domain to Akash

**In Namecheap (or your DNS provider):**

```
Type: CNAME
Host: api
Value: <your-akash-uri-from-above>
TTL: 300
```

**Wait for DNS propagation (5-10 minutes):**
```bash
# Check DNS
dig api.alternatefutures.ai

# Test your domain
curl https://api.alternatefutures.ai/health
```

---

## 📊 Step 6: Migrate Database

### Option A: Fresh Database (Simplest)

```bash
# Port-forward to your Akash PostgreSQL
akash provider lease-shell \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE \
  --service postgres

# Inside the container
psql -U postgres alternatefutures

# Run migrations
# (You'll need to exec into the api container to run prisma migrate)
```

### Option B: Migrate from Railway

```bash
# Export from Railway
railway run pg_dump alternatefutures > railway_backup.sql

# Import to Akash (you'll need to set up port forwarding)
# This is complex - recommend starting fresh for Phase 1
```

**Recommendation:** Start with fresh database, seed with test data

---

## 💰 Step 7: Monitor Costs

### Check your balance

```bash
# Check AKT balance
akash query bank balances $(akash keys show default -a) \
  --node $AKASH_NODE

# Check deployment cost
akash query deployment get \
  --owner $AKASH_ACCOUNT_ADDRESS \
  --dseq $AKASH_DSEQ \
  --node $AKASH_NODE
```

### Top up if needed

Keep at least 2-3 AKT in your wallet for ongoing deployment costs.

---

## 🔄 Step 8: Update Frontend

Update frontend API URL in `altfutures-app/.env`:

```bash
# Old
VITE_API_URL=https://api.alternatefutures.ai  # Still works!
VITE_GRAPHQL_URL=https://api.alternatefutures.ai/graphql

# Your DNS now points to Akash instead of Railway
```

**No code changes needed!** Your DNS change routes traffic to Akash automatically.

---

## ✅ Verification Checklist

- [ ] Akash CLI installed and configured
- [ ] 5-10 AKT tokens in Keplr wallet
- [ ] Docker image built and pushed
- [ ] Environment variables configured in deploy.yaml
- [ ] Deployment created on Akash
- [ ] Lease active with provider
- [ ] API responding at Akash URI
- [ ] DNS updated and propagated
- [ ] Database migrated/seeded
- [ ] Frontend API URL updated
- [ ] End-to-end test successful

---

## 🚨 Troubleshooting

### Deployment fails

```bash
# Check logs
akash provider lease-logs \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE \
  --service api

# Check events
akash provider lease-events \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE
```

### Database connection issues

```bash
# Shell into api container
akash provider lease-shell \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE \
  --service api

# Test database connection
node -e "const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient(); prisma.\$connect().then(() => console.log('Connected!')).catch(console.error)"
```

### Provider not responding

Try deploying to a different provider:
```bash
# Close current lease
akash tx market lease close \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node $AKASH_NODE

# Repeat deployment with different provider
```

---

## 📈 Cost Comparison

### Before (Railway)
```
Railway Starter:    $5/month
Railway DB:        $10/month
Resend:           $10/month
-----------------
Total:            $25/month
```

### After (Akash)
```
Akash Compute:     ~$3/month
Akash Database:    ~$2/month
Resend:           $10/month
-----------------
Total:            $15/month
Savings:          $10/month (40%)
```

---

## 🎉 Success!

Once deployed, you have:
- ✅ Backend running on DePIN (Akash)
- ✅ 40% cost savings
- ✅ Same API URL (just DNS change)
- ✅ Email via Resend (reliable)
- ✅ Ready for Phase 2 (XMTP)

---

## 📝 Next Steps

### Keep Railway as Backup (Recommended for now)

Don't shut down Railway immediately:
1. Run Akash for 1 week
2. Monitor stability
3. Test all features
4. Then shut down Railway

### Phase 2 (Optional - Later)

Add XMTP for Web3 notifications:
- Install XMTP SDK
- Add wallet notification routing
- FREE wallet-to-wallet messaging

---

## 🆘 Need Help?

**Akash Support:**
- Discord: https://discord.akash.network
- Docs: https://docs.akash.network
- Forums: https://forum.akash.network

**This Project:**
- Check DEPIN_MIGRATION.md for overview
- Check IMPLEMENTATION_STATUS.md for full status

---

**Last Updated:** October 12, 2025
**Phase:** 1 (Akash + Resend)
**Status:** Ready to Deploy
