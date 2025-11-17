# Deployment Strategy: Branches & Tags

## Branch Strategy

### Production Branches

```
main (production)
  ↓
  Automatically deploys to Akash mainnet
  Protected branch with strict rules

develop (staging)
  ↓
  Deploys to Akash testnet (when available)
  Integration branch for features

feature/* (development)
  ↓
  For active development
  No automatic deployment
```

### Branch Rules

#### `main` Branch (Production)
**Purpose**: Production-ready code only

**Protection Rules** (Settings → Branches → Add rule):
- ✅ **Require pull request before merging**
  - Require approvals: 1+ reviewers
  - Dismiss stale reviews when new commits are pushed
  - Require review from Code Owners

- ✅ **Require status checks to pass**
  - ✅ Build must pass
  - ✅ Tests must pass
  - ✅ Linting must pass
  - ✅ Security scan must pass

- ✅ **Require branches to be up to date**
  - Ensures no merge conflicts

- ✅ **Do not allow bypassing the above settings**
  - Even admins must follow rules

- ✅ **Restrict who can push**
  - Only maintainers can merge

- ✅ **Require linear history**
  - Use squash or rebase (no merge commits)

#### `develop` Branch (Staging)
**Purpose**: Integration testing before production

**Protection Rules**:
- ✅ Require pull request
- ✅ Require status checks
- ⚠️ Allow force pushes (for rebasing)

#### `feature/*` Branches
**Purpose**: Active development work

**Naming Convention**:
- `feature/add-authentication`
- `feature/fix-database-connection`
- `feature/improve-api-performance`

**No protection rules** - developers work freely

## Tag Strategy (Semantic Versioning)

### Version Format: `vMAJOR.MINOR.PATCH`

```
v1.0.0 → First production release
v1.1.0 → New feature (backward compatible)
v1.1.1 → Bug fix (backward compatible)
v2.0.0 → Breaking change
```

### Pre-release Tags

```
v1.0.0-alpha.1  → Early testing
v1.0.0-beta.1   → Feature complete, testing
v1.0.0-rc.1     → Release candidate
v1.0.0          → Stable release
```

### Tag Rules

#### Production Tags (`v*`)
**Trigger**: Manual creation after successful deployment

**Process**:
1. Merge PR to `main`
2. Deployment completes successfully
3. Tag the commit:
   ```bash
   git tag -a v1.0.0 -m "Release v1.0.0: Initial production deployment"
   git push origin v1.0.0
   ```

#### Pre-release Tags (`v*-rc.*`, `v*-beta.*`)
**Trigger**: Testing milestones

**Purpose**: Track test deployments

## Deployment Triggers

### Option 1: Branch-Based (Current Setup)

```yaml
# Deploy on every push to main
on:
  push:
    branches:
      - main
```

**Pros**:
- Simple, automatic
- Continuous deployment
- Fast iteration

**Cons**:
- Every merge deploys immediately
- No rollback mechanism
- Higher risk

### Option 2: Tag-Based (Recommended for Production)

```yaml
# Deploy only on version tags
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'
```

**Pros**:
- Controlled releases
- Clear versioning
- Easy rollbacks (redeploy previous tag)
- Release notes tied to tags

**Cons**:
- Requires manual tagging
- Slower deployment cycle

### Option 3: Hybrid (Best of Both)

```yaml
# Auto-deploy main for continuous deployment
# Also support manual tag-based releases
on:
  push:
    branches:
      - main
    tags:
      - 'v*'
  workflow_dispatch:  # Manual trigger
```

**Best for**: Teams that want both speed and control

## Recommended Configuration for Production

### 1. Update Workflow Trigger

**For Conservative Approach (Tag-Based)**:
```yaml
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'  # Stable releases only
      - 'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+'  # Release candidates
  workflow_dispatch:  # Manual override
```

**For Aggressive Approach (Continuous Deployment)**:
```yaml
on:
  push:
    branches:
      - main
    paths:
      - 'deploy-mainnet.yaml'
      - 'src/**'
      - '.github/workflows/deploy-akash.yml'
  workflow_dispatch:
```

### 2. Branch Protection Configuration

Navigate to: **Settings → Branches → Add rule**

**Branch name pattern**: `main`

Enable:
- [x] Require a pull request before merging
  - Required approvals: 1
  - Dismiss stale reviews: ✓
- [x] Require status checks to pass before merging
  - [x] Require branches to be up to date before merging
  - Status checks: `build`, `test`, `lint`
- [x] Require conversation resolution before merging
- [x] Require signed commits (optional, for security)
- [x] Require linear history
- [x] Do not allow bypassing the above settings
- [x] Restrict who can push to matching branches

