# GitHub Actions Setup

This repository uses GitHub Actions for continuous integration and automated code reviews.

## Required GitHub Secrets

To enable all workflows, configure the following secrets in your repository settings:

### Navigation
Go to: **Repository Settings** → **Secrets and variables** → **Actions** → **New repository secret**

### Required Secrets

#### `ANTHROPIC_API_KEY`
**Purpose:** Enables Claude Code Review on pull requests

**How to get:**
1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Navigate to API Keys
3. Create a new API key
4. Copy the key and add it as a secret

**Workflow:** `.github/workflows/claude-code-review.yml`

---

## Workflows

### 1. CI (Continuous Integration)
**File:** `.github/workflows/ci.yml`

**Triggers:**
- Pull requests to `main`, `staging`, or `develop`
- Pushes to `main`, `staging`, or `develop`

**Jobs:**
- **Test** - Runs test suite with PostgreSQL and Redis
- **Lint** - Type checking with TypeScript
- **Build** - Verifies code compiles successfully

**Services:**
- PostgreSQL 15
- Redis (Alpine)

**No secrets required** - runs with default `GITHUB_TOKEN`

---

### 2. Claude Code Review
**File:** `.github/workflows/claude-code-review.yml`

**Triggers:**
- Pull requests opened, synchronized, or reopened on `main`, `staging`, or `develop`

**What it does:**
- Reviews code changes using Claude Sonnet 4.5
- Posts review comments directly on the PR
- Identifies potential issues, bugs, and improvements
- Suggests code optimizations

**Required secrets:**
- `ANTHROPIC_API_KEY`
- `GITHUB_TOKEN` (automatically provided)

---

## Branch Strategy & Workflow

### Protected Branches
- **`main`** - Production (protected)
- **`staging`** - Pre-production testing
- **`develop`** - Active development

### Branch Naming Convention

All branches should be named based on your Linear ticket:

**Feature Branches:**
- Format: `feature/ALT-123-description` or `feat/alt-123-description`
- Merge target: `develop`
- Example: `feature/ALT-456-add-webhook-support` or `feat/alt-456-add-webhook-support`

**Bug Fixes:**
- Format: `fix/ALT-789-description` or `fix/alt-789-description`
- Merge target: `staging` (can merge directly)
- Example: `fix/ALT-123-auth-token-expiry`

**Hotfixes:**
- Format: `hotfix/ALT-999-description` or `hotfix/alt-999-description`
- Merge target: `main` (emergency only)
- Example: `hotfix/ALT-234-security-patch`

### Workflow
1. **Feature development:**
   - Create branch from `develop`: `feature/ALT-XXX-name` or `feat/alt-xxx-name`
   - Open PR to `develop`
   - CI and Claude review run automatically
   - Merge to `develop` after approval

2. **Bug fixes:**
   - Create branch from `staging`: `fix/ALT-XXX-name` or `fix/alt-xxx-name`
   - Open PR to `staging`
   - CI and Claude review run automatically
   - Merge to `staging` after approval

3. **Releases:**
   - `develop` → `staging` (for testing)
   - `staging` → `main` (for production)

---

## Verify Setup

After adding secrets, you can verify the setup by:

1. Creating a new feature branch: `feature/ALT-123-test` or `feat/alt-123-test`
2. Making a small change
3. Opening a pull request to `develop`

You should see:
- ✅ CI workflow running tests
- ✅ Claude Code Review analyzing changes
- 📝 Review comments posted on your PR

---

## Branch Protection Rules

To enforce branch naming conventions and workflow rules, configure branch protection in GitHub.

### Setting Up Protection Rules

**Navigate to:**
Repository Settings → Rules → Rulesets → **New ruleset**

### Recommended Rules for `main`

**Protection Settings:**
- ✅ Require pull request before merging
- ✅ Require approvals: **1**
- ✅ Require status checks to pass before merging
  - `test` (CI)
  - `lint` (CI)
  - `build` (CI)
  - `check-branch-name` (Branch Name Check)
  - `check-pr-title` (Branch Name Check)
- ✅ Require conversation resolution before merging
- ✅ Require linear history
- ✅ Do not allow bypassing the above settings

**Restrict who can push:**
- Only allow admins to push directly (no one else)

---

### Recommended Rules for `staging`

**Protection Settings:**
- ✅ Require pull request before merging
- ✅ Require approvals: **1**
- ✅ Require status checks to pass before merging
  - `test` (CI)
  - `lint` (CI)
  - `build` (CI)
  - `check-branch-name` (Branch Name Check)
- ✅ Do not allow bypassing the above settings

**Allowed merge sources:**
- `develop` (features)
- `fix/*` branches (bug fixes)

---

### Recommended Rules for `develop`

**Protection Settings:**
- ✅ Require pull request before merging
- ✅ Require status checks to pass before merging
  - `test` (CI)
  - `check-branch-name` (Branch Name Check)

**Allowed merge sources:**
- `feature/*` branches only

---

### Automated Enforcement

The repository includes automated checks that run on every PR:

**Branch Name Validation:**
- ✅ Validates branch names match pattern: `feature/ALT-###-description` or `feat/alt-###-description`
- ✅ Enforces lowercase and hyphens only in description
- ✅ Requires Linear ticket number (ALT-### or alt-###, case-insensitive)
- ❌ Fails CI if branch name is invalid

**PR Title Validation:**
- ✅ Requires Linear ticket number in PR title
- ✅ Accepts formats: `ALT-123: Description` or `[ALT-123] Description`
- ❌ Fails CI if ticket number is missing

These checks run automatically via `.github/workflows/branch-name-check.yml`

---

## Troubleshooting

### Claude Code Review not running
- Verify `ANTHROPIC_API_KEY` is set in repository secrets
- Check workflow file permissions (needs `pull-requests: write`)
- Ensure API key has sufficient credits

### Tests failing
- Check PostgreSQL/Redis service health
- Verify database migrations are up to date
- Review test environment variables in `ci.yml`

### Build errors
- Ensure Node.js version matches (20.x)
- Clear npm cache if dependencies are stale
- Check TypeScript compilation errors

### Branch name check failing
**Invalid branch name format:**
- Branch must start with `feature/`, `feat/`, `fix/`, or `hotfix/`
- Must include Linear ticket: `ALT-###` or `alt-###` (case-insensitive)
- Description must use lowercase and hyphens
- Example: `feature/ALT-123-add-new-feature` or `feat/alt-123-add-new-feature`

**PR title check failing:**
- PR title must include Linear ticket number
- Format: `ALT-123: Description` or `[ALT-123] Description`
- The ticket number must match your branch name
