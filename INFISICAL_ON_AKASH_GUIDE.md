# Infisical on Akash - Complete Implementation Guide

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  GitHub Actions                      │
│  ┌─────────────────────────────────────────────┐   │
│  │ 1. Decrypt bootstrap secrets (SOPS + age)   │   │
│  │ 2. Deploy Infisical + MongoDB to Akash      │   │
│  │ 3. Deploy application services               │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│              Akash Network (Audited Provider)        │
│                                                      │
│  ┌──────────────┐      ┌──────────────┐           │
│  │   MongoDB    │←─────│  Infisical   │           │
│  │ (Persistent) │      │ (Open Source)│           │
│  └──────────────┘      └──────┬───────┘           │
│                                │                    │
│                         ┌──────▼───────┐           │
│                         │  API Service │           │
│                         │ (Fetches     │           │
│                         │  secrets at  │           │
│                         │  runtime)    │           │
│                         └──────────────┘           │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────┐ │
│  │ YugabyteDB-1 │  │ YugabyteDB-2 │  │  IPFS   │ │
│  └──────────────┘  └──────────────┘  └─────────┘ │
└─────────────────────────────────────────────────────┘
```

**Trust Model:**

- ✅ Infisical code: Open source, auditable
- ✅ MongoDB: Open source, auditable
- ✅ Akash provider: Audited by official Akash auditor
- ⚠️ Bootstrap secrets: Encrypted with SOPS, age key in GitHub Secrets
- ✅ All other secrets: In Infisical, rotatable, auditable

## Phase 1: Prerequisites & Setup

### 1.1 Install Required Tools

```bash
# SOPS for encrypting bootstrap secrets
brew install sops

# Age for encryption keys
brew install age

# Infisical CLI
brew install infisical/get-cli/infisical

# Verify installations
sops --version
age --version
infisical --version
```

### 1.2 Generate Age Key (Bootstrap Encryption)

```bash
# Generate age key pair
age-keygen -o .age-key.txt

# Output will show:
# Public key: age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p
# (Keep the private key in .age-key.txt SECURE - never commit!)

# Save public key for SOPS config
export AGE_PUBLIC_KEY=$(grep "public key:" .age-key.txt | cut -d: -f2 | xargs)
echo "Age public key: $AGE_PUBLIC_KEY"

# Add private key to GitHub Secrets (MANUAL STEP)
# Go to: Settings → Secrets → Actions
# Name: AGE_SECRET_KEY
# Value: (contents of .age-key.txt)
cat .age-key.txt
```

### 1.3 Configure SOPS

```bash
# Create SOPS configuration
cat > .sops.yaml <<EOF
creation_rules:
  - path_regex: \.enc\.env$
    age: ${AGE_PUBLIC_KEY}
EOF

# Add to .gitignore
echo ".age-key.txt" >> .gitignore
echo "*.env" >> .gitignore
echo "!*.enc.env" >> .gitignore  # Allow encrypted files

git add .sops.yaml .gitignore
```

### 1.4 Generate Bootstrap Secrets

These are the ONLY secrets that need special protection:

```bash
# Generate strong random secrets
export INFISICAL_ENCRYPTION_KEY=$(openssl rand -hex 32)
export INFISICAL_JWT_SECRET=$(openssl rand -hex 32)
export MONGO_INITDB_ROOT_PASSWORD=$(openssl rand -hex 16)

# Create bootstrap secrets file
cat > bootstrap.env <<EOF
INFISICAL_ENCRYPTION_KEY=${INFISICAL_ENCRYPTION_KEY}
INFISICAL_JWT_SECRET=${INFISICAL_JWT_SECRET}
MONGO_INITDB_ROOT_PASSWORD=${MONGO_INITDB_ROOT_PASSWORD}
EOF

# Encrypt with SOPS
sops -e bootstrap.env > bootstrap.enc.env

# Verify encryption worked
cat bootstrap.enc.env
# Should see encrypted data, not plaintext!

# Delete plaintext (IMPORTANT!)
rm bootstrap.env

