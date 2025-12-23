# AlternateFutures Edge Network Architecture

## Overview

Self-hosted edge network providing SSL termination, load balancing, and geographic distribution for custom domains. Replaces dependency on centralized CDN providers like Cloudflare.

## Architecture

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    EDGE NETWORK                          │
                    └─────────────────────────────────────────────────────────┘

    Customer DNS                    Edge Layer                      Origin Layer
    ─────────────                   ──────────                      ────────────

    api.customer.com ──┐
                       │        ┌─────────────────┐
    CNAME to           ├──────► │  Edge Node NYC  │ ────┐
    edge.alternatefutures.ai    │  (Caddy)        │     │
                       │        └─────────────────┘     │
                       │                                │      ┌──────────────────┐
                       │        ┌─────────────────┐     ├────► │  Akash Backend   │
    GeoDNS routes      ├──────► │  Edge Node LON  │ ────┤      │  (service-cloud) │
    to nearest edge    │        │  (Caddy)        │     │      └──────────────────┘
                       │        └─────────────────┘     │
                       │                                │      ┌──────────────────┐
                       │        ┌─────────────────┐     ├────► │  Akash Backend   │
                       └──────► │  Edge Node SIN  │ ────┘      │  (service-auth)  │
                                │  (Caddy)        │            └──────────────────┘
                                └─────────────────┘

    Legend:
    ──────► HTTPS (TLS 1.3)
    Edge nodes handle: SSL termination, dynamic routing, rate limiting, DDoS protection
```

## Current Stack (Phase 1: Pingap on Akash)

| Component        | Technology                  | Purpose                                  |
| ---------------- | --------------------------- | ---------------------------------------- |
| Edge Proxy       | Pingap (Rust/Pingora)       | SSL termination, load balancing, routing |
| SSL Certificates | Cloudflare Origin Certs     | Certificate management                   |
| DNS              | Cloudflare + deSEC          | DNS management with GeoDNS               |
| Origin Backends  | Akash Network               | Decentralized compute                    |
| Monitoring       | Akash logs + custom metrics | Observability                            |

### Current Deployment

| Field            | Value                                                       |
| ---------------- | ----------------------------------------------------------- |
| **DSEQ**         | 24750686                                                    |
| **Provider**     | Europlots (`akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc`)  |
| **Dedicated IP** | 62.3.50.133                                                 |
| **Image**        | `ghcr.io/alternatefutures/infrastructure-proxy-pingap:main` |

### Why Pingap?

| Feature         | Caddy          | Pingap                   | Winner |
| --------------- | -------------- | ------------------------ | ------ |
| Performance     | Good           | Excellent (Rust/Pingora) | Pingap |
| Memory usage    | ~50MB          | ~20MB                    | Pingap |
| HTTP/3 support  | Limited        | Native                   | Pingap |
| Config format   | Caddyfile/JSON | TOML                     | Pingap |
| Dynamic updates | REST API       | Config reload            | Caddy  |

We chose Pingap for its Rust-based performance and lower memory footprint on Akash.

## Edge Node Specifications

### Minimum Requirements (Akash Deployment)

| Resource | Minimum | Recommended |
| -------- | ------- | ----------- |
| CPU      | 1 vCPU  | 2 vCPU      |
| RAM      | 512 MB  | 1 GB        |
| Storage  | 1 GB    | 2 GB        |

### VPS Requirements (Future Multi-Region)

| Resource  | Minimum          | Recommended      |
| --------- | ---------------- | ---------------- |
| CPU       | 1 vCPU           | 2 vCPU           |
| RAM       | 1 GB             | 2 GB             |
| Storage   | 20 GB SSD        | 40 GB SSD        |
| Bandwidth | 1 TB/mo          | Unmetered        |
| OS        | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

### Recommended VPS Providers (Future)

| Provider     | Region Coverage     | Starting Cost |
| ------------ | ------------------- | ------------- |
| Hetzner      | EU, US              | $4/mo         |
| Vultr        | Global (25 regions) | $5/mo         |
| DigitalOcean | Global (15 regions) | $6/mo         |
| Linode       | Global (11 regions) | $5/mo         |

## Features

### Phase 1 (Caddy - Current)

- [x] SSL/TLS termination with Let's Encrypt
- [x] SNI-based routing for multiple domains
- [x] **Dynamic domain management via REST API**
- [x] Load balancing across Akash backends
- [x] Health checks and automatic failover
- [x] Security headers (HSTS, X-Frame-Options)
- [x] Request logging

### Phase 2 (Enhanced Caddy)

- [ ] Geographic load balancing (multi-region)
- [ ] Request/response caching
- [ ] Advanced rate limiting
- [ ] Custom error pages
- [ ] Request logging and analytics
- [ ] Wildcard SSL for `*.alternatefutures.ai`

### Phase 3 (DePIN Provider Expansion)

Expand beyond Akash to additional decentralized infrastructure providers:

#### Edge Network (edge.network)

A decentralized "supercloud" with global CDN and serverless capabilities.

| Feature         | Details                                                |
| --------------- | ------------------------------------------------------ |
| **Services**    | CDN, DNS, Compute, Serverless Functions, Storage       |
| **Network**     | Peer-to-peer architecture, thousands of global nodes   |
| **Token**       | $EDGE (Ethereum + XE blockchain)                       |
| **Integration** | Edge CLI, REST API                                     |
| **Use Case**    | Global content delivery, edge caching, DDoS protection |

**Integration Points:**

- CDN for static assets and cached content
- DNS with global anycast
- Serverless functions at edge locations
- DDoS protection (Shield)

```bash
# Edge CLI example
edge cdn deploy --domain cdn.alternatefutures.ai --origin ipfs.alternatefutures.ai
```

**Documentation:** https://wiki.edge.network

#### Hedera Hashgraph

High-throughput distributed ledger for consensus and micropayments.

| Feature        | Details                                            |
| -------------- | -------------------------------------------------- |
| **Throughput** | 10,000+ TPS                                        |
| **Cost**       | ~$0.001 per transaction                            |
| **Finality**   | 3-5 seconds                                        |
| **Services**   | Consensus Service, Token Service, Smart Contracts  |
| **Use Case**   | Payment-gated functions, audit logs, micropayments |

**Integration Points:**

- Hedera Consensus Service (HCS) for ordered event logs
- Token Service for function micropayments
- Smart contracts for access control

```typescript
// Hedera SDK example - payment-gated function
import { Client, TopicMessageSubmitTransaction } from '@hashgraph/sdk'

