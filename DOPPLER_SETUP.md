# Doppler Secrets Manager Setup Guide

Quick guide to set up Doppler for secure Akash deployments.

## Why Doppler?

✅ **Free tier** (unlimited secrets, 5 projects)
✅ **Easy to use** (simpler than Vault)
✅ **Audit logs** (see who accessed secrets)
✅ **Token rotation** (revoke and create new tokens)
✅ **No code changes** (injects env vars automatically)

## Setup Steps

### 1. Create Doppler Account

```bash
# Visit https://doppler.com and sign up (free)
# Or use CLI:
curl -Ls https://cli.doppler.com/install.sh | sh
doppler login
```

### 2. Create Project

```bash
# In your project directory
cd /path/to/service-cloud-api
doppler setup

# Choose:
# - Project: alternatefutures-api (or create new)
# - Config: production
```

### 3. Add Secrets

```bash
# Add all production secrets
doppler secrets set DATABASE_URL "postgresql://user:pass@db.supabase.co:5432/postgres"
doppler secrets set JWT_SECRET "your-super-secret-jwt-key-min-32-chars"
doppler secrets set RESEND_API_KEY "re_xxxxxxxxxxxx"
doppler secrets set SUPABASE_URL "https://xxx.supabase.co"
doppler secrets set SUPABASE_SERVICE_KEY "eyJxxx..."
doppler secrets set IPFS_GATEWAY_URL "https://ipfs.alternatefutures.ai"

# Optional secrets
doppler secrets set ARWEAVE_WALLET "your-arweave-wallet-json"
doppler secrets set SENTRY_DSN "https://xxx@sentry.io/xxx"
doppler secrets set FILECOIN_RPC_URL "https://api.node.glif.io/rpc/v0"
```

### 4. Generate Service Token for Akash

```bash
# Create a token that expires in 30 days
doppler configs tokens create akash-production \
  --project alternatefutures-api \
  --config production \
  --max-age 30d

# Output: dp.st.production.xxxxxxxxxxxx

# Copy this token - you'll add it to deploy-mainnet-secure.yaml
```

### 5. Update Application Code

**Install Doppler SDK** (if using Node.js injection):

```bash
npm install @doppler/node-sdk
```

**Option A: Use Doppler SDK (Recommended)**

```typescript
// src/index.ts (or src/config.ts)
import { config } from 'dotenv'

// Check if running on Akash (has Doppler token)
if (process.env.DOPPLER_TOKEN) {
  console.log('🔐 Loading secrets from Doppler...')
  require('@doppler/node-sdk').setup({
    // Secrets auto-injected as process.env.XXX
  })
} else {
  // Local development - use .env file
  console.log('🔐 Loading secrets from .env file...')
  config()
}

// Now use secrets as normal
const jwtSecret = process.env.JWT_SECRET!
const databaseUrl = process.env.DATABASE_URL!
```

**Option B: Use Doppler CLI (Alternative)**

```dockerfile
# Add to Dockerfile (if you prefer CLI approach)
RUN curl -Ls https://cli.doppler.com/install.sh | sh

# Update CMD to use Doppler
CMD ["doppler", "run", "--", "node", "dist/index.js"]
```

### 6. Test Locally

```bash
# Run app with Doppler secrets
doppler run -- npm run dev

# Or with specific config
doppler run --config production -- npm start
```

### 7. Update Akash SDL

```yaml
# deploy-mainnet-secure.yaml
api:
  env:
    - NODE_ENV=production
    - PORT=4000
    - DOPPLER_TOKEN=dp.st.production.xxxxxxxxxxxx # Replace with actual token
    # All other secrets fetched from Doppler!
```

### 8. Deploy to Akash

```bash
# Update the SDL with your Doppler token
# Then deploy (via GitHub Actions or CLI)
akash tx deployment create deploy-mainnet-secure.yaml ...
```

## Security Best Practices

### Token Rotation (Every 30 Days)

```bash
# 1. Create new token
doppler configs tokens create akash-production-2 --max-age 30d

# 2. Update SDL with new token
# 3. Redeploy to Akash
# 4. Delete old token
doppler configs tokens revoke akash-production
```

### Audit Logs

```bash
# View who accessed secrets
doppler activity

# View specific secret access
doppler activity --secret DATABASE_URL
```

### Least Privilege

```bash
# Create read-only token (can't modify secrets)
doppler configs tokens create akash-prod-readonly \
  --max-age 30d \
  --read-only
```

## Environment-Specific Configs

Doppler supports multiple environments (dev, staging, prod):

```bash
# Create configs
doppler configs create development
doppler configs create staging
doppler configs create production

# Set different secrets per environment
doppler secrets set DATABASE_URL "postgres://localhost/dev" --config development
doppler secrets set DATABASE_URL "postgres://staging.db/db" --config staging
doppler secrets set DATABASE_URL "postgres://prod.db/db" --config production

# Use different tokens per environment
doppler configs tokens create akash-staging --config staging
doppler configs tokens create akash-production --config production
```

## Troubleshooting

### Issue: Secrets not loading

```bash
# Check if Doppler token is valid
doppler secrets --token dp.st.production.xxx

# Check if SDK is installed
npm list @doppler/node-sdk

# Check logs
console.log('DOPPLER_TOKEN:', process.env.DOPPLER_TOKEN ? 'present' : 'missing');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'loaded' : 'missing');
```

### Issue: Token expired

```bash
# Tokens expire after max-age
# Create new token and update SDL
doppler configs tokens create akash-prod-new --max-age 30d

# Update deploy-mainnet-secure.yaml with new token
# Redeploy
```

### Issue: Rate limiting

```bash
# Doppler free tier limits:
# - 1000 API calls/hour
# - If exceeding, cache secrets locally

# Use Doppler's automatic retry with backoff
require('@doppler/node-sdk').setup({
  retry: {
    maxAttempts: 3,
    backoff: 2000, // 2 seconds
  },
});
```

## Cost

**Free Tier** (enough for most projects):

- Unlimited secrets
- 5 projects
- 5 configs per project
- Unlimited team members
- 90-day secret history
- Basic support

**Paid Plans** (if you need more):

- $12/month - 20 projects
- $36/month - Unlimited projects + advanced features

## Alternative: Infisical (Open Source)

If you prefer self-hosted:

```bash
# Deploy Infisical to your own infrastructure
docker run -d -p 8080:8080 infisical/infisical

# Use similar workflow
infisical init
infisical secrets set DATABASE_URL "xxx"
infisical run -- node dist/index.js
```

## Migration from .env

```bash
# Import existing .env file to Doppler
doppler secrets upload .env

# Or import one by one
cat .env | while read line; do
  if [[ $line =~ ^([^#][^=]+)=(.+)$ ]]; then
    KEY="${BASH_REMATCH[1]}"
    VALUE="${BASH_REMATCH[2]}"
    doppler secrets set "$KEY" "$VALUE"
  fi
done
```

## Next Steps

1. ✅ Set up Doppler account
2. ✅ Add all production secrets
3. ✅ Generate service token (30-day expiration)
4. ✅ Update application code to use Doppler
5. ✅ Test locally with `doppler run`
6. ✅ Update deploy-mainnet-secure.yaml with token
7. ✅ Deploy to Akash
8. ✅ Set calendar reminder to rotate token in 30 days

---

**Links**:

- [Doppler Dashboard](https://dashboard.doppler.com/)
- [Doppler Docs](https://docs.doppler.com/)
- [Doppler Node.js SDK](https://docs.doppler.com/docs/nodejs)
- [Doppler CLI Reference](https://docs.doppler.com/docs/cli)
