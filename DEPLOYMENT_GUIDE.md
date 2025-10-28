# AlternateFutures Backend - Deployment Guide

Complete guide to deploying the AlternateFutures GraphQL backend and achieving full dogfooding.

---

## Phase 1: Initial Deployment to Railway ⭐

### Quick Start: Automated Deployment

The easiest way to deploy is using the automated deployment script:

```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend
npm run deploy:railway
```

This script will:
- ✅ Check Railway CLI installation and login status
- ✅ Verify project connection
- ✅ Check for PostgreSQL database (prompts to add if missing)
- ✅ Set all required environment variables
- ✅ Deploy the service
- ✅ Automatically run migrations and seed data (via `railway.json` build)

---

### Manual Deployment (Alternative)

If you prefer manual setup:

#### Step 1: Install Dependencies

```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend
npm install
```

#### Step 2: Set Up Railway

1. **Install Railway CLI**:
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway**:
   ```bash
   railway login
   ```

3. **Create new project**:
   ```bash
   railway init
   ```
   - Project name: `alternatefutures-backend`

4. **Add PostgreSQL database**:
   - Go to Railway dashboard: https://railway.app
   - Click "+ New" → "Database" → "Add PostgreSQL"
   - Railway will auto-create `DATABASE_URL` environment variable

#### Step 3: Configure Environment Variables

Use Railway CLI to set variables:

```bash
railway variables \
  --set "JWT_SECRET=your-super-secret-jwt-key-CHANGE-THIS" \
  --set "NODE_ENV=production" \
  --set "PORT=4000" \
  --set "FUNCTIONS_DOMAIN=af-functions.dev" \
  --set "APP_URL=https://app.alternatefutures.ai" \
  --set "PINATA_JWT=your-pinata-jwt-token" \
  --set "PINATA_GATEWAY=your-gateway.mypinata.cloud"
```

#### Step 4: Deploy to Railway

```bash
# Deploy (migrations and seeding run automatically via railway.json)
railway up

# Check logs
railway logs
```

#### Step 5: Get Railway URL

```bash
railway domain
```

Example output: `alternatefutures-backend-production.up.railway.app`

Your GraphQL endpoint: `https://alternatefutures-backend-production.up.railway.app/graphql`

---

### Automated Build Process

The `railway.json` configuration automatically runs:
1. `npm install` - Install dependencies
2. `npm run build` - Compile TypeScript
3. `npm run db:generate` - Generate Prisma client
4. `npm run db:push` - Push database schema
5. `npm run db:seed` - Seed database with initial data

---

## Phase 2: Configure DNS on Namecheap

### Step 1: Login to Namecheap

1. Go to https://namecheap.com
2. Login to your account
3. Go to Dashboard → Domain List → `alternatefutures.ai` → Manage

### Step 2: Add CNAME Record

In **Advanced DNS** settings:

| Type  | Host | Value | TTL |
|-------|------|-------|-----|
| CNAME | api  | alternatefutures-backend-production.up.railway.app. | Automatic |

**Important**: Add a trailing dot (`.`) at the end of the Railway URL

### Step 3: Wait for DNS Propagation

DNS changes can take 5-30 minutes to propagate.

Check status:
```bash
dig api.alternatefutures.ai
```

### Step 4: Configure Custom Domain in Railway

