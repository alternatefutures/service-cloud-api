# Caddy SSL Gateway for Akash

A decentralized, open-source SSL termination solution using Caddy + Let's Encrypt on Akash Network.

## Architecture

```
                     Internet
                         │
                         ▼
              ┌──────────────────┐
              │   DNS (CNAME)    │
              │                  │
              │ api.domain.com   │──┐
              │ auth.domain.com  │──┤
              └──────────────────┘  │
                                    ▼
              ┌──────────────────────────────────┐
              │         Akash Network            │
              │                                  │
              │  ┌────────────────────────────┐  │
              │  │      Caddy Gateway         │  │
              │  │                            │  │
              │  │  • Let's Encrypt certs     │  │
              │  │  • SSL termination         │  │
              │  │  • Reverse proxy           │  │
              │  └─────────────┬──────────────┘  │
              │                │                 │
              │       ┌───────┴───────┐         │
              │       ▼               ▼         │
              │  ┌─────────┐    ┌──────────┐    │
              │  │   API   │    │   Auth   │    │
              │  │ Service │    │  Service │    │
              │  └─────────┘    └──────────┘    │
              └──────────────────────────────────┘
```

## Features

- **Free SSL certificates** via Let's Encrypt
- **Automatic renewal** - Caddy handles certificate lifecycle
- **Open source** - No vendor lock-in
- **Decentralized** - Runs entirely on Akash Network
- **Multi-tenant** - Can proxy to multiple backend services

## Quick Start

1. Deploy the gateway:
   ```bash
   npx tsx scripts/deploy-gateway.ts
   ```

2. Update DNS to point to the gateway

3. SSL certificates are automatically provisioned

## Configuration

Edit `gateway/Caddyfile` to add domains and backend services:

```caddyfile
your-domain.com {
    reverse_proxy your-backend-service:port
}
```

## For Customer Deployments

Use the deployment script with customer configuration:

```bash
npx tsx scripts/deploy-customer-gateway.ts --domain customer.com --backend https://their-service.ingress.akash.com
```
