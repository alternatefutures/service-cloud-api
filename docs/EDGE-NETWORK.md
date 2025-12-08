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

## Current Stack (Phase 1: Caddy)

| Component | Technology | Purpose |
|-----------|------------|---------|
| Edge Proxy | Caddy 2.x | SSL termination, load balancing, dynamic routing |
| Dynamic Config | Caddy Admin API | Instant domain updates via REST API |
| SSL Certificates | Let's Encrypt (auto) + OpenProvider (wildcard) | Automatic cert management |
| DNS | OpenProvider API | DNS management |
| Origin Backends | Akash Network | Decentralized compute |
| Monitoring | Prometheus + Grafana | Observability |

### Why Caddy?

| Feature | HAProxy | Caddy | Winner |
|---------|---------|-------|--------|
| Dynamic domain updates | Socket API (complex) | REST API (simple) | Caddy |
| Auto HTTPS | Manual (acme.sh) | Built-in | Caddy |
| Configuration | Config file reload | Instant API updates | Caddy |
| Memory usage | ~20MB | ~50MB | HAProxy |
| Learning curve | High | Low | Caddy |

## Edge Node Specifications

### Minimum Requirements (Akash Deployment)

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 512 MB | 1 GB |
| Storage | 1 GB | 2 GB |

### VPS Requirements (Future Multi-Region)

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 2 GB |
| Storage | 20 GB SSD | 40 GB SSD |
| Bandwidth | 1 TB/mo | Unmetered |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |

### Recommended VPS Providers (Future)

| Provider | Region Coverage | Starting Cost |
|----------|-----------------|---------------|
| Hetzner | EU, US | $4/mo |
| Vultr | Global (25 regions) | $5/mo |
| DigitalOcean | Global (15 regions) | $6/mo |
| Linode | Global (11 regions) | $5/mo |

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

### Phase 3 (Pingora Migration)

Migration triggers (from [PINGORA-MIGRATION.md](./PINGORA-MIGRATION.md)):
- HTTP/3 demand > 20% of customers
- > 100k RPS per node needed
- Rust developer on staff
- Custom routing logic requirements

Features:
- [ ] HTTP/3 (QUIC) support
- [ ] Programmable request routing
- [ ] Custom caching logic
- [ ] Advanced traffic shaping
- [ ] Plugin architecture for customer features

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

| Service | Ingress URL | Purpose |
|---------|-------------|---------|
| service-cloud-api | cjrdmusuql9e34bevi8mjgj8pg.ingress.europlots.com | Main API |
| service-auth | 2svb4vnmb1fkdbudldgr7p3thg.ingress.europlots.com | Authentication |
| infisical | 9tnnbebe65bvt1vd2g6k67a72g.ingress.parallelnode.de | Secrets Manager |

## Scaling Strategy

### Horizontal Scaling (Edge Nodes)

| Traffic Level | Edge Nodes | Regions |
|---------------|------------|---------|
| < 10k RPM | 1 | Single region (Akash) |
| 10k - 100k RPM | 2-3 | 2 regions |
| 100k - 1M RPM | 3-5 | 3 regions |
| 1M+ RPM | 5+ | Global |

### Vertical Scaling (Per Node)

| Connections | Resources |
|-------------|-----------|
| < 10k concurrent | 1 vCPU / 512 MB |
| 10k - 50k concurrent | 2 vCPU / 1 GB |
| 50k - 100k concurrent | 4 vCPU / 2 GB |
| 100k+ concurrent | 8 vCPU / 4 GB |

### Sites per Edge Node

| Sites | Memory Impact | Notes |
|-------|--------------|-------|
| 100 | ~5 MB | Minimal impact |
| 1,000 | ~20 MB | Easy |
| 10,000 | ~100 MB | Still comfortable |
| 50,000+ | ~500 MB | Consider sharding |

## Monitoring

### Key Metrics

| Metric | Alert Threshold |
|--------|-----------------|
| Request latency (p99) | > 500ms |
| Error rate (5xx) | > 1% |
| Backend health | Any backend down |
| SSL cert expiry | < 14 days |
| Connection queue | > 1000 |
| CPU usage | > 80% |
| Memory usage | > 85% |

### Health Endpoints

| Endpoint | Port | Purpose |
|----------|------|---------|
| /health | 8080 | Liveness check |
| /ready | 8080 | Readiness check |

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

| Item | Monthly Cost |
|------|--------------|
| Akash deployment (1 CPU / 512 MB) | ~$5 |
| IP Lease | ~$10 |
| DNS (OpenProvider) | ~$5 |
| **Total** | **~$20/mo** |

### 3-Node Global Edge Network (Future)

| Item | Monthly Cost |
|------|--------------|
| 3x VPS (2 vCPU / 4 GB) | $60 |
| Bandwidth (10 TB) | Included |
| Monitoring (Grafana Cloud free tier) | $0 |
| DNS (OpenProvider) | ~$5 |
| **Total** | **~$65/mo** |

### At Scale (10 Nodes)

| Item | Monthly Cost |
|------|--------------|
| 10x VPS (4 vCPU / 8 GB) | $400 |
| Bandwidth (100 TB) | ~$100 |
| Monitoring | $50 |
| DNS | $10 |
| **Total** | **~$560/mo** |

## SSL Certificate Strategy

### Current Approach

1. **Wildcard cert from OpenProvider** for `*.alternatefutures.ai` (covers all subdomains)
2. **Let's Encrypt** for custom domains (automatic via Caddy)

### Let's Encrypt Rate Limits

| Limit | Value | Mitigation |
|-------|-------|------------|
| Certs per domain/week | 50 | Use wildcard for subdomains |
| Duplicate certs/week | 5 | Cache certs |
| New orders/3 hours | 300 | Spread deployments |

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

| Date | Decision | Rationale |
|------|----------|-----------|
| 2024-12-02 | Started with HAProxy | Fast time to market, mature technology |
| 2024-12-04 | **Migrated to Caddy** | Need for dynamic domain management via API |
| TBD | Pingora migration | When HTTP/3 or custom routing triggers met |
