# YugabyteDB Admin UI Guide

**URL:** http://localhost:17100

**For Production (Akash):** https://yb.alternatefutures.ai

---

## 📊 Dashboard Overview

### Main Navigation

The Admin UI has several tabs:

1. **Overview** - Cluster health and metrics
2. **Tables** - Browse database schema and data
3. **Queries** - View slow queries and performance
4. **Nodes** - Node status and distribution
5. **Replication** - Data replication status
6. **Metrics** - Detailed performance metrics

---

## 🗃️ Tables Tab - Explore Your Data

### Finding Your Tables

1. Click **"Tables"** in the top navigation
2. Select **"YSQL"** (PostgreSQL API)
3. Select database: **"yugabyte"**
4. Select schema: **"public"**

### Tables to Check

**Usage Buffer Tables:**

```
📋 UsageBuffer
   - Primary table for buffering usage metrics
   - Check: Current buffered data
   - Columns: userId, bandwidth, compute, requests, updatedAt

📋 UsageMetadata
   - Optional metadata for auditing
   - Check: Metadata records
   - Columns: id, userId, type, metadata, createdAt
```

**Application Tables:**

```
📋 User - User accounts
📋 Project - Projects
📋 Site - Deployed sites
📋 Deployment - Deployment history
📋 AFFunction - Serverless functions
📋 UsageRecord - Final usage records (after aggregation)
📋 Customer - Billing customers
📋 Invoice - Generated invoices
```

### Viewing Table Data

1. Click on any table name (e.g., "UsageBuffer")
2. You'll see:
   - **Schema** - Column definitions and types
   - **Size** - Table size and row count
   - **Indexes** - Configured indexes
   - **Live Data** - Current rows (limited preview)

### Running Queries

Click the **SQL Console** button to run custom queries:

```sql
-- View current buffered usage
SELECT * FROM "UsageBuffer" LIMIT 10;

-- View usage metadata
SELECT * FROM "UsageMetadata"
ORDER BY "createdAt" DESC
LIMIT 10;

-- Check buffer statistics
SELECT
  COUNT(*) as active_users,
  SUM(bandwidth) as total_bandwidth,
  SUM(requests) as total_requests,
  SUM(compute) as total_compute
FROM "UsageBuffer";

-- View recent usage records
SELECT * FROM "UsageRecord"
ORDER BY timestamp DESC
LIMIT 10;
```

---

## 📈 Overview Tab - Cluster Health

### Key Metrics to Monitor

**Cluster Status:**

- ✅ All nodes healthy (should show 1/1 for local testing)
- ✅ Replication factor: 1 (local) or 3 (production)
- ✅ Under-replicated tablets: 0

**Performance Metrics:**

- **Ops/sec** - Operations per second
- **Latency** - P99 read/write latency
- **Connections** - Active database connections

**Resource Usage:**

- **CPU** - Current CPU usage
- **Memory** - RAM usage
- **Disk** - Storage usage

---

## 🔍 Queries Tab - Performance Analysis

### Slow Query Log

1. Click **"Queries"** tab
2. View **"Slow Queries"** section
3. Find queries taking >100ms

### Query Analysis

For each query you can see:

- Execution time
- Rows affected
- Query plan
- Optimization suggestions

**Tip:** If you see slow queries on UsageBuffer operations, check indexes!

---

## 🌐 Nodes Tab - Cluster Topology

### Local Setup (1 Node)

```
Node 1:
- Host: localhost
- Status: ALIVE ✅
- Role: Master + TServer
- Version: 2.x.x
```

### Production Setup (3 Nodes)

```
Node 1:
- Host: yb-node-1 (Akash provider)
- Status: ALIVE ✅
- Role: Master + TServer
- Tablets: ~33% of data

Node 2:
- Host: yb-node-2 (Akash provider)
- Status: ALIVE ✅
- Role: Master + TServer
- Tablets: ~33% of data

Node 3:
- Host: yb-node-3 (Akash provider)
- Status: ALIVE ✅
- Role: Master + TServer
- Tablets: ~33% of data
```

