# Mainnet Migration Readiness Checklist

**Purpose**: Track testnet validation and determine mainnet migration readiness.

**Start Date**: ******\_\_\_******
**Target Migration Date**: ******\_\_\_******

---

## Phase 1: Testnet Deployment ✅/❌

### Initial Deployment (Day 1)

- [ ] Akash testnet AKT tokens acquired (25 AKT)
- [ ] Docker image built and pushed to ghcr.io
- [ ] deploy-testnet.yaml secrets configured
- [ ] Testnet deployment script executed successfully
- [ ] Bid accepted and lease created
- [ ] Manifest sent to provider
- [ ] All 5 services show "available": 1
  - [ ] yb-node-1
  - [ ] yb-node-2
  - [ ] yb-node-3
  - [ ] api
  - [ ] ipfs

**Notes**: ******************************\_\_\_******************************

---

## Phase 2: Service Verification (Day 1-2)

### YugabyteDB Cluster

- [ ] All 3 nodes showing "ALIVE" in Admin UI
- [ ] Replication factor confirmed as 3
- [ ] 0 under-replicated tablets
- [ ] Tablet distribution even (~33% per node)
- [ ] Admin UI accessible at forwarded port
- [ ] Database connection working from API

**Admin UI URL**: http://******\_\_\_******:**\_**

**Screenshot saved**: ******\_\_\_******

### GraphQL API

- [ ] API responds to health check queries
- [ ] GraphQL endpoint accessible
- [ ] WebSocket connections working
- [ ] Database queries executing successfully
- [ ] No startup errors in logs

**API URL**: http://******\_\_\_******:**\_**/graphql

**Test query result**:

```json
Response: _______________
```

### IPFS Gateway

- [ ] IPFS daemon running
- [ ] Gateway accessible via HTTP
- [ ] Test file retrieved successfully
- [ ] Peer connections established

**IPFS Gateway URL**: http://******\_\_\_******:**\_**

---

## Phase 3: Performance Testing (Day 2-3)

### Usage Buffer Performance

- [ ] Test script executed successfully
- [ ] All 10 tests passing
- [ ] Average latency: **\_** ms (target: < 5ms)
- [ ] P99 latency: **\_** ms (target: < 10ms)
- [ ] No errors during 100-iteration test
- [ ] Atomic upserts working correctly

**Test Results**:

```
Average latency: _____ ms
P99 latency: _____ ms
Errors: _____
```

### API Performance

- [ ] Response time P95: **\_** ms (target: < 100ms)
- [ ] Response time P99: **\_** ms (target: < 200ms)
- [ ] Error rate: **\_**% (target: < 0.1%)
- [ ] Concurrent connections tested: **\_**
- [ ] No timeouts during load test

**Load Test Command**:

```bash
# Run 100 concurrent requests
ab -n 1000 -c 100 http://<api-url>/graphql
```

### YugabyteDB Performance

- [ ] P99 read latency: **\_** ms (target: < 10ms)
- [ ] P99 write latency: **\_** ms (target: < 20ms)
- [ ] CPU usage avg: **\_**% (target: < 70%)
- [ ] Memory usage avg: **\_**% (target: < 80%)
- [ ] Disk usage: **\_**% (target: < 75%)

**Performance Screenshot**: ******\_\_\_******

---

## Phase 4: High Availability Testing (Day 3-4)

### Node Failure Test

- [ ] Simulated yb-node-2 failure
- [ ] Cluster remained available during failure
- [ ] No data loss occurred
- [ ] Queries continued successfully
- [ ] Admin UI showed failover
- [ ] Failed node auto-rejoined after restart
- [ ] Cluster rebalanced automatically
- [ ] 0 under-replicated tablets after recovery

**HA Test Results**:

```
Failure time: _____
Recovery time: _____
Data loss: Yes / No
Query failures during downtime: _____
```

### API Restart Test

- [ ] API container restarted gracefully
- [ ] Reconnected to database automatically
- [ ] WebSocket connections re-established
- [ ] No errors in logs
- [ ] < 30 seconds downtime

---

## Phase 5: Stability Testing (Day 4-7)

### 72-Hour Uptime Test

**Start Time**: ******\_\_\_******
**End Time**: ******\_\_\_******

- [ ] All services running for 72+ hours
- [ ] No unexpected restarts
- [ ] No memory leaks detected
- [ ] CPU usage stable (no upward trend)
- [ ] Memory usage stable (no upward trend)
- [ ] Disk usage stable
- [ ] 0 critical errors in logs

**Daily Health Checks**:

**Day 4**:

- Services up: ☐ All ☐ Partial ☐ Down
- Critical errors: **\_**
- Notes: ******\_\_\_******

**Day 5**:

- Services up: ☐ All ☐ Partial ☐ Down
- Critical errors: **\_**
- Notes: ******\_\_\_******

**Day 6**:

- Services up: ☐ All ☐ Partial ☐ Down
- Critical errors: **\_**
- Notes: ******\_\_\_******

**Day 7**:

