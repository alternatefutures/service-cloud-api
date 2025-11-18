# TODO - Service Cloud API

## High Priority

### Restore 5-Minute Bid Wait Time in Akash Deployment Workflow

**Status**: Pending
**Priority**: Medium
**Created**: 2025-01-18

#### Context

The Akash deployment workflow currently has a **30-second wait time** for provider bids, which was temporarily reduced for faster development iterations.

#### Task

Restore the bid wait time to **5 minutes** (30 attempts × 10 seconds) in the production deployment workflow.

#### File to Update

`.github/workflows/deploy-akash.yml` - Lines 220-232

#### Changes Needed

```yaml
# Current (temporary):
echo "Waiting for provider bids (max 30 seconds - TEMPORARY)..."
for i in {1..6}; do
  sleep 5
done

# Should be (production):
echo "Waiting for provider bids (max 5 minutes)..."
for i in {1..30}; do
  sleep 10
done
```

#### Why This Matters

- Providers may take longer than 30 seconds to submit bids in production
- Insufficient wait time could result in missing better bids or deployment failures
- 5 minutes is the industry standard for Akash deployments

#### When to Do This

After development stabilizes and before going to full production.

---

## Other Tasks

### Fix DNS Sync - Akash CLI Command Incompatibility

**Status**: In Progress
**Priority**: High

The DNS sync uses provider API queries which may need additional work for full automation.

### Add OpenProvider Credentials to GitHub Secrets

**Status**: Pending
**Priority**: Medium

Required for automated DNS updates after deployments.

### Run Cleanup Workflow to Close Old Deployments

**Status**: Pending
**Priority**: Low

Close 6-7 old deployments to recover AKT deposits (~3 AKT).
