# Phase 5: Deploy and Configure Infisical - Manual Guide

## Prerequisites: DNS Setup

### Option 1: Migrate DNS to Openprovider (Recommended)

If your domain is currently on Namecheap, use the migration script:

```bash
cd /Users/wonderwomancode/Projects/alternatefutures/service-cloud-api

# Set environment variables
export NAMECHEAP_API_USER="your-api-user"
export NAMECHEAP_API_KEY="your-api-key"
export NAMECHEAP_USERNAME="your-username"
export OPENPROVIDER_USERNAME="your-openprovider-username"
export OPENPROVIDER_PASSWORD="your-openprovider-password"

# Dry run (shows what will be migrated)
tsx scripts/migrate-dns-namecheap-to-openprovider.ts alternatefutures.ai

# Actually migrate
CONFIRM=yes tsx scripts/migrate-dns-namecheap-to-openprovider.ts alternatefutures.ai
```

This will:

1. Fetch all DNS records from Namecheap
2. Create them in Openprovider
3. Update Namecheap nameservers to point to Openprovider
4. Enable automatic DNS management for all deployments

### Option 2: Use Existing DNS Provider

If you're already using Openprovider or another provider, ensure:

- OPENPROVIDER_USERNAME and OPENPROVIDER_PASSWORD are in GitHub Secrets
- Domain is properly delegated to Openprovider nameservers

## Step 1: Deploy Infisical to Akash (via GitHub UI)

### 1.1 Navigate to Workflow

Open: https://github.com/alternatefutures/service-cloud-api/actions/workflows/deploy-infisical.yml

### 1.2 Trigger Deployment

1. Click the **"Run workflow"** dropdown button (top right)
2. Ensure branch is: `main`
3. Select action: **`deploy`**
4. Click **"Run workflow"** button

### 1.3 Monitor Deployment

- The workflow will appear at the top of the runs list
- Click on it to see real-time logs
- Deployment takes ~5-10 minutes

**Expected steps:**

- ✓ Install SOPS and Akash CLI
- ✓ Decrypt bootstrap secrets using AGE_SECRET_KEY
- ✓ Setup Akash wallet and certificates
- ✓ Create deployment on Akash
- ✓ Wait for bids from audited providers
- ✓ Accept best bid and create lease
- ✓ Configure DNS automatically (secrets.alternatefutures.ai)
- ✓ Deployment summary with DSEQ

## Step 2: Verify DNS Configuration

DNS is now **automatically configured** by the deployment workflow.

The workflow automatically:

- Retrieves the Infisical deployment IP from Akash
- Creates/updates the A record: `secrets.alternatefutures.ai`
- Uses the existing DNSManager with Openprovider API

**Manual DNS configuration is only needed if automation fails.**

### If DNS automation fails:

1. Check deployment logs for the Infisical IP address
2. Manually create DNS record:
   ```
   Type: A
   Name: secrets
   Value: [infisical-ip-from-logs]
   TTL: 3600
   ```

### Verify DNS propagation:

```bash
# Check DNS resolution
dig secrets.alternatefutures.ai

# Test HTTPS access
curl -I https://secrets.alternatefutures.ai
```

## Step 3: Access Infisical and Create Account

### 3.1 Wait for DNS Propagation

DNS is configured automatically during deployment. Wait 2-5 minutes for propagation:

```bash
# Test DNS resolution
dig secrets.alternatefutures.ai

# Should show A record pointing to Infisical deployment IP

# Test HTTPS access
curl -I https://secrets.alternatefutures.ai

# Should return HTTP/2 200
```

### 3.2 Create Admin Account

1. Open: https://secrets.alternatefutures.ai
2. Click "Sign Up"
3. Create your admin account (email + password)
4. Verify email if required

### 3.3 Create Project

1. Click "Create Project"
2. Name: **"AlternateFutures Production"**
3. Environment: Keep default "production"

## Step 4: Add Secrets to Infisical

In your new project, click "Add Secret" for each:

### Required Secrets

```
DATABASE_URL
JWT_SECRET
RESEND_API_KEY
ARWEAVE_WALLET
FILECOIN_WALLET_KEY
SENTRY_DSN
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
```

### Where to Get Values

Copy from your current `.env` file or GitHub Secrets:

