# Phase 2: Service Verification & Initial Testing

**Project**: Decentralized Cloud Launch
**Type**: Task
**Priority**: High
**Labels**: infrastructure, testing, testnet, day-1-2
**Parent**: [EPIC] Deploy Backend Infrastructure to Akash (Testnet → Mainnet)
**Estimate**: 1 day

## Objective

Verify all deployed services are functioning correctly and communicating with each other.

## Acceptance Criteria

### YugabyteDB Cluster

- [ ] All 3 nodes showing "ALIVE" in Admin UI
- [ ] Replication factor confirmed as 3
- [ ] 0 under-replicated tablets
- [ ] Tablet distribution even (~33% per node)
- [ ] Admin UI accessible and showing metrics

### GraphQL API

- [ ] API responds to health check queries
- [ ] GraphQL playground accessible (if enabled)
- [ ] Database connection working (no connection errors in logs)
- [ ] WebSocket server running
- [ ] No startup errors in logs

### IPFS Gateway

- [ ] IPFS daemon running
- [ ] Gateway accessible via HTTP
- [ ] Test file retrieved successfully
- [ ] Peer connections established

### Usage Buffer

- [ ] Test script runs successfully against testnet
- [ ] All 10 tests passing
- [ ] Average latency acceptable (< 10ms over network)
- [ ] No errors during atomic upsert operations

### Integration

- [ ] API can query YugabyteDB successfully
- [ ] Usage buffer can write to database
- [ ] All services accessible from each other
- [ ] No network connectivity issues

## Tasks

1. **Access YugabyteDB Admin UI**
   - Open http://<provider-ip>:<admin-port>
   - Navigate to Tables → YSQL → yugabyte → public
   - Verify all tables exist (User, Project, Site, etc.)
   - Screenshot cluster overview

2. **Test GraphQL API**

   ```bash
   curl -X POST http://<api-url>/graphql \
     -H 'Content-Type: application/json' \
     -d '{"query":"{ __typename }"}'
   ```

   - Expected: `{"data":{"__typename":"Query"}}`

3. **Test IPFS Gateway**

   ```bash
   curl http://<ipfs-gateway>/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG
   ```

   - Should return content

4. **Run usage buffer tests**
   - Update test script with testnet DATABASE_URL
   - Run: `npm run tsx test-usage-buffer.ts`
   - Log results in MAINNET_MIGRATION_CHECKLIST.md

5. **Check service logs**

   ```bash
   # API logs
   akash provider service-logs \
     --dseq $AKASH_DSEQ \
     --from testnet \
     --provider $AKASH_PROVIDER \
     --node https://rpc.sandbox-01.aksh.pw:443 \
     --service api \
     --tail 100
   ```

   - Look for errors or warnings
   - Verify database connection successful

6. **Update checklist**
   - Fill out Phase 2 section in MAINNET_MIGRATION_CHECKLIST.md
   - Document all endpoint URLs
   - Log any issues encountered

## Success Metrics

- All services passing health checks
- No critical errors in logs
- API response time < 200ms
- YugabyteDB cluster fully replicated
- Usage buffer tests passing

## Resources

- Monitoring Guide: TESTNET_MONITORING.md (sections 1-4)
- Admin UI Guide: ADMIN_UI_GUIDE.md
- Migration Checklist: MAINNET_MIGRATION_CHECKLIST.md (Phase 2)
