# Deploy AlternateFutures Backend to Railway - Step by Step

## 🚀 Run These Commands in Your Terminal

Open a new terminal window and run these commands one by one:

### Step 1: Navigate to Backend Directory
```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend
```

### Step 2: Login to Railway
```bash
railway login
```
- This will open a browser window
- Login with GitHub (recommended) or email
- Come back to terminal when done

### Step 3: Initialize Railway Project
```bash
railway init
```
- Project name: `alternatefutures-backend`
- Press Enter

### Step 4: Add PostgreSQL Database
```bash
railway add
```
- Select: `PostgreSQL`
- This automatically creates a `DATABASE_URL` environment variable

### Step 5: Link Services
```bash
railway link
```
- Select your project from the list

### Step 6: Set Environment Variables
```bash
# Set JWT secret
railway variables --set JWT_SECRET=af-production-jwt-secret-$(openssl rand -hex 32)

# Set Node environment
railway variables --set NODE_ENV=production

# Set port
railway variables --set PORT=4000

# Set Functions domain
railway variables --set FUNCTIONS_DOMAIN=af-functions.dev

# Set App URL
railway variables --set APP_URL=https://app.alternatefutures.ai
```

### Step 7: Deploy to Railway
```bash
railway up
```
- This will build and deploy your backend
- Wait for deployment to complete (1-2 minutes)

### Step 8: Run Database Migrations
```bash
railway run npm run db:push
```
- This sets up the database schema

### Step 9: Seed Database with Test Data
```bash
railway run npm run db:seed
```
- Creates test user and Personal Access Token

### Step 10: Get Your Railway URL
```bash
railway domain
```
- Copy the URL (e.g., `alternatefutures-backend-production.up.railway.app`)

### Step 11: Add Custom Domain in Railway Dashboard
1. Go to https://railway.app
2. Select your project
3. Click Settings → Networking
4. Under "Custom Domains", click "Add Domain"
5. Enter: `api.alternatefutures.ai`
6. Railway will provision SSL certificate automatically

---

## 🌐 Now Configure DNS on Namecheap

Once you have the Railway URL from Step 10:

1. **Go to Namecheap Dashboard**
2. **Domain List** → **alternatefutures.ai** → **Manage**
3. **Advanced DNS** → **Add New Record**:
   - **Type**: CNAME
   - **Host**: `api`
   - **Value**: `alternatefutures-backend-production.up.railway.app.` *(with trailing dot!)*
   - **TTL**: Automatic
4. **Save Changes**

DNS propagation takes 5-30 minutes.

---

## ✅ Test Production API

Once DNS propagates (check with `dig api.alternatefutures.ai`):

```bash
# Test version endpoint
curl https://api.alternatefutures.ai/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ version { commitHash } }"}'

# Should return: {"data":{"version":{"commitHash":"dev"}}}
```

---

## 🎉 Next: Test with CLI

Once the API is live, update the CLI:

```bash
cd /Users/wonderwomancode/Projects/fleek/cloud-cli

# Update environment
echo 'SDK__GRAPHQL_API_URL=https://api.alternatefutures.ai/graphql' > .env

# Rebuild
pnpm build

# Test
af functions create --name my-first-production-function
af functions list
```

---

## 📊 Railway Dashboard URLs

- **Project Dashboard**: https://railway.app/project/[your-project-id]
- **Logs**: Click on your service → "View Logs"
- **Environment Variables**: Settings → Variables
- **Database**: PostgreSQL service → "Connect" tab

---

## 🔧 Troubleshooting

### If deployment fails:
```bash
# Check logs
railway logs

# Check service status
railway status
```

### If database connection fails:
```bash
# Check DATABASE_URL is set
railway variables

# Reconnect to database
railway run npm run db:push
```

### If DNS not resolving:
```bash
# Check DNS propagation
dig api.alternatefutures.ai

# Flush local DNS cache (macOS)
sudo dscacheutil -flushcache
```

---

**Start with Step 1 above!** Let me know when you complete each step and I can help if you run into any issues.
