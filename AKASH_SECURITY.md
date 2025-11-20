# Akash Deployment Security Analysis

## Executive Summary

⚠️ **CRITICAL**: Akash deployments have significant security implications that require careful architecture to mitigate.

## Security Model

### What Providers Can Access

Akash providers have **FULL ACCESS** to:

1. ✅ **Deployment Manifest (SDL)** - Stored publicly on blockchain
2. ✅ **All Environment Variables** - Visible in SDL and container runtime
3. ✅ **Container Filesystem** - Root access to all containers
4. ✅ **Container Logs** - All stdout/stderr output
5. ✅ **Persistent Volumes** - All data stored in volumes
6. ✅ **Network Traffic** - Can intercept/inspect traffic
7. ✅ **Execute Commands** - Can exec into running containers

### Trust Model

**You must trust the provider** not to:

- Steal secrets (database passwords, API keys, private keys)
- Exfiltrate user data
- Modify application behavior
- Log sensitive information

**There is NO cryptographic isolation** between your application and the provider.

## Current Security Issues

### 🚨 Issue 1: Secrets in SDL (CRITICAL)

**File**: `deploy-mainnet.yaml`

**Problem**: All secrets are visible on the blockchain:

```yaml
env:
  - YSQL_PASSWORD=your_secure_password_here_change_this # PUBLIC!
  - JWT_SECRET=your_jwt_secret_min_32_chars... # PUBLIC!
  - RESEND_API_KEY=your_resend_api_key # PUBLIC!
  - ARWEAVE_WALLET=your_arweave_wallet # PUBLIC!
  - FILECOIN_WALLET_KEY=your_filecoin_wallet_key # PUBLIC!
```

**Impact**:

- Anyone can query the blockchain and see these secrets
- Providers have permanent access to these credentials
- Rotating secrets requires updating SDL and redeploying

**Who Can See**:

- ❌ Public (blockchain is queryable)
- ❌ All Akash providers (not just yours)
- ❌ GitHub (if SDL is committed)

### 🟡 Issue 2: Data at Rest

**Problem**: YugabyteDB data is stored on provider's infrastructure

**Impact**:

- Provider can access database files directly
- All user data, API keys, sessions visible to provider
- No encryption at rest (YugabyteDB default config)

### 🟡 Issue 3: Provider Reputation

**Problem**: No cryptographic guarantees about provider behavior

**Impact**:

- Must rely on reputation system
- No recourse if provider steals data
- Provider could be compromised by attackers

## Docker Image Security ✅

**Good news**: Your Docker images are SAFE to publish publicly.

### Dockerfile Analysis

✅ **SECURE**:

- Multi-stage build (no build artifacts leaked)
- No secrets in build args
- No environment variables baked in
- Runs as non-root user (nodejs:1001)
- No .env files copied (.dockerignore configured)
- Only copies necessary files

✅ **Safe to publish to public registries** (Docker Hub, GHCR)

## Recommended Solutions

### Solution 1: External Secrets Manager (Recommended)

**Use a secrets manager that containers fetch from at runtime.**

#### Option A: Doppler (Easiest)

```yaml
# deploy-mainnet.yaml
env:
  # Only expose Doppler token (rotatable)
  - DOPPLER_TOKEN=dp.st.xxxx # Single secret, easy to rotate

# Application fetches secrets at startup
# No secrets in SDL except the Doppler token
```

**Pros**:

- Secrets not visible on blockchain (only Doppler token)
- Easy rotation (revoke token, create new one)
- Audit logs of secret access
- Free tier available

**Cons**:

- Still requires trusting provider (they can steal Doppler token)
- Dependency on external service

#### Option B: HashiCorp Vault

```yaml
env:
  - VAULT_ADDR=https://your-vault.com
  - VAULT_TOKEN=hvs.xxxx # Renewable token with limited scope
  - VAULT_NAMESPACE=alternatefutures
```

**Pros**:

- Enterprise-grade security
- Fine-grained access control
- Token renewal and revocation
- Self-hostable

**Cons**:

- More complex setup
- Still vulnerable if provider steals token

#### Option C: Infisical (Open Source)

```yaml
env:
  - INFISICAL_TOKEN=st.xxxx.xxxx
  - INFISICAL_PROJECT_ID=xxxx
```

**Pros**:

- Open source
- Can self-host
- Good developer experience

### Solution 2: Managed Services for Sensitive Data

**Move sensitive data OFF Akash.**

#### Database: Use Managed PostgreSQL

Instead of YugabyteDB on Akash:

```yaml
# Don't deploy database on Akash
# Use managed service instead
env:
  - DATABASE_URL=postgresql://user:pass@db.supabase.co/postgres
```

**Options**:

- **Supabase** (free tier, PostgreSQL + Auth + Storage)
- **Neon** (serverless PostgreSQL, free tier)
- **Render PostgreSQL** (free tier)
- **Railway** (PostgreSQL, $5/month)

**Pros**:

- Database not accessible to Akash provider
- Professional backups and monitoring
- Better performance
- No data loss if Akash deployment fails

**Cons**:

- External dependency
- Potential cost (though free tiers exist)
- Database URL still visible in SDL

#### Authentication: Use Managed Auth

Instead of custom auth service on Akash:

```yaml
# Use Supabase Auth, Clerk, or Auth0
env:
  - SUPABASE_URL=https://xxx.supabase.co
  - SUPABASE_ANON_KEY=eyJxxx # Safe to expose publicly
```

**Options**:

- **Supabase Auth** (free, includes database)
- **Clerk** (free tier, great DX)
- **Auth0** (free tier)

**Pros**:

- No auth secrets on Akash
- Professional security team
- Better features (2FA, OAuth, etc.)

### Solution 3: Application-Level Encryption

**Encrypt sensitive data before storing.**

```typescript
// Encrypt sensitive fields before storing in database
import { encrypt, decrypt } from './crypto'

// Master key stored in Doppler/Vault (NOT in SDL)
const MASTER_KEY = process.env.MASTER_KEY

// Encrypt user data
const encryptedEmail = encrypt(user.email, MASTER_KEY)
await db.users.create({ email: encryptedEmail })

// Decrypt when reading
const user = await db.users.findUnique({ id })
user.email = decrypt(user.email, MASTER_KEY)
```

**Pros**:

- Database compromise doesn't expose plaintext data
- Provider can't read sensitive fields

**Cons**:

- Cannot query encrypted fields
- Performance overhead
- Key management complexity

### Solution 4: Hybrid Architecture (Best Practice)

**Use Akash for compute, managed services for data.**

```
┌─────────────────────────────────────┐
│         Akash (Compute Only)        │
│  ┌──────────┐      ┌──────────┐   │
│  │   API    │      │   IPFS   │   │
│  │ Service  │      │  Gateway │   │
│  └────┬─────┘      └──────────┘   │
└───────┼──────────────────────────────┘
        │
        │ (Connects to managed services)
        │
        ├─────────────► Supabase (Database + Auth)
        ├─────────────► Doppler (Secrets)
        ├─────────────► Cloudflare R2 (Storage)
        └─────────────► Resend (Email)
```

**Benefits**:

- Minimal secrets on Akash (only service API keys)
- Sensitive data in professionally managed infrastructure
- Easy to migrate away from Akash if needed
- Better security posture

## Implementation Plan

### Phase 1: Immediate Security Fixes (Required Before Public Deployment)

1. **Remove hardcoded secrets from SDL**
   - Never commit real secrets to Git
   - Use placeholders only

2. **Set up Doppler (or alternative)**

   ```bash
   # Install Doppler CLI
   curl -Ls https://cli.doppler.com/install.sh | sh

   # Create project
   doppler setup

   # Add secrets
   doppler secrets set JWT_SECRET="your-secret-here"
   doppler secrets set DATABASE_URL="postgresql://..."

   # Generate service token for Akash
   doppler configs tokens create akash-production --max-age 30d
   ```

3. **Update application to use Doppler**

   ```typescript
   // src/config.ts
   import { config } from 'dotenv'

   // Load from Doppler (or fallback to .env for local dev)
   if (process.env.DOPPLER_TOKEN) {
     // Doppler SDK will auto-inject secrets as env vars
     require('@doppler/node-sdk').setup()
   } else {
     config() // Load from .env for local development
   }

   export const CONFIG = {
     jwtSecret: process.env.JWT_SECRET!,
     databaseUrl: process.env.DATABASE_URL!,
     resendApiKey: process.env.RESEND_API_KEY!,
   }
   ```

