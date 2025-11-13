# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- LICENSE file (GNU GPLv3)
- SECURITY.md with vulnerability disclosure policy
- PRIVACY.md documenting data handling practices
- CODE_OF_CONDUCT.md (Contributor Covenant 2.1)
- CONTRIBUTING.md with contribution guidelines
- GitHub issue templates (bug report, feature request)
- GitHub pull request template
- .dockerignore file for optimized Docker builds
- Dependabot configuration for automated dependency updates
- Secrets scanning in CI workflow (TruffleHog)
- npm audit checks in CI for critical vulnerabilities
- GOVERNANCE.md for project governance (pending)

### Changed

- Dockerfile converted to multi-stage build for improved security and smaller images
- Package.json: Added dependency overrides to mitigate transitive vulnerabilities
- CI workflow: Added security job with secrets scanning and vulnerability checks

### Security

- Reduced npm vulnerabilities from 13 (1 critical, 9 high) to 6 (0 critical, 3 high)
- Added npm overrides for axios, elliptic, secp256k1, and parse-duration
- Implemented secrets scanning in CI/CD pipeline

## [0.1.0] - 2024-XX-XX

### Added

- Initial release of Alternate Futures Service Cloud API
- GraphQL API with GraphQL Yoga 5
- Multi-storage support (IPFS, Arweave, Filecoin)
- Custom domain management with DNS verification
- Automatic SSL/TLS provisioning and renewal (Let's Encrypt)
- Web3 domain integration (ArNS, ENS, IPNS)
- Usage-based billing with Stripe integration
- Invoice generation with branded PDFs
- Personal Access Token (PAT) management
- Native routing/proxy system
- Real-time chat via WebSockets
- Agent-based chat system
- Redis-based usage buffering (97% cost reduction)
- Background job scheduling (node-cron)
- Cryptocurrency payment support
- Multi-tenant support (projects, sites)
- Deployment versioning
- Storage snapshots and analytics
- Subscription management
- PostgreSQL database with Prisma ORM
- Comprehensive test suite (223 test files with Vitest)
- TypeScript with strict mode
- Docker support with Alpine-based images
- Akash Network deployment configuration
- Railway deployment support
- CI/CD with GitHub Actions
  - Automated testing
  - TypeScript type checking
  - CodeQL security scanning
  - Branch name validation
  - Claude Code review integration
- Authentication & Authorization
  - JWT-based authentication via auth service
  - Wallet-based authentication for Web3
  - PAT system with rate limiting (50/day, max 500 active)
  - Service-to-service JWT authentication

### Documentation

- README.md with quick start guide
- DEPLOYMENT_GUIDE.md
- AKASH_DEPLOYMENT.md
- OPENREGISTRY_DEPLOYMENT.md
- DECENTRALIZED_REGISTRY_ARCHITECTURE.md
- CODEGEN.md for GraphQL type generation
- AUTH_SERVICE_MIGRATION.md
- .github/SETUP.md for CI/CD configuration
- docs/route-configuration.md
- docs/runtime-routing-implementation.md
- docs/runtime-integration.md

---

## Release Types

### Added

New features, capabilities, or functionality.

### Changed

Changes to existing functionality or behavior.

### Deprecated

Features that will be removed in upcoming releases.

### Removed

Features or functionality that have been removed.

### Fixed

Bug fixes and error corrections.

### Security

Security vulnerability fixes and improvements.

---

## How to Update This File

When making changes:

1. Add entry under `[Unreleased]` section
2. Use appropriate category (Added, Changed, Fixed, etc.)
3. Write clear, user-focused descriptions
4. Reference issue/PR numbers where applicable
5. On release, move unreleased changes to new version section

Example:

```markdown
### Added

- Support for decentralized storage via Storj (#123)

### Fixed

- Resolved authentication token expiration issue (#456)

### Security

- Updated axios to fix CSRF vulnerability (CVE-2023-XXXXX)
```

---

[Unreleased]: https://github.com/alternatefutures/alternatefutures-backend/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/alternatefutures/alternatefutures-backend/releases/tag/v0.1.0