```bash
# If you have .env locally
cd /Users/wonderwomancode/Projects/alternatefutures/service-cloud-api
cat .env
```

Or check GitHub Secrets:
https://github.com/alternatefutures/service-cloud-api/settings/secrets/actions

## Step 5: Generate Service Token

### 5.1 Create Token

1. In Infisical project, click your profile (bottom left)
2. Go to: **Project Settings → Access Control → Service Tokens**
3. Click **"Create Token"**
4. Settings:
   - **Name:** "Production API"
   - **Environment:** production
   - **Permissions:** Read
   - **Expiration:** Never (or set expiry for rotation)
5. Click **"Create"**
6. **COPY THE TOKEN IMMEDIATELY** (shown only once!)

### 5.2 Note Your Project ID

- Find in URL: `https://secrets.alternatefutures.ai/project/[PROJECT_ID]`
- Or in Project Settings → General

## Step 6: Add Tokens to GitHub Secrets

### Option A: Via GitHub UI

1. Go to: https://github.com/alternatefutures/service-cloud-api/settings/secrets/actions
2. Click "New repository secret"
3. Add:
   - Name: `INFISICAL_SERVICE_TOKEN`
   - Value: [token from step 5.1]
4. Add another:
   - Name: `INFISICAL_PROJECT_ID`
   - Value: [project ID from step 5.2]

### Option B: Via GitHub CLI (if authenticated)

```bash
cd /Users/wonderwomancode/Projects/alternatefutures/service-cloud-api

gh auth login  # If not already authenticated

gh secret set INFISICAL_SERVICE_TOKEN \
  -R alternatefutures/service-cloud-api \
  --body "YOUR_TOKEN_HERE"

gh secret set INFISICAL_PROJECT_ID \
  -R alternatefutures/service-cloud-api \
  --body "YOUR_PROJECT_ID"
```

## Step 7: Deploy Main Application

### 7.1 Trigger Deployment

1. Go to: https://github.com/alternatefutures/service-cloud-api/actions/workflows/deploy-akash.yml
2. Click **"Run workflow"**
3. Settings:
   - **Environment:** production
   - **SDL file:** `deploy-mainnet-with-infisical.yaml`
   - **Use Infisical:** ✓ (checked)
4. Click **"Run workflow"**

### 7.2 Monitor Deployment

- Watch workflow logs
- Deployment takes ~10-15 minutes
- Application will fetch all secrets from Infisical at startup

## Verification

### Check Infisical Access

```bash
curl -I https://secrets.alternatefutures.ai
# Should return: HTTP/2 200
```

### Check Application Logs

Once deployed, check if application successfully fetched secrets:

- Look for: `✅ Loaded N secrets from Infisical`
- Should initialize without errors

## Troubleshooting

### Workflow fails with "Bad credentials"

- GitHub CLI needs authentication: `gh auth login`
- Or use GitHub UI instead

### Infisical not accessible

- Check DNS: `dig secrets.alternatefutures.ai`
- Check deployment logs for provider endpoint
- Wait 2-5 minutes for DNS propagation

### Application can't fetch secrets

- Verify INFISICAL_SERVICE_TOKEN is correct
- Verify INFISICAL_PROJECT_ID matches your project
- Check token hasn't expired
- Check token has "Read" permission

### Bootstrap secrets decryption fails

- Verify AGE_SECRET_KEY is in GitHub Secrets
- Check it matches the key used to encrypt bootstrap.enc.env

## Success Criteria

✅ Infisical deployed and accessible at secrets.alternatefutures.ai
✅ Admin account created
✅ Project created with all secrets
✅ Service token generated and added to GitHub Secrets
✅ Main application deployed and fetching secrets from Infisical
✅ No secrets visible in Akash SDL (only service token)

## Next Steps After Phase 5

1. **Test secret rotation:**
   - Change a secret in Infisical
   - Restart application to pick up new value
   - No redeployment needed!

2. **Setup secret rotation schedule:**
   - Rotate JWT_SECRET monthly
   - Rotate service tokens quarterly
   - Rotate API keys as required

3. **Monitor Infisical:**
   - Check audit logs regularly
   - Review access patterns
   - Backup project settings

4. **Setup additional environments:**
   - Create "staging" environment
   - Generate separate service tokens
   - Deploy staging stack with staging tokens
