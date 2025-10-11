# AlternateFutures Backend - Deployment Guide

Complete guide to deploying the AlternateFutures GraphQL backend and achieving full dogfooding.

---

## Phase 1: Initial Deployment to Railway ⭐

### Step 1: Install Dependencies

```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend
npm install
```

### Step 2: Set Up Railway

1. **Install Railway CLI**:
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway**:
   ```bash
   railway login
   ```

3. **Create new project**:
   ```bash
   railway init
   ```
   - Project name: `alternatefutures-backend`

4. **Add PostgreSQL database**:
   ```bash
   railway add
   ```
   - Select: `PostgreSQL`
   - Railway will auto-create `DATABASE_URL` environment variable

### Step 3: Configure Environment Variables

In Railway dashboard (https://railway.app):

```env
DATABASE_URL=postgresql://... # Auto-set by Railway
PORT=4000
NODE_ENV=production
JWT_SECRET=your-super-secret-jwt-key-CHANGE-THIS
PINATA_JWT=your-pinata-jwt-token
PINATA_GATEWAY=your-gateway.mypinata.cloud
FUNCTIONS_DOMAIN=af-functions.dev
APP_URL=https://app.alternatefutures.ai
```

### Step 4: Deploy to Railway

```bash
# Deploy
railway up

# Run database migrations
railway run npm run db:push

# Check logs
railway logs
```

### Step 5: Get Railway URL

```bash
railway domain
```

Example output: `alternatefutures-backend-production.up.railway.app`

Your GraphQL endpoint: `https://alternatefutures-backend-production.up.railway.app/graphql`

---

## Phase 2: Configure DNS on Namecheap

### Step 1: Login to Namecheap

1. Go to https://namecheap.com
2. Login to your account
3. Go to Dashboard → Domain List → `alternatefutures.ai` → Manage

### Step 2: Add CNAME Record

In **Advanced DNS** settings:

| Type  | Host | Value | TTL |
|-------|------|-------|-----|
| CNAME | api  | alternatefutures-backend-production.up.railway.app. | Automatic |

**Important**: Add a trailing dot (`.`) at the end of the Railway URL

### Step 3: Wait for DNS Propagation

DNS changes can take 5-30 minutes to propagate.

Check status:
```bash
dig api.alternatefutures.ai
```

### Step 4: Configure Custom Domain in Railway

1. Go to Railway dashboard → Your project → Settings
2. Add custom domain: `api.alternatefutures.ai`
3. Railway will auto-provision SSL certificate (via Let's Encrypt)

---

## Phase 3: Test the Backend

### Test 1: Health Check

```bash
curl https://api.alternatefutures.ai/graphql
```

Should return GraphQL Playground HTML.

### Test 2: Create User & PAT (Personal Access Token)

First, create a test user manually in database:

```bash
railway connect postgres
```

```sql
-- Create a test user
INSERT INTO "User" (id, email, username, "createdAt", "updatedAt")
VALUES ('test-user-1', 'test@alternatefutures.ai', 'testuser', NOW(), NOW());

-- Create a personal access token for testing
INSERT INTO "PersonalAccessToken" (id, name, token, "userId", "createdAt", "updatedAt")
VALUES ('pat-1', 'Test Token', 'test-token-12345', 'test-user-1', NOW(), NOW());

-- Create a test project
INSERT INTO "Project" (id, name, slug, "userId", "createdAt", "updatedAt")
VALUES ('proj-1', 'Test Project', 'test-project', 'test-user-1', NOW(), NOW());
```

### Test 3: Test GraphQL API with CLI

Update CLI environment to use production:

```bash
cd /Users/wonderwomancode/Projects/fleek/cloud-cli

# Update .env to point to production
echo 'SDK__GRAPHQL_API_URL=https://api.alternatefutures.ai/graphql' >> .env
```

Rebuild CLI:
```bash
pnpm build
```

Set up authentication:
```bash
# Store the PAT in CLI config
af auth login
# Enter token: test-token-12345
```

Test functions commands:
```bash
# Create a function
af functions create

# List functions
af functions list
```

---

## Phase 4: Dogfooding - Deploy Backend as AF Function 🚀

Once Phase 1-3 are working, let's eat our own dog food!

### Step 1: Package Backend for Deployment

Create a bundled version of the backend:

```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend

# Build TypeScript
npm run build

# Create deployment bundle
mkdir -p deploy
cp -r dist package.json node_modules deploy/
cd deploy && tar -czf ../backend-bundle.tar.gz .
```

### Step 2: Create Function via CLI

```bash
af functions create --name alternatefutures-graphql-api
```

This creates a function record in the database.

### Step 3: Deploy Backend to AF Function

```bash
af functions deploy \
  --name alternatefutures-graphql-api \
  --filePath ./dist/index.js
```

This will:
1. Upload code to IPFS
2. Create deployment record
3. Return invoke URL

Example: `https://alternatefutures-graphql-api.af-functions.dev/graphql`

### Step 4: Update DNS

In Namecheap, update the CNAME:

| Type  | Host | Value | TTL |
|-------|------|-------|-----|
| CNAME | api  | alternatefutures-graphql-api.af-functions.dev. | Automatic |

### Step 5: Verify

```bash
curl https://api.alternatefutures.ai/graphql
```

Now your platform is running on itself! 🎉

---

## Architecture After Dogfooding

```
┌─────────────────────────────────────────────────┐
│           Users (CLI, Dashboard, SDK)           │
└────────────────────┬────────────────────────────┘
                     │
                     │ HTTPS
                     ▼
┌─────────────────────────────────────────────────┐
│        DNS: api.alternatefutures.ai             │
│            ↓ (CNAME)                            │
│  alternatefutures-graphql-api.af-functions.dev  │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│       AF Functions Runtime (Cloudflare)         │
│                                                  │
│  Fetches code from IPFS:                       │
│  ipfs://QmXXXX... (GraphQL Yoga server)        │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│         PostgreSQL Database (Railway)           │
└─────────────────────────────────────────────────┘
```

**Key insight**: The GraphQL API that manages functions is ITSELF a function!

---

## Troubleshooting

### DNS not resolving
```bash
# Check DNS propagation
dig api.alternatefutures.ai

# Flush DNS cache (macOS)
sudo dscacheutil -flushcache
```

### Database connection errors
```bash
# Check Railway database status
railway status

# View logs
railway logs
```

### CLI not connecting
```bash
# Verify environment variables
cat /Users/wonderwomancode/Projects/fleek/cloud-cli/.env

# Should show:
# SDK__GRAPHQL_API_URL=https://api.alternatefutures.ai/graphql
```

---

## Next Steps After Deployment

1. ✅ Backend deployed to Railway
2. ✅ DNS configured (api.alternatefutures.ai)
3. ✅ CLI tested end-to-end
4. ✅ Backend redeployed as AF Function (dogfooding!)
5. Build agent creation wizards in agents-ui
6. Connect agents-ui to GraphQL backend
7. Launch! 🚀

---

Last Updated: 2025-10-10
