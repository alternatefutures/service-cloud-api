# Railway Deployment - Correct Commands

## Current Issue
You have PostgreSQL service but no backend app service.

## Fix: Deploy via Railway Dashboard (Easiest)

### Option 1: Deploy via Dashboard (Recommended - 2 minutes)

1. **Go to Railway Dashboard**: https://railway.app
2. **Open your project** (alternatefutures-backend)
3. **Click "+ New"** button
4. **Select "GitHub Repo"** or **"Empty Service"**
   - If GitHub Repo: Connect your repo
   - If Empty Service: We'll deploy via CLI after
5. **Service name**: alternatefutures-backend
6. **Set environment variables** in the service:
   - `NODE_ENV` = `production`
   - `PORT` = `4000`
   - `JWT_SECRET` = `[generate random string]`
   - `FUNCTIONS_DOMAIN` = `af-functions.dev`
   - `APP_URL` = `https://app.alternatefutures.ai`
7. **Connect PostgreSQL**:
   - Service Settings → Variables → "+ Reference"
   - Select PostgreSQL service's `DATABASE_URL`
8. **Deploy**: Click "Deploy" or use CLI below

### Option 2: Deploy via CLI (Alternative)

```bash
# Make sure you're in the backend directory
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend

# This will prompt you to create a new service
railway up

# When prompted:
# - "Create a new service?" → Yes
# - Service name → alternatefutures-backend
```

### Option 3: Link to Existing Service (If you created one in dashboard)

```bash
# List available services
railway service

# Link to the backend service (interactive)
railway service
# Select: alternatefutures-backend

# Then deploy
railway up
```

---

## After Deployment

### 1. Get your service URL
```bash
railway domain
```

### 2. Set up database (via Railway Web Terminal)
1. Dashboard → Backend Service → "..." → "Terminal"
2. Run:
```bash
npm run db:push
npm run db:seed
```

### 3. Test the API
```bash
curl https://[your-railway-url].up.railway.app/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ version { commitHash } }"}'
```

---

## Recommended: Use Dashboard Method

The easiest way is:
1. **Go to Railway Dashboard**
2. **+ New → Empty Service**
3. **Name it** alternatefutures-backend
4. **Add environment variables**
5. **Run** `railway link` then `railway up` from CLI

This avoids CLI confusion and gives you full control!
