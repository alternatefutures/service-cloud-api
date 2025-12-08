# Pingora Migration Plan

## Executive Summary

This document outlines the migration path from HAProxy to Pingora for the AlternateFutures edge network. Migration is recommended when specific triggers are met, not as a time-based deadline.

## Migration Triggers

**Migrate to Pingora when ANY of these conditions are true:**

| Trigger | Threshold | Rationale |
|---------|-----------|-----------|
| HTTP/3 demand | >20% of customers request it | HAProxy HTTP/3 is experimental |
| Custom routing logic | >3 custom routing rules needed | HAProxy Lua becomes unwieldy |
| Performance ceiling | >100k RPS per node needed | Pingora's efficiency matters |
| Team capability | Rust developer on staff | Development cost drops significantly |
| Competitive pressure | Competitors offer HTTP/3 | Feature parity needed |
| HAProxy limitations | Specific feature blocked | Business need unmet |

**Do NOT migrate if:**
- Current setup meets all requirements
- No Rust expertise available
- Team bandwidth is constrained
- Stability is the top priority

## Current State (HAProxy)

```
┌─────────────────────────────────────────────────────────────┐
│                     HAProxy Edge Node                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ SSL Termination │  │ Load Balancer │  │ Rate Limiting    │  │
│  │ (OpenSSL)   │  │ (built-in)  │  │ (stick-tables)     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Health Checks │  │ Metrics     │  │ Hot Reload         │  │
│  │ (built-in)  │  │ (Prometheus)│  │ (seamless)         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  Config: /etc/haproxy/haproxy.cfg (declarative)             │
│  Certs:  /etc/haproxy/certs/*.pem                           │
└─────────────────────────────────────────────────────────────┘
```

## Target State (Pingora)

```
┌─────────────────────────────────────────────────────────────┐
│                    Pingora Edge Node                         │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ SSL Termination │  │ HTTP/3 QUIC │  │ Custom Filters     │  │
│  │ (rustls)    │  │ (native)    │  │ (Rust code)        │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Connection Pool │  │ Caching     │  │ Programmable      │  │
│  │ (optimized) │  │ (custom)    │  │ (full control)     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  Binary: /opt/pingora/edge-proxy (compiled Rust)            │
│  Config: /etc/pingora/config.yaml + Rust code               │
└─────────────────────────────────────────────────────────────┘
```

## Migration Phases

### Phase 0: Preparation (2-4 weeks before migration)

| Task | Owner | Duration |
|------|-------|----------|
| Rust developer onboarding/training | Engineering | 2 weeks |
| Set up Rust development environment | DevOps | 1 day |
| Create Pingora prototype (hello world proxy) | Engineering | 1 week |
| Benchmark prototype vs HAProxy | Engineering | 3 days |
| Document current HAProxy behavior | DevOps | 2 days |
| Create comprehensive test suite | QA | 1 week |

**Exit Criteria:**
- [ ] Team can build and deploy Pingora binary
- [ ] Prototype passes basic traffic
- [ ] All current HAProxy behaviors documented
- [ ] Test suite covers all edge cases

### Phase 1: Feature Parity (4-6 weeks)

Build Pingora proxy with equivalent HAProxy functionality:

| Feature | Priority | Complexity | Est. Time |
|---------|----------|------------|-----------|
| SSL termination (TLS 1.3) | P0 | Medium | 3 days |
| SNI-based routing | P0 | Medium | 2 days |
| Backend load balancing | P0 | Low | 2 days |
| Health checks | P0 | Medium | 2 days |
| Graceful reload | P0 | High | 3 days |
| Rate limiting | P1 | Medium | 3 days |
| Prometheus metrics | P1 | Low | 1 day |
| Request logging | P1 | Low | 1 day |
| Connection limits | P1 | Low | 1 day |
| Timeout handling | P1 | Medium | 2 days |
| Error pages | P2 | Low | 1 day |
| **Total** | | | **~4 weeks** |

**Exit Criteria:**
- [ ] All HAProxy features replicated
- [ ] Test suite passes 100%
- [ ] Performance meets or exceeds HAProxy

### Phase 2: Shadow Deployment (2-4 weeks)

Run Pingora alongside HAProxy, comparing behavior:

```
                    ┌─────────────┐
                    │   Splitter  │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
    ┌─────────────────┐      ┌─────────────────┐
    │    HAProxy      │      │    Pingora      │
    │   (primary)     │      │   (shadow)      │
    │  ───────────►   │      │  ───────────►   │
    │   responses     │      │   discarded     │
    └─────────────────┘      └─────────────────┘
              │                         │
              │                         ▼
              │               ┌─────────────────┐
              │               │   Comparator    │
              │               │   (log diffs)   │
              │               └─────────────────┘
              ▼
         To Client
```

| Metric to Compare | Acceptable Variance |
|-------------------|---------------------|
| Response status codes | 0% difference |
| Response headers | 0% difference (excluding date/server) |
| Latency (p50) | ±10% |
| Latency (p99) | ±20% |
| Error rate | 0% difference |

**Exit Criteria:**
- [ ] 7 days with zero functional differences
- [ ] Latency within acceptable variance
- [ ] No memory leaks or crashes
- [ ] Team confident in Pingora behavior

### Phase 3: Canary Rollout (2-4 weeks)

Gradually shift traffic to Pingora:

| Day | Pingora Traffic | Rollback Trigger |
|-----|-----------------|------------------|
| 1-3 | 1% | Any error rate increase |
| 4-7 | 5% | Error rate > 0.1% |
| 8-14 | 25% | Error rate > 0.05% |
| 15-21 | 50% | Error rate > 0.01% |
| 22-28 | 100% | Any regression |

