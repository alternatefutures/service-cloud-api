# Phase 1: Testnet Deployment Setup

**Project**: Decentralized Cloud Launch
**Type**: Task
**Priority**: High
**Labels**: infrastructure, deployment, testnet, day-1
**Parent**: [EPIC] Deploy Backend Infrastructure to Akash (Testnet → Mainnet)
**Estimate**: 1 day

## Objective

Deploy all services to Akash testnet (Sandbox) and verify initial functionality.

## Acceptance Criteria

- [ ] Secrets configured in `deploy-testnet.yaml` (YugabyteDB password, JWT secret, DATABASE_URL)
- [ ] Docker image available at ghcr.io/alternatefutures/service-cloud-api:latest (via GitHub Actions)
- [ ] Deployment script executed successfully: `./deploy-akash-testnet.sh`
- [ ] Bid accepted and lease created on Akash testnet
- [ ] Manifest sent to provider
- [ ] All 5 services showing "available": 1 in lease-status
  - yb-node-1
  - yb-node-2
  - yb-node-3
  - api
  - ipfs
- [ ] Service endpoints documented (API URL, Admin UI URL, IPFS URL)
- [ ] AKASH_DSEQ and AKASH_PROVIDER environment variables saved for future commands

## Steps

1. **Update deployment secrets**

   ```bash
   cd service-cloud-api
   nano deploy-testnet.yaml
   ```

   - Set `YSQL_PASSWORD` on all 3 YugabyteDB nodes (same password)
   - Update `DATABASE_URL` password to match
   - Generate and set `JWT_SECRET` (random 32+ character string)

2. **Verify Docker image built**
   - Check GitHub Actions: https://github.com/alternatefutures/service-cloud-api/actions
   - Confirm latest commit has green checkmark
   - Verify image exists: `docker pull ghcr.io/alternatefutures/service-cloud-api:latest`

3. **Run deployment**

   ```bash
   ./deploy-akash-testnet.sh
   ```

   - Answer "y" to Docker image ready
   - Answer "y" to secrets configured
   - Save the DSEQ number shown

4. **Wait for bids** (30 seconds)
   - Script will automatically list available bids

5. **Choose provider and create lease**

   ```bash
   export AKASH_DSEQ=<dseq-from-above>
   export AKASH_PROVIDER=<chosen-provider-address>

   akash tx market lease create \
     --dseq $AKASH_DSEQ \
     --from testnet \
     --provider $AKASH_PROVIDER \
     --node https://rpc.sandbox-01.aksh.pw:443 \
     --chain-id sandbox-01 \
     --yes
   ```

6. **Send manifest**

   ```bash
   akash provider send-manifest deploy-testnet.yaml \
     --dseq $AKASH_DSEQ \
     --from testnet \
     --provider $AKASH_PROVIDER \
     --node https://rpc.sandbox-01.aksh.pw:443
   ```

7. **Check deployment status**

   ```bash
   akash provider lease-status \
     --dseq $AKASH_DSEQ \
     --from testnet \
     --provider $AKASH_PROVIDER \
     --node https://rpc.sandbox-01.aksh.pw:443
   ```

8. **Document endpoints**
   - Note API URL from forwarded_ports
   - Note YugabyteDB Admin UI URL
   - Note IPFS Gateway URL
   - Save DSEQ and PROVIDER to a safe location

## Testing

**Quick health check:**

```bash
./scripts/check-testnet-health.sh
```

**Expected output:**

- All 5 services showing ✅ Running
- Service URLs displayed
- Recent API logs visible

## Notes

- Keep testnet wallet funded (check balance: `akash query bank balances <address> --node https://rpc.sandbox-01.aksh.pw:443`)
- If deployment fails, check logs: `akash provider service-logs --service <service-name> ...`
- Testnet uses free tokens from faucet (https://faucet.sandbox-01.aksh.pw/)

## Resources

- Deployment Guide: TESTNET_DEPLOYMENT.md (steps 1-6)
- Testnet Script: deploy-akash-testnet.sh
- Deployment Manifest: deploy-testnet.yaml

## Success Metrics

- Deployment time: < 30 minutes
- All services start successfully on first try
- No errors in deployment logs
