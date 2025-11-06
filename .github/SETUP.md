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
- **Automated Review:** Pull requests opened, synchronized, or reopened on `main`, `staging`, or `develop`
- **Interactive Review:** Comments containing `@claude` on PRs or issues

**What it does:**

#### Automated Reviews (on PR open/update)
- Automatically reviews code changes using Claude Sonnet 4.5
- Analyzes code quality, security, performance, testing, and documentation
- Posts comprehensive review comments directly on the PR
- Identifies potential issues, bugs, and improvements
- Suggests code optimizations and best practices
- Verifies TypeScript typing and type safety

#### Interactive Reviews (via @claude mentions)
- Responds to `@claude` mentions in PR comments
- Answers questions about the codebase
- Provides explanations for specific code sections
- Helps with debugging and troubleshooting
- Can suggest alternative implementations
- Supports back-and-forth conversations (up to 10 turns)

**How to use @claude:**

Comment on any PR or issue with:
```
@claude can you explain how the authentication works in this PR?
```

```
@claude please review the database schema changes for potential issues
```

```
@claude can you suggest a better way to handle error cases here?
```

**Required secrets:**
- `ANTHROPIC_API_KEY`
- `GITHUB_TOKEN` (automatically provided)

**Features:**
- ✅ Automatic code review on every PR
- ✅ Interactive AI assistance via @claude
- ✅ Progress tracking with status updates
- ✅ Multi-turn conversations (up to 10 for interactive, 5 for automated)
- ✅ Context-aware analysis of full PR changes

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

### Testing Automated Review

1. Creating a new feature branch: `feature/ALT-123-test` or `feat/alt-123-test`
2. Making a small change (e.g., add a new function or update a file)
3. Opening a pull request to `develop`

You should see:
- ✅ CI workflow running tests
- ✅ Claude Code Review workflow triggered (check Actions tab)
- ✅ "Automated AI Code Review" job running
- 📝 Automated review comments posted on your PR within 2-5 minutes
- 📊 Review covering code quality, security, performance, testing, and documentation

### Testing Interactive Review

1. Open any existing PR or the test PR from above
2. Add a comment: `@claude can you review this change?`
3. Wait 30-60 seconds

You should see:
- ✅ "Interactive Claude Assistant" workflow triggered
- 🤖 Claude responds to your comment
- 💬 Ability to continue the conversation by replying with more `@claude` mentions

### Verification Checklist

- [ ] `ANTHROPIC_API_KEY` is added to repository secrets
- [ ] Automated review runs when PR is opened
- [ ] Interactive `@claude` mentions get responses
- [ ] Review comments are helpful and relevant
- [ ] No permission errors in GitHub Actions logs

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

**For Automated Reviews:**
- Verify `ANTHROPIC_API_KEY` is set in repository secrets
- Check workflow file permissions (needs `contents: write`, `pull-requests: write`, `issues: write`)
- Ensure API key has sufficient credits in [Anthropic Console](https://console.anthropic.com/)
- Verify PR is targeting `main`, `staging`, or `develop` branch
- Check GitHub Actions logs for error messages

**For Interactive @claude Reviews:**
- Ensure you're using `@claude` (not `@Claude` or other variations)
- Verify the comment is on a PR or issue (not a commit comment)
- Check that the workflow has been triggered in Actions tab
- Review permissions: action needs `id-token: write` and `actions: read`

**Common Issues:**
- **Rate limiting:** If you see API rate limit errors, wait a few minutes before trying again
- **Permission errors:** Ensure all required permissions are granted in the workflow file
- **No response:** Check if the workflow was triggered in the Actions tab
- **API key invalid:** Generate a new key from [Anthropic Console](https://console.anthropic.com/)

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
