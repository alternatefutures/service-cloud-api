# Testnet Monitoring & Mainnet Migration Guide

**Purpose**: Track testnet health and determine readiness for mainnet deployment.

---

## Monitoring Dashboard

### Quick Health Check Script

Run this to get instant testnet health status:

```bash
./scripts/check-testnet-health.sh
```

### Continuous Monitoring

Monitor testnet in real-time:

```bash
./scripts/monitor-testnet.sh
```

---

## Key Metrics to Monitor

### 1. YugabyteDB Cluster Health

**Critical Metrics:**

- ✅ All 3 nodes showing "ALIVE" status
- ✅ 0 under-replicated tablets
- ✅ Replication factor: 3
- ✅ Even tablet distribution (~33% per node)

**Performance Metrics:**

- P99 read latency: < 10ms
- P99 write latency: < 20ms
- CPU usage: < 70% on all nodes
- Memory usage: < 80% on all nodes
- Disk usage: < 75%

**Check via:**

- Admin UI: `http://<testnet-provider-ip>:<admin-port>`
- Script: `./scripts/check-yugabyte-health.sh`

---

### 2. GraphQL API Health

**Critical Metrics:**

- ✅ API responding to GraphQL queries
- ✅ No 5xx errors
- ✅ Database connection stable

**Performance Metrics:**

- Response time: < 100ms (P95)
- Error rate: < 0.1%
- Uptime: > 99.5%

**Test:**

```bash
# Health check endpoint
curl -X POST http://<api-url>/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __typename }"}'

# Expected: {"data":{"__typename":"Query"}}
```

---

### 3. Usage Buffer Performance

**Critical Metrics:**

- ✅ increment() operations succeeding
- ✅ No data loss during node failures
- ✅ Atomic upserts working correctly

**Performance Metrics:**

- Average latency: < 5ms
- P99 latency: < 10ms
- Buffer flush success rate: 100%

**Test:**

```bash
npm run test:usage-buffer
```

---

### 4. IPFS Gateway

**Critical Metrics:**

- ✅ IPFS daemon running
- ✅ Gateway accessible
- ✅ Content retrievable

**Test:**

```bash
curl http://<ipfs-gateway-url>/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG
```

---

### 5. High Availability Testing

**Critical Tests:**

- ✅ Cluster survives 1 node failure
- ✅ Automatic failover works
- ✅ No data loss during failover
- ✅ Failed node rejoins cluster automatically

**Run HA Test:**

```bash
./scripts/test-ha-failover.sh
```

---

## Mainnet Migration Criteria

### ✅ Testnet must pass ALL of these:

#### Infrastructure Stability

- [ ] 72+ hours of continuous uptime
- [ ] Zero unexpected restarts or crashes
- [ ] All 3 YugabyteDB nodes consistently "ALIVE"
- [ ] 0 under-replicated tablets for 48+ hours
- [ ] No memory leaks (stable memory usage)

#### Performance Benchmarks

- [ ] API P95 response time < 100ms
- [ ] YugabyteDB P99 read latency < 10ms
- [ ] YugabyteDB P99 write latency < 20ms
- [ ] Usage buffer avg latency < 5ms
- [ ] Zero query timeouts in 24+ hours

#### Reliability Tests

- [ ] High availability test passed (node failure recovery)
- [ ] Database backup/restore tested successfully
- [ ] Rolling restart tested without downtime
- [ ] Load testing completed (100+ concurrent users)

#### Data Integrity

- [ ] Zero data corruption events
- [ ] All database constraints enforced
- [ ] Usage buffer never lost data
- [ ] Atomic operations working correctly

#### Monitoring & Observability

- [ ] All health checks passing
- [ ] Logs showing no critical errors
- [ ] Metrics collection working
- [ ] Alert system tested and working

#### Deployment Process

- [ ] GitHub Actions building images successfully
- [ ] Docker images tested on testnet
- [ ] Akash deployment process documented
- [ ] Rollback procedure tested

---

## Migration Timeline

### Phase 1: Testnet Validation (3-7 days)

**Days 1-2: Initial Deployment**

- Deploy to Akash testnet
- Verify all services start correctly
- Run initial health checks
- Monitor for 24 hours

**Days 3-5: Stability Testing**

- Run load tests
- Test high availability (node failures)
- Monitor performance under load
- Fix any issues found

**Days 6-7: Final Validation**

- 72-hour stability check
- Performance benchmark validation
- Review all metrics
- Document any concerns

### Phase 2: Mainnet Preparation (1-2 days)

**Pre-deployment:**

- [ ] Buy AKT tokens for mainnet
- [ ] Update deploy.yaml with production secrets
- [ ] Configure DNS records
- [ ] Set up production monitoring/alerts
- [ ] Review all documentation
- [ ] Create mainnet deployment checklist

