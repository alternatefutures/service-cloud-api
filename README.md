<div align="center">
  <img src="./assets/hero-logo.svg" alt="Alternate Futures" width="600" />
</div>

# ✨ Alternate Futures - GraphQL Backend ✨

**Decentralized serverless platform that runs on itself**

A GraphQL API server powering the Alternate Futures platform - serverless functions infrastructure built with GraphQL Yoga, Prisma, and PostgreSQL. Deploy your backend to distributed compute networks like Akash while managing everything through a unified API.

---

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env

# Set up database
npm run db:push

# Seed test data
npm run db:seed

# Start development server
npm run dev
```

Server runs at: **http://localhost:4000/graphql**

## Prerequisites

- Node.js 18+
- PostgreSQL (local or managed)
- Redis (required for usage buffering and auth service)
- pnpm (recommended)
- **Auth Service** (required for authentication) - See [alternatefutures-auth](https://github.com/alternatefutures/alternatefutures-auth)

## Deployment

### Akash Network (Recommended)

Deploy to decentralized compute infrastructure for 60-85% cost savings.

**Cost:** ~$18-27/month vs $50-130/month on traditional cloud
**Guide:** See [AKASH_DEPLOYMENT.md](AKASH_DEPLOYMENT.md) for complete instructions

```bash
# Build Docker image
docker build -t alternatefutures/backend:latest .
docker push alternatefutures/backend:latest

# Deploy to Akash (see AKASH_DEPLOYMENT.md for detailed steps)
akash tx deployment create deploy.yaml --from default
```

**Environment Variables** are stored in **GitHub Secrets** for CI/CD deployment.

### Railway (Backup Option)

Traditional cloud deployment option available as backup.
See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for Railway deployment instructions.

## Redis Setup

Redis is required for usage buffer aggregation (97% cost reduction on DB writes).

**Local Development:**
```bash
# macOS (Homebrew)
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt install redis-server
sudo systemctl start redis

# Docker
docker run -d -p 6379:6379 redis:alpine
```

**Production Configuration:**

Enable persistence for data integrity:
```bash
# RDB Snapshots (recommended)
save 60 1  # Save every 60 seconds if 1+ keys changed

# AOF (Append-Only File) - more durable
appendonly yes
appendfsync everysec
```

**Cloud Providers:**
- Akash Network: Include Redis in deploy.yaml
- Railway: Add Redis service via dashboard
- Upstash: Serverless Redis with persistence
- AWS ElastiCache: Configure snapshot retention

## Test Credentials

After seeding:
- **Token**: `af_local_test_token_12345`
- **Project ID**: `proj-1`

## CI/CD & Automation

This repository includes automated workflows for continuous integration:

### Automated Testing
- **Runs on:** Pull requests and pushes to `main`, `staging`, `develop`
- **Tests:** Vitest test suite with PostgreSQL and Redis
- **Type checking:** TypeScript compilation
- **Build verification:** Ensures code compiles successfully

### Automated Enforcement
- **Branch name validation:** Enforces `feature/ALT-###-description` or `feat/alt-###-description` format
- **PR title validation:** Requires Linear ticket number in PR title
- **Status checks:** All checks must pass before merging

### Claude Code Review
- **AI-powered code reviews** on every pull request
- Uses Claude Sonnet 4.5 to analyze changes
- Posts review comments directly on PRs
- Identifies bugs, security issues, and suggests improvements

**Setup:** Add `ANTHROPIC_API_KEY` to your repository secrets.
See [.github/SETUP.md](.github/SETUP.md) for configuration details.

### Branch Strategy
- **`main`** - Production (protected)
- **`staging`** - Pre-production testing
- **`develop`** - Active development

**Workflow:**
- Feature branches → Merge into `develop`
  - Naming: `feature/ALT-123-description` or `feat/alt-123-description`
- Bug fixes → Can merge directly into `staging`
  - Naming: `fix/ALT-789-description`
- Hotfixes → Merge directly into `main` (emergency only)
  - Naming: `hotfix/ALT-999-description`

## API Documentation

GraphQL Playground available at `/graphql`

### Core Features

#### Custom Domains & DNS
Bring your own domain from any registrar (GoDaddy, Namecheap, Cloudflare, etc.)

**Verification Methods:**
- TXT Record verification
- CNAME Record verification
- A Record verification

**SSL/TLS:**
- Automatic Let's Encrypt certificate provisioning
- Auto-renewal (30 days before expiry)
- HTTP-01 and DNS-01 ACME challenges

**Web3 Domains:**
- ArNS (Arweave Name System)
- ENS (Ethereum Name System)
- IPNS (IPFS Name System)

#### Usage-Based Billing
- Real-time usage tracking (storage, bandwidth, compute)
- Automatic invoice generation
- Stripe integration
- Customer portal access
- Branded invoice PDFs with company logo

**Preview Invoice Template:**
```bash
npm run generate:invoice
```

Creates a sample invoice PDF with:
- Alternate Futures logo and Instrument Sans typography
- Sample customer data
- Example usage charges
- Professional styling