# Commit encrypted version (SAFE!)
git add bootstrap.enc.env
git commit -m "Add encrypted bootstrap secrets"
```

## Phase 2: Akash SDL Configuration

### 2.1 Create Infisical Deployment SDL

```bash
# Create new SDL for Infisical infrastructure
cat > deploy-infisical.yaml <<'EOF'
---
# Infisical Secrets Manager on Akash
version: "2.0"

services:
  # MongoDB - Backend for Infisical
  mongo:
    image: mongo:7
    env:
      - MONGO_INITDB_ROOT_USERNAME=admin
      - MONGO_INITDB_ROOT_PASSWORD=PLACEHOLDER_MONGO_PASSWORD
    expose:
      - port: 27017
        as: 27017
        to:
          - service: infisical
    params:
      storage:
        data:
          mount: /data/db
          readOnly: false

  # Infisical - Open Source Secrets Manager
  infisical:
    image: infisical/infisical:latest-postgres  # Use postgres variant for stability
    env:
      - ENCRYPTION_KEY=PLACEHOLDER_ENCRYPTION_KEY
      - JWT_SIGNUP_SECRET=PLACEHOLDER_JWT_SECRET
      - JWT_REFRESH_SECRET=PLACEHOLDER_JWT_SECRET
      - JWT_AUTH_SECRET=PLACEHOLDER_JWT_SECRET
      - JWT_SERVICE_SECRET=PLACEHOLDER_JWT_SECRET
      - MONGO_URL=mongodb://admin:PLACEHOLDER_MONGO_PASSWORD@mongo:27017/infisical?authSource=admin
      - SITE_URL=https://secrets.alternatefutures.ai
      - HTTPS_ENABLED=false  # Handled by Akash ingress
      - TELEMETRY_ENABLED=false  # Privacy
      - SMTP_HOST=smtp.resend.com
      - SMTP_PORT=587
      - SMTP_SECURE=false
      - SMTP_FROM_ADDRESS=noreply@alternatefutures.ai
      - SMTP_FROM_NAME=Alternate Futures
      # Leave SMTP credentials empty for now - will add via Infisical itself
    expose:
      - port: 8080
        as: 80
        to:
          - global: true
        accept:
          - secrets.alternatefutures.ai
      - port: 8080
        as: 8080
        to:
          - service: api
    depends_on:
      - mongo

profiles:
  compute:
    mongo:
      resources:
        cpu:
          units: 1.0
        memory:
          size: 2Gi
        storage:
          - name: data
            size: 20Gi

    infisical:
      resources:
        cpu:
          units: 1.0
        memory:
          size: 1Gi
        storage:
          size: 512Mi

  placement:
    dcloud:
      # REQUIRE AUDITED PROVIDERS
      signedBy:
        anyOf:
          - "akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63"
      attributes:
        host: akash
      pricing:
        mongo:
          denom: uakt
          amount: 25
        infisical:
          denom: uakt
          amount: 20

deployment:
  mongo:
    dcloud:
      profile: mongo
      count: 1

  infisical:
    dcloud:
      profile: infisical
      count: 1
EOF
```

### 2.2 Create Application SDL (Uses Infisical)

```bash
cat > deploy-mainnet-infisical.yaml <<'EOF'
---
# Production Deployment with Infisical for Secrets
version: "2.0"

