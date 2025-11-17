# Production Environment Setup for Akash Deployment

## Overview

The GitHub Actions workflow is configured for production deployments:
- **Auto-deploys** when `deploy-mainnet.yaml` or workflow file changes are pushed to `main` branch
- Uses GitHub **"production" environment** for secrets and deployment approvals
- Costs ~$65/month (~108 AKT) for full-stack deployment

## Setup Steps

### 1. Create Production Environment in GitHub

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Environments**
3. Click **New environment**
4. Name it: `production`
5. Configure protection rules (recommended):
   - ✅ **Required reviewers**: Add team members who must approve deployments
   - ✅ **Wait timer**: Add 5-minute delay before deployment (optional safety)
   - ✅ **Deployment branches**: Only `main` branch

### 2. Add Secrets to Production Environment

Navigate to **Settings** → **Environments** → **production** → **Environment secrets**

Add these secrets (click "Add secret" for each):

#### Required Secrets:

1. **`AKASH_MNEMONIC`**
   - Your Akash wallet 12/24-word mnemonic phrase
   - ⚠️ This is CRITICAL - protects your funds!

   ```bash
   # Get your current wallet mnemonic
   akash keys export default
   ```

2. **`YUGABYTE_PASSWORD`**
   - Generated secure password: `I1ZqzIc4wq8kbIbkM4Pje/BNS+Kx4IkyqAozryoqe1g=`
   - Or generate new: `openssl rand -base64 32`

3. **`JWT_SECRET`**
   - Generated secure secret: `tlSnxQz/SiMLTAEGvFT0qxVYCie71gsNDIDwZgLoMg4=`
   - Or generate new: `openssl rand -base64 32`

#### Optional Secrets (add as needed):

4. **`RESEND_API_KEY`** - Email service (https://resend.com)
5. **`ARWEAVE_WALLET`** - Arweave uploads (https://turbo.ardrive.io)
6. **`FILECOIN_WALLET_KEY`** - Filecoin storage wallet (direct integration, no third party)
7. **`SENTRY_DSN`** - Error tracking (https://sentry.io)

### 3. Verify Wallet Balance

Ensure your Akash wallet has sufficient AKT:
```bash
akash query bank balances akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn \
  --node https://rpc.akashnet.net:443
```

**Minimum recommended**: 120 AKT (~$72) for ~1 month of operation

### 4. Commit and Push

```bash
# Stage the workflow files
git add .github/

# Commit
git commit -m "feat: Add production GitHub Actions deployment for Akash

- Auto-deploy on push to main
- Use production environment for secrets
- Full stack: YugabyteDB + IPFS + API
- Cost: ~108 AKT/month (~$65)

🤖 Generated with Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"

# Push to main (this will trigger deployment!)
git push origin main
```

⚠️ **Note**: Pushing to `main` will automatically trigger a deployment if `deploy-mainnet.yaml` or the workflow file was modified!

## Deployment Workflow

### Automatic Deployment (Production)
```
push to main
  ↓
Production environment approval (if configured)
  ↓
Deploy to Akash mainnet
  ↓
Services live at:
  - api.alternatefutures.ai
  - yb.alternatefutures.ai
  - ipfs.alternatefutures.ai
```

### Manual Deployment
```
Actions tab → Deploy to Akash Network → Run workflow
  ↓
Select: production or staging
  ↓
Select: deploy-mainnet.yaml
  ↓
Run workflow
```

## Post-Deployment Tasks

### 1. Configure DNS

Point your domains to the deployment:

```bash
# Get the lease details
akash query market lease list \
  --owner akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn \
  --node https://rpc.akashnet.net:443
```

Then set up DNS A records:
- `api.alternatefutures.ai` → Provider IP
- `yb.alternatefutures.ai` → Provider IP
- `ipfs.alternatefutures.ai` → Provider IP

### 2. Verify Services

```bash
# Check API
curl https://api.alternatefutures.ai/health

# Check IPFS Gateway
curl https://ipfs.alternatefutures.ai/ipfs/QmHash

# Check YugabyteDB Admin (requires authentication)
curl https://yb.alternatefutures.ai
```

### 3. Monitor Logs

```bash
# Get provider and DSEQ from workflow output
akash provider lease-logs \
  --dseq YOUR_DSEQ \
  --provider YOUR_PROVIDER \
  --node https://rpc.akashnet.net:443 \
  --from default
```

## Security Best Practices

### Environment Protection

✅ **Do configure**:
- Required reviewers for production deployments
- Branch protection on `main`
- Wait timer for deployment delays
- Regular secret rotation

### Secret Management

✅ **Do**:
- Store all credentials in GitHub Secrets
- Use environment-specific secrets (production vs staging)
- Rotate secrets every 90 days
- Use strong, unique passwords

❌ **Don't**:
- Commit secrets to Git
- Share secrets via chat/email
- Reuse passwords
- Store secrets locally

## Troubleshooting

### Deployment fails with "insufficient funds"
- Check wallet balance: Need ~5-10 AKT for deployment escrow
- Add more AKT to wallet

### No deployment triggered on push
- Verify you pushed to `main` branch
- Check that `deploy-mainnet.yaml` or workflow file was modified
- Review Actions tab for error messages

### Deployment stuck on "Waiting for approval"
- Check if production environment has required reviewers
- Ask reviewer to approve the deployment
- Or remove reviewer requirement temporarily

### Services not accessible after deployment
- Wait 5-10 minutes for DNS propagation
- Verify DNS is correctly configured
- Check lease status for provider IP
- Verify domains in SDL match your DNS setup

## Cost Monitoring

### Current Configuration
- **Daily**: ~3.6 AKT (~$2.16)
- **Weekly**: ~25 AKT (~$15)
- **Monthly**: ~108 AKT (~$65)

### Monitor Balance
Set up alerts when balance drops below threshold:
```bash
# Check balance
akash query bank balances YOUR_ADDRESS --node https://rpc.akashnet.net:443
```

### Reduce Costs
If costs are too high:
1. Reduce resource allocations in `deploy-mainnet.yaml`
2. Lower bid prices (may get fewer/slower providers)
3. Use fewer services (remove IPFS or reduce DB nodes)

## Support

- **Akash Docs**: https://docs.akash.network
- **Discord**: https://discord.akash.network
- **GitHub Issues**: Create an issue in this repository
