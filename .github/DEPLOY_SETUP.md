# Akash Network Deployment via GitHub Actions

This repository includes automated deployment to Akash Network using GitHub Actions.

## Required GitHub Secrets

Navigate to your repository: **Settings → Secrets and variables → Actions → New repository secret**

### Required Secrets:

#### 1. `AKASH_MNEMONIC` (Required)
Your Akash wallet mnemonic phrase (12 or 24 words)

**To get your mnemonic:**
```bash
# Export from existing wallet
akash keys export default --unsafe --unarmored-hex
```

**⚠️ SECURITY**: Never share your mnemonic. It provides full access to your wallet.

#### 2. `YUGABYTE_PASSWORD` (Required)
Secure password for YugabyteDB

**Generate a secure password:**
```bash
openssl rand -base64 32
```

Example: `I1ZqzIc4wq8kbIbkM4Pje/BNS+Kx4IkyqAozryoqe1g=`

#### 3. `JWT_SECRET` (Required)
Secret key for JWT token signing (min 32 characters)

**Generate:**
```bash
openssl rand -base64 32
```

Example: `tlSnxQz/SiMLTAEGvFT0qxVYCie71gsNDIDwZgLoMg4=`

### Optional Secrets (for additional services):

#### 4. `RESEND_API_KEY` (Optional)
API key for Resend email service
- Get from: https://resend.com/api-keys

#### 5. `TURBO_WALLET_KEY` (Optional)
Arweave Turbo wallet key for permanent storage
- Get from: https://turbo.ardrive.io/

#### 6. `LIGHTHOUSE_API_KEY` (Optional)
Lighthouse Storage API key for Filecoin
- Get from: https://files.lighthouse.storage/

#### 7. `SENTRY_DSN` (Optional)
Sentry DSN for error tracking
- Get from: https://sentry.io/

## How to Deploy

### 1. Add Secrets to GitHub
1. Go to your repository on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add each secret listed above

### 2. Trigger Deployment
1. Go to **Actions** tab in your repository
2. Select **Deploy to Akash Network** workflow
3. Click **Run workflow**
4. Select environment: `mainnet` or `testnet`
5. Enter SDL file: `deploy-mainnet.yaml`
6. Click **Run workflow**

### 3. Monitor Deployment
- The workflow will:
  1. ✓ Install Akash CLI
  2. ✓ Setup wallet from mnemonic
  3. ✓ Check balance
  4. ✓ Substitute secrets into SDL
  5. ✓ Create/verify certificate
  6. ✓ Create deployment
  7. ✓ Wait for provider bids
  8. ✓ Accept best bid
  9. ✓ Create lease
  10. ✓ Output service URIs

### 4. View Results
- Deployment summary appears at the bottom of the workflow run
- Contains:
  - Deployment DSEQ
  - Transaction hash
  - Provider information
  - Service endpoints

## Cost Estimates

### Full Stack (deploy-mainnet.yaml):
- **Monthly**: ~108 AKT (~$65 at $0.60/AKT)
- **Daily**: ~3.6 AKT (~$2.16)
- **Resources**:
  - 3x YugabyteDB nodes (2 CPU, 4GB RAM, 50GB storage each)
  - 1x IPFS node (2 CPU, 4GB RAM, 100GB storage)
  - 1x API service (1 CPU, 1GB RAM)

## Post-Deployment

### Configure DNS
Point your domains to the provider's IPs:
- `api.alternatefutures.ai` → API service
- `yb.alternatefutures.ai` → YugabyteDB admin
- `ipfs.alternatefutures.ai` → IPFS gateway

### Monitor Services
```bash
# Get lease status
akash provider lease-status \
  --dseq YOUR_DSEQ \
  --provider YOUR_PROVIDER \
  --node https://rpc.akashnet.net:443

# View logs
akash provider lease-logs \
  --dseq YOUR_DSEQ \
  --provider YOUR_PROVIDER \
  --node https://rpc.akashnet.net:443
```

## Updating Deployment

### Update Secrets
1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Click on the secret you want to update
3. Click **Update secret**
4. Enter new value

### Redeploy
After updating secrets, simply re-run the workflow to deploy with new configuration.

### Close Old Deployment
```bash
akash tx deployment close \
  --dseq OLD_DSEQ \
  --from default \
  --node https://rpc.akashnet.net:443 \
  --chain-id akashnet-2 \
  -y
```

## Troubleshooting

### Workflow fails at "Setup Akash wallet"
- Check that `AKASH_MNEMONIC` is correctly set
- Verify mnemonic has 12 or 24 words

### Workflow fails at "Check wallet balance"
- Ensure wallet has sufficient AKT balance
- Minimum recommended: 120 AKT for 1 month of full stack

### No bids received
- Check SDL pricing is competitive
- Verify services/resources are reasonable
- Try increasing bid amounts slightly

### Deployment created but lease fails
- Check certificate is valid
- Verify wallet has enough AKT for escrow deposit
- Check provider has capacity

## Security Best Practices

✅ **DO**:
- Use GitHub Secrets for all sensitive data
- Rotate secrets regularly
- Use strong, unique passwords
- Enable 2FA on GitHub account
- Review workflow runs for sensitive data leaks

❌ **DON'T**:
- Commit secrets to Git
- Share mnemonic phrase
- Use weak passwords
- Reuse passwords across services
- Disable security features

## Support

For issues:
1. Check workflow logs for errors
2. Review Akash Network status
3. Consult Akash documentation: https://docs.akash.network
4. Join Akash Discord: https://discord.akash.network
