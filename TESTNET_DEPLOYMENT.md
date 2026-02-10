# Akash Testnet Deployment Guide

**Purpose**: Test the entire Alternate Futures stack on Akash Sandbox before mainnet deployment.

**Why Testnet First?**

- Free testnet AKT tokens (no cost)
- Validate 3-node YugabyteDB cluster in production-like environment
- Test all services (API, YugabyteDB, IPFS) working together
- Identify any deployment issues safely
- Practice the deployment workflow
- Temporary data (testnet resets periodically)

---

## Prerequisites

### 1. Install Akash CLI

```bash
# macOS (Homebrew)
brew tap akash-network/tap
brew install akash-provider-services

# Verify installation
akash version
```

**Expected output**: `v0.x.x` or similar

### 2. Create Testnet Wallet

```bash
# Create new testnet wallet
akash keys add testnet

# IMPORTANT: Save the mnemonic phrase shown!
# This is your ONLY way to recover the wallet
```

**Save This Information:**

- Mnemonic phrase (24 words) - write it down securely
- Wallet address (starts with `akash1...`)

**Alternative: Import Existing Wallet**

```bash
# If you already have a wallet
akash keys add testnet --recover
# Enter your mnemonic when prompted
```

### 3. Get Free Testnet AKT

1. Copy your wallet address:

   ```bash
   akash keys show testnet -a
   ```

2. Visit the Akash Testnet Faucet:
   **https://faucet.sandbox-01.aksh.pw/**

3. Paste your wallet address and request tokens

4. Wait ~1 minute, then verify:
   ```bash
   akash query bank balances $(akash keys show testnet -a) \
     --node https://rpc.sandbox-01.aksh.pw:443
   ```

**Expected**: You should see a balance like `5000000uakt` (5 AKT)

---

## Step 1: Build and Push Docker Image

### Build the Image

```bash
cd /Users/wonderwomancode/Projects/alternatefutures/service-cloud-api

# Build production image
npm run build

# Build Docker image
docker build -t ghcr.io/alternatefutures/service-cloud-api:testnet .
```

### Push to GitHub Container Registry

**One-time setup:**

1. Create GitHub Personal Access Token:
   - Go to: https://github.com/settings/tokens
   - Click "Generate new token (classic)"
   - Select scope: `write:packages`
   - Copy the token (save it securely!)

2. Login to GitHub Container Registry:
   ```bash
   echo "YOUR_GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
   ```

**Push the image:**

```bash
docker push ghcr.io/alternatefutures/service-cloud-api:testnet
```

**Make it public** (so Akash providers can pull it):

1. Go to: https://github.com/orgs/alternatefutures/packages
2. Find `service-cloud-api`
3. Click "Package settings"
4. Scroll to "Danger Zone"
5. Click "Change visibility" → "Public"

---

## Step 2: Configure Testnet Secrets

Edit `deploy-testnet.yaml` and update these values:

```bash
nano deploy-testnet.yaml
```

**Required changes:**

### YugabyteDB Passwords (Lines 20, 61, 96)

```yaml
- YSQL_PASSWORD=TESTNET_PASSWORD_CHANGE_ME
```

Change to a secure password (same password on all 3 nodes):

```yaml
- YSQL_PASSWORD=<choose-a-strong-testnet-password>
```

### API Database URL (Line 151)

```yaml
- DATABASE_URL=postgresql://yugabyte:TESTNET_PASSWORD_CHANGE_ME@yb-node-1:5433/alternatefutures
```

Change to match your password:

```yaml
- DATABASE_URL=postgresql://yugabyte:<your-testnet-password>@yb-node-1:5433/alternatefutures
```

### API JWT Secret (Line 154)

```yaml
- JWT_SECRET=TESTNET_JWT_SECRET_CHANGE_ME
```

Change to a random string:

```yaml
- JWT_SECRET=testnet_jwt_a8f7d6c5b4e3a2d1_20241115
```

### Optional API Keys (for testnet, these can stay as-is or use real values)

