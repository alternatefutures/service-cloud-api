# Decentralized Status Page

A fully decentralized status monitoring solution using IPFS + Arweave.

## Architecture

```
GitHub Actions (every 5 min)
  ↓
Check service health
  ↓
Upload status.json to IPFS
  ↓
Update IPFS CID in HTML
  ↓
Deploy HTML to Arweave (permanent)
  ↓
Users view at: https://status.arweave.net/YOUR_TX_ID
```

## Features

- ✅ **Fully Decentralized**: No centralized monitoring services
- ✅ **Zero Downtime**: Arweave hosting = permanent availability
- ✅ **Real-time Updates**: Status data refreshed on IPFS every 5 min
- ✅ **Cost Effective**: One-time Arweave payment, IPFS updates are cheap
- ✅ **DePIN Native**: Uses your existing infrastructure

## Setup

### 1. Deploy Status Page to Arweave

```bash
# Install Arweave CLI
npm install -g arweave-deploy

# Deploy the status page (one-time)
arweave deploy index.html --key-file wallet.json

# Output: https://arweave.net/YOUR_TX_ID
```

### 2. Automate Status Updates

Add to `.github/workflows/update-status.yml`:

```yaml
name: Update Status Page

on:
  schedule:
    - cron: '*/5 * * * *'  # Every 5 minutes
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check service health
        run: |
          cd status-page
          ./update-status.sh

      - name: Upload to IPFS
        run: |
          IPFS_CID=$(curl -X POST \
            -F file=@status-page/status.json \
            https://ipfs.alternatefutures.ai:5001/api/v0/add?pin=true \
            | jq -r '.Hash')
          echo "IPFS_CID=$IPFS_CID" >> $GITHUB_ENV

      - name: Update HTML with new CID
        run: |
          sed -i "s/YOUR_IPFS_CID_HERE/$IPFS_CID/g" status-page/index.html

      - name: Optional: Redeploy to Arweave
        # Only if you want to update the Arweave version
        # Usually not needed - IPFS CID update is enough
        run: |
          echo "Skipping Arweave redeploy (status updates via IPFS)"
```

### 3. Manual Updates

```bash
# Check services and update status
cd status-page
./update-status.sh

# Deploy to Arweave (initial setup)
arweave deploy index.html
```

## Monitoring Stack

### Current: IPFS + Arweave (Lightweight)

- Status data: IPFS (updated every 5 min)
- Status page: Arweave (permanent, immutable)
- Perfect for: Public status pages

### Optional: Add Grafana + Prometheus (Full Observability)

If you want metrics, dashboards, and alerts, add to `deploy-mainnet.yaml`:

```yaml
grafana:
  image: grafana/grafana:latest
  expose:
    - port: 3000
      to:
        - global: true
      accept:
        - metrics.alternatefutures.ai

prometheus:
  image: prom/prometheus:latest
  expose:
    - port: 9090
      to:
        - service: grafana
```

**Cost**: +~20 AKT/month for Grafana + Prometheus

## Alternative: Log Errors to YugabyteDB

```typescript
// In your API
app.use((err, req, res, next) => {
  // Log to database
  await db.errors.create({
    message: err.message,
    stack: err.stack,
    timestamp: new Date(),
    path: req.path,
  })

  // Optionally pin critical errors to IPFS
  if (err.severity === 'critical') {
    const cid = await ipfs.add(JSON.stringify(err))
    await db.errors.update({ id: err.id, ipfsCid: cid })
  }

  res.status(500).json({ error: 'Internal server error' })
})
```

Query errors:

```sql
SELECT * FROM errors
WHERE timestamp > NOW() - INTERVAL '1 hour'
ORDER BY timestamp DESC;
```

## Deployment Checklist

- [ ] Deploy status page to Arweave
- [ ] Set up GitHub Actions for auto-updates
- [ ] Configure DNS: `status.alternatefutures.ai` → Arweave gateway
- [ ] Test IPFS status updates
- [ ] Optional: Add Grafana/Prometheus
- [ ] Optional: Set up error logging to YugabyteDB

## No Sentry Needed!

This gives you:

- ✅ Public status page (Arweave)
- ✅ Real-time health checks (IPFS)
- ✅ Error logging (YugabyteDB)
- ✅ Metrics (optional Grafana)
- ✅ 100% decentralized
- ✅ No monthly SaaS fees

Skip the `SENTRY_DSN` secret entirely!
