# Phase 1 Deployment Checklist
## Akash + Resend Migration

**Branch:** `feat/alt-9-agents-ui-enhancements`
**Timeline:** 2-3 hours
**Cost:** ~$15/month (40% savings)

---

## 📋 Pre-Deployment (15 minutes)

### 1. Install Akash CLI
```bash
brew tap akash-network/tap
brew install akash-provider-services
akash version
```
- [ ] Akash CLI installed

### 2. Get AKT Tokens
- [ ] Buy 5-10 AKT from [Osmosis](https://app.osmosis.zone) or [Kraken](https://kraken.com)
- [ ] Install [Keplr wallet](https://www.keplr.app/)
- [ ] Transfer AKT to Keplr
- [ ] Import wallet to Akash: `akash keys add default --recover`
- [ ] Verify balance: `akash query bank balances $(akash keys show default -a) --node https://rpc.akash.network:443`

### 3. Get API Keys
- [ ] [Resend API key](https://resend.com/api-keys) - for email
- [ ] [Pinata JWT](https://pinata.cloud/keys) - for IPFS (optional)
- [ ] Generate JWT secret: `openssl rand -base64 32`
- [ ] Generate DB password: `openssl rand -base64 24`

---

## 🐳 Build Docker Image (30 minutes)

### 1. Build Backend
```bash
cd alternatefutures-backend
npm run build
```
- [ ] TypeScript compiled

### 2. Build Docker Image
```bash
docker build -t alternatefutures/backend:latest .
```
- [ ] Docker image built

### 3. Test Locally (Optional)
```bash
docker run -p 4000:4000 \
  -e DATABASE_URL=postgresql://test \
  -e JWT_SECRET=test \
  alternatefutures/backend:latest
```
- [ ] Docker image works locally

### 4. Push to Docker Hub
```bash
docker login
docker tag alternatefutures/backend:latest YOUR_USERNAME/alternatefutures-backend:latest
docker push YOUR_USERNAME/alternatefutures-backend:latest
```
- [ ] Image pushed to Docker Hub
- [ ] Update `deploy.yaml` with your image name

---

## 🔐 Configure Secrets (10 minutes)

Edit `deploy.yaml` and replace:

```yaml
# PostgreSQL password (line ~10)
POSTGRES_PASSWORD=YOUR_SECURE_PASSWORD_HERE

# API environment (lines ~20-40)
DATABASE_URL=postgresql://postgres:YOUR_SECURE_PASSWORD_HERE@postgres:5432/alternatefutures
JWT_SECRET=YOUR_32_CHAR_JWT_SECRET
RESEND_API_KEY=re_YOUR_RESEND_KEY
PINATA_JWT=YOUR_PINATA_JWT
```

**Checklist:**
- [ ] Postgres password set
- [ ] DATABASE_URL updated with password
- [ ] JWT_SECRET set (32+ chars)
- [ ] RESEND_API_KEY set
- [ ] PINATA_JWT set (optional)
- [ ] Docker image name updated

---

## 🚀 Deploy to Akash (1 hour)

### 1. Run Deployment Script
```bash
cd alternatefutures-backend
./deploy-akash.sh
```
- [ ] Deployment created
- [ ] DSEQ number noted

### 2. Accept Bid & Create Lease
```bash
export AKASH_DSEQ=<your-dseq>
export AKASH_PROVIDER=<chosen-provider>

akash tx market lease create \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node https://rpc.akash.network:443 \
  --chain-id akashnet-2

akash provider send-manifest deploy.yaml \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node https://rpc.akash.network:443
```
- [ ] Lease created
- [ ] Manifest sent

### 3. Verify Deployment
```bash
# Get deployment URI
akash provider lease-status \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node https://rpc.akash.network:443 | jq -r '.services.api.uris[0]'

# Test API
curl https://<akash-uri>/health
```
- [ ] Deployment URI retrieved
- [ ] Health check passes
- [ ] GraphQL endpoint responds

---

## 🌐 DNS Update (30 minutes)

### 1. Update DNS
In Namecheap (or your DNS provider):
```
Type: CNAME
Host: api
Value: <your-akash-uri>
TTL: 300
```
- [ ] DNS record created
- [ ] Wait 5-10 minutes for propagation
- [ ] Test: `dig api.alternatefutures.ai`

### 2. Verify Production URL
```bash
curl https://api.alternatefutures.ai/health
curl -X POST https://api.alternatefutures.ai/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}'
```
- [ ] Production URL works
- [ ] GraphQL responds

---

## 🗄️ Database Setup (30 minutes)

### Option A: Fresh Database (Recommended)
```bash
# Shell into API container
akash provider lease-shell \
  --dseq $AKASH_DSEQ \
  --from default \
  --provider $AKASH_PROVIDER \
  --node https://rpc.akash.network:443 \
  --service api

# Run migrations
npx prisma migrate deploy

# Seed data
npm run db:seed
```
- [ ] Migrations run
- [ ] Test data seeded

### Option B: Migrate from Railway (Advanced)
```bash
# Export from Railway
railway run pg_dump > backup.sql

# Import to Akash (requires port forwarding setup)
# See AKASH_DEPLOYMENT.md for details
```
- [ ] Database migrated

---

## ✅ Final Verification (15 minutes)

### 1. Test All Endpoints
```bash
# Health check
curl https://api.alternatefutures.ai/health

# GraphQL introspection
curl -X POST https://api.alternatefutures.ai/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __schema { types { name } } }"}'

# Test with token
curl -X POST https://api.alternatefutures.ai/graphql \
  -H 'Content-Type: application/json' \
  -H 'authorization: af_local_test_token_12345' \
  -H 'x-project-id: proj-1' \
  -d '{"query":"query { fleekFunctions { id name } }"}'
```
- [ ] Health check works
- [ ] GraphQL schema accessible
- [ ] Authenticated queries work

### 2. Update Frontend
In `altfutures-app/.env`:
```bash
# No changes needed! DNS already points to Akash
VITE_API_URL=https://api.alternatefutures.ai
VITE_GRAPHQL_URL=https://api.alternatefutures.ai/graphql
```
- [ ] Frontend still works
- [ ] Can create projects
- [ ] Can deploy functions

### 3. Monitor for 24 Hours
- [ ] Check logs: `akash provider lease-logs ...`
- [ ] Monitor costs: `akash query deployment get ...`
- [ ] Keep Railway running as backup

---

## 🎉 Success Criteria

- [ ] Backend running on Akash
- [ ] API accessible at api.alternatefutures.ai
- [ ] Database working (fresh or migrated)
- [ ] All GraphQL queries working
- [ ] Frontend connected and functional
- [ ] Costs: ~$15/month (40% savings)

---

## 📊 Cost Tracking

Track your first month costs:

**Week 1:**
- AKT spent: _____ AKT
- USD equivalent: $_____

**Week 2:**
- AKT spent: _____ AKT
- USD equivalent: $_____

**Week 3:**
- AKT spent: _____ AKT
- USD equivalent: $_____

**Week 4:**
- AKT spent: _____ AKT
- USD equivalent: $_____

**Total Month 1:** $_____
**Projected Monthly:** $_____ (should be ~$15)

---

## 🚨 If Something Goes Wrong

### Deployment fails
```bash
# Check logs
akash provider lease-logs --dseq $AKASH_DSEQ ...

# Close lease and retry
akash tx market lease close --dseq $AKASH_DSEQ ...
```

### DNS not working
- Wait longer (up to 24h for full propagation)
- Verify CNAME record is correct
- Test with direct Akash URI first

### Database issues
- Check environment variables in deploy.yaml
- Verify passwords match
- Shell into postgres container and test connection

### Railway Fallback
If Akash isn't working:
1. DNS still points to Railway
2. Change CNAME back to Railway
3. Debug Akash separately
4. Try again when ready

---

## 📅 Timeline

**Day 1 (Today):**
- [ ] Pre-deployment setup (15 min)
- [ ] Build Docker image (30 min)
- [ ] Configure secrets (10 min)
- [ ] Deploy to Akash (1 hour)
- [ ] Update DNS (30 min)
- [ ] Setup database (30 min)
- [ ] Final verification (15 min)

**Total:** ~2-3 hours

**Week 1:**
- Monitor stability
- Keep Railway as backup
- Fix any issues

**After 1 Week:**
- If stable → shut down Railway ✅
- Save $10/month
- Phase 1 complete!

---

## 🎯 Next: Phase 2 (Optional)

After Phase 1 is stable (1 week+), consider:
- Add XMTP for Web3 wallet notifications (FREE)
- Self-host email on Akash (save another $10/month)
- Deploy to multiple Akash providers (redundancy)

---

**Start Date:** _____________
**Completion Date:** _____________
**Status:** [ ] Not Started [ ] In Progress [ ] Complete

Good luck! 🚀