**Rollback procedure:**
```bash
# Immediate rollback (< 30 seconds)
./scripts/rollback-to-haproxy.sh

# This script:
# 1. Updates DNS/load balancer to route away from Pingora
# 2. Verifies HAProxy is healthy
# 3. Alerts team
```

**Exit Criteria:**
- [ ] 100% traffic on Pingora for 7 days
- [ ] No rollbacks triggered
- [ ] All SLOs maintained

### Phase 4: Cleanup & Enhancement (1-2 weeks)

| Task | Priority |
|------|----------|
| Decommission HAProxy nodes | P0 |
| Update documentation | P0 |
| Update runbooks | P0 |
| Implement HTTP/3 | P1 |
| Add custom caching | P1 |
| Performance optimization | P2 |

## Pingora Architecture

### Project Structure

```
edge-proxy/
├── Cargo.toml
├── src/
│   ├── main.rs              # Entry point
│   ├── config.rs            # Configuration loading
│   ├── proxy.rs             # Main proxy logic
│   ├── ssl.rs               # TLS/certificate handling
│   ├── routing.rs           # Request routing
│   ├── backends.rs          # Backend pool management
│   ├── health.rs            # Health checking
│   ├── metrics.rs           # Prometheus metrics
│   ├── rate_limit.rs        # Rate limiting
│   └── filters/
│       ├── mod.rs
│       ├── headers.rs       # Header manipulation
│       ├── logging.rs       # Request logging
│       └── security.rs      # Security filters
├── config/
│   └── config.yaml          # Runtime configuration
└── tests/
    ├── integration/
    └── unit/
```

### Key Dependencies

```toml
[dependencies]
pingora = "0.1"
pingora-core = "0.1"
pingora-proxy = "0.1"
pingora-load-balancing = "0.1"
tokio = { version = "1", features = ["full"] }
rustls = "0.21"
prometheus = "0.13"
serde = { version = "1", features = ["derive"] }
serde_yaml = "0.9"
tracing = "0.1"
```

### Sample Code Structure

```rust
// src/proxy.rs
use pingora::prelude::*;

pub struct EdgeProxy {
    config: Config,
    backends: Arc<BackendPool>,
    rate_limiter: RateLimiter,
}

#[async_trait]
impl ProxyHttp for EdgeProxy {
    type CTX = RequestContext;

    async fn request_filter(
        &self,
        session: &mut Session,
        ctx: &mut Self::CTX,
    ) -> Result<bool> {
        // Rate limiting
        if !self.rate_limiter.check(session.client_addr()) {
            return session.respond(429, "Too Many Requests").await;
        }

        // Route based on SNI/Host
        ctx.backend = self.routing.get_backend(session)?;

        Ok(false) // Continue to upstream
    }

    async fn upstream_peer(
        &self,
        session: &mut Session,
        ctx: &mut Self::CTX,
    ) -> Result<Box<HttpPeer>> {
        let backend = ctx.backend.as_ref().unwrap();
        Ok(Box::new(HttpPeer::new(backend.addr, backend.tls, backend.sni)))
    }
}
```

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Rust learning curve | High | Allocate training time; start with simple features |
| Undocumented HAProxy behavior | Medium | Extensive shadow testing |
| Performance regression | Medium | Benchmark at each phase |
| Production incidents during rollout | High | Canary + instant rollback |
| Team member leaves during migration | High | Document everything; pair programming |
| Pingora library bugs | Medium | Pin versions; contribute upstream fixes |

## Resource Requirements

| Phase | Duration | Engineers | Cost |
|-------|----------|-----------|------|
| Phase 0: Preparation | 2-4 weeks | 1 | $8,000-15,000 |
| Phase 1: Feature Parity | 4-6 weeks | 1-2 | $15,000-30,000 |
| Phase 2: Shadow Deploy | 2-4 weeks | 1 | $5,000-10,000 |
| Phase 3: Canary Rollout | 2-4 weeks | 1 | $5,000-10,000 |
| Phase 4: Cleanup | 1-2 weeks | 1 | $3,000-6,000 |
| **Total** | **11-20 weeks** | | **$36,000-71,000** |

## Success Metrics

| Metric | HAProxy Baseline | Pingora Target |
|--------|------------------|----------------|
| P50 latency | TBD after HAProxy deploy | ≤ baseline |
| P99 latency | TBD | ≤ baseline |
| Requests/sec (single node) | TBD | ≥ baseline |
| Memory usage | TBD | ≤ 70% of baseline |
| HTTP/3 support | No | Yes |
| Hot reload time | ~100ms | ≤ 100ms |
| Uptime | 99.9% | 99.95% |

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2025-12-02 | Start with HAProxy | Faster time to market, lower initial cost |
| TBD | Begin Pingora migration | [Trigger condition met] |

## Appendix

### A. Pingora Resources

- [Pingora GitHub](https://github.com/cloudflare/pingora)
- [Pingora Documentation](https://github.com/cloudflare/pingora/tree/main/docs)
- [Cloudflare Blog: Open Sourcing Pingora](https://blog.cloudflare.com/pingora-open-source)
- [Rust Book](https://doc.rust-lang.org/book/)

### B. Team Training Plan

| Week | Topic | Resource |
|------|-------|----------|
| 1 | Rust fundamentals | Rust Book chapters 1-10 |
| 2 | Async Rust | Tokio tutorial |
| 3 | Pingora basics | Official examples |
| 4 | Build prototype | Hands-on project |

### C. Rollback Checklist

```markdown
## Rollback Checklist

- [ ] Confirm issue requires rollback (not transient)
- [ ] Notify team in #incidents channel
- [ ] Run: `./scripts/rollback-to-haproxy.sh`
- [ ] Verify HAProxy is serving traffic
- [ ] Monitor error rates for 15 minutes
- [ ] Post incident summary
- [ ] Schedule post-mortem
```
