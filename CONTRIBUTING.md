# Contributing to Alternate Futures

Thank you for your interest in contributing to Alternate Futures! We're building a privacy-focused, censorship-resistant, open-source serverless platform, and we welcome contributions from the community.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Testing](#testing)
- [Code Style](#code-style)
- [Documentation](#documentation)
- [Community](#community)

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to conduct@alternatefutures.com.

## Getting Started

### Prerequisites

- **Node.js**: >= 20.18.0
- **PostgreSQL**: >= 15
- **Redis**: Latest stable
- **Docker**: (optional, for containerized development)
- **Git**: Latest stable

### First Contribution?

If you're new to open source, check out:

- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [First Timers Only](https://www.firsttimersonly.com/)

Look for issues labeled `good first issue` or `help wanted`.

## Development Setup

1. **Fork and Clone**:

   ```bash
   git fork https://github.com/alternatefutures/alternatefutures-backend
   git clone https://github.com/YOUR-USERNAME/alternatefutures-backend
   cd alternatefutures-backend
   ```

2. **Install Dependencies**:

   ```bash
   npm install
   ```

3. **Setup Environment**:

   ```bash
   cp .env.example .env
   # Edit .env with your local configuration
   ```

4. **Setup Database**:

   ```bash
   # Start PostgreSQL and Redis (or use Docker)
   npm run db:push      # Push schema to database
   npm run db:seed      # (Optional) Seed test data
   ```

5. **Generate Prisma Client**:

   ```bash
   npm run db:generate
   ```

6. **Generate GraphQL Types**:

   ```bash
   npm run generate:types
   ```

7. **Run Development Server**:

   ```bash
   npm run dev
   ```

8. **Run Tests**:
   ```bash
   npm test
   ```

## How to Contribute

### Reporting Bugs

Before creating bug reports, please check existing issues. When creating a bug report, include:

- **Clear title**: Descriptive summary of the issue
- **Steps to reproduce**: Detailed steps to reproduce the behavior
- **Expected behavior**: What you expected to happen
- **Actual behavior**: What actually happened
- **Environment**: OS, Node version, database version, etc.
- **Screenshots**: If applicable
- **Error logs**: Full error messages and stack traces

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md).

### Suggesting Features

Feature requests are welcome! Please:

1. **Check existing requests**: Search issues first
2. **Provide context**: Explain the problem you're trying to solve
3. **Describe the solution**: What you'd like to see implemented
4. **Consider alternatives**: Any alternative solutions you've considered
5. **Align with mission**: Ensure it supports privacy/censorship-resistance goals

Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md).

### Security Vulnerabilities

**Do not open public issues for security vulnerabilities.**

Please see [SECURITY.md](SECURITY.md) for responsible disclosure procedures.

## Commit Guidelines

We use [Linear](https://linear.app) for project management and follow this commit convention:

### Branch Naming

Format: `<type>/ALT-<ticket-number>-<description>`

Examples:

- `feature/ALT-123-add-web3-storage`
- `fix/ALT-456-resolve-auth-bug`
- `chore/ALT-789-update-dependencies`

Types:

- `feature/` - New features
- `fix/` - Bug fixes
- `chore/` - Maintenance tasks
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Test additions/updates
- `perf/` - Performance improvements

### Commit Messages

Format: `ALT-<number>: <description>`

Example:

```
ALT-123: Add IPFS pinning support

- Implement pin/unpin functionality
- Add pin status tracking
- Update tests
```

**Guidelines**:

- Use present tense ("Add feature" not "Added feature")
- Use imperative mood ("Move cursor to..." not "Moves cursor to...")
- First line: 50 characters or less
- Reference Linear ticket number
- Provide detailed description in body if needed

### Automated Commit Message

All commits will include:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

## Pull Request Process

1. **Create a branch** from `develop`:

   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feature/ALT-123-your-feature
   ```

2. **Make your changes**:
   - Write clean, documented code
   - Follow existing code style
   - Add/update tests
   - Update documentation

3. **Test your changes**:

   ```bash
   npm test                    # Run test suite
   npm run build               # Verify build
   npm run db:generate         # Regenerate Prisma client if schema changed
   npm run generate:types      # Regenerate GraphQL types if schema changed
   ```

4. **Commit your changes**:

   ```bash
   git add .
   git commit -m "ALT-123: Add your feature description"
   ```

5. **Push to your fork**:

   ```bash
   git push origin feature/ALT-123-your-feature
   ```

6. **Create Pull Request**:
   - Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md)
   - Link to related Linear ticket
   - Provide clear description of changes
   - Include screenshots/recordings for UI changes
   - Add tests and documentation
   - Request review from maintainers

7. **Address review feedback**:
   - Make requested changes
   - Push additional commits
   - Re-request review when ready

8. **Merge requirements**:
   - ✅ All CI checks pass
   - ✅ Code review approved
   - ✅ Branch up-to-date with base branch
   - ✅ No merge conflicts
   - ✅ Linear ticket linked

## Testing

### Running Tests

```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report
```

### Writing Tests

- **Location**: Co-locate test files with source (`*.test.ts`)
- **Framework**: Vitest
- **Coverage**: Aim for >80% coverage for new code
- **Types**: Unit tests for business logic, integration tests for API endpoints

**Example**:

```typescript
import { describe, it, expect } from 'vitest'
import { myFunction } from './myFunction'

describe('myFunction', () => {
  it('should return expected result', () => {
    const result = myFunction('input')
    expect(result).toBe('expected')
  })
})
```

## Code Style

### TypeScript

- **Strict mode**: Enabled in tsconfig.json
- **Naming conventions**:
  - PascalCase: Classes, interfaces, types
  - camelCase: Variables, functions, methods
  - UPPER_SNAKE_CASE: Constants
- **File naming**: kebab-case.ts

### GraphQL

- **Schema**: Located in `src/schema/`
- **Resolvers**: Located in `src/resolvers/`
- **Naming**: PascalCase for types, camelCase for fields
- **Documentation**: Add descriptions to all schema definitions

### Formatting

We will soon add ESLint and Prettier. For now:

- **Indentation**: 2 spaces
- **Quotes**: Single quotes for strings
- **Semicolons**: Required
- **Line length**: 80-100 characters (soft limit)

### Code Organization

```
src/
├── auth/           # Authentication middleware
├── config/         # Configuration
├── jobs/           # Background jobs
├── resolvers/      # GraphQL resolvers
├── schema/         # GraphQL schema
├── services/       # Business logic
│   ├── billing/
│   ├── storage/
│   └── ...
└── utils/          # Shared utilities
```

## Documentation

### Code Documentation

- **Functions**: Add JSDoc comments for public functions
- **Complex logic**: Add inline comments explaining "why" not "what"
- **GraphQL**: Add descriptions to all types and fields
- **Types**: Document complex types and interfaces

Example:

```typescript
/**
 * Pins a file to IPFS and tracks it in the database
 *
 * @param cid - The IPFS content identifier
 * @param userId - The user performing the pin operation
 * @returns Promise resolving to pin status
 * @throws {Error} If CID is invalid or pinning fails
 */
async function pinToIPFS(cid: string, userId: string): Promise<PinStatus> {
  // Implementation
}
```

### Project Documentation

Update relevant docs when making changes:

- **README.md**: Major feature additions
- **API documentation**: New endpoints or schema changes
- **Deployment guides**: Infrastructure changes
- **CHANGELOG.md**: All user-facing changes

## Community

### Communication Channels

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: General questions and community discussion
- **Pull Requests**: Code review and collaboration
- **Email**: conduct@alternatefutures.com (Code of Conduct issues)
- **Email**: security@alternatefutures.com (Security vulnerabilities)

### Getting Help

- Check existing documentation and issues first
- Ask in GitHub Discussions for general questions
- Tag `@maintainers` in your PR for review requests
- Be patient and respectful

### Recognition

Contributors will be:

- Listed in release notes
- Acknowledged in the project
- Invited to join maintainer discussions (for regular contributors)

## Project Structure

### Key Files

- `src/index.ts` - Main application entry point
- `src/schema/` - GraphQL schema definitions
- `src/resolvers/` - GraphQL resolvers
- `prisma/schema.prisma` - Database schema
- `src/services/` - Core business logic
- `src/auth/` - Authentication middleware

### Important Concepts

- **Authentication**: JWT-based with Personal Access Tokens (PATs)
- **Database**: PostgreSQL with Prisma ORM
- **Caching**: Redis for rate limiting and usage buffering
- **Storage**: Support for IPFS, Arweave, Filecoin
- **Deployment**: Akash Network (decentralized)

## License

By contributing to Alternate Futures, you agree that your contributions will be licensed under the [GNU General Public License v3.0](LICENSE).

## Questions?

If you have questions not covered here:

- Open a [GitHub Discussion](https://github.com/alternatefutures/alternatefutures-backend/discussions)
- Review existing [documentation](README.md)
- Check [issues](https://github.com/alternatefutures/alternatefutures-backend/issues)

---

**Thank you for contributing to Alternate Futures!** Together, we're building a more private, censorship-resistant internet.
