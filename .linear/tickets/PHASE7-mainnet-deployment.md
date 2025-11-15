# Phase 7: Mainnet Deployment

**Project**: Decentralized Cloud Launch
**Type**: Task
**Priority**: Critical
**Labels**: infrastructure, deployment, mainnet, production
**Parent**: [EPIC] Deploy Backend Infrastructure to Akash (Testnet → Mainnet)
**Estimate**: 1 day

## Objective

Deploy backend infrastructure to Akash mainnet and verify all services operational.

## Acceptance Criteria

- [ ] All services deployed to Akash mainnet
- [ ] All 5 services running and healthy
- [ ] Database migrations applied successfully
- [ ] DNS records pointing to services
- [ ] SSL/TLS working (if applicable)
- [ ] Initial health checks passing
- [ ] Monitoring operational
- [ ] No critical errors

## Tasks

1. **Pre-Deployment Checks**
   - [ ] Mainnet AKT balance verified
   - [ ] deploy.yaml reviewed
   - [ ] Docker image built and tested
   - [ ] Backup plan ready
   - [ ] Rollback plan ready
   - [ ] Team notified

2. **Deploy to Mainnet**

   ```bash
   cd service-cloud-api

   # Verify wallet and balance
   akash keys show default -a
   akash query bank balances <address> --node https://rpc.akashnet.net:443

   # Run deployment
   ./deploy-akash.sh
   ```

3. **Accept Bid & Create Lease**

   ```bash
   export AKASH_DSEQ=<dseq>
   export AKASH_PROVIDER=<provider>

   akash tx market lease create \
     --dseq $AKASH_DSEQ \
     --from default \
     --provider $AKASH_PROVIDER \
     --node https://rpc.akashnet.net:443 \
     --chain-id akashnet-2 \
     --yes
   ```

4. **Send Manifest**

   ```bash
   akash provider send-manifest deploy.yaml \
     --dseq $AKASH_DSEQ \
     --from default \
     --provider $AKASH_PROVIDER \
     --node https://rpc.akashnet.net:443
   ```

5. **Verify Services Started**

   ```bash
   akash provider lease-status \
     --dseq $AKASH_DSEQ \
     --from default \
     --provider $AKASH_PROVIDER \
     --node https://rpc.akashnet.net:443
   ```

   - All services "available": 1
   - Note forwarded ports

6. **Run Database Migrations**

   ```bash
   # Get shell access to API container
   akash provider lease-shell \
     --service api \
     ... -- /bin/bash

   # Run migrations
   npx prisma migrate deploy
   exit
   ```

7. **Update DNS Records**
   - Point A records to provider IPs
   - api.alternatefutures.ai → <api-port>
   - yb.alternatefutures.ai → <admin-port>
   - ipfs.alternatefutures.ai → <ipfs-port>
   - Wait for propagation (5-30 minutes)

8. **Test Services**

   ```bash
   # Test API
   curl https://api.alternatefutures.ai/graphql \
     -X POST \
     -H 'Content-Type: application/json' \
     -d '{"query":"{ __typename }"}'

   # Test Admin UI
   open https://yb.alternatefutures.ai

   # Test IPFS
   curl https://ipfs.alternatefutures.ai/ipfs/<test-hash>
   ```

9. **Run Full Health Checks**
   - YugabyteDB: 3 nodes ALIVE
   - API: responding correctly
   - IPFS: gateway working
   - Usage buffer: tests passing
   - No errors in logs

10. **Monitor for 12 Hours**
    - Check health every hour
    - Monitor error rates
    - Watch resource usage
    - Be ready for rollback

## Rollback Procedure

If deployment fails:

```bash
# Close mainnet deployment
akash tx deployment close \
  --dseq $AKASH_DSEQ \
  --from default \
  --node https://rpc.akashnet.net:443 \
  --chain-id akashnet-2 \
  --yes

# Point DNS back to testnet or previous
# Review logs and fix issues
# Retry deployment
```

## Success Metrics

- Deployment completes in < 1 hour
- All services healthy on first try
- DNS resolves correctly
- No critical errors
- API responding correctly
- YugabyteDB cluster fully operational

## Resources

- Deployment Script: deploy-akash.sh
- Mainnet Config: deploy.yaml
- Monitoring Guide: TESTNET_MONITORING.md
