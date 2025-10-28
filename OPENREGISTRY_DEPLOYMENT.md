# OpenRegistry Deployment Guide

Decentralized container registry on Akash Network with IPFS-backed storage.

## Why OpenRegistry?

- **Decentralized**: Runs on Akash Network (decentralized compute)
- **IPFS Storage**: Container images stored on IPFS via Filebase
- **OCI Compliant**: Works with Docker, containerd, and all OCI tools
- **User Value**: Your users can host their own containers decentralized

## Architecture

```
┌─────────────────────────────────────────────────────┐
│         Alternate Futures OpenRegistry              │
├─────────────────────────────────────────────────────┤
│                                                       │
│  Akash Network (Compute)                             │
│  ├── PostgreSQL (metadata)                           │
│  └── OpenRegistry (OCI API)                          │
│                                                       │
│  Filebase (Storage)                                  │
│  └── IPFS (container layers)                         │
│                                                       │
└─────────────────────────────────────────────────────┘
```

## Prerequisites

### 1. Install Akash CLI

```bash
# Install Akash CLI
curl -sSfL https://raw.githubusercontent.com/akash-network/node/master/install.sh | sh

# Verify installation
akash version
```

### 2. Setup Akash Wallet

```bash
# Create or import wallet
akash keys add mykey

# Fund wallet with AKT tokens
# Get testnet tokens: https://faucet.akash.network
# Or buy AKT: https://akash.network/token
```

### 3. Get Filebase Account (IPFS Storage)

1. Sign up at https://filebase.com
2. Create a bucket named `alternatefutures-registry`
3. Generate S3 API credentials:
   - Access Key
   - Secret Key
4. Note the endpoint: `https://s3.filebase.com`

## Deployment Steps

### Step 1: Configure Environment Variables

Edit `deploy-registry.yaml` and replace:

```yaml
# Database password
POSTGRES_PASSWORD: "your-secure-database-password"
OPEN_REGISTRY_DB_PASSWORD: "your-secure-database-password"

# JWT signing secret (min 32 chars)
OPEN_REGISTRY_SIGNING_SECRET: "your-jwt-secret-at-least-32-characters-long"

# Filebase credentials
OPEN_REGISTRY_DFS_FILEBASE_ACCESS_KEY: "your-filebase-access-key"
OPEN_REGISTRY_DFS_FILEBASE_SECRET_KEY: "your-filebase-secret-key"
OPEN_REGISTRY_DFS_FILEBASE_BUCKET_NAME: "alternatefutures-registry"
```

### Step 2: Deploy to Akash

```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend

# Set your Akash wallet key
export AKASH_KEY_NAME=mykey
export AKASH_NET=https://akash.network
export AKASH_CHAIN_ID=akashnet-2

# Create deployment
akash tx deployment create deploy-registry.yaml --from $AKASH_KEY_NAME

# Get deployment ID from output
export AKASH_DEPLOYMENT_ID=<deployment-id-from-output>

# Wait for bids
akash query market bid list --owner $AKASH_ACCOUNT_ADDRESS

# Accept a bid
akash tx market lease create --dseq $AKASH_DSEQ --from $AKASH_KEY_NAME

# Get the service endpoint
akash provider lease-status --dseq $AKASH_DSEQ --from $AKASH_KEY_NAME
```

### Step 3: Configure DNS

Point your domain to the Akash provider IP:

```
registry.alternatefutures.ai -> <akash-provider-ip>
```

Using Namecheap:
1. Log into Namecheap
2. Domain List → Manage → Advanced DNS
3. Add A Record:
   - Host: `registry`
   - Value: `<akash-provider-ip>`
   - TTL: Automatic

### Step 4: Test the Registry

```bash
# Check health
curl http://registry.alternatefutures.ai/v2/

# Should return: {}
```

## Using the Registry

### Push an Image

```bash
# Tag your image
docker tag alternatefutures/backend:latest registry.alternatefutures.ai/alternatefutures/backend:latest

# Login (if auth enabled)
docker login registry.alternatefutures.ai

# Push
docker push registry.alternatefutures.ai/alternatefutures/backend:latest
```

### Pull an Image

```bash
# From any Akash deployment or local machine
docker pull registry.alternatefutures.ai/alternatefutures/backend:latest
```

### Update Backend deploy.yaml

Update `/Users/wonderwomancode/Projects/fleek/alternatefutures-backend/deploy.yaml`:

```yaml
services:
  api:
    image: registry.alternatefutures.ai/alternatefutures/backend:latest
    # ... rest of config
```

## Integration with CLI

Add registry management commands to Alternate Futures CLI:

### 1. Registry Login Command

```typescript
// src/commands/registry/login.ts
import { Command } from 'commander';

export const loginCommand = new Command('login')
  .description('Login to Alternate Futures Registry')
  .action(async () => {
    const registryUrl = 'registry.alternatefutures.ai';
    // Implement OAuth or token-based login
    // Store credentials securely
  });
```

### 2. Image Push Command

```typescript
// src/commands/registry/push.ts
import { Command } from 'commander';

export const pushCommand = new Command('push')
  .argument('<image>', 'Docker image to push')
  .description('Push container image to decentralized registry')
  .action(async (image: string) => {
    // Tag and push to registry
    // Leverages IPFS storage via Filebase
  });
```

### 3. User Registry Access

Enable users to use the registry in their deployments:

```typescript
// src/commands/sites/deploy.ts
export const deployCommand = new Command('deploy')
  .option('--registry <url>', 'Use custom registry', 'registry.alternatefutures.ai')
  .action(async (options) => {
    // Allow users to specify container images from the registry
    // Automatically use alternatefutures registry by default
  });
```

## Integration with App Frontend

### Display User's Container Images

```typescript
// app/src/components/Registry/ImageList.tsx
export function ImageList() {
  const { data: images } = useQuery({
    queryKey: ['registry', 'images'],
    queryFn: async () => {
      const res = await fetch(`${REGISTRY_URL}/v2/_catalog`);
      return res.json();
    }
  });

  return (
    <div>
      <h2>Your Container Images</h2>
      {images?.repositories.map(repo => (
        <ImageCard key={repo} name={repo} />
      ))}
    </div>
  );
}
```

### Add to GraphQL Schema

```graphql
type ContainerImage {
  id: ID!
  name: String!
  tags: [String!]!
  size: Int!
  ipfsHash: String
  createdAt: DateTime!
}

extend type Query {
  userContainerImages: [ContainerImage!]!
  containerImage(name: String!): ContainerImage
}

extend type Mutation {
  pushContainerImage(name: String!, tag: String!): ContainerImage!
  deleteContainerImage(name: String!, tag: String!): Boolean!
}
```

## Benefits for Users

1. **Decentralized Storage**: Images stored on IPFS, censorship-resistant
2. **No Vendor Lock-in**: OCI-compliant, works everywhere
3. **Cost Effective**: Akash + Filebase cheaper than Docker Hub Pro
4. **Privacy**: Self-hosted, you control the data
5. **Web3 Native**: Aligns with decentralization mission

## Monitoring

Add registry health to your status page:

```typescript
// Add to /home/src/app/status/page.tsx
const registryHealth = await fetch('https://registry.alternatefutures.ai/v2/');
const registryStatus = registryHealth.ok ? 'healthy' : 'unhealthy';
```

## Cost Estimates

- **Akash Network**: ~$20-50/month (compute)
- **Filebase**: Free tier: 5GB storage, then $5.99/TB/month
- **Total**: ~$20-55/month for production-ready decentralized registry

Compare to Docker Hub Teams: $7/user/month

## Security Considerations

1. **TLS/HTTPS**: Use Let's Encrypt with Akash (automatic)
2. **Authentication**: Enable token-based auth in production
3. **Rate Limiting**: Built into OpenRegistry
4. **Access Control**: Per-repository permissions
5. **Secrets**: Store credentials in secure vault, not in SDL

## Troubleshooting

### Registry not accessible
```bash
# Check deployment status
akash provider lease-status

# Check logs
akash provider lease-logs --follow
```

### Images not uploading to IPFS
- Verify Filebase credentials
- Check bucket exists and is accessible
- Ensure S3 endpoint is correct

### Database connection errors
- Verify PostgreSQL service is running
- Check password matches in both services
- Ensure network connectivity between services

## Next Steps

1. Deploy OpenRegistry to Akash ✓
2. Configure Filebase IPFS storage ✓
3. Push backend image to registry
4. Update backend deployment to use registry
5. Add registry commands to CLI
6. Build registry UI in frontend app
7. Document for users

## References

- OpenRegistry: https://github.com/containerish/OpenRegistry
- Akash Network: https://akash.network
- Filebase: https://filebase.com
- OCI Spec: https://github.com/opencontainers/distribution-spec