1. Go to Railway dashboard → Your project → Settings
2. Add custom domain: `api.alternatefutures.ai`
3. Railway will auto-provision SSL certificate (via Let's Encrypt)

---

## Phase 3: Test the Backend

### Test 1: Health Check

```bash
curl https://api.alternatefutures.ai/graphql
```

Should return GraphQL Playground HTML.

### Test 2: Create User & PAT (Personal Access Token)

First, create a test user manually in database:

```bash
railway connect postgres
```

```sql
-- Create a test user
INSERT INTO "User" (id, email, username, "createdAt", "updatedAt")
VALUES ('test-user-1', 'test@alternatefutures.ai', 'testuser', NOW(), NOW());

-- Create a personal access token for testing
INSERT INTO "PersonalAccessToken" (id, name, token, "userId", "createdAt", "updatedAt")
VALUES ('pat-1', 'Test Token', 'test-token-12345', 'test-user-1', NOW(), NOW());

-- Create a test project
INSERT INTO "Project" (id, name, slug, "userId", "createdAt", "updatedAt")
VALUES ('proj-1', 'Test Project', 'test-project', 'test-user-1', NOW(), NOW());
```

### Test 3: Test GraphQL API with CLI

Update CLI environment to use production:

```bash
cd /Users/wonderwomancode/Projects/fleek/cloud-cli

# Update .env to point to production
echo 'SDK__GRAPHQL_API_URL=https://api.alternatefutures.ai/graphql' >> .env
```

Rebuild CLI:
```bash
pnpm build
```

Set up authentication:
```bash
# Store the PAT in CLI config
af auth login
# Enter token: test-token-12345
```

Test functions commands:
```bash
# Create a function
af functions create

# List functions
af functions list
```

---

## Phase 4: Dogfooding - Deploy Backend as AF Function 🚀

Once Phase 1-3 are working, let's eat our own dog food!

### Step 1: Package Backend for Deployment

Create a bundled version of the backend:

```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend

# Build TypeScript
npm run build

# Create deployment bundle
mkdir -p deploy
cp -r dist package.json node_modules deploy/
cd deploy && tar -czf ../backend-bundle.tar.gz .
```

### Step 2: Create Function via CLI

```bash
af functions create --name alternatefutures-graphql-api
```

This creates a function record in the database.

### Step 3: Deploy Backend to AF Function

```bash
af functions deploy \
  --name alternatefutures-graphql-api \
  --filePath ./dist/index.js
```

This will:
1. Upload code to IPFS
2. Create deployment record
3. Return invoke URL

Example: `https://alternatefutures-graphql-api.af-functions.dev/graphql`

### Step 4: Update DNS

In Namecheap, update the CNAME:

| Type  | Host | Value | TTL |
|-------|------|-------|-----|
| CNAME | api  | alternatefutures-graphql-api.af-functions.dev. | Automatic |

### Step 5: Verify

```bash
curl https://api.alternatefutures.ai/graphql
```

Now your platform is running on itself! 🎉

---

## Architecture After Dogfooding

```
┌─────────────────────────────────────────────────┐
│           Users (CLI, Dashboard, SDK)           │
└────────────────────┬────────────────────────────┘
                     │
                     │ HTTPS
                     ▼
┌─────────────────────────────────────────────────┐
│        DNS: api.alternatefutures.ai             │
│            ↓ (CNAME)                            │
│  alternatefutures-graphql-api.af-functions.dev  │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│       AF Functions Runtime (Cloudflare)         │
│                                                  │
│  Fetches code from IPFS:                       │
│  ipfs://QmXXXX... (GraphQL Yoga server)        │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│         PostgreSQL Database (Railway)           │
└─────────────────────────────────────────────────┘
```

**Key insight**: The GraphQL API that manages functions is ITSELF a function!

---

## Troubleshooting

### DNS not resolving
```bash
# Check DNS propagation
dig api.alternatefutures.ai

# Flush DNS cache (macOS)
sudo dscacheutil -flushcache
```

### Database connection errors
```bash
# Check Railway database status
railway status

# View logs
railway logs
```

### CLI not connecting
```bash
# Verify environment variables
cat /Users/wonderwomancode/Projects/fleek/cloud-cli/.env

# Should show:
# SDK__GRAPHQL_API_URL=https://api.alternatefutures.ai/graphql
```

---

## Next Steps After Deployment

1. ✅ Backend deployed to Railway
2. ✅ DNS configured (api.alternatefutures.ai)
3. ✅ CLI tested end-to-end
4. ✅ Backend redeployed as AF Function (dogfooding!)
5. Build agent creation wizards in agents-ui
6. Connect agents-ui to GraphQL backend
7. Launch! 🚀

---

## Phase 5: Deploy to Akash Network with Self-Hosted IPFS ⭐

Complete decentralization: deploy the backend, database, and IPFS node to Akash Network.

### Why Akash?

- **Decentralized Compute**: No single point of failure
- **Cost Effective**: 85% cheaper than Railway (~$15-20/month vs $100+/month)
- **Self-Hosted IPFS**: Own your storage infrastructure
- **Censorship Resistant**: Distributed across global providers

### Architecture

The Akash deployment includes:
- **PostgreSQL**: Database (1 CPU, 2GB RAM, 10GB storage)
- **IPFS (Kubo)**: Self-hosted storage node (2 CPU, 4GB RAM, 100GB storage)
- **API**: GraphQL backend (1 CPU, 1GB RAM)

### Prerequisites

#### 1. Install Akash CLI

```bash
# Install Akash CLI
curl -sSfL https://raw.githubusercontent.com/akash-network/node/master/install.sh | sh

# Verify installation
akash version
```

#### 2. Setup Akash Wallet

```bash
# Create or import wallet
akash keys add mykey

# Fund wallet with AKT tokens
# Get testnet tokens: https://faucet.akash.network
# Or buy AKT: https://akash.network/token

# Check balance
akash query bank balances $(akash keys show mykey -a)
```

You'll need at least 5 AKT for deployment (0.5 AKT for deployment deposit + funds for compute).

### Step 1: Configure deployment.yaml

The `deploy.yaml` file is already configured with self-hosted IPFS. Update the following values:

```yaml
# deploy.yaml

services:
  postgres:
    env:
      - POSTGRES_PASSWORD=CHANGE_THIS_SECURE_PASSWORD  # CHANGE THIS!

  api:
    env:
      # Database (use same password as above)
      - DATABASE_URL=postgresql://postgres:CHANGE_THIS_SECURE_PASSWORD@postgres:5432/alternatefutures

      # JWT Secret (min 32 characters)
      - JWT_SECRET=CHANGE_THIS_JWT_SECRET_MIN_32_CHARS  # CHANGE THIS!

      # Email
      - RESEND_API_KEY=your_resend_api_key

      # Storage - Self-Hosted IPFS (configured automatically)
      - IPFS_API_URL=http://ipfs:5001
      - IPFS_GATEWAY_URL=https://ipfs.alternatefutures.ai

      # Storage - Arweave (optional)
      - TURBO_WALLET_KEY=your_turbo_wallet_key

      # Storage - Filecoin (optional)
      - LIGHTHOUSE_API_KEY=your_lighthouse_api_key
```

### Step 2: Build and Push Docker Image

```bash
# Build Docker image
docker build -t alternatefutures/backend:latest .

# Login to Docker Hub (or your registry)
docker login

# Push image
docker push alternatefutures/backend:latest
```

### Step 3: Deploy to Akash

```bash
# Create deployment
akash tx deployment create deploy.yaml --from mykey --chain-id akashnet-2

# Get deployment ID from output (e.g., dseq: 12345678)
export DSEQ=12345678

# View bids from providers
akash query market bid list --owner $(akash keys show mykey -a) --dseq $DSEQ

# Accept a bid (choose provider with good reputation and price)
export PROVIDER=akash1...  # Provider address from bid list
export GSEQ=1
export OSEQ=1

akash tx market lease create --dseq $DSEQ --gseq $GSEQ --oseq $OSEQ --provider $PROVIDER --from mykey

# Send manifest to provider
akash provider send-manifest deploy.yaml --dseq $DSEQ --provider $PROVIDER --from mykey
```

### Step 4: Get Service URLs

```bash
# Get lease status and URLs
akash provider lease-status --dseq $DSEQ --from mykey --provider $PROVIDER

# Example output:
# "services": {
#   "api": {
#     "uris": ["r9vtl0bnv8mcqmaf66uh9pjqb8.ingress.aksh.online"]
#   },
#   "ipfs": {
#     "uris": ["gateway-abc123.ingress.aksh.online"]
#   }
# }
```

### Step 5: Configure DNS

Update Namecheap DNS to point to Akash:

| Type  | Host | Value | TTL |
|-------|------|-------|-----|
| CNAME | api  | r9vtl0bnv8mcqmaf66uh9pjqb8.ingress.aksh.online. | Automatic |
| CNAME | ipfs | gateway-abc123.ingress.aksh.online. | Automatic |

**Important**: Add trailing dot and use your actual Akash URLs.

### Step 6: Verify Deployment

```bash
# Test API
curl https://api.alternatefutures.ai/graphql

# Test IPFS gateway
curl https://ipfs.alternatefutures.ai/ipfs/QmTest...

# Check IPFS node health
curl https://api.alternatefutures.ai/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id } }"}'
```

### Step 7: Run Database Migrations

Connect to the deployment and run migrations:

```bash
# Get pod name
kubectl get pods --context akash

# Run migrations
kubectl exec -it <pod-name> --context akash -- npm run db:push
kubectl exec -it <pod-name> --context akash -- npm run db:seed
```

### Self-Hosted IPFS Features

Your IPFS node includes:

1. **API Access** (Internal): `http://ipfs:5001`
   - Used by backend to upload/pin content
   - Add files, pin/unpin, retrieve content

2. **Gateway** (Public): `https://ipfs.alternatefutures.ai`
   - Access IPFS content via HTTP
   - Format: `https://ipfs.alternatefutures.ai/ipfs/<CID>`

3. **P2P Swarm** (Port 4001):
   - Connects to global IPFS network
   - Ensures content availability
   - Participates in content routing

### Environment Variable Reference

The backend auto-detects self-hosted IPFS:

```bash
# Self-Hosted IPFS (Primary)
IPFS_API_URL=http://ipfs:5001          # Triggers self-hosted mode
IPFS_GATEWAY_URL=https://ipfs.alternatefutures.ai

# Pinata (Fallback - optional)
PINATA_API_KEY=your_key                # Only used if IPFS_API_URL not set
PINATA_API_SECRET=your_secret
```

**Dual-Mode Logic:**
- If `IPFS_API_URL` is set → Uses SelfHostedIPFSStorageService
- If `IPFS_API_URL` is NOT set → Falls back to Pinata

### Cost Comparison

**Railway (Centralized):**
- Compute: $20/month
- PostgreSQL: $10/month
- Pinata IPFS: $20-100/month
- **Total**: $50-130/month

**Akash (Decentralized):**
- Compute (API): ~$3-5/month
- PostgreSQL: ~$5-7/month
- IPFS Node: ~$10-15/month
- **Total**: $18-27/month

**Savings**: 60-85% cost reduction

### Monitoring

Add health checks to your monitoring:

```typescript
// Check IPFS node health
const ipfsHealth = await fetch('https://ipfs.alternatefutures.ai/api/v0/id');

// Check backend API
const apiHealth = await fetch('https://api.alternatefutures.ai/graphql');

// Get IPFS stats via GraphQL (add this query)
const stats = await graphql(`
  query {
    ipfsNodeInfo {
      id
      agentVersion
      repoSize
      numObjects
    }
  }
`);
```

### Updating Deployment

To update your Akash deployment:

```bash
# Update Docker image
docker build -t alternatefutures/backend:latest .
docker push alternatefutures/backend:latest

# Update deployment
akash tx deployment update deploy.yaml --dseq $DSEQ --from mykey

# Send updated manifest
akash provider send-manifest deploy.yaml --dseq $DSEQ --provider $PROVIDER --from mykey
```

### Backup Strategy

**PostgreSQL Backups:**
```bash
# Backup database
kubectl exec -it postgres-pod --context akash -- pg_dump -U postgres alternatefutures > backup.sql

# Restore database
kubectl exec -i postgres-pod --context akash -- psql -U postgres alternatefutures < backup.sql
```

**IPFS Backups:**
- IPFS content is distributed across the network
- Pin important content to multiple nodes
- Export repo: `ipfs repo export`
- Replicate to other IPFS nodes for redundancy

### Troubleshooting

**IPFS node not connecting:**
```bash
# Check IPFS logs
kubectl logs ipfs-pod --context akash

# Test IPFS connectivity
curl http://ipfs:5001/api/v0/id
```

**Backend can't reach IPFS:**
```bash
# Verify environment variables
kubectl exec api-pod --context akash -- env | grep IPFS

# Test internal connectivity
kubectl exec api-pod --context akash -- curl http://ipfs:5001/api/v0/id
```

**High costs on Akash:**
- Review provider pricing
- Reduce IPFS storage allocation
- Consider different provider

---

## CLI and SDK Updates for Self-Hosted IPFS

The CLI and SDK may need updates to support self-hosted IPFS:

### Required Changes:

1. **CLI Configuration**
   - Add IPFS gateway URL configuration
   - Support custom IPFS endpoints
   - Add commands for IPFS node management

2. **SDK Updates**
   - Add IPFS client factory for dual-mode support
   - Update deployment methods to use self-hosted IPFS
   - Add IPFS node health check methods

See `ALT-70` for implementation details.

---

Last Updated: 2025-10-27