const client = Client.forMainnet()
await new TopicMessageSubmitTransaction()
  .setTopicId(topicId)
  .setMessage(`function:${functionId}:invoked:${timestamp}`)
  .execute(client)
```

**Documentation:** https://docs.hedera.com

#### Filecoin Saturn

Decentralized content delivery network built on Filecoin.

| Feature         | Details                                        |
| --------------- | ---------------------------------------------- |
| **Network**     | 2,500+ nodes globally                          |
| **Latency**     | Sub-100ms for cached content                   |
| **Integration** | HTTP Gateway, Client Library                   |
| **Use Case**    | Large file delivery, IPFS content acceleration |

**Integration Points:**

- Accelerate IPFS content delivery
- Cache frequently accessed function assets
- Reduce origin load for static content

```typescript
// Saturn client example
import { Saturn } from '@filecoin-saturn/client'

const saturn = new Saturn()
const content = await saturn.fetchCID(cid, {
  preferredNodes: ['us-west', 'eu-central'],
})
```

**Documentation:** https://saturn.tech

#### Internet Computer (ICP)

Sovereign internet cloud providing tamperproof, unstoppable web hosting and compute.

| Feature      | Details                                              |
| ------------ | ---------------------------------------------------- |
| **Runtime**  | WebAssembly (any language that compiles to Wasm)     |
| **Language** | Motoko (domain-specific) + Rust, TypeScript, Python  |
| **Security** | Tamperproof execution, immune to traditional attacks |
| **Hosting**  | Fully on-chain apps, websites, SaaS                  |
| **Use Case** | Autonomous dApps, cross-chain token operations       |

**Integration Points:**

- Host static sites and SPAs directly on-chain
- Run serverless canisters (smart contracts) for backend logic
- Cross-chain token operations (Bitcoin, Ethereum integration)
- Unstoppable, censorship-resistant hosting

```typescript
// ICP canister example (Motoko)
actor {
  public query func greet(name : Text) : async Text {
    return "Hello, " # name # "!";
  };
}

// Or using dfx CLI
// dfx deploy --network ic
```

**Documentation:** https://internetcomputer.org/docs

#### Phala Network

Confidential computing platform with GPU TEE for private AI and secure execution.

| Feature         | Details                                         |
| --------------- | ----------------------------------------------- |
| **TEE Support** | Intel SGX, AMD SEV, NVIDIA H100/H200/B200 GPUs  |
| **Performance** | 95% native efficiency with full privacy         |
| **Compliance**  | SOC 2 Type I, HIPAA compliant                   |
| **SLA**         | 99.9% uptime                                    |
| **Use Case**    | Confidential AI, private compute, secure agents |

**Integration Points:**

- Run AI models with full data privacy (DeepSeek, Llama, Qwen)
- Confidential VMs with Docker/Kubernetes compatibility
- Cryptographic attestations for security verification
- Trusted execution for sensitive function logic

```typescript
// Phala dStack deployment example
// 1. Write code, dockerize
// 2. Deploy via Phala CLI

import { PhalaCloud } from '@phal/sdk'

