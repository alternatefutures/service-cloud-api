# How to Create Linear Tickets

All ticket descriptions are ready in `.linear/tickets/` directory.

## Quick Summary

**Project**: Decentralized Cloud Launch
**Total Tickets**: 9 (1 Epic + 8 Phase Tasks)
**Timeline**: 2-3 weeks
**Target Uptime**: 99.99%

## Ticket Structure

```
📊 EPIC: Deploy Backend Infrastructure to Akash (Testnet → Mainnet)
  ├── Phase 1: Testnet Deployment Setup (1 day)
  ├── Phase 2: Service Verification & Initial Testing (1 day)
  ├── Phase 3: Performance Testing & Benchmarking (1-2 days)
  ├── Phase 4: High Availability Testing (1 day)
  ├── Phase 5: 72-Hour Stability Testing (3 days)
  ├── Phase 6: Migration Decision & Mainnet Prep (1-2 days)
  ├── Phase 7: Mainnet Deployment (1 day)
  └── Phase 8: Post-Mainnet Monitoring & Validation (1 week)
```

## Step-by-Step Creation in Linear

### 1. Create the Epic First

1. Open Linear: https://linear.app/alternatefutures/team/ALT/new
2. Select **Project**: "Decentralized Cloud Launch"
3. **Type**: Epic
4. **Title**: `Deploy Backend Infrastructure to Akash (Testnet → Mainnet)`
5. **Description**: Copy from `tickets/EPIC-testnet-to-mainnet.md`
6. **Priority**: High
7. **Labels**: infrastructure, deployment, depin, epic
8. **Estimate**: 2-3 weeks
9. Click **Create**
10. **Save the Epic ID** (e.g., ALT-XXX)

### 2. Create Phase Tasks (in order)

For each phase (PHASE1 through PHASE8):

1. Click **New Issue** (or press `C`)
2. **Project**: Decentralized Cloud Launch
3. **Type**: Task
4. **Title**: Copy from ticket file (e.g., "Phase 1: Testnet Deployment Setup")
5. **Description**: Copy entire markdown from ticket file
6. **Priority**: High (Critical for Phases 4-7)
7. **Labels**: Copy from ticket (e.g., infrastructure, deployment, testnet, day-1)
8. **Parent**: Select the Epic created in step 1
9. **Estimate**: Copy from ticket
10. Click **Create**

### 3. Label Guide

Use these labels consistently:

- `infrastructure` - All tickets
- `deployment` - Deployment-related tasks
- `testing` - Test phases
- `depin` - DePIN infrastructure
- `testnet` - Testnet-specific (Phases 1-6)
- `mainnet` - Mainnet-specific (Phases 7-8)
- `production` - Phase 7 only
- `monitoring` - Phase 8
- `day-X` - Day markers (day-1, day-1-2, etc.)

### 4. Priority Levels

- **High**: Phases 1, 2, 3, 8
- **Critical**: Phases 4, 5, 6, 7

### 5. Estimates

- Phase 1: 1 day
- Phase 2: 1 day
- Phase 3: 1-2 days
- Phase 4: 1 day
- Phase 5: 3 days
- Phase 6: 1-2 days
- Phase 7: 1 day
- Phase 8: 1 week
- **Total**: 2-3 weeks

## Ticket Files Reference

```
.linear/tickets/
├── EPIC-testnet-to-mainnet.md        # Create FIRST
├── PHASE1-testnet-deployment.md      # Then create in order
├── PHASE2-service-verification.md
├── PHASE3-performance-testing.md
├── PHASE4-ha-testing.md
├── PHASE5-stability-testing.md
├── PHASE6-migration-decision.md
├── PHASE7-mainnet-deployment.md
└── PHASE8-post-mainnet-monitoring.md
```

## Tips

1. **Create Epic first** - You'll need the Epic ID for child tasks
2. **Copy-paste descriptions** - Don't retype, just copy the markdown
3. **Link tasks** - Each phase depends on the previous one
4. **Use templates** - Save the first ticket as a template for consistency
5. **Update as you go** - Check off acceptance criteria as you complete them

## After Creation

1. **Set Epic status** to "Backlog" or "Todo"
2. **Set Phase 1 status** to "Todo" (ready to start)
3. **Set other phases** to "Backlog"
4. **Assign** tickets to yourself
5. **Add to project view** in Linear

## Quick Links

- **Create Issue**: https://linear.app/alternatefutures/team/ALT/new
- **Project Board**: https://linear.app/alternatefutures/project/decentralized-cloud-launch
- **Tickets Directory**: `.linear/tickets/`

---

**Ready to create?** Open Linear and start with the Epic!
