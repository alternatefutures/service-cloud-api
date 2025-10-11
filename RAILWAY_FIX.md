# Railway Service Linking Fix

## The Issue
You need to link to a specific service before setting environment variables.

## Solution - Run These Commands:

### Step 1: List Available Services
```bash
railway service
```
This will show you the services in your project (e.g., "alternatefutures-backend" and "postgres")

### Step 2: Link to Your Backend Service
```bash
railway service alternatefutures-backend
```
Or if the service has a different name, select it from the interactive menu.

### Step 3: Now Set Environment Variables
```bash
# Set JWT secret
railway variables set JWT_SECRET="af-production-jwt-secret-$(openssl rand -hex 32)"

# Set Node environment
railway variables set NODE_ENV=production

# Set port
railway variables set PORT=4000

# Set Functions domain
railway variables set FUNCTIONS_DOMAIN=af-functions.dev

# Set App URL
railway variables set APP_URL=https://app.alternatefutures.ai
```

Note: I removed the `--set` flag and used `set` instead (Railway CLI syntax).

### Step 4: Continue with Deployment
```bash
railway up
```

---

## Alternative: Set Variables via Railway Dashboard

If the CLI continues to have issues, you can set variables in the web dashboard:

1. Go to https://railway.app
2. Select your project
3. Click on your backend service
4. Go to **Variables** tab
5. Click **+ New Variable** for each:
   - `JWT_SECRET` = `af-production-jwt-secret-[generate random string]`
   - `NODE_ENV` = `production`
   - `PORT` = `4000`
   - `FUNCTIONS_DOMAIN` = `af-functions.dev`
   - `APP_URL` = `https://app.alternatefutures.ai`
6. Click **Deploy** to apply changes

---

## Quick Reference

```bash
# Full corrected flow:
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend
railway service                           # List services
railway service alternatefutures-backend  # Link to service
railway variables set JWT_SECRET="af-production-jwt-secret-$(openssl rand -hex 32)"
railway variables set NODE_ENV=production
railway variables set PORT=4000
railway variables set FUNCTIONS_DOMAIN=af-functions.dev
railway variables set APP_URL=https://app.alternatefutures.ai
railway up                                # Deploy
```

Try Step 1 first to see your service name!