- Services up: ☐ All ☐ Partial ☐ Down
- Critical errors: **\_**
- Notes: ******\_\_\_******

### Sustained Load Test

- [ ] Ran 24-hour load test
- [ ] No performance degradation
- [ ] No resource exhaustion
- [ ] Error rate remained < 0.1%
- [ ] Response times remained consistent

**Load Test Results**:

```
Duration: _____ hours
Total requests: _____
Failed requests: _____
Avg response time: _____ ms
```

---

## Phase 6: Data Integrity (Ongoing)

### Database Integrity

- [ ] Zero data corruption events
- [ ] Foreign key constraints enforced
- [ ] Unique constraints working
- [ ] Transaction atomicity verified
- [ ] No orphaned records detected

### Usage Buffer Integrity

- [ ] No lost usage increments
- [ ] Atomic upserts always succeed
- [ ] Buffer flush rate: 100%
- [ ] Metadata records intact
- [ ] No duplicate entries

**Data Integrity Report**:

```
Corruption events: _____
Failed constraints: _____
Lost updates: _____
```

---

## Phase 7: Monitoring & Observability (Day 5-7)

### Health Checks

- [ ] Automated health check script working
- [ ] All endpoints monitored
- [ ] Logs accessible and searchable
- [ ] Error tracking functional
- [ ] Performance metrics collected

### Alerting (if configured)

- [ ] Critical alerts tested
- [ ] Warning alerts tested
- [ ] Alert delivery confirmed
- [ ] Alert thresholds appropriate
- [ ] False positive rate acceptable

---

## Phase 8: Documentation & Process (Day 6-7)

### Documentation Complete

- [ ] Testnet deployment documented
- [ ] Service URLs documented
- [ ] Known issues documented
- [ ] Performance benchmarks documented
- [ ] HA test results documented

### Deployment Process Validated

- [ ] GitHub Actions building images successfully
- [ ] Akash deployment process smooth
- [ ] Secret management secure
- [ ] Rollback procedure tested
- [ ] Upgrade process tested

---

## Phase 9: Mainnet Preparation (Day 7+)

### Infrastructure

- [ ] Mainnet AKT tokens purchased (amount: **\_** AKT)
- [ ] Production secrets generated and secured
- [ ] deploy.yaml updated with production config
- [ ] DNS records prepared (not yet pointing)
- [ ] Backup strategy defined

### Security

- [ ] Production JWT secret generated
- [ ] Database password complex and unique
- [ ] API keys for production services obtained
- [ ] SSL/TLS certificates ready (if needed)
- [ ] Security audit completed

### Operational Readiness

- [ ] On-call rotation defined
- [ ] Incident response plan created
- [ ] Backup/restore tested
- [ ] Monitoring dashboards set up
- [ ] Alert escalation defined

---

## Final Go/No-Go Decision

### Critical Requirements (ALL must pass)

- [ ] ✅ 72+ hours of continuous uptime
- [ ] ✅ All 3 YugabyteDB nodes consistently ALIVE
- [ ] ✅ 0 under-replicated tablets for 48+ hours
- [ ] ✅ High availability test passed
- [ ] ✅ Zero data corruption/loss events
- [ ] ✅ API error rate < 0.1%
- [ ] ✅ Performance benchmarks met

### High Priority (80%+ must pass)

- [ ] API P95 response time < 100ms: **\_** ms
- [ ] YugabyteDB P99 read latency < 10ms: **\_** ms
- [ ] YugabyteDB P99 write latency < 20ms: **\_** ms
- [ ] CPU usage < 70%: **\_**%
- [ ] Memory usage < 80%: **\_**%
- [ ] Load test passed (100+ concurrent users): **\_**
- [ ] Documentation complete and reviewed
- [ ] Rollback procedure tested

---

## Migration Decision

**Date**: ******\_\_\_******

**Decision**: ☐ PROCEED TO MAINNET ☐ EXTEND TESTNET ☐ HALT

**Rationale**:

---

---

---

**Signed off by**: ******\_\_\_******

---

## Post-Migration Validation (Day 1 after mainnet)

### First 24 Hours

- [ ] All services deployed successfully
- [ ] Health checks passing
- [ ] No critical errors
- [ ] Performance within SLAs
- [ ] User access working
- [ ] DNS records updated and propagated

### First Week

- [ ] Daily health checks completed
- [ ] No major incidents
- [ ] Performance stable
- [ ] User feedback positive
- [ ] Monitoring working correctly

---

## Rollback Criteria

Rollback to testnet if:

🚨 **Immediate Rollback Required:**

- Multiple node failures
- Data corruption detected
- API error rate > 10%
- Complete service outage
- Security breach detected

⚠️ **Consider Rollback:**

- Persistent performance degradation (> 500ms response times)
- API error rate > 5% for > 1 hour
- Under-replicated tablets > 10
- Critical bug affecting user experience

---

## Lessons Learned

### What Went Well

---

---

### What Could Be Improved

---

---

### Action Items for Next Deployment

---

---

---

**Checklist Version**: 1.0
**Last Updated**: November 15, 2025