### Phase 3: Mainnet Deployment (1 day)

**Deployment day:**

- Deploy using deploy-akash.sh
- Verify all services
- Run health checks
- Monitor for 12 hours
- Gradual traffic ramp-up

---

## Monitoring Tools & Scripts

### Health Check Scripts

All scripts located in `scripts/`:

1. **check-testnet-health.sh** - Quick health snapshot
2. **monitor-testnet.sh** - Continuous monitoring
3. **check-yugabyte-health.sh** - YugabyteDB cluster health
4. **test-ha-failover.sh** - High availability testing
5. **load-test.sh** - Load testing script
6. **check-deployment-status.sh** - Akash deployment status

### Metrics to Log

Create a daily log with these metrics:

```markdown
## Testnet Health Log - [DATE]

### YugabyteDB

- Nodes alive: 3/3
- Under-replicated tablets: 0
- P99 read latency: 5ms
- P99 write latency: 12ms
- CPU avg: 45%
- Memory avg: 60%

### API

- Uptime: 99.9%
- P95 response time: 45ms
- Error rate: 0.02%
- Requests/sec: 120

### Usage Buffer

- Avg latency: 1.5ms
- Buffer flushes: 1440/1440 (100%)
- Data integrity: ✅

### Issues

- None

### Notes

- Cluster stable, ready for HA test tomorrow
```

---

## Red Flags (Do NOT migrate if present)

🚨 **Critical Issues:**

- Any node consistently showing "DOWN" status
- Under-replicated tablets > 0 for more than 1 hour
- Data corruption or loss events
- Query timeouts or database errors
- Memory leaks (increasing memory usage)
- API error rate > 1%

⚠️ **Warning Signs:**

- Intermittent connection issues
- Slow query performance (P99 > 50ms)
- High CPU usage (> 80%)
- Disk space > 80%
- Inconsistent node performance

---

## Decision Matrix

| Criteria          | Weight   | Pass Threshold                | Testnet Status | Pass? |
| ----------------- | -------- | ----------------------------- | -------------- | ----- |
| Uptime            | High     | 99.5%+                        | \_\_\_%        | ☐     |
| YB Cluster Health | Critical | All alive, 0 under-replicated | \_\_\_         | ☐     |
| API Performance   | High     | P95 < 100ms                   | \_\_\_ms       | ☐     |
| HA Test           | Critical | Passes without data loss      | \_\_\_         | ☐     |
| Data Integrity    | Critical | 0 corruption events           | \_\_\_         | ☐     |
| Load Test         | High     | Handles 100+ users            | \_\_\_         | ☐     |
| Stability         | High     | 72h+ continuous               | \_\_\_h        | ☐     |

**Migration Decision:** Proceed when **ALL Critical** and **80%+ of High** criteria pass.

---

## Post-Mainnet Monitoring

After mainnet deployment, monitor for 7 days before declaring "stable":

**Days 1-3: Intensive Monitoring**

- Check health every 4 hours
- Monitor all metrics closely
- Have rollback plan ready

**Days 4-7: Normal Monitoring**

- Daily health checks
- Review metrics daily
- Monitor user feedback

**Day 7+: Steady State**

- Health checks 2x/week
- Weekly metric reviews
- Automated alerts only

---

## Rollback Procedure

If mainnet deployment fails:

1. **Immediate rollback** (< 5 minutes)

   ```bash
   akash tx deployment close --dseq $AKASH_DSEQ --from default --yes
   ```

2. **Restore from backup** (if data affected)

   ```bash
   pg_restore -h localhost -U yugabyte -d alternatefutures < backup.sql
   ```

3. **Post-mortem**
   - Document what went wrong
   - Fix issues on testnet
   - Re-validate before retry

---

## Automated Alerts

Set up alerts for:

**Critical (immediate action):**

- Any node goes down
- API error rate > 5%
- Database connection failures
- Under-replicated tablets > 0

**Warning (review within 1 hour):**

- CPU > 80%
- Memory > 85%
- Disk > 80%
- P99 latency > 50ms
- API error rate > 1%

**Info (daily review):**

- Performance degradation trends
- Unusual traffic patterns
- Resource usage trends

---

## Resources

- **Testnet Admin UI**: http://<provider-ip>:<admin-port>
- **API Health**: http://<api-url>/graphql
- **IPFS Gateway**: http://<ipfs-url>/ipfs
- **Akash Dashboard**: https://stats.akash.network
- **YugabyteDB Docs**: https://docs.yugabyte.com/preview/explore/observability/

---

**Last Updated**: [Auto-updated by monitoring script]
