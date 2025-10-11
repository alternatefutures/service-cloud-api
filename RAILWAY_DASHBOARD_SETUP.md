# Railway Setup via Dashboard (Most Reliable)

## Step-by-Step Dashboard Setup

### 1. Go to Railway Dashboard
Open: **https://railway.app/dashboard**

### 2. Create New Project
- Click **"+ New Project"**
- Select **"Deploy from GitHub repo"** OR **"Empty Project"**

If you choose **Empty Project**:
- Name: `alternatefutures-backend`

### 3. Add PostgreSQL Database
- In your new project, click **"+ New"**
- Select **"Database"** → **"Add PostgreSQL"**
- Railway will create the database and set `DATABASE_URL` automatically

### 4. Add Backend Service
- Click **"+ New"** again
- Select **"Empty Service"**
- Name: `backend` or `api`

### 5. Connect Service to GitHub (Optional)
- Click the backend service
- Go to **Settings** → **Source**
- Connect to your GitHub repo
- Select branch: `main`
- Root directory: `/alternatefutures-backend` (if in monorepo)

### 6. Set Environment Variables
Click backend service → **Variables** tab:

Add these variables:
```
NODE_ENV=production
PORT=4000
JWT_SECRET=af-production-jwt-secret-[random-32-chars]
FUNCTIONS_DOMAIN=af-functions.dev
APP_URL=https://app.alternatefutures.ai
```

**Link PostgreSQL DATABASE_URL:**
- Click **"+ New Variable"** → **"Add Reference"**
- Select: PostgreSQL service → `DATABASE_URL`

### 7. Configure Build & Start Commands
Click **Settings** → **Deploy**:

**Build Command:**
```bash
npm install && npm run build && npm run db:generate
```

**Start Command:**
```bash
npm start
```

### 8. Deploy
- Click **"Deploy"** button
- Wait for deployment (1-2 minutes)
- Check logs for any errors

### 9. Get Your Domain
- Click the backend service
- Go to **Settings** → **Networking**
- You'll see the Railway-provided domain (e.g., `backend-production-xxxx.up.railway.app`)
- Copy this URL

### 10. Add Custom Domain
In **Settings** → **Networking**:
- Click **"+ Custom Domain"**
- Enter: `api.alternatefutures.ai`
- Railway will show DNS instructions

### 11. Set Up Database Schema
- Click backend service → **"..."** → **"Service Terminal"**
- In the terminal, run:
```bash
npm run db:push
npm run db:seed
```

---

## Alternative: Fresh CLI Setup

If you want to start fresh with CLI:

```bash
# 1. Unlink current project
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend
rm -rf .railway

# 2. Create new project
railway init

# 3. Add PostgreSQL
railway add
# Select: PostgreSQL

# 4. Deploy
railway up

# 5. Get domain
railway domain
```

---

## Recommended: Use Dashboard
The dashboard method is more visual and easier to debug.

**Start here**: https://railway.app/dashboard

Create the project there, then we can link the CLI after!
