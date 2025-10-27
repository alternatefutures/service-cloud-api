# Fully Decentralized Container Registry Architecture

## Overview

Complete decentralization stack for container image storage and distribution:

- **Compute**: Akash Network (decentralized cloud)
- **Storage**: Self-hosted IPFS node (Kubo)
- **Registry**: OpenRegistry (OCI-compliant)
- **No third-party dependencies**: Filebase, Pinata, or Docker Hub

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│              Alternate Futures Decentralized Stack            │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │            Akash Network (Compute Layer)               │  │
│  │                                                          │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │  │
│  │  │  PostgreSQL  │  │  IPFS (Kubo) │  │ OpenRegistry │ │  │
│  │  │              │  │              │  │              │ │  │
│  │  │  Metadata    │  │  Container   │  │  OCI API     │ │  │
│  │  │  Storage     │  │  Layers      │  │  Server      │ │  │
│  │  │              │  │              │  │              │ │  │
│  │  │  Port: 5432  │  │  Port: 5001  │  │  Port: 5000  │ │  │
│  │  │              │  │  Port: 8080  │  │              │ │  │
│  │  │              │  │  Port: 4001  │  │              │ │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘ │  │
│  │         │                 │                  │         │  │
│  └─────────┼─────────────────┼──────────────────┼─────────┘  │
│            │                 │                  │             │
│            └─────────────────┴──────────────────┘             │
│                                                                │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │               Public Endpoints (Namecheap DNS)         │  │
│  │                                                          │  │
│  │  registry.alternatefutures.ai  → OpenRegistry          │  │
│  │  ipfs.alternatefutures.ai      → IPFS Gateway          │  │
│  │                                                          │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                                │
└──────────────────────────────────────────────────────────────┘

                              ↕

┌──────────────────────────────────────────────────────────────┐
│                       User Workflows                          │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  1. Push Container Image                                      │
│     docker push registry.alternatefutures.ai/myapp:latest    │
│     ↓                                                          │
│     OpenRegistry → Stores layers on IPFS → Returns CID        │
│                                                                │
│  2. Pull Container Image                                      │
│     docker pull registry.alternatefutures.ai/myapp:latest    │
│     ↓                                                          │
│     OpenRegistry → Fetches from IPFS → Delivers image         │
│                                                                │
│  3. Deploy to Akash                                           │
│     image: registry.alternatefutures.ai/myapp:latest         │
│     ↓                                                          │
│     Akash pulls from your registry (fully decentralized!)     │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

## Components

### 1. PostgreSQL (Metadata Storage)
- **Purpose**: Store registry metadata (image names, tags, references)
- **Resources**: 1 CPU, 2GB RAM, 20GB storage
- **Network**: Internal only (accessible to OpenRegistry)
- **Image**: `postgres:15-alpine`

### 2. IPFS Node (Kubo - Storage Layer)
- **Purpose**: Decentralized storage for container image layers
- **Resources**: 2 CPU, 4GB RAM, 100GB storage
- **Network**:
  - **API (5001)**: Internal - OpenRegistry connects here
  - **Gateway (8080)**: Public - `ipfs.alternatefutures.ai`
  - **Swarm (4001)**: Public - P2P connections to IPFS network
- **Image**: `ipfs/kubo:latest`
- **Config**: Server profile for production

### 3. OpenRegistry (OCI API Server)
- **Purpose**: OCI-compliant container registry API
- **Resources**: 2 CPU, 4GB RAM, 10GB storage
- **Network**: Public HTTP on port 5000 → `registry.alternatefutures.ai`
- **Image**: `jasdeepsingh/open-registry:beta`
- **Storage Backend**: Self-hosted IPFS (not Filebase/Pinata)

## Why This Matters

### Complete Decentralization
1. **No Docker Hub**: Eliminate dependency on centralized registries
2. **No Filebase/Pinata**: Own your IPFS infrastructure
3. **No Cloud Providers**: Runs on Akash Network
4. **Censorship Resistant**: Images stored on IPFS
5. **Open Source**: All components are FOSS

### Cost Comparison

**Traditional Stack:**
- Docker Hub Teams: $7/user/month
- IPFS Pinning (Pinata): $20-100/month
- Cloud Hosting (AWS): $50-200/month
- **Total**: ~$77-307/month

**Decentralized Stack:**
- Akash Network: ~$40-70/month
- IPFS Node: Included in Akash cost
- OpenRegistry: Included in Akash cost
- **Total**: ~$40-70/month ✅

**Savings**: 40-85% cost reduction + full sovereignty

