# OpenProvider DNS Setup

This guide explains how to configure OpenProvider for automated DNS updates after Akash deployments.

## Prerequisites

- OpenProvider account with API access
- Domain registered with OpenProvider or transferred to OpenProvider
- GitHub repository with Actions enabled

## Step 1: Get OpenProvider API Credentials

1. Log in to [OpenProvider Control Panel](https://cp.openprovider.eu/)
2. Navigate to **Configuration** → **API Settings**
3. Generate API credentials:
   - Username: Your OpenProvider API username
   - Password: Your OpenProvider API password
4. Save these credentials securely

## Step 2: Configure GitHub Secrets

Add the following secrets to your GitHub repository:

### Navigate to Secrets

1. Go to your repository on GitHub
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**

### Add OpenProvider Credentials

Add these two secrets:

| Secret Name | Value | Description |
|-------------|-------|-------------|
| `OPENPROVIDER_USERNAME` | Your API username | OpenProvider API username |
| `OPENPROVIDER_PASSWORD` | Your API password | OpenProvider API password |

## Step 3: Transfer Domain to OpenProvider (if needed)

If your domain is currently with another provider (e.g., NameCheap):

### Option A: Transfer Domain

1. Unlock domain at current registrar
2. Get authorization/EPP code
3. Initiate transfer at OpenProvider
4. Wait for transfer completion (5-7 days)

### Option B: Change Name Servers Only

1. Keep domain registration at current provider
2. Point nameservers to OpenProvider:
   ```
   ns1.openprovider.nl
   ns2.openprovider.be
   ns3.openprovider.eu
   ```
3. Wait for nameserver propagation (24-48 hours)
4. Configure DNS records in OpenProvider control panel

## Step 4: Verify DNS Zone Setup

1. Log in to OpenProvider Control Panel
2. Navigate to **DNS** → **Zone Management**
3. Find your domain: `alternatefutures.ai`
4. Ensure zone is active and editable

## Step 5: Test DNS Sync

The GitHub Actions workflow will automatically:

1. Deploy to Akash Network
2. Get service IPs from the provider
3. Update DNS records via OpenProvider API:
   - `api.alternatefutures.ai` → API service IP
   - `yb.alternatefutures.ai` → YugabyteDB UI IP
   - `ipfs.alternatefutures.ai` → IPFS gateway IP
4. Verify DNS propagation
5. Report results in deployment summary

### Manual Testing

You can test DNS sync locally:

```bash
# Set environment variables
export OPENPROVIDER_USERNAME="your-username"
export OPENPROVIDER_PASSWORD="your-password"
export DOMAIN="alternatefutures.ai"
export AKASH_NODE="https://rpc.akashnet.net:443"
export AKASH_CHAIN_ID="akashnet-2"

# Run DNS sync script
tsx scripts/sync-dns.ts <DSEQ> <PROVIDER>

# Example:
tsx scripts/sync-dns.ts 24241134 akash1hzjzhdzhpe8dzjhncah8jdrs5pwckrq40p7cte
```

## Step 6: Monitor DNS Propagation

After deployment, DNS records update automatically, but propagation takes time:

### Check DNS Status

```bash
# Check if DNS has propagated
dig api.alternatefutures.ai +short
dig yb.alternatefutures.ai +short
dig ipfs.alternatefutures.ai +short
```

### Expected Timeline

- **OpenProvider Update**: Immediate (via API)
- **DNS Propagation**: 2-5 minutes (typically)
- **Global Propagation**: Up to 24 hours (worst case)

## Troubleshooting

### DNS Not Updating

1. Check GitHub Actions logs for errors
2. Verify OpenProvider credentials are correct
3. Ensure domain zone is active in OpenProvider
4. Check API rate limits (OpenProvider has limits)

### DNS Verification Failing

- DNS records are updated but verification may take time
- The workflow warns but doesn't fail if verification is slow
- Manual verification recommended after 5 minutes

### OpenProvider API Errors

Common errors and solutions:

| Error | Solution |
|-------|----------|
| Invalid credentials | Check `OPENPROVIDER_USERNAME` and `OPENPROVIDER_PASSWORD` |
| Zone not found | Ensure domain is set up in OpenProvider DNS |
| Rate limit exceeded | Wait and retry (API has rate limits) |
| Permission denied | Ensure API credentials have DNS management permissions |

## Security Best Practices

1. **Never commit credentials** - Always use GitHub Secrets
2. **Rotate API credentials** regularly (every 90 days)
3. **Use read-only credentials** where possible
4. **Enable 2FA** on OpenProvider account
5. **Audit DNS changes** regularly

## Alternative: Using Your Platform API

If you prefer to use your own platform's domain management API instead of calling OpenProvider directly:

1. Create an endpoint in your API: `POST /api/domains/sync`
2. Implement OpenProvider integration server-side
3. Update `scripts/sync-dns.ts` to call your API instead
4. Use internal authentication instead of OpenProvider credentials

This approach provides better security and centralized control.

## Next Steps

After DNS is configured:

1. Test each endpoint:
   - `https://api.alternatefutures.ai/health`
   - `https://yb.alternatefutures.ai`
   - `https://ipfs.alternatefutures.ai/ipfs/<hash>`

2. Set up SSL certificates (Let's Encrypt)

3. Configure monitoring and alerts

4. Document your deployment endpoints

---

**Status**: Ready for automated DNS updates
**Domain**: alternatefutures.ai
**Provider**: OpenProvider
**Automation**: GitHub Actions
