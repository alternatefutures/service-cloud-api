<div align="center">

# ☁️ service-cloud-api

**Compute Orchestration · Domains · Templates · Agents**

Part of the [Alternate Clouds](https://alternatefutures.ai) platform.

[![CI](https://github.com/alternatefutures/service-cloud-api/actions/workflows/ci.yml/badge.svg)](https://github.com/alternatefutures/service-cloud-api/actions/workflows/ci.yml)

---

</div>

## Overview

GraphQL API that orchestrates compute deployments across decentralized infrastructure, manages custom domains with automatic SSL, serves deployment templates, and powers the AI assistant and feedback system.

Runs on port **1602**.

---

## Quick Start

```bash
pnpm install
cp .env.example .env
npx prisma migrate dev
pnpm dev
```

GraphQL Playground: **http://localhost:1602/graphql**

---

## Features

### Compute Orchestration
- **Standard Compute** — deploy containers to decentralized infrastructure
- **Confidential Compute** — hardware-isolated execution environments
- Unified deployment lifecycle: create → deploy → monitor → close
- Self-healing reconciler with strict close-on-`'gone'`-only policy and fleet-wide mass-event guards (Phase 49 + 49b — see `admin/cloud/docs/AF_DEVELOPMENT_PROCESS.md`)

### Templates
- Pre-built deployment templates (GPU instances, game servers, AI agents, etc.)
- Composable multi-service templates
- Template catalog with pricing and resource specs

### Domains & DNS
- Custom domain verification (TXT, CNAME, A record)
- Automatic Let's Encrypt SSL provisioning and renewal
- Subdomain proxy routing (`*.alternatefutures.ai`)

### AI Assistant & Chat
- Per-user AI agents with persistent chat history
- Platform-aware assistant with tool access

### Observability
- ClickHouse integration for traces, logs, and metrics
- Storage usage tracking

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js |
| Framework | GraphQL Yoga |
| Database | PostgreSQL + Prisma |
| Observability | ClickHouse |
| Compute | Decentralized providers (standard + confidential) |
| SSL | Let's Encrypt (ACME) |
| Testing | Vitest |

---

## Project Structure

```
src/
├── schema/typeDefs.ts       # GraphQL schema
├── resolvers/               # Query + mutation resolvers
│   ├── index.ts             # Main resolver map
│   ├── akash.ts             # Compute deployments
│   ├── domain.ts            # Domains + DNS + SSL
│   ├── chat.ts              # AI agents + chat
│   └── feedback.ts          # Bug reports + feedback
├── services/
│   ├── akash/               # Standard compute orchestration
│   ├── phala/               # Confidential compute integration
│   ├── dns/                 # Domain verification + SSL
│   ├── billing/             # Invoice generation
│   ├── chat/                # Agent + chat service
│   └── observability/       # ClickHouse integration
├── templates/definitions/   # Deployment template definitions
└── index.ts                 # Server entry
```

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `AUTH_SERVICE_URL` | Yes | URL to service-auth |
| `AUTH_INTROSPECTION_SECRET` | Yes | Shared secret with service-auth |
| `AKASH_MNEMONIC` | For compute | Compute provider wallet mnemonic |
| `CLICKHOUSE_URL` | For observability | ClickHouse connection |
| `DISCORD_FEEDBACK_WEBHOOK_URL` | For feedback | Discord webhook for bug reports |

---

## Development

```bash
pnpm test              # Run test suite
pnpm tsc --noEmit      # Type check
npx prisma migrate dev # Apply schema changes
npx prisma studio      # Browse database
```

### Branch Strategy

- `main` — production
- `develop` — active development
- Feature branches: `feature/ALT-123-description`

---

## Related

- [service-auth](https://github.com/alternatefutures/service-auth) — Auth + billing + AI proxy
- [web-app](https://github.com/alternatefutures/web-app.alternatefutures.ai) — Dashboard
- [package-cloud-cli](https://github.com/alternatefutures/package-cloud-cli) — CLI

---

AGPL-3.0-only