---

## 🔄 Replication Tab - Data Distribution

### What to Check

**Replication Factor:**

- Local: 1 (no replication)
- Production: 3 (triple replication)

**Under-Replicated Tablets:**

- Should always be: 0
- If >0: Some data isn't fully replicated (unhealthy)

**Tablet Distribution:**

- Should be evenly balanced across nodes
- Each node should have ~33% of tablets (3-node cluster)

---

## 📊 Metrics Tab - Deep Dive

### Key Metrics to Monitor

**YSQL (PostgreSQL API):**

- Total operations/sec
- Read vs. Write ratio
- Connection pool usage

**Performance:**

- P99 latency (should be <10ms for reads)
- P99 latency (should be <20ms for writes)

**Resource Usage:**

- CPU per node
- Memory per node
- Disk IOPS

---

## 🛠️ Useful SQL Queries

### Check Buffer Activity

```sql
-- Count users in buffer
SELECT COUNT(*) FROM "UsageBuffer";

-- Top 10 users by bandwidth
SELECT "userId", bandwidth
FROM "UsageBuffer"
ORDER BY bandwidth DESC
LIMIT 10;

-- Metadata by type
SELECT type, COUNT(*)
FROM "UsageMetadata"
GROUP BY type;
```

### Monitor Aggregation

```sql
-- Compare buffer vs. records
SELECT
  (SELECT COUNT(*) FROM "UsageBuffer") as buffered_users,
  (SELECT COUNT(DISTINCT "customerId") FROM "UsageRecord") as recorded_customers;
```

### Check Indexes

```sql
-- View all indexes
SELECT
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('UsageBuffer', 'UsageMetadata')
ORDER BY tablename, indexname;
```

---

## 🎯 What to Look For (Production)

### Healthy Cluster Indicators

✅ **All nodes show "ALIVE" status**
✅ **0 under-replicated tablets**
✅ **Even tablet distribution** (~33% per node)
✅ **P99 latency <20ms** for writes
✅ **P99 latency <10ms** for reads
✅ **CPU usage <70%** on all nodes
✅ **Memory usage <80%** on all nodes

### Warning Signs

⚠️ **Any node showing "DOWN" status**
⚠️ **Under-replicated tablets >0**
⚠️ **Uneven tablet distribution** (>20% variance)
⚠️ **P99 latency >50ms** consistently
⚠️ **CPU >90%** on any node
⚠️ **Memory >95%** on any node

### Critical Issues

🚨 **2+ nodes down** (cluster unavailable)
🚨 **Consistent query timeouts**
🚨 **Replication lag >10 seconds**
🚨 **Disk space >95%** full

---

## 🔐 Security Note

**Local Development:**

- Admin UI is open (no auth required)
- Safe because it's localhost only

**Production (Akash):**

- Admin UI exposed at `yb.alternatefutures.ai`
- **TODO:** Add authentication (basic auth or firewall)
- **TODO:** Restrict access to your IP only

**Recommended:** Use Cloudflare Access or similar to protect the admin UI in production.

---

## 📝 Quick Reference

| What                 | Where                | Action                 |
| -------------------- | -------------------- | ---------------------- |
| View buffered usage  | Tables → UsageBuffer | Check current buffer   |
| Run SQL queries      | Tables → SQL Console | Execute custom queries |
| Check cluster health | Overview             | Monitor status         |
| View slow queries    | Queries              | Optimize performance   |
| Check replication    | Replication          | Verify data safety     |
| Monitor resources    | Metrics              | Track CPU/memory       |

---

## 🎓 Learning Resources

**YugabyteDB Docs:**

- Admin UI: https://docs.yugabyte.com/preview/admin/yb-master/#universe
- Performance Tuning: https://docs.yugabyte.com/preview/explore/observability/
- Monitoring: https://docs.yugabyte.com/preview/explore/observability/metrics/

---

**Pro Tip:** Bookmark the Admin UI and check it regularly to understand your database performance patterns!
