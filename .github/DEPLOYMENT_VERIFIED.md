# Deployment Verification Checklist

This document tracks the verification of our production deployment setup.

## Pre-Deployment Checklist

### GitHub Configuration
- ✅ Production environment created
- ✅ GitHub Secrets configured:
  - ✅ `AKASH_MNEMONIC`
  - ✅ `YUGABYTE_PASSWORD`
  - ✅ `JWT_SECRET`
  - ✅ `ARWEAVE_WALLET`
  - ✅ `FILECOIN_WALLET_KEY`
  - ⚪ `RESEND_API_KEY` (optional)
  - ⚪ `SENTRY_DSN` (skipped - using decentralized monitoring)
- ✅ Branch protection rules configured
- ✅ CI workflows tested

### Wallet Setup
- ✅ Akash wallet funded (~222 AKT)
- ✅ Arweave wallet created and funded
- ✅ Filecoin wallet created and funded

### Infrastructure
- ✅ CI workflow (`.github/workflows/ci.yml`)
  - Tests with PostgreSQL + Redis
  - Linting and type checking
  - Build verification
  - Security scans (TruffleHog + npm audit)
- ✅ Deployment workflow (`.github/workflows/deploy-akash.yml`)
  - Auto-deploy on push to main
  - Manual deployment option
  - Secret injection
  - Akash deployment automation

### DePIN Stack
- ✅ Compute: Akash Network (mainnet)
- ✅ Database: YugabyteDB (3-node cluster)
- ✅ Storage: IPFS (self-hosted)
- ✅ Storage: Arweave (permanent)
- ✅ Storage: Filecoin (direct integration)
- ✅ Monitoring: IPFS + Arweave status page

## Deployment Cost
- **Monthly**: ~108 AKT (~$65 at $0.60/AKT)
- **Daily**: ~3.6 AKT (~$2.16)
- **Current runway**: ~2 months with 222 AKT

## Post-Deployment Tasks

After successful deployment:
- [ ] Configure DNS for domains
  - [ ] api.alternatefutures.ai → API service
  - [ ] yb.alternatefutures.ai → YugabyteDB admin
  - [ ] ipfs.alternatefutures.ai → IPFS gateway
- [ ] Deploy status page to Arweave
- [ ] Set up status page auto-updates
- [ ] Monitor first 24 hours of operation
- [ ] Verify all services are accessible
- [ ] Test database connectivity
- [ ] Test IPFS uploads
- [ ] Test Arweave uploads
- [ ] Test Filecoin storage deals

## Monitoring

### Service Health Checks
```bash
# API Health
curl https://api.alternatefutures.ai/health

# IPFS Gateway
curl https://ipfs.alternatefutures.ai/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn

# YugabyteDB Admin
curl https://yb.alternatefutures.ai
```

### Akash Deployment Info
```bash
# View deployments
akash query deployment list \
  --owner <AKASH_ADDRESS> \
  --node https://rpc.akashnet.net:443

# View logs
akash provider lease-logs \
  --dseq <DSEQ> \
  --provider <PROVIDER> \
  --node https://rpc.akashnet.net:443 \
  --from default
```

## Rollback Procedure

If deployment fails:
1. Close bad deployment:
   ```bash
   akash tx deployment close \
     --dseq <DSEQ> \
     --from default \
     --node https://rpc.akashnet.net:443 \
     --chain-id akashnet-2 \
     -y
   ```
2. Fix issues in code
3. Create new PR
4. Redeploy via merge to main

## Success Criteria

Deployment is successful when:
- ✅ All CI checks pass
- ✅ Akash deployment creates successfully
- ✅ Provider accepts bid and creates lease
- ✅ All services start and become healthy
- ✅ API responds to health check
- ✅ Database is accessible
- ✅ IPFS gateway serves content
- ✅ No errors in service logs

---

**First deployment**: Pending
**Status**: Ready for production deployment 🚀
