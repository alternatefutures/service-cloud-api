# Branch Protection Setup Guide

## Overview

This guide configures `main` branch protection to ensure **all tests pass before merging**, then **auto-deploy to production** on merge.

## CI/CD Pipeline Flow

```
Developer creates PR
  ↓
CI Workflow runs automatically:
  ├── Run Tests (PostgreSQL, Redis)
  ├── Lint & Type Check
  ├── Build Verification
  └── Security Scans
  ↓
All checks MUST pass ✅
  ↓
Code review required (1+ approvals)
  ↓
Merge to main
  ↓
Auto-deploy to Akash production 🚀
```

## Step 1: Configure Branch Protection

### Navigate to Branch Protection Settings

1. Go to your repository on GitHub
2. Click **Settings** (top right)
3. Click **Branches** (left sidebar)
4. Click **Add branch protection rule**

### Configure Rule for `main` Branch

#### Branch name pattern
```
main
```

#### Enable These Settings:

##### ✅ Require a pull request before merging
- [x] **Require approvals**: `1`
  - At least one team member must review and approve
- [x] **Dismiss stale pull request approvals when new commits are pushed**
  - Forces re-review after changes
- [ ] Require review from Code Owners (optional - enable if you have CODEOWNERS file)

##### ✅ Require status checks to pass before merging
- [x] **Require branches to be up to date before merging**
  - Ensures no merge conflicts

**Required status checks** (check all of these):
- [x] `test / Run Tests`
- [x] `lint / Lint & Type Check`
- [x] `build / Build Check`
- [x] `security / Security Checks`

**How to find status check names**:
1. Create a test PR
2. Wait for CI to run
3. Come back to branch protection settings
4. The status checks will now appear in the search box

##### ✅ Require conversation resolution before merging
- [x] All PR comments must be resolved

##### ✅ Require linear history
- [x] Enforce squash or rebase merges (no merge commits)

##### ✅ Do not allow bypassing the above settings
- [x] Enforced for administrators too
- [ ] Allow specified actors to bypass (leave empty for full enforcement)

##### ✅ Restrict who can push to matching branches
- [x] Restrict pushes that create matching branches
- **Allowed to push**: Select maintainers/admins only
  - This prevents direct pushes to `main`
  - All changes must go through PRs

##### ✅ Require deployments to succeed before merging (Optional)
- [ ] Leave unchecked (deployment happens after merge)

##### ⚠️ Lock branch (Don't enable - too restrictive)
- [ ] Leave unchecked

### Step 2: Save Protection Rule

Click **Create** or **Save changes** at the bottom

## Step 2: Verify CI Configuration

Your CI workflow is already configured! It runs on:
- ✅ Pull requests to `main`
- ✅ Pushes to `main` (after merge)

### CI Jobs Breakdown:

#### 1. **Test Job** (`test / Run Tests`)
- Spins up PostgreSQL (port 5432)
- Spins up Redis (port 6379)
- Runs database migrations
- Executes test suite
- **Blocks merge if**: Tests fail

#### 2. **Lint Job** (`lint / Lint & Type Check`)
- Runs type checking
- Builds TypeScript code
- **Blocks merge if**: Type errors exist

#### 3. **Build Job** (`build / Build Check`)
- Verifies code compiles
- Checks build artifacts
- **Blocks merge if**: Build fails

#### 4. **Security Job** (`security / Security Checks`)
- Scans for secrets in code (TruffleHog)
- Checks for vulnerabilities (npm audit)
- **Blocks merge if**: Critical vulnerabilities found

## Step 3: Test the Protection

### Create a Test PR

```bash
# Create a feature branch
git checkout -b test/branch-protection

# Make a small change
echo "# Test" >> README.md

# Commit and push
git add README.md
git commit -m "test: Verify branch protection"
git push origin test/branch-protection
```

### Create PR on GitHub

1. Go to your repository
2. Click **Pull requests** → **New pull request**
3. Base: `main` ← Compare: `test/branch-protection`
4. Click **Create pull request**

### Observe Protection in Action

You should see:
1. ⏳ **CI checks running** (yellow dot)
   - test / Run Tests
   - lint / Lint & Type Check
   - build / Build Check
   - security / Security Checks

2. 🚫 **Merge blocked** until:
   - All 4 checks pass ✅
   - At least 1 approval ✅

3. ✅ **Merge enabled** when conditions met

4. 🚀 **Auto-deploy** triggers after merge

## Step 4: Configure Deploy Workflow Dependencies

Ensure deployment only runs AFTER CI passes:

