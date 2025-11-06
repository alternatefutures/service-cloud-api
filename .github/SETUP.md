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

## Verify Setup

After adding secrets, you can verify the setup by:

1. Creating a new branch
2. Making a small change
3. Opening a pull request

You should see:
- ✅ CI workflow running tests
- ✅ Claude Code Review analyzing changes
- 📝 Review comments posted on your PR

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