### User Benefits
- **Developers**: Push/pull containers without centralized deps
- **Platform Users**: Can use the same registry for their deployments
- **Web3 Native**: Aligns with decentralization mission
- **Privacy**: You control all data
- **Resilience**: P2P storage across IPFS network

## Implementation Details

### Backend Integration

The backend now supports **two IPFS modes**:

#### 1. Legacy Mode (Pinata)
```typescript
// Uses Pinata if no IPFS_API_URL is set
const storage = StorageServiceFactory.create('IPFS');
// → Uses IPFSStorageService (Pinata SDK)
```

#### 2. Self-Hosted Mode (NEW)
```typescript
// Uses self-hosted IPFS when IPFS_API_URL is set
process.env.IPFS_API_URL = 'http://ipfs:5001';
process.env.IPFS_GATEWAY_URL = 'https://ipfs.alternatefutures.ai';

const storage = StorageServiceFactory.create('IPFS');
// → Uses SelfHostedIPFSStorageService (ipfs-http-client)
```

### Environment Variables

**Backend (`deploy.yaml`):**
```yaml
# Enable self-hosted IPFS
- IPFS_API_URL=http://ipfs:5001
- IPFS_GATEWAY_URL=https://ipfs.alternatefutures.ai
```

**OpenRegistry (`deploy-registry.yaml`):**
```yaml
# Connect to self-hosted IPFS
- OPEN_REGISTRY_DFS_IPFS_ENABLED=true
- OPEN_REGISTRY_DFS_IPFS_API_URL=http://ipfs:5001
- OPEN_REGISTRY_DFS_IPFS_GATEWAY_URL=http://ipfs:8080
```

### New Storage Service API

The `SelfHostedIPFSStorageService` provides:

```typescript
// Upload file
await ipfs.upload(buffer, 'myfile.txt');
// → Returns: { cid, url, size, storageType }

// Upload directory
await ipfs.uploadDirectory('./build');
// → Uploads entire directory to IPFS

// Pin existing CID
await ipfs.pin('QmHash...');

// Unpin to free space
await ipfs.unpin('QmHash...');

// Get file from IPFS
const buffer = await ipfs.get('QmHash...');

// Node info
const info = await ipfs.getNodeInfo();
// → { id, agentVersion, protocolVersion, addresses }

// Storage stats
const stats = await ipfs.getStats();
// → { numObjects, repoSize, storageMax, version }
```

## Deployment Steps

### Prerequisites
1. Akash wallet with AKT tokens
2. Namecheap domain access for DNS configuration

### Step 1: Deploy Registry Stack
```bash
cd /Users/wonderwomancode/Projects/fleek/alternatefutures-backend

# Set secrets in deploy-registry.yaml
# - POSTGRES_PASSWORD
# - JWT signing secret

# Deploy to Akash
akash tx deployment create deploy-registry.yaml \
  --from default \
  --node https://rpc.akash.network:443 \
  --chain-id akashnet-2

# Accept bid and send manifest (follow OPENREGISTRY_DEPLOYMENT.md)
```

### Step 2: Configure DNS
Add to Namecheap:
```
registry  →  A Record  →  <akash-provider-ip>
ipfs      →  A Record  →  <akash-provider-ip>
```

### Step 3: Test Registry
```bash
# Check OCI API
curl https://registry.alternatefutures.ai/v2/
# → {}

# Check IPFS Gateway
curl https://ipfs.alternatefutures.ai/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn
# → Returns hello world IPFS file
```

### Step 4: Push Backend Image
```bash
# Tag with your registry
docker tag alternatefutures/backend:latest \
  registry.alternatefutures.ai/alternatefutures/backend:latest

# Push
docker push registry.alternatefutures.ai/alternatefutures/backend:latest
```

### Step 5: Deploy Backend Using Registry
Update `deploy.yaml`:
```yaml
services:
  api:
    image: registry.alternatefutures.ai/alternatefutures/backend:latest
    env:
      - IPFS_API_URL=http://ipfs:5001
      - IPFS_GATEWAY_URL=https://ipfs.alternatefutures.ai
```

Deploy:
```bash
akash tx deployment create deploy.yaml --from default
```

## CLI Integration

### Add Registry Commands