services:
  # IPFS Node
  ipfs:
    image: ipfs/kubo:latest
    env:
      - IPFS_PROFILE=server
      - IPFS_PATH=/data/ipfs
    expose:
      - port: 8080
        as: 80
        to:
          - global: true
        accept:
          - ipfs.alternatefutures.ai
      - port: 4001
        as: 4001
        proto: tcp
        to:
          - global: true
    params:
      storage:
        data:
          mount: /data/ipfs
          readOnly: false

  # YugabyteDB Node 1
  yb-node-1:
    image: yugabytedb/yugabyte:2.20.1.0-b2
    command:
      - "/home/yugabyte/bin/yugabyted"
      - "start"
      - "--advertise_address=yb-node-1"
      - "--master_flags=replication_factor=3"
      - "--tserver_flags=ysql_enable_auth=true"
      - "--daemon=false"
    env:
      # Fetch YB password from Infisical at startup
      - INFISICAL_TOKEN=PLACEHOLDER_INFISICAL_SERVICE_TOKEN
      - YSQL_PASSWORD_SECRET_NAME=YSQL_PASSWORD
    expose:
      - port: 5433
        as: 5433
        to:
          - service: api
      - port: 7100
        as: 7100
        to:
          - service: yb-node-2
          - service: yb-node-3
      - port: 9100
        as: 9100
        to:
          - service: yb-node-2
          - service: yb-node-3
      - port: 15000
        as: 15000
        to:
          - global: true
        accept:
          - yb.alternatefutures.ai
    params:
      storage:
        data:
          mount: /mnt/disk0
          readOnly: false

  # YugabyteDB Node 2
  yb-node-2:
    image: yugabytedb/yugabyte:2.20.1.0-b2
    command:
      - "/home/yugabyte/bin/yugabyted"
      - "start"
      - "--advertise_address=yb-node-2"
      - "--join=yb-node-1"
      - "--master_flags=replication_factor=3"
      - "--tserver_flags=ysql_enable_auth=true"
      - "--daemon=false"
    env:
      - INFISICAL_TOKEN=PLACEHOLDER_INFISICAL_SERVICE_TOKEN
      - YSQL_PASSWORD_SECRET_NAME=YSQL_PASSWORD
    expose:
      - port: 5433
        as: 5433
        to:
          - service: api
      - port: 7100
        as: 7100
        to:
          - service: yb-node-1
          - service: yb-node-3
      - port: 9100
        as: 9100
        to:
          - service: yb-node-1
          - service: yb-node-3
    params:
      storage:
        data:
          mount: /mnt/disk0
          readOnly: false

  # YugabyteDB Node 3
  yb-node-3:
    image: yugabytedb/yugabyte:2.20.1.0-b2
    command:
      - "/home/yugabyte/bin/yugabyted"
      - "start"
      - "--advertise_address=yb-node-3"
      - "--join=yb-node-1"
      - "--master_flags=replication_factor=3"
      - "--tserver_flags=ysql_enable_auth=true"
      - "--daemon=false"
    env:
      - INFISICAL_TOKEN=PLACEHOLDER_INFISICAL_SERVICE_TOKEN
      - YSQL_PASSWORD_SECRET_NAME=YSQL_PASSWORD
    expose:
      - port: 5433
        as: 5433
        to:
          - service: api
      - port: 7100
        as: 7100
        to:
          - service: yb-node-1
          - service: yb-node-2
      - port: 9100
        as: 9100
        to:
          - service: yb-node-1
          - service: yb-node-2
    params:
      storage:
        data:
          mount: /mnt/disk0
          readOnly: false

  # API Service (fetches all secrets from Infisical)
  api:
    image: ghcr.io/alternatefutures/service-cloud-api:latest
    env:
      # Non-sensitive config
      - NODE_ENV=production
      - PORT=4000

      # Infisical connection (service token is rotatable)
      - INFISICAL_TOKEN=PLACEHOLDER_INFISICAL_SERVICE_TOKEN
      - INFISICAL_SITE_URL=https://secrets.alternatefutures.ai
      - INFISICAL_PROJECT_ID=PLACEHOLDER_PROJECT_ID
      - INFISICAL_ENVIRONMENT=production

      # All other secrets fetched from Infisical at runtime:
      # - DATABASE_URL
      # - JWT_SECRET
      # - RESEND_API_KEY
      # - ARWEAVE_WALLET
      # etc.
    expose:
      - port: 4000
        as: 80
        to:
          - global: true
        accept:
          - api.alternatefutures.ai
    depends_on:
      - yb-node-1
      - yb-node-2
      - yb-node-3
      - ipfs

profiles:
  compute:
    yb-node-1:
      resources:
        cpu:
          units: 2.0
        memory:
          size: 4Gi
        storage:
          - name: data
            size: 50Gi

    yb-node-2:
      resources:
        cpu:
          units: 2.0
        memory:
          size: 4Gi
        storage:
          - name: data
            size: 50Gi

    yb-node-3:
      resources:
        cpu:
          units: 2.0
        memory:
          size: 4Gi
        storage:
          - name: data
            size: 50Gi

    api:
      resources:
        cpu:
          units: 1.0
        memory:
          size: 1Gi
        storage:
          size: 512Mi

    ipfs:
      resources:
        cpu:
          units: 2.0
        memory:
          size: 4Gi
        storage:
          - name: data
            size: 100Gi

  placement:
    dcloud:
      signedBy:
        anyOf:
          - "akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63"
      attributes:
        host: akash
      pricing:
        yb-node-1:
          denom: uakt
          amount: 50
        yb-node-2:
          denom: uakt
          amount: 50
        yb-node-3:
          denom: uakt
          amount: 50
        api:
          denom: uakt
          amount: 30
        ipfs:
          denom: uakt
          amount: 70