```yaml
- RESEND_API_KEY=your_resend_api_key
- TURBO_WALLET_KEY=your_turbo_wallet_key
- LIGHTHOUSE_API_KEY=your_lighthouse_api_key
- SENTRY_DSN=your_sentry_dsn
```

**Save and close** (Ctrl+X, then Y, then Enter)

---

## Step 3: Deploy to Akash Testnet

Run the deployment script:

```bash
cd /Users/wonderwomancode/Projects/alternatefutures/service-cloud-api

./deploy-akash-testnet.sh
```

### What the Script Does

1. **Checks Akash CLI** is installed
2. **Checks testnet wallet** exists
3. **Checks AKT balance** (warns if low)
4. **Pre-flight checks**: Asks if Docker image is ready and secrets configured
5. **Creates deployment** on Akash testnet
6. **Waits for bids** from providers
7. **Shows next steps** for accepting a bid

### Expected Output

```
🧪 Alternate Futures - Akash TESTNET Deployment
================================================
⚠️  This deploys to TESTNET (free tokens for testing)

✅ Akash CLI found
📡 Using Testnet: sandbox-01
🔗 RPC: https://rpc.sandbox-01.aksh.pw:443
✅ Testnet wallet found: akash1abc...xyz
✅ Balance: 5.00 AKT

📋 Pre-flight Checklist:
========================

🐳 Docker image built and pushed? (y/n): y
🔐 Testnet environment variables configured in deploy-testnet.yaml? (y/n): y

✅ Pre-flight checks passed!

🚀 Creating Akash TESTNET deployment...

✅ Testnet deployment created!
DSEQ: 123456

⏳ Waiting for bids (30 seconds)...

📨 Available testnet bids:
==========================
(List of providers will appear here)
```

**Save the DSEQ number!** You'll need it for the next steps.

---

## Step 4: Accept a Bid and Create Lease

From the bids list, choose a provider and create a lease:

```bash
# Set your deployment sequence number
export AKASH_DSEQ=123456  # Replace with your actual DSEQ from above

# Set the provider address (from the bids list)
export AKASH_PROVIDER=akash1abc...xyz  # Replace with chosen provider

# Create the lease
akash tx market lease create \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --provider $AKASH_PROVIDER \
  --node https://rpc.sandbox-01.aksh.pw:443 \
  --chain-id sandbox-01 \
  --yes
```

**Wait ~30 seconds** for the lease to be created.

---

## Step 5: Send Manifest

Upload your deployment configuration to the provider:

```bash
akash provider send-manifest deploy-testnet.yaml \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --provider $AKASH_PROVIDER \
  --node https://rpc.sandbox-01.aksh.pw:443
```

**Expected output:**

```
Manifest sent successfully
```

---

## Step 6: Check Deployment Status

### Get Lease Status

```bash
akash provider lease-status \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --provider $AKASH_PROVIDER \
  --node https://rpc.sandbox-01.aksh.pw:443
```

**What to look for:**

- `"services"` section shows all 5 services (yb-node-1, yb-node-2, yb-node-3, ipfs, api)
- Each service shows `"available": 1`
- `"forwarded_ports"` shows your public endpoints

### Get Service URLs

```bash
akash provider lease-status \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --provider $AKASH_PROVIDER \
  --node https://rpc.sandbox-01.aksh.pw:443 \
  | jq '.services'
```

**Expected endpoints:**

- **API**: `http://<provider-ip>:<port>` (should map to port 80 of api service)
- **YugabyteDB Admin**: `http://<provider-ip>:<port>` (should map to port 15000 of yb-node-1)
- **IPFS Gateway**: `http://<provider-ip>:<port>` (should map to port 8080 of ipfs)

---

## Step 7: Test Your Deployment

### Test GraphQL API

```bash
# Get the API URL from lease-status output
export API_URL="http://<provider-ip>:<port>/graphql"

# Test the endpoint
curl -X POST $API_URL \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}'
```

**Expected response:**

```json
{ "data": { "__typename": "Query" } }
```

### Test YugabyteDB Admin UI

