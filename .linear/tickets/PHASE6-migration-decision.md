# Phase 6: Migration Decision & Mainnet Preparation

**Project**: Decentralized Cloud Launch
**Type**: Task
**Priority**: Critical
**Labels**: infrastructure, deployment, decision, day-7-8
**Parent**: [EPIC] Deploy Backend Infrastructure to Akash (Testnet → Mainnet)
**Estimate**: 1-2 days

## Objective

Review all test results, make go/no-go decision for mainnet, and prepare mainnet deployment configuration.

## Acceptance Criteria

### Decision Criteria Review

- [ ] All critical criteria met (7/7)
- [ ] 80%+ high priority criteria met
- [ ] MAINNET_MIGRATION_CHECKLIST.md complete
- [ ] Go/No-Go decision documented
- [ ] Sign-off recorded

### Mainnet Preparation

- [ ] Mainnet AKT tokens purchased (amount: \_\_\_ AKT)
- [ ] Production secrets generated and secured
- [ ] deploy.yaml updated with mainnet config
- [ ] DNS records prepared (not yet pointing)
- [ ] Backup strategy documented
- [ ] Rollback procedure tested

## Tasks

1. **Review Test Results**
   - Open MAINNET_MIGRATION_CHECKLIST.md
   - Verify all phases complete
   - Check all boxes
   - Calculate pass rate

2. **Critical Criteria Check**
   Count how many pass:
   - [ ] 72+ hours uptime
   - [ ] All YB nodes consistently ALIVE
   - [ ] 0 under-replicated tablets 48+ hours
   - [ ] HA test passed
   - [ ] Zero data corruption/loss
   - [ ] API error rate < 0.1%
   - [ ] Performance benchmarks met

   **Result: \_\_\_/7 Critical** (need 7/7 to proceed)

3. **High Priority Criteria Check**
   Count how many pass:
   - [ ] API P95 < 100ms
   - [ ] YB P99 read < 10ms
   - [ ] YB P99 write < 20ms
   - [ ] CPU < 70%
   - [ ] Memory < 80%
   - [ ] Load test 100+ users
   - [ ] Documentation complete

   **Result: \_\_\_/7 High Priority** (need 5/7 to proceed)

4. **Make Decision**
   - If 7/7 Critical AND 5+/7 High Priority: ✅ **PROCEED**
   - If not: ❌ **EXTEND TESTNET** or ⚠️ **HALT**

5. **Document Decision**
   - Fill out "Migration Decision" section in checklist
   - Write rationale
   - Sign off
   - Set mainnet deployment date

**If PROCEED:**

6. **Purchase Mainnet AKT**
   - Estimate cost: ~100-150 AKT ($500-750)
   - Buy from exchange (Coinbase, Kraken, etc.)
   - Transfer to mainnet wallet
   - Verify balance

7. **Generate Production Secrets**

   ```bash
   # YugabyteDB password (32+ chars)
   openssl rand -base64 32

   # JWT secret (64+ chars)
   openssl rand -base64 64
   ```

   - Store securely (password manager)

8. **Update deploy.yaml**
   - Copy deploy-testnet.yaml to deploy.yaml
   - Update resource allocations (increase from testnet)
   - Update domain names (remove -test)
   - Update secrets (use production values)
   - Review pricing (increase bids for mainnet)

9. **Prepare DNS**
   - Create A records (don't point yet):
     - api.alternatefutures.ai
     - yb.alternatefutures.ai
     - ipfs.alternatefutures.ai
   - Will point after successful deployment

10. **Final Review**
    - Review deploy.yaml line by line
    - Verify all secrets set
    - Double-check domain names
    - Confirm resource allocations
    - Review backup plan

## Resources

- Migration Checklist: MAINNET_MIGRATION_CHECKLIST.md
- Monitoring Guide: TESTNET_MONITORING.md
- Mainnet Deployment: deploy.yaml

## Success Metrics

- Clear go/no-go decision made
- All preparation complete
- Mainnet config reviewed and approved
- Team aligned on timeline