deployment:
  yb-node-1:
    dcloud:
      profile: yb-node-1
      count: 1

  yb-node-2:
    dcloud:
      profile: yb-node-2
      count: 1

  yb-node-3:
    dcloud:
      profile: yb-node-3
      count: 1

  api:
    dcloud:
      profile: api
      count: 1

  ipfs:
    dcloud:
      profile: ipfs
      count: 1
EOF
```

## Phase 3: Application Integration

### 3.1 Update package.json

```bash
cd /path/to/service-cloud-api
npm install @infisical/sdk
```

### 3.2 Create Infisical Config Module

```typescript
// src/config/infisical.ts
import { InfisicalClient, LogLevel } from '@infisical/sdk'

let client: InfisicalClient | null = null
let secretsCache: Record<string, string> = {}

export async function initInfisical() {
  if (process.env.INFISICAL_TOKEN) {
    console.log('🔐 Initializing Infisical client...')

    client = new InfisicalClient({
      siteUrl:
        process.env.INFISICAL_SITE_URL || 'https://secrets.alternatefutures.ai',
      auth: {
        universalAuth: {
          clientId: process.env.INFISICAL_CLIENT_ID!,
          clientSecret: process.env.INFISICAL_CLIENT_SECRET!,
        },
      },
      logLevel: LogLevel.Error,
    })

    // Fetch all secrets
    const secrets = await client.listSecrets({
      environment: process.env.INFISICAL_ENVIRONMENT || 'production',
      projectId: process.env.INFISICAL_PROJECT_ID!,
    })

    // Cache in memory
    secrets.forEach(secret => {
      secretsCache[secret.secretKey] = secret.secretValue
      // Inject into process.env for compatibility
      process.env[secret.secretKey] = secret.secretValue
    })

    console.log(`✅ Loaded ${secrets.length} secrets from Infisical`)
  } else {
    console.log('⚠️  No INFISICAL_TOKEN found, using local .env file')
    // Fall back to .env for local development
    require('dotenv').config()
  }
}

export function getSecret(key: string): string {
  const value = secretsCache[key] || process.env[key]
  if (!value) {
    throw new Error(`Secret ${key} not found in Infisical or environment`)
  }
  return value
}

export async function refreshSecrets() {
  if (client) {
    console.log('🔄 Refreshing secrets from Infisical...')
    await initInfisical()
  }
}

// Refresh secrets every hour
if (process.env.NODE_ENV === 'production') {
  setInterval(
    () => {
      refreshSecrets().catch(console.error)
    },
    60 * 60 * 1000
  ) // 1 hour
}
```

### 3.3 Update Main Entry Point

```typescript
// src/index.ts
import { initInfisical } from './config/infisical'

async function bootstrap() {
  // Initialize Infisical FIRST
  await initInfisical()

  // Now all secrets are available in process.env
  const databaseUrl = process.env.DATABASE_URL
  const jwtSecret = process.env.JWT_SECRET
  // etc.

  // Start your application
  await startServer()
}

bootstrap().catch(error => {
  console.error('Failed to bootstrap application:', error)
  process.exit(1)
})
```

## Phase 4: GitHub Actions Workflow

### 4.1 Deploy Infisical Workflow

```yaml
# .github/workflows/deploy-infisical.yml
name: Deploy Infisical to Akash