1. Get the Admin UI URL from lease-status output
2. Open in browser: `http://<provider-ip>:<port>`
3. You should see the YugabyteDB Admin interface
4. Check:
   - **Overview** → 3 nodes should be "ALIVE"
   - **Tables** → Navigate to YSQL → yugabyte → public
   - Verify tables exist (User, Project, Site, etc.)

### Test IPFS Gateway

```bash
# Get the IPFS Gateway URL from lease-status output
export IPFS_GATEWAY="http://<provider-ip>:<port>"

# Test with a known IPFS hash
curl $IPFS_GATEWAY/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG
```

**Expected**: Should return "Hello World" or similar content

---

## Step 8: Monitor Logs

### Get Service Logs

```bash
# API logs
akash provider service-logs \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --provider $AKASH_PROVIDER \
  --node https://rpc.sandbox-01.aksh.pw:443 \
  --service api

# YugabyteDB node 1 logs
akash provider service-logs \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --provider $AKASH_PROVIDER \
  --node https://rpc.sandbox-01.aksh.pw:443 \
  --service yb-node-1

# IPFS logs
akash provider service-logs \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --provider $AKASH_PROVIDER \
  --node https://rpc.sandbox-01.aksh.pw:443 \
  --service ipfs
```

**What to look for:**

- API: `GraphQL server running at...`
- YugabyteDB: `Started PostgreSQL server`
- IPFS: `Daemon is ready`

---

## Step 9: Test YugabyteDB Cluster

### Connect to YugabyteDB

You'll need to use port forwarding to connect from your local machine:

```bash
# Forward YugabyteDB port
akash provider lease-shell \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --provider $AKASH_PROVIDER \
  --node https://rpc.sandbox-01.aksh.pw:443 \
  --service yb-node-1 \
  --stdin --tty -- /bin/bash
```

Once inside the container:

```bash
# Connect to YSQL
ysqlsh -h yb-node-1 -p 5433 -U yugabyte -d alternatefutures

# Run test queries
SELECT COUNT(*) FROM "UsageBuffer";
SELECT * FROM pg_stat_replication;  -- Check replication status
\dt  -- List all tables
\q  -- Exit
```

### Test High Availability

**Simulate node failure:**

```bash
# Get shell on yb-node-2
akash provider lease-shell \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --provider $AKASH_PROVIDER \
  --node https://rpc.sandbox-01.aksh.pw:443 \
  --service yb-node-2 \
  --stdin --tty -- /bin/bash

# Stop the node (simulates failure)
pkill -9 postgres
exit
```

**Verify automatic recovery:**

1. Open YugabyteDB Admin UI
2. Go to **Nodes** tab
3. You should see yb-node-2 status change but cluster remains available
4. Go to **Replication** tab
5. Cluster should auto-rebalance tablets

**Restart the node:**

```bash
# Akash will automatically restart the container
# Wait ~30 seconds and check Admin UI again
# Node should rejoin the cluster automatically
```

---

## Step 10: Test Usage Buffer

### Run Test Script Against Testnet

Update the test script to connect to your testnet deployment:

```typescript
// Edit test-usage-buffer.ts
// Change DATABASE_URL environment variable
process.env.DATABASE_URL =
  'postgresql://yugabyte:<your-testnet-password>@<provider-ip>:<port>/alternatefutures'
```

Then run:

```bash
cd /Users/wonderwomancode/Projects/alternatefutures/service-cloud-api
npm run tsx test-usage-buffer.ts
```

**Expected**: All 10 tests pass with similar latency (~1-5ms depending on network)

---

## Validation Checklist

Before proceeding to mainnet, verify:

- [ ] All 3 YugabyteDB nodes show "ALIVE" in Admin UI
- [ ] API responds to GraphQL queries
- [ ] IPFS gateway serves content
- [ ] Database tables exist and are accessible
- [ ] Usage buffer test passes (all 10 tests)
- [ ] Cluster survives node failure (HA test)
- [ ] No errors in service logs
- [ ] Performance is acceptable (API latency <100ms)
- [ ] Admin UI shows 0 under-replicated tablets
- [ ] Replication factor is 3 across all tablets

---

## Common Issues

### Issue 1: No Bids Received

**Symptoms**: After 30 seconds, no providers bid on your deployment