Your current `deploy-akash.yml` triggers on:
```yaml
on:
  push:
    branches:
      - main
    paths:
      - 'deploy-mainnet.yaml'
      - '.github/workflows/deploy-akash.yml'
```

**This is correct!** Deployment happens after merge, which means:
1. PR created → CI runs
2. CI must pass → Merge enabled
3. Merge to main → Deployment runs

## Workflow Status Badges (Optional)

Add badges to your README.md:

```markdown
[![CI](https://github.com/YOUR_ORG/YOUR_REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_ORG/YOUR_REPO/actions/workflows/ci.yml)
[![Deploy](https://github.com/YOUR_ORG/YOUR_REPO/actions/workflows/deploy-akash.yml/badge.svg)](https://github.com/YOUR_ORG/YOUR_REPO/actions/workflows/deploy-akash.yml)
```

Replace `YOUR_ORG` and `YOUR_REPO` with actual values.

## Common Scenarios

### Scenario 1: PR with Failing Tests

```
Developer creates PR
  ↓
CI runs → Tests fail ❌
  ↓
Merge button is DISABLED
  ↓
Developer fixes tests
  ↓
Pushes new commit
  ↓
CI runs again → Tests pass ✅
  ↓
Merge button ENABLED
```

### Scenario 2: Emergency Hotfix

**Option A: Follow normal process** (Recommended)
```bash
git checkout -b hotfix/critical-bug
# Fix the bug
git commit -m "fix: Critical production bug"
git push origin hotfix/critical-bug
# Create PR, CI runs, get approval, merge
```

**Option B: Bypass protection** (If configured)
1. Admin can force-merge if bypass is enabled
2. **NOT RECOMMENDED** - breaks safety guarantees

### Scenario 3: CI False Positive

If CI fails incorrectly:
1. Check workflow logs in Actions tab
2. Re-run failed jobs (sometimes network issues)
3. If persistent, fix CI configuration
4. **Never** bypass protection to ignore CI failures

## Monitoring

### Check CI Status

```bash
# View recent workflow runs
gh run list --workflow=ci.yml --limit 10

# Watch specific run
gh run watch <RUN_ID>

# View logs
gh run view <RUN_ID> --log
```

### Check Branch Protection Status

```bash
# Via GitHub CLI
gh api repos/:owner/:repo/branches/main/protection

# Or check in GitHub UI:
# Settings → Branches → main (view rule)
```

## Troubleshooting

### Problem: Can't enable required status checks

**Solution**:
1. Create and merge at least one PR first
2. Status checks appear after first CI run
3. Come back to branch protection settings
4. Status checks now available in dropdown

### Problem: Merge button still enabled despite failures

**Check**:
1. Branch protection rule is saved
2. Status checks are marked as required
3. Rule applies to correct branch (`main`)

### Problem: Accidentally merged without approval

**Prevention**:
- Enable "Require approvals" setting
- Set to at least 1 reviewer
- Enable "Do not allow bypassing" for admins

**Recovery**:
- Revert the merge commit
- Close and redeploy previous version

### Problem: CI takes too long

**Optimizations**:
1. Cache npm dependencies (already configured)
2. Run jobs in parallel (already configured)
3. Skip redundant checks on minor changes
4. Optimize test suite performance

## Best Practices

### ✅ DO:
- Always create PRs for changes
- Wait for CI to complete
- Get meaningful code reviews
- Keep CI fast (< 5 minutes ideal)
- Fix broken CI immediately
- Keep `main` always deployable

### ❌ DON'T:
- Push directly to `main`
- Bypass protection rules
- Merge with failing CI
- Approve without reviewing code
- Ignore CI failures
- Merge on Fridays (only half joking!)

## Next Steps

After configuring branch protection:

1. ✅ Create production environment in GitHub
2. ✅ Add GitHub Secrets (AKASH_MNEMONIC, etc.)
3. ✅ Test with a real PR
4. ✅ Monitor first production deployment
5. ✅ Set up monitoring/alerting
6. ✅ Document deployment runbook

## Summary

With this setup:
- **No code reaches production without**:
  - ✅ Passing all tests
  - ✅ Passing lint/type checks
  - ✅ Successful build
  - ✅ No critical security issues
  - ✅ At least one code review

- **Production deployments are**:
  - 🔒 Safe (tests required)
  - 🤖 Automated (no manual steps)
  - 📊 Auditable (full history)
  - ⚡ Fast (on every merge)

This gives you **confidence to deploy multiple times per day** while maintaining high quality and security standards.
