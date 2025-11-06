# AlternateFutures GraphQL Backend

GraphQL API server for the AlternateFutures platform - a serverless functions platform that runs on itself.

## 🚀 Quick Start

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

Server runs at: **http://localhost:4000/graphql** 🎉

## 📋 Prerequisites

- Node.js 18+
- PostgreSQL (local or Railway)
- Redis (required for usage buffering)
- pnpm (recommended)

## 🌐 Deploy to Railway

See [../PLATFORM_SETUP.md](../PLATFORM_SETUP.md) for complete deployment guide.

**Quick deploy:**
```bash
railway login
railway init
railway add  # Select PostgreSQL
railway service create alternatefutures-backend
railway service alternatefutures-backend
railway up
```

## 🔴 Redis Setup

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

For data integrity during deployments, enable persistence in your Redis config:

```bash
# Option 1: RDB Snapshots (recommended)
save 60 1  # Save every 60 seconds if 1+ keys changed

# Option 2: AOF (Append-Only File) - more durable
appendonly yes
appendfsync everysec
```

**Cloud Providers:**
- **Railway**: Add Redis service via dashboard
- **Upstash**: Serverless Redis with persistence
- **Redis Cloud**: Managed Redis with automatic persistence
- **AWS ElastiCache**: Configure snapshot retention

**Pre-Deployment Safety:**

Before deployments or maintenance, manually flush the buffer:

```graphql
mutation {
  flushUsageBuffer {
    success
    usersFlushed
    duration
    message
  }
}
```

Monitor buffer health:

```graphql
query {
  usageBufferStats {
    activeUsers
    totalBandwidth
    totalCompute
    totalRequests
    bufferHealthy
  }
}
```

## 🧪 Test Credentials

After seeding:
- **Token**: `af_local_test_token_12345`
- **Project ID**: `proj-1`

## ⚙️ GitHub Actions & CI/CD

This repository includes automated workflows for continuous integration and code review:

### Automated Testing
- **Runs on:** Pull requests and pushes to `main`, `staging`, `develop`
- **Tests:** Vitest test suite with PostgreSQL and Redis
- **Type checking:** TypeScript compilation
- **Build verification:** Ensures code compiles successfully

### Claude Code Review
- **AI-powered code reviews** on every pull request
- Uses Claude Sonnet 4.5 to analyze changes
- Posts review comments directly on PRs
- Identifies bugs, security issues, and suggests improvements

### Setup Required
To enable Claude Code Review, add `ANTHROPIC_API_KEY` to your repository secrets.

See [.github/SETUP.md](.github/SETUP.md) for detailed configuration instructions.

### Branch Strategy
- **`main`** - Production (protected)
- **`staging`** - Pre-production testing
- **`develop`** - Active development

## 📚 API Documentation

GraphQL Playground available at `/graphql`

### Core Features

#### 🌐 Custom Domains & DNS
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

#### 💳 Usage-Based Billing
- Real-time usage tracking (storage, bandwidth, compute)
- Automatic invoice generation
- Stripe integration
- Customer portal access
- Branded invoice PDFs with company logo

**Preview Invoice Template:**

Generate a sample invoice PDF to preview the branding and layout:

```bash
npm run generate:invoice
```

This creates a test invoice with:
- Alternate Futures logo and Instrument Sans typography
- Sample customer data (Acme Corporation)
- Example usage charges (bandwidth, compute, requests)
- Professional styling matching the brand

The PDF is saved to `/invoices` and opens automatically.

**Payment Retries:**

Failed payments are handled automatically via Stripe's Smart Retries feature. Configure in your Stripe Dashboard:

1. Go to **Settings** → **Billing** → **Automatic collection**
2. Enable **Smart Retries** (recommended settings):
   - First retry: 3 days after failure
   - Second retry: 5 days after first retry
   - Third retry: 7 days after second retry
   - Final retry: 9 days after third retry

Smart Retries automatically:
- Retries payments at optimal times based on historical success patterns
- Sends email notifications to customers before each retry
- Updates your webhook with payment status changes
- Marks subscriptions as `past_due` until payment succeeds

**Manual Retry:**

For custom retry logic or manual intervention, use the Stripe API:

```typescript
// Retry a specific invoice
await stripe.invoices.pay('inv_xxx');
```

All payment webhooks are automatically handled via `/billing/webhook` endpoint.

#### 📦 Multi-Storage Support
- IPFS (self-hosted & Pinata)
- Arweave permanent storage
- Filecoin decentralized storage

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

**Verify Domain:**
```graphql
mutation {
  verifyDomain(domainId: "domain-123")
}
```

**Provision SSL:**
```graphql
mutation {
  provisionSsl(
    domainId: "domain-123"
    email: "admin@example.com"
  ) {
    sslStatus
    sslExpiresAt
  }
}
```

## 🛠️ Tech Stack

- **GraphQL Yoga 5** - GraphQL server
- **Prisma** - ORM
- **PostgreSQL** - Database
- **TypeScript** - Language

## 📁 Project Structure

```
src/
├── schema/          # GraphQL schema
├── resolvers/       # Resolvers
├── auth/            # Authentication
├── utils/           # Utilities
└── index.ts         # Server entry

prisma/
└── schema.prisma    # Database schema
```

## 🍽️ Dogfooding

This backend can be deployed as an AlternateFutures Function to run on itself!

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for details.

## 📝 License

MIT