4. **Update deploy-mainnet.yaml**
   ```yaml
   env:
     # Only Doppler token (rotate every 30 days)
     - DOPPLER_TOKEN=dp.st.dev.xxxx
     - NODE_ENV=production
     - PORT=4000
     # All other secrets fetched from Doppler
   ```

### Phase 2: Move to Managed Database (Recommended)

1. **Sign up for Supabase** (free tier)
   - Create project: alternatefutures-prod
   - Get DATABASE_URL from settings
   - Enable Row Level Security (RLS)

2. **Update SDL to use Supabase**

   ```yaml
   # Remove YugabyteDB services (yb-node-1, yb-node-2, yb-node-3)

   api:
     env:
       - DOPPLER_TOKEN=dp.st.xxxx # Doppler has DATABASE_URL
   ```

3. **Savings**:
   - Remove 3x YugabyteDB nodes = ~150 AKT/month saved
   - Better security (database not on Akash)
   - Professional backups

### Phase 3: Provider Selection

**Choose reputable providers**:

1. **Check provider reputation**
   - Cloudmos Akash Provider Stats
   - Uptime history
   - Community reviews

2. **Recommended providers** (as of 2024):
   - Akash Network Foundation providers
   - Praetor providers (audited)
   - Avoid unknown/new providers for production

3. **Diversify** (if critical):
   - Deploy to multiple providers
   - Use load balancer (Cloudflare)

### Phase 4: Monitoring & Auditing

1. **Secret rotation schedule**
   - Doppler tokens: 30 days
   - Database passwords: 90 days
   - API keys: 90 days

2. **Monitoring**
   - Doppler audit logs (who accessed secrets)
   - Database query logs (unusual access patterns)
   - Container restart alerts (provider issues)

3. **Incident response plan**
   - If provider suspected compromised: rotate ALL secrets
   - If data breach: notify users, rotate tokens
   - Maintain off-Akash backups

## Security Checklist

Before deploying to production:

- [ ] Remove all hardcoded secrets from SDL
- [ ] Set up Doppler (or equivalent) secrets manager
- [ ] Update application to fetch secrets from Doppler
- [ ] Configure .env files in .dockerignore (already done ✅)
- [ ] Ensure Dockerfile doesn't bake in secrets (already done ✅)
- [ ] Consider managed database (Supabase/Neon)
- [ ] Choose reputable Akash provider
- [ ] Set up monitoring and alerting
- [ ] Create secret rotation schedule
- [ ] Document incident response plan
- [ ] Test deployment with placeholder secrets first
- [ ] Perform security review before going live

## FAQ

### Q: Are Docker images safe to make public?

**A: YES**, your Docker images are safe to publish publicly because:

- No secrets baked into image
- No .env files included
- Multi-stage build (no build artifacts)
- .dockerignore properly configured

### Q: Can providers steal my secrets?

**A: YES**, providers can access:

- All env vars in SDL
- All container processes and memory
- All files in containers
- All data in volumes

**Mitigation**: Use secrets manager (Doppler), minimize secrets in SDL, rotate frequently.

### Q: Should I encrypt data in the database?

**A: YES** for sensitive fields:

- User PII (email, phone, address)
- Payment information
- Private keys/wallets
- API keys/tokens

**A: NO** for non-sensitive data:

- Public profile information
- IPFS CIDs
- Timestamps
- IDs

### Q: What if the provider is compromised?

**A: Assume breach**:

1. Rotate ALL secrets immediately
2. Audit database for unauthorized access
3. Check logs for data exfiltration
4. Migrate to new provider
5. Notify users if data was accessed

### Q: Can I trust Akash for production?

**A: Depends on threat model**:

**Safe for**:

- Public data/services
- Stateless applications
- IPFS gateways
- CDN/proxies
- Development/testing

**Risky for**:

- User credentials/PII
- Financial data
- Private keys/wallets
- HIPAA/SOC2 compliance

**Best practice**: Hybrid architecture (Akash for compute, managed services for data)

## Additional Resources

- [Doppler Documentation](https://docs.doppler.com/)
- [Supabase Documentation](https://supabase.com/docs)
- [Akash Provider Selection Guide](https://akash.network/docs/providers/)
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

---

**Last Updated**: 2024-11-19
**Status**: Draft - Security Review Required