**Payment Retries:**

Failed payments handled automatically via Stripe's Smart Retries.
Configure in Stripe Dashboard: **Settings** → **Billing** → **Automatic collection**

Recommended retry schedule:
- First retry: 3 days after failure
- Second retry: 5 days after first retry
- Third retry: 7 days after second retry
- Final retry: 9 days after third retry

All payment webhooks are handled via `/billing/webhook` endpoint.

#### Multi-Storage Support
- IPFS (self-hosted & Pinata)
- Arweave permanent storage
- Filecoin decentralized storage

#### Personal Access Tokens (API Keys)
**Note:** PAT management has been migrated to the dedicated auth service.
- Secure token generation with rate limiting
- 50 tokens per day limit per user
- Maximum 500 active tokens per user
- Automatic expired token cleanup (handled by auth service)
- XSS prevention and input validation
- **Required:** Set `AUTH_SERVICE_URL` in `.env` to connect to the auth service

### Example Mutations

**Create Function:**
```graphql
mutation {
  createFleekFunction(name: "my-api") {
    id
    name
    invokeUrl
  }
}
```

**Deploy Function:**
```graphql
mutation {
  deployFleekFunction(
    functionId: "clxxx"
    cid: "QmXXX"
  ) {
    id
    cid
  }
}
```

**Add Custom Domain:**
```graphql
mutation {
  createDomain(input: {
    hostname: "example.com"
    siteId: "site-123"
    verificationMethod: TXT
  }) {
    id
    hostname
    txtVerificationToken
    verified
  }
}
```

**Create Personal Access Token:**
```graphql
mutation {
  createPersonalAccessToken(name: "My API Token") {
    id
    token
    name
    createdAt
  }
}
```

## Tech Stack

- **GraphQL Yoga 5** - GraphQL server
- **Prisma** - ORM
- **PostgreSQL** - Database
- **Redis** - Rate limiting and usage buffering
- **TypeScript** - Language
- **Vitest** - Testing framework
- **Docker** - Containerization

## Project Structure

```
src/
├── schema/              # GraphQL schema
├── resolvers/           # Resolvers
│   ├── auth.ts         # Authentication (proxies to auth service)
│   ├── domain.ts       # Custom domains
│   ├── billing.ts      # Stripe billing
│   └── function.ts     # Functions management
├── services/           # Business logic
│   ├── billing/        # Stripe integration
│   ├── dns/            # Domain verification & SSL
│   └── storage/        # IPFS, Arweave, Filecoin
├── jobs/               # Background jobs
│   └── sslRenewal.ts   # SSL certificate renewal
├── utils/              # Utilities
└── index.ts            # Server entry

prisma/
└── schema.prisma       # Database schema
```

## Dogfooding

This backend can be deployed as an Alternate Futures Function to run on itself!

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for details on self-hosting the platform.

## Development

### Code Generation

Generate TypeScript types from GraphQL schema:
```bash
npm run generate:types

# Watch mode
npm run generate:types:watch
```

See [CODEGEN.md](CODEGEN.md) for details.

### Testing

```bash
# Run all tests
npm test

# Run specific test suite
npm test src/services/billing

# Watch mode
npm test -- --watch
```

### Database Migrations

```bash
# Push schema changes
npm run db:push

# Generate migration
npm run db:migrate

# Seed database
npm run db:seed
```

## Related Repositories

- **[CLI](https://github.com/alternatefutures/cloud-cli)** - Command-line interface
- **[SDK](https://github.com/alternatefutures/cloud-sdk)** - Software development kit
- **[App](https://github.com/alternatefutures/altfutures-app)** - Web application dashboard
- **[Website](https://github.com/alternatefutures/home)** - Company website

## Cost Comparison

### Traditional Cloud (Railway)
- Compute: $20/month
- PostgreSQL: $10/month
- Redis: $10/month
- Pinata IPFS: $20-100/month
- **Total**: $60-140/month

### Decentralized (Akash Network)
- Compute (API): ~$3-5/month
- PostgreSQL: ~$5-7/month
- Redis: ~$3-5/month
- Self-hosted IPFS: ~$10-15/month
- **Total**: $21-32/month

**Savings**: 60-85% cost reduction

## Security Features

- **Rate Limiting**: Redis-based sliding window algorithm
- **Input Validation**: XSS prevention, dangerous pattern detection
- **Token Security**: Separated GraphQL types to prevent exposure
- **Structured Logging**: Production-ready JSON logs for monitoring
- **SSL/TLS**: Automatic certificate provisioning and renewal
- **Database Transactions**: Race condition prevention
- **Audit Logging**: Track all API key operations

## License

MIT

---

**Documentation:**
- [Akash Deployment Guide](AKASH_DEPLOYMENT.md)
- [General Deployment Guide](DEPLOYMENT_GUIDE.md)
- [GraphQL Code Generation](CODEGEN.md)
- [OpenRegistry Deployment](OPENREGISTRY_DEPLOYMENT.md)
- [Decentralized Registry Architecture](DECENTRALIZED_REGISTRY_ARCHITECTURE.md)
