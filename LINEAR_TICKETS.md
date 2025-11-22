# Linear Tickets for YugabyteDB Production Readiness

## Ticket 1: Increase YugabyteDB CPU Capacity (HIGH PRIORITY)

**Project:** Decentralized Cloud Launch
**Priority:** High
**Assignee:** @wonderwomancode
**Status:** Backlog

### Title

Increase YugabyteDB CPU capacity from 1 to 2 CPUs per node

### Description

## Context

Currently running YugabyteDB with 1 CPU per node for beta testing to reduce costs. Need to increase to 2 CPUs per node for production workloads.

## Requirements

- Update `deploy-mainnet.yaml`: change YugabyteDB CPU from 1.0 to 2.0 units per node (lines 270, 282, 294)
- Update `deploy-mainnet-with-infisical.yaml`: same change (lines 187, 197, 207)
- Test deployment with new configuration
- Monitor performance improvements

## Background

YugabyteDB runs both Master and TServer processes per node:

- **Master:** Cluster coordination, metadata, consensus (Raft protocol)
- **TServer:** Data storage, query processing, replication

Production recommendation is 2 CPUs per node to handle:

- Concurrent query processing
- 3-way replication overhead
- Background compaction and maintenance
- Faster recovery from node failures

## Files to Update

```yaml
# deploy-mainnet.yaml
yb-node-1:
  resources:
    cpu:
      units: 2.0 # Change from 1.0

yb-node-2:
  resources:
    cpu:
      units: 2.0 # Change from 1.0

yb-node-3:
  resources:
    cpu:
      units: 2.0 # Change from 1.0
```

Apply same changes to `deploy-mainnet-with-infisical.yaml`

## Cost Impact

- Increasing from 3 CPUs to 6 CPUs total (1→2 per node × 3 nodes)
- Estimated additional cost: ~$35/month
- Total database cost: ~$70/month (vs current ~$35/month)

## Acceptance Criteria

- [ ] SDL files updated with 2 CPUs per YugabyteDB node
- [ ] Deployment tested successfully on Akash
- [ ] Performance metrics show improved query response times
- [ ] No increase in database errors or timeouts

---

## Ticket 2: Database Load Testing

**Project:** Decentralized Cloud Launch
**Priority:** Medium
**Assignee:** @wonderwomancode
**Status:** Blocked (depends on Ticket 1)
**Blocked by:** Increase YugabyteDB CPU Capacity

### Title

Perform load testing on YugabyteDB cluster after CPU upgrade

### Description

## Context

After increasing YugabyteDB CPU capacity to 2 cores per node, we need to validate performance under load and establish baseline metrics.

## Objectives

1. Validate YugabyteDB cluster performance with 2 CPUs per node
2. Establish baseline metrics for production capacity planning
3. Identify bottlenecks and optimization opportunities
4. Document performance characteristics

## Test Scenarios

### 1. Read Performance

- Concurrent read queries (100, 500, 1000 queries/sec)
- Measure: latency (p50, p95, p99), throughput, error rate

### 2. Write Performance

- Concurrent writes with replication (100, 500, 1000 writes/sec)
- Measure: write latency, replication lag, consistency

### 3. Mixed Workload

- 70% reads, 30% writes (realistic production ratio)
- Sustained load over 30 minutes
- Measure: overall throughput, query distribution

### 4. Spike Testing

- Sudden traffic spikes (2x, 5x, 10x baseline)
- Measure: recovery time, error rates during spike

### 5. Endurance Testing

- Sustained moderate load (24 hours)
- Measure: memory leaks, connection pool exhaustion, disk growth

## Tools

Use one or more of:

- **k6** - Modern load testing tool (recommended)
- **Apache JMeter** - Traditional load testing
- **pgbench** - PostgreSQL-specific benchmarking (YSQL compatible)
- **YugabyteDB Workload Generator** - Built-in tool

## Expected Outcomes

### Performance Targets

- Query latency p95 < 50ms for simple queries
- Write latency p95 < 100ms with 3-way replication
- Sustained throughput: 500+ queries/sec
- 99.9% uptime during load test

### Deliverables

- Load test results document with:
  - Test scenarios and configurations
  - Performance graphs (latency, throughput, CPU, memory)
  - Identified bottlenecks
  - Recommendations for optimization
- Updated capacity planning document
- Monitoring dashboard for production

## Resources

- [YugabyteDB Benchmarking Guide](https://docs.yugabyte.com/preview/benchmark/)
- [k6 Documentation](https://k6.io/docs/)
- Our API endpoints: `https://api.alternatefutures.ai/graphql`
- YugabyteDB Admin: `https://yb.alternatefutures.ai`

## Acceptance Criteria

- [ ] All 5 test scenarios executed successfully
- [ ] Results documented with graphs and analysis
- [ ] Performance meets or exceeds targets
- [ ] Recommendations provided for optimization
- [ ] Monitoring alerts configured based on findings
- [ ] Capacity plan updated with max user estimates

## Estimated Effort

- Setup and test development: 4 hours
- Test execution and monitoring: 8 hours (including 24h endurance)
- Analysis and documentation: 4 hours
- **Total: ~16 hours over 2-3 days**

---

## How to Create These Tickets

### Option 1: Via Linear Web UI

1. Go to Linear → Decentralized Cloud Launch project
2. Create new issue
3. Copy title and description from above
4. Set priority and assignee

### Option 2: Via Linear API

```bash
# Set your Linear API key
export LINEAR_API_KEY="your_api_key_here"

# Create Ticket 1
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation IssueCreate { issueCreate(input: { teamId: \"YOUR_TEAM_ID\", title: \"Increase YugabyteDB CPU capacity from 1 to 2 CPUs per node\", description: \"...\", priority: 1 }) { success issue { id identifier } } }"
  }'

# Create Ticket 2 (after getting ID from Ticket 1)
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation IssueCreate { issueCreate(input: { teamId: \"YOUR_TEAM_ID\", title: \"Perform load testing on YugabyteDB cluster after CPU upgrade\", description: \"...\", priority: 2, blockedBy: [\"TICKET_1_ID\"] }) { success issue { id identifier } } }"
  }'
```

### Option 3: Via Linear CLI

```bash
# Install Linear CLI
npm install -g @linear/cli

# Login
linear login

# Create Ticket 1
linear issue create \
  --title "Increase YugabyteDB CPU capacity from 1 to 2 CPUs per node" \
  --description "..." \
  --priority high \
  --project "Decentralized Cloud Launch"

# Create Ticket 2
linear issue create \
  --title "Perform load testing on YugabyteDB cluster after CPU upgrade" \
  --description "..." \
  --priority medium \
  --project "Decentralized Cloud Launch" \
  --blocked-by "ALT-XXX"  # Use ID from Ticket 1
```
