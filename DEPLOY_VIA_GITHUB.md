# Deploy Backend via GitHub (Most Reliable)

The CLI upload is having issues. Let's deploy via GitHub instead.

## Option 1: Deploy from GitHub (Recommended)

### Step 1: Push Code to GitHub

```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend

# Initialize git if not already
git init

# Add all files
git add .

# Commit
git commit -m "Add AlternateFutures backend"

# Add remote (replace with your repo URL)
git remote add origin https://github.com/YOUR_USERNAME/alternatefutures-backend.git

# Push
git push -u origin main
```

### Step 2: Connect Railway to GitHub

1. **Railway Dashboard** → Your Project → **Backend Service**
2. Click **Settings** → **Source**
3. Click **"Connect Repo"**
4. Authorize Railway to access GitHub
5. Select your repository
6. Branch: `main`
7. Root Directory: `/` (or `/alternatefutures-backend` if in monorepo)

### Step 3: Configure Deploy Settings

Still in **Settings** → **Deploy**:

**Build Command:**
```
npm install && npm run build
```

**Start Command:**
```
npm start
```

**Watch Paths:**
```
src/**
prisma/**
package.json
```

### Step 4: Deploy

Railway will automatically deploy! Watch the logs in the **Deployments** tab.

---

## Option 2: Try Railway CLI Fix

Sometimes restarting helps:

```bash
# 1. Check Railway CLI version
railway version

# 2. Update if needed
npm install -g @railway/cli

# 3. Re-link
rm -rf .railway
railway link

# 4. Make sure service is selected
railway service
# Select: backend

# 5. Try deploying again
railway up
```

---

## Option 3: Deploy Directly in Dashboard

1. **Railway Dashboard** → Backend Service
2. Click **"..."** → **"Redeploy"**
3. Or manually trigger a new deployment

---

## Recommended: Use GitHub Method

It's the most reliable and you get:
- ✅ Automatic deployments on push
- ✅ Better visibility into build process
- ✅ Easy rollbacks
- ✅ No CLI upload issues

**Start with pushing to GitHub, then connecting Railway to the repo!**