const cloud = new PhalaCloud({ apiKey: process.env.PHALA_API_KEY })

// Deploy confidential container
const deployment = await cloud.deploy({
  image: 'ghcr.io/alternatefutures/secure-function:latest',
  tee: 'sgx', // or 'nvidia-h100'
  resources: { cpu: 2, memory: '4Gi' },
})
```

**Pricing:** Starting at $0.27/million tokens for AI inference

**Documentation:** https://docs.phala.network

### Phase 4 (Advanced Features)

With DePIN network established:

- [ ] HTTP/3 (QUIC) support via Pingap upgrade
- [ ] Programmable request routing
- [ ] Custom caching logic across providers
- [ ] Advanced traffic shaping
- [ ] Provider marketplace (user selects preferred DePIN)

## Dynamic Domain Management

### Caddy Admin API

The edge proxy exposes Caddy's Admin API on port 2019 for instant domain updates.

#### Add a new domain route

```bash
curl -X POST "http://edge-ip:2019/config/apps/http/servers/srv0/routes" \
  -H "Content-Type: application/json" \
  -d '{
    "@id": "route-mysite",
    "match": [{"host": ["mysite.example.com"]}],
    "handle": [{
      "handler": "reverse_proxy",
      "upstreams": [{"dial": "backend.ingress.akash:443"}],
      "transport": {"protocol": "http", "tls": {"insecure_skip_verify": true}}
    }]
  }'
```

#### Remove a domain route

```bash
curl -X DELETE "http://edge-ip:2019/id/route-mysite"
```

#### List current configuration

```bash
curl "http://edge-ip:2019/config/"
```

### Integration with cloud-cli

When a user deploys a site:

1. Site deploys to Akash, gets ingress URL
2. cloud-cli calls Caddy Admin API to add domain route
3. Route is active immediately (no restart needed)
4. User's domain works within seconds

## Configuration

### Directory Structure (Container)

```
/etc/caddy/
├── Caddyfile           # Main configuration (startup)
└── certs/
    ├── cert.pem        # SSL certificate
    └── key.pem         # Private key
