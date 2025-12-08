# AlternateFutures Edge Network

Self-hosted edge network for SSL termination and load balancing.

## Quick Start

### Local Development (Docker)

```bash
# 1. Add test certificates (self-signed for local dev)
./scripts/generate-dev-certs.sh

# 2. Start the stack
docker-compose up -d

# 3. Test
curl -k https://localhost/health
```

### Production Deployment (VPS)

```bash
# On a fresh Ubuntu 22.04 VPS
export OPENPROVIDER_USER="system"
export OPENPROVIDER_PASS="your-password"
export ACME_EMAIL="admin@alternatefutures.ai"

curl -s https://raw.githubusercontent.com/.../deploy-edge-node.sh | sudo bash
```

## Architecture

```
Internet
    │
    ▼
┌─────────────────────────────────┐
│         HAProxy Edge            │
│  ┌───────────┐ ┌─────────────┐  │
│  │ SSL Term. │ │ Rate Limit  │  │
│  └───────────┘ └─────────────┘  │
│  ┌───────────┐ ┌─────────────┐  │
│  │ Routing   │ │ Health Chk  │  │
│  └───────────┘ └─────────────┘  │
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│      Akash Network Backends     │
│  ┌───────────┐ ┌─────────────┐  │
│  │ API       │ │ Auth        │  │
│  └───────────┘ └─────────────┘  │
└─────────────────────────────────┘
```

## Directory Structure

```
edge/
├── haproxy.cfg           # Main HAProxy configuration
├── docker-compose.yml    # Docker deployment
├── maps/
│   └── domains.map       # Domain → backend routing
├── certs/                # SSL certificates (gitignored)
├── errors/               # Custom error pages
├── scripts/
│   └── deploy-edge-node.sh
└── prometheus/
    └── prometheus.yml
```

## Configuration

### Adding a New Domain

1. Issue certificate:
```bash
~/.acme.sh/acme.sh --issue --dns dns_openprovider_rest -d newdomain.com
```

2. Install certificate:
```bash
~/.acme.sh/acme.sh --install-cert -d newdomain.com \
    --key-file /etc/haproxy/certs/newdomain.com.key \
    --fullchain-file /etc/haproxy/certs/newdomain.com.crt \
    --reloadcmd "cat /etc/haproxy/certs/newdomain.com.crt /etc/haproxy/certs/newdomain.com.key > /etc/haproxy/certs/newdomain.com.pem && systemctl reload haproxy"
```

3. Add to domain map (runtime, no restart needed):
```bash
echo "set map /etc/haproxy/maps/domains.map newdomain.com be_api" | socat stdio /var/run/haproxy.sock
```

Or edit `/etc/haproxy/maps/domains.map` and reload.

### Rate Limiting

Default: 100 requests per 10 seconds per IP.

Adjust in `haproxy.cfg`:
```
http-request deny deny_status 429 if { sc_http_req_rate(0) gt 100 }
```

### Health Checks

- HAProxy checks backends every 10 seconds
- Backend marked down after 3 consecutive failures
- Backend marked up after 2 consecutive successes

## Monitoring

### HAProxy Stats

- URL: `http://edge-ip:8404/stats`
- Prometheus metrics: `http://edge-ip:8404/metrics`

### Key Metrics

| Metric | Description |
|--------|-------------|
| `haproxy_frontend_current_sessions` | Active connections |
| `haproxy_frontend_http_requests_total` | Total requests |
| `haproxy_backend_http_responses_total` | Responses by status |
| `haproxy_backend_response_time_average_seconds` | Backend latency |

## Operations

### Reload Configuration

```bash
# Validate config
haproxy -c -f /etc/haproxy/haproxy.cfg

# Reload (zero downtime)
systemctl reload haproxy
```

### View Active Connections

```bash
echo "show stat" | socat stdio /var/run/haproxy.sock
```

### Runtime Map Updates

```bash
# Add domain
echo "set map /etc/haproxy/maps/domains.map api.newcustomer.com be_api" | socat stdio /var/run/haproxy.sock

# Remove domain
echo "del map /etc/haproxy/maps/domains.map api.oldcustomer.com" | socat stdio /var/run/haproxy.sock

# Show current mappings
echo "show map /etc/haproxy/maps/domains.map" | socat stdio /var/run/haproxy.sock
```

## Troubleshooting

### Certificate Issues

```bash
# Check cert expiry
echo | openssl s_client -connect localhost:443 -servername api.alternatefutures.ai 2>/dev/null | openssl x509 -noout -dates

# Force renewal
~/.acme.sh/acme.sh --renew -d api.alternatefutures.ai --force
```

### Backend Health

```bash
# Check backend status
echo "show servers state" | socat stdio /var/run/haproxy.sock

# Manually disable backend server
echo "disable server be_api/akash_api" | socat stdio /var/run/haproxy.sock

# Re-enable
echo "enable server be_api/akash_api" | socat stdio /var/run/haproxy.sock
```

### High Latency

1. Check backend health: `echo "show stat" | socat stdio /var/run/haproxy.sock`
2. Check Akash deployment logs
3. Verify network path to Akash ingress

## Future: Pingora Migration

See [PINGORA-MIGRATION.md](../docs/PINGORA-MIGRATION.md) for migration plan.

Migration triggers:
- HTTP/3 requirement
- Custom routing logic needed
- 100k+ RPS per node
- Rust developer available
