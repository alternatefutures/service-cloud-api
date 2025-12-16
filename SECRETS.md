# Environment Variables & Secrets

This document lists all environment variables required for `service-cloud-api`.

## Infisical Path

```
/production/service-cloud-api/
```

## Required Variables

### Database

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |

### Authentication

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | JWT signing secret (shared with service-auth) | `your-256-bit-secret` |
| `AUTH_SERVICE_URL` | URL to auth service | `https://auth.alternatefutures.ai` |

### IPFS Storage (Pinata)

| Variable | Description | Example |
|----------|-------------|---------|
| `PINATA_API_KEY` | Pinata API key | `abc123...` |
| `PINATA_API_SECRET` | Pinata API secret | `xyz789...` |
| `PINATA_JWT` | Pinata JWT token (alternative auth) | `eyJ...` |

## Optional Variables

### Billing (Stripe)

| Variable | Description | Example |
|----------|-------------|---------|
| `STRIPE_SECRET_KEY` | Stripe secret key | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret | `whsec_...` |
| `STRIPE_PRICE_ID_PRO` | Price ID for Pro plan | `price_...` |

### Arweave Storage

| Variable | Description | Example |
|----------|-------------|---------|
| `ARWEAVE_PRIVATE_KEY` | Arweave wallet private key (JWK JSON) | `{"kty":"RSA",...}` |
| `TURBO_WALLET_KEY` | Turbo SDK wallet key | `base64-encoded-key` |

### Lighthouse (Filecoin)

| Variable | Description | Example |
|----------|-------------|---------|
| `LIGHTHOUSE_API_KEY` | Lighthouse API key | `abc123...` |

### Blockchain RPC

| Variable | Description | Example |
|----------|-------------|---------|
| `ETH_RPC_URL` | Ethereum RPC endpoint | `https://eth-mainnet.g.alchemy.com/v2/...` |
| `SOLANA_RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |

### Secrets Management

| Variable | Description | Example |
|----------|-------------|---------|
| `INFISICAL_CLIENT_ID` | Infisical machine identity client ID | `abc123...` |
| `INFISICAL_CLIENT_SECRET` | Infisical machine identity secret | `xyz789...` |
| `INFISICAL_PROJECT_ID` | Infisical project ID | `proj_...` |

### Application

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `production` |
| `PORT` | Server port | `4000` |
| `LOG_LEVEL` | Logging verbosity | `info` |

## Example .env

```env
# Database
DATABASE_URL=postgresql://af:password@localhost:5432/alternatefutures

# Auth
JWT_SECRET=your-super-secret-jwt-key-min-32-chars
AUTH_SERVICE_URL=https://auth.alternatefutures.ai

# IPFS (Pinata)
PINATA_API_KEY=your-pinata-api-key
PINATA_API_SECRET=your-pinata-api-secret

# Stripe (optional)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Application
NODE_ENV=development
PORT=4000
```

## Priority Order for Setup

1. **Critical** (service won't start without):
   - `DATABASE_URL`
   - `JWT_SECRET`

2. **Important** (core features):
   - `PINATA_API_KEY`, `PINATA_API_SECRET`
   - `AUTH_SERVICE_URL`

3. **Optional** (enhanced features):
   - Stripe variables (billing)
   - Arweave/Lighthouse (additional storage)
   - Blockchain RPC (Web3 features)