on:
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Install SOPS
        run: |
          curl -LO https://github.com/getsops/sops/releases/download/v3.8.1/sops-v3.8.1.linux.amd64
          sudo mv sops-v3.8.1.linux.amd64 /usr/local/bin/sops
          sudo chmod +x /usr/local/bin/sops

      - name: Decrypt bootstrap secrets
        env:
          SOPS_AGE_KEY: ${{ secrets.AGE_SECRET_KEY }}
        run: |
          sops -d bootstrap.enc.env > bootstrap.env
          source bootstrap.env

          echo "INFISICAL_ENCRYPTION_KEY=$INFISICAL_ENCRYPTION_KEY" >> $GITHUB_ENV
          echo "INFISICAL_JWT_SECRET=$INFISICAL_JWT_SECRET" >> $GITHUB_ENV
          echo "MONGO_INITDB_ROOT_PASSWORD=$MONGO_INITDB_ROOT_PASSWORD" >> $GITHUB_ENV

      - name: Install Akash CLI
        run: |
          cd /tmp
          curl -sfL "https://github.com/akash-network/node/releases/download/v1.0.2/akash_1.0.2_linux_amd64.zip" -o akash.zip
          unzip akash.zip
          sudo mv akash /usr/local/bin/
          chmod +x /usr/local/bin/akash

      - name: Setup Akash wallet
        env:
          AKASH_KEYRING_BACKEND: test
          AKASH_KEY_NAME: deploy
          AKASH_MNEMONIC: ${{ secrets.AKASH_MNEMONIC }}
        run: |
          echo "$AKASH_MNEMONIC" | akash keys add $AKASH_KEY_NAME --recover --keyring-backend test
          AKASH_ADDRESS=$(akash keys show $AKASH_KEY_NAME -a --keyring-backend test)
          echo "AKASH_ADDRESS=$AKASH_ADDRESS" >> $GITHUB_ENV

      - name: Inject secrets into SDL
        run: |
          sed -i "s/PLACEHOLDER_ENCRYPTION_KEY/${{ env.INFISICAL_ENCRYPTION_KEY }}/g" deploy-infisical.yaml
          sed -i "s/PLACEHOLDER_JWT_SECRET/${{ env.INFISICAL_JWT_SECRET }}/g" deploy-infisical.yaml
          sed -i "s/PLACEHOLDER_MONGO_PASSWORD/${{ env.MONGO_INITDB_ROOT_PASSWORD }}/g" deploy-infisical.yaml

      - name: Deploy to Akash
        env:
          AKASH_NODE: https://rpc.akashnet.net:443
          AKASH_CHAIN_ID: akashnet-2
          AKASH_KEYRING_BACKEND: test
          AKASH_KEY_NAME: deploy
        run: |
          # Create deployment
          akash tx deployment create deploy-infisical.yaml \
            --from $AKASH_KEY_NAME \
            --keyring-backend test \
            --node $AKASH_NODE \
            --chain-id $AKASH_CHAIN_ID \
            --gas-prices 0.025uakt \
            --gas auto \
            --gas-adjustment 1.5 \
            -y

          # Wait for bids
          sleep 30

          # Accept lowest bid (or implement selection logic)
          # ... (similar to existing deploy-akash.yml)

      - name: Output Infisical URL
        run: |
          echo "Infisical deployed! Access at: https://secrets.alternatefutures.ai"
          echo "Configure DNS A record to point to provider IP"
```

## Phase 5: Initial Setup & Testing

### 5.1 First-Time Infisical Setup

After deploying Infisical:

1. **Access Infisical UI**: https://secrets.alternatefutures.ai
2. **Create admin account** (first signup becomes admin)
3. **Create organization**: "Alternate Futures"
4. **Create project**: "service-cloud-api"
5. **Create environments**: development, staging, production

### 5.2 Add Secrets to Infisical

```bash
# Login via CLI
infisical login --domain https://secrets.alternatefutures.ai

# Select project
infisical init

# Add secrets
infisical secrets set DATABASE_URL "postgresql://yugabyte:password@yb-node-1:5433/alternatefutures" --env production
infisical secrets set JWT_SECRET "your-jwt-secret-min-32-chars" --env production
infisical secrets set RESEND_API_KEY "re_xxxx" --env production
infisical secrets set YSQL_PASSWORD "yugabyte-password" --env production
# ... add all secrets
```

### 5.3 Generate Service Token

```bash
# Create service token for API service
infisical service-token create \
  --name "api-production" \
  --project "service-cloud-api" \
  --environment "production" \
  --expiry "30d"

# Output: st.xxx.yyy.zzz

