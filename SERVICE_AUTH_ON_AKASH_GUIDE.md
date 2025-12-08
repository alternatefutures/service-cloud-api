# Deploying Service-Auth on Akash Network

This guide documents how to deploy the Alternate Futures Authentication Service on Akash Network.

## Working Deployment (November 2025)

**Deployment Details:**
- **dseq**: 24354342
- **Provider**: europlots (`akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc`)
- **URL**: https://irqnjdusb9c813k10bl2gd92l0.ingress.europlots.com

## Quick Start

### 1. Create Deployment
```bash
# Using Akash MCP or CLI
akash tx deployment create service-auth-akash.yaml --from <wallet>
```

### 2. Accept Bid from Provider
Recommended providers:
| Provider | Address | Notes |
|----------|---------|-------|
| europlots | `akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc` | Fast, reliable |
| parallelnode | `akash1gq42nhp64xrkxlawvchfguuq0wpdx68rkzfnw6` | Good for multi-service |

### 3. Send Manifest
After lease is created, send the manifest to the provider.

## Working SDL Configuration

```yaml
---
version: "2.0"

services:
  auth-api:
    image: node:20-alpine
    expose:
      - port: 3000
        as: 80
        to:
          - global: true
    env:
      # Core Configuration
      - NODE_ENV=production
      - PORT=3000
      - DATABASE_URL=/app/data/auth.db

      # JWT Secrets (generate with: openssl rand -hex 32)
      - JWT_SECRET=<your-64-char-hex-secret>
      - JWT_REFRESH_SECRET=<your-64-char-hex-secret>
      - JWT_EXPIRES_IN=15m
      - JWT_REFRESH_EXPIRES_IN=7d

      # CORS (use * for testing, restrict in production)
      - CORS_ORIGIN=*

      # Optional: Redis for rate limiting
      # - REDIS_URL=redis://redis:6379

      # Optional: Email service (Resend)
      # - RESEND_API_KEY=your_key

      # Optional: SMS service (httpSMS)
      # - HTTPSMS_API_KEY=your_key
      # - HTTPSMS_PHONE_NUMBER=+1234567890

      # Optional: OAuth providers
      # - GOOGLE_CLIENT_ID=...
      # - GOOGLE_CLIENT_SECRET=...
      # - GITHUB_CLIENT_ID=...
      # - GITHUB_CLIENT_SECRET=...

    command:
      - sh
      - -c
      - |
        echo "Installing git and build tools..."
        apk add --no-cache git python3 make g++

        echo "Cloning service-auth repository..."
        git clone https://github.com/alternatefutures/service-auth.git /app
        cd /app

        echo "Creating data directory..."
        mkdir -p /app/data

        echo "Installing ALL dependencies..."
        NODE_ENV=development npm install

        echo "Starting service-auth with tsx (TypeScript runner)..."
        NODE_ENV=production ./node_modules/.bin/tsx src/index.ts

profiles:
  compute:
    auth-api:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          - size: 2Gi

  placement:
    akash:
      attributes:
        host: akash
      signedBy:
        anyOf:
          - "akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63"
      pricing:
        auth-api:
          denom: uakt
          amount: 1000

deployment:
  auth-api:
    akash:
      profile: auth-api
      count: 1
```

## Key Configuration Details

### Why tsx Instead of tsc?

The service-auth codebase uses ESM modules (`"type": "module"` in package.json). When TypeScript compiles to JavaScript, it doesn't add `.js` extensions to imports, which ESM requires.

**This fails:**
```bash
./node_modules/.bin/tsc
node dist/index.js
# Error: Cannot find module '/app/dist/middleware/cors'
```

**This works:**
```bash
./node_modules/.bin/tsx src/index.ts
# Runs TypeScript directly without compilation issues
```

### Why NODE_ENV=development for npm install?

The `NODE_ENV=production` environment variable in the SDL affects npm install behavior. TypeScript and other build tools are in `devDependencies`, so we must:

```bash
# Force dev dependencies to be installed
NODE_ENV=development npm install

# Then run with production mode
NODE_ENV=production ./node_modules/.bin/tsx src/index.ts
```

### Why Build Tools (python3, make, g++)?

The `better-sqlite3` package is a native Node.js module that requires compilation:

```bash
apk add --no-cache git python3 make g++
```

Without these, npm install will fail when building native bindings.

## API Endpoints

Once deployed, the following endpoints are available:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Service info and endpoint list |
| `/health` | GET | Health check |
| `/auth/email/request` | POST | Request email magic link |
| `/auth/email/verify` | POST | Verify email token |
| `/auth/sms/request` | POST | Request SMS OTP |
| `/auth/sms/verify` | POST | Verify SMS code |
| `/auth/wallet/challenge` | POST | Get wallet sign challenge |
| `/auth/wallet/verify` | POST | Verify wallet signature |
| `/auth/oauth/:provider` | GET | Initiate OAuth flow |
| `/auth/oauth/callback` | GET | OAuth callback |
| `/auth/refresh` | POST | Refresh JWT token |
| `/auth/logout` | POST | Logout session |

## Testing the Deployment

```bash
# Health check
curl https://<your-akash-url>/health
# {"status":"ok","service":"alternatefutures-auth","version":"0.1.0",...}

# Service info
curl https://<your-akash-url>/
# Returns list of all endpoints
```

## Common Issues and Solutions

### Issue: Redis Connection Errors in Logs
```
Redis connection error ... code: 'ECONNREFUSED'
```

**Cause**: The rate limiter tries to connect to Redis but none is configured.

**Solution**: These errors are non-fatal. The service works without Redis, just without rate limiting. To enable rate limiting, add a Redis service to the SDL.

### Issue: Module Not Found Errors
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/dist/middleware/cors'
```

**Cause**: ESM module resolution requires `.js` extensions in imports.

**Solution**: Use `tsx` to run TypeScript directly instead of compiling with `tsc`.

### Issue: tsc Not Found
```
sh: tsc: not found
```

**Cause**: TypeScript is in devDependencies but NODE_ENV=production skips dev deps.

**Solution**: Use `NODE_ENV=development npm install` before building.

### Issue: Native Module Build Fails
```
gyp ERR! build error
```

**Cause**: Missing build tools for native modules (better-sqlite3).

**Solution**: Install build tools: `apk add --no-cache python3 make g++`

## Resource Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 0.5 units | 1.0 units |
| Memory | 512Mi | 1Gi |
| Storage | 2Gi | 5Gi (for SQLite growth) |

## Estimated Costs

- ~3-8 uakt/block depending on provider
- ~$0.50-2.00 USD/month at typical AKT prices

## Future Improvements

1. **Pre-built Docker Image**: Push to ghcr.io to avoid build-on-deploy
2. **Fix ESM Imports**: Add `.js` extensions to source imports
3. **Move better-sqlite3**: Should be in dependencies, not devDependencies
4. **Add Redis Service**: For production rate limiting
5. **Persistent Storage**: Add beta3 persistent storage for SQLite database

## Related Documentation

- [Infisical on Akash Guide](./INFISICAL_ON_AKASH_GUIDE.md)
- [Akash SDL Documentation](https://docs.akash.network/readme/stack-definition-language)
- [Service-Auth Repository](https://github.com/alternatefutures/service-auth)