```

### Backend Definitions

Current Akash backends:

| Service           | Provider  | Ingress URL                                         | Purpose                  |
| ----------------- | --------- | --------------------------------------------------- | ------------------------ |
| SSL Proxy         | Europlots | 62.3.50.133 (dedicated IP)                          | SSL termination, routing |
| service-cloud-api | Subangle  | rvknp4kjg598n8uslgnovkrdpk.ingress.gpu.subangle.com | Main GraphQL API         |
| service-auth      | _TBD_     | _Needs redeployment_                                | Authentication           |
| infisical         | Europlots | ddchr1pel5e0p8i0c46drjpclg.ingress.europlots.com    | Secrets Manager          |

> **Note:** Auth service needs redeployment on a different provider to avoid NAT hairpin issues with the proxy.

## Scaling Strategy

### Horizontal Scaling (Edge Nodes)

| Traffic Level  | Edge Nodes | Regions               |
| -------------- | ---------- | --------------------- |
| < 10k RPM      | 1          | Single region (Akash) |
| 10k - 100k RPM | 2-3        | 2 regions             |
| 100k - 1M RPM  | 3-5        | 3 regions             |
| 1M+ RPM        | 5+         | Global                |

### Vertical Scaling (Per Node)

| Connections           | Resources       |
| --------------------- | --------------- |
| < 10k concurrent      | 1 vCPU / 512 MB |
| 10k - 50k concurrent  | 2 vCPU / 1 GB   |
| 50k - 100k concurrent | 4 vCPU / 2 GB   |
| 100k+ concurrent      | 8 vCPU / 4 GB   |

### Sites per Edge Node

| Sites   | Memory Impact | Notes             |
| ------- | ------------- | ----------------- |
| 100     | ~5 MB         | Minimal impact    |
| 1,000   | ~20 MB        | Easy              |
| 10,000  | ~100 MB       | Still comfortable |
| 50,000+ | ~500 MB       | Consider sharding |

## Monitoring

### Key Metrics

| Metric                | Alert Threshold  |
| --------------------- | ---------------- |
| Request latency (p99) | > 500ms          |
| Error rate (5xx)      | > 1%             |
| Backend health        | Any backend down |
| SSL cert expiry       | < 14 days        |
| Connection queue      | > 1000           |
| CPU usage             | > 80%            |
| Memory usage          | > 85%            |

### Health Endpoints

| Endpoint | Port | Purpose         |
| -------- | ---- | --------------- |
| /health  | 8080 | Liveness check  |
| /ready   | 8080 | Readiness check |

### Dashboards

- Edge node health overview
- Per-domain traffic and errors
- Backend health and latency
- Certificate expiration tracker
- Geographic traffic distribution

## Security

### Implemented

- TLS 1.3 (modern cipher suites)
- HSTS headers
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Timeout configurations

### Planned

- Rate limiting per IP/domain
- IP reputation blocking
- Geographic blocking (optional per customer)
- WAF rules
- Bot detection
- Admin API authentication

## Disaster Recovery

### Failover

1. Health checks detect backend failure
2. Traffic routes to healthy backends
3. Alert fires to ops team
4. Auto-recovery when backend returns

### Edge Node Failure

1. GeoDNS detects node is down
2. Traffic routes to next-nearest node
3. Alert fires
4. Replace or recover failed node

### Full Region Outage

1. All traffic routes to other regions
2. Increased latency but no downtime
3. Spin up replacement in new region if needed

## Cost Estimate

### Current (Single Akash Node)

| Item                              | Monthly Cost |
| --------------------------------- | ------------ |
| Akash deployment (1 CPU / 512 MB) | ~$5          |
| IP Lease                          | ~$10         |
| DNS (OpenProvider)                | ~$5          |
| **Total**                         | **~$20/mo**  |

### 3-Node Global Edge Network (Future)

| Item                                 | Monthly Cost |
| ------------------------------------ | ------------ |
| 3x VPS (2 vCPU / 4 GB)               | $60          |
| Bandwidth (10 TB)                    | Included     |
| Monitoring (Grafana Cloud free tier) | $0           |
| DNS (OpenProvider)                   | ~$5          |
| **Total**                            | **~$65/mo**  |

### At Scale (10 Nodes)

| Item                    | Monthly Cost |
| ----------------------- | ------------ |
| 10x VPS (4 vCPU / 8 GB) | $400         |
| Bandwidth (100 TB)      | ~$100        |
| Monitoring              | $50          |
| DNS                     | $10          |
| **Total**               | **~$560/mo** |

## SSL Certificate Strategy

### Current Approach

1. **Wildcard cert from OpenProvider** for `*.alternatefutures.ai` (covers all subdomains)
2. **Let's Encrypt** for custom domains (automatic via Caddy)

### Let's Encrypt Rate Limits

| Limit                 | Value | Mitigation                  |
| --------------------- | ----- | --------------------------- |
| Certs per domain/week | 50    | Use wildcard for subdomains |
| Duplicate certs/week  | 5     | Cache certs                 |
| New orders/3 hours    | 300   | Spread deployments          |

### Fallback CAs

If Let's Encrypt limits hit:

- ZeroSSL (3 free, then paid)
- Buypass (20/week limit)
- Google Trust Services

## Related Documentation

- [Pingora Migration Plan](./PINGORA-MIGRATION.md)
- [Certificate Management](./CERTIFICATES.md)
- [Runbook: Edge Node Deployment](./runbooks/EDGE-NODE-DEPLOY.md)

## Decision Log

| Date       | Decision                 | Rationale                                    |
| ---------- | ------------------------ | -------------------------------------------- |
| 2024-12-02 | Started with HAProxy     | Fast time to market, mature technology       |
| 2024-12-04 | Migrated to Caddy        | Need for dynamic domain management via API   |
| 2025-12-23 | **Migrated to Pingap**   | Better performance, lower memory, Rust-based |
| 2025-12-23 | Moved proxy to Europlots | DigitalFrontier IP pool exhausted            |
| 2025-12-23 | Added provider selection | NAT hairpin prevention for backend services  |
| TBD        | Edge Network integration | Global CDN and edge caching                  |
| TBD        | Hedera integration       | Payment-gated functions, micropayments       |
| TBD        | Filecoin Saturn          | Content delivery acceleration                |
| TBD        | Internet Computer (ICP)  | Tamperproof on-chain hosting                 |
| TBD        | Phala Network            | Confidential computing, private AI           |

## Related Documentation

- [AF_FUNCTIONS_PLATFORM.md](../../web-app.alternatefutures.ai/AF_FUNCTIONS_PLATFORM.md) - Functions platform architecture
- [ProviderSelector](../src/services/akash/providerSelector.ts) - NAT hairpin prevention
- [infrastructure-proxy/CLAUDE.md](../../infrastructure-proxy/CLAUDE.md) - Proxy deployment procedures
- [Pingora Migration Plan](./PINGORA-MIGRATION.md) - HTTP/3 upgrade path

## External Resources

- [Akash Network](https://akash.network/) - Primary compute provider
- [Edge Network](https://edge.network/) - Decentralized CDN (Phase 3)
- [Hedera Hashgraph](https://hedera.com/) - Consensus and micropayments (Phase 3)
- [Filecoin Saturn](https://saturn.tech/) - Content delivery (Phase 3)
- [Internet Computer](https://internetcomputer.org/) - Tamperproof web hosting (Phase 3)
- [Phala Network](https://phala.com/) - Confidential computing with TEE (Phase 3)