# Add to GitHub Secrets
# Name: INFISICAL_SERVICE_TOKEN
# Value: st.xxx.yyy.zzz
```

## Phase 6: Operational Procedures

### 6.1 Secret Rotation Schedule

```bash
# Every 30 days: Rotate service tokens
infisical service-token revoke <old-token-id>
infisical service-token create --name "api-production-$(date +%Y%m)" ...

# Every 90 days: Rotate sensitive secrets
infisical secrets set DATABASE_URL "new-value" --env production
# Redeploy services to pick up new secrets

# Annually: Rotate bootstrap secrets (ENCRYPTION_KEY, JWT_SECRET)
# Requires Infisical migration/re-encryption
```

### 6.2 Backup Procedures

```bash
# Backup MongoDB (Infisical data)
kubectl exec -it mongo-pod -- mongodump --out /backup
# Download backup from Akash provider
# Encrypt and store on Arweave

# Backup secrets (encrypted export)
infisical secrets export --env production --format json > secrets.json
sops -e secrets.json > secrets.enc.json
# Store encrypted backup on Arweave
```

### 6.3 Disaster Recovery

If Akash deployment fails:

1. **Redeploy Infisical** from `deploy-infisical.yaml`
2. **Restore MongoDB** from encrypted backup
3. **Verify secrets** accessible via Infisical UI
4. **Regenerate service tokens** if compromised
5. **Redeploy application** services

## Cost Analysis

### Infisical Infrastructure on Akash

```
MongoDB: 25 uakt/block
Infisical: 20 uakt/block
Total: 45 uakt/block = ~19 AKT/month = ~$12/month

Full stack with Infisical:
- Infisical: 45 uakt/block
- YugabyteDB (3 nodes): 150 uakt/block
- API: 30 uakt/block
- IPFS: 70 uakt/block
Total: ~295 uakt/block = ~127 AKT/month = ~$76/month

VS Doppler: $0/month (free tier) or $12/month (paid)

Trade-off: Pay ~$12/month more, get:
✅ Full control (open source)
✅ No corporate dependency
✅ Self-hosted on decentralized infrastructure
✅ Auditable
```

## Security Checklist

Before going to production:

- [ ] Age key stored ONLY in GitHub Secrets (not in repo)
- [ ] Bootstrap secrets encrypted with SOPS (bootstrap.enc.env committed)
- [ ] Plaintext bootstrap.env DELETED (never committed)
- [ ] Infisical deployed on audited Akash provider
- [ ] MongoDB has persistent storage enabled
- [ ] Infisical admin account created with strong password
- [ ] Service tokens generated with 30-day expiry
- [ ] All application secrets added to Infisical
- [ ] Application integrated with Infisical SDK
- [ ] Tested secret refresh (automatic hourly)
- [ ] DNS configured for secrets.alternatefutures.ai
- [ ] Encrypted backups scheduled
- [ ] Rotation schedule documented

## Troubleshooting

### Issue: Infisical won't start

```bash
# Check MongoDB connection
kubectl logs infisical-pod

# Verify MONGO_URL is correct
echo $MONGO_URL

# Check MongoDB is running
kubectl exec mongo-pod -- mongosh --eval "db.adminCommand('ping')"
```

### Issue: API can't fetch secrets

```bash
# Verify service token is valid
infisical service-token list

# Check token permissions
# Ensure environment matches (production vs development)

# Test token manually
export INFISICAL_TOKEN=st.xxx.yyy.zzz
infisical secrets list --env production
```

### Issue: Secrets not refreshing

```bash
# Check refresh interval (default 1 hour)
# Force refresh by restarting API service

# Or add webhook for instant updates:
infisical webhooks create \
  --url https://api.alternatefutures.ai/webhooks/secrets-updated
```

---

## Next Steps

1. ✅ Complete Phase 1 (Prerequisites & Setup)
2. ✅ Complete Phase 2 (SDL Configuration)
3. ✅ Complete Phase 3 (Application Integration)
4. ✅ Complete Phase 4 (GitHub Actions Workflow)
5. ✅ Execute: Deploy Infisical to Akash
6. ✅ Execute: Configure Infisical with secrets
7. ✅ Execute: Deploy application services
8. ✅ Test: Verify end-to-end functionality

**Ready to execute!** 🚀