**Solutions**:

1. Check your pricing is competitive:
   ```bash
   akash query market bid list --owner $(akash keys show testnet -a) --node https://rpc.sandbox-01.aksh.pw:443
   ```
2. Increase bid amounts in `deploy-testnet.yaml` (profile → placement → pricing)
3. Reduce resource requirements (CPU, memory, storage)

### Issue 2: Manifest Send Fails

**Symptoms**: `akash provider send-manifest` returns error

**Solutions**:

1. Verify lease exists:
   ```bash
   akash query market lease list --owner $(akash keys show testnet -a) --node https://rpc.sandbox-01.aksh.pw:443
   ```
2. Check provider is still active
3. Ensure DSEQ and PROVIDER variables are set correctly

### Issue 3: Services Not Starting

**Symptoms**: `lease-status` shows `"available": 0` for some services

**Solutions**:

1. Check service logs for errors
2. Verify Docker image is public and accessible
3. Check secrets in `deploy-testnet.yaml` are correct
4. Look for resource constraints (provider may not have enough resources)

### Issue 4: Database Connection Errors

**Symptoms**: API logs show "Cannot connect to database"

**Solutions**:

1. Verify YugabyteDB password matches in:
   - All 3 yb-node services (YSQL_PASSWORD)
   - API service (DATABASE_URL password)
2. Check YugabyteDB nodes are running (lease-status)
3. Ensure inter-service networking is working

### Issue 5: Low AKT Balance

**Symptoms**: Deployment creation fails with insufficient funds

**Solutions**:

1. Visit faucet again: https://faucet.sandbox-01.aksh.pw/
2. Wait for testnet to reset (usually happens weekly)
3. Reduce deployment costs (lower bids, smaller resources)

---

## Cost Estimate (Testnet)

**Total Testnet Cost**: ~1-2 AKT/day (FREE from faucet!)

Breakdown:

- YugabyteDB nodes (3x): ~0.5 AKT/day each = 1.5 AKT/day
- API: ~0.25 AKT/day
- IPFS: ~0.5 AKT/day

**Faucet gives**: 5 AKT (enough for ~3-5 days of testing)

**Note**: Testnet resets periodically, so don't rely on it for permanent data.

---

## Cleanup (When Done Testing)

### Close Deployment

```bash
# Close the lease (stops billing)
akash tx deployment close \
  --dseq $AKASH_DSEQ \
  --from testnet \
  --node https://rpc.sandbox-01.aksh.pw:443 \
  --chain-id sandbox-01 \
  --yes
```

**Verify closure:**

```bash
akash query deployment list --owner $(akash keys show testnet -a) --node https://rpc.sandbox-01.aksh.pw:443
```

Should show deployment status as "closed"

### Optional: Delete Wallet

```bash
# If you want to remove the testnet wallet
akash keys delete testnet
```

**Warning**: Make sure you've saved any important data first!

---

## Next Steps: Mainnet Deployment

Once testnet validation is complete:

1. Review `deploy.yaml` and update secrets for mainnet
2. Get real AKT tokens (buy from exchange)
3. Create mainnet wallet (`akash keys add default`)
4. Run `./deploy-akash.sh` (mainnet deployment script)
5. Configure DNS records for production domains:
   - api.alternatefutures.ai → API service
   - yb.alternatefutures.ai → YugabyteDB Admin UI
   - ipfs.alternatefutures.ai → IPFS Gateway

See `deploy.yaml` and `deploy-akash.sh` for mainnet deployment details.

---

## Resources

- **Akash Testnet Faucet**: https://faucet.sandbox-01.aksh.pw/
- **Akash Testnet RPC**: https://rpc.sandbox-01.aksh.pw:443
- **Akash Docs**: https://docs.akash.network
- **YugabyteDB Docs**: https://docs.yugabyte.com
- **Project Docs**: See YUGABYTE_MIGRATION.md, ADMIN_UI_GUIDE.md, LOCAL_TEST_RESULTS.md

---

**Testing completed on testnet?** ✅

**Ready for mainnet deployment!** → See `deploy-akash.sh`
