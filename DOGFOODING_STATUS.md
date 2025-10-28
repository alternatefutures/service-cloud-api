# AlternateFutures Backend - Dogfooding Status

## ✅ Phase 1-3: COMPLETE - Railway Deployment

### Infrastructure Deployed
- **Backend URL**: `https://api.alternatefutures.ai`
- **Database**: PostgreSQL on Railway
- **Environment**: Production
- **Status**: ✅ LIVE and operational

### Features Working
- ✅ GraphQL API responding
- ✅ Authentication with Personal Access Tokens
- ✅ Database seeded with test data
- ✅ DNS configured with SSL
- ✅ All CRUD operations functional

### Test Credentials
```
Token: af_local_test_token_12345
Project ID: proj-1
User: test@alternatefutures.ai
```

---

## ✅ Phase 4: PARTIAL - Dogfooding Setup

### Function Record Created
```json
{
  "id": "cmgms34vl000121fwpn63m5rw",
  "name": "alternatefutures-graphql-api",
  "slug": "alternatefutures-graphql-api",
  "invokeUrl": "https://alternatefutures-graphql-api.af-functions.dev",
  "status": "ACTIVE"
}
```

### Deployment Record Created
```json
{
  "id": "cmgms85ek000321fwoztxdkye",
  "cid": "QmPK1s3pNYLi9ERiq3BDxKa4XosgWwFRQUydHUtz4YgpqB",
  "blake3Hash": "7ee4aa9c3802dc792e9ead6fd130cea63f5919da2bfd5d23540faf860a5f4e28"
}
```

### Backend Bundle
- **Location**: `./backend-bundle.tar.gz`
- **Size**: 8.5KB
- **Contents**: Compiled TypeScript + package.json
- **Hash**: `7ee4aa9c3802dc792e9ead6fd130cea63f5919da2bfd5d23540faf860a5f4e28`

---

## 🚧 What's Needed to Complete Full Dogfooding

### 1. IPFS Storage Setup
**Current State**: Using placeholder CID

**Required**:
- Set up Pinata account and get JWT token
- Configure PINATA_JWT and PINATA_GATEWAY in Railway
- Upload backend bundle to IPFS
- Update deployment record with real CID

**Commands**:
```bash
# Set Pinata credentials in Railway
railway variables --set "PINATA_JWT=your-pinata-jwt"
railway variables --set "PINATA_GATEWAY=your-gateway.mypinata.cloud"

# Upload bundle to IPFS (using CLI or API)
# Update deployment with real CID
```

### 2. AF Functions Runtime
**Current State**: Not deployed

**Required**: Deploy the functions runtime infrastructure that:
- Listens on `*.af-functions.dev`
- Fetches code from IPFS using CID
- Executes code in isolated environment (Cloudflare Workers, Lambda, etc.)
- Routes requests to correct function based on subdomain

**Architecture**:
```
                  ┌─────────────────────┐
                  │ Cloudflare Workers  │
                  │  *.af-functions.dev │
                  └──────────┬──────────┘
                             │
                  ┌──────────▼──────────┐
                  │  Function Router    │
                  │  - Parse subdomain  │
                  │  - Lookup function  │
                  │  - Fetch CID        │
                  │  - Execute code     │
                  └──────────┬──────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
    ┌───────▼──────┐  ┌──────▼──────┐  ┌─────▼──────┐
    │ IPFS Gateway │  │  Database   │  │  Function  │
    │ (code fetch) │  │  (metadata) │  │  Execution │
    └──────────────┘  └─────────────┘  └────────────┘
```

### 3. DNS Update
**Current State**: `api.alternatefutures.ai` → Railway

**Final State**: `api.alternatefutures.ai` → AF Functions Runtime

**Namecheap DNS Configuration**:
```
Type: CNAME
Host: api
Value: alternatefutures-graphql-api.af-functions.dev.
```

---

## 🎯 Current Architecture

### Production (Railway)
```
Users → api.alternatefutures.ai → Railway → PostgreSQL
                                    ↓
                              GraphQL API
                                    ↓
                          (Manages functions metadata)
```

### Target Architecture (Dogfooding)
```
Users → api.alternatefutures.ai → AF Functions Runtime → PostgreSQL
                                           ↓
                                  Fetches from IPFS (CID)
                                           ↓
                                    Executes Backend
                                           ↓
                                     GraphQL API
                                           ↓
                          (Manages its own deployment!)
```

**Key Insight**: The platform that manages serverless functions is ITSELF a serverless function! 🎉

---

## 📋 Next Steps

### Immediate (To Complete Dogfooding)
1. **Set up IPFS Storage**
   - Get Pinata credentials
   - Upload backend bundle
   - Update deployment CID

2. **Deploy AF Functions Runtime**
   - Choose platform (Cloudflare Workers recommended)
   - Implement function router
   - Deploy to `*.af-functions.dev`

3. **Update DNS**
   - Point `api.alternatefutures.ai` to functions runtime
   - Verify SSL certificate

4. **Test End-to-End**
   - Verify API responds via functions runtime
   - Test all GraphQL operations
   - Confirm IPFS code fetch works

### Future Enhancements
- Implement automatic deployments on git push
- Add function versioning and rollbacks
- Implement cold start optimization
- Add metrics and monitoring
- Support for multiple regions

---

## 🧪 Testing Commands

### Check Function Status
```bash
curl -s https://api.alternatefutures.ai/graphql \
  -H 'Content-Type: application/json' \
  -H 'authorization: af_local_test_token_12345' \
  -H 'x-project-id: proj-1' \
  -d '{"query":"query { fleekFunctions { id name invokeUrl status } }"}'
```

### Verify Deployment
```bash
curl -s https://api.alternatefutures.ai/graphql \
  -H 'Content-Type: application/json' \
  -H 'authorization: af_local_test_token_12345' \
  -H 'x-project-id: proj-1' \
  -d '{"query":"query { fleekFunctionByName(name: \"alternatefutures-graphql-api\") { currentDeployment { cid blake3Hash } } }"}'
```

---

## 📊 Success Metrics

### Current Status
- ✅ Backend API: 100% operational
- ✅ Function Metadata: Stored in database
- ✅ Deployment Records: Created
- ⏳ IPFS Upload: Pending credentials
- ⏳ Runtime Execution: Not yet deployed
- ⏳ Full Dogfooding: Awaiting runtime

### When Complete
- ✅ Self-hosted: Backend manages its own deployment
- ✅ Decentralized: Code stored on IPFS
- ✅ Scalable: Runs on serverless infrastructure
- ✅ Verifiable: Blake3 hash ensures integrity

---

Last Updated: 2025-10-11
Status: Phase 4 Partially Complete - Runtime deployment required for full dogfooding
