# Phase 4: High Availability Testing

**Project**: Decentralized Cloud Launch
**Type**: Task
**Priority**: Critical
**Labels**: infrastructure, testing, ha, day-3-4
**Parent**: [EPIC] Deploy Backend Infrastructure to Akash (Testnet → Mainnet)
**Estimate**: 1 day

## Objective

Validate system can handle node failures without data loss or significant downtime.

## Acceptance Criteria

- [ ] Cluster remains available during single node failure
- [ ] Zero data loss during failover
- [ ] Queries continue successfully during failure
- [ ] Failed node rejoins automatically after restart
- [ ] Cluster rebalances tablets automatically
- [ ] 0 under-replicated tablets after recovery
- [ ] No manual intervention required
- [ ] Failover time < 30 seconds

## Tasks

1. **Baseline Metrics**
   - Record current cluster state
   - Document tablet distribution
   - Note all nodes ALIVE
   - Screenshot Admin UI

2. **Simulate Node Failure**

   ```bash
   # Get shell access to yb-node-2
   akash provider lease-shell \
     --dseq $AKASH_DSEQ \
     --from testnet \
     --provider $AKASH_PROVIDER \
     --node https://rpc.sandbox-01.aksh.pw:443 \
     --service yb-node-2 \
     --stdin --tty -- /bin/bash

   # Kill PostgreSQL process
   pkill -9 postgres
   exit
   ```

3. **Monitor During Failure**
   - Watch Admin UI (refresh every 5 seconds)
   - Run continuous API queries
   - Check for errors
   - Time how long until failover completes

4. **Verify Cluster Health**
   - Check remaining 2 nodes still ALIVE
   - Verify queries still working
   - Check for under-replicated tablets
   - Monitor automatic rebalancing

5. **Wait for Auto-Recovery**
   - Akash will automatically restart the container
   - Wait ~30-60 seconds
   - Check Admin UI for node rejoin
   - Verify 3/3 nodes ALIVE again

6. **Post-Recovery Validation**
   - Run data integrity check
   - Verify all tablets balanced
   - Check 0 under-replicated tablets
   - Run usage buffer tests
   - Confirm no data loss

7. **API Restart Test**
   - Restart API container
   - Verify reconnects to database
   - Check < 30 second downtime
   - No errors in logs

8. **Document Results**
   - Fill out Phase 4 in checklist
   - Record failover time
   - Log any issues
   - Note recovery behavior

## Success Metrics

- Failover time < 30 seconds
- Zero data loss
- Zero manual intervention
- Cluster self-heals
- All tests pass post-recovery

## Resources

- Monitoring Guide: TESTNET_MONITORING.md (HA Testing section)
- Migration Checklist: MAINNET_MIGRATION_CHECKLIST.md (Phase 4)
- Admin UI Guide: ADMIN_UI_GUIDE.md
