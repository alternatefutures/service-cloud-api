# Deploy and Validate on Akash Testnet Before Mainnet Migration

## Overview

Deploy the YugabyteDB-based backend infrastructure to Akash testnet (Sandbox) for validation before mainnet deployment. This ensures production readiness through systematic testing and monitoring over a 7-day period.

## Context

We've completed:

- ✅ YugabyteDB migration (replaced PostgreSQL + Redis)
- ✅ 3-node cluster configuration for high availability
- ✅ Akash deployment manifests (testnet + mainnet)
- ✅ GitHub Actions for automated Docker builds
- ✅ Local testing (all tests passing, 1.27ms avg latency)
- ✅ Comprehensive monitoring and migration documentation

Now ready to deploy to Akash testnet for production validation.

## Acceptance Criteria

### Phase 1: Testnet Deployment (Day 1)

- [ ] Akash testnet wallet funded (25 AKT from faucet)
- [ ] Secrets configured in `deploy-testnet.yaml`
- [ ] Deployment successful via `./deploy-akash-testnet.sh`
- [ ] All 5 services running (yb-node-1, yb-node-2, yb-node-3, api, ipfs)
- [ ] Service endpoints accessible
- [ ] Initial health checks passing

### Phase 2: Service Verification (Day 1-2)

- [ ] YugabyteDB cluster: 3 nodes ALIVE, replication factor 3, 0 under-replicated tablets
- [ ] GraphQL API responding to queries
- [ ] IPFS gateway retrieving content
- [ ] Usage buffer tests passing on testnet
- [ ] No critical errors in logs

### Phase 3: Performance Testing (Day 2-3)

- [ ] API P95 response time < 100ms
- [ ] YugabyteDB P99 read latency < 10ms
- [ ] YugabyteDB P99 write latency < 20ms
- [ ] Load test: 100+ concurrent users
- [ ] Usage buffer avg latency < 5ms

### Phase 4: High Availability Testing (Day 3-4)

- [ ] Simulate node failure (kill yb-node-2)
- [ ] Verify cluster remains available
- [ ] Confirm no data loss
- [ ] Verify failed node auto-rejoins
- [ ] Confirm cluster rebalances automatically

### Phase 5: Stability Testing (Day 4-7)

- [ ] 72+ hours continuous uptime
- [ ] No unexpected restarts
- [ ] No memory leaks (stable resource usage)
- [ ] Daily health checks logged
- [ ] Error rate < 0.1%

### Phase 6: Mainnet Migration Decision

- [ ] Review completed `MAINNET_MIGRATION_CHECKLIST.md`
- [ ] All critical criteria met
- [ ] Go/No-Go decision documented
- [ ] Mainnet deployment plan approved

## Tasks

### Setup & Deployment

1. Update `deploy-testnet.yaml` with production-like secrets
2. Run deployment: `./deploy-akash-testnet.sh`
3. Accept provider bid and create lease
4. Send manifest to provider
5. Verify all services started

### Daily Monitoring (7 days)

6. Run `./scripts/check-testnet-health.sh` daily
7. Log metrics in `MAINNET_MIGRATION_CHECKLIST.md`
8. Check YugabyteDB Admin UI for cluster health
9. Review service logs for errors
10. Monitor resource usage trends

### Testing

11. Run usage buffer test suite
12. Execute load tests (100+ concurrent users)
13. Perform HA failover test
14. Test API performance under load
15. Validate data integrity

### Documentation

16. Document service endpoints (API, IPFS, Admin UI)
17. Log daily health check results
18. Document any issues encountered
19. Update migration checklist
20. Create mainnet deployment plan

### Mainnet Preparation (after testnet validation)

21. Purchase mainnet AKT tokens
22. Generate production secrets
23. Update `deploy.yaml` with mainnet config
24. Prepare DNS records
25. Review and approve mainnet deployment

## Technical Details

### Testnet Configuration

- **Network**: Akash Sandbox (sandbox-01)
- **RPC**: https://rpc.sandbox-01.aksh.pw:443
- **Faucet**: https://faucet.sandbox-01.aksh.pw/
- **Wallet**: testnet (already configured, funded with 25 AKT)

### Services

- **YugabyteDB**: 3-node cluster (1 CPU, 2Gi RAM, 20Gi storage each)
- **GraphQL API**: Node.js + Prisma (0.5 CPU, 512Mi RAM)
- **IPFS**: Kubo gateway (1 CPU, 2Gi RAM, 20Gi storage)

### Docker Image

- **Registry**: ghcr.io/alternatefutures/service-cloud-api
- **Tags**: latest, testnet, main-{sha}
- **Build**: Automated via GitHub Actions

### Monitoring Tools

- **Health Check**: `./scripts/check-testnet-health.sh`
- **Admin UI**: YugabyteDB cluster monitoring
- **Logs**: Via `akash provider service-logs`
- **Metrics**: Tracked in `MAINNET_MIGRATION_CHECKLIST.md`

## Success Metrics

### Critical (ALL must pass)

- ✅ 72+ hours continuous uptime
- ✅ All 3 YugabyteDB nodes consistently ALIVE
- ✅ 0 under-replicated tablets for 48+ hours
- ✅ High availability test passed
- ✅ Zero data corruption/loss events
- ✅ API error rate < 0.1%

### High Priority (80%+ must pass)

- API P95 response time < 100ms
- YugabyteDB P99 latencies < 10ms read / 20ms write
- Load test handles 100+ concurrent users
- CPU < 70%, Memory < 80%
- 100% buffer flush success rate

## Timeline

- **Days 1-2**: Deploy and initial verification
- **Days 3-5**: Performance and HA testing
- **Days 6-7**: 72-hour stability check
- **Day 8+**: Mainnet preparation and deployment

Estimated total: 7-10 days

## Dependencies

- ✅ GitHub Actions workflow (automated Docker builds)
- ✅ Akash testnet wallet with AKT tokens
- ✅ YugabyteDB migration complete
- ✅ Documentation and monitoring tools ready

## Risks

### Low Risk

- Testnet resets (data loss expected, no impact on validation)
- Lower resource allocation than mainnet (acceptable for testing)
- Free testnet tokens may run out (can request more)

### Mitigation

- Daily health checks to catch issues early
- Comprehensive monitoring to detect problems quickly
- Rollback procedure documented
- Mainnet config separate from testnet

## Resources

- **Deployment Guide**: `TESTNET_DEPLOYMENT.md`
- **Monitoring Guide**: `TESTNET_MONITORING.md`
- **Migration Checklist**: `MAINNET_MIGRATION_CHECKLIST.md`
- **YugabyteDB Guide**: `ADMIN_UI_GUIDE.md`
- **Local Test Results**: `LOCAL_TEST_RESULTS.md`

## Labels

- `infrastructure`
- `deployment`
- `high-priority`
- `depin`
- `testing`

## Estimate

7-10 days (includes 72-hour stability test)