```typescript
// src/commands/registry/index.ts
import { Command } from 'commander';

export const registryCommand = new Command('registry')
  .description('Manage container images on decentralized registry');

// Login
registryCommand
  .command('login')
  .description('Login to Alternate Futures Registry')
  .action(async () => {
    // Implement authentication
  });

// Push
registryCommand
  .command('push <image>')
  .description('Push container image to decentralized registry')
  .action(async (image: string) => {
    // Tag and push using Docker SDK
    // Images automatically stored on IPFS
  });

// List
registryCommand
  .command('list')
  .description('List your container images')
  .action(async () => {
    // Fetch from registry API
  });

// Info
registryCommand
  .command('info <image>')
  .description('Show image details including IPFS CIDs')
  .action(async (image: string) => {
    // Show image layers, sizes, IPFS CIDs
  });
```

## App Frontend Integration

### Display Container Images

```typescript
// GraphQL Schema
type ContainerImage {
  id: ID!
  name: String!
  tag: String!
  digest: String!
  ipfsCid: String # Layer stored on IPFS
  size: Int!
  createdAt: DateTime!
}

extend type Query {
  containerImages: [ContainerImage!]!
  containerImage(name: String!, tag: String!): ContainerImage
}

extend type Mutation {
  pushContainerImage(input: PushImageInput!): ContainerImage!
}
```

### React Component

```typescript
// app/src/pages/Registry.tsx
export function RegistryPage() {
  const { data } = useQuery({
    queryKey: ['containerImages'],
    queryFn: async () => {
      const res = await graphql(`
        query {
          containerImages {
            id
            name
            tag
            ipfsCid
            size
            createdAt
          }
        }
      `);
      return res.containerImages;
    }
  });

  return (
    <div>
      <h1>Your Container Images</h1>
      <p>Stored on decentralized infrastructure (IPFS)</p>
      {data?.map(image => (
        <ImageCard key={image.id} image={image} />
      ))}
    </div>
  );
}
```

## Monitoring & Health

### Registry Health Endpoint
```bash
curl https://registry.alternatefutures.ai/v2/
```

### IPFS Node Health
```bash
# Node info
curl http://ipfs.alternatefutures.ai:5001/api/v0/id

# Repo stats
curl http://ipfs.alternatefutures.ai:5001/api/v0/repo/stat
```

### Integration with Status Page

Add to `/home/src/app/status/page.tsx`:

```typescript
// Check registry health
const registryHealth = await fetch('https://registry.alternatefutures.ai/v2/');

// Check IPFS health
const ipfsHealth = await fetch('https://ipfs.alternatefutures.ai/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn');

// Display status
<MetricCard>
  <h3>Container Registry</h3>
  <Status status={registryHealth.ok ? 'healthy' : 'unhealthy'} />
</MetricCard>

<MetricCard>
  <h3>IPFS Storage</h3>
  <Status status={ipfsHealth.ok ? 'healthy' : 'unhealthy'} />
</MetricCard>
```

## Migration from Pinata

If you're currently using Pinata, migration is automatic:

```typescript
// Before: Uses Pinata
const storage = StorageServiceFactory.create('IPFS');

// After: Set IPFS_API_URL environment variable
// Now automatically uses self-hosted IPFS!
process.env.IPFS_API_URL = 'http://ipfs:5001';
const storage = StorageServiceFactory.create('IPFS');
```

No code changes needed - just environment configuration!

## Future Enhancements

1. **IPFS Cluster**: Multiple IPFS nodes for redundancy
2. **Helia Migration**: Upgrade from ipfs-http-client to Helia
3. **IPNS Support**: Mutable pointers for latest tags
4. **Web3 Auth**: ENS-based authentication
5. **Image Scanning**: Security vulnerability scanning
6. **CDN Layer**: Global edge caching with IPFS

## Security Considerations

1. **TLS**: Akash providers support Let's Encrypt automatically
2. **Authentication**: Token-based auth in OpenRegistry
3. **Network Isolation**: PostgreSQL not exposed publicly
4. **IPFS Security**: Pin only trusted content
5. **Rate Limiting**: Built into OpenRegistry

## Resources

- **OpenRegistry**: https://github.com/containerish/OpenRegistry
- **Kubo (IPFS)**: https://github.com/ipfs/kubo
- **Akash Network**: https://akash.network
- **OCI Spec**: https://github.com/opencontainers/distribution-spec

## Files Created

1. **`deploy-registry.yaml`**: Akash SDL for registry deployment
2. **`src/services/storage/ipfs-selfhosted.ts`**: Self-hosted IPFS adapter
3. **`src/services/storage/factory.ts`**: Updated to support both modes
4. **`OPENREGISTRY_DEPLOYMENT.md`**: Step-by-step deployment guide
5. **`DECENTRALIZED_REGISTRY_ARCHITECTURE.md`**: This file

---

**Next Steps**: Follow `OPENREGISTRY_DEPLOYMENT.md` to deploy to Akash Network!