### 3. Tag Protection (GitHub Enterprise/Pro)

Navigate to: **Settings → Tags → Add rule**

**Tag name pattern**: `v*`

Enable:
- [x] Restrict who can create matching tags
  - Only: Maintainers, Admins

## Workflow Examples

### Example 1: Feature Development → Production

```bash
# 1. Create feature branch
git checkout -b feature/add-user-auth

# 2. Develop and commit
git commit -m "feat: Add user authentication"

# 3. Push feature branch
git push origin feature/add-user-auth

# 4. Create Pull Request
# GitHub UI: feature/add-user-auth → main

# 5. Code review + approval

# 6. Merge to main (triggers deployment)
# OR: Tag for release
git checkout main
git pull
git tag -a v1.1.0 -m "Release v1.1.0: Add user authentication"
git push origin v1.1.0
```

### Example 2: Hotfix for Production

```bash
# 1. Create hotfix branch from main
git checkout main
git checkout -b hotfix/fix-login-bug

# 2. Fix and commit
git commit -m "fix: Resolve login authentication bug"

# 3. Push and create PR
git push origin hotfix/fix-login-bug

# 4. Emergency review and merge

# 5. Tag hotfix release
git checkout main
git pull
git tag -a v1.0.1 -m "Hotfix v1.0.1: Fix login bug"
git push origin v1.0.1
```

### Example 3: Rolling Back

```bash
# Option 1: Revert commit
git revert <bad-commit-hash>
git push origin main  # Triggers new deployment

# Option 2: Redeploy previous tag
git checkout v1.0.0
# Manually trigger workflow with old tag

# Option 3: Close bad deployment, create new one
akash tx deployment close --dseq BAD_DSEQ ...
# Manually trigger workflow with good config
```

## Environment-Specific Rules

### Production Environment
- **Branch**: `main` only
- **Requires**: Approval from 1+ maintainers
- **Wait time**: 5 minutes (safety delay)
- **Notifications**: Slack/Email on deploy
- **Rollback**: Tag-based redeployment

### Staging Environment
- **Branch**: `develop` or `staging/*`
- **Requires**: No approval needed
- **Wait time**: None
- **Auto-deploy**: On every commit
- **Cost**: Use cheaper SDL config

## Commit Message Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: Add new feature
fix: Bug fix
docs: Documentation only
style: Code style changes (formatting)
refactor: Code refactoring
perf: Performance improvement
test: Add/update tests
chore: Maintenance tasks
ci: CI/CD changes
```

**Examples**:
```bash
git commit -m "feat(api): Add user authentication endpoint"
git commit -m "fix(db): Resolve connection timeout issue"
git commit -m "docs: Update deployment instructions"
git commit -m "ci: Add tag-based deployment trigger"
```

## Release Notes Automation

Use GitHub Releases with auto-generated notes:

```bash
# Create release from tag
gh release create v1.0.0 \
  --title "v1.0.0 - Initial Production Release" \
  --notes-file CHANGELOG.md \
  --generate-notes
```

## Best Practices Summary

✅ **DO**:
- Use semantic versioning for tags
- Protect `main` branch with strict rules
- Require PR reviews before merging
- Use conventional commit messages
- Tag stable releases
- Document breaking changes
- Test on staging before production
- Keep deployment configs in version control

❌ **DON'T**:
- Push directly to `main`
- Deploy untested code
- Use ambiguous version numbers
- Skip code reviews
- Force push to protected branches
- Deploy on Fridays (joke... but not really)

## Monitoring Deployments

### Track Deployment Success
```bash
# List all deployments
gh run list --workflow=deploy-akash.yml

# Watch specific run
gh run watch <run-id>

# Get deployment details
akash query deployment list \
  --owner YOUR_ADDRESS \
  --node https://rpc.akashnet.net:443
```

### Audit Trail
- GitHub Actions logs: All deployments logged
- Git tags: Version history
- Commit history: Who deployed what
- Environment logs: Runtime information

## Migration Path

**Current**: Branch-based (push to main)
**Goal**: Tag-based (controlled releases)

### Phase 1: Add Protection Rules
1. Enable branch protection on `main`
2. Require PR reviews
3. Require status checks

### Phase 2: Add Tagging
1. Create first tag: `v1.0.0`
2. Document tagging process
3. Train team on SemVer

### Phase 3: Switch Trigger
1. Update workflow to tag-based
2. Test with `v1.0.1-rc.1`
3. Monitor first production tag deploy

### Phase 4: Mature Process
1. Automate changelog generation
2. Add release notes
3. Implement staging environment
